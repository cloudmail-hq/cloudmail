/**
 * Actions for the open conversation.
 *
 * The frequent verbs (reply, archive, delete) are always visible; the rest live
 * in menus so the strip survives a narrow reading pane.
 */

import { composerPreloadProps } from "~/components/lazy";
import {
	Archive,
	ArchiveRestore,
	ArrowLeft,
	Ban,
	BellOff,
	BellRing,
	Check,
	ChevronDown,
	Clock,
	CornerUpLeft,
	CornerUpRight,
	FolderInput,
	Inbox,
	Mail,
	MailX,
	MoreHorizontal,
	Pencil,
	Printer,
	ReplyAll,
	Send,
	ShieldAlert,
	Star,
	Tag,
	Trash2,
	X,
} from "lucide-react";
import { Folders } from "shared/folders";
import { snoozePresets } from "shared/dates";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";
import type { Email, EmailLabel, EmailPriority, Folder, Label } from "~/types";

interface MessageToolbarProps {
	email: Email;
	folderId?: string;
	labels: Label[];
	emailLabels: EmailLabel[];
	moveTargets: Folder[];
	isSending: boolean;
	onClose: () => void;
	onReply: () => void;
	onReplyAll: () => void;
	onForward: () => void;
	onArchive: () => void;
	onDelete: () => void;
	/** Only reachable from the bin; see `inTrash` below. */
	onRestore: () => void;
	onToggleStar: () => void;
	onToggleRead: () => void;
	onMove: (folderId: string) => void;
	onSetLabels: (labelIds: string[]) => void;
	onSnooze: (untilIso: string) => void;
	onUnsnooze: () => void;
	onSetPriority: (priority: EmailPriority) => void;
	onBlockSender: () => void;
	onMarkSpam: () => void;
	onNotSpam: () => void;
	onPrint: () => void;
	/**
	 * Where this sender's unsubscribe link points, or undefined when the message
	 * carries no `List-Unsubscribe` header.
	 *
	 * A link rather than a callback because it is a plain navigation, and rendering
	 * it as an anchor is what gives the reader the address in the status bar before
	 * they commit to leaving the list.
	 */
	unsubscribeHref?: string;
	/**
	 * Where a reply will actually go, when that is not the sender.
	 *
	 * The full explanation lives at the foot of the message, next to the Reply
	 * button there. These buttons are the ones that are always on screen, so a
	 * reader can start a reply from a long newsletter without having scrolled far
	 * enough to meet it — this puts the destination in their label and tooltip so
	 * the redirect is at least stated where the action is taken.
	 */
	replyDestination?: string;
	/** Whether this conversation is muted; undefined while it loads. */
	isMuted?: boolean;
	onToggleMute: () => void;
	/** Present only while the message is queued for delivery. */
	onCancelScheduled?: () => void;
	isCancellingScheduled?: boolean;
	/**
	 * Present only when the open message is an unsent draft.
	 *
	 * The per-message Send lives inside the expanded card body, which a draft
	 * that isn't the newest message in its thread never shows — so without this
	 * there is no way to send it from the reading pane at all.
	 */
	onSendDraft?: () => void;
	onEditDraft?: () => void;
	/**
	 * Which menu a keystroke asked for, or null.
	 *
	 * `v`, `l` and `.` open the Move, Label and overflow menus. They are the same
	 * Radix dropdowns the mouse uses — driven from outside rather than duplicated,
	 * so a shortcut and a click land on exactly one menu.
	 */
	openMenu?: "move" | "label" | "more" | null;
	onOpenMenuChange?: (menu: "move" | "label" | "more" | null) => void;
}

function ToolButton({
	label,
	onClick,
	disabled,
	danger,
	active,
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	danger?: boolean;
	active?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={label}
			aria-label={label}
			className={cn(
				"inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40",
				danger
					? "text-text-secondary hover:bg-destructive/10 hover:text-destructive"
					: active
						? "bg-bg-muted text-text-primary"
						: "text-text-secondary hover:bg-bg-muted hover:text-text-primary",
			)}
		>
			{children}
		</button>
	);
}

/** A labelled icon button for the phone action bar: icon over a short word. */
function BarButton({
	label,
	title,
	onClick,
	disabled,
	children,
}: {
	label: string;
	title?: string;
	onClick: () => void;
	disabled?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title ?? label}
			aria-label={title ?? label}
			className="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium text-text-secondary active:bg-bg-muted disabled:opacity-40"
		>
			<span aria-hidden>{children}</span>
			<span aria-hidden className="truncate">
				{label}
			</span>
		</button>
	);
}

