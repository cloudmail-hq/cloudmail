/**
 * Folder rail for the mail workspace.
 *
 * Unlike the retired kumo sidebar this lists Spam, because inbound mail from a
 * blocked sender is filed there and was previously unreachable in the UI.
 */

import { Fragment, useMemo, useState } from "react";
import { composerPreloadProps } from "~/components/lazy";
import { NavLink, useNavigate } from "react-router";
import {
	Archive,
	ChevronDown,
	Clock,
	FileText,
	Folder as FolderIcon,
	Inbox,
	Layers,
	Mail,
	MailQuestion,
	PenSquare,
	Plus,
	Send,
	Settings2,
	ShieldAlert,
	Settings,
	ShieldCheck,
	Tag,
	Timer,
	Trash2,
	UserCheck,
	X,
} from "lucide-react";
import {
	folderCountKind,
	Folders,
	formatBadgeCount,
	getFolderDisplayName,
} from "shared/folders";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useUIStore } from "~/hooks/useUIStore";
import { useZoneStore } from "~/hooks/useZoneStore";
import { useMailboxVisibilityStore } from "~/hooks/useMailboxVisibilityStore";
import { visibleMailboxes } from "~/lib/mailbox-visibility";
import { cn } from "~/lib/utils";
import { errorMessage, showToast } from "~/lib/toast";
import { useCreateFolder, useFolders } from "~/queries/folders";
import { useCreateLabel, useLabels } from "~/queries/labels";
import { useFollowups } from "~/queries/followups";
import { useMailbox, useMailboxes } from "~/queries/mailboxes";
import { usePendingApprovalCount } from "~/queries/approvals";

/** Sidebar order, including Spam. */
const SIDEBAR_FOLDERS = [
	{ id: Folders.INBOX, Icon: Inbox },
	{ id: Folders.SNOOZED, Icon: Clock },
	{ id: Folders.SENT, Icon: Send },
	{ id: Folders.SCHEDULED, Icon: Timer },
	{ id: Folders.DRAFT, Icon: FileText },
	{ id: Folders.ARCHIVE, Icon: Archive },
	{ id: Folders.SPAM, Icon: ShieldAlert },
	{ id: Folders.TRASH, Icon: Trash2 },
] as const;

// The Screener is a system folder with its own route, nested under Inbox.
const SYSTEM_IDS = new Set<string>([...SIDEBAR_FOLDERS.map((f) => f.id), Folders.SCREENER]);

const LABEL_COLORS = [
	"#6b7280",
	"#ef4444",
	"#f97316",
	"#eab308",
	"#22c55e",
	"#3b82f6",
	"#a855f7",
	"#ec4899",
];

interface RailLinkProps {
	to: string;
	label: string;
	icon: React.ReactNode;
	count?: number;
	/** Unread (bold) or a neutral total (Drafts, Scheduled). */
	countKind?: "unread" | "total";
	/** Show the count as an attention badge (things that need action, not unread mail). */
	badge?: boolean;
	onNavigate?: () => void;
}

function RailLink({
	to,
	label,
	icon,
	count,
	countKind = "unread",
	badge,
	onNavigate,
}: RailLinkProps) {
	return (
		<NavLink
			to={to}
			onClick={onNavigate}
			className={({ isActive }) =>
				cn(
					"group/rail flex h-8 items-center gap-3 rounded-[6px] px-2.5 text-[13px] transition-colors",
					isActive
						? "active bg-accent-subtle font-semibold text-accent-subtle-fg"
						: "text-text-secondary hover:bg-bg-muted hover:text-text-primary",
				)
			}
		>
			<span className="shrink-0 text-text-tertiary group-[.active]/rail:text-accent-subtle-fg">
				{icon}
			</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{/*
			  A plain number, as in Gmail. A tinted pill on every folder made the
			  counts the loudest thing in the rail.
			*/}
			{/*
			  Unread counts are bold; totals (Drafts, Scheduled) are plain grey, so
			  your own unsent work does not read as mail waiting for you.
			*/}
			{count != null && count > 0 && (
				<span
					className={cn(
						"shrink-0 text-xs tabular-nums",
						badge
							? "rounded-full bg-accent px-1.5 py-px text-[11px] font-semibold text-accent-foreground"
							: countKind === "total"
								? "font-normal text-text-tertiary"
								: "font-semibold",
					)}
					title={
						badge
							? `${count} waiting for approval`
							: countKind === "total"
								? `${count} in ${label}`
								: `${count} unread`
					}
				>
					{formatBadgeCount(count)}
				</span>
			)}
		</NavLink>
	);
}

