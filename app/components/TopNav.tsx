import { Link, useNavigate } from "react-router";
import {
  Bell,
  BellOff,
  Check,
  Command,
  Globe,
  Inbox as InboxIcon,
  LogOut,
  Moon,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Sun,
  User,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { AppSectionNav } from "~/components/AppNav";
import { BrandMark } from "~/components/ui/brand-mark";
import GlobalSearch from "~/components/GlobalSearch";
import { ThemeToggleButton } from "~/components/ThemeToggle";
import { useDesktopNotify } from "~/hooks/useDesktopNotify";
import { useCommandPaletteStore } from "~/hooks/useCommandPaletteStore";
import { useThemeStore } from "~/hooks/useThemeStore";
import { useZoneStore } from "~/hooks/useZoneStore";
import { showToast } from "~/lib/toast";
import { cn } from "~/lib/utils";

interface Zone {
  id: string;
  domain: string;
  name: string;
  zoneId?: string;
}

interface TopNavProps {
  brandName?: string;
  /** Uploaded logo, or null/undefined to fall back to the built-in mail glyph. */
  logoUrl?: string | null;
  /** Hex colour for the built-in glyph. Ignored when a logo is set. */
  accentColor?: string;
  onSignOut?: () => void;
  user?: {
    name?: string;
    email?: string;
    role?: string;
  } | null;
  onToggleAgent: () => void;
  agentOpen: boolean;
  zones?: Zone[];
  /** Where the brand goes: Mail, as in Outlook. */
  brandHref?: string;
  /** Inbox unread across readable mailboxes, for the Mail link's badge; see `totalUnread`. */
  unread?: number;
  /** Last mailbox opened on this device, where the Mail link goes. */
  lastMailboxId?: string | null;
}

/** "Ada Lovelace" → "AL", "ada@example.com" → "A". */
function initialsOf(nameOrEmail?: string): string {
  if (!nameOrEmail) return "";
  const base = nameOrEmail.includes("@") ? nameOrEmail.split("@")[0] : nameOrEmail;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "";
  if (!nameOrEmail.includes("@") && words.length > 1) {
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  return words[0][0].toUpperCase();
}

/** Square icon button for the bar: 32px with a mouse, 44px under a finger. */
const ICON_BUTTON =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-text-secondary transition-colors duration-150 hover:bg-bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:h-11 touch:w-11";

/** The new-mail notification switch, with a label that says what it will do. */
function useNotifyToggle() {
  const desktopNotify = useDesktopNotify();
  const on = desktopNotify.state === "on";
  const label =
    desktopNotify.state === "on"
      ? "New-mail notifications on"
      : desktopNotify.state === "needs-permission"
        ? "Allow notifications in this browser"
        : desktopNotify.state === "blocked"
          ? "Notifications blocked in this browser"
          : desktopNotify.state === "unsupported"
            ? "This browser can't show notifications"
            : "Notify me about new mail";
  const toggle = async () => {
    if (on) {
      desktopNotify.disable();
      return;
    }
    if (desktopNotify.state === "unsupported") return;
    if (desktopNotify.state === "blocked") {
      showToast({
        kind: "warning",
        message: "Notifications are blocked for this site.",
        description: "Allow them in your browser settings to be told about new mail.",
      });
      return;
    }
    // Asked from the click: browsers reject a prompt not tied to a gesture.
    await desktopNotify.enable();
  };
  return { on, label, toggle, blocked: desktopNotify.state === "blocked" };
}

/**
 * The app's top bar. The same controls in the same order on every page:
 *
 *   brand · sections · search · notifications · agent · theme · account   (md and up)
 *   brand · search · agent · account                           (phone)
 *
 * Nothing here is supplied by a page. Page-specific actions (mailbox
 * settings, folder tools, analytics filters) live in the page's own toolbar,
 * so moving between modules never changes the bar. It is mounted once by
 * `AppShell`, which keeps it in place across navigations.
 *
 * Height comes from `--app-topbar-h` (see index.css), which every page frame
 * offsets by, so the bar cannot be resized by what is under it.
 */
export default function TopNav({
  brandName = "cloudmail",
  logoUrl,
  accentColor = "#4F46E5",
  onSignOut,
  user,
  onToggleAgent,
  agentOpen,
  zones = [],
  brandHref = "/",
  unread = 0,
  lastMailboxId = null,
}: TopNavProps) {
  const navigate = useNavigate();
  const { selectedZone, setSelectedZone } = useZoneStore();
  const openPalette = useCommandPaletteStore((state) => state.open);
  const notify = useNotifyToggle();
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const isAdmin = user?.role === "admin";

  return (
    <header
      data-app-topbar
      className="pt-safe px-safe fixed inset-x-0 top-0 z-50 h-[var(--app-topbar-h)] border-b border-border bg-card"
    >
      {/* 16px phone gutter, the same as the page content's. */}
      <div className="flex h-full items-center gap-1 pl-4 pr-2 md:gap-2 md:pl-0 md:pr-3">
        {/*
          Brand. From `md` it is as wide as the 208px folder / module pane
          below it, so the section links and search start over the content.
        */}
        <Link
          to={brandHref}
          aria-label={brandName}
          className="flex shrink-0 items-center gap-2 text-[15px] font-semibold tracking-tight text-text-primary transition-opacity duration-150 hover:opacity-80 md:w-[208px] md:pl-4 touch:min-h-11"
        >
          {logoUrl ? (
            /*
              An uploaded logo is drawn to read on the light theme's white bar,
              and nothing says it reads on a near-black one: a dark wordmark all
              but disappears there. So in dark mode it sits on a small plate in
              the foreground token (near-white in dark), which gives it the
              surface it was made for. Border-box, so the plate stays inside the
              same 120px. Light mode is unchanged.
            */
            <img
              src={logoUrl}
              alt=""
              className="h-6 w-auto max-w-[120px] object-contain md:h-7 dark:rounded-[6px] dark:bg-foreground dark:px-1.5 dark:py-0.5"
            />
          ) : (
            /* No uploaded logo: the cloudmail mark, which carries its own light and dark colours. */
            <BrandMark className="h-7 w-7" />
          )}
          {/* The glyph alone on a phone; the name is on the aria-label. */}
          <span className="hidden truncate md:inline">{brandName}</span>
        </Link>

        {/* Mail, People, Templates, Sequences, Analytics (md and up). */}
        <AppSectionNav unread={unread} lastMailboxId={lastMailboxId} />

        {/* Search: the one flexible child, centred and capped at 720px. */}
        <div className="flex min-w-0 flex-1 justify-center">
          <div className="w-full min-w-0 max-w-[720px]">
            <GlobalSearch />
          </div>
        </div>

        {/* Fixed icon set, fixed order. */}
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => void notify.toggle()}
            aria-pressed={notify.on}
            aria-label={notify.label}
            title={notify.label}
            className={cn(ICON_BUTTON, "relative hidden md:flex", notify.on && "text-accent")}
          >
            {/*
              Always the bell, so it reads as a control rather than a status; a
              dot says it is on. The crossed-out bell is kept for a browser that
              has blocked notifications, which is a status worth showing.
            */}
            {notify.blocked ? <BellOff className="h-4 w-4" aria-hidden /> : <Bell className="h-4 w-4" aria-hidden />}
            {notify.on && <span aria-hidden className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent" />}
          </button>

          <button
            type="button"
            onClick={onToggleAgent}
            aria-pressed={agentOpen}
            aria-label="AI agent"
            title="AI agent"
            className={cn(ICON_BUTTON, agentOpen && "bg-accent-subtle text-accent-subtle-fg hover:bg-accent-subtle")}
          >
            <Sparkles className="h-4 w-4 touch:h-5 touch:w-5" aria-hidden />
          </button>

          <ThemeToggleButton className={cn(ICON_BUTTON, "hidden md:flex")} />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={user?.email}
                aria-label={`Account: ${user?.name || user?.email || "User"}`}
                className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-shadow duration-150 hover:ring-2 hover:ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:ml-0 touch:h-11 touch:w-11"
              >
                {/* Initials, like every mainstream client. */}
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-[11px] font-semibold uppercase text-accent-foreground">
                  {initialsOf(user?.name || user?.email) || <User className="h-3.5 w-3.5" aria-hidden />}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <div className="px-2 py-1.5 text-sm">
                <p className="flex items-center gap-2 font-medium text-text-primary">
                  <span className="truncate">{user?.name || "Account"}</span>
                  {isAdmin && (
                    <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] font-medium leading-4 text-text-secondary">
                      Admin
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-text-secondary">{user?.email}</p>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate("/")} className="cursor-pointer">
                <InboxIcon className="h-4 w-4" />
                Mailboxes
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate("/settings")} className="cursor-pointer">
                <SettingsIcon className="h-4 w-4" />
                Settings
              </DropdownMenuItem>
              {/*
                What the phone bar has no room for: the same two switches the
                desktop bar shows as icons, and the palette (no ⌘K on a phone).
              */}
              <div className="md:hidden">
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void notify.toggle()} className="cursor-pointer">
                  {notify.on ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
                  {notify.label}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={toggleTheme} className="cursor-pointer">
                  {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                  {resolvedTheme === "dark" ? "Light theme" : "Dark theme"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => openPalette()} className="cursor-pointer">
                  <Command className="h-4 w-4" />
                  Command palette
                </DropdownMenuItem>
              </div>
              {/* Domain filter, when there is more than one to filter by. */}
              {zones.length > 1 && (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1 text-xs font-medium text-text-tertiary">Domain</div>
                  {[...zones, null].map((zone) => {
                    const on = zone ? selectedZone?.id === zone.id : !selectedZone;
                    return (
                      <DropdownMenuItem
                        key={zone?.id ?? "all"}
                        onClick={() => setSelectedZone(zone)}
                        className="cursor-pointer"
                      >
                        <Globe className="h-4 w-4" />
                        <span className="flex-1 truncate">{zone ? zone.name : "All domains"}</span>
                        {on && <Check className="h-4 w-4 text-accent" />}
                      </DropdownMenuItem>
                    );
                  })}
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild className="cursor-pointer">
                <a href="/privacy" target="_blank" rel="noreferrer">
                  <ShieldCheck className="h-4 w-4" />
                  Privacy notice
                </a>
              </DropdownMenuItem>
              {onSignOut && (
                <DropdownMenuItem
                  onClick={onSignOut}
                  className="cursor-pointer text-red-500 focus:bg-red-500/10 focus:text-red-500"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
