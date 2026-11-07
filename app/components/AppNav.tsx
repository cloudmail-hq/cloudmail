import { memo, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Link, useLocation } from "react-router";
import {
  BarChart3,
  FileText,
  ListOrdered,
  Mail,
  MoreHorizontal,
  PenSquare,
  Settings as SettingsIcon,
  Users,
  X,
} from "lucide-react";
import { composerPreloadProps } from "~/components/lazy";
import {
  type AppModuleId,
  MORE_MODULES,
  NAV_MODULES,
  SETTINGS_MODULE,
  activeModule,
  mailHref,
} from "~/lib/app-nav";
import { cn } from "~/lib/utils";
import { formatBadgeCount } from "shared/folders";

const ICONS: Record<AppModuleId, React.ElementType> = {
  mail: Mail,
  people: Users,
  templates: FileText,
  sequences: ListOrdered,
  analytics: BarChart3,
  settings: SettingsIcon,
};

interface NavProps {
  /** Unread Inbox mail across readable mailboxes; see `totalUnread`. */
  unread: number;
  /** Last mailbox opened on this device, where Mail goes. */
  lastMailboxId: string | null;
}

function hrefFor(id: AppModuleId, path: string, lastMailboxId: string | null) {
  return id === "mail" ? mailHref(lastMailboxId) : path;
}

function Badge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums leading-none text-accent-foreground",
        className,
      )}
    >
      {formatBadgeCount(count)}
    </span>
  );
}

/**
 * The section links in the top bar, from `md`: Mail, People, Templates,
 * Sequences and Analytics. Settings is in the account menu.
 *
 * Icons only below `xl`, icons with labels from there: the labelled row is
 * about 450px wide, which would squeeze search to a sliver under 1280px. The
 * aria-label and title carry the name (and the unread count) at every width.
 * Rendered by `TopNav`, which `AppShell` mounts once, so navigating between
 * pages only moves the `aria-current` marker. Below `md`, `AppTabBar` takes
 * over.
 */
