/**
 * Compose window.
 *
 * A non-modal window docked bottom-right, with three sizes: minimised to a title
 * bar, the default corner panel, and full screen. Minimising matters because the
 * window has no other way to get out of the way — the previous two-state version
 * forced a choice between covering the list and closing the draft.
 *
 * Everything the retired composer could do (rich text, cc/bcc, attachments,
 * scheduling, undo send) plus autosave, recipient autocomplete, per-row address
 * validation, signatures and templates.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
	EyeOff,
	FileText,
	PenLine,
	Save,
	Send,
	Signature,
	Trash2,
	Upload,
} from "lucide-react";
import AttachmentPicker, {
	AttachmentChips,
	createAttachmentAdder,
	useAttachmentDrop,
} from "~/components/mail/AttachmentPicker";
import ComposeEnvelope from "~/components/mail/ComposeEnvelope";
import SuppressionWarning from "~/components/mail/SuppressionWarning";
import ComposeWindow, {
	type ComposeWindowState,
} from "~/components/mail/ComposeWindow";
import Editor from "~/components/mail/Editor";
import { insertSnippet } from "~/components/mail/snippet-extension";
import type { Editor as TiptapEditor } from "@tiptap/core";
import ScheduleMenu from "~/components/mail/ScheduleMenu";
import FollowupMenu from "~/components/mail/FollowupMenu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
	useComposeForm,
	type RecipientOverrides,
} from "~/hooks/useComposeForm";
import { useUIStore } from "~/hooks/useUIStore";
import { useCommandPaletteStore } from "~/hooks/useCommandPaletteStore";
import {
	firstRecipient,
	recipientVariables,
	type SnippetTemplate,
} from "~/lib/snippets";
import { announce } from "~/lib/toast";
import {
	cn,
	extractEmailAddress,
	renderSignatureBlock,
	splitEmailList,
} from "~/lib/utils";
import { useSignatures } from "~/queries/signatures";
import { useTemplates } from "~/queries/templates";
import { useMailbox } from "~/queries/mailboxes";
import { usePeople } from "~/queries/people";
import { useProductFor, useProducts } from "~/queries/products";
import { fromNameFor } from "shared/products";

interface ComposerProps {
	mailboxId: string;
	folderId?: string;
}

type RecipientField = "to" | "cc" | "bcc";

/** How long the Discard button stays armed before reverting. */
const DISCARD_CONFIRM_MS = 4000;

