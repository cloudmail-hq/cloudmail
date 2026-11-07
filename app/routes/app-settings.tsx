// App Settings Page.
//
// Every section here is backed by real storage. Theme is per-device in
// `localStorage` so it can be applied before first paint; auto-draft is per
// mailbox; branding, notifications and display preferences are instance-wide R2
// records. Notifications and display preferences used to hold local state with
// `setTimeout` fakes behind a "not saved yet" badge — they are now bound to
// `PUT /api/v1/preferences` and each one changes something the reader can see.

import {
  BadgeCheck,
  Ban,
  Bell,
  Bot,
  Cloud,
  Contrast,
  Cpu,
  Eye,
  Globe,
  Inbox,
  KeyRound,
  Package,
  Palette,
  ScrollText,
  Send,
  Shield,
  Sparkles,
  UserCog,
  Users,
  Webhook,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import DashboardLayout from "~/components/DashboardLayout";
import { ThemePicker } from "~/components/ThemeToggle";
import { Switch } from "~/components/ui/switch";
import { useDashboardUser } from "~/queries/people";
import AutoDraftSettings from "~/components/AutoDraftSettings";
import AppBrandingSettings from "~/components/settings/AppBrandingSettings";
import AccessSettings from "~/components/settings/AccessSettings";
import AccessLog from "~/components/settings/AccessLog";
import AccountSettings from "~/components/settings/AccountSettings";
import UsersSettings from "~/components/settings/UsersSettings";
import DomainsSettings from "~/components/settings/DomainsSettings";
import CloudflareSettings from "~/components/settings/CloudflareSettings";
import LicenceSettings from "~/components/settings/LicenceSettings";
import ProductsSettings from "~/components/settings/ProductsSettings";
import SuppressionsSettings from "~/components/settings/SuppressionsSettings";
import PrivacySettingsSection from "~/components/settings/PrivacySettings";
import WebhooksSettings from "~/components/settings/WebhooksSettings";
import AgentInboxesSettings from "~/components/settings/AgentInboxesSettings";
import AiProvidersSettings from "~/components/settings/AiProvidersSettings";
import { SaveStatus } from "~/components/settings/settings-ui";
import AssistantSettings from "~/components/settings/AssistantSettings";
import NotificationSettings from "~/components/settings/NotificationSettings";
import { useCurrentUser } from "~/queries/people";
import {
	usePreferences,
	useUpdatePreferences,
} from "~/queries/preferences";
import { useDesktopNotify } from "~/hooks/useDesktopNotify";
import { playNewMailChime } from "~/lib/notification-sound";
import { showToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import type { Density, ReadingPanePosition } from "~/services/api";
import { SettingsLayout } from "~/components/settings/SettingsLayout";
import {
  resolveSection,
  sectionForLegacyHash,
  visibleSections,
  type SettingsSectionId,
} from "../../shared/settings-sections";

/**
 * `/settings/:section`. One section per page, each with one save model (see
 * `shared/settings-sections.ts`). `/settings` and the old `/settings#hash`
 * links redirect to the matching section.
 */
export default function AppSettingsPage() {
  const user = useDashboardUser();
  const { section } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  // Admin-only sections stay hidden until the identity resolves, rather than
  // flashing controls the user may turn out not to have.
  const isAdmin = user?.role === "admin";
  const { data: me } = useCurrentUser();
  const passwordMode = me?.authMode === "password";
  const managesSomeMailbox =
    me?.capabilities === null ||
    (me?.capabilities ?? []).some((entry) => entry.capabilities.includes("manageSettings"));

  const visible = useMemo(
    () => visibleSections({ isAdmin, passwordMode, managesSomeMailbox }),
    [isAdmin, passwordMode, managesSomeMailbox],
  );

  // `/settings#domains` from the single-page days, or a bare `/settings`.
  useEffect(() => {
    if (section) return;
    const legacy = sectionForLegacyHash(location.hash);
    if (legacy) navigate(`/settings/${legacy}${location.search}`, { replace: true });
  }, [section, location.hash, location.search, navigate]);

  // A section added without an icon still renders, just without one.
  const icons: Partial<Record<SettingsSectionId, React.ElementType>> = {
    account: KeyRound,
    preferences: Contrast,
    notifications: Bell,
    "auto-draft": Sparkles,
    users: Users,
    domains: Globe,
    cloudflare: Cloud,
    licence: BadgeCheck,
    access: UserCog,
    "access-log": ScrollText,
    webhooks: Webhook,
    branding: Palette,
    sending: Send,
    suppressions: Ban,
    assistant: Bot,
    products: Package,
    privacy: Shield,
    "agent-inboxes": Inbox,
    "ai-providers": Cpu,
  };

  const content: Record<SettingsSectionId, React.ReactNode> = {
    account: <AccountSettings />,
    preferences: <PreferencesSection isAdmin={isAdmin} />,
    notifications: <NotificationSettings />,
    "auto-draft": <AutoDraftSettings />,
    assistant: <AssistantSettings isAdmin={isAdmin} />,
    users: <UsersSettings />,
    domains: <DomainsSettings />,
    cloudflare: <CloudflareSettings />,
    licence: <LicenceSettings />,
    products: <ProductsSettings />,
    access: <AccessSettings />,
    "access-log": <AccessLog enabled={isAdmin} />,
    webhooks: <WebhooksSettings isAdmin={isAdmin} />,
    "agent-inboxes": <AgentInboxesSettings />,
    "ai-providers": <AiProvidersSettings />,
    branding: <AppBrandingSettings />,
    sending: <SendingSection />,
    suppressions: <SuppressionsSettings />,
    privacy: <PrivacySettingsSection />,
  };

  // Wait for the identity before resolving: until then only the
  // everyone-sections exist and a deep link to an admin page would bounce.
  const ready = !!me;
  const current = resolveSection(section, visible);
  if (ready && !section && !sectionForLegacyHash(location.hash) && current) {
    return <Navigate to={`/settings/${current.id}${location.search}`} replace />;
  }
  if (ready && section && current && current.id !== section) {
    return <Navigate to={`/settings/${current.id}`} replace />;
  }

  return (
    <DashboardLayout>
      {ready && current ? (
        <SettingsLayout
          basePath="/settings"
          active={current.id}
          items={visible.map((s) => ({ id: s.id, label: s.label, icon: icons[s.id], content: content[s.id] }))}
        />
      ) : (
        // The same frame as the loaded page: a pane where the pane will be.
        <div aria-busy="true" aria-label="Loading settings" className="flex w-full">
          <div className="hidden h-[calc(100dvh-var(--app-topbar-h))] w-[208px] shrink-0 space-y-2 border-r border-border bg-card px-2 pt-12 md:block">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-8 animate-pulse rounded-[6px] bg-bg-muted" />
            ))}
          </div>
          <div className="mx-auto w-full max-w-[1120px] px-4 py-6 md:px-8 md:py-8">
            <div className="h-64 max-w-3xl animate-pulse rounded-[8px] bg-bg-muted/60" />
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

/** Shared by the autosave preference pages: write, roll back and say so on failure. */
function usePreferenceSaver() {
  const updatePreferences = useUpdatePreferences();
  const save = (patch: Parameters<typeof updatePreferences.mutate>[0]) => {
    updatePreferences.mutate(patch, {
      onError: () =>
        showToast({
          kind: "error",
          message: "Could not save that preference.",
          description: "Your change has been rolled back. Try again.",
        }),
    });
  };
  return { save, status: updatePreferences.status };
}

/** Page heading for the autosave pages, with the one save status beside it. */
function AutosaveHeading({
  icon: Icon,
  title,
  status,
}: {
  icon: React.ElementType;
  title: string;
  status: "idle" | "pending" | "success" | "error";
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon size={14} className="text-text-tertiary" aria-hidden />
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      <SaveStatus status={status} className="ml-auto" />
    </div>
  );
}

/* ----------------------------------- Appearance --------------------------------- */
/**
 * Theme choice.
 *
 * Stored in `localStorage` rather than on the server, so it applies per device.
 * That is the behaviour people expect from a theme — a laptop in a bright office
 * and a phone in bed want different answers — and it is what lets the preference
 * be applied before first paint, with no round trip to flash through.
 */
function AppearanceCard() {
  return (
    <div className="space-y-3">
      <div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-text-primary">Theme</h3>
            <p className="mt-1 text-sm text-text-secondary">
              <span className="font-medium">System</span> follows your operating
              system and updates as it changes. Saved on this device.
            </p>
          </div>
          <ThemePicker />
        </div>

        <p className="mt-4 text-sm text-text-tertiary">
          Messages that specify their own colours keep them, so newsletters and
          other richly styled mail still render the way the sender intended.
        </p>
      </div>
    </div>
  );
}

/**
 * Appearance & display: theme (this device) and how mail is laid out
 * (deployment-wide, admin only). Every control saves as it changes.
 */
function PreferencesSection({ isAdmin }: { isAdmin: boolean }) {
  const { save, status } = usePreferenceSaver();
  return (
    <section className="space-y-6">
      <AutosaveHeading icon={Contrast} title="Appearance & display" status={status} />
      <AppearanceCard />
      {isAdmin ? <DisplayPreferencesSection save={save} /> : null}
      <p className="text-sm text-text-tertiary">Changes on this page save as you make them.</p>
    </section>
  );
}

/* ------------------------------- Shared building blocks ------------------------- */
/**
 * One labelled switch row.
 *
 * Extracted because there are seven of them below and the label/description/
 * control geometry has to stay identical: a row that drifts by a few pixels in
 * one section is exactly the sort of thing nobody notices until it ships.
 */
function ToggleRow({
  title,
  description,
  checked,
  onChange,
  busy,
  disabled,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 p-5">
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-text-primary">{title}</h3>
        <p className="mt-1 text-sm text-text-secondary">
          {description}
        </p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        busy={busy}
        disabled={disabled}
        aria-label={title}
      />
    </div>
  );
}

/**
 * A segmented choice between a small fixed set of options.
 *
 * Radio semantics via `role="radiogroup"`, not a `<select>`: each option carries
 * a one-line explanation of what it does, which a native select cannot show.
 */
function SegmentedChoice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; hint: string }[];
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex items-baseline gap-2 rounded-[6px] border px-3 py-2 text-left transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/60",
              active
                ? "border-violet bg-violet/[0.07]"
                : "border-border hover:bg-bg-subtle/70",
              disabled && "cursor-not-allowed opacity-60",
            )}
          >
            <span
              className={cn(
                "text-xs font-semibold",
                active ? "text-text-primary" : "text-text-secondary",
              )}
            >
              {option.label}
            </span>
            <span className="text-xs text-text-tertiary">
              {option.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const DENSITY_OPTIONS: { value: Density; label: string; hint: string }[] = [
  { value: "comfortable", label: "Comfortable", hint: "Roomy rows, easiest to scan" },
  { value: "cozy", label: "Cozy", hint: "The default balance" },
  { value: "compact", label: "Compact", hint: "Most messages per screen" },
];

const READING_PANE_OPTIONS: {
  value: ReadingPanePosition;
  label: string;
  hint: string;
}[] = [
  { value: "right", label: "Right", hint: "List beside the message" },
  { value: "bottom", label: "Bottom", hint: "List above the message" },
  { value: "off", label: "No pane", hint: "Opening a message fills the width" },
];

/**
 * The offered undo windows.
 *
 * A fixed set rather than a free number field: this is a "how careful do you want
 * to be" choice, not a measurement, and every value here is inside the range the
 * API accepts (5–120s) so no option can be saved and then rejected. Values are
 * strings because `SegmentedChoice` is keyed on a string union; the caller
 * converts before saving.
 */
const UNDO_WINDOW_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "10", label: "10 seconds", hint: "Barely a pause" },
  { value: "30", label: "30 seconds", hint: "The default" },
  { value: "60", label: "60 seconds", hint: "Time to reread it" },
];


