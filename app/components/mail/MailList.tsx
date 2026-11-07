/**
 * The message list, shared by the folder, label and search views.
 *
 * Rows are identical everywhere, so each caller supplies only data, a heading
 * and an empty state. `collectionKey` identifies what is being listed so the
 * component can drop selection when the user navigates sideways.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { SecurityWarningIcon } from "~/components/mail/SecurityWarnings";
import {
	AlertTriangle,
	Archive,
	ArchiveRestore,
	CheckCheck,
	ChevronLeft,
	ChevronRight,
	CloudOff,
	CornerUpLeft,
	Mail,
	MailOpen,
	Paperclip,
	RefreshCw,
	Star,
	Trash2,
} from "lucide-react";
import { formatListDate } from "shared/dates";
import { canMoveMessageInto, Folders, isOutboundFrom } from "shared/folders";
import { splitSnippetHighlights } from "shared/fts";
import { draftPreview, redactSecrets } from "shared/redact-secrets";
import MailFilterBar from "~/components/mail/MailFilterBar";
import { SentStatusIcon } from "~/components/mail/SentStatus";
import MailSelectionBar, {
	type BulkExtra,
} from "~/components/mail/MailSelectionBar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { hasActiveFilters, type MailListFilters } from "~/lib/mail-filters";
import {
	MENU_REQUEST_EVENT,
	type MenuRequest,
} from "~/hooks/useKeyboardShortcuts";
import { useCollapseOnScroll } from "~/hooks/useCollapseOnScroll";
import { usePullToRefresh } from "~/hooks/usePullToRefresh";
import { useSwipeRow } from "~/hooks/useSwipeRow";
import { useUIStore } from "~/hooks/useUIStore";
import { announce, errorMessage, showToast } from "~/lib/toast";
import { wasTrashed } from "~/lib/delete-outcome";
import { cn, getSnippetText } from "~/lib/utils";
import {
	senderAvatarTint,
	senderDisplayName,
	senderInitials,
} from "~/lib/sender-display";
import { useBulkAction, useMarkAllRead } from "~/queries/bulk";
import {
	useDeleteEmail,
	useEmptyTrash,
	useMarkThreadRead,
	useMoveEmail,
	useRestoreEmail,
	useUpdateEmail,
} from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import { useLabels, useSetEmailLabels } from "~/queries/labels";
import { usePreferenceValues } from "~/queries/preferences";
import { useAssistantPrefValues } from "~/queries/assistant";
import { AiMark } from "~/components/mail/AiSummary";
import type { BulkActionRequest, Density } from "~/services/api";
import type { Email } from "~/types";
import { isDeliveryProblem } from "~/types";

export const PAGE_SIZE = 25;

/**
 * Row geometry per density.
 *
 * Three genuine tiers rather than a boolean: the vertical padding, the gap
 * between the row's columns, the leading on the two text lines, and the size of
 * the avatar-less star/checkbox column all move together. Changing padding alone
 * produced a "compact" row that was shorter but still typographically roomy,
 * which read as a rendering bug rather than a setting.
 *
 * Kept as one table so a tier cannot be half-defined, and so the difference
 * between tiers is legible at a glance.
 */
const DENSITY: Record<
	Density,
	{
		/** Row padding. */
		row: string;
		/** Leading on the participants line. */
		heading: string;
		/** Gap between the subject line and the row above it. */
		subject: string;
		/** Hit target for the inline row actions. */
		action: string;
		/**
		 * Top offset for the checkbox and star.
		 *
		 * These sit in their own columns beside a text block whose first line gets
		 * shorter as density increases, so a fixed offset left them floating above
		 * the name they belong to in the compact tier.
		 */
		glyph: string;
		/** Top offset for the star, which is a touch taller than the checkbox. */
		star: string;
	}
> = {
	comfortable: {
		row: "gap-3 pl-5 pr-3.5 py-3.5",
		heading: "leading-6",
		subject: "mt-1 leading-6",
		action: "h-7 w-7",
		glyph: "mt-1.5",
		star: "mt-1",
	},
	cozy: {
		row: "gap-3 pl-5 pr-3 py-2.5",
		heading: "leading-5",
		subject: "mt-0.5 leading-5",
		action: "h-6 w-6",
		glyph: "mt-1",
		star: "mt-0.5",
	},
	compact: {
		row: "gap-2 pl-4 pr-2.5 py-1.5",
		heading: "leading-4",
		subject: "mt-0 leading-4",
		action: "h-5 w-5",
		glyph: "mt-0.5",
		star: "mt-0",
	},
};

/**
 * The 24x24 floor WCAG 2.2 SC 2.5.8 asks of a pointer target.
 *
 * An accessibility floor outranks a density preference: the compact tier's
 * `h-5 w-5` action buttons are 20px, which fails the success criterion outright,
 * so the floor is applied on top of `density.action` for every tier.
 *
 * `min-h`/`min-w` rather than `h`/`w` deliberately. Tailwind-merge treats height
 * and min-height as separate groups, so this raises the compact tier to 24px
 * without overwriting the roomier tiers — a plain `h-6 w-6` floor would have
 * merged away comfortable's `h-7 w-7` and silently flattened all three tiers
 * into one size.
 */
const ACTION_TARGET_FLOOR = "min-h-6 min-w-6";

/**
 * Whether a swipe right can archive from this view.
 *
 * Not from Archive itself, and not from Trash or Spam, where "archive" would
 * quietly rescue mail the user put there on purpose; the row resists instead.
 * Views with no folder (label, search) list mail from anywhere, and archiving
 * from them is what the reader's Archive does too.
 */
function canArchiveFrom(folderId: string | undefined): boolean {
	return (
		folderId !== Folders.ARCHIVE &&
		folderId !== Folders.TRASH &&
		folderId !== Folders.SPAM &&
		folderId !== Folders.DRAFT
	);
}

/**
 * A list row that can be swiped: right to archive, left to trash.
 *
 * The coloured layer sits behind the row's content and is only painted during
 * a drag (`data-swipe`); at rest the content covers it, so a screenshot of an
 * idle list is unchanged. The swipe is a shortcut, never the only way: the
 * same actions stay on the row's hover/cursor buttons and in the reader.
 */
