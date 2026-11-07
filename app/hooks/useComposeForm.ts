// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { trackFieldFor } from "shared/compose-tracking";
import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { showToast } from "~/lib/toast";
import {
	buildQuotedReplyBlock,
	escapeHtml,
	formatComposeDate,
	getSignatureBlock,
	htmlToPlainText,
	isEmailAddress,
	splitEmailList,
	toEmailListValue,
} from "~/lib/utils";
// Sending goes through the scheduled-send path (see handleSend) so every send
// gets an undo window, which is why the direct send/reply/forward mutations are
// no longer used here.
import { useDeleteEmail, useSaveDraft } from "~/queries/emails";
import { useScheduleEmail } from "~/queries/scheduled-sends";
import { useSendWithUndo } from "~/hooks/useSendWithUndo";
import { useDefaultSignature } from "~/queries/signatures";
import { useMailbox } from "~/queries/mailboxes";
import { useMailboxAliases } from "~/queries/domains";
import { buildFromOptions, pickDefaultFrom, withFromEmail } from "shared/domains-ui";
import { useProducts } from "~/queries/products";
import { fromNameFor, signatureForFrom, signatureKey, swapProductSignature } from "shared/products";
import { useUIStore } from "~/hooks/useUIStore";
import {
	attachmentsSignature,
	prepareAttachmentsForApi,
	stageStoredAttachments,
} from "~/lib/attachment-transfer";
import { replyRecipients } from "shared/headers";
import type { AttachmentFile } from "~/components/mail/AttachmentPicker";
import {
	choiceForDefault,
	followupRequestFor,
	type FollowupChoice,
} from "~/components/mail/FollowupMenu";

/**
 * Idle gap before an edited composer is written back as a draft.
 *
 * Long enough that ordinary typing doesn't generate a request per word, short
 * enough that an accidental close loses at most a sentence.
 */
const AUTOSAVE_IDLE_MS = 2500;

function appendUniqueAddress(
	addresses: string[],
	seen: Set<string>,
	address: string,
	exclude?: string,
) {
	const trimmed = address.trim();
	if (!trimmed) return;

	const normalized = trimmed.toLowerCase();
	if (normalized === exclude || seen.has(normalized)) return;

	seen.add(normalized);
	addresses.push(trimmed);
}

interface ComposeFormFields {
	to: string;
	cc: string;
	bcc: string;
	showCc: boolean;
	showBcc: boolean;
	subject: string;
	body: string;
}

const EMPTY_FIELDS: ComposeFormFields = {
	to: "",
	cc: "",
	bcc: "",
	showCc: false,
	showBcc: false,
	subject: "",
	body: "",
};

/** Recipient strings to use in place of the current state, if any. */
export interface RecipientOverrides {
	to?: string;
	cc?: string;
	bcc?: string;
}

/** Per-field validation messages, rendered against the offending row. */
export interface RecipientFieldErrors {
	to?: string;
	cc?: string;
	bcc?: string;
}

/**
 * First unusable address in a list, if any.
 *
 * The send route validates cc and bcc with Zod's `.email()`, but nothing checked
 * them here — a typo in Cc surfaced as a generic failure toast after Send, with
 * no clue which address was at fault.
 */
function firstInvalidAddress(list: string): string | undefined {
	return splitEmailList(list).find((address) => !isEmailAddress(address));
}

function getPrefixedSubject(subject: string, prefix: "Re" | "Fwd") {
	const expectedPrefix = `${prefix}: `;
	return subject.startsWith(expectedPrefix)
		? subject
		: `${expectedPrefix}${subject}`;
}

function buildForwardBody(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	sigBlock: string,
) {
	const safeSender = escapeHtml(original.sender);
	const safeSubject = escapeHtml(original.subject);
	// A forward keeps the whole original, quote chain included, but as plain
	// text with its line breaks intact instead of one flattened run.
	const safeBody = escapeHtml(htmlToPlainText(original.body || "")).replace(/\n/g, "<br>");

	return `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}<div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>Forwarded message:</strong><br><strong>From:</strong> ${safeSender}<br><strong>Date:</strong> ${formatComposeDate(original.date)}<br><strong>Subject:</strong> ${safeSubject}<br><br>${safeBody}</div>`;
}

