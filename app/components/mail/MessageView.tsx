/**
 * Reading pane for the open conversation.
 *
 * Owns every action that applies to a whole thread or its selected message, so
 * the toolbar and the per-message cards stay presentational.
 */

import { useEffect, useMemo, useState } from "react";
import { useCommandPaletteStore } from "~/hooks/useCommandPaletteStore";
import { senderDisplayName } from "~/lib/sender-display";
import { AlertTriangle, CloudOff, Loader2 } from "lucide-react";
import { canMoveMessageInto, Folders, isOutboundFrom } from "shared/folders";
import { formatSnoozeReturn } from "shared/dates";
import { parseSpamSignals } from "shared/spam";
import { replyRecipients, replyToDiffersFromSender } from "shared/headers";
import MessageCard from "~/components/mail/MessageCard";
import MessageToolbar from "~/components/mail/MessageToolbar";
import DeliveryTimeline from "~/components/mail/DeliveryTimeline";
import FollowupBanner from "~/components/mail/FollowupBanner";
import { useUIStore } from "~/hooks/useUIStore";
import { useSendWithUndo } from "~/hooks/useSendWithUndo";
import { MENU_REQUEST_EVENT, type MenuRequest } from "~/hooks/useKeyboardShortcuts";
import { announce, errorMessage, showToast } from "~/lib/toast";
import { loadAttachmentsForSend } from "~/lib/attachment-transfer";
import { findThreadParent, replyTargetForDraft } from "~/lib/thread-parent";
import { wasTrashed } from "~/lib/delete-outcome";
import {
	parseUnsubscribe,
	prepareEmailHtml,
	sanitizeInlineHtml,
} from "~/lib/email-html";
import { escapeHtml, splitEmailList, toEmailListValue } from "~/lib/utils";
import { useBlockSender } from "~/queries/blocked-senders";
import {
	useDeleteEmail,
	useEmail,
	useMarkNotSpam,
	useMoveEmail,
	useRestoreEmail,
	useSetEmailPriority,
	useSnoozeEmail,
	useThreadReplies,
	useUnsnoozeEmail,
	useUpdateEmail,
} from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { useEmailLabels, useLabels, useSetEmailLabels } from "~/queries/labels";
import { useMailbox } from "~/queries/mailboxes";
import { useCancelScheduledSend } from "~/queries/scheduled-sends";
import { useMutedThreads, useSetThreadMuted } from "~/queries/rules";
import api from "~/services/api";
import type { Email, EmailPriority } from "~/types";
import { isDeliveryProblem } from "~/types";
import { ThreadSummaryPanel } from "~/components/mail/AiSummary";

/**
 * Whether "Reply all" would reach anyone "Reply" does not: more than one
 * address across To and Cc. Offering it on a one-to-one message is a second
 * button that does the same thing.
 */
function hasMultipleRecipients(email: { recipient?: string | null; cc?: string | null }): boolean {
	const count = [email.recipient, email.cc]
		.filter(Boolean)
		.join(",")
		.split(",")
		.map((a) => a.trim())
		.filter(Boolean).length;
	return count > 1;
}

function MessageSkeleton() {
	return (
		<div className="animate-pulse space-y-4 p-5">
			<div className="h-4 w-2/3 rounded bg-bg-muted" />
			<div className="flex items-center gap-3">
				<div className="h-9 w-9 rounded-full bg-bg-muted" />
				<div className="flex-1 space-y-2">
					<div className="h-3 w-40 rounded bg-bg-muted" />
					<div className="h-2.5 w-24 rounded bg-bg-muted" />
				</div>
			</div>
			<div className="space-y-2 pt-3">
				<div className="h-2.5 w-full rounded bg-bg-muted" />
				<div className="h-2.5 w-5/6 rounded bg-bg-muted" />
				<div className="h-2.5 w-4/6 rounded bg-bg-muted" />
			</div>
		</div>
	);
}

interface MessageViewProps {
	mailboxId: string;
	emailId: string;
	/** The folder the list is showing, which decides a few action affordances. */
	folderId?: string;
}