type SavePreferences = ReturnType<typeof usePreferenceSaver>["save"];

/* --------------------------------- Notifications -------------------------------- */
/**
 * New-mail alerts, backed by the shared preferences record.
 *
 * `desktop` is the gate the poller in `useMailboxLiveUpdates` reads. Turning it on
 * here also asks the browser for permission, which has to happen inside this
 * click: browsers reject a permission prompt that is not tied to a user gesture.
 * If permission is refused the preference is left off rather than saved as an on
 * switch that can never fire.
 */
function NotificationsCard({ save }: { save: SavePreferences }) {
  const { data: preferences, isLoading } = usePreferences();
  const notifications = preferences?.notifications;

  // The on/off switch is per user per browser and reflects real permission;
  // the two refinements below stay in the shared record.
  const desktopNotify = useDesktopNotify();
  const desktopOn = desktopNotify.state === "on";

  const toggleDesktop = async (next: boolean) => {
    if (!next) {
      desktopNotify.disable();
      return;
    }
    await desktopNotify.enable();
  };

  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Bell size={14} className="text-text-tertiary" aria-hidden />
        Notifications
      </h3>

      <div className="divide-y divide-border/60 rounded-[8px] bg-card ring-1 ring-border">
        <ToggleRow
          title="Desktop notifications"
          description="Show a browser notification when new mail arrives while this tab is in the background."
          checked={desktopOn}
          onChange={(next) => void toggleDesktop(next)}
          disabled={desktopNotify.state === "unsupported"}
        />

        {/* Disabled rather than hidden while alerts are off, so the options stay discoverable. */}
        <ToggleRow
          title="Only important mail"
          description="Notify only for messages the sender flagged high priority."
          checked={notifications?.onlyImportant ?? false}
          onChange={(next) => save({ notifications: { onlyImportant: next } })}
          disabled={isLoading || !desktopOn}
        />

        <ToggleRow
          title="Play a sound"
          description="Sound a short tone alongside the notification."
          checked={notifications?.playSound ?? false}
          onChange={(next) => {
            // Played from this click: WebAudio needs a gesture to start.
            if (next) void playNewMailChime();
            save({ notifications: { playSound: next } });
          }}
          disabled={isLoading || !desktopOn}
        />
      </div>

      <p className="text-sm text-text-tertiary">
        {desktopNotify.state === "blocked"
          ? "This browser has blocked notifications for this site. Allow them in the browser's site settings, then turn this on."
          : desktopNotify.state === "needs-permission"
            ? "Turn this on to let this browser ask for permission."
            : "Desktop notifications are saved for you on this browser only. Sound and importance apply to everyone on this deployment."}
      </p>
    </div>
  );
}