function SwipeRow({
	onArchive,
	onTrash,
	trashLabel,
	disabled,
	className,
	children,
}: {
	onArchive?: () => void;
	onTrash?: () => void;
	trashLabel: string;
	disabled?: boolean;
	className?: string;
	children: React.ReactNode;
}) {
	const { contentRef, revealRef, handlers } = useSwipeRow({ onArchive, onTrash, disabled });
	return (
		<>
			<div ref={revealRef} aria-hidden className="swipe-reveal absolute inset-0 flex items-center justify-between px-6 text-sm font-semibold text-white">
				<span className="swipe-reveal-archive flex items-center gap-2">
					<Archive size={18} />
					Archive
				</span>
				<span className="swipe-reveal-trash flex items-center gap-2">
					{trashLabel}
					<Trash2 size={18} />
				</span>
			</div>
			<div ref={contentRef} {...handlers} className={className}>
				{children}
			</div>
		</>
	);
}

export function MailListSkeleton() {
	return (
		<div className="animate-pulse space-y-1 p-2">
			{Array.from({ length: 10 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 px-2 py-2.5">
					<div className="h-3.5 w-3.5 rounded bg-bg-muted" />
					<div className="min-w-0 flex-1 space-y-2">
						<div className="flex items-center gap-2">
							<div className="h-3 w-28 rounded bg-bg-muted" />
							<div className="h-3 flex-1 rounded bg-bg-muted" />
							<div className="h-3 w-10 rounded bg-bg-muted" />
						</div>
						<div className="h-2.5 w-3/4 rounded bg-bg-muted" />
					</div>
				</div>
			))}
		</div>
	);
}

/**
 * Shown when the list could not be fetched.
 *
 * Deliberately not the empty state: "your inbox is empty" and "we could not
 * reach the server" call for opposite reactions from the reader, and conflating
 * them reads as data loss. Offers a retry, because the usual cause is a tab
 * waking up from sleep.
 */
export function MailListError({
	error,
	onRetry,
}: {
	error: unknown;
	onRetry: () => void;
}) {
	return (
		<div
			role="alert"
			className="flex flex-col items-center justify-center px-6 py-16 text-center"
		>
			<CloudOff size={22} className="text-text-tertiary" aria-hidden />
			<p className="mt-3 text-sm font-semibold text-text-primary">
				Could not load these messages
			</p>
			<p className="mt-1 max-w-xs text-xs font-light text-text-secondary">
				{errorMessage(error, "Something went wrong reaching the server.")}
			</p>
			<button
				type="button"
				onClick={onRetry}
				className="mt-4 rounded-[6px] bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
			>
				Try again
			</button>
		</div>
	);
}

interface MailListProps {
	mailboxId: string;
	title: string;
	titleAdornment?: React.ReactNode;
	/**
	 * The phone's module bar above already names this view ("Inbox ▾"), so
	 * below `md` the header keeps the title for screen readers only.
	 */
	titleInModuleBar?: boolean;
	emails: Email[];
	totalCount: number;
	isRefreshing: boolean;
	page: number;
	onPageChange: (page: number) => void;
	onRefresh: () => void;
	empty: React.ReactNode;
	/** A line above the rows, e.g. search parse warnings. */
	notice?: React.ReactNode;
	/**
	 * Why the list could not be loaded, if it could not be.
	 *
	 * Distinct from an empty result and rendered differently. Without this the
	 * component treated a failed fetch as "no messages" and told the reader their
	 * inbox was empty — the single most alarming thing a mail client can say when
	 * the truth is that the request failed.
	 */
	error?: unknown;
	collectionKey: string;
	/** Scope for Mark all read, matching what this view lists. */
	markAllReadScope?: { folder?: string; label_id?: string };
	/**
	 * The folder being listed, when this view is one folder.
	 *
	 * Only used to decide affordances that only make sense in the bin — Empty
	 * Trash, Restore, and whether Delete is reversible. Label and search views
	 * leave it unset because their rows can come from anywhere.
	 */
	folderId?: string;
	countNoun?: string;
	/**
	 * Filter and sort state. Omit both to hide the filter bar, for views whose
	 * backing endpoint cannot honour them.
	 */
	filters?: MailListFilters;
	onFiltersChange?: (next: MailListFilters) => void;
	/** Hidden where the endpoint has a fixed order, e.g. search relevance. */
	showSort?: boolean;
	/**
	 * The phone's "load more" mode. When set, `emails` holds every page loaded
	 * so far, the pager is replaced by an infinite-scroll sentinel plus a Load
	 * more button, and `onPageChange(page + 1)` asks for the next page.
	 */
	loadMore?: { hasMore: boolean; loading: boolean };
	/** Rendered at the top of the scrolling area, above the rows (the inbox "Today" card). */
	header?: React.ReactNode;
}