export default function MessageView({
	mailboxId,
	emailId,
	folderId,
}: MessageViewProps) {
	const { data: email, error: emailError } = useEmail(mailboxId, emailId);
	// Scoped to the folder on screen: in Trash a conversation shows only its
	// trashed messages, so deleting one no longer reads as deleting the thread.
	const { data: threadRaw } = useThreadReplies(
		mailboxId,
		email?.thread_id,
		folderId,
	);
	const { data: currentMailbox } = useMailbox(mailboxId);
	const { data: folders = [] } = useFolders(mailboxId);
	const { data: labels = [] } = useLabels(mailboxId);
	const { data: emailLabels = [] } = useEmailLabels(mailboxId, emailId);

	const updateEmail = useUpdateEmail();
	const deleteEmail = useDeleteEmail();
	const restoreEmail = useRestoreEmail();
	const moveEmail = useMoveEmail();
	const setEmailLabels = useSetEmailLabels();
	const snooze = useSnoozeEmail();
	const unsnooze = useUnsnoozeEmail();
	const setPriority = useSetEmailPriority();
	const blockSender = useBlockSender();
	const markNotSpam = useMarkNotSpam();
	const cancelScheduled = useCancelScheduledSend();
	const { data: mutedThreads = [] } = useMutedThreads(mailboxId);
	const setThreadMuted = useSetThreadMuted();
	const sendWithUndo = useSendWithUndo();

	const { closePanel, startCompose } = useUIStore();

	const noteThread = useCommandPaletteStore((state) => state.noteThread);
	useEffect(() => {
		if (!email?.id) return;
		noteThread({
			mailboxId,
			id: email.id,
			subject: email.subject,
			sender: senderDisplayName(email.sender, email.sender_name),
		});
	}, [email?.id, email?.subject, email?.sender, email?.sender_name, mailboxId, noteThread]);

	/**
	 * Close the reading pane, but only if it is still showing the message we acted
	 * on.
	 *
	 * Every close that happens after an await needs this. `emailId` is captured by
	 * the closure, so over a slow request the user can select another row and the
	 * callback still sees the old id — and `closePanel` closes whatever is open, not
	 * the message it was called about. The result is someone's newly opened message
	 * closing itself because an earlier draft finished being deleted.
	 *
	 * Read from the store rather than from a ref over `emailId`, because the store
	 * is what `closePanel` mutates: this asks the same question the answer depends
	 * on.
	 */
	const closePanelIfShowing = (id: string) => {
		if (useUIStore.getState().selectedEmailId === id) closePanel();
	};

	const [isSending, setIsSending] = useState(false);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [sourceEmail, setSourceEmail] = useState<Email | null>(null);
	const [preview, setPreview] = useState<{
		url: string;
		filename: string;
		mimetype: string;
	} | null>(null);

	/**
	 * Which toolbar menu a keystroke asked for.
	 *
	 * `v` / `l` / `.` are handled here rather than in the toolbar so the shortcut
	 * only ever opens a menu for the message actually on screen.
	 */
	const [openMenu, setOpenMenu] = useState<"move" | "label" | "more" | null>(
		null,
	);

	const messages = useMemo(() => {
		if (!email) return [];
		const replies = (threadRaw ?? []).filter((e) => e.id !== email.id);
		return [email, ...replies].sort(
			(a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
		);
	}, [email, threadRaw]);

	/** Drafts that can still be acted on: sent, edited, discarded. */
	const draftIds = useMemo(() => {
		const ids = new Set<string>();
		for (const msg of messages) {
			if (msg.folder_id === Folders.DRAFT) ids.add(msg.id);
			else if (folderId === Folders.DRAFT && msg.id === emailId) ids.add(msg.id);
		}
		return ids;
	}, [messages, folderId, emailId]);

	/**
	 * The newest message we sent in this conversation, for "Remind me if no
	 * reply" after the fact. Only offered when it is also the newest message
	 * overall: once someone has answered there is nothing to wait for. Declared
	 * above the early returns below, as every hook here must be.
	 */
	const latestSentForReminder = useMemo(() => {
		const own = currentMailbox?.email?.toLowerCase();
		const newest = messages.find(
			(m) => !draftIds.has(m.id) && m.folder_id !== Folders.SCHEDULED,
		);
		if (!newest || !own) return undefined;
		return newest.sender?.toLowerCase() === own ? newest.id : undefined;
	}, [messages, draftIds, currentMailbox?.email]);

	/**
	 * Drafts that were discarded and are sitting in Trash.
	 *
	 * Still labelled drafts — unsent text the user wrote is not incoming mail, and
	 * `folder_id` alone says only "trash", so the card offered Reply and Forward on
	 * something they had written themselves. But they carry no draft actions:
	 * sending or editing from the bin would quietly resurrect a message the user
	 * deleted, so the way back is Restore.
	 */
	const discardedDraftIds = useMemo(() => {
		const ids = new Set<string>();
		for (const msg of messages) {
			if (
				msg.folder_id === Folders.TRASH &&
				msg.trashed_from === Folders.DRAFT
			) {
				ids.add(msg.id);
			}
		}
		return ids;
	}, [messages]);

	// Newest message opens by default, and so does every draft: a draft is unsent
	// work, and its Send/Edit actions live in the expanded card body, so leaving
	// it collapsed hides the only per-message way to act on it. Expansion resets
	// only when the selected conversation changes, not on background refetches.
	useEffect(() => {
		if (messages.length === 0) return;
		const initial = new Set<string>([messages[0].id]);
		for (const msg of messages) {
			if (draftIds.has(msg.id)) initial.add(msg.id);
		}
		setExpanded(initial);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [email?.id]);

	/**
	 * Keystrokes aimed at the open conversation.
	 *
	 * `;` / `:` expand or collapse every message, `n` / `p` step between them, and
	 * `v` / `l` / `.` open a toolbar menu. All published by the shortcut hook, the
	 * same way `/` reaches the search field, so the hook never has to reach into
	 * this component's state.
	 */
	useEffect(() => {
		function onThreadExpand(event: Event) {
			const expand = (event as CustomEvent<boolean>).detail;
			setExpanded(expand ? new Set(messages.map((m) => m.id)) : new Set());
			announce(expand ? "Expanded all messages" : "Collapsed all messages");
		}

		/**
		 * Step between messages in the thread.
		 *
		 * Stepping *expands* the message it lands on and scrolls it into view: a
		 * cursor that moved between collapsed cards would be invisible, which is
		 * the same trap the list cursor exists to avoid.
		 */
		function onThreadStep(event: Event) {
			const delta = (event as CustomEvent<1 | -1>).detail;
			if (messages.length === 0) return;
			setExpanded((prev) => {
				const current = messages.findIndex((m) => prev.has(m.id));
				const from = current === -1 ? 0 : current;
				const next = from + delta;
				if (next < 0 || next >= messages.length) return prev;
				const target = messages[next];
				announce(
					`Message ${next + 1} of ${messages.length}, from ${target.sender}`,
				);
				// Scrolling is deferred so the card has expanded before we move to it.
				requestAnimationFrame(() => {
					document
						.getElementById(`threadmsg-${target.id}`)
						?.scrollIntoView({ block: "nearest" });
				});
				return new Set([target.id]);
			});
		}

		function onMenuRequest(event: Event) {
			const detail = (event as CustomEvent<MenuRequest>).detail;
			if (!detail || detail.target !== "message") return;
			setOpenMenu(detail.menu);
		}

		window.addEventListener("inbox:thread-expand", onThreadExpand);
		window.addEventListener("inbox:thread-step", onThreadStep);
		window.addEventListener(MENU_REQUEST_EVENT, onMenuRequest);
		return () => {
			window.removeEventListener("inbox:thread-expand", onThreadExpand);
			window.removeEventListener("inbox:thread-step", onThreadStep);
			window.removeEventListener(MENU_REQUEST_EVENT, onMenuRequest);
		};
	}, [messages]);

	/** The message a Reply should answer: the newest one we did not send. */
	const lastInbound = useMemo(() => {
		const own = currentMailbox?.email?.toLowerCase();
		const inbound = messages.filter(
			(m) => !draftIds.has(m.id) && m.sender?.toLowerCase() !== own,
		);
		if (inbound.length > 0) return inbound[0];
		const nonDrafts = messages.filter((m) => !draftIds.has(m.id));
		return nonDrafts[0] ?? email;
	}, [messages, draftIds, currentMailbox?.email, email]);

	/**
	 * Where the toolbar's Reply would send, when the sender has redirected it.
	 *
	 * Derived from `lastInbound` rather than the opened message, because that is
	 * the message those buttons actually answer — labelling them from a different
	 * one would name an address the reply is not going to.
	 *
	 * Undefined when `Reply-To` agrees with the sender, which is the common case:
	 * there is nothing to warn about, and a label that always carried an address
	 * would stop being read.
	 */
	const replyDestination = useMemo(() => {
		if (!lastInbound) return undefined;
		const target = {
			raw_headers: lastInbound.raw_headers,
			sender: lastInbound.sender,
		};
		if (!replyToDiffersFromSender(target)) return undefined;
		const recipients = replyRecipients(target);
		return recipients.length > 0 ? recipients.join(", ") : undefined;
	}, [lastInbound]);

	/**
	 * Where this conversation's unsubscribe link points, if any.
	 *
	 * Read from the newest message that carries `List-Unsubscribe` rather than
	 * from the opened one: `messages` is newest-first, and a list that started
	 * sending the header partway through a thread should still be leavable. The
	 * HTTPS form is preferred over the `mailto:` one — RFC 8058 one-click is a
	 * request the sender has undertaken to honour without a confirmation step,
	 * whereas the mail form depends on a composer opening at all.
	 */
	const unsubscribeHref = useMemo(() => {
		for (const message of messages) {
			const parsed = parseUnsubscribe(message.raw_headers);
			if (parsed) return parsed.url ?? parsed.mailto;
		}
		return undefined;
	}, [messages]);

	/**
	 * Whether this conversation is muted.
	 *
	 * Keyed on the thread, falling back to the message id for a message that has
	 * no thread yet — which is what the mute endpoint would store for it too.
	 */
	const isMuted = useMemo(() => {
		const threadId = email?.thread_id ?? email?.id;
		return !!threadId && mutedThreads.includes(threadId);
	}, [mutedThreads, email?.thread_id, email?.id]);

	const moveTargets = useMemo(() => {
		const current = folderId || email?.folder_id;
		// Drafts and Scheduled are not filing destinations — the server refuses them,
		// so offering them would only ever produce an error toast. See `canMoveInto`.
		// Snoozed is reached through Snooze, and Sent only by mail this mailbox
		// sent. See `canMoveMessageInto`.
		const outbound = isOutboundFrom(email?.sender, currentMailbox?.email);
		return folders.filter(
			(f) => f.id !== current && canMoveMessageInto(f.id, { outbound }),
		);
	}, [folders, folderId, email?.folder_id, email?.sender, currentMailbox?.email]);

	/**
	 * A failed fetch used to fall into the skeleton branch below and stay there.
	 * 4xx responses are not retried (see `root.tsx`), so opening a message that
	 * had been deleted in another tab left a loading animation running forever
	 * with no way to find out why.
	 */
	if (emailError && !email) {
		// A shared or stale `?m=` link lands here: say "not found" plainly rather
		// than echoing the API's wording. 403 reads the same, by design.
		const status = (emailError as { status?: number }).status;
		const missing = status === 404 || status === 403;
		return (
			<div
				role="alert"
				className="flex h-full flex-col items-center justify-center px-6 text-center"
			>
				<CloudOff size={22} className="text-text-tertiary" aria-hidden />
				<p className="mt-3 text-sm font-semibold text-text-primary">
					{missing ? "Message not found" : "Could not open this message"}
				</p>
				<p className="mt-1 max-w-xs text-xs font-light text-text-secondary">
					{missing
						? "It may have been deleted, or the link points at a mailbox you don't have access to."
						: errorMessage(
								emailError,
								"It may have been moved or deleted somewhere else.",
							)}
				</p>
				<button
					type="button"
					onClick={closePanel}
					className="mt-4 rounded-[6px] bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
				>
					Back to the list
				</button>
			</div>
		);
	}

	if (!email) return <MessageSkeleton />;

	const isScheduled =
		folderId === Folders.SCHEDULED || email.folder_id === Folders.SCHEDULED;

	const isSpam = folderId === Folders.SPAM || email.folder_id === Folders.SPAM;
	const spamReasons = parseSpamSignals(email.spam_signals);

	/**
	 * Whether this message is known not to have arrived.
	 *
	 * Read off the message rather than the folder, unlike the two flags above: a
	 * failed send sits in Drafts and a bounce in Sent, so there is no folder that
	 * means "this did not get there".
	 */
	// Only the two failure states raise the banner. `queued`, `sent` and
	// `delivered` are progress, shown by the delivery timeline instead.
	const deliveryStatus = isDeliveryProblem(email.delivery_status)
		? email.delivery_status
		: null;

	/**
	 * Whether this message is one this mailbox sent, and so has a delivery
	 * timeline worth showing.
	 *
	 * Decided by SENDER, not by folder. An earlier revision tested for
	 * `folder_id === "sent"`, which quietly lost the timeline the moment anyone
	 * archived or binned a sent message — both explicitly supported moves — even
	 * though its ledger was still there. The mailbox's own address is the durable
	 * fact: mail this mailbox sent has that address in `sender` wherever the
	 * message later ends up.
	 *
	 * The folder and status checks remain as fallbacks for the one case the
	 * sender comparison cannot serve: `currentMailbox` has not loaded yet.
	 */
	const ownAddress = currentMailbox?.email?.toLowerCase();
	const isOutbound = ownAddress
		? email.sender?.toLowerCase() === ownAddress
		: (folderId ?? email.folder_id) === Folders.SENT ||
			email.folder_id === Folders.SENT ||
			(deliveryStatus !== null && draftIds.has(email.id));

	const toggle = (id: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	/**
	 * Move the open message, offering a way back.
	 *
	 * Archive and Move are one-click and close the pane, so without an undo the
	 * only recovery is remembering which folder the message went to and finding
	 * it again. Delete has its own undo in the list; this covers the rest.
	 */
	const handleMove = (targetFolder: string, options: { undo?: boolean } = {}) => {
		const from = email.folder_id ?? folderId;
		moveEmail.mutate(
			{ mailboxId, id: email.id, folderId: targetFolder },
			{
				onSuccess: () => {
					if (!options.undo || !from || from === targetFolder) return;
					showToast({
						message:
							targetFolder === Folders.ARCHIVE
								? "Archived"
								: `Moved to ${targetFolder}`,
						action: {
							label: "Undo",
							onClick: (dismiss) => {
								dismiss();
								moveEmail.mutate({
									mailboxId,
									id: email.id,
									folderId: from,
								});
							},
						},
					});
				},
				onError: (err) =>
					showToast({
						kind: "error",
						message: errorMessage(err, "Could not move that message."),
					}),
			},
		);
		closePanel();
	};

	/**
	 * Delete: bin it, or destroy it if it is already binned.
	 *
	 * No confirmation for the reversible case — the Undo in the toast is a
	 * better answer than a dialog in front of every delete. The irreversible
	 * case still asks.
	 */
	const handleDelete = () => {
		// Same precedence the toolbar uses for its label, so the button cannot say
		// "Delete forever" while the handler treats it as a reversible bin.
		const folder = folderId ?? email.folder_id;
		const alreadyBinned = folder === Folders.TRASH || folder === Folders.SPAM;

		if (alreadyBinned && !window.confirm("Delete this message permanently?")) {
			return;
		}

		const id = email.id;
		deleteEmail.mutate(
			{ mailboxId, id },
			{
				onSuccess: (result) => {
					const trashed = wasTrashed(result);
					showToast(
						trashed
							? {
									message: "Moved to Trash",
									action: {
										label: "Undo",
										onClick: (dismiss) => {
											dismiss();
											restoreEmail.mutate(
												{ mailboxId, id },
												{
													onError: (err) =>
														showToast({
															kind: "error",
															message: errorMessage(
																err,
																"Could not restore that message.",
															),
														}),
												},
											);
										},
									},
								}
							: { message: "Message deleted" },
					);
				},
				onError: (err) =>
					showToast({
						kind: "error",
						message: errorMessage(err, "Could not delete that message."),
					}),
			},
		);
		closePanel();
	};

	const handleSnooze = (untilIso: string) => {
		snooze.mutate(
			{ mailboxId, id: email.id, when: { until: untilIso } },
			{
				onSuccess: () => {
					showToast({ message: `Snoozed. ${formatSnoozeReturn(untilIso)}` });
					closePanel();
				},
				onError: (err) =>
					showToast({
						kind: "error",
						message: errorMessage(err, "Could not snooze."),
					}),
			},
		);
	};

	const handleBlockSender = () => {
		if (!email.sender) return;
		const confirmed = window.confirm(
			`Block ${email.sender}? Future messages go to Spam. Mail already received stays where it is.`,
		);
		if (!confirmed) return;
		blockSender.mutate(
			{ mailboxId, pattern: email.sender },
			{
				onSuccess: () => showToast({ message: `Blocked ${email.sender}` }),
				onError: (err) =>
					showToast({
						kind: "error",
						message: errorMessage(err, "Could not block that sender."),
					}),
			},
		);
	};

	/**
	 * Report spam files the message and blocks the sender in one gesture, which
	 * is what people expect from the button — filing alone leaves the next
	 * message from the same sender in the inbox.
	 */
	const handleMarkSpam = () => {
		moveEmail.mutate(
			{ mailboxId, id: email.id, folderId: Folders.SPAM },
			{
				onSuccess: () => {
					if (email.sender) {
						blockSender.mutate({ mailboxId, pattern: email.sender });
					}
					showToast({
						message: "Reported as spam",
						description: email.sender
							? `Future mail from ${email.sender} goes to Spam.`
							: undefined,
					});
					closePanel();
				},
			},
		);
	};

	/**
	 * The inverse of Report spam, and it has to undo everything that did.
	 *
	 * This used to be a plain move to the inbox, which left the sender blocked
	 * and left the message's spam score in place — so the next message from them
	 * was filed to Spam again and the button appeared to do nothing. The server
	 * route clears the block, allowlists the sender and clears the score in one
	 * step.
	 */
	const handleNotSpam = () => {
		markNotSpam.mutate(
			{ mailboxId, id: email.id },
			{
				onSuccess: () => {
					showToast({
						kind: "success",
						message: "Moved to Inbox",
						description: email.sender
							? `Mail from ${email.sender} will not be filed as spam again.`
							: undefined,
					});
					closePanel();
				},
				onError: (err) =>
					showToast({
						kind: "error",
						message: errorMessage(err, "Could not move that message."),
					}),
			},
		);
	};

	/**
	 * Mute or unmute the conversation.
	 *
	 * Muting is about the future: replies that arrive later are archived and
	 * pre-read rather than returning to the inbox, and the agent stops drafting
	 * for them. It deliberately leaves the messages already here alone.
	 */
	const handleToggleMute = () => {
		const threadId = email.thread_id ?? email.id;
		setThreadMuted.mutate(
			{ mailboxId, threadId, muted: !isMuted },
			{
				onSuccess: () =>
					showToast({
						message: isMuted
							? "Conversation unmuted"
							: "Conversation muted — new replies go to Archive",
					}),
				onError: (err) =>
					showToast({
						kind: "error",
						message: errorMessage(err, "Could not change the mute setting."),
					}),
			},
		);
	};

	const handlePrint = () => {
		const prepared = prepareEmailHtml(email.body, {
			mailboxId,
			emailId: email.id,
			attachments: email.attachments,
			// Printing is an explicit act, so remote images are fair game here,
			// through the proxy like everywhere else.
			allowRemoteImages: true,
			imageProxy: email.image_proxy,
		});

		const frame = document.createElement("iframe");
		frame.style.position = "fixed";
		frame.style.right = "0";
		frame.style.bottom = "0";
		frame.style.width = "0";
		frame.style.height = "0";
		frame.style.border = "0";
		document.body.appendChild(frame);

		const doc = frame.contentDocument;
		if (!doc) {
			document.body.removeChild(frame);
			return;
		}

		/**
		 * This frame is a bare `about:blank`, so it inherits the app's origin —
		 * anything that executes here has the session, the API and the DOM.
		 *
		 * Both halves of the document therefore need handling, and neither had it:
		 *
		 * - Header fields are escaped. A subject of `</style><img src=x onerror=…>`
		 *   previously broke out of the `<title>` and ran.
		 * - The body is sanitised. `prepareEmailHtml` only rewrites `img src` for
		 *   `cid:` resolution and remote-image blocking; the DOMPurify pass lives in
		 *   `EmailIframe`, which this path does not go through. So the stored body
		 *   was reaching a same-origin document untouched.
		 */
		const field = (value: string | null | undefined) =>
			escapeHtml(value ?? "");
		const safeBody = sanitizeInlineHtml(prepared.html);

		doc.open();
		doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${
			field(email.subject) || "Message"
		}</title><style>
			body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 12pt; padding: 24px; }
			.meta { border-bottom: 1px solid #ccc; margin-bottom: 16px; padding-bottom: 8px; font-size: 10pt; color: #444; }
			img { max-width: 100%; }
		</style></head><body>
			<h1 style="font-size:14pt;margin:0 0 8px">${field(email.subject) || "(no subject)"}</h1>
			<div class="meta">
				<div><strong>From:</strong> ${field(email.sender)}</div>
				<div><strong>To:</strong> ${field(email.recipient)}</div>
				${email.cc ? `<div><strong>Cc:</strong> ${field(email.cc)}</div>` : ""}
				<div><strong>Date:</strong> ${field(email.date)}</div>
			</div>
			${safeBody}
		</body></html>`);
		doc.close();

		frame.contentWindow?.focus();
		frame.contentWindow?.print();
		// Give the print dialog time to take a snapshot of the document.
		setTimeout(() => frame.remove(), 1000);
	};

	const handleEditDraft = (draft: Email) => {
		if (draft.in_reply_to) {
			startCompose({
				mode: "reply",
				// Matched on row id or Message-ID: a draft that came back from Undo Send
				// names its parent by Message-ID, and matching only on id opened a reply
				// composer with no original attached — which then failed to send.
				originalEmail: findThreadParent(messages, draft.in_reply_to),
				draftEmail: draft,
			});
		} else {
			startCompose({ mode: "new", draftEmail: draft });
		}
	};

	/**
	 * Discard a draft into Trash rather than destroying it.
	 *
	 * A draft is often the only copy of something someone spent a while writing,
	 * so this is the last place to make Delete final. Undo replaces the
	 * confirmation dialog.
	 */
	const handleDeleteDraft = (draft: Email) => {
		deleteEmail.mutate(
			{ mailboxId, id: draft.id },
			{
				onSuccess: (result) => {
					/**
					 * Undo is offered only when there is something to undo.
					 *
					 * `deleteOrTrash` bins a draft but *destroys* one already in Trash. This
					 * used to announce "Draft moved to Trash" and offer Undo unconditionally,
					 * so on the destroy path it promised a recovery that could not happen —
					 * and the Undo, having no `onError`, then failed its 404 in silence.
					 */
					const trashed = wasTrashed(result);

					showToast(
						trashed
							? {
									message: "Draft moved to Trash",
									action: {
										label: "Undo",
										onClick: (dismiss) => {
											dismiss();
											restoreEmail.mutate(
												{ mailboxId, id: draft.id },
												{
													onError: (err) =>
														showToast({
															kind: "error",
															message: errorMessage(
																err,
																"Could not restore that draft.",
															),
														}),
												},
											);
										},
									},
								}
							: { message: "Draft deleted" },
					);

					// Closed here rather than alongside the mutate call: the delete is not
					// optimistic, so closing up front left a failure reported against a
					// pane that had already gone, with the draft still sitting in Drafts.
					// Scoped to the live selection because moving it here introduced a
					// window in which the selection can change — see `closePanelIfShowing`.
					closePanelIfShowing(draft.id);
				},
				onError: (err) =>
					showToast({
						kind: "error",
						message: errorMessage(err, "Could not discard that draft."),
					}),
			},
		);
	};

	const handleSendDraft = async (draft: Email) => {
		if (!currentMailbox) return;
		setIsSending(true);
		try {
			let target = draft;
			// List rows are a projection: no body, and `attachments` is deliberately
			// omitted in favour of the `has_attachment` flag. Anything short of the
			// detail record has to be refetched, or the send goes out missing the
			// very fields it is made of.
			if (!target.recipient || !target.subject || !target.attachments) {
				try {
					const fresh = (await api.getEmail(mailboxId, target.id)) as Email;
					if (fresh) target = fresh;
				} catch {
					// Fall through with what the list gave us; validation below catches
					// a genuinely empty draft.
				}
			}

			const recipients = splitEmailList(target.recipient);
			if (recipients.length === 0) {
				showToast({
					kind: "error",
					message: "This draft has no recipient yet.",
				});
				return;
			}

			const fromName =
				currentMailbox.settings?.fromName || currentMailbox.name;
			const from =
				fromName && fromName !== currentMailbox.email
					? { email: currentMailbox.email, name: fromName }
					: currentMailbox.email;

			/**
			 * What this reply attaches to, as the server should resolve it.
			 *
			 * Not `messages.find(m => m.id === in_reply_to)`, which was wrong twice
			 * over: it missed a Message-ID-form reference (every draft that came back
			 * from Undo Send), and it missed a parent outside the capped thread window
			 * (any long conversation). Both dropped `replyToEmailId`, and the reply
			 * then went out with no In-Reply-To and no References — a fresh
			 * conversation in the recipient's client, invisible from our own Sent
			 * folder.
			 */
			const replyTargetId = replyTargetForDraft(messages, target);

			// The draft's files live in R2 under the draft's own id, so they have to
			// be pulled back and re-encoded for the send. Sending from here used to
			// build the payload from the row's text fields alone, which quietly
			// dropped every attachment the draft was saved with — the composer path
			// did not, so the same draft sent differently depending on which button
			// you used.
			if (target.has_attachment && !target.attachments) {
				// The refetch above failed, so we know files exist but not what they
				// are. Sending now would drop them without saying so.
				showToast({
					kind: "error",
					message: "Could not load this draft's attachments.",
					description: "Check your connection and try again.",
				});
				return;
			}
			const { attachments: draftAttachments, failed } =
				await loadAttachmentsForSend(mailboxId, target.id, target.attachments);
			if (failed.length > 0) {
				showToast({
					kind: "error",
					message: `Could not attach ${failed.join(", ")}`,
					description: "Open the draft to attach again before sending.",
				});
				return;
			}

			// The draft row is removed by the server as part of accepting the send —
			// see `supersedesDraftId`. Doing it here in a follow-up request meant a
			// send that had already been accepted could still report failure, and the
			// follow-up needed `deletePermanently`, which the `agent` preset lacks.
			await sendWithUndo({
				mailboxId,
				email: {
					to: toEmailListValue(recipients),
					cc: toEmailListValue(splitEmailList(target.cc)),
					bcc: toEmailListValue(splitEmailList(target.bcc)),
					from,
					subject: target.subject || "(no subject)",
					html: target.body || "",
					text: (target.body || "").replace(/<[^>]*>/g, "").trim(),
					...(draftAttachments.length > 0
						? { attachments: draftAttachments }
						: {}),
				},
				/**
				 * No `threadedMode`, so this defaults to "reply" and marks the thread
				 * read. A stored draft does not record whether it was started as a reply
				 * or a forward — both write the parent into `in_reply_to` and nothing
				 * else — so the distinction cannot be recovered here without a column to
				 * carry the intent. Defaulting to "reply" is the better error: the user
				 * has the conversation open in front of them, so treating it as read is
				 * true either way, whereas leaving it unread would put a bold subject on
				 * a thread they just answered. The composer, which does know its mode,
				 * passes it explicitly.
				 */
				...(replyTargetId ? { replyToEmailId: replyTargetId } : {}),
				supersedesDraftId: target.id,
			});

			// Same staleness window, and it was always here: this close comes after
			// several awaits. `folderId === DRAFT` alone would close whatever the user
			// had selected in the meantime, and would also close the pane when the
			// draft sent was a card inside a thread rather than the message on screen.
			if (folderId === Folders.DRAFT) closePanelIfShowing(target.id);
		} catch (err) {
			showToast({
				kind: "error",
				message: errorMessage(err, "Could not send that draft."),
			});
		} finally {
			setIsSending(false);
		}
	};

	const hasThread = messages.length > 1;

	return (
		<div className="flex h-full min-h-0 flex-col bg-card">
			<MessageToolbar
				openMenu={openMenu}
				onOpenMenuChange={setOpenMenu}
				email={email}
				folderId={folderId}
				labels={labels}
				emailLabels={emailLabels}
				moveTargets={moveTargets}
				isSending={isSending}
				onClose={closePanel}
				onReply={() => startCompose({ mode: "reply", originalEmail: lastInbound })}
				onReplyAll={() =>
					startCompose({ mode: "reply-all", originalEmail: lastInbound })
				}
				onForward={() => startCompose({ mode: "forward", originalEmail: email })}
				onArchive={() => handleMove(Folders.ARCHIVE, { undo: true })}
				onDelete={handleDelete}
				onRestore={() => {
					restoreEmail.mutate(
						{ mailboxId, id: email.id },
						{
							onSuccess: () => showToast({ message: "Restored" }),
							onError: (err) =>
								showToast({
									kind: "error",
									message: errorMessage(err, "Could not restore that message."),
								}),
						},
					);
					closePanel();
				}}
				onToggleStar={() =>
					updateEmail.mutate({
						mailboxId,
						id: email.id,
						data: { starred: !email.starred },
					})
				}
				onToggleRead={() => {
					updateEmail.mutate({
						mailboxId,
						id: email.id,
						data: { read: !email.read },
					});
					if (email.read) closePanel();
				}}
				onMove={(target) => handleMove(target, { undo: true })}
				onSetLabels={(labelIds) =>
					setEmailLabels.mutate({ mailboxId, emailId: email.id, labelIds })
				}
				onSnooze={handleSnooze}
				onUnsnooze={() =>
					unsnooze.mutate(
						{ mailboxId, id: email.id },
						{
							onSuccess: () =>
								showToast({ message: "Returned to its folder" }),
						},
					)
				}
				onSetPriority={(priority: EmailPriority) =>
					setPriority.mutate({ mailboxId, id: email.id, priority })
				}
				onBlockSender={handleBlockSender}
				isMuted={isMuted}
				onToggleMute={handleToggleMute}
				onMarkSpam={handleMarkSpam}
				onNotSpam={handleNotSpam}
				onPrint={handlePrint}
				unsubscribeHref={unsubscribeHref}
				replyDestination={replyDestination}
				onCancelScheduled={
					isScheduled
						? () =>
								cancelScheduled.mutate(
									{ mailboxId, emailId: email.id },
									{
										onSuccess: () => {
											showToast({
												kind: "success",
												message: "Send cancelled. Saved to Drafts.",
											});
											closePanel();
										},
										onError: (err) =>
											showToast({
												kind: "error",
												message: errorMessage(
													err,
													"Could not cancel that send.",
												),
											}),
									},
								)
						: undefined
				}
				isCancellingScheduled={cancelScheduled.isPending}
				onSendDraft={
					draftIds.has(email.id) ? () => handleSendDraft(email) : undefined
				}
				onEditDraft={
					draftIds.has(email.id) ? () => handleEditDraft(email) : undefined
				}
			/>

			{/* Subject + snooze state */}
			{/*
			  `py-2.5`, from `py-4`. The subject is one line of 17px text; it was
			  sitting in 32px of vertical padding directly above a message that has to
			  share the same column.
			*/}
			<div className="shrink-0 border-b border-border px-4 py-2.5">
				<h2 className="break-words text-xl font-semibold leading-snug tracking-tight text-text-primary [overflow-wrap:anywhere]">
					{email.subject?.trim() || "(no subject)"}
				</h2>
				<div className="mt-1 flex flex-wrap items-center gap-2 empty:mt-0">
					{hasThread && (
						<span className="text-[11px] font-light text-text-tertiary">
							{messages.length} messages
						</span>
					)}
					{email.snoozed_until && (
						<span className="rounded-[4px] bg-accent-subtle px-1.5 py-0.5 text-[11px] font-semibold text-accent-subtle-fg">
							{formatSnoozeReturn(email.snoozed_until)}
						</span>
					)}
					{emailLabels.map((label) => (
						<span
							key={label.id}
							className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium text-text-secondary"
						>
							<span
								className="h-2 w-2 rounded-full"
								style={{ backgroundColor: label.color }}
								aria-hidden
							/>
							{label.name}
						</span>
					))}
				</div>
			</div>

			{!isSpam && email.folder_id !== Folders.TRASH && (
				<FollowupBanner
					mailboxId={mailboxId}
					emailId={email.id}
					sentEmailId={latestSentForReminder}
				/>
			)}

			{/*
			  Why this is in Spam.
			  
			  A filter that files mail without saying why is indistinguishable from a
			  bug, and the user cannot tell whether to trust it or to correct it. The
			  reasons are the ones recorded at delivery, so they still describe the
			  decision that was actually made even if the rules have changed since.
			*/}
			{isSpam && spamReasons.length > 0 && (
				<div className="shrink-0 border-b border-border bg-amber-500/5 px-4 py-2.5">
					<p className="text-[11px] font-semibold text-text-primary">
						Filed as spam because:
					</p>
					<ul className="mt-1 space-y-0.5">
						{spamReasons.map((reason) => (
							<li
								key={reason.id}
								className="text-[11px] font-light leading-snug text-text-secondary"
							>
								{reason.label}
							</li>
						))}
					</ul>
				</div>
			)}

			{/*
			  Why this message did not arrive.
			  
			  Same markup as the spam banner above, in destructive rather than amber:
			  both answer "why is this message not where I expected it to be", and
			  giving them one shape means the reading pane has one place a banner
			  appears rather than two competing ones.
			  
			  `role="status"` with a polite live region: the banner appears when a
			  message is opened, not in response to a keystroke, so a screen reader
			  user who navigated into a failed draft is otherwise told nothing at all.
			  Polite rather than assertive because it is describing what is already on
			  screen, not interrupting with something new.
			*/}
			{deliveryStatus && (
				<div
					role="status"
					aria-live="polite"
					className="shrink-0 border-b border-border bg-destructive/5 px-4 py-2.5"
				>
					<div className="flex items-start gap-2">
						<AlertTriangle
							size={13}
							className="mt-px shrink-0 text-destructive"
							aria-hidden
						/>
						<div className="min-w-0 flex-1">
							<p className="text-[11px] font-semibold text-text-primary">
								{deliveryStatus === "failed"
									? "Couldn't be sent"
									: "Delivery failed"}
							</p>
							<p className="mt-1 text-[11px] font-light leading-snug text-text-secondary">
								{deliveryStatus !== "failed"
									? "The receiving server rejected this message."
									: draftIds.has(email.id)
										? "We tried several times and gave up. It's saved here as a draft."
										: "Cloudflare Email Service didn't accept this message, so it wasn't delivered."}
							</p>
							{/*
							  The remote server's own words. Kept verbatim and unstyled
							  rather than reworded: it is the only text that says whether
							  the address was wrong, the mailbox was full or a policy
							  refused it, and a friendlier paraphrase would lose exactly
							  the part that tells the user what to do next.
							*/}
							{email.delivery_error && (
								<p className="mt-1 break-words text-[11px] font-light leading-snug text-text-tertiary">
									{email.delivery_error}
								</p>
							)}
							{/*
							  Retry only for `failed`, and only for a draft. A bounce was
							  accepted and then refused downstream, so resending the same
							  message to the same address just reproduces it; there is no
							  draft to reopen either. Reopening the composer rather than
							  firing a send straight off: the send failed for a reason, and
							  the address is the most likely one.
							*/}
							{deliveryStatus === "failed" && draftIds.has(email.id) && (
								<button
									type="button"
									onClick={() => handleEditDraft(email)}
									className="mt-2 rounded-[6px] border border-border px-2 py-1 text-[11px] font-semibold text-text-primary hover:bg-bg-muted"
								>
									Retry
								</button>
							)}
						</div>
					</div>
				</div>
			)}

			{/*
			  Delivery timeline for a message this mailbox sent. Sits under the
			  failure banner (which stays as the loud, always-visible signal) and
			  adds the full picture — delivered/opened/clicked and the coarse
			  our-side-vs-their-side attribution on a failure — behind a lazy
			  disclosure, so it costs nothing until opened. Shown for outbound mail
			  only; inbound has no timeline.
			*/}
			{isOutbound && (
				<DeliveryTimeline mailboxId={mailboxId} emailId={email.id} email={email} />
			)}

			{/*
			  The trailing rule under the last card is dropped: it reads as a divider
			  promising another message below, and there is none.
			*/}
			<div className="min-h-0 flex-1 overflow-y-auto pb-6 smooth-scroll [&>article:last-child]:border-b-0">
				{/*
				  The AI summary card, first in the scroll area like Gmail's, so it
				  scrolls away with the conversation instead of pinning a band above
				  it. Never for Spam, Trash or Drafts.
				*/}
				<ThreadSummaryPanel
					mailboxId={mailboxId}
					threadId={email.thread_id ?? email.id}
					disabled={
						isSpam ||
						folderId === Folders.TRASH ||
						email.folder_id === Folders.TRASH ||
						folderId === Folders.DRAFT
					}
				/>
				{messages.map((msg) => {
					const isDraft = draftIds.has(msg.id);
					// Labelled a draft either way; only a live one gets the actions.
					const isDiscardedDraft = discardedDraftIds.has(msg.id);
					return (
						<MessageCard
							key={msg.id}
							email={msg}
							mailboxId={mailboxId}
							mailboxEmail={currentMailbox?.email}
							expanded={hasThread ? expanded.has(msg.id) : true}
							onToggle={() => toggle(msg.id)}
							collapsible={hasThread}
							isDraft={isDraft || isDiscardedDraft}
							isSending={isDraft ? isSending : false}
							onSendDraft={isDraft ? () => handleSendDraft(msg) : undefined}
							onEditDraft={isDraft ? () => handleEditDraft(msg) : undefined}
							onDeleteDraft={isDraft ? () => handleDeleteDraft(msg) : undefined}
							onReply={
								isDraft || isDiscardedDraft
									? undefined
									: () => startCompose({ mode: "reply", originalEmail: msg })
							}
							onReplyAll={
								isDraft || isDiscardedDraft || !hasMultipleRecipients(msg)
									? undefined
									: () => startCompose({ mode: "reply-all", originalEmail: msg })
							}
							onForward={
								isDraft || isDiscardedDraft
									? undefined
									: () => startCompose({ mode: "forward", originalEmail: msg })
							}
							onViewSource={() => setSourceEmail(msg)}
							onPreviewAttachment={setPreview}
						/>
					);
				})}
			</div>

			{/* Source viewer */}
			{sourceEmail && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
					role="dialog"
					aria-modal="true"
					aria-label="Message source"
					onClick={() => setSourceEmail(null)}
				>
					<div
						className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-[10px] bg-card shadow-2xl"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="flex items-center justify-between border-b border-border px-4 py-2.5">
							<h3 className="text-sm font-semibold text-text-primary">
								Message source
							</h3>
							<button
								type="button"
								onClick={() => setSourceEmail(null)}
								className="rounded-[6px] px-2 py-1 text-xs text-text-secondary hover:bg-bg-muted"
							>
								Close
							</button>
						</div>
						<pre className="min-h-0 flex-1 overflow-auto bg-bg-subtle p-4 text-[11px] leading-relaxed text-text-secondary">
							{sourceEmail.raw_headers || "No stored headers for this message."}
							{"\n\n"}
							{sourceEmail.body ?? ""}
						</pre>
					</div>
				</div>
			)}

			{/* Attachment preview */}
			{preview && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
					role="dialog"
					aria-modal="true"
					aria-label={preview.filename}
					onClick={() => setPreview(null)}
				>
					<div
						className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-[10px] bg-card shadow-2xl"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="flex items-center justify-between border-b border-border px-4 py-2.5">
							<h3 className="truncate text-sm font-semibold text-text-primary">
								{preview.filename}
							</h3>
							<div className="flex items-center gap-2">
								<a
									href={preview.url}
									download={preview.filename}
									className="rounded-[6px] border border-border px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-muted"
								>
									Download
								</a>
								<button
									type="button"
									onClick={() => setPreview(null)}
									className="rounded-[6px] px-2 py-1 text-xs text-text-secondary hover:bg-bg-muted"
								>
									Close
								</button>
							</div>
						</div>
						<div className="min-h-0 flex-1 overflow-auto bg-bg-subtle p-3">
							{preview.mimetype.startsWith("image/") ? (
								<img
									src={preview.url}
									alt={preview.filename}
									className="mx-auto max-h-full max-w-full object-contain"
								/>
							) : (
								<iframe
									src={preview.url}
									title={preview.filename}
									className="h-[70vh] w-full rounded-[6px] border border-border bg-card"
								/>
							)}
						</div>
					</div>
				</div>
			)}

			{isSending && (
				<div className="flex shrink-0 items-center gap-2 border-t border-border bg-bg-subtle px-4 py-2">
					<Loader2 size={13} className="animate-spin text-text-tertiary" />
					<span className="text-[11px] font-light text-text-secondary">
						Sending…
					</span>
				</div>
			)}
		</div>
	);
}
