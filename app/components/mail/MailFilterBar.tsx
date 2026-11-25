/**
 * Filter and sort controls for the message list.
 *
 * The list previously offered no way to narrow a folder at all: the Worker
 * accepted `sortColumn`/`sortDirection` and nothing ever sent them, and there
 * was no unread/starred/attachment filter on any screen. This is that surface.
 *
 * Sort is a chip at the end of the same row ("Date ↓"), not a separate control
 * group: on a phone the old right-aligned group wrapped onto a second line and
 * cost the list another 44px. The menu sets both key and direction. On desktop
 * a direction button sits beside it as well, so reversing is one click.
 */

import {
	ArrowDown,
	ArrowUp,
	Check,
	ChevronDown,
	Paperclip,
	Star,
	X,
} from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
	NATURAL_DIRECTION,
	SORT_LABELS,
	hasActiveFilters,
	withFiltersCleared,
	withSortKey,
	withToggledDirection,
	type MailListFilters,
	type MailSortDirection,
	type MailSortKey,
} from "~/lib/mail-filters";
import { cn } from "~/lib/utils";

const SORT_KEYS: MailSortKey[] = ["date", "subject", "sender"];

/** What each direction means for each key, in words a reader uses. */
const DIRECTION_LABELS: Record<MailSortKey, Record<MailSortDirection, string>> = {
	date: { DESC: "Newest first", ASC: "Oldest first" },
	subject: { ASC: "A to Z", DESC: "Z to A" },
	sender: { ASC: "A to Z", DESC: "Z to A" },
};

/** The visual pill, shared by the filter chips and the sort chip. */
const PILL =
	"inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors touch:h-8 touch:px-3 touch:text-[13px]";
const PILL_IDLE =
	"border-border bg-card text-text-secondary group-hover/chip:bg-bg-muted group-hover/chip:text-text-primary";
const PILL_ACTIVE = "border-violet/40 bg-violet/10 text-violet";

interface FilterChipProps {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
	icon?: React.ReactNode;
}

/**
 * A pill inside a button, rather than a pill-shaped button.
 *
 * On touch the button is the 44px hit area and the pill stays a compact visual
 * inside it, so the row reads the same as on desktop while a thumb has a full
 * target. On desktop the button is exactly the pill's 28px.
 */
function FilterChip({ active, onClick, children, icon }: FilterChipProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className="group/chip inline-flex shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 touch:min-w-0 touch:px-0.5"
		>
			<span className={cn(PILL, active ? PILL_ACTIVE : PILL_IDLE)}>
				{icon}
				{children}
			</span>
		</button>
	);
}

interface MailFilterBarProps {
	filters: MailListFilters;
	onChange: (next: MailListFilters) => void;
	/** Hidden for views whose backing endpoint cannot sort, e.g. search. */
	showSort?: boolean;
}

export default function MailFilterBar({
	filters,
	onChange,
	showSort = true,
}: MailFilterBarProps) {
	const active = hasActiveFilters(filters);
	const directionLabel = DIRECTION_LABELS[filters.sortKey][filters.sortDirection];
	const DirectionIcon = filters.sortDirection === "ASC" ? ArrowUp : ArrowDown;

	return (
		/*
		  At the 340px list column a `lg` window gives it, the row wraps rather
		  than scrolling (a scrollbar across our own toolbar reads as broken). On
		  a phone it stays on one line so the list keeps the 44px a second line
		  cost: the chips and the sort chip fit in 390px, and on a narrower
		  screen the row scrolls sideways with no visible bar.
		*/
		<div className="no-scrollbar flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-card px-3 py-1.5 touch:flex-nowrap touch:gap-0 touch:overflow-x-auto touch:px-1.5 touch:py-0">
			<FilterChip
				active={filters.unread}
				onClick={() => onChange({ ...filters, unread: !filters.unread })}
			>
				Unread
			</FilterChip>

			<FilterChip
				active={filters.starred}
				onClick={() => onChange({ ...filters, starred: !filters.starred })}
				icon={
					<Star
						size={11}
						fill={filters.starred ? "currentColor" : "none"}
						aria-hidden
					/>
				}
			>
				Starred
			</FilterChip>

			<FilterChip
				active={filters.hasAttachment}
				onClick={() =>
					onChange({ ...filters, hasAttachment: !filters.hasAttachment })
				}
				icon={<Paperclip size={11} aria-hidden />}
			>
				Attachments
			</FilterChip>

			{active && (
				<button
					type="button"
					onClick={() => onChange(withFiltersCleared(filters))}
					aria-label="Clear filters"
					className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 touch:px-1"
				>
					<X size={12} aria-hidden />
					<span className="touch:sr-only">Clear</span>
				</button>
			)}

			{showSort && (
				<div className="ml-auto flex shrink-0 items-center gap-0.5">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								aria-label={`Sort: ${SORT_LABELS[filters.sortKey]}, ${directionLabel}`}
								className="group/chip inline-flex shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 touch:min-w-0 touch:px-0.5"
							>
								<span className={cn(PILL, PILL_IDLE)}>
									{SORT_LABELS[filters.sortKey]}
									<DirectionIcon size={11} aria-hidden className="hidden touch:block" />
									<ChevronDown size={11} aria-hidden />
								</span>
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-44">
							<DropdownMenuLabel>Sort by</DropdownMenuLabel>
							{SORT_KEYS.map((key) => (
								<DropdownMenuItem
									key={key}
									className="cursor-pointer"
									onClick={() =>
										// Re-picking the active key flips direction.
										onChange(
											key === filters.sortKey
												? withToggledDirection(filters)
												: withSortKey(filters, key),
										)
									}
								>
									<span className="flex-1">{SORT_LABELS[key]}</span>
									{key === filters.sortKey && <Check size={12} aria-hidden />}
								</DropdownMenuItem>
							))}
							<DropdownMenuSeparator />
							<DropdownMenuLabel>Order</DropdownMenuLabel>
							{/* The key's natural order first: newest first, A to Z. */}
							{(NATURAL_DIRECTION[filters.sortKey] === "DESC"
								? (["DESC", "ASC"] as const)
								: (["ASC", "DESC"] as const)
							).map((dir) => (
									<DropdownMenuItem
										key={dir}
										className="cursor-pointer"
										onClick={() =>
											dir !== filters.sortDirection && onChange(withToggledDirection(filters))
										}
									>
										<span className="flex-1">{DIRECTION_LABELS[filters.sortKey][dir]}</span>
										{dir === filters.sortDirection && <Check size={12} aria-hidden />}
									</DropdownMenuItem>
								))}
						</DropdownMenuContent>
					</DropdownMenu>

					{/* Desktop only: the menu carries direction on touch. */}
					<button
						type="button"
						onClick={() => onChange(withToggledDirection(filters))}
						title={directionLabel}
						aria-label={`Sort ${
							filters.sortDirection === "ASC" ? "ascending" : "descending"
						}, change direction`}
						className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 touch:hidden"
					>
						<DirectionIcon size={13} aria-hidden />
					</button>
				</div>
			)}
		</div>
	);
}