export const AppSectionNav = memo(function AppSectionNav({ unread, lastMailboxId }: NavProps) {
  const { pathname } = useLocation();
  const active = activeModule(pathname);

  return (
    <nav aria-label="App" data-app-sections className="hidden shrink-0 md:mr-2 md:block lg:mr-4">
      <ul className="flex items-center gap-0.5">
        {NAV_MODULES.map(({ id, label, path }) => {
          const Icon = ICONS[id];
          const on = active === id;
          const count = id === "mail" ? unread : 0;
          const name = count > 0 ? `${label}, ${count} unread` : label;
          return (
            <li key={id}>
              <Link
                to={hrefFor(id, path, lastMailboxId)}
                aria-current={on ? "page" : undefined}
                aria-label={name}
                title={name}
                className={cn(
                  "flex h-8 min-w-9 items-center justify-center gap-1.5 rounded-[6px] px-2 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:px-2.5 touch:h-11 touch:min-w-11",
                  on
                    ? // A filled accent tint, flat; stronger in dark so it reads on the near-black bar.
                      "bg-accent/12 text-accent-subtle-fg dark:bg-accent/40 dark:text-white"
                    : "text-text-secondary hover:bg-bg-muted hover:text-text-primary",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={on ? 2.25 : 1.75} aria-hidden />
                <span className="hidden whitespace-nowrap xl:inline">{label}</span>
                {/* Inline, never over the icon: after the icon, or after the label from `xl`. */}
                <Badge count={count} className="dark:bg-white dark:text-accent" />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
});

/**
 * The phone's section nav: a bottom tab bar of five. Mail, People, Analytics,
 * More (Templates, Sequences, Settings) and Compose.
 *
 * Fixed under every page below `md`, with the home-indicator inset. The page
 * frame reserves `--app-tabbar-h` for it, and the reader's own action bar and
 * the composer sit above it (see `AppShell`), so nothing overlaps.
 */
export const AppTabBar = memo(function AppTabBar({
  unread,
  lastMailboxId,
  onCompose,
}: NavProps & { onCompose: () => void }) {
  const { pathname } = useLocation();
  const active = activeModule(pathname);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = active !== null && MORE_MODULES.includes(active);
  const all = [...NAV_MODULES, SETTINGS_MODULE];
  const module = (id: AppModuleId) => all.find((m) => m.id === id)!;

  const tab =
    "relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
  const tone = (on: boolean) => (on ? "text-accent" : "text-text-secondary");

  const link = (id: AppModuleId) => {
    const m = module(id);
    const Icon = ICONS[id];
    const on = active === id;
    const count = id === "mail" ? unread : 0;
    return (
      <Link
        key={id}
        to={hrefFor(id, m.path, lastMailboxId)}
        aria-current={on ? "page" : undefined}
        aria-label={count > 0 ? `${m.label}, ${count} unread` : m.label}
        className={cn(tab, tone(on))}
      >
        {/* A tinted pill behind the active icon, as Outlook and Material draw it. */}
        <span
          className={cn(
            "relative flex h-7 w-12 items-center justify-center rounded-full transition-colors",
            on && "bg-accent/12 dark:bg-accent/30",
          )}
        >
          <Icon className="h-5 w-5" strokeWidth={on ? 2.25 : 1.75} aria-hidden />
          {/* Clear of the icon: anchored at the pill's top-right corner, outside it. */}
          <Badge count={count} className="absolute -right-1.5 -top-1.5 ring-2 ring-card" />
        </span>
        {m.label}
      </Link>
    );
  };

  return (
    <nav
      aria-label="App"
      data-app-tabbar
      className="pb-safe px-safe fixed inset-x-0 bottom-0 z-40 h-[var(--app-tabbar-h)] border-t border-border bg-card md:hidden"
    >
      <div className="flex h-14 items-stretch">
        {link("mail")}
        {link("people")}
        {link("analytics")}
        <DialogPrimitive.Root open={moreOpen} onOpenChange={setMoreOpen}>
          <DialogPrimitive.Trigger asChild>
            <button
              type="button"
              aria-label="More"
              aria-haspopup="dialog"
              className={cn(tab, tone(moreActive))}
            >
              <span
                className={cn(
                  "flex h-7 w-12 items-center justify-center rounded-full transition-colors",
                  moreActive && "bg-accent/12 dark:bg-accent/30",
                )}
              >
                <MoreHorizontal className="h-5 w-5" aria-hidden />
              </span>
              {/* A fixed label: the page's own title says which of the three is open. */}
              More
            </button>
          </DialogPrimitive.Trigger>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-slate-900/40 md:hidden" />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              className="pb-safe fixed inset-x-0 bottom-0 z-[61] rounded-t-[16px] border-t border-border bg-card text-text-primary shadow-lg focus:outline-none md:hidden"
            >
              <div className="flex h-14 items-center justify-between pl-4 pr-2">
                <DialogPrimitive.Title className="text-sm font-semibold">More</DialogPrimitive.Title>
                <DialogPrimitive.Close
                  aria-label="Close"
                  className="flex h-11 w-11 items-center justify-center rounded-[6px] text-text-secondary hover:bg-bg-muted"
                >
                  <X className="h-5 w-5" aria-hidden />
                </DialogPrimitive.Close>
              </div>
              <ul className="px-2 pb-3">
                {MORE_MODULES.map((id) => {
                  const m = module(id);
                  const Icon = ICONS[id];
                  const on = active === id;
                  return (
                    <li key={id}>
                      <Link
                        to={m.path}
                        onClick={() => setMoreOpen(false)}
                        aria-current={on ? "page" : undefined}
                        className={cn(
                          "flex h-12 items-center gap-3 rounded-[8px] px-3 text-[15px] font-medium",
                          on ? "bg-accent-subtle text-accent-subtle-fg" : "text-text-primary hover:bg-bg-muted",
                        )}
                      >
                        <Icon className="h-5 w-5" aria-hidden />
                        {m.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
        <button
          type="button"
          onClick={onCompose}
          {...composerPreloadProps}
          aria-label="Compose"
          // Neutral like the other tabs: a filled pill here read as the active tab.
          className={cn(tab, "text-text-secondary")}
        >
          <span className="flex h-7 w-12 items-center justify-center">
            <PenSquare className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          </span>
          Compose
        </button>
      </div>
    </nav>
  );
});