function buildReplyAllFields(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	selfAddress?: string,
) {
	const toRecipients: string[] = [];
	const toSeen = new Set<string>();

	/**
	 * The author's suggested reply address leads, then the original recipients.
	 *
	 * `replyRecipients` returns every address in `Reply-To`, because a sender who
	 * names two means both. Where there is no `Reply-To` it yields `From`, which is
	 * what this always used.
	 *
	 * Note what reply-all deliberately does *not* do: drop the other recipients
	 * when `Reply-To` is set. RFC 5322 lets the author redirect replies, not
	 * un-address the people they wrote to, and a reply-all that quietly narrowed to
	 * one address would be the more dangerous surprise of the two.
	 */
	for (const address of replyRecipients(original)) {
		appendUniqueAddress(toRecipients, toSeen, address, selfAddress);
	}

	for (const recipient of splitEmailList(original.recipient)) {
		appendUniqueAddress(toRecipients, toSeen, recipient, selfAddress);
	}

	const ccRecipients: string[] = [];
	const ccSeen = new Set<string>();
	for (const recipient of splitEmailList(original.cc)) {
		const normalized = recipient.toLowerCase();
		if (
			normalized === selfAddress ||
			toSeen.has(normalized) ||
			ccSeen.has(normalized)
		) {
			continue;
		}
		ccSeen.add(normalized);
		ccRecipients.push(recipient);
	}

	return {
		to: toRecipients.join(", "),
		cc: ccRecipients.join(", "),
		showCc: ccRecipients.length > 0,
	};
}

function buildInitialComposeFields(
	composeOptions: ReturnType<typeof useUIStore.getState>["composeOptions"],
	mailboxEmail: string | undefined,
	sigBlock: string,
): ComposeFormFields {
	const { draftEmail: draft, originalEmail: original, mode } = composeOptions;

	if (draft) {
		return {
			to: draft.recipient || "",
			cc: draft.cc || "",
			bcc: draft.bcc || "",
			showCc: Boolean(draft.cc),
			showBcc: Boolean(draft.bcc),
			subject: draft.subject || "",
			body: draft.body || "",
		};
	}

	if (!original) {
		const prefill = composeOptions.prefill;
		return {
			...EMPTY_FIELDS,
			to: prefill?.to ?? "",
			cc: prefill?.cc ?? "",
			bcc: prefill?.bcc ?? "",
			showCc: !!prefill?.cc,
			showBcc: !!prefill?.bcc,
			subject: prefill?.subject ?? "",
			body: prefill?.body ?? (sigBlock ? `<p><br></p>${sigBlock}` : ""),
		};
	}

	if (mode === "reply") {
		return {
			...EMPTY_FIELDS,
			// `Reply-To` where the sender set one, `From` otherwise — RFC 5322 §3.6.2.
			// This used to be `original.sender` unconditionally, which sent every
			// reply to a mailing list or ticketing system's robot `From` address
			// instead of the address it asked to be answered on.
			to: replyRecipients(original).join(", ") || original.sender,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, original.body || "")}`,
		};
	}

	if (mode === "reply-all") {
		const recipients = buildReplyAllFields(original, mailboxEmail?.toLowerCase());
		return {
			...EMPTY_FIELDS,
			...recipients,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, original.body || "")}`,
		};
	}

	if (mode === "forward") {
		return {
			...EMPTY_FIELDS,
			subject: getPrefixedSubject(original.subject, "Fwd"),
			body: buildForwardBody(original, sigBlock),
		};
	}

	return {
		...EMPTY_FIELDS,
		body: sigBlock ? `<p><br></p>${sigBlock}` : "",
	};
}