export default function Composer({ mailboxId, folderId }: ComposerProps) {
	const { closeCompose, composeOptions } = useUIStore();
	// `Shift+r`/`a`/`f` ask for a popped-out composer, which here means opening
	// straight into fullscreen rather than the corner panel.
	const [windowState, setWindowState] = useState<ComposeWindowState>(() =>
		composeOptions.popOut ? "fullscreen" : "compact",
	);
	const [confirmDiscard, setConfirmDiscard] = useState(false);

	/**
	 * Where the caret starts. A blank message needs an address before anything
	 * else; a reply, forward or reopened draft already has one, so the useful
	 * place is the message. Decided once, at open.
	 */
	const [initialFocus] = useState<"to" | "body">(() =>
		composeOptions.draftEmail ||
		composeOptions.originalEmail ||
		composeOptions.prefill?.to
			? "body"
			: "to",
	);

	const {
		to,
		setTo,
		cc,
		setCc,
		bcc,
		setBcc,
		fromEmail,
		setFromEmail,
		fromOptions,
		showCc,
		setShowCc,
		showBcc,
		setShowBcc,
		subject,
		setSubject,
		body,
		setBody,
		attachments,
		setAttachments,
		error,
		setError,
		fieldErrors,
		hasContent,
		isSavingDraft,
		isSending,
		isLoadingAttachments,
		lastSavedAt,
		formTitle,
		followup,
		setFollowup,
		dontTrack,
		setDontTrack,
		handleSaveDraft,
		handleSend,
		handleSchedule,
		handleDiscard,
	} = useComposeForm(mailboxId, folderId);

	const { data: mailbox } = useMailbox(mailboxId);
	const { data: signatures = [] } = useSignatures(mailboxId);
	const { data: allTemplates = [] } = useTemplates();
	/** The product the From address sends as, for its badge and default templates. */
	const product = useProductFor(fromEmail);
	// The product's default templates lead the menu and the snippet list.
	const templates = useMemo(() => {
		const first = product?.defaultTemplates ?? [];
		if (first.length === 0) return allTemplates;
		const rank = (slug: string) => {
			const i = first.indexOf(slug);
			return i === -1 ? Number.MAX_SAFE_INTEGER : i;
		};
		return [...allTemplates].sort((a, b) => rank(a.slug) - rank(b.slug));
	}, [allTemplates, product]);

	const addFiles = createAttachmentAdder(attachments, setAttachments, setError);
	const { isOver, handlers } = useAttachmentDrop(addFiles, isSending);

	/**
	 * Tokens still being typed in each address row.
	 *
	 * State rather than a ref because Send has to enable off them: an address
	 * typed but not yet turned into a chip is still an address, and the button
	 * used to sit disabled until you pressed Enter.
	 */
	const [pending, setPending] = useState<Record<RecipientField, string>>({
		to: "",
		cc: "",
		bcc: "",
	});

	const handlePendingChange = useCallback(
		(field: RecipientField, value: string) => {
			setPending((prev) => (prev[field] === value ? prev : { ...prev, [field]: value }));
		},
		[],
	);

	const { data: products = [] } = useProducts();
	// Follows the product when From is another product's alias (`fromNameFor`).
	const fromName =
		fromNameFor(
			products,
			mailbox?.email ?? mailboxId,
			fromEmail || mailbox?.email || mailboxId,
			mailbox?.settings?.fromName || mailbox?.name,
		) ?? undefined;
	const fromLabel = useMemo(() => {
		const address = fromEmail || mailbox?.email || mailboxId;
		return fromName && fromName !== mailbox?.email
			? `${fromName} <${address}>`
			: address;
	}, [fromName, fromEmail, mailbox?.email, mailboxId]);

	/** Own domains read as internal, which tints their chips. */
	const ownDomains = useMemo(() => {
		const address = mailbox?.email ?? mailboxId;
		const at = address.lastIndexOf("@");
		return at === -1 ? [] : [address.slice(at + 1).toLowerCase()];
	}, [mailbox?.email, mailboxId]);

	/**
	 * Fold any half-typed token into its row and hand the merged lists to the
	 * send. Sending with ⌘↵ never blurred the field, so the address the user had
	 * just typed was dropped without a word.
	 */
	const commitPendingRecipients = (): RecipientOverrides => {
		const merged: RecipientOverrides = {};
		const current: Record<RecipientField, string> = { to, cc, bcc };
		const setters: Record<RecipientField, (next: string) => void> = {
			to: setTo,
			cc: setCc,
			bcc: setBcc,
		};

		for (const field of ["to", "cc", "bcc"] as const) {
			const address = pending[field] ? extractEmailAddress(pending[field]) : null;
			if (!address) continue;

			const existing = splitEmailList(current[field]);
			if (existing.some((a) => a.toLowerCase() === address.toLowerCase())) {
				continue;
			}

			const next = [...existing, address].join(", ");
			merged[field] = next;
			setters[field](next);
		}

		return merged;
	};

	const submitSend = () => {
		void handleSend(null, closeCompose, commitPendingRecipients());
	};

	// ⌘/Ctrl+↵ from anywhere in the window, including inside the editor, which
	// swallows a plain Enter.
	const handleWindowKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			if (canSend) submitSend();
			return;
		}
		// Escape puts the window away rather than discarding it: the draft is still
		// autosaving, and losing a message to a stray keypress isn't recoverable.
		if (e.key === "Escape" && windowState !== "minimized") {
			e.stopPropagation();
			setWindowState("minimized");
		}
	};

	useEffect(() => {
		if (!confirmDiscard) return;
		const timer = setTimeout(() => setConfirmDiscard(false), DISCARD_CONFIRM_MS);
		return () => clearTimeout(timer);
	}, [confirmDiscard]);

	/** Append a signature at the cursor-free end of the body. */
	const insertSignature = (html: string) => {
		setBody(`${body}${renderSignatureBlock(html)}`);
	};

	/**
	 * Templates replace the subject only when it is still empty, so applying one
	 * to a reply doesn't wipe the "Re:" line.
	 */
	const applyTemplate = (template: { subject?: string; bodyHtml?: string }) => {
		if (!subject.trim() && template.subject) setSubject(template.subject);
		if (template.bodyHtml) setBody(`${template.bodyHtml}${body}`);
	};

	/*
	  Snippets. Variables are read at insert time from the first To recipient.
	  A display name is only used when one is actually known: from a
	  `Name <address>` token, or from the message being replied to, whose
	  stored `From:` name belongs to that address.
	*/
	const editorRef = useRef<TiptapEditor | null>(null);
	const onEditor = useCallback((editor: TiptapEditor | null) => {
		editorRef.current = editor;
	}, []);
	/*
	  Names for the first To address, best source first: the message being
	  replied to (its stored `From:` name is that person's own), then the
	  People directory, which keeps the name each correspondent last used.
	  The To field stores bare addresses, so a typed "Name <address>" doesn't
	  survive into `to`.
	*/
	const firstTo = useMemo(
		() => firstRecipient([to, pending.to].filter(Boolean).join(", "))?.email ?? "",
		[to, pending.to],
	);
	const { data: directory } = usePeople(
		{ search: firstTo, pageSize: 3 },
		{ enabled: templates.length > 0 && firstTo.includes("@") },
	);
	const knownNames = useMemo(() => {
		const names: Record<string, string> = {};
		for (const person of directory?.people ?? []) {
			if (person.name) names[person.email.toLowerCase()] = person.name;
		}
		const original = composeOptions.originalEmail;
		const address = original?.sender ? extractEmailAddress(original.sender) : null;
		if (address && original?.sender_name) names[address.toLowerCase()] = original.sender_name;
		return names;
	}, [composeOptions.originalEmail, directory]);
	const snippetVariables = useCallback(() => {
		const toList = [to, pending.to].filter(Boolean).join(", ");
		return recipientVariables(firstRecipient(toList, knownNames));
	}, [to, pending.to, knownNames]);

	/** Insert a template at the caret, from the palette's "Insert template…". */
	const insertTemplateAtCaret = useCallback(
		(template: SnippetTemplate) => {
			const editor = editorRef.current;
			if (!editor || editor.isDestroyed) return;
			if (windowState === "minimized") setWindowState("compact");
			if (!subject.trim() && template.subject) setSubject(template.subject);
			const { from, to: end } = editor.state.selection;
			insertSnippet(editor, { from, to: end }, template, snippetVariables());
			announce(`Inserted ${template.name}`);
		},
		[snippetVariables, subject, setSubject, windowState],
	);

	const setPaletteInsert = useCommandPaletteStore((state) => state.setInsertTemplate);
	useEffect(() => {
		setPaletteInsert(insertTemplateAtCaret);
	}, [insertTemplateAtCaret, setPaletteInsert]);
	useEffect(() => () => setPaletteInsert(null), [setPaletteInsert]);

	/** Reveal a row, or put it away again while it is still empty. */
	const toggleRecipientRow = (field: "cc" | "bcc") => {
		const value = field === "cc" ? cc : bcc;
		const show = field === "cc" ? showCc : showBcc;
		const setShow = field === "cc" ? setShowCc : setShowBcc;

		if (show && value.trim() === "") {
			setShow(false);
			return;
		}
		if (!show) {
			setShow(true);
			return;
		}
		// Open and populated: focus it instead of hiding addresses that are going
		// to be sent to whether the row is visible or not.
		document.getElementById(`compose-${field}`)?.focus();
	};

	const recipientCount = splitEmailList(to).length;

	// Block sending until a draft's or forward's stored attachments have arrived.
	// Sending mid-fetch would deliver the message without the files the user can
	// see listed, which is the failure this whole path exists to remove.
	const hasRecipient = recipientCount > 0 || !!extractEmailAddress(pending.to);
	const canSend =
		hasRecipient &&
		!isSending &&
		!isLoadingAttachments;

	const headerSubtitle = useMemo(() => {
		const recipients = splitEmailList(to);
		if (recipients.length === 0) return undefined;
		return recipients.length === 1
			? recipients[0]
			: `${recipients[0]} +${recipients.length - 1}`;
	}, [to]);

	const sendShortcut =
		typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
			? "⌘↵"
			: "Ctrl+Enter";

	const saveStatus = isSavingDraft
		? "Saving…"
		: lastSavedAt
			? `Draft saved ${lastSavedAt.toLocaleTimeString([], {
					hour: "numeric",
					minute: "2-digit",
				})}`
			: hasContent
				? "Not saved yet"
				: "";

	const onDiscard = () => {
		if (hasContent && !confirmDiscard) {
			setConfirmDiscard(true);
			return;
		}
		void handleDiscard(closeCompose);
	};

	return (
		<ComposeWindow
			title={formTitle}
			subtitle={headerSubtitle}
			icon={<PenLine size={13} aria-hidden />}
			state={windowState}
			onStateChange={setWindowState}
			onClose={closeCompose}
			closeDisabled={isSending}
			isDropTarget={isOver}
			dropHandlers={handlers}
			minimizedStatus={saveStatus}
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					submitSend();
				}}
				onKeyDown={handleWindowKeyDown}
				className="flex min-h-0 flex-1 flex-col"
			>
				<ComposeEnvelope
					fromLabel={fromLabel}
					fromName={fromName && fromName !== mailbox?.email ? fromName : undefined}
					fromEmail={fromEmail}
					fromOptions={fromOptions}
					onFromChange={setFromEmail}
					fromNameOf={(address) => {
						const name = fromNameFor(
							products,
							mailbox?.email ?? mailboxId,
							address,
							mailbox?.settings?.fromName || mailbox?.name,
						);
						return name && name !== mailbox?.email ? name : undefined;
					}}
					to={to}
					onToChange={setTo}
					cc={cc}
					onCcChange={setCc}
					bcc={bcc}
					onBccChange={setBcc}
					showCc={showCc}
					showBcc={showBcc}
					onToggleCc={() => toggleRecipientRow("cc")}
					onToggleBcc={() => toggleRecipientRow("bcc")}
					subject={subject}
					onSubjectChange={setSubject}
					onPendingChange={handlePendingChange}
					ownDomains={ownDomains}
					errors={fieldErrors}
					disabled={isSending}
					autoFocusTo={initialFocus === "to"}
				/>

				<SuppressionWarning
					recipients={[...splitEmailList(to), ...splitEmailList(cc), ...splitEmailList(bcc)]}
					from={mailbox?.email ?? mailboxId}
				/>

				{/* Body */}
				<div className="relative min-h-0 flex-1 overflow-y-auto smooth-scroll">
					<Editor
						value={body}
						onChange={setBody}
						onError={setError}
						placeholder="Write your message…"
						bare
						autoFocus={initialFocus === "body"}
						className="h-full"
						snippets={templates}
						snippetVariables={snippetVariables}
						onEditor={onEditor}
					/>

					{isOver && (
						<div
							className="pointer-events-none absolute inset-2 flex flex-col items-center justify-center gap-1 rounded-[8px] border-2 border-dashed border-violet bg-card/85 text-xs font-semibold text-text-secondary"
							aria-hidden
						>
							<Upload size={18} className="text-violet" />
							Drop files to attach
						</div>
					)}
				</div>

				{isLoadingAttachments && (
					<p
						role="status"
						className="mx-3 mb-1 text-[11px] font-light text-text-tertiary"
					>
						Loading attachments…
					</p>
				)}

				<AttachmentChips
					attachments={attachments}
					onChange={setAttachments}
					disabled={isSending}
				/>

				{error && (
					<p
						role="alert"
						className="mx-3 mb-2 rounded-[6px] border border-destructive/40 bg-destructive/[0.06] px-2.5 py-1.5 text-[11px] text-destructive"
					>
						{error}
					</p>
				)}

				{/* Footer */}
				<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border bg-card px-4 py-2.5 touch:gap-0.5 touch:px-2 touch:py-1">
					{/* Split control: send now, or the caret for a scheduled send. */}
					<div className="flex items-center">
						<button
							type="submit"
							disabled={!canSend}
							title={`Send (${sendShortcut})`}
							aria-keyshortcuts="Meta+Enter Control+Enter"
							className="inline-flex h-9 items-center gap-2 rounded-l-full bg-accent pl-5 pr-4 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50"
						>
							<Send size={15} />
							{isSending
								? "Sending…"
								: isLoadingAttachments
									? "Loading…"
									: "Send"}
						</button>
						<span className="h-9 w-px bg-accent-foreground/25 touch:h-11" aria-hidden />
						<ScheduleMenu
							disabled={!canSend}
							disabledReason={
								hasRecipient
									? isLoadingAttachments
										? "Wait for attachments to load"
										: undefined
									: "Add a recipient to schedule"
							}
							variant="split"
							onSchedule={(sendAt) =>
								void handleSchedule(
									sendAt,
									closeCompose,
									commitPendingRecipients(),
								)
							}
						/>
					</div>

					<FollowupMenu value={followup} onChange={setFollowup} disabled={isSending} />

					<button
						type="button"
						role="switch"
						aria-checked={dontTrack}
						onClick={() => setDontTrack((v) => !v)}
						disabled={isSending}
						title={dontTrack ? "Not tracking opens and clicks for this message" : "Don't track this message"}
						aria-label="Don't track this message"
						className={cn(
							"inline-flex h-7 items-center gap-1 rounded-[6px] px-1.5 text-xs font-medium transition-colors disabled:opacity-40 touch:h-11 touch:min-w-11 touch:justify-center",
							dontTrack
								? "bg-accent-subtle text-accent-subtle-fg hover:bg-accent-subtle/80"
								: "text-text-tertiary hover:bg-bg-muted hover:text-text-primary",
						)}
					>
						<EyeOff size={15} aria-hidden />
						{dontTrack && <span className="whitespace-nowrap">Not tracked</span>}
					</button>

					<AttachmentPicker
						attachments={attachments}
						onChange={setAttachments}
						onError={setError}
						disabled={isSending}
					/>

						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									title="Insert signature"
									aria-label="Insert signature"
									className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
								>
									<Signature size={15} />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="w-52">
								<DropdownMenuLabel>Insert signature</DropdownMenuLabel>
								{signatures.length === 0 ? (
									<DropdownMenuItem asChild className="cursor-pointer">
										<Link to={`/mail/${encodeURIComponent(mailboxId)}/settings`}>
											<span className="text-text-secondary">No signatures yet.</span>
											<span className="ml-auto font-medium text-accent">Create one</span>
										</Link>
									</DropdownMenuItem>
								) : null}
								{signatures.map((sig) => (
									<DropdownMenuItem
										key={sig.id}
										className="cursor-pointer"
										onClick={() => insertSignature(sig.body_html)}
									>
										<span className="truncate">{sig.name}</span>
										{sig.is_default && (
											<span className="ml-auto text-[10px] font-light text-text-tertiary">
												default
											</span>
										)}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>

						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									title="Insert template"
									aria-label="Insert template"
									className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
								>
									<FileText size={15} />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="w-56">
								<DropdownMenuLabel>Insert template</DropdownMenuLabel>
								{templates.length === 0 ? (
									<DropdownMenuItem asChild className="cursor-pointer">
										<Link to="/templates/new">
											<span className="text-text-secondary">No templates yet.</span>
											<span className="ml-auto font-medium text-accent">Create one</span>
										</Link>
									</DropdownMenuItem>
								) : null}
								{templates.slice(0, 12).map((template) => (
									<DropdownMenuItem
										key={template.slug}
										className="cursor-pointer"
										onClick={() => applyTemplate(template)}
									>
										<span className="truncate">{template.name}</span>
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>

					<div className="flex-1" />

					{/* Autosave status: the reason there is no longer a "did I lose it?" */}
					<span
						aria-live="polite"
						className="mr-1 hidden text-[10px] font-light text-text-tertiary sm:inline"
					>
						{saveStatus}
					</span>

					<button
						type="button"
						onClick={handleSaveDraft}
						disabled={isSending || isSavingDraft}
						title="Save draft"
						aria-label="Save draft"
						className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-40"
					>
						<Save size={15} />
					</button>

					<button
						type="button"
						onClick={onDiscard}
						disabled={isSending}
						title={confirmDiscard ? "Confirm discard" : "Discard draft"}
						aria-label={confirmDiscard ? "Confirm discard" : "Discard draft"}
						className={cn(
							"inline-flex h-7 items-center gap-1 rounded-[6px] px-1.5 text-text-tertiary transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40",
							confirmDiscard &&
								"bg-destructive/10 text-destructive ring-1 ring-destructive/40",
						)}
					>
						<Trash2 size={15} />
						{confirmDiscard && (
							<span className="text-[11px] font-semibold">Discard?</span>
						)}
					</button>
				</div>
			</form>
		</ComposeWindow>
	);
}