export default function MailList({
	mailboxId,
	title,
	titleAdornment,
	titleInModuleBar = false,
	emails,
	totalCount,
	isRefreshing,
	page,
	onPageChange,
	onRefresh,
	empty,
	error,
	collectionKey,
	markAllReadScope,
	folderId,
	countNoun = "conversation",
	filters,
	onFiltersChange,
	showSort = true,
	loadMore,
	notice,
	header,
}: MailListProps) {
	const {
		selectedEmailId,
		selectEmail,
		closePanel,
		setNavigableRows,
		cursorEmailId,
		setCursorEmailId,
		selectionAnchorId,
		checkedEmailIds,
		toggleChecked,
		setCheckedEmailIds,
		clearChecked,
	} = useUIStore();
	// Decides whether a row may be moved into Sent (only mail this mailbox sent).
	const mailboxAddress = useMailbox(mailboxId).data?.email ?? null;

	const updateEmail = useUpdateEmail();
	const markThreadRead = useMarkThreadRead();
	const deleteEmail = useDeleteEmail();
	const restoreEmail = useRestoreEmail();
	const moveEmail = useMoveEmail();
	const emptyTrash = useEmptyTrash();
	const bulkAction = useBulkAction();
	const markAllRead = useMarkAllRead();
	const { data: folders = [] } = useFolders(mailboxId);
	const { data: labels = [] } = useLabels(mailboxId);

	// Row geometry and whether the snippet line is drawn, from the saved display
	// preferences. Read here rather than passed in: every listing route renders
	// this component, and threading one prop through all of them would let them
	// drift.
	const { display } = usePreferenceValues();
	const assistant = useAssistantPrefValues();
	const density = DENSITY[display.density];

	/** Only the bin can be emptied, and only from it can messages be restored. */
	const isTrashView = folderId === Folders.TRASH;

	/**
	 * Where Delete destroys rather than bins.
	 *
	 * Spam counts as well as Trash, matching the storage layer: a second delete
	 * on a junk message is a request to be rid of it. Labelling that "Move to
	 * Trash" and skipping the confirmation would destroy mail behind a button
	 * that promised to be reversible.
	 */
	const isTerminalView = isTrashView || folderId === Folders.SPAM;

	/**
	 * Ticked ids narrowed to what is on screen. Paging keeps the store's set so a
	 * selection survives a round trip, but acting on rows the user cannot see
	 * would be invisible, so every action works from this.
	 */
	const visibleChecked = useMemo(() => {
		const listed = new Set(emails.map((e) => e.id));
		return checkedEmailIds.filter((id) => listed.has(id));
	}, [checkedEmailIds, emails]);

	const hasSelection = visibleChecked.length > 0;
	const allChecked =
		emails.length > 0 && visibleChecked.length === emails.length;

	/** A threaded row reports unread for the whole conversation. */
	const hasUnread = (email: Email): boolean =>
		email.thread_unread_count !== undefined
			? email.thread_unread_count > 0
			: !email.read;

	useEffect(() => () => clearChecked(), [clearChecked]);

	/**
	 * Publish the listed rows so the keyboard handler can step through them.
	 *
	 * Read and starred state travels with the id because `s` and `*u` decide what
	 * to do from it; see `navigableRows` in the store.
	 */
	useEffect(() => {
		setNavigableRows(
			emails.map((e) => ({
				id: e.id,
				read: !hasUnread(e),
				starred: !!e.starred,
			})),
		);
	}, [emails, setNavigableRows]);
	useEffect(() => () => setNavigableRows([]), [setNavigableRows]);

	/**
	 * Stable DOM ids for the rows, so `aria-activedescendant` can name one.
	 *
	 * Derived from the collection as well as the message id: two lists mounted at
	 * once (list beside reading pane) would otherwise emit duplicate element ids
	 * and the attribute would resolve to whichever rendered first.
	 */
	const rowDomId = (id: string) => `mailrow-${collectionKey}-${id}`;
	const checkboxDomId = (id: string) => `mailcheck-${collectionKey}-${id}`;

	const listRef = useRef<HTMLUListElement>(null);

	/**
	 * Keep the cursor row on screen.
	 *
	 * `j` past the fold is the whole point of a cursor, and a cursor that has
	 * scrolled out of view is exactly the invisible selection this feature exists
	 * to avoid. `nearest` rather than `center` so short moves don't jerk the list.
	 */
	useEffect(() => {
		if (!cursorEmailId) return;
		const row = listRef.current?.querySelector<HTMLElement>(
			`#${CSS.escape(rowDomId(cursorEmailId))}`,
		);
		row?.scrollIntoView({ block: "nearest" });
		// `rowDomId` is derived from `collectionKey`, which is already a dependency.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cursorEmailId, collectionKey]);

	/**
	 * Tick every row between the anchor and this one.
	 *
	 * Shift-click is the only way to select a span without clicking each row, and
	 * with no anchor yet it degrades to ticking the one row rather than doing
	 * nothing.
	 */
	const checkRange = (toId: string) => {
		const anchor = selectionAnchorId;
		if (!anchor) {
			toggleChecked(toId);
			return;
		}
		const from = emails.findIndex((e) => e.id === anchor);
		const to = emails.findIndex((e) => e.id === toId);
		if (from === -1 || to === -1) {
			toggleChecked(toId);
			return;
		}
		const span = emails
			.slice(Math.min(from, to), Math.max(from, to) + 1)
			.map((e) => e.id);
		// Union with what is already ticked: shift-clicking a second range adds to
		// the selection rather than replacing the first.
		const next = new Set(checkedEmailIds);
		for (const id of span) next.add(id);
		setCheckedEmailIds([...next]);
	};

	/**
	 * Which menu `v` / `l` / `.` opened on the cursor row.
	 *
	 * The list renders one menu anchored to the cursor rather than three per row:
	 * a page of 25 rows would otherwise mount 75 dropdowns to serve one keystroke.
	 * Only requests aimed at the cursor are taken; the reading pane answers the
	 * ones aimed at the open message.
	 */
	const [cursorMenu, setCursorMenu] = useState<MenuRequest["menu"] | null>(null);

	useEffect(() => {
		function onMenuRequest(event: Event) {
			const detail = (event as CustomEvent<MenuRequest>).detail;
			if (!detail || detail.target !== "cursor") return;
			if (!cursorEmailId) {
				announce("Move the cursor to a message first");
				return;
			}
			setCursorMenu(detail.menu);
		}

		window.addEventListener(MENU_REQUEST_EVENT, onMenuRequest);
		return () => window.removeEventListener(MENU_REQUEST_EVENT, onMenuRequest);
	}, [cursorEmailId]);

	// A menu anchored to a row that has gone would float unattached.
	useEffect(() => {
		if (!cursorEmailId) setCursorMenu(null);
	}, [cursorEmailId]);

	const setEmailLabels = useSetEmailLabels();

	/** Apply one action from the cursor-row menu, then close it. */
	const runCursorMenuAction = (run: (id: string) => void) => {
		const id = cursorEmailId;
		setCursorMenu(null);
		if (id) run(id);
	};

	const prevCollectionRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		const first = prevCollectionRef.current === undefined;
		const changed = prevCollectionRef.current !== collectionKey;
		prevCollectionRef.current = collectionKey;
		if (changed) {
			// Not on first mount: a deep link (`?m=`) or a reload has just opened
			// the message this list is being mounted under.
			if (!first) closePanel();
			clearChecked();
			onPageChange(1);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [collectionKey, closePanel, clearChecked]);

	const runBulkAction = (
		action: BulkActionRequest["action"],
		extra?: BulkExtra,
	) => {
		if (visibleChecked.length === 0) return;
		const ids = visibleChecked;

		const body: BulkActionRequest =
			action === "move"
				? { action, ids, folder_id: extra?.folder_id ?? "" }
				: action === "label" || action === "unlabel"
					? { action, ids, label_id: extra?.label_id ?? "" }
					: { action, ids };

		// Destroying a selection is the one bulk action with no way back, so it is
		// the one that still asks.
		if (
			action === "delete_permanently" &&
			!window.confirm(
				`Permanently delete ${ids.length} message${ids.length !== 1 ? "s" : ""}? This cannot be undone.`,
			)
		) {
			return;
		}

		bulkAction.mutate(
			{ mailboxId, body },
			{
				onSuccess: (result) => {
					clearChecked();
					if (
						(action === "delete" ||
							action === "delete_permanently" ||
							action === "restore" ||
							action === "move") &&
						selectedEmailId &&
						ids.includes(selectedEmailId)
					) {
						closePanel();
					}

					// Undo is offered only for what actually went to the bin. A
					// selection spanning the inbox and the bin trashes some rows and
					// destroys others, and promising to undo the lot would be a lie.
					if (action === "delete" && (result?.trashed ?? 0) > 0) {
						const trashedIds = ids;
						showToast({
							message: `Moved ${result.trashed} to Trash`,
							action: {
								label: "Undo",
								onClick: (dismiss) => {
									dismiss();
									bulkAction.mutate({
										mailboxId,
										body: { action: "restore", ids: trashedIds },
									});
								},
							},
						});
					}
				},
				onError: (err) =>
					showToast({
						kind: "error",
						message: errorMessage(err, "That bulk action failed."),
					}),
			},
		);
	};

	/** Empty Trash: irreversible and unbounded, so it always confirms. */
	const handleEmptyTrash = () => {
		if (
			!window.confirm(
				"Permanently delete everything in Trash? This cannot be undone.",
			)
		) {
			return;
		}

		emptyTrash.mutate(
			{ mailboxId },
			{
				onSuccess: ({ deleted }) => {
					closePanel();
					clearChecked();
					showToast({
						message: `Deleted ${deleted} message${deleted !== 1 ? "s" : ""}`,
					});
				},
				onError: (err) =>
					showToast({
						kind: "error",
						message: errorMessage(err, "Could not empty Trash."),
					}),
			},
		);
	};

	/**
	 * Row-level delete.
	 *
	 * Reversible outside the bin, so it reports with an Undo instead of asking
	 * first; inside the bin it destroys the message and asks.
	 */
	const handleRowDelete = (email: Email) => {
		if (isTerminalView && !window.confirm("Delete this message permanently?")) {
			return;
		}

		deleteEmail.mutate(
			{ mailboxId, id: email.id },
			{
				onSuccess: (result) => {
					if (wasTrashed(result)) {
						showToast({
							message: "Moved to Trash",
							action: {
								label: "Undo",
								onClick: (dismiss) => {
									dismiss();
									restoreEmail.mutate({ mailboxId, id: email.id });
								},
							},
						});
					}
				},
				onError: (err) =>
					showToast({
						kind: "error",
						message: errorMessage(err, "Could not delete that message."),
					}),
			},
		);

		if (selectedEmailId === email.id) closePanel();
	};

	/**
	 * Row-level archive, from a swipe. Reversible, so it reports with an Undo
	 * rather than asking, the same as the reader's Archive.
	 */
	const handleRowArchive = (email: Email) => {
		const from = email.folder_id ?? folderId;
		moveEmail.mutate(
			{ mailboxId, id: email.id, folderId: Folders.ARCHIVE },
			{
				onSuccess: () => {
					if (!from || from === Folders.ARCHIVE) return;
					showToast({
						message: "Archived",
						action: {
							label: "Undo",
							onClick: (dismiss) => {
								dismiss();
								moveEmail.mutate({ mailboxId, id: email.id, folderId: from });
							},
						},
					});
				},
				onError: (err) =>
					showToast({
						kind: "error",
						message: errorMessage(err, "Could not archive that message."),
					}),
			},
		);
		if (selectedEmailId === email.id) closePanel();
	};

	const handleRowClick = (email: Email) => {
		selectEmail(email.id);
		if (!hasUnread(email)) return;
		if (email.thread_id && (email.thread_count ?? 1) > 1) {
			markThreadRead.mutate({ mailboxId, threadId: email.thread_id });
		} else {
			updateEmail.mutate({ mailboxId, id: email.id, data: { read: true } });
		}
	};

	/**
	 * Collapse a thread's participants into a short, de-duplicated summary.
	 *
	 * The mailbox's own address reads as "me", and is dropped entirely when
	 * anyone else took part — a Sent row said "alex, devops" for a message from
	 * devops to Alex.
	 */
	const formatParticipants = (email: Email): string => {
		const self = mailboxId.toLowerCase();
		const addresses = (email.participants || email.sender)
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean);
		const others = addresses.filter((a) => a.toLowerCase() !== self);
		// The name the sender gave in `From:` when the list carries one (threaded
		// rows send a map, flat rows the row's own sender_name); otherwise the
		// address humanised, as before.
		const nameFor = (address: string): string =>
			email.participant_names?.[address.toLowerCase()] ||
			(address.toLowerCase() === email.sender?.toLowerCase()
				? email.sender_name
				: null) ||
			senderDisplayName(address);
		const names = (others.length > 0 ? others.map(nameFor) : ["me"]).filter(
			(name, idx, arr) => arr.indexOf(name) === idx,
		);
		if (names.length <= 3) return names.join(", ");
		return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
	};

	const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

	/**
	 * Pull down from the top of the list to refresh, on touch. Off while a
	 * selection is open so a stray pull never discards it, and `onRefresh` is
	 * the same refetch the header's Refresh button runs.
	 */
	const pull = usePullToRefresh({ onRefresh, disabled: hasSelection });

	/**
	 * On a phone the filter row folds away while scrolling down the list and
	 * comes back on the way up, so the list gets the height back. Only in
	 * load-more mode, which is the phone layout; desktop chrome never moves.
	 */
	const chromeHidden = useCollapseOnScroll(pull.scrollerRef, !!loadMore);

	/**
	 * Infinite scroll: ask for the next page when a sentinel below the last row
	 * comes within a screen of view. The Load more button inside it is the
	 * fallback for when the observer is unavailable or the reader is faster.
	 */
	const sentinelRef = useRef<HTMLDivElement>(null);
	const canLoadMore = !!loadMore?.hasMore && !loadMore.loading;
	const nextPageRef = useRef(() => {});
	nextPageRef.current = () => {
		if (canLoadMore) onPageChange(page + 1);
	};
	useEffect(() => {
		const sentinel = sentinelRef.current;
		const root = pull.scrollerRef.current;
		if (!canLoadMore || !sentinel || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) nextPageRef.current();
			},
			{ root, rootMargin: "0px 0px 100% 0px" },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [canLoadMore, emails.length, pull.scrollerRef]);

	return (
		<div className="flex h-full min-h-0 flex-col bg-card">
			{hasSelection ? (
				<MailSelectionBar
					count={visibleChecked.length}
					allSelected={allChecked}
					onToggleAll={() =>
						setCheckedEmailIds(allChecked ? [] : emails.map((e) => e.id))
					}
					onClear={clearChecked}
					onAction={runBulkAction}
					folders={folders.filter((f) => f.id !== markAllReadScope?.folder)}
					labels={labels}
					canRestore={isTrashView}
					deleteDestroys={isTerminalView}
					busy={bulkAction.isPending}
				/>
			) : (
				// On touch the icon buttons take the 44px floor, so the row's own
				// padding shrinks to keep it from growing by the difference twice.
				<div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-subtle/60 px-3 py-2 touch:gap-0 touch:py-0 touch:pr-1">
					{titleAdornment}
					<h1
						className={cn(
							"min-w-0 truncate text-sm font-bold text-text-primary",
							titleInModuleBar && "max-md:sr-only",
						)}
					>
						{title}
					</h1>
					{totalCount > 0 && (
						<span
							className={cn(
								"shrink-0 text-sm font-normal text-text-secondary touch:ml-2",
								// Lines up with the module bar's title when the count leads the row.
								titleInModuleBar && "max-md:ml-1",
							)}
						>
							{totalCount} {countNoun}
							{totalCount !== 1 ? "s" : ""}
							{/* Say so when a filter narrows the count. */}
							{filters && hasActiveFilters(filters) && (
								<span className="text-text-tertiary">
									{" · "}
									{[
										filters.unread && "unread",
										filters.starred && "starred",
										filters.hasAttachment && "with attachments",
									]
										.filter(Boolean)
										.join(", ")}
								</span>
							)}
						</span>
					)}
					<div className="flex-1" />
					{isTrashView && emails.length > 0 && (
						<button
							type="button"
							onClick={handleEmptyTrash}
							disabled={emptyTrash.isPending}
							className="inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
						>
							<Trash2 size={13} />
							Empty Trash
						</button>
					)}
					{emails.length > 0 && (
						<button
							type="button"
							onClick={() => markAllRead.mutate({ mailboxId, scope: markAllReadScope })}
							disabled={markAllRead.isPending}
							title="Mark all read"
							aria-label="Mark all read"
							className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-40"
						>
							<CheckCheck size={14} />
						</button>
					)}
					<button
						type="button"
						onClick={onRefresh}
						disabled={isRefreshing}
						title="Refresh"
						aria-label="Refresh"
						className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-40"
					>
						<RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} />
					</button>
				</div>
			)}

			{filters && onFiltersChange && (
				/*
				  Collapsed with a grid-rows transition rather than display:none, so
				  the list below slides up instead of jumping. `inert` keeps the
				  hidden chips out of the tab order and the accessibility tree.
				*/
				<div
					className={cn(
						"grid shrink-0 transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
						chromeHidden ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
					)}
					inert={chromeHidden || undefined}
				>
					<div className="min-h-0 overflow-hidden">
						<MailFilterBar
							filters={filters}
							onChange={onFiltersChange}
							showSort={showSort}
						/>
					</div>
				</div>
			)}

			{notice}

			{/*
			  `overscroll-y-contain` keeps the browser's own pull-to-refresh (which
			  reloads the app) out of the list, so only ours runs. The bottom padding
			  on touch widths clears the floating Compose button and the home
			  indicator, so the last row is never stuck under them.
			*/}
			<div
				ref={pull.scrollerRef}
				className="relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain max-md:pb-[calc(5.5rem+env(safe-area-inset-bottom,0px))]"
			>
				<div
					ref={pull.indicatorRef}
					aria-hidden
					className="pull-indicator pointer-events-none absolute left-1/2 top-0 z-10 -ml-4 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card text-accent shadow-md"
					style={{ opacity: 0, transform: "translate3d(0,-48px,0)" }}
				>
					<RefreshCw size={15} className={pull.refreshing ? "animate-spin" : ""} />
				</div>
				{header}
				{/*
					Error is checked before empty. A failed fetch also yields zero rows,
					so testing `emails.length` first reported a network failure as an
					empty mailbox. Cached rows still render, with the failure surfaced by
					the `stalled` indicator instead of replacing readable mail.
				*/}
				{error && emails.length === 0 ? (
					<MailListError error={error} onRetry={onRefresh} />
				) : isRefreshing && emails.length === 0 ? (
					<MailListSkeleton />
				) : emails.length > 0 ? (
					/*
					  A listbox rather than a pile of buttons.

					  Every row used to be `role="button" tabIndex={0}`, which put one tab
					  stop per message: reaching the pager past a full page of mail took
					  25 presses, and nothing told assistive tech that the rows were a
					  single set or which one was current. As a composite widget the list
					  is one tab stop, `aria-activedescendant` names the cursor row, and
					  `aria-selected` reports what is ticked.
					*/
					<ul
						ref={listRef}
						role="listbox"
						aria-label={`${title} — ${totalCount} ${countNoun}${totalCount !== 1 ? "s" : ""}`}
						aria-multiselectable
						// Roving tab stop: the list itself is focusable, never the rows.
						tabIndex={0}
						aria-activedescendant={
							cursorEmailId ? rowDomId(cursorEmailId) : undefined
						}
						onFocus={() => {
							// Landing on the list with no cursor puts it on the first row, so
							// the first `j` or Enter has something to act on.
							if (!cursorEmailId && emails.length > 0) {
								setCursorEmailId(emails[0].id);
							}
						}}
						className="divide-y divide-border/70 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
					>
						{emails.map((email) => {
							const isOpen = selectedEmailId === email.id;
							const isChecked = checkedEmailIds.includes(email.id);
							const isCursor = cursorEmailId === email.id;
							// A draft is your own unsent work; it never renders as unread.
							const unread =
								hasUnread(email) && email.folder_id !== Folders.DRAFT && folderId !== Folders.DRAFT;
							/*
							 * Search results arrive with an FTS5 `snippet()` carrying
							 * markers around the matched words; every other list sends a
							 * plain body excerpt with no markers, which splits to a
							 * single unmarked segment. Both render through the same path
							 * so the row markup has one shape.
							 *
							 * `getSnippetText` still strips HTML first: the snippet is
							 * cut from a message body, so it is untrusted text and is
							 * rendered as React text nodes — never as markup.
							 */
							// Previews are masked (`redactSecrets`), and a draft shows only
							// its first line: anyone glancing at the list should not read
							// a password a customer or a half-written draft contains.
							const isDraftRow =
								folderId === Folders.DRAFT || email.folder_id === Folders.DRAFT;
							/*
							 * The AI one-liner replaces the snippet when there is one and the
							 * reader has not turned it off. Search rows carry none (the
							 * search path does not attach summaries), so they keep their
							 * highlighted snippet. Masked like the snippet: a model can echo
							 * a secret it read.
							 */
							const aiLine =
								assistant.listSummaries && !isDraftRow ? email.summary_line : undefined;
							const snippetSegments = (
								aiLine
									? [{ text: aiLine, match: false }]
									: isDraftRow
										? [{ text: draftPreview(getSnippetText(email.snippet, 300)), match: false }]
										: splitSnippetHighlights(getSnippetText(email.snippet, 140))
							)
								.map((segment) => ({ ...segment, text: redactSecrets(segment.text) }))
								.filter((segment) => segment.text.length > 0);

							return (
								<li
									key={email.id}
									id={rowDomId(email.id)}
									role="option"
									aria-selected={isChecked}
									// Shift-click extends from the anchor; a plain click opens.
									onClick={(e) => {
										if (e.shiftKey) {
											e.preventDefault();
											setCursorEmailId(email.id);
											checkRange(email.id);
											return;
										}
										handleRowClick(email);
									}}
									// The swipe layer clips to the row; `pan-y` leaves vertical
									// scrolling to the browser and hands sideways drags to it.
									className="relative touch-pan-y overflow-hidden"
								>
								<SwipeRow
									onArchive={
										canArchiveFrom(folderId) ? () => handleRowArchive(email) : undefined
									}
									onTrash={() => handleRowDelete(email)}
									trashLabel={isTerminalView ? "Delete forever" : "Trash"}
									disabled={hasSelection}
									className={cn(
										"group relative flex w-full cursor-pointer items-start text-left transition-colors",
										density.row,
										/*
										  Three states that must be distinguishable from each other,
										  not just from the default row:
										  - open: violet wash + violet left rail
										  - checked: muted fill
										  - cursor: inset ring on `ring`, plus a solid left rail
										  The cursor is a ring rather than a background so it reads
										  clearly on top of either of the other two. `ring` is the
										  theme's focus token and is defined for both themes
										  (violet 55% light / 72% dark), which clears the 3:1 that
										  WCAG 2.2 SC 1.4.11 asks of a non-text indicator.
										*/
										isOpen
											? "bg-accent-subtle"
											: isChecked
												? "bg-accent-subtle/60"
												: unread
													? "bg-card hover:bg-bg-muted"
													: "bg-bg-subtle hover:bg-bg-muted",
										// Gmail's hover lift: a shadow under the row, so hover reads
										// on read rows whose fill is already tinted.
										"hover:z-[1] hover:shadow-[inset_1px_0_0_var(--color-border),inset_-1px_0_0_var(--color-border),0_1px_3px_rgb(0_0_0/0.12)]",
										// The keyboard cursor keeps a full-strength ring: on `ring`, it is the
										// indicator that has to clear 3:1 (SC 1.4.11) on any row fill.
										isCursor && "ring-2 ring-inset ring-ring",
									)}
								>
									{/*
									  The rail marker. Doubling the ring with a solid bar means the
									  cursor is still locatable where a ring is easy to lose — high
									  contrast modes, and rows already tinted by the open state.
									*/}
									{isCursor && (
										<span
											aria-hidden
											className="absolute inset-y-0 left-0 w-[3px] bg-ring"
										/>
									)}

									{/*
									  Anchor for the `v` / `l` / `.` menus, on the cursor row only.

									  Radix positions content against its trigger, so there has to be
									  one even though a keystroke is what opens this. It is a
									  zero-size, `aria-hidden`, untabbable span: present to give the
									  menu a position in the row, never to be seen or reached.
									*/}
									{isCursor && cursorMenu && (
										<DropdownMenu
											open
											onOpenChange={(next) => {
												if (!next) setCursorMenu(null);
											}}
										>
											<DropdownMenuTrigger asChild>
												<span
													aria-hidden
													tabIndex={-1}
													className="pointer-events-none absolute bottom-0 left-8 block h-0 w-0"
												/>
											</DropdownMenuTrigger>
											<DropdownMenuContent
												align="start"
												className="w-52"
												// Radix wants a trigger; this menu is opened by a
												// keystroke instead, so focus is handed to it directly
												// and returned to the list on close.
												onCloseAutoFocus={(e) => {
													e.preventDefault();
													listRef.current?.focus();
												}}
											>
												{cursorMenu === "move" && (
													<>
														<DropdownMenuLabel>Move to</DropdownMenuLabel>
														{folders
															.filter(
																(f) =>
																	f.id !== folderId &&
																	canMoveMessageInto(f.id, {
																		outbound: isOutboundFrom(email.sender, mailboxAddress),
																	}),
															)
															.map((folder) => (
																<DropdownMenuItem
																	key={folder.id}
																	className="cursor-pointer"
																	onClick={() =>
																		runCursorMenuAction((id) => {
																			moveEmail.mutate({
																				mailboxId,
																				id,
																				folderId: folder.id,
																			});
																			announce(`Moved to ${folder.name}`);
																		})
																	}
																>
																	{folder.name}
																</DropdownMenuItem>
															))}
													</>
												)}

												{cursorMenu === "label" && (
													<>
														<DropdownMenuLabel>Label as</DropdownMenuLabel>
														{labels.length === 0 && (
															<DropdownMenuItem disabled>
																No labels yet
															</DropdownMenuItem>
														)}
														{labels.map((label) => (
															<DropdownMenuItem
																key={label.id}
																className="cursor-pointer"
																onClick={() =>
																	runCursorMenuAction((id) => {
																		// The list row carries no label set, so this
																		// adds rather than toggles. Removing a label
																		// is the reading pane's job, where the
																		// current set is known.
																		setEmailLabels.mutate({
																			mailboxId,
																			emailId: id,
																			labelIds: [label.id],
																		});
																		announce(`Labelled ${label.name}`);
																	})
																}
															>
																<span
																	className="h-2.5 w-2.5 rounded-full"
																	style={{ backgroundColor: label.color }}
																	aria-hidden
																/>
																<span className="flex-1 truncate">
																	{label.name}
																</span>
															</DropdownMenuItem>
														))}
													</>
												)}

												{cursorMenu === "more" && (
													<>
														<DropdownMenuLabel>More actions</DropdownMenuLabel>
														<DropdownMenuItem
															className="cursor-pointer"
															onClick={() =>
																runCursorMenuAction((id) => {
																	const row = emails.find((e) => e.id === id);
																	updateEmail.mutate({
																		mailboxId,
																		id,
																		data: { read: !row?.read },
																	});
																	announce(
																		row?.read
																			? "Marked as unread"
																			: "Marked as read",
																	);
																})
															}
														>
															<MailOpen size={13} />
															Toggle read
														</DropdownMenuItem>
														<DropdownMenuItem
															className="cursor-pointer"
															onClick={() =>
																runCursorMenuAction((id) => {
																	const row = emails.find((e) => e.id === id);
																	updateEmail.mutate({
																		mailboxId,
																		id,
																		data: { starred: !row?.starred },
																	});
																	announce(row?.starred ? "Unstarred" : "Starred");
																})
															}
														>
															<Star size={13} />
															Toggle star
														</DropdownMenuItem>
														<DropdownMenuSeparator />
														<DropdownMenuItem
															className="cursor-pointer"
															onClick={() =>
																runCursorMenuAction((id) => {
																	const row = emails.find((e) => e.id === id);
																	if (row) handleRowDelete(row);
																})
															}
														>
															<Trash2 size={13} />
															{isTerminalView ? "Delete forever" : "Move to Trash"}
														</DropdownMenuItem>
													</>
												)}
											</DropdownMenuContent>
										</DropdownMenu>
									)}

									{/*
									  Unread marker, in the gutter rather than inline before the
									  name. Inline, it pushed the name 14px right of the subject on
									  unread rows only, so the two lines never shared an edge.
									*/}
									{unread && (
										<span
											className={cn(
												"absolute left-1.5 h-1.5 w-1.5 rounded-full bg-unread",
												display.density === "compact" ? "top-1/2 -translate-y-1/2" : display.density === "cozy" ? "top-[17px]" : "top-[23px]",
											)}
											aria-label="Unread"
										/>
									)}

									{/*
									  Avatar and checkbox share one slot, as in Gmail: the avatar
									  identifies the sender at rest, and the checkbox replaces it on
									  hover, on focus, or once anything is selected. Compact density
									  drops the avatar and keeps the checkbox column.
									*/}
									<div
										className={cn(
											"relative flex shrink-0 items-center justify-center",
											display.density === "compact" ? "h-6 w-6" : "h-9 w-9",
										)}
									>
										{display.density !== "compact" && (
											<span
												aria-hidden
												className={cn(
													"flex h-9 w-9 items-center justify-center rounded-full text-[13px] font-semibold transition-opacity",
													senderAvatarTint(email.sender),
													hasSelection || isChecked
														? "opacity-0"
														: "group-hover:opacity-0 group-focus-within:opacity-0",
												)}
											>
												{senderInitials(email.sender, email.sender_name)}
											</span>
										)}
										<input
											id={checkboxDomId(email.id)}
											type="checkbox"
											checked={isChecked}
											onChange={() => toggleChecked(email.id)}
											onClick={(e) => e.stopPropagation()}
											aria-label={`Select message from ${email.sender}`}
											className={cn(
												"absolute h-4 w-4 cursor-pointer accent-violet",
												// 24px hit area via padding on a 16px control: SC 2.5.8.
												"box-content p-1",
												hasSelection || isChecked || display.density === "compact"
													? ""
													: "opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100",
												display.density === "compact" && !hasSelection && !isChecked &&
													"opacity-0 group-hover:opacity-100 focus:opacity-100",
											)}
										/>
										{/*
										  The hit area: a label over the whole avatar slot (36px,
										  24px in compact; 44px on touch), pointing at the
										  checkbox. Native checkboxes ignore padding, so the 16px
										  box measured 16x16 however it was padded; this grows
										  the target without growing the box. Clicking or tapping
										  the avatar starts a selection, as in Gmail.
										*/}
										<label
											htmlFor={checkboxDomId(email.id)}
											aria-hidden
											onClick={(e) => e.stopPropagation()}
											className="absolute inset-0 block cursor-pointer touch:-inset-1"
										/>
									</div>

									<div className="min-w-0 flex-1">
										<div className={cn("flex items-baseline gap-2", density.heading)}>
											<span
												title={email.participants || email.sender}
												className={cn(
													"truncate text-sm",
													unread
														? "font-semibold text-text-primary"
														: "text-text-secondary",
												)}
											>
												{formatParticipants(email)}
											</span>
											{(email.thread_count ?? 1) > 1 && (
												<span className="shrink-0 rounded-full bg-bg-muted px-1.5 text-[10px] font-semibold leading-4 text-text-secondary">
													{email.thread_count}
												</span>
											)}
											{email.priority === "high" && (
												<span
													title="High priority"
													className="shrink-0 text-xs font-bold text-destructive"
												>
													!
												</span>
											)}
											{/* A message that never arrived, marked either because
											    this app gave up sending it or because a remote
											    server bounced it. Same treatment as the
											    needs-reply corner arrow, in destructive: the
											    reading pane carries the reason, so the row only
											    has to be noticeable enough to open. Labelled
											    rather than `title`-only, since the icon is the
											    entire content of the cue. */}
											{isDeliveryProblem(email.delivery_status) && (
												<span
													title={
														email.delivery_status === "failed"
															? "Couldn't be sent"
															: "Delivery failed"
													}
													className="shrink-0 text-destructive"
												>
													<AlertTriangle
														size={11}
														aria-label={
															email.delivery_status === "failed"
																? "Couldn't be sent"
																: "Delivery failed"
														}
													/>
												</span>
											)}
											{/* Impersonation or link-mismatch warning, stored at
											    delivery. The reading pane carries the detail. */}
											<SecurityWarningIcon email={email} />
											{(email.has_draft || isDraftRow) && (
												<span className="shrink-0 rounded-[4px] bg-bg-muted px-1.5 text-[11px] font-medium leading-4 text-text-secondary">
													Draft
												</span>
											)}
											{email.needs_reply && !email.has_draft && (
												<span
													title="Needs reply"
													className="shrink-0 text-text-tertiary"
												>
													<CornerUpLeft size={12} aria-label="Needs reply" />
												</span>
											)}
											{/* `has_attachment` is a flag computed by the list
											    query. The list projection carries no attachment
											    rows, so the old `attachments?.length` test was
											    never true and the paperclip never rendered. */}
											{email.has_attachment && (
												<Paperclip
													size={11}
													className="shrink-0 text-text-tertiary"
													aria-label="Has attachments"
												/>
											)}
											<span
												className={cn(
													"ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs tabular-nums",
													unread ? "font-semibold text-text-primary" : "text-text-tertiary",
													// The hover actions sit over the date; hiding it keeps
													// the two from showing through each other.
													"group-hover:invisible",
													isCursor && "invisible",
												)}
											>
												{/* Delivery / opened / clicked, for mail this mailbox
												    sent. Beside the date, where chat apps put the ticks,
												    so the subject line keeps its place. */}
												{email.folder_id === Folders.SENT && (
													<SentStatusIcon email={email} />
												)}
												{formatListDate(email.date)}
											</span>
										</div>

										{/*
										  Subject and snippet as two flex items that each truncate,
										  rather than two inline spans inside one truncating line.
										  Inline, a long subject (an unbroken URL, say) laid out at
										  its full width past the row's edge and was only clipped by
										  the parent; as flex items each is sized to the space it
										  gets. The subject may shrink to nothing before the row
										  overflows, and the snippet takes what is left.
										*/}
										<div className={cn("flex min-w-0 text-sm", density.subject)}>
											<span
												className={cn(
													"min-w-0 max-w-full shrink truncate",
													unread
														? "font-semibold text-text-primary"
														: "text-text-primary",
												)}
											>
												{email.subject?.trim() || "(no subject)"}
											</span>
											{display.previewText && snippetSegments.length > 0 && (
												<span
													className={cn(
														"min-w-0 flex-1 truncate text-text-tertiary",
														aiLine && email.summary_status === "blocked" && "italic",
													)}
													title={aiLine ? "AI summary" : undefined}
												>
													{/* Non-breaking: a flex item drops leading spaces. */}
													{" – "}
													{aiLine && <AiMark className="mr-1 align-[-1px]" />}
													{snippetSegments.map((segment, i) =>
														// Plain text for unmatched runs: a wrapper span per
														// run only added boxes laid out past the row's edge.
														// Index keys are stable here: segments are derived
														// from one immutable string and never reordered.
														segment.match ? (
															<mark
																key={i}
																className="rounded-[2px] bg-amber-200/60 font-medium text-text-primary dark:bg-amber-400/25"
															>
																{segment.text}
															</mark>
														) : (
															<Fragment key={i}>{segment.text}</Fragment>
														),
													)}
												</span>
											)}
										</div>
									</div>

									{/*
									  Hover actions.

									  `hidden … group-hover:flex` leaves these unreachable without a
									  pointer, so they also appear once the row is the cursor: that
									  is the keyboard user's equivalent of hovering it.
									*/}
									<div
										className={cn(
											// Over the date, not beside it: in the row's flow they
											// squeezed the text and moved the date on every hover.
											// On the name line, where the date is, so it never lands on the subject.
											display.density === "compact" ? "top-1/2 -translate-y-1/2" : display.density === "cozy" ? "top-2" : "top-3",
											"absolute right-3 items-center gap-0.5 group-hover:flex",
											isCursor ? "flex" : "hidden",
										)}
									>
										<button
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												updateEmail.mutate({
													mailboxId,
													id: email.id,
													data: { read: !email.read },
												});
											}}
											title={email.read ? "Mark unread" : "Mark read"}
											aria-label={email.read ? "Mark unread" : "Mark read"}
											className={cn(
												"inline-flex items-center justify-center rounded-[6px] text-text-tertiary hover:bg-bg-muted hover:text-text-primary",
												density.action,
												ACTION_TARGET_FLOOR,
											)}
										>
											{email.read ? <Mail size={13} /> : <MailOpen size={13} />}
										</button>
										<button
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												handleRowDelete(email);
											}}
											title={isTerminalView ? "Delete forever" : "Move to Trash"}
											aria-label={
												isTerminalView ? "Delete forever" : "Move to Trash"
											}
											className={cn(
												"inline-flex items-center justify-center rounded-[6px] text-text-tertiary hover:bg-destructive/10 hover:text-destructive",
												density.action,
												ACTION_TARGET_FLOOR,
											)}
										>
											<Trash2 size={13} />
										</button>
										{isTrashView && (
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													restoreEmail.mutate({ mailboxId, id: email.id });
												}}
												title="Restore to its original folder"
												aria-label="Restore"
												className={cn(
													"inline-flex items-center justify-center rounded-[6px] text-text-tertiary hover:bg-bg-muted hover:text-text-primary",
													density.action,
													ACTION_TARGET_FLOOR,
												)}
											>
												<ArchiveRestore size={13} />
											</button>
										)}
									</div>
								</SwipeRow>
								</li>
							);
						})}
					</ul>
				) : (
					empty
				)}
				{loadMore && emails.length > 0 && (loadMore.hasMore || loadMore.loading) ? (
					<div ref={sentinelRef} className="flex justify-center px-3 py-3">
						<button
							type="button"
							onClick={() => nextPageRef.current()}
							disabled={!canLoadMore}
							aria-busy={loadMore.loading || undefined}
							className="inline-flex h-11 items-center gap-2 rounded-full border border-border bg-card px-5 text-sm font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:opacity-70"
						>
							{loadMore.loading ? (
								<RefreshCw size={14} className="animate-spin" aria-hidden />
							) : null}
							{loadMore.loading ? "Loading…" : "Load more"}
						</button>
					</div>
				) : loadMore && emails.length > 0 && totalCount > PAGE_SIZE ? (
					<p className="py-4 text-center text-xs text-text-tertiary">
						That's everything: {totalCount} {countNoun}
						{totalCount !== 1 ? "s" : ""}
					</p>
				) : null}
			</div>

			{!loadMore && totalCount > PAGE_SIZE && (
				// Below `md` the floating Compose sits bottom right, so the pager's
				// buttons move left of it (row-reverse) rather than under it.
				<div className="flex shrink-0 items-center justify-between border-t border-border bg-bg-subtle/60 px-3 py-2 max-md:flex-row-reverse max-md:pr-[calc(10rem+env(safe-area-inset-right,0px))] touch:py-0 touch:pl-1">
					<span className="text-xs font-light text-text-tertiary">
						Page {page} of {totalPages}
					</span>
					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={() => onPageChange(Math.max(1, page - 1))}
							disabled={page <= 1}
							aria-label="Previous page"
							className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-secondary hover:bg-bg-muted disabled:opacity-40"
						>
							<ChevronLeft size={14} className="touch:size-5" />
						</button>
						<button
							type="button"
							onClick={() => onPageChange(Math.min(totalPages, page + 1))}
							disabled={page >= totalPages}
							aria-label="Next page"
							className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-secondary hover:bg-bg-muted disabled:opacity-40"
						>
							<ChevronRight size={14} className="touch:size-5" />
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