/* ------------------------------ Display preferences ----------------------------- */
/**
 * How mail is laid out, backed by the shared preferences record. Density and
 * preview text drive the row geometry in `MailList`, the reading-pane position
 * relayouts `MailWorkspace`, and hiding signatures strips the signature block
 * from the bodies `MessageCard` renders.
 */
function DisplayPreferencesSection({ save }: { save: SavePreferences }) {
  const { data: preferences, isLoading } = usePreferences();
  const display = preferences?.display;

  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Eye size={14} className="text-text-tertiary" aria-hidden />
        Mail layout
        <span className="font-normal text-text-tertiary">· everyone on this deployment</span>
      </h3>

      <div className="divide-y divide-border/60 rounded-[8px] bg-card ring-1 ring-border">
        <div className="space-y-3 p-5">
          <div>
            <h4 className="text-sm font-medium text-text-primary">List density</h4>
            <p className="mt-1 text-sm text-text-secondary">
              How much room each conversation takes in the message list.
            </p>
          </div>
          <SegmentedChoice
            label="List density"
            value={display?.density ?? "cozy"}
            options={DENSITY_OPTIONS}
            onChange={(density) => save({ display: { density } })}
            disabled={isLoading}
          />
        </div>

        <div className="space-y-3 p-5">
          <div>
            <h4 className="text-sm font-medium text-text-primary">Reading pane</h4>
            <p className="mt-1 text-sm text-text-secondary">
              Where the open message sits relative to the list. On narrow screens
              the message always takes the full width.
            </p>
          </div>
          <SegmentedChoice
            label="Reading pane position"
            value={display?.readingPanePosition ?? "right"}
            options={READING_PANE_OPTIONS}
            onChange={(readingPanePosition) =>
              save({ display: { readingPanePosition } })
            }
            disabled={isLoading}
          />
        </div>

        <ToggleRow
          title="Remove tracking from links"
          description="Strip utm_, fbclid, gclid, mc_eid and similar parameters from links in mail you receive. They tell the site who clicked and do nothing for you."
          checked={display?.cleanTrackingLinks ?? true}
          onChange={(cleanTrackingLinks) => save({ display: { cleanTrackingLinks } })}
          disabled={isLoading}
        />

        <ToggleRow
          title="Preview text"
          description="Show the first line of each message under its subject in the list."
          checked={display?.previewText ?? true}
          onChange={(previewText) => save({ display: { previewText } })}
          disabled={isLoading}
        />

        <ToggleRow
          title="Hide signatures"
          description="Strip the signature block from message bodies in the reading pane to keep threads short."
          checked={display?.hideSignaturesInChat ?? false}
          onChange={(hideSignaturesInChat) =>
            save({ display: { hideSignaturesInChat } })
          }
          disabled={isLoading}
        />
      </div>
    </div>
  );
}