export default function MessageToolbar({
	email,
	folderId,
	labels,
	emailLabels,
	moveTargets,
	isSending,
	onClose,
	onReply,
	onReplyAll,
	onForward,
	onArchive,
	onDelete,
	onRestore,
	onToggleStar,
	onToggleRead,
	onMove,
	onSetLabels,
	onSnooze,
	onUnsnooze,
	onSetPriority,
	onBlockSender,
	onMarkSpam,
	onNotSpam,
	onPrint,
	unsubscribeHref,
	replyDestination,
	isMuted = false,
	onToggleMute,
	onCancelScheduled,
	isCancellingScheduled = false,
	onSendDraft,
	onEditDraft,
	openMenu = null,
	onOpenMenuChange,
}: MessageToolbarProps) {
	const appliedLabelIds = new Set(emailLabels.map((l) => l.id));
	const inSpam = (folderId ?? email.folder_id) === Folders.SPAM;
	const inArchive = (folderId ?? email.folder_id) === Folders.ARCHIVE;
	const inTrash = (folderId ?? email.folder_id) === Folders.TRASH;
	const isSnoozed = !!email.snoozed_until;

	/**
	 * Wire one dropdown to the shared `openMenu` slot.
	 *
	 * Radix menus are otherwise self-controlled; naming which one is open lets a
	 * keystroke open the very same menu a click does, and guarantees only one is
	 * ever open at a time.
	 */
	const menuProps = (menu: "move" | "label" | "more") => ({
		open: openMenu === menu,
		onOpenChange: (next: boolean) => onOpenMenuChange?.(next ? menu : null),
	});

	const toggleLabel = (labelId: string) => {
		const next = appliedLabelIds.has(labelId)
			? [...appliedLabelIds].filter((id) => id !== labelId)
			: [...appliedLabelIds, labelId];
		onSetLabels(next);
	};

	/**
	 * The overflow menu's rows, shared by the top toolbar's menu and the phone
	 * action bar's, so the two cannot list different things.
	 */
	const moreItems = (
		<>
			{inSpam ? (
				<DropdownMenuItem className="cursor-pointer" onClick={onNotSpam}>
					<Inbox size={13} />
					Not spam — move to Inbox
				</DropdownMenuItem>
			) : (
				<DropdownMenuItem className="cursor-pointer" onClick={onMarkSpam}>
					<ShieldAlert size={13} />
					Report spam
				</DropdownMenuItem>
			)}
			<DropdownMenuItem className="cursor-pointer" onClick={onToggleMute}>
				{isMuted ? <BellRing size={13} /> : <BellOff size={13} />}
				{isMuted ? "Unmute conversation" : "Mute conversation"}
			</DropdownMenuItem>
			<DropdownMenuItem className="cursor-pointer" onClick={onBlockSender}>
				<Ban size={13} />
				Block sender
			</DropdownMenuItem>
			{/*
			  Next to Block sender, because they are the same intention at two
			  strengths: ask the sender to stop, or stop accepting them. It used to
			  be a banner above every message from a list, which spent the pane's
			  most valuable row restating an offer the reader takes up once.

			  `asChild` keeps it a real anchor inside the menu item, so the target
			  is visible on hover and middle-click still works.
			*/}
			{unsubscribeHref && (
				<DropdownMenuItem asChild className="cursor-pointer">
					<a href={unsubscribeHref} target="_blank" rel="noopener noreferrer">
						<MailX size={13} />
						Unsubscribe
					</a>
				</DropdownMenuItem>
			)}
			<DropdownMenuSeparator />
			<DropdownMenuLabel>Priority</DropdownMenuLabel>
			<DropdownMenuItem
				className="cursor-pointer"
				onClick={() => onSetPriority("high")}
			>
				<span className="flex-1">High</span>
				{email.priority === "high" && <Check size={12} />}
			</DropdownMenuItem>
			<DropdownMenuItem
				className="cursor-pointer"
				onClick={() => onSetPriority(null)}
			>
				<span className="flex-1">Normal</span>
				{!email.priority && <Check size={12} />}
			</DropdownMenuItem>
			<DropdownMenuItem
				className="cursor-pointer"
				onClick={() => onSetPriority("low")}
			>
				<span className="flex-1">Low</span>
				{email.priority === "low" && <Check size={12} />}
			</DropdownMenuItem>
			<DropdownMenuSeparator />
			<DropdownMenuItem className="cursor-pointer" onClick={onPrint}>
				<Printer size={13} />
				Print
			</DropdownMenuItem>
		</>
	);

	/** Archive, or Restore from the bin, or nothing from Archive itself. */
	const archiveAction = inTrash
		? { label: "Restore", title: "Restore to its original folder", icon: <ArchiveRestore size={18} />, onClick: onRestore }
		: inArchive
			? null
			: { label: "Archive", title: "Archive", icon: <Archive size={18} />, onClick: onArchive };

	return (
		<>
		{/*
		  The phone action bar: Reply, Reply all, Forward, Archive and More,
		  pinned to the bottom of the reader where a thumb is, Gmail-style. The
		  top toolbar drops those same buttons below `md` so nothing appears
		  twice, and keeps the back arrow and the per-message toggles.

		  Rendered first but positioned with `order-last` by the reader's flex
		  column (see MessageView), so it sits under the scrolling body rather
		  than floating over the last lines of the message. Safe-area padding
		  keeps the labels above the home indicator.
		*/}
		<div
			role="toolbar"
			aria-label="Message actions"
			{...composerPreloadProps}
			className="pb-safe order-last flex shrink-0 items-stretch justify-around border-t border-border bg-card md:hidden"
		>
			<BarButton
				label="Reply"
				title={replyDestination ? `Reply — goes to ${replyDestination}` : "Reply"}
				onClick={onReply}
				disabled={isSending}
			>
				<CornerUpLeft size={18} />
			</BarButton>
			<BarButton
				label="Reply all"
				title={
					replyDestination ? `Reply all — goes to ${replyDestination}` : "Reply all"
				}
				onClick={onReplyAll}
				disabled={isSending}
			>
				<ReplyAll size={18} />
			</BarButton>
			<BarButton label="Forward" onClick={onForward} disabled={isSending}>
				<CornerUpRight size={18} />
			</BarButton>
			{archiveAction && (
				<BarButton
					label={archiveAction.label}
					title={archiveAction.title}
					onClick={archiveAction.onClick}
				>
					{archiveAction.icon}
				</BarButton>
			)}
			{/* Trash beside Archive here too, rather than in the top bar. */}
			<BarButton
				label={inTrash || inSpam ? "Delete" : "Trash"}
				title={inTrash || inSpam ? "Delete forever" : "Move to Trash"}
				onClick={onDelete}
			>
				<Trash2 size={18} />
			</BarButton>
			{/* Its own menu rather than the top bar's: that one is hidden here, and
			    Radix would anchor its content to an invisible trigger. */}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						aria-label="More actions"
						className="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium text-text-secondary active:bg-bg-muted"
					>
						<MoreHorizontal size={18} aria-hidden />
						More
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-56">
					{moreItems}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>

		<div
			// Reply and Forward open the code-split composer; start fetching it as
			// soon as the pointer or focus reaches the toolbar.
			{...composerPreloadProps}
			className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border bg-card px-2 py-1.5 touch:gap-0 touch:px-1 touch:py-0.5">
			{/* Back on a phone, where the reader has replaced the list; Close beside it. */}
			<ToolButton label="Back to list" onClick={onClose}>
				<ArrowLeft size={16} className="touch:size-5" />
			</ToolButton>

			<div className="mx-1.5 h-5 w-px bg-border max-md:hidden" aria-hidden />

			<div className="contents max-md:hidden">
			<ToolButton
				label={
					replyDestination ? `Reply — goes to ${replyDestination}` : "Reply"
				}
				onClick={onReply}
				disabled={isSending}
			>
				<CornerUpLeft size={16} />
			</ToolButton>
			<ToolButton
				label={
					replyDestination
						? `Reply all — goes to ${replyDestination}`
						: "Reply all"
				}
				onClick={onReplyAll}
				disabled={isSending}
			>
				<ReplyAll size={16} />
			</ToolButton>
			<ToolButton label="Forward" onClick={onForward} disabled={isSending}>
				<CornerUpRight size={16} />
			</ToolButton>

			<div className="mx-1.5 h-5 w-px bg-border" aria-hidden />

			{/* Archiving out of the bin makes no sense; putting it back does. */}
			{inTrash ? (
				<ToolButton label="Restore to its original folder" onClick={onRestore}>
					<ArchiveRestore size={16} />
				</ToolButton>
			) : (
				!inArchive && (
					<ToolButton label="Archive" onClick={onArchive}>
						<Archive size={16} />
					</ToolButton>
				)
			)}
			{/*
			  Trash beside Archive: the two "get this out of my inbox" actions sit
			  together, and Delete is no longer adjacent to Move with equal weight.
			*/}
			<ToolButton
				label={inTrash || inSpam ? "Delete forever" : "Move to Trash"}
				onClick={onDelete}
				danger
			>
				<Trash2 size={16} />
			</ToolButton>

			<div className="mx-1.5 h-5 w-px bg-border" aria-hidden />
			</div>

			{/* Right-aligned on a phone, where the verbs before them moved down. */}
			<div className="flex-1 md:hidden" aria-hidden />
			<ToolButton
				label={email.starred ? "Unstar" : "Star"}
				onClick={onToggleStar}
				active={email.starred}
			>
				<Star size={16} fill={email.starred ? "currentColor" : "none"} />
			</ToolButton>
			<ToolButton
				label={email.read ? "Mark unread" : "Mark read"}
				onClick={onToggleRead}
			>
				<Mail size={16} />
			</ToolButton>

			{/* Snooze */}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						title="Snooze"
						aria-label="Snooze"
						className="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
					>
						<Clock size={16} />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-52">
					<DropdownMenuLabel>Snooze until</DropdownMenuLabel>
					{snoozePresets().map((preset) => (
						<DropdownMenuItem
							key={preset.id}
							className="cursor-pointer"
							onClick={() => onSnooze(preset.at.toISOString())}
						>
							<span className="flex-1">{preset.label}</span>
							<span className="text-[10px] font-light text-text-tertiary">
								{preset.at.toLocaleString(undefined, {
									weekday: "short",
									hour: "numeric",
									minute: "2-digit",
								})}
							</span>
						</DropdownMenuItem>
					))}
					{isSnoozed && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem className="cursor-pointer" onClick={onUnsnooze}>
								<X size={13} />
								Unsnooze now
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>

			{/* Labels */}
			{labels.length > 0 && (
				<DropdownMenu {...menuProps("label")}>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							title="Labels"
							aria-label="Labels"
							className="inline-flex h-8 items-center gap-0.5 rounded-full px-2 text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
						>
							<Tag size={16} />
							<ChevronDown size={10} />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-52">
						<DropdownMenuLabel>Labels</DropdownMenuLabel>
						{labels.map((label) => (
							<DropdownMenuItem
								key={label.id}
								className="cursor-pointer"
								onClick={() => toggleLabel(label.id)}
							>
								<span
									className="h-2.5 w-2.5 rounded-full"
									style={{ backgroundColor: label.color }}
									aria-hidden
								/>
								<span className="flex-1 truncate">{label.name}</span>
								{appliedLabelIds.has(label.id) && <Check size={12} />}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}

			{/* Move */}
			{moveTargets.length > 0 && (
				<DropdownMenu {...menuProps("move")}>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							title="Move to"
							aria-label="Move to folder"
							className="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
						>
							<FolderInput size={16} />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-48">
						<DropdownMenuLabel>Move to</DropdownMenuLabel>
						{moveTargets.map((folder) => (
							<DropdownMenuItem
								key={folder.id}
								className="cursor-pointer"
								onClick={() => onMove(folder.id)}
							>
								{folder.name}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}

			<div className="flex-1 max-md:hidden" />

			{onSendDraft && (
				<>
					{onEditDraft && (
						<button
							type="button"
							onClick={onEditDraft}
							disabled={isSending}
							className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card h-8 px-3 text-[13px] font-medium text-text-secondary hover:bg-bg-muted disabled:opacity-50"
						>
							<Pencil size={14} />
							Edit
						</button>
					)}
					<button
						type="button"
						onClick={onSendDraft}
						disabled={isSending}
						className="inline-flex items-center gap-1.5 rounded-full bg-accent h-8 px-3 text-[13px] font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
					>
						<Send size={14} />
						{isSending ? "Sending…" : "Send"}
					</button>
				</>
			)}

			{onCancelScheduled && (
				<button
					type="button"
					onClick={onCancelScheduled}
					disabled={isCancellingScheduled}
					className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card h-8 px-3 text-[13px] font-semibold text-text-primary hover:bg-bg-muted disabled:opacity-50"
				>
					<X size={14} />
					{isCancellingScheduled ? "Cancelling…" : "Cancel send"}
				</button>
			)}

			{/* Overflow. On a phone this lives in the bottom action bar instead. */}
			<DropdownMenu {...menuProps("more")}>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						title="More actions"
						aria-label="More actions"
						className="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary max-md:hidden"
					>
						<MoreHorizontal size={16} />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-56">
					{moreItems}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
		</>
	);
}