interface MailSidebarProps {
	mailboxId: string;
	/** Called after navigating, so the mobile drawer can close itself. */
	onNavigate?: () => void;
}

export default function MailSidebar({
	mailboxId,
	onNavigate,
}: MailSidebarProps) {
	const navigate = useNavigate();
	const { data: folders = [] } = useFolders(mailboxId);
	const { data: labels = [], isPending: labelsPending } = useLabels(mailboxId);
	// Honour the domain selector: the switcher used to list every mailbox on every
	// domain regardless of the chosen zone, which made the selector look broken.
	const { selectedZone } = useZoneStore();
	const { data: mailboxes = [] } = useMailboxes(selectedZone?.domain);
	const { hiddenMailboxIds } = useMailboxVisibilityStore();
	const createFolder = useCreateFolder();
	const createLabel = useCreateLabel();
	const { startCompose } = useUIStore();

	const [creating, setCreating] = useState<"folder" | "label" | null>(null);
	const [draftName, setDraftName] = useState("");
	const [draftColor, setDraftColor] = useState(LABEL_COLORS[0]);

	// Fetched by id rather than looked up in `mailboxes`, which is now filtered by
	// the selected domain: viewing a mailbox on one domain while the selector
	// points at another would otherwise blank the header out to a raw id.
	const { data: currentMailbox } = useMailbox(mailboxId);

	/**
	 * The switcher lists what the user chose to see, plus whatever is open.
	 *
	 * `mailboxId` is passed as `alwaysInclude` so navigating to a hidden mailbox
	 * directly — an old bookmark, a link from the people view — still leaves it
	 * in the list rather than showing a switcher that omits the mailbox on screen.
	 */
	const switchable = useMemo(
		() => visibleMailboxes(mailboxes, hiddenMailboxIds, mailboxId),
		[mailboxes, hiddenMailboxIds, mailboxId],
	);
	const hiddenCount = mailboxes.length - switchable.length;

	const customFolders = useMemo(
		() => folders.filter((f) => !SYSTEM_IDS.has(f.id)),
		[folders],
	);

	const countFor = (folderId: string) => {
		const folder = folders.find((f) => f.id === folderId);
		if (!folder) return 0;
		return folderCountKind(folderId) === "total"
			? (folder.totalCount ?? folder.unreadCount)
			: folder.unreadCount;
	};

	// Fired reminders are the ones that need the user now; pending ones wait.
	const { data: followups = [] } = useFollowups(mailboxId);
	const awaitingCount = followups.filter((f) => f.status === "fired").length;

	// Shown while the Screener is on, or while anything is still waiting in it.
	const screenerFolder = folders.find((f) => f.id === Folders.SCREENER);
	const screenerWaiting = screenerFolder?.totalCount ?? 0;
	const showScreener =
		currentMailbox?.settings?.screener === "unknown_only" || screenerWaiting > 0;
	// Agent and MCP sends waiting for a person. Always listed so the queue is
	// discoverable before anything has been held; the count is the badge.
	const { data: approvalCount } = usePendingApprovalCount(mailboxId);

	const submitCreate = (e: React.FormEvent) => {
		e.preventDefault();
		const name = draftName.trim();
		if (!name) return;

		if (creating === "folder") {
			createFolder.mutate(
				{ mailboxId, name },
				{
					onError: (err) =>
						showToast({
							kind: "error",
							message: errorMessage(err, "Could not create the folder."),
						}),
				},
			);
		} else {
			createLabel.mutate(
				{ mailboxId, name, color: draftColor },
				{
					onError: (err) =>
						showToast({
							kind: "error",
							message: errorMessage(err, "Could not create the label."),
						}),
				},
			);
		}

		setDraftName("");
		setDraftColor(LABEL_COLORS[0]);
		setCreating(null);
	};

	return (
		<aside className="flex h-full w-full flex-col border-r border-border bg-card">
			{/* Mailbox switcher */}
			{/*
			  Gutters trimmed to 2.5 throughout, to buy back some of what the rail lost
			  when it went from 232px to 208px: the account name and the folder counts
			  are what the width is for, not the margin beside them.
			*/}
			<div className="shrink-0 px-2.5 pt-2.5">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="flex w-full items-center gap-2 rounded-[8px] border border-border bg-card px-2.5 py-2 text-left transition-colors hover:bg-bg-muted"
						>
							<Mail size={14} className="shrink-0 text-violet" aria-hidden />
							<span className="min-w-0 flex-1">
								<span className="block truncate text-xs font-semibold text-text-primary">
									{currentMailbox?.settings?.fromName ||
										currentMailbox?.name ||
										mailboxId}
								</span>
								<span className="block truncate text-[11px] font-light text-text-tertiary">
									{currentMailbox?.email ?? mailboxId}
								</span>
							</span>
							<ChevronDown
								size={13}
								className="shrink-0 text-text-tertiary"
								aria-hidden
							/>
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-64">
						{switchable.map((box) => (
							<DropdownMenuItem
								key={box.id}
								className="cursor-pointer"
								onClick={() => {
									navigate(`/mail/${encodeURIComponent(box.id)}/inbox`);
									onNavigate?.();
								}}
							>
								<Mail size={14} />
								<span className="truncate">{box.email}</span>
							</DropdownMenuItem>
						))}
						<DropdownMenuSeparator />
						{/*
						  Hidden mailboxes are not silently dropped from the switcher: the
						  count says how many, so a mailbox that stopped appearing is
						  explained rather than mysterious.
						*/}
						<DropdownMenuItem
							className="cursor-pointer"
							onClick={() => {
								navigate("/");
								onNavigate?.();
							}}
						>
							<Settings2 size={14} />
							{hiddenCount > 0
								? `Manage inboxes (${hiddenCount} hidden)`
								: "Manage inboxes"}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{/* Compose */}
			<div className="shrink-0 px-2.5 py-2.5">
				<button
					type="button"
					onClick={() => startCompose()}
					{...composerPreloadProps}
					className="flex h-10 w-full items-center justify-center gap-2 rounded-[8px] bg-accent px-3 text-[13px] font-semibold text-accent-foreground shadow-sm transition-colors hover:bg-accent-hover"
				>
					<PenSquare size={14} />
					Compose
				</button>
			</div>

			<nav aria-label="Folders and labels" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
				{/*
				  Every mailbox at once, above this one's folders. Outlook keeps
				  cross-account views at the top of the folder pane, not in the app-level nav.
				*/}
				{mailboxes.length > 1 && (
					<div className="mb-1 border-b border-border/70 pb-1">
						<RailLink
							to="/mail/all/inbox"
							label="All inboxes"
							icon={<Layers size={15} />}
							onNavigate={onNavigate}
						/>
					</div>
				)}
				{SIDEBAR_FOLDERS.map(({ id, Icon }) => (
					<Fragment key={id}>
						<RailLink
							to={`/mail/${encodeURIComponent(mailboxId)}/${id}`}
							label={getFolderDisplayName(id)}
							icon={<Icon size={15} />}
							count={countFor(id)}
							countKind={folderCountKind(id)}
							onNavigate={onNavigate}
						/>
						{/* First-time senders waiting for a Yes or No, nested under Inbox. */}
						{id === Folders.INBOX && showScreener && (
							<div className="pl-4">
								<RailLink
									to={`/mail/${encodeURIComponent(mailboxId)}/screener`}
									label="Screener"
									icon={<UserCheck size={15} />}
									count={screenerFolder?.unreadCount ?? 0}
									onNavigate={onNavigate}
								/>
							</div>
						)}
						{/* Sent mail with a follow-up reminder, nested under Sent. */}
						{id === Folders.SENT && (
							<div className="pl-4">
								<RailLink
									to={`/mail/${encodeURIComponent(mailboxId)}/awaiting`}
									label="Awaiting reply"
									icon={<MailQuestion size={15} />}
									count={awaitingCount}
									onNavigate={onNavigate}
								/>
							</div>
						)}
					</Fragment>
				))}
				<RailLink
					to={`/mail/${encodeURIComponent(mailboxId)}/approvals`}
					label="Pending approval"
					icon={<ShieldCheck size={15} />}
					count={approvalCount?.pending ?? 0}
					badge
					onNavigate={onNavigate}
				/>

				{/* Custom folders */}
				<div className="pt-4">
					<div className="mb-1 flex items-center justify-between px-2.5">
						<span className="text-xs font-medium text-text-tertiary">
							Folders
						</span>
						<button
							type="button"
							onClick={() => {
								setCreating("folder");
								setDraftName("");
							}}
							aria-label="Create folder"
							className="-mr-1.5 inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
						>
							<Plus size={13} />
						</button>
					</div>
					{customFolders.map((folder) => (
						<RailLink
							key={folder.id}
							to={`/mail/${encodeURIComponent(mailboxId)}/${folder.id}`}
							label={folder.name}
							icon={<FolderIcon size={15} />}
							count={folder.unreadCount}
							onNavigate={onNavigate}
						/>
					))}
				</div>

				{/* Labels */}
				<div className="pt-4">
					<div className="mb-1 flex items-center justify-between px-2.5">
						<span className="text-xs font-medium text-text-tertiary">
							Labels
						</span>
						<button
							type="button"
							onClick={() => {
								setCreating("label");
								setDraftName("");
							}}
							aria-label="Create label"
							className="-mr-1.5 inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
						>
							<Plus size={13} />
						</button>
					</div>
					{labels.map((label) => (
						<RailLink
							key={label.id}
							to={`/mail/${encodeURIComponent(mailboxId)}/label/${label.id}`}
							label={label.name}
							icon={<Tag size={15} style={{ color: label.color }} />}
							count={label.unread_count}
							onNavigate={onNavigate}
						/>
					))}
					{/* Not "No labels yet" while they are still loading. */}
					{labels.length === 0 && creating !== "label" && !labelsPending && (
						<p className="px-2.5 text-xs font-light text-text-tertiary">
							No labels yet.
						</p>
					)}
				</div>

				{/* Inline create form — cheaper than a modal for a single field */}
				{creating && (
					<form
						onSubmit={submitCreate}
						className="mt-2 space-y-2 rounded-[8px] border border-border bg-card p-2.5"
					>
						<div className="flex items-center justify-between">
							<span className="text-[11px] font-semibold text-text-primary">
								New {creating}
							</span>
							<button
								type="button"
								onClick={() => setCreating(null)}
								aria-label="Cancel"
								className="rounded-[4px] p-0.5 text-text-tertiary hover:text-text-primary"
							>
								<X size={12} />
							</button>
						</div>
						<input
							autoFocus
							value={draftName}
							onChange={(e) => setDraftName(e.target.value)}
							placeholder={creating === "folder" ? "Projects" : "Invoices"}
							aria-label={`${creating} name`}
							className="w-full rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15"
						/>
						{creating === "label" && (
							<div className="flex flex-wrap gap-1.5">
								{LABEL_COLORS.map((color) => (
									<button
										key={color}
										type="button"
										onClick={() => setDraftColor(color)}
										aria-label={`Use colour ${color}`}
										aria-pressed={draftColor === color}
										className={cn(
											"h-5 w-5 rounded-full transition-transform",
											draftColor === color
												? "ring-2 ring-text-primary/40 ring-offset-1"
												: "hover:scale-110",
										)}
										style={{ backgroundColor: color }}
									/>
								))}
							</div>
						)}
						<button
							type="submit"
							disabled={!draftName.trim()}
							className="w-full rounded-[6px] bg-accent px-2 py-1.5 text-xs font-medium text-accent-foreground disabled:opacity-50"
						>
							Create
						</button>
					</form>
				)}
			</nav>

			{/* This mailbox's settings: a page of the mailbox, not of the app. */}
			<div className="shrink-0 border-t border-border px-2 py-1.5">
				<RailLink
					to={`/mail/${encodeURIComponent(mailboxId)}/settings`}
					label="Mailbox settings"
					icon={<Settings size={15} />}
					onNavigate={onNavigate}
				/>
			</div>
		</aside>
	);
}
