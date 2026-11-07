import { useState } from "react";
import {
  Search,
  Filter,
  List,
  Table2,
  RefreshCw,
  Plus,
  ChevronDown,
  X,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";

export type InboxView = "list" | "table";

export type InboxSort = "recency" | "unread" | "inbox" | "attachments";
export type SortDirection = "asc" | "desc";

export interface InboxSortSpec {
  key: InboxSort;
  direction: SortDirection;
}

export interface InboxFilters {
  recipient?: string;
  unread?: boolean;
  hasAttachment?: boolean;
}

interface SenderIdentity {
  email: string;
  displayName: string | null;
}

interface InboxToolbarProps {
  filters: InboxFilters;
  onFiltersChange: (filters: InboxFilters) => void;
  inboxes: SenderIdentity[];
  search: string;
  onSearchChange: (search: string) => void;
  view: InboxView;
  onViewChange: (view: InboxView) => void;
  sortSpec: InboxSortSpec;
  onSortChange: (spec: InboxSortSpec) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  onCompose?: () => void;
}

const SORT_OPTIONS: { key: InboxSort; label: string }[] = [
  { key: "recency", label: "Most recent" },
  { key: "unread", label: "Unread count" },
  { key: "inbox", label: "Inbox" },
  { key: "attachments", label: "Has attachments" },
];

export default function InboxToolbar({
  filters,
  onFiltersChange,
  inboxes,
  search,
  onSearchChange,
  view,
  onViewChange,
  sortSpec,
  onSortChange,
  onRefresh,
  refreshing,
  onCompose,
}: InboxToolbarProps) {
  const [searchFocused, setSearchFocused] = useState(false);

  const activeFilterCount = [
    filters.recipient,
    filters.unread,
    filters.hasAttachment,
  ].filter(Boolean).length;

  const clearFilters = () => {
    onFiltersChange({});
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Search */}
      <div
        className={cn(
          // A full line of its own on a phone; the buttons wrap below it.
          "relative flex min-w-0 flex-1 basis-full items-center transition-all sm:min-w-[200px] sm:basis-auto sm:max-w-[320px]",
          searchFocused && "ring-2 ring-accent/30 rounded-md"
        )}
      >
        <Search
          size={14}
          className="pointer-events-none absolute left-2.5 text-text-tertiary"
        />
        <Input
          type="search"
          aria-label="Filter people"
          placeholder="Filter people…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          className="h-8 pl-8 pr-8 text-sm touch:h-11 touch:pr-11"
        />
        {search && (
          <button
            onClick={() => onSearchChange("")}
            aria-label="Clear search"
            className="absolute right-2 inline-flex items-center justify-center p-0.5 text-text-tertiary hover:text-text-primary touch:right-0"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Filters dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "gap-1.5",
              activeFilterCount > 0 && "text-accent"
            )}
          >
            <Filter size={14} />
            <span className="hidden sm:inline">Filter</span>
            {activeFilterCount > 0 && (
              <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-foreground">
                {activeFilterCount}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {/* Inbox filter */}
          {inboxes.length > 0 && (
            <>
              <DropdownMenuItem disabled className="text-xs font-medium text-text-tertiary">
                Inbox
              </DropdownMenuItem>
              {inboxes.map((inbox) => (
                <DropdownMenuCheckboxItem
                  key={inbox.email}
                  checked={filters.recipient === inbox.email}
                  onCheckedChange={(checked) =>
                    onFiltersChange({
                      ...filters,
                      recipient: checked ? inbox.email : undefined,
                    })
                  }
                >
                  {inbox.displayName || inbox.email.split("@")[0]}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}

          {/* Status filters */}
          <DropdownMenuCheckboxItem
            checked={filters.unread === true}
            onCheckedChange={(checked) =>
              onFiltersChange({
                ...filters,
                unread: checked ? true : undefined,
              })
            }
          >
            Unread only
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={filters.hasAttachment === true}
            onCheckedChange={(checked) =>
              onFiltersChange({
                ...filters,
                hasAttachment: checked ? true : undefined,
              })
            }
          >
            Has attachments
          </DropdownMenuCheckboxItem>

          {activeFilterCount > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={clearFilters} className="text-red-500">
                Clear filters
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Sort dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1.5">
            <span className="hidden text-[13px] sm:inline">
              <span className="text-text-tertiary">Sort: </span>
              {SORT_OPTIONS.find((o) => o.key === sortSpec.key)?.label}
            </span>
            <ChevronDown size={12} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {SORT_OPTIONS.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.key}
              checked={sortSpec.key === option.key}
              onCheckedChange={() =>
                onSortChange({
                  key: option.key,
                  direction:
                    sortSpec.key === option.key
                      ? sortSpec.direction === "asc"
                        ? "desc"
                        : "asc"
                      : "desc",
                })
              }
            >
              {option.label}
              {sortSpec.key === option.key && (
                <span className="ml-auto text-[10px] text-text-tertiary">
                  {sortSpec.direction === "asc" ? "↑" : "↓"}
                </span>
              )}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Spacer */}
      <div className="flex-1" />

      {/* View toggle */}
      <div className="flex items-center rounded-md bg-bg-subtle p-0.5">
        <button
          onClick={() => onViewChange("list")}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded transition-colors",
            view === "list"
              ? "bg-card text-text-primary shadow-sm"
              : "text-text-tertiary hover:text-text-primary"
          )}
          title="List view"
          aria-label="List view"
          aria-pressed={view === "list"}
        >
          <List size={14} />
        </button>
        <button
          onClick={() => onViewChange("table")}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded transition-colors",
            view === "table"
              ? "bg-card text-text-primary shadow-sm"
              : "text-text-tertiary hover:text-text-primary"
          )}
          title="Table view"
          aria-label="Table view"
          aria-pressed={view === "table"}
        >
          <Table2 size={14} />
        </button>
      </div>

      {/* Refresh */}
      {onRefresh && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh people"
          title="Refresh"
          className="h-8 w-8"
        >
          <RefreshCw
            aria-hidden
            size={14}
            className={cn(refreshing && "animate-spin")}
          />
        </Button>
      )}

      {/* Compose button */}
      {onCompose && (
        <Button onClick={onCompose} size="sm" className="gap-1.5">
          <Plus size={14} />
          <span className="hidden sm:inline">Compose</span>
        </Button>
      )}
    </div>
  );
}
