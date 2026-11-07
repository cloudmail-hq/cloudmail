import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Paperclip,
  MoreHorizontal,
  Trash2,
  CheckCheck,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { cn, formatTime, initials, avatarColor } from "~/lib/utils";

// Single source of truth, shared with the Worker that produces these rows.
// Re-exported because several components already import it from here.
export type { GroupedPerson } from "../../shared/people";
import type { GroupedPerson } from "../../shared/people";

export interface LoadMoreProps {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}

interface PersonListProps {
  items: GroupedPerson[];
  loading: boolean;
  total: number;
  pageSize: number;
  page: number;
  onPageChange: (page: number) => void;
  selectedPersonId: string | null;
  onSelectPerson: (person: GroupedPerson) => void;
  onPersonDeleted?: (personId: string) => void;
  isAdmin?: boolean;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  onMarkPersonRead?: (id: string) => void;
  onRefresh?: () => Promise<unknown> | void;
  /**
   * Accumulating "load more" mode (phones). Replaces the pager with an
   * infinite-scroll sentinel, with a button as the fallback.
   */
  loadMore?: LoadMoreProps;
}

/** Loads the next page when it scrolls into view; the button is the fallback. */
function LoadMoreFooter({ hasMore, loading, onLoadMore }: LoadMoreProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || !hasMore || loading || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore();
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  return (
    <div ref={ref} className="flex justify-center px-4 py-4">
      {hasMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loading}
          className="inline-flex min-h-11 items-center gap-2 rounded-[8px] px-4 text-sm font-medium text-text-secondary ring-1 ring-border hover:bg-bg-muted disabled:opacity-60"
        >
          {loading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
          {loading ? "Loading…" : "Load more"}
        </button>
      ) : (
        <p className="text-xs text-text-tertiary">That's everyone.</p>
      )}
    </div>
  );
}