/* ------------------------------- Sending ---------------------------------- */
/**
 * Sending & notifications. The send delay (off is a real choice: with it
 * disabled a send goes straight to the provider and no undo card appears) and
 * new-mail alerts. Every control saves as it changes.
 */
function SendingSection() {
  const { data: preferences, isLoading } = usePreferences();
  const { save, status } = usePreferenceSaver();
  const sending = preferences?.sending;
  const enabled = sending?.undoWindowEnabled ?? true;

  return (
    <section className="space-y-6">
      <AutosaveHeading icon={Send} title="Sending & notifications" status={status} />

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Undo send</h3>
        <div className="divide-y divide-border/60 rounded-[8px] bg-card ring-1 ring-border">
          <ToggleRow
            title="Delay sending"
            description="Hold each message briefly so you can pull it back. Turn this off to send immediately, with no undo."
            checked={enabled}
            onChange={(undoWindowEnabled) =>
              save({ sending: { undoWindowEnabled } })
            }
            disabled={isLoading}
          />

          <div className="space-y-3 p-5">
            <div>
              <h4 className="text-sm font-medium text-text-primary">How long to wait</h4>
              <p className="mt-1 text-sm text-text-secondary">
                The window stays open even if you close the tab. The message waits
                on the server, not in this browser.
              </p>
            </div>
            <SegmentedChoice
              label="Undo window length"
              value={String(sending?.undoWindowSeconds ?? 30)}
              options={UNDO_WINDOW_OPTIONS}
              onChange={(seconds) =>
                save({ sending: { undoWindowSeconds: Number(seconds) } })
              }
              disabled={isLoading || !enabled}
            />
          </div>
        </div>
        <p className="text-sm text-text-tertiary">
          While a message is waiting you can send it immediately, or pull it back
          into Drafts, from the notification that appears after sending.
        </p>
      </div>

      <NotificationsCard save={save} />
    </section>
  );
}
