/**
 * Attachments on a message.
 *
 * Images and PDFs open in a preview overlay; everything else downloads. The
 * previous UI offered download only, which meant checking a screenshot took a
 * round trip through the filesystem.
 *
 * Styled for the position it actually occupies: above the body, Outlook-style.
 * The trailing rule and top margin this used to carry were leftovers from when
 * it hung off the end of the message, and above the body they read as a divider
 * belonging to whatever sat higher up.
 */

import {
	Download,
	FileText,
	ImageIcon,
	Paperclip,
	ShieldAlert,
} from "lucide-react";
import {
	cn,
	formatBytes,
	getAttachmentUrl,
	getFileTypeLabel,
	getNonInlineAttachments,
	isImageMimeType,
} from "~/lib/utils";
import type { Attachment } from "~/types";

interface AttachmentListProps {
	mailboxId: string;
	emailId: string;
	attachments?: Attachment[];
	onPreview?: (preview: { url: string; filename: string; mimetype: string }) => void;
	/** Escape hatch for callers that need different spacing. */
	className?: string;
}

export default function AttachmentList({
	mailboxId,
	emailId,
	attachments,
	onPreview,
	className,
}: AttachmentListProps) {
	/**
	 * Ordinary attachments, plus every blocked part whatever its disposition.
	 *
	 * `getNonInlineAttachments` exists so a `cid:` image embedded in the body is not
	 * also listed as a file — right for an image that renders, wrong for one that
	 * was refused. A blocked part has no blob, so its `cid:` resolves to a failing
	 * URL and the reader sees a broken image with no explanation and no filename.
	 * Listing it here is the only place they can be told.
	 */
	const items = [
		...getNonInlineAttachments(attachments),
		...(attachments ?? []).filter(
			(att) => att.blocked && att.disposition === "inline" && att.content_id,
		),
	];
	if (items.length === 0) return null;

	return (
		<div
			className={cn(
				"mb-3 rounded-[10px] border border-border bg-bg-subtle/60 px-3 py-2.5",
				className,
			)}
		>
			<div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
				<Paperclip size={11} />
				{items.length} attachment{items.length !== 1 ? "s" : ""}
			</div>
			<ul className="flex flex-wrap gap-2">
				{items.map((att) => {
					const url = getAttachmentUrl(mailboxId, emailId, att.id);
					// The preview overlay renders these in an <img>/<iframe>, so it needs
					// the inline variant; the download link below keeps the plain URL.
					const previewUrl = getAttachmentUrl(mailboxId, emailId, att.id, {
						inline: true,
					});
					const previewable =
						isImageMimeType(att.mimetype) || att.mimetype === "application/pdf";
					const Icon = isImageMimeType(att.mimetype) ? ImageIcon : FileText;

					/**
					 * A refused part: named, but with nothing to click.
					 *
					 * There is no blob, so there is nothing to preview or download. The
					 * chip exists so the reader can see *what* was refused — enough to
					 * ask the sender to resend it another way, which they cannot do if
					 * the attachment simply is not there.
					 */
					if (att.blocked) {
						return (
							<li key={att.id}>
								<div className="flex items-center gap-2 rounded-[8px] border border-warning-border bg-warning-bg px-2.5 py-1.5">
									<ShieldAlert
										size={14}
										className="shrink-0 text-warning-text"
										aria-hidden
									/>
									<span className="min-w-0">
										<span
											className="block max-w-[220px] truncate text-xs font-medium text-warning-text line-through"
											title={att.filename}
										>
											{att.filename}
										</span>
										<span className="block text-[10px] font-light text-warning-text/80">
											Blocked · could run code on your computer
										</span>
									</span>
								</div>
							</li>
						);
					}

					return (
						<li key={att.id}>
							{/* `bg-card`, not the subtle tint the chips used to use: that
							    tint now belongs to the surrounding card and the chips would
							    vanish into it. */}
							<div className="flex items-center gap-2 rounded-[8px] border border-border bg-card px-2.5 py-1.5">
								<Icon size={14} className="shrink-0 text-text-tertiary" aria-hidden />
								<span className="min-w-0">
									<button
										type="button"
										onClick={() => {
											if (previewable && onPreview) {
												onPreview({
													url: previewUrl,
													filename: att.filename,
													mimetype: att.mimetype,
												});
											} else {
												window.open(url, "_blank", "noopener,noreferrer");
											}
										}}
										className="block max-w-[220px] truncate text-left text-xs font-medium text-text-primary hover:underline"
										title={att.filename}
									>
										{att.filename}
									</button>
									<span className="block text-[10px] font-light text-text-tertiary">
										{getFileTypeLabel(att.mimetype)} · {formatBytes(att.size)}
									</span>
								</span>
								<a
									href={url}
									download={att.filename}
									aria-label={`Download ${att.filename}`}
									className="shrink-0 rounded-[6px] p-1 text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
								>
									<Download size={13} />
								</a>
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