export function useComposeForm(mailboxId?: string, _folder?: string) {
	const { composeOptions, closePanel, closeCompose } = useUIStore();
	const { data: currentMailbox } = useMailbox(mailboxId);
	const saveDraftMutation = useSaveDraft();
	const deleteEmailMutation = useDeleteEmail();
	const scheduleEmailMutation = useScheduleEmail();
	const sendWithUndo = useSendWithUndo();

	const { data: aliases = [] } = useMailboxAliases(mailboxId);

	/**
	 * The From address: the mailbox's own, or one of its aliases.
	 *
	 * `fromChoice` is the user's explicit pick and is cleared whenever the
	 * composer is pointed at a new message. Until then the default is derived,
	 * not stored, so it settles correctly even when the aliases arrive after the
	 * composer opened: a reply to mail sent to an alias answers from that alias.
	 */
	const [fromChoice, setFromChoice] = useState<string | null>(null);
	const fromOptions = useMemo(
		() => (currentMailbox ? buildFromOptions(currentMailbox.email, aliases) : []),
		[currentMailbox, aliases],
	);
	const fromEmail = useMemo(() => {
		if (!currentMailbox) return "";
		if (fromChoice && fromOptions.includes(fromChoice)) return fromChoice;
		const source =
			composeOptions.mode === "new"
				? composeOptions.draftEmail
					? // A reopened draft: keep the address it was written from, when
						// that is still one of ours.
						{ recipient: composeOptions.draftEmail.sender }
					: null
				: composeOptions.originalEmail;
		return pickDefaultFrom(currentMailbox.email, aliases, source);
	}, [currentMailbox, fromChoice, fromOptions, aliases, composeOptions]);

	const [to, setTo] = useState("");
	const [cc, setCc] = useState("");
	const [bcc, setBcc] = useState("");
	const [showCc, setShowCc] = useState(false);
	const [showBcc, setShowBcc] = useState(false);
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [attachments, setAttachments] = useState<AttachmentFile[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [fieldErrors, setFieldErrors] = useState<RecipientFieldErrors>({});
	const [isSavingDraft, setIsSavingDraft] = useState(false);
	const [isSending, setIsSending] = useState(false);
	/**
	 * "Remind me if no reply". Starts from the mailbox default; `null` until the
	 * user touches it, so a settings change made while the composer is open is
	 * still picked up.
	 */
	const [followupPick, setFollowup] = useState<FollowupChoice | null>(null);
	const followup =
		followupPick ?? choiceForDefault(currentMailbox?.settings?.followups?.default);
	/** "Don't track this message": send this one without open/click tracking. */
	const [dontTrack, setDontTrack] = useState(false);
	const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
	/** True while a draft's or forward's stored attachments are being fetched. */
	const [isLoadingAttachments, setIsLoadingAttachments] = useState(false);
	const lastInitializedOptionsRef = useRef<typeof composeOptions | null>(null);
	const isDraftEdit = !!composeOptions.draftEmail;

	/**
	 * The draft row this composer owns.
	 *
	 * Saving replaces the row server-side and hands back a new id, so autosave
	 * has to follow it — otherwise every save would leave the previous copy
	 * behind and Drafts would fill with near-identical rows.
	 */
	const draftIdRef = useRef<string | undefined>(composeOptions.draftEmail?.id);
	/** Snapshot of the last persisted fields, so an idle composer stays quiet. */
	const savedSnapshotRef = useRef<string | null>(null);
	/**
	 * Signature of the attachment set as last written to the draft.
	 *
	 * Autosave only ships attachments when this changes. Re-encoding and
	 * re-uploading unchanged files on every idle save would move the same bytes
	 * repeatedly while the user typed.
	 */
	const savedAttachmentsRef = useRef<string>("");
	/**
	 * Set once the content has left as a real message. The fields still differ
	 * from the last saved snapshot at that point, so without this latch autosave
	 * would fire on its way out and re-create the draft we just deleted.
	 */
	const dispatchedRef = useRef(false);

	const formTitle = useMemo(() => {
		if (isDraftEdit) return "Edit Draft";
		switch (composeOptions.mode) { case "reply": return "Reply"; case "reply-all": return "Reply All"; case "forward": return "Forward"; default: return "New Message"; }
	}, [composeOptions.mode, isDraftEdit]);

	/**
	 * The signature to prefill with.
	 *
	 * A stored signature marked default wins over the single signature in the
	 * mailbox settings blob, which it supersedes. The blob remains the fallback
	 * so mailboxes configured before stored signatures existed keep theirs
	 * without having to re-enter it.
	 */
	const { data: defaultSignature } = useDefaultSignature(mailboxId);
	const { data: products = [] } = useProducts();
	/** The mailbox's own default signature, inner HTML, or "" when none. */
	const mailboxSignatureHtml = useMemo(() => {
		if (defaultSignature?.body_html?.trim()) return defaultSignature.body_html;
		const legacy = getSignatureBlock(currentMailbox?.settings);
		// The legacy helper returns a whole block; keep only what is inside it.
		return legacy ? legacy.replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "") : "";
	}, [defaultSignature, currentMailbox]);
	/**
	 * What signs a message from `from`: the From product's signature when it has
	 * one, else the mailbox default. Tagged, so a later From change can find and
	 * replace it (see `swapProductSignature`). A signature picked by hand from
	 * the menu is not tagged and is never touched.
	 */
	const signatureFor = useCallback(
		(from: string) => signatureForFrom(products, from, mailboxSignatureHtml),
		[products, mailboxSignatureHtml],
	);
	const sigBlock = useMemo(() => {
		const next = signatureFor(fromEmail);
		return next ? swapProductSignature("", next) : "";
	}, [signatureFor, fromEmail]);
	/** The From address and signature last written into the body. */
	const appliedSignatureRef = useRef<{ from: string; key: string } | null>(null);

	useEffect(() => {
		if (lastInitializedOptionsRef.current === composeOptions) return;
		lastInitializedOptionsRef.current = composeOptions;

		const initialFields = buildInitialComposeFields(
			composeOptions,
			currentMailbox?.email,
			sigBlock,
		);
		setError(null);
		setFieldErrors({});
		setFromChoice(null);
		setTo(initialFields.to);
		setCc(initialFields.cc);
		setBcc(initialFields.bcc);
		setShowCc(initialFields.showCc);
		setShowBcc(initialFields.showBcc);
		setSubject(initialFields.subject);
		setBody(initialFields.body);
		appliedSignatureRef.current = { from: fromEmail, key: signatureKey(signatureFor(fromEmail)) };

		// Start empty, then pull in whatever the source message already had. A
		// reopened draft and a forward both carry attachments stored in R2 under
		// their own message id; neither used to reach the composer, so a draft came
		// back without its files and a forward went out without the originals.
		setAttachments([]);
		savedAttachmentsRef.current = "";

		// A fresh compose target owns a different draft row, and its opening
		// content counts as already-persisted so autosave doesn't immediately
		// write back the quoted reply nobody has edited yet.
		draftIdRef.current = composeOptions.draftEmail?.id;
		dispatchedRef.current = false;
		savedSnapshotRef.current = JSON.stringify([
			initialFields.to,
			initialFields.cc,
			initialFields.bcc,
			initialFields.subject,
			initialFields.body,
		]);
		setLastSavedAt(null);

		const source = composeOptions.draftEmail ?? composeOptions.originalEmail;
		const wantsAttachments =
			!!source?.attachments?.length &&
			(!!composeOptions.draftEmail || composeOptions.mode === "forward");
		if (!wantsAttachments || !mailboxId) return;

		// Guards against a slow fetch landing in a composer the user has since
		// pointed at a different message.
		const target = composeOptions;
		setIsLoadingAttachments(true);
		void stageStoredAttachments(mailboxId, source.id, source.attachments)
			.then(({ files, failed }) => {
				if (lastInitializedOptionsRef.current !== target) {
					// Superseded: release the object URLs we just created.
					files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
					return;
				}
				setAttachments(files);
				// Count them as already stored so autosave doesn't immediately
				// re-upload the bytes it just downloaded.
				savedAttachmentsRef.current = attachmentsSignature(files);
				if (failed.length > 0) {
					setError(
						`Could not attach ${failed.join(", ")}. Send without ${
							failed.length > 1 ? "them" : "it"
						}, or attach again.`,
					);
				}
			})
			.finally(() => {
				if (lastInitializedOptionsRef.current === target) {
					setIsLoadingAttachments(false);
				}
			});
	}, [composeOptions, currentMailbox?.email, sigBlock, mailboxId, fromEmail, signatureFor]);

	/**
	 * Swap the signature when the From address moves to another product, or
	 * when the product list arrives after the composer opened.
	 *
	 * Replaces the tagged block in place rather than appending, so switching
	 * From back and forth never stacks signatures. A reopened draft keeps the
	 * signature it was saved with until its From actually changes.
	 */
	useEffect(() => {
		if (lastInitializedOptionsRef.current !== composeOptions || !fromEmail) return;
		const applied = appliedSignatureRef.current;
		const next = signatureFor(fromEmail);
		const key = signatureKey(next);
		if (applied && applied.key === key) {
			applied.from = fromEmail;
			return;
		}
		if (applied && isDraftEdit && applied.from === fromEmail) return;
		appliedSignatureRef.current = { from: fromEmail, key };
		setBody((current) => swapProductSignature(current, next));
	}, [fromEmail, signatureFor, composeOptions, isDraftEdit]);

	// Cleanup attachment previews on unmount
	useEffect(() => {
		return () => {
			attachments.forEach((att) => {
				if (att.preview) {
					URL.revokeObjectURL(att.preview);
				}
			});
		};
	}, [attachments]);

	/**
	 * Persist the current fields as a draft.
	 *
	 * Shared by the explicit Save button and autosave, so the two cannot drift on
	 * which draft row they target.
	 */
	const persistDraft = useCallback(async () => {
		if (!mailboxId) return;

		// Only ship files when the set actually changed. Encoding is the expensive
		// part of a save, and autosave runs on a timer.
		const signature = attachmentsSignature(attachments);
		const attachmentsChanged = signature !== savedAttachmentsRef.current;

		const result = await saveDraftMutation.mutateAsync({
			mailboxId,
			draft: {
				to,
				cc: cc || undefined,
				bcc: bcc || undefined,
				subject,
				body,
				in_reply_to:
					composeOptions.originalEmail?.id ||
					composeOptions.draftEmail?.in_reply_to ||
					undefined,
				thread_id:
					composeOptions.originalEmail?.thread_id ||
					composeOptions.draftEmail?.thread_id ||
					undefined,
				draft_id: draftIdRef.current,
				...(attachmentsChanged
					? {
							replace_attachments: true,
							attachments: await prepareAttachmentsForApi(attachments),
						}
					: {}),
			},
		});

		if (result?.id) draftIdRef.current = result.id;
		savedSnapshotRef.current = JSON.stringify([to, cc, bcc, subject, body]);
		if (attachmentsChanged) savedAttachmentsRef.current = signature;
		setLastSavedAt(new Date());
	}, [
		attachments,
		mailboxId,
		saveDraftMutation,
		to,
		cc,
		bcc,
		subject,
		body,
		composeOptions.originalEmail?.id,
		composeOptions.originalEmail?.thread_id,
		composeOptions.draftEmail?.in_reply_to,
		composeOptions.draftEmail?.thread_id,
	]);

	const handleSaveDraft = async () => {
		if (!mailboxId || isSending) return;
		setIsSavingDraft(true);
		setError(null);
		try {
			await persistDraft();
			showToast({ kind: "success", message: "Draft saved" });
		} catch (err: unknown) {
			const message =
				(err instanceof Error ? err.message : null) || "Failed to save draft.";
			setError(message);
			showToast({ kind: "error", message });
		} finally {
			setIsSavingDraft(false);
		}
	};

	/**
	 * Autosave.
	 *
	 * Closing a composer used to discard everything typed into it, because the
	 * only way to persist was the Save button. This writes after a short idle
	 * gap, and only when something actually changed — a composer sitting open
	 * with a quoted reply in it never touches the server.
	 */
	useEffect(() => {
		if (!mailboxId || isSending || isSavingDraft) return;
		if (dispatchedRef.current) return;

		// Don't autosave over a draft whose own attachments are still arriving —
		// the set is momentarily empty, and saving now would delete them.
		if (isLoadingAttachments) return;

		const snapshot = JSON.stringify([to, cc, bcc, subject, body]);
		const attachmentsChanged =
			attachmentsSignature(attachments) !== savedAttachmentsRef.current;
		if (snapshot === savedSnapshotRef.current && !attachmentsChanged) return;

		// Nothing worth keeping yet: no recipient, no subject, no prose. An
		// attachment on its own counts — someone who dragged a file in and has not
		// typed yet still expects to find it again.
		const hasContent =
			to.trim() !== "" ||
			subject.trim() !== "" ||
			htmlToPlainText(body).trim() !== "" ||
			attachments.length > 0;
		if (!hasContent) return;

		const timer = setTimeout(() => {
			void persistDraft().catch(() => {
				// Autosave is best-effort: a transient failure must not interrupt
				// typing, and the explicit Save button reports errors properly.
			});
		}, AUTOSAVE_IDLE_MS);

		return () => clearTimeout(timer);
	}, [
		mailboxId,
		to,
		cc,
		bcc,
		subject,
		body,
		attachments,
		isLoadingAttachments,
		isSending,
		isSavingDraft,
		persistDraft,
	]);

	/**
	 * Validate the form and assemble the outbound payload.
	 *
	 * Shared by immediate and scheduled send so the two can't drift on
	 * validation, sender derivation or attachment encoding. Returns null and sets
	 * `error` when the form isn't ready.
	 */
	const buildOutgoing = async (overrides?: RecipientOverrides) => {
		if (!currentMailbox || !mailboxId) {
			setError("No mailbox selected.");
			return null;
		}

		const toValue = overrides?.to ?? to;
		const ccValue = overrides?.cc ?? cc;
		const bccValue = overrides?.bcc ?? bcc;

		const toRecipients = splitEmailList(toValue);
		if (toRecipients.length === 0) {
			setFieldErrors({ to: "Add at least one recipient." });
			setError("Add at least one recipient.");
			return null;
		}

		// Every list is checked before anything leaves, so a typo is pinned to the
		// row it's in instead of coming back as a parse error from the send route.
		const nextFieldErrors: RecipientFieldErrors = {};
		for (const [field, value] of [
			["to", toValue],
			["cc", ccValue],
			["bcc", bccValue],
		] as const) {
			const bad = firstInvalidAddress(value);
			if (bad) nextFieldErrors[field] = `${bad} isn't a valid address.`;
		}
		if (Object.keys(nextFieldErrors).length > 0) {
			setFieldErrors(nextFieldErrors);
			setError("Fix the highlighted addresses before sending.");
			return null;
		}
		setFieldErrors({});

		// The send routes require a non-empty html or text part, so an empty message
		// came back as "Invalid request body" — a platform error surfaced verbatim
		// to someone who had simply not written anything yet. Images and tables
		// count as content even though they carry no text.
		const bodyIsEmpty =
			htmlToPlainText(body).trim() === "" &&
			!/<(img|table|hr|blockquote)\b/i.test(body);
		if (bodyIsEmpty) {
			setError("Write a message before sending.");
			return null;
		}

		// An alias of another product sends under that product's name.
		const fromName = fromNameFor(
			products,
			currentMailbox.email,
			fromEmail || currentMailbox.email,
			currentMailbox.settings?.fromName || currentMailbox.name,
		);
		const baseFrom =
			fromName && fromName !== currentMailbox.email
				? { email: currentMailbox.email, name: fromName }
				: currentMailbox.email;
		// Same shape as before; only the address changes when an alias is picked.
		const from =
			fromEmail && fromEmail !== currentMailbox.email.toLowerCase()
				? withFromEmail(baseFrom, fromEmail)
				: baseFrom;

		const apiAttachments =
			attachments.length > 0 ? await prepareAttachmentsForApi(attachments) : undefined;

		return {
			to: toEmailListValue(toRecipients),
			cc: toEmailListValue(splitEmailList(ccValue)),
			bcc: toEmailListValue(splitEmailList(bccValue)),
			from,
			// Matches what the "send draft" action in the reading pane substitutes,
			// so the same empty-subject message doesn't arrive titled two ways
			// depending on which button sent it.
			subject: subject.trim() || "(no subject)",
			html: body,
			text: htmlToPlainText(body),
			attachments: apiAttachments,
			// Sent on every path (now, undo window, scheduled). The server sets the
			// reminder once the message is accepted; see workers/routes/followups.ts.
			followup: followupRequestFor(followup),
			...trackFieldFor(dontTrack),
		};
	};

	/** Release the object URLs held by attachment previews. */
	const releaseAttachmentPreviews = () => {
		attachments.forEach((att) => {
			if (att.preview) URL.revokeObjectURL(att.preview);
		});
	};

	/**
	 * Queue the message instead of sending it now.
	 *
	 * The scheduled endpoint takes threading fields in the body rather than
	 * deriving them from a path parameter, so a scheduled reply has to carry
	 * `in_reply_to` and `thread_id` explicitly to stay in its conversation.
	 */
	const handleSchedule = async (
		sendAt: Date,
		onClose: () => void,
		overrides?: RecipientOverrides,
	) => {
		if (isSending) return;
		setError(null);
		if (!mailboxId) {
			setError("No mailbox selected.");
			return;
		}
		if (sendAt.getTime() <= Date.now()) {
			setError("Pick a time in the future.");
			return;
		}

		setIsSending(true);
		try {
			const outgoing = await buildOutgoing(overrides);
			if (!outgoing) return;

			/**
			 * Threading is named, not hand-built, exactly as `handleSend` does it.
			 *
			 * This used to post `in_reply_to` and `thread_id` directly, derived as
			 * `original?.message_id || draftEmail?.in_reply_to`. That fallback assumed
			 * `in_reply_to` always held an RFC Message-ID, while the composer's own
			 * draft saves store a row UUID there — so scheduling an edited draft put a
			 * UUID in the `In-Reply-To` header, which matches nothing at the far end
			 * and splits the conversation for the recipient. The immediate-send path
			 * assumed the opposite, which is how the two drifted.
			 *
			 * Naming the parent instead lets the server resolve it either way and
			 * rebuild the full `References` ancestry, which the composer does not have.
			 */
			const originalId =
				composeOptions.originalEmail?.id ||
				composeOptions.draftEmail?.in_reply_to ||
				undefined;
			const mode = composeOptions.mode;
			const isForward = mode === "forward" && !!originalId;
			const isReply =
				(mode === "reply" || mode === "reply-all" || !!composeOptions.draftEmail) &&
				!!originalId &&
				!isForward;

			// The draft has been superseded by the queued copy, and the server removes
			// it as part of accepting this request. Prefer the row autosave currently
			// owns: a composer opened as a new message or a reply has no `draftEmail`,
			// yet autosave may well have created a draft for it, and that row would
			// otherwise linger in the thread as a duplicate of what we just queued.
			const draftId = draftIdRef.current ?? composeOptions.draftEmail?.id;

			await scheduleEmailMutation.mutateAsync({
				mailboxId,
				email: {
					...outgoing,
					...(isReply || isForward
						? {
								reply_to_email_id: originalId,
								threaded_mode: isForward ? "forward" : "reply",
							}
						: {}),
					...(draftId ? { supersedes_draft_id: draftId } : {}),
					send_at: sendAt.toISOString(),
				},
			});

			dispatchedRef.current = true;
			draftIdRef.current = undefined;

			releaseAttachmentPreviews();
			showToast({
				kind: "success",
				message: `Scheduled for ${formatComposeDate(sendAt.toISOString())}`,
			});
			onClose();
		} catch (err: unknown) {
			const message =
				(err instanceof Error ? err.message : null) || "Failed to schedule email.";
			setError(message);
			showToast({ kind: "error", message });
		} finally {
			setIsSending(false);
		}
	};

	/**
	 * Sends with an undo window rather than delivering outright — see
	 * `useSendWithUndo`. Threading is handed to the server as `replyToEmailId`
	 * rather than resolved here, because the `References` chain needs the
	 * original's ancestry and the compose form doesn't have it.
	 */
	const handleSend = async (
		e: FormEvent | null,
		onClose: () => void,
		overrides?: RecipientOverrides,
	) => {
		e?.preventDefault(); if (isSending) return; setError(null);
		if (!currentMailbox || !mailboxId) { setError("No mailbox selected."); return; }

		setIsSending(true);

		try {
			// Validation lives in buildOutgoing so the immediate and scheduled paths
			// can't disagree about what counts as sendable.
			const emailData = await buildOutgoing(overrides);
			if (!emailData) return;

			// Autosave's row wins over the one we were opened with — see the note
			// in handleSchedule. Without this an autosaved reply-draft survives
			// the send and shows up alongside the sent copy in the thread.
			const draftId = draftIdRef.current ?? composeOptions.draftEmail?.id;
			const mode = composeOptions.mode;
			// Either form of reference is fine here: the server resolves a row id or a
			// Message-ID (see `getEmailByRef`), and a draft demoted back into Drafts by
			// Undo Send carries the latter. This used to be posted straight to a
			// row-id-only lookup, which 404'd as "Original email not found".
			const originalId = composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to;

			const isReply = (mode === "reply" || mode === "reply-all") && !!originalId;
			const isForward = mode === "forward" && !!originalId;

			// The autosaved row is removed by the server as part of accepting the
			// send, not by a follow-up request from here: that follow-up needed
			// `deletePermanently`, which a grant allowed to send need not hold, and it
			// could fail *after* the message had been queued — leaving the composer
			// reporting a failed send for a message that was on its way.
			await sendWithUndo({
				mailboxId,
				email: emailData,
				...(isReply || isForward
					? {
							replyToEmailId: originalId,
							threadedMode: isForward ? ("forward" as const) : ("reply" as const),
						}
					: {}),
				...(draftId ? { supersedesDraftId: draftId } : {}),
			});

			dispatchedRef.current = true;
			// Cleared so autosave cannot write the row back after the send.
			draftIdRef.current = undefined;

			releaseAttachmentPreviews();
			onClose();
		} catch (err: unknown) { 
			const message = (err instanceof Error ? err.message : null) || "Failed to send email."; 
			setError(message); 
			showToast({ kind: "error", message }); 
		}
		finally { setIsSending(false); }
	};

	/**
	 * Whether there is anything a user would mind losing.
	 *
	 * Drives the confirmation on discard and the "not saved yet" note. Erring
	 * towards true: an unnecessary confirmation costs a click, a missing one
	 * costs the message.
	 */
	const hasContent = useMemo(
		() =>
			attachments.length > 0 ||
			to.trim() !== "" ||
			cc.trim() !== "" ||
			bcc.trim() !== "" ||
			subject.trim() !== "" ||
			htmlToPlainText(body).trim() !== "",
		[to, cc, bcc, subject, body, attachments.length],
	);

	/**
	 * Throw the message away, including the row autosave may already have
	 * written.
	 *
	 * Discard used to just close the window, which left the autosaved draft
	 * sitting in Drafts — the one thing the button promises not to do.
	 */
	const handleDiscard = async (onClose: () => void) => {
		if (isSending) return;

		const draftId = draftIdRef.current ?? composeOptions.draftEmail?.id;
		// Latch first: closing changes the fields, and autosave must not race the
		// delete and re-create what we are removing.
		dispatchedRef.current = true;
		draftIdRef.current = undefined;

		if (draftId && mailboxId) {
			try {
				await deleteEmailMutation.mutateAsync({ mailboxId, id: draftId });
				showToast({ kind: "success", message: "Draft moved to Trash" });
			} catch (err: unknown) {
				showToast({
					kind: "error",
					message:
						(err instanceof Error ? err.message : null) ||
						"Could not discard the draft.",
				});
			}
		}

		releaseAttachmentPreviews();
		onClose();
	};

	return { 
		to, setTo, 
		cc, setCc, 
		bcc, setBcc, 
		/** The address this message goes out from, and the choices for it. */
		fromEmail, setFromEmail: setFromChoice, fromOptions,
		showCc, setShowCc,
		showBcc, setShowBcc,
		subject, setSubject, 
		body, setBody, 
		attachments, setAttachments,
		error, setError, 
		/** Per-row recipient validation messages. */
		fieldErrors, setFieldErrors,
		hasContent,
		isSavingDraft, isSending, 
		/** True while a draft's or forward's stored attachments are being fetched. */
		isLoadingAttachments,
		/** When the draft was last written, for the composer's status line. */
		lastSavedAt,
		formTitle, 
		/** The "Remind me if no reply" choice for this message. */
		followup, setFollowup,
		/** Per-message tracking opt-out. */
		dontTrack, setDontTrack,
		handleSaveDraft, handleSend, handleSchedule, handleDiscard,
		closeCompose, closePanel 
	};
}
