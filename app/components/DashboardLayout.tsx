import DeliverabilityBanner from "~/components/DeliverabilityBanner";
import LicenceBanner from "~/components/licence/LicenceBanner";
import { useUIStore } from "~/hooks/useUIStore";
import { cn } from "~/lib/utils";

interface DashboardLayoutProps {
  children?: React.ReactNode;
  /**
   * Make the page exactly as tall as the viewport and scroll nothing itself.
   *
   * For the mail workspace and People, which are frames of panes that scroll
   * individually and can only size themselves if something above them is the
   * height of the window.
   *
   * Opt-in, because it moves scrolling off the document, and
   * `<ScrollRestoration />` in `root.tsx` restores `window.scrollY`. The long
   * pages (settings, analytics, templates) keep document scrolling.
   */
  fillViewport?: boolean;
}

/**
 * The content frame of a page: the full width under the top bar. The chrome
 * itself is `AppShell`'s, mounted once around every page.
 *
 * Offsets come from the `--app-*` variables in index.css, the same ones the
 * chrome is sized by, so a page cannot sit under or away from it.
 */
export default function DashboardLayout({ children, fillViewport = false }: DashboardLayoutProps) {
  const agentOpen = useUIStore((s) => s.isAgentPanelOpen);

  return (
    <div
      className={cn(
        "flex flex-col bg-background pb-[var(--app-tabbar-h)] pl-safe pt-[var(--app-topbar-h)] transition-[padding] duration-300",
        fillViewport ? "h-dvh overflow-hidden" : "min-h-dvh",
        // The docked agent panel, from `xl`. Below that it overlays.
        agentOpen && "xl:pr-[400px]",
      )}
    >
      {/* Spam-rate warning or paused bulk sending; renders nothing when healthy. */}
      <DeliverabilityBanner />
      {/* Licence check failing but still within grace; admins only. */}
      <LicenceBanner />
      <main
        id="main"
        className={cn("flex min-h-0 min-w-0 flex-1 flex-col", fillViewport && "overflow-y-auto")}
      >
        {children}
      </main>
    </div>
  );
}
