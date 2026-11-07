/**
 * One message inside the reading pane.
 *
 * Collapsed it shows a snippet; expanded it renders the sanitised body in a
 * sandboxed iframe with remote images withheld until the reader asks for them.
 */

import { composerPreloadProps } from "~/components/lazy";
import { useMemo, useState } from "react";
import {
	ChevronDown,
	ChevronRight,
	CornerUpLeft,
	CornerUpRight,
	Download,
	EyeOff,
	Code2,
	Image as ImageIcon,
	ImageOff,
	Pencil,
	ReplyAll,
	Send,
	Trash2,
} from "lucide-react";
import { formatDetailDate } from "shared/dates";
import EmailIframe from "~/components/EmailIframe";
import AttachmentList from "~/components/mail/AttachmentList";
import SenderTrustBadge from "~/components/mail/SenderTrustBadge";
import SecurityWarnings, { emailWarnings } from "~/components/mail/SecurityWarnings";
import { Folders } from "shared/folders";
import { SentStatusIcon } from "~/components/mail/SentStatus";
import InvitationCard, {
	findCalendarAttachment,
} from "~/components/mail/InvitationCard";
import QuotedText from "~/components/mail/QuotedText";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useRemoteImageStore } from "~/hooks/useRemoteImageStore";
import { prepareEmailHtml, toEmlBlob } from "~/lib/email-html";
import { paintsOwnSurface } from "~/lib/reading-typography";
import {
	describePattern,
	matchingPatterns,
	senderAddress,
	senderDomainPattern,
} from "~/lib/remote-images";
import { splitQuotedBody } from "shared/quoted-text";
import { replyRecipients, replyToDiffersFromSender } from "shared/headers";
import { stripSignatureBlocks } from "shared/signature-block";
import { cn, getSnippetText } from "~/lib/utils";
import {
	senderAvatarTint,
	senderDisplayName,
	senderInitials,
} from "~/lib/sender-display";
import { usePreferenceValues } from "~/queries/preferences";
import type { Email } from "~/types";

/**
 * Where a saved "always show" rule lives, and how to undo it.
 *
 * The reader is agreeing to something durable, so the scope has to travel with
 * the control — as menu copy on narrow panes and as the tooltip on the inline
 * buttons that replace that menu on wide ones.
 */
const REMOTE_IMAGE_SAVE_HINT =
	"Saved in this browser. Manage the list under Settings → Remote images.";

interface MessageCardProps {
	email: Email;
	mailboxId: string;
	/** Our own address, used to label outbound messages as "You". */
	mailboxEmail?: string;
	expanded: boolean;
	onToggle: () => void;
	/** Collapsing is pointless for a single-message thread. */
	collapsible?: boolean;
	isDraft?: boolean;
	isSending?: boolean;
	onSendDraft?: () => void;
	onEditDraft?: () => void;
	onDeleteDraft?: () => void;
	onReply?: () => void;
	onReplyAll?: () => void;
	onForward?: () => void;
	onViewSource?: () => void;
	onPreviewAttachment?: (preview: {
		url: string;
		filename: string;
		mimetype: string;
	}) => void;
}