export default function PersonList({
  items,
  loading,
  total,
  pageSize,
  page,
  onPageChange,
  selectedPersonId,
  onSelectPerson,
  onPersonDeleted,
  isAdmin,
  selectedIds,
  onToggleSelected,
  onMarkPersonRead,
  onRefresh,
  loadMore,
}: PersonListProps) {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const handleRefresh = async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const showingRange = useMemo(() => {
    if (total === 0) return "0";
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    return `${start}-${end} of ${total}`;
  }, [total, page, pageSize]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header strip, only when the list owns its own refresh. */}
      {onRefresh && (
        <div className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-2.5">
          <span className="text-sm font-semibold text-text-primary">People</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-tertiary hover:bg-bg-muted hover:text-text-primary touch:h-11 touch:w-11"
              disabled={refreshing}
              aria-label="Refresh people"
              title="Refresh"
            >
              <RefreshCw size={14} className={cn(refreshing && "animate-spin")} aria-hidden />
            </button>
            <span className="text-xs tabular-nums text-text-tertiary">
              {/* No count until there is one: "0" beside "Loading…" read as empty. */}
              {loading ? "" : showingRange}
            </span>
          </div>
        </div>
      )}

      {/* Scrollable list. Bottom padding clears the compose FAB on phones. */}
      <div className="smooth-scroll relative min-h-0 flex-1 overflow-y-auto max-md:pb-[calc(5rem+env(safe-area-inset-bottom,0px))]">
        {loading ? (
          // Skeleton rows in the shape of the real ones, so the list does not
          // jump when it fills.
          <ul aria-busy="true" aria-label="Loading people" className="divide-y divide-border/60">
            {Array.from({ length: 8 }, (_, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-3">
                <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-bg-muted" />
                <span className="min-w-0 flex-1 space-y-2">
                  <span className="block h-3 w-1/2 animate-pulse rounded bg-bg-muted" />
                  <span className="block h-2.5 w-3/4 animate-pulse rounded bg-bg-muted/70" />
                </span>
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <p className="text-sm font-medium text-text-primary">No people found</p>
            <p className="text-sm text-text-tertiary">Try a different search, or wait for new mail.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border/60" aria-label="People">
            {items.map((person) => {
              const isSelected = selectedPersonId === person.id;
              const isChecked = selectedIds?.has(person.id) ?? false;
              const selectionMode = selectedIds !== undefined;
              const anySelected = (selectedIds?.size ?? 0) > 0;
              const color = avatarColor(person.email);
              const display = person.name || person.email;
              const showMenu = Boolean(isAdmin && onPersonDeleted);

              /*
                One row of sibling controls: the checkbox, the person button
                (stretched over the row with ::after so a tap anywhere still
                opens it), the unread button and the actions menu. They used to
                be nested inside the person <button>, which is invalid HTML and
                read out as one long button.
              */
              return (
                <li
                  key={person.id}
                  className={cn(
                    "group relative flex items-start gap-2.5 px-3 py-2.5 transition-colors sm:py-2",
                    isSelected
                      ? "bg-text-primary/[0.04]"
                      : isChecked
                        ? "bg-violet/[0.04]"
                        : "hover:bg-text-primary/[0.025]",
                  )}
                >
                  {isSelected && (
                    <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" aria-hidden />
                  )}

                  {selectionMode && (
                    // A real checkbox with the label as its hit area: 28px on
                    // desktop, 44px on touch. Native boxes ignore padding.
                    <label
                      className={cn(
                        "relative z-10 -my-1 -ml-1 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] touch:-my-2.5 touch:-ml-2.5 touch:h-11 touch:w-11",
                        isChecked || anySelected
                          ? "opacity-100"
                          : "opacity-0 focus-within:opacity-100 group-hover:opacity-100 touch:opacity-100",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => onToggleSelected?.(person.id)}
                        aria-label={`Select ${display}`}
                        className="h-4 w-4 cursor-pointer accent-accent"
                      />
                    </label>
                  )}

                  <span
                    aria-hidden
                    className={cn(
                      "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tracking-tight",
                      selectionMode && (anySelected || isChecked) && "hidden sm:flex",
                    )}
                    style={{ backgroundColor: color.bg, color: color.fg }}
                  >
                    {initials(person.name, person.email)}
                  </span>

                  <div className={cn("min-w-0 flex-1", showMenu && "pr-8 touch:pr-11")}>
                    <div className="flex items-baseline justify-between gap-3">
                      <button
                        type="button"
                        data-testid="person-row"
                        data-person-id={person.id}
                        onClick={() => onSelectPerson(person)}
                        aria-current={isSelected ? "true" : undefined}
                        className={cn(
                          "flex min-w-0 text-left text-sm focus-visible:outline-none",
                          // The hit area covers the row; the focus ring is
                          // drawn on that stretched box.
                          "after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-violet/60",
                          person.unreadCount > 0
                            ? "font-semibold text-text-primary"
                            : "font-medium text-text-primary",
                        )}
                      >
                        <span className="min-w-0 max-w-full shrink truncate">{display}</span>
                        {person.name && (
                          <span className="ml-1.5 min-w-0 flex-1 truncate font-light text-text-tertiary">
                            {person.email}
                          </span>
                        )}
                        {person.unreadCount > 0 ? (
                          <span className="sr-only">, {person.unreadCount} unread</span>
                        ) : null}
                      </button>
                      <span className="shrink-0 text-[11px] text-text-tertiary">
                        {formatTime(person.lastEmailAt)}
                      </span>
                    </div>

                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
                        <span>
                          {person.totalCount} email{person.totalCount !== 1 ? "s" : ""}
                        </span>
                        {person.recipientCount > 1 && (
                          <>
                            <span aria-hidden>·</span>
                            <span>{person.recipientCount} inboxes</span>
                          </>
                        )}
                        {person.hasAttachment === 1 && (
                          <Paperclip size={10} className="text-text-tertiary" aria-label="Has attachment" />
                        )}
                      </div>

                      {person.unreadCount > 0 && (
                        <button
                          type="button"
                          data-testid="person-unread-badge"
                          title="Mark all as read"
                          aria-label={`Mark ${person.unreadCount} unread from ${display} as read`}
                          onClick={() => onMarkPersonRead?.(person.id)}
                          // A 28px hit area around the 20px pill (44px on
                          // touch), above the stretched row button.
                          className="group/badge relative z-10 -my-1 flex h-7 min-w-7 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/60 touch:-my-3 touch:h-11 touch:min-w-11"
                        >
                          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-accent-foreground transition-transform group-hover/badge:scale-110 group-active/badge:scale-95">
                            <span className="group-hover/badge:hidden" aria-hidden>
                              {person.unreadCount}
                            </span>
                            <CheckCheck size={11} className="hidden group-hover/badge:block" aria-hidden />
                          </span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* The menu's only action is delete, so it stays hidden
                      unless a handler is supplied. */}
                  {showMenu && (
                    <button
                      type="button"
                      data-testid="person-kebab-menu"
                      data-person-id={person.id}
                      onClick={() => setMenuOpenId(menuOpenId === person.id ? null : person.id)}
                      aria-expanded={menuOpenId === person.id}
                      aria-haspopup="menu"
                      aria-label={`Actions for ${display}`}
                      className={cn(
                        "absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-tertiary transition-opacity hover:bg-bg-subtle hover:text-text-secondary focus-visible:opacity-100 touch:right-0 touch:top-0 touch:h-11 touch:w-11",
                        menuOpenId === person.id
                          ? "opacity-100"
                          : "opacity-0 group-hover:opacity-100 touch:opacity-100",
                      )}
                    >
                      <MoreHorizontal size={14} aria-hidden />
                    </button>
                  )}

                  {menuOpenId === person.id && (
                    <div
                      role="menu"
                      className="absolute right-2 top-10 z-50 w-44 rounded-[8px] border border-border bg-card py-1 shadow-lg"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="person-delete-button"
                        onClick={() => {
                          if (
                            confirm(
                              `Permanently delete ${display} and all ${person.totalCount} email${person.totalCount !== 1 ? "s" : ""}? This cannot be undone.`,
                            )
                          ) {
                            onPersonDeleted?.(person.id);
                          }
                          setMenuOpenId(null);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive-subtle touch:min-h-11"
                      >
                        <Trash2 size={12} aria-hidden />
                        Delete person
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {loadMore && !loading && items.length > 0 ? <LoadMoreFooter {...loadMore} /> : null}
      </div>

      {/* Pagination (desktop). Phones load more instead. */}
      {!loadMore && totalPages > 1 && (
        <nav
          aria-label="People pages"
          className="flex shrink-0 items-center justify-between border-t border-border bg-bg-subtle/40 px-4 py-2"
        >
          <button
            type="button"
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Previous page"
          >
            <ChevronLeft size={14} aria-hidden />
          </button>
          <span className="text-[11px] font-medium text-text-tertiary">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Next page"
          >
            <ChevronRight size={14} aria-hidden />
          </button>
        </nav>
      )}
    </div>
  );
}
