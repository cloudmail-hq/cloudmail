// Person-centric inbox: SaaSMail's UI over the agentic inbox's real data.
//
// People are aggregated across every mailbox this deployment serves, so search,
// filters, sorting and pagination are all resolved server-side by
// GET /api/v1/people. The client holds one page at a time and cannot correctly
// filter or sort what it has not fetched.

import { useState, useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";
import { ArrowLeft, AlertTriangle, Users } from "lucide-react";
import DashboardLayout from "~/components/DashboardLayout";
import PersonList from "~/components/PersonList";
import PersonDetail from "~/components/PersonDetail";
import InboxToolbar, {
  type InboxFilters,
  type InboxView,
  type InboxSortSpec,
} from "~/components/InboxToolbar";
import { LazyComposer, preloadAgentPanelWhenIdle } from "~/components/lazy";
import { ModuleBar } from "~/components/ModuleBar";
import { useMailboxes } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";
import { useZoneStore } from "~/hooks/useZoneStore";
import { useCurrentUser, useMarkPersonRead, usePeople, usePeopleInfinite } from "~/queries/people";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { flattenPages } from "../../shared/paged-list";
import { cn } from "~/lib/utils";
import type { GroupedPerson } from "../../shared/people";

const PEOPLE_PAGE_SIZE = 40;

export default function EnhancedInboxPage() {
  const [selectedPerson, setSelectedPerson] = useState<GroupedPerson | null>(
    null
  );
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<InboxFilters>({});
  const [search, setSearch] = useState("");
  const [view, setView] = useState<InboxView>("list");
  const [sortSpec, setSortSpec] = useState<InboxSortSpec>({
    key: "recency",
    direction: "desc",
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Compose is shared with the mail workspace, so a message started here has
  // the same rich text, attachments, scheduling and undo-send behaviour.
  const { isComposing, startCompose } = useUIStore();

  const { data: currentUser } = useCurrentUser();
  // Scoped to the selected domain like the rest of the app. This view spans
  // mailboxes, so it has to nominate one to send from, and offering mailboxes
  // from a domain the user has filtered out was the wrong default.
  const { selectedZone } = useZoneStore();
  const { data: mailboxes = [] } = useMailboxes(selectedZone?.domain);
  const markPersonRead = useMarkPersonRead();

  /*
    `?person=<email>` opens that correspondent, which is how the command
    palette jumps to someone. Searched for rather than read from the current
    page, which may not include them.
  */
  const [searchParams, setSearchParams] = useSearchParams();
  const personParam = searchParams.get("person");
  const { data: personLookup } = usePeople(
    { search: personParam ?? "", pageSize: 5 },
    { enabled: !!personParam },
  );
  useEffect(() => {
    if (!personParam || !personLookup) return;
    const wanted = personParam.toLowerCase();
    const match = personLookup.people.find((p) => p.email.toLowerCase() === wanted);
    if (match) setSelectedPerson(match);
    const next = new URLSearchParams(searchParams);
    next.delete("person");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personParam, personLookup]);

  // Phones scroll one growing list ("load more"); desktop keeps pages.
  const isMobile = useIsMobile();
  const peopleQuery = {
    pageSize: PEOPLE_PAGE_SIZE,
    search: search.trim() || undefined,
    unread: filters.unread,
    hasAttachment: filters.hasAttachment,
    recipient: filters.recipient,
    sortKey: sortSpec.key,
    sortDirection: sortSpec.direction,
  };
  const paged = usePeople({ ...peopleQuery, page }, { enabled: !isMobile });
  const infinite = usePeopleInfinite(peopleQuery, { enabled: isMobile });

  const active = isMobile ? infinite : paged;
  const { isLoading, isFetching, error, refetch } = active;
  const infinitePages = infinite.data?.pages ?? [];
  const people = isMobile
    ? flattenPages(
        infinitePages.map((p) => p.people),
        (p) => p.id,
      )
    : (paged.data?.people ?? []);
  const lastPage = isMobile ? infinitePages[infinitePages.length - 1] : paged.data;
  const total = lastPage?.total ?? 0;
  const degraded = lastPage?.degraded ?? [];
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = infinite;
  const loadMore = useMemo(
    () =>
      isMobile
        ? {
            hasMore: Boolean(hasNextPage),
            loading: isFetchingNextPage,
            onLoadMore: () => void fetchNextPage(),
          }
        : undefined,
    [isMobile, hasNextPage, isFetchingNextPage, fetchNextPage],
  );

  /** Our own mailbox addresses — the "from" identities for compose and filters. */
  const inboxes = useMemo(
    () =>
      mailboxes.map((m) => ({
        email: m.email,
        displayName: m.settings?.fromName ?? m.name ?? null,
      })),
    [mailboxes]
  );


  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const handleMarkPersonRead = useCallback(
    (id: string) => {
      // `id` is the person's address; the mutation invalidates the people list.
      markPersonRead.mutate(id);
    },
    [markPersonRead]
  );

  const handleRefresh = useCallback(() => refetch(), [refetch]);

  // Reset to the first page whenever the result set changes shape, otherwise a
  // narrower filter can leave the user stranded on a page that no longer exists.
  const handleFiltersChange = useCallback((next: InboxFilters) => {
    setFilters(next);
    setPage(1);
  }, []);

  const handleSearchChange = useCallback((next: string) => {
    setSearch(next);
    setPage(1);
  }, []);

  const handleSortChange = useCallback((next: InboxSortSpec) => {
    setSortSpec(next);
    setPage(1);
  }, []);

  const user = currentUser
    ? {
        name: currentUser.name,
        email: currentUser.email ?? undefined,
        role: currentUser.role,
      }
    : null;

  /**
   * Which mailbox a message composed here is sent from.
   *
   * The People view spans every mailbox, so it nominates one: the inbox that
   * last corresponded with this person when we know it, otherwise the first
   * configured mailbox.
   */
  const composeMailboxId = useMemo(() => {
    if (mailboxes.length === 0) return null;
    const preferred = selectedPerson?.recipients?.[0];
    const match = preferred
      ? mailboxes.find(
          (m) => m.email.toLowerCase() === preferred.toLowerCase(),
        )
      : undefined;
    return (match ?? mailboxes[0]).id;
  }, [mailboxes, selectedPerson]);

  // Composer and agent panel are code-split; fetch them after first paint.
  useEffect(() => preloadAgentPanelWhenIdle({ alsoComposer: true }), []);

  const openCompose = useCallback(() => {
    startCompose({
      mode: "new",
      prefill: selectedPerson ? { to: selectedPerson.email } : undefined,
    });
  }, [selectedPerson, startCompose]);

  const banner = error ? (
    <div className="mx-3 mt-2 rounded-[8px] border border-destructive/50 bg-destructive/10 px-3 py-2 md:mx-4">
      <p className="text-xs text-destructive">
        {error instanceof Error ? error.message : "Could not load people."}
      </p>
    </div>
  ) : degraded.length > 0 ? (
    <div className="mx-3 mt-2 flex items-start gap-1.5 rounded-[8px] border border-amber-300/60 bg-amber-50/80 px-3 py-2 md:mx-4 dark:bg-amber-500/10">
      <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" />
      <p className="text-xs text-amber-700 dark:text-amber-500">
        Some mailboxes did not respond, so this list may be incomplete:{" "}
        {degraded.join(", ")}
      </p>
    </div>
  ) : null;

  const personList = (
    <PersonList
      items={people}
      // Only the first load, not background refetches. PersonList replaces the
      // whole list with skeleton rows, so passing `isFetching` here would
      // blank the list on every refetch and defeat `placeholderData`.
      loading={isLoading}
      total={total}
      pageSize={PEOPLE_PAGE_SIZE}
      page={page}
      onPageChange={setPage}
      selectedPersonId={selectedPerson?.id ?? null}
      onSelectPerson={setSelectedPerson}
      isAdmin={currentUser?.role === "admin"}
      selectedIds={selectedIds}
      onToggleSelected={toggleSelected}
      onMarkPersonRead={handleMarkPersonRead}
      loadMore={loadMore}
      // No list-level refresh: the toolbar above has one, and two buttons
      // doing the same thing a few hundred pixels apart read as different.
    />
  );

  return (
    <DashboardLayout fillViewport>
      {/*
        A workspace like Mail: full width, flush under the bar, with the panes
        dividing the window. It was a 1600px inset card sized by a
        \`calc(100vh-7rem)\` guess at the chrome above it.
      */}
      <div className="flex min-h-0 w-full flex-1 flex-col">
        {/* Phone: the same module bar every page has; the title for desktop's outline. */}
        <ModuleBar label="People" navLabel="People" icon={Users} />
        <h1 className="sr-only hidden md:block">People</h1>
        {!(view === "table" && selectedPerson) && (
          <div className={selectedPerson ? "hidden sm:block" : undefined}>
            {banner}
            <div className="border-b border-border bg-card px-3 py-2 md:px-4">
              <InboxToolbar
                filters={filters}
                onFiltersChange={handleFiltersChange}
                inboxes={inboxes}
                search={search}
                onSearchChange={handleSearchChange}
                view={view}
                onViewChange={(v) => {
                  setView(v);
                  setSelectedPerson(null);
                  clearSelection();
                }}
                sortSpec={sortSpec}
                onSortChange={handleSortChange}
                onRefresh={handleRefresh}
                refreshing={isFetching}
                onCompose={openCompose}
              />
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
          {view === "table" ? (
            selectedPerson ? (
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex shrink-0 items-center gap-3 border-b border-border bg-bg-subtle/60 px-4 py-2">
                  <button
                    onClick={() => setSelectedPerson(null)}
                    className="inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                  >
                    <ArrowLeft size={13} />
                    Back to all
                  </button>
                  <span className="text-xs text-text-tertiary">
                    Viewing {selectedPerson.name || selectedPerson.email}
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <PersonDetail
                    person={selectedPerson}
                    onBack={() => setSelectedPerson(null)}
                  />
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 overflow-hidden bg-card">
                {personList}
              </div>
            )
          ) : (
            <div className="flex h-full min-h-0">
              <div
                className={cn(
                  "relative w-full shrink-0 border-r border-border bg-card md:w-[340px]",
                  selectedPerson ? "hidden md:block" : "block"
                )}
              >
                {personList}
              </div>

              <div
                className={cn(
                  "min-w-0 flex-1 bg-card",
                  selectedPerson ? "block" : "hidden md:block"
                )}
              >
                {selectedPerson ? (
                  <PersonDetail
                    person={selectedPerson}
                    onBack={() => setSelectedPerson(null)}
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
                    <span
                      className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-subtle text-accent-subtle-fg"
                      aria-hidden
                    >
                      <Users size={20} />
                    </span>
                    <p className="text-base font-semibold text-text-primary">
                      Pick someone
                    </p>
                    <p className="max-w-[300px] text-sm text-text-secondary">
                      Everything you and they have sent each other, across every
                      mailbox, in one place.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setView("table");
                        setSelectedPerson(null);
                        clearSelection();
                      }}
                      className="mt-1 text-sm font-medium text-accent hover:underline"
                    >
                      Or see everyone in a table
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {isComposing && composeMailboxId && (
        <LazyComposer mailboxId={composeMailboxId} />
      )}
    </DashboardLayout>
  );
}