export default function MessageCard({
	email,
	mailboxId,
	mailboxEmail,
	expanded,
	onToggle,
	collapsible = true,
	isDraft = false,
	isSending = false,
	onSendDraft,
	onEditDraft,
	onDeleteDraft,
	onReply,
	onReplyAll,
	onForward,
	onViewSource,
	onPreviewAttachment,
}: MessageCardProps) {
	/**
	 * Remote images shown for this message only, from "Show once".
	 *
	 * Separate from the saved rules below because they answer different
	 * questions: "let me see this one" is not "I trust this sender", and
	 * conflating them is what makes a one-off click quietly permanent.
	 */
	const [showOnce, setShowOnce] = useState(false);
	const [showDetails, setShowDetails] = useState(false);

	const trustedSenders = useRemoteImageStore((s) => s.trustedSenders);
	const trustSender = useRemoteImageStore((s) => s.trustSender);
	const trustDomain = useRemoteImageStore((s) => s.trustDomain);
	const forgetPattern = useRemoteImageStore((s) => s.remove);

	const address = senderAddress(email.sender);
	const domainPattern = senderDomainPattern(email.sender);

	/**
	 * Saved rules covering this sender.
	 *
	 * Both the address rule and the domain rule can be present, and "Don't
	 * display" has to clear all of them — dropping only one would look like the
	 * button did nothing, because the other rule still allows the images.
	 */
	const applicableRules = useMemo(
		() => matchingPatterns(trustedSenders, email.sender),
		[trustedSenders, email.sender],
	);
	const trusted = applicableRules.length > 0;
	const showRemoteImages = trusted || showOnce;

	// Saved display preference. Read here rather than passed down: every message
	// in every thread renders through this component, and threading one flag from
	// the workspace would touch four intermediate components for nothing.
	const { display } = usePreferenceValues();

	/**
	 * The sender's own words, and the quote chain they appended, prepared
	 * separately.
	 *
	 * Split before sanitising rather than after: the cut can leave a tag open,
	 * and running each half through `prepareEmailHtml` re-balances it. Remote
	 * images are counted across both halves so the "images blocked" banner is
	 * right even when the only remote image sits inside the collapsed quote.
	 */
	// Our own sent and draft copies are shown exactly as written.
	const ownMail = email.folder_id === Folders.SENT || email.folder_id === Folders.DRAFT;

	const prepared = useMemo(() => {
		// Signatures come out before the quote split, not after. A signature is the
		// last thing above a quote, so stripping it first is what stops the split
		// from being decided by markup that is about to be removed anyway.
		const source = display.hideSignaturesInChat
			? stripSignatureBlocks(email.body)
			: email.body;
		const { visible, quoted, hasQuote } = splitQuotedBody(source);
		const options = {
			mailboxId,
			emailId: email.id,
			attachments: email.attachments,
			allowRemoteImages: showRemoteImages,
			imageProxy: email.image_proxy,
			// Our own sent mail is shown as written; cleaning is for received mail.
			cleanLinks: !ownMail && display.cleanTrackingLinks !== false,
		};
		const body = prepareEmailHtml(visible, options);
		const quote = hasQuote ? prepareEmailHtml(quoted, options) : null;
		return {
			html: body.html,
			quotedHtml: quote?.html ?? "",
			hasQuote: hasQuote && !!quote?.html.trim(),
			blockedRemoteCount:
				body.blockedRemoteCount + (quote?.blockedRemoteCount ?? 0),
			remoteImageCount:
				body.remoteImageCount + (quote?.remoteImageCount ?? 0),
			trackerCount: body.trackerCount + (quote?.trackerCount ?? 0),
		};
	}, [
		email.body,
		email.attachments,
		email.id,
		mailboxId,
		showRemoteImages,
		display.hideSignaturesInChat,
		display.cleanTrackingLinks,
		email.image_proxy,
		ownMail,
	]);

	/**
	 * Whether the message arrives with a surface of its own.
	 *
	 * Decides how the body is framed below. The same predicate picks the frame's
	 * internal gutter, so the two halves of that decision cannot disagree and leave
	 * a padded frame inside a full-bleed card, or the reverse.
	 */
	const ownSurface = useMemo(
		() => paintsOwnSurface(prepared.html),
		[prepared.html],
	);

	/**
	 * Where a reply would actually go, and whether that is somewhere the reader
	 * would not expect.
	 *
	 * `Reply-To` is set by whoever sent the message, so a reply can be addressed
	 * away from the author without the reader choosing it — how a confidential
	 * reply ends up on a mailing list. Legitimate in the common cases (a list, a
	 * ticketing system), which is why the answer is to say so rather than to
	 * ignore the header.
	 */
	const replyTo = useMemo(
		() => replyRecipients({ raw_headers: email.raw_headers, sender: email.sender }),
		[email.raw_headers, email.sender],
	);
	const replyToWarning = useMemo(
		() =>
			replyToDiffersFromSender({
				raw_headers: email.raw_headers,
				sender: email.sender,
			}),
		[email.raw_headers, email.sender],
	);

	/**
	 * The message's calendar part, if it has one.
	 *
	 * Looked for on every message because an invitation is not distinguishable
	 * from ordinary mail by anything cheaper — the subject is just the event
	 * title, and the body is often empty.
	 */
	const calendarAttachment = useMemo(
		() => findCalendarAttachment(email.attachments),
		[email.attachments],
	);

	const outbound =
		!!mailboxEmail &&
		email.sender?.toLowerCase().includes(mailboxEmail.toLowerCase());

	const downloadEml = () => {
		const url = URL.createObjectURL(toEmlBlob(email));
		const link = document.createElement("a");
		link.href = url;
		link.download = `${(email.subject || "message").replace(/[^\w.-]+/g, "_").slice(0, 60)}.eml`;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		// Revoked on the next tick so Safari has time to start the download.
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};

	return (
		<article
			// Stable handle so `n` / `p` can scroll the message they land on into
			// view. Without it the thread cursor could expand a card below the fold
			// and leave the reader looking at the previous one.
			id={`threadmsg-${email.id}`}
			className={cn(
				"border-b border-border",
				isDraft && "bg-amber-50/40 dark:bg-amber-500/[0.06]",
			)}
		>
			<header
				className={cn(
					"flex items-start gap-3 px-4 py-3",
					collapsible && "cursor-pointer hover:bg-bg-subtle/50",
				)}
				onClick={collapsible ? onToggle : undefined}
			>
				{collapsible && (
					<span className="mt-1 shrink-0 text-text-tertiary" aria-hidden>
						{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
					</span>
				)}

				{/* Same avatar as the list row, so a sender is recognisable across both. */}
				<span
					className={cn(
						"mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold",
						senderAvatarTint(email.sender || email.id),
					)}
					aria-hidden
				>
					{senderInitials(email.sender || "?", email.sender_name)}
				</span>

				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-baseline gap-x-2">
						<span className="truncate text-sm font-semibold text-text-primary">
							{outbound ? "You" : senderDisplayName(email.sender || "", email.sender_name)}
						</span>
						{!outbound && email.sender && (
							<span className="truncate text-xs text-text-tertiary">
								{email.sender}
							</span>
						)}
						{isDraft && (
							<span className="rounded-[4px] bg-bg-muted px-1.5 py-0.5 text-[11px] font-medium leading-4 text-text-secondary">
								Draft
							</span>
						)}
						<SenderTrustBadge
							rawHeaders={email.raw_headers}
							folderId={email.folder_id}
						/>
						{/* Per-message status for our own messages inside a thread:
						    each reply we sent has its own delivery and opens. */}
						<span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-text-tertiary">
							{outbound && collapsible && !isDraft && <SentStatusIcon email={email} />}
							{email.date ? formatDetailDate(email.date) : ""}
						</span>
					</div>

					{expanded ? (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								setShowDetails((v) => !v);
							}}
							className="mt-0.5 text-xs text-text-tertiary hover:text-text-secondary"
						>
							to {email.recipient || "—"}
							{email.cc ? `, cc ${email.cc}` : ""}
							<span className="ml-1 underline">
								{showDetails ? "hide" : "details"}
							</span>
						</button>
					) : (
						<p className="mt-0.5 truncate text-xs text-text-secondary">
							{getSnippetText(email.snippet || email.body, 120)}
						</p>
					)}

					{expanded && showDetails && (
						<dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-[6px] bg-bg-subtle/70 px-2.5 py-2 text-[11px]">
							<dt className="font-semibold text-text-tertiary">From</dt>
							<dd className="min-w-0 break-words text-text-secondary">
								{email.sender}
							</dd>
							{/*
							  Shown only when it redirects replies. `Reply-To: author`
							  says nothing the From line does not, and a row that
							  always appears is a row nobody reads.
							*/}
							{replyToWarning && (
								<>
									<dt className="font-semibold text-text-tertiary">Reply-To</dt>
									<dd className="min-w-0 break-words text-text-secondary">
										{replyTo.join(", ")}
									</dd>
								</>
							)}
							<dt className="font-semibold text-text-tertiary">To</dt>
							<dd className="min-w-0 break-words text-text-secondary">
								{email.recipient || "—"}
							</dd>
							{email.cc && (
								<>
									<dt className="font-semibold text-text-tertiary">Cc</dt>
									<dd className="min-w-0 break-words text-text-secondary">
										{email.cc}
									</dd>
								</>
							)}
							{/*
							  The undo for "always show images". It used to be a full-width
							  bar above every message from a trusted sender, the most
							  valuable rows of the pane spent restating a choice already
							  made. Here it stays findable next to the other facts about
							  the sender, and Settings → Remote images lists every rule.
							*/}
							{trusted && prepared.remoteImageCount > 0 && (
								<>
									<dt className="font-semibold text-text-tertiary">Images</dt>
									<dd className="flex min-w-0 flex-wrap items-center gap-x-2 text-text-secondary">
										<span>Always shown for {applicableRules.map(describePattern).join(" and ")}</span>
										<button
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												for (const rule of applicableRules) forgetPattern(rule);
												// Also drops a "Show images" from earlier in this session,
												// or the images stay on screen and "stop" visibly does nothing.
												setShowOnce(false);
											}}
											className="font-semibold text-text-secondary underline hover:text-text-primary"
										>
											Stop showing
										</button>
									</dd>
								</>
							)}
							{email.message_id && (
								<>
									<dt className="font-semibold text-text-tertiary">
										Message ID
									</dt>
									<dd className="min-w-0 break-all font-mono text-[10px] text-text-tertiary">
										{email.message_id}
									</dd>
								</>
							)}
						</dl>
					)}
				</div>
			</header>

			{expanded && (
				<div className="px-4 pb-4">
					{/*
					  Above the body, because on an invitation the body is usually empty
					  or a restatement of the card. The card renders nothing at all when
					  the calendar part cannot be read, so this never displaces anything.
					*/}
					{calendarAttachment && (
						<InvitationCard
							mailboxId={mailboxId}
							emailId={email.id}
							attachment={calendarAttachment}
							mailboxEmail={mailboxEmail}
						/>
					)}

					{/*
					  Blocked images offer three answers, not one. "Show images" used to
					  be the only option, which meant a newsletter the reader trusts
					  asked the same question on every message forever. The two "always"
					  choices are saved (see `useRemoteImageStore`); the plain one is
					  scoped to this message so a single peek at an unknown sender does
					  not become a standing permission.
					*/}
					{prepared.blockedRemoteCount > 0 && (
						<div className="@container mb-3 flex flex-wrap items-center gap-2 rounded-[8px] bg-bg-subtle px-3 py-2">
							<ImageOff size={15} className="shrink-0 text-text-secondary" aria-hidden />
							<span className="text-[13px] text-text-secondary">
								{prepared.blockedRemoteCount} remote image
								{prepared.blockedRemoteCount !== 1 ? "s" : ""} blocked to stop
								read tracking.
							</span>
							<div className="ml-auto flex items-center gap-1.5">
								<button
									type="button"
									onClick={() => setShowOnce(true)}
									className="h-7 rounded-full border border-border bg-card px-3 text-[13px] font-medium text-text-primary hover:bg-bg-muted"
								>
									Show images
								</button>
								{(address || domainPattern) && (
									<>
										{/*
										  On a wide pane the same two choices sit on the bar itself.
										  Behind a chevron they read as an overflow menu, so the
										  durable answer — the one that stops the question coming
										  back — is the one the reader has to go looking for. The
										  scope moves into the tooltip here because the inline form
										  has no room for the "saved in this browser" note the menu
										  carries.
										*/}
										<div className="hidden items-center gap-1 @min-[900px]:flex">
											<span className="pl-0.5 text-[13px] text-text-secondary">
												Always show for
											</span>
											{address && (
												<button
													type="button"
													onClick={() => trustSender(email.sender ?? "")}
													aria-label={`Always show images from ${address}`}
													title={`Always show images from ${address}. ${REMOTE_IMAGE_SAVE_HINT}`}
													className="max-w-[240px] truncate rounded-[6px] px-1 py-1 text-[13px] font-medium text-accent hover:underline"
												>
													{address}
												</button>
											)}
											{address && domainPattern && (
												<span
													className="text-[13px] text-text-tertiary"
													aria-hidden
												>
													·
												</span>
											)}
											{domainPattern && (
												<button
													type="button"
													onClick={() => trustDomain(email.sender ?? "")}
													aria-label={`Always show images from everyone at ${domainPattern.slice(1)}`}
													title={`Always show images from everyone at ${domainPattern.slice(1)}. ${REMOTE_IMAGE_SAVE_HINT}`}
													className="max-w-[240px] truncate rounded-[6px] px-1 py-1 text-[13px] font-medium text-accent hover:underline"
												>
													{domainPattern}
												</button>
											)}
										</div>

										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<button
													type="button"
													aria-label="Always show images from this sender"
													title="Always show images…"
													className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card text-text-secondary hover:bg-bg-muted @min-[900px]:hidden"
												>
													<ChevronDown size={12} aria-hidden />
												</button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end" className="w-72">
												<DropdownMenuLabel>Always show images from</DropdownMenuLabel>
												<DropdownMenuSeparator />
												{address && (
													<DropdownMenuItem
														className="cursor-pointer"
														onClick={() => trustSender(email.sender ?? "")}
													>
														<ImageIcon size={13} className="shrink-0" aria-hidden />
														<span className="min-w-0 flex-1 truncate">{address}</span>
													</DropdownMenuItem>
												)}
												{domainPattern && (
													<DropdownMenuItem
														className="cursor-pointer"
														onClick={() => trustDomain(email.sender ?? "")}
													>
														<ImageIcon size={13} className="shrink-0" aria-hidden />
														<span className="min-w-0 flex-1 truncate">
															Everyone at {domainPattern.slice(1)}
														</span>
													</DropdownMenuItem>
												)}
												<DropdownMenuSeparator />
												<DropdownMenuLabel className="font-light text-text-tertiary">
													{REMOTE_IMAGE_SAVE_HINT}
												</DropdownMenuLabel>
											</DropdownMenuContent>
										</DropdownMenu>
									</>
								)}
							</div>
						</div>
					)}

					{/*
					  Unsubscribe is not a banner any more: it lives in the
					  conversation's overflow menu.

					  A standing offer to leave the list was taking a full row above
					  every newsletter it applied to, in the one part of the pane where
					  vertical space is worth most — and it is a decision the reader makes
					  once, not something they need restated each time they open the mail.
					  The menu is where the other one-off verbs already are.
					*/}

					<SenderTrustBadge
						rawHeaders={email.raw_headers}
						folderId={email.folder_id}
						variant="banner"
						className="mb-3"
					/>

					<SecurityWarnings warnings={emailWarnings(email)} className="mb-3" />

					{/*
					  Trackers stay blocked after "Show images", so say so: otherwise a
					  reader who allowed images sees a gap and assumes a bug.
					*/}
					{showRemoteImages && prepared.trackerCount > 0 && (
						<p className="mb-3 flex items-center gap-1.5 text-xs font-light text-text-secondary">
							<EyeOff size={13} className="shrink-0 text-text-tertiary" aria-hidden />
							{prepared.trackerCount} tracker{prepared.trackerCount !== 1 ? "s" : ""} blocked
						</p>
					)}

					{/*
					  Attachments lead, the way Outlook places them: buried under the
					  body they were only reachable after scrolling a long message and
					  its quote chain.
					*/}
					<AttachmentList
						mailboxId={mailboxId}
						emailId={email.id}
						attachments={email.attachments}
						onPreview={onPreviewAttachment}
					/>

					{/*
					  The body sits in its own bordered surface: sender HTML brings its
					  own colours and widths, so a visible edge is what tells the reader
					  where our chrome stops and the message starts.

					  A message that lays itself out gets that edge without the inset. It
					  already has its own canvas and its own padding within it, so a
					  rounded card holding it 16px in from a column that is itself 16px in
					  is two frames around a thing that came framed — and on a narrow pane
					  those 32px are a sixth of the width, which the message then pays for
					  again in how far it has to be scaled to fit. `-mx-4` cancels the
					  gutter this block applies to everything else, because the banners and
					  the attachment list above genuinely do need it. The rule stays, top
					  and bottom, where it still says where our chrome ends and costs no
					  width to say it.
					*/}
					<div
						className={cn(
							"bg-card",
							ownSurface
								? "-mx-4 border-y border-border"
								: "overflow-hidden rounded-[10px] border border-border",
						)}
					>
						<EmailIframe
							body={prepared.html}
							autoSize
							allowRemoteImages={showRemoteImages}
						/>
					</div>

					{prepared.hasQuote && (
						<QuotedText
							quotedBody={prepared.quotedHtml}
							senderLabel={outbound ? "You" : email.sender || undefined}
							allowRemoteImages={showRemoteImages}
						/>
					)}

					{/*
					  Where a reply would actually go — said next to the Reply button,
					  not above the message.

					  The reply itself is addressed correctly (RFC 5322 §3.6.2), but
					  "correctly" means "where the sender asked", and the sender is not
					  necessarily acting in the reader's interest. Naming the address is
					  the difference between a reply that goes somewhere unexpected and one
					  that goes somewhere unexpected *silently*.

					  It sat above the body until now, which put a caveat about replying
					  between the reader and the thing they opened the message to read, on
					  every message in the thread. Down here it is still ahead of the
					  action it qualifies — the reader passes it on the way to Reply — and
					  it costs the body nothing.

					  `role="status"` rather than `alert`: it is context for a message
					  being read, not an error, so it should not interrupt.
					*/}
					{replyToWarning && (
						<div
							role="status"
							className="mt-4 flex flex-wrap items-center gap-2 rounded-[8px] border border-warning-border bg-warning-bg px-3 py-2"
						>
							<CornerUpLeft
								size={13}
								className="shrink-0 text-warning-text"
								aria-hidden
							/>
							<span className="text-[13px] font-medium text-warning-text">
								{/*
								  Two shapes, two sentences. "not to X" is wrong when the
								  author is among the targets — the reply reaches them *and*
								  whoever else was added, which is the case worth naming most.
								*/}
								{replyTo.some(
									(address) =>
										address.toLowerCase() === (email.sender ?? "").toLowerCase(),
								)
									? `Replies go to ${replyTo.join(", ")} — more than just the sender.`
									: `Replies go to ${replyTo.join(", ")}, not to ${email.sender}.`}
							</span>
						</div>
					)}

					{/* Per-message actions */}
					<div className="mt-4 flex flex-wrap items-center gap-1.5">
						{/*
						  Draft actions are gated on the handlers, not on `isDraft` alone.
						  A discarded draft sitting in Trash is still marked as a draft —
						  it is the user's own unsent text and labelling it anything else
						  is a lie — but it cannot be sent or edited from the bin, so it
						  arrives with no handlers and gets no buttons. Rendering them
						  from `isDraft` alone produced a Send button wired to
						  `onClick={undefined}`.
						*/}
						{isDraft ? (
							<>
								{onSendDraft && (
								<button
									type="button"
									onClick={onSendDraft}
									disabled={isSending}
									className="inline-flex items-center gap-1.5 rounded-[6px] bg-accent px-2.5 py-1.5 text-[11px] font-semibold text-accent-foreground disabled:opacity-50"
								>
									<Send size={12} />
									{isSending ? "Sending…" : "Send draft"}
								</button>
								)}
								{onEditDraft && (
								<button
									type="button"
									onClick={onEditDraft}
									className="inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-text-secondary hover:bg-bg-muted"
								>
									<Pencil size={12} />
									Edit
								</button>
								)}
								{onDeleteDraft && (
								<button
									type="button"
									onClick={onDeleteDraft}
									className="inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-text-secondary hover:bg-destructive/10 hover:text-destructive"
								>
									<Trash2 size={12} />
									Discard
								</button>
								)}
							</>
						) : (
							<>
								{onReply && (
									<button
										type="button"
										onClick={onReply}
										{...composerPreloadProps}
										className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-card px-4 text-[13px] font-medium text-text-primary transition-colors hover:bg-bg-muted"
									>
										<CornerUpLeft size={15} />
										Reply
									</button>
								)}
								{onReplyAll && (
									<button
										type="button"
										onClick={onReplyAll}
										className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-card px-4 text-[13px] font-medium text-text-primary transition-colors hover:bg-bg-muted"
									>
										<ReplyAll size={15} />
										Reply all
									</button>
								)}
								{onForward && (
									<button
										type="button"
										onClick={onForward}
										className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-card px-4 text-[13px] font-medium text-text-primary transition-colors hover:bg-bg-muted"
									>
										<CornerUpRight size={15} />
										Forward
									</button>
								)}
							</>
						)}

						<div className="flex-1" />

						<button
							type="button"
							onClick={downloadEml}
							title="Download original (.eml)"
							aria-label="Download original message"
							className="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-secondary hover:bg-bg-muted hover:text-text-primary"
						>
							<Download size={15} />
						</button>
						{onViewSource && (
							<button
								type="button"
								onClick={onViewSource}
								title="View source"
								aria-label="View message source"
								className="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-secondary hover:bg-bg-muted hover:text-text-primary"
							>
								<Code2 size={15} />
							</button>
						)}
					</div>
				</div>
			)}
		</article>
	);
}
