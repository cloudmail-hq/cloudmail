/**
 * The signed-in app's chrome, as a layout route around every page.
 *
 * A top bar (brand, section links, search, a fixed set of icons) and the page
 * under it, full width. There is no left app rail: the sections live in the
 * top bar only. On a phone they move to a bottom tab bar.
 *
 * A layout route rather than a component each page renders, so the chrome is
 * mounted once and stays mounted: moving between pages swaps the `<Outlet />`
 * and nothing else. That is what keeps the bars from changing between
 * pages, which they used to do when every route assembled its own (one passed
 * search and four extra buttons, another passed none, a third an unread count
 * of its own). Pages render `DashboardLayout`, which is now only the content
 * frame, and put page-specific controls in their own toolbar.
 */

import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AppTabBar } from "~/components/AppNav";
import CommandPalette from "~/components/CommandPalette";
import TopNav from "~/components/TopNav";
import { LazyAgentPanel } from "~/components/lazy";
import { useLastMailboxStore } from "~/hooks/useLastMailboxStore";
import { useMailboxVisibilityStore } from "~/hooks/useMailboxVisibilityStore";
import { useUIStore } from "~/hooks/useUIStore";
import { activeModule, isMailWorkspacePath, mailboxFromPath, mailHref, mailTarget, totalUnread } from "~/lib/app-nav";
import { cn } from "~/lib/utils";
import { useSignOut } from "~/queries/auth";
import { brandingLogoUrl, useBranding } from "~/queries/branding";
import { queryKeys } from "~/queries/keys";
import { useMailboxes } from "~/queries/mailboxes";
import { useDashboardUser } from "~/queries/people";
import { useInboxUnread } from "~/queries/products";
import api from "~/services/api";
import { useLicence } from "~/queries/licence";
import LicenceLockScreen from "~/components/licence/LicenceLockScreen";

export default function AppShell() {
	const user = useDashboardUser();
	const onSignOut = useSignOut();
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const { data: licence } = useLicence(!!user);

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
	});
	const { data: branding } = useBranding();

	// The mailbox in the URL, remembered for the Mail section link and the agent.
	const routeMailbox = mailboxFromPath(pathname);
	const { lastMailboxId, setLastMailbox } = useLastMailboxStore();
	useEffect(() => {
		if (routeMailbox) setLastMailbox(routeMailbox);
	}, [routeMailbox, setLastMailbox]);

	const { data: mailboxes = [] } = useMailboxes();
	// Where Mail goes and what the agent works in off Mail: the last mailbox used
	// (if still readable), else the first. A lost grant is forgotten here.
	const rememberedMailbox = mailTarget(lastMailboxId, mailboxes);
	const agentMailbox = routeMailbox ?? rememberedMailbox ?? undefined;

	// One unread definition everywhere: Inbox, across visible readable mailboxes.
	const { data: unreadByMailbox } = useInboxUnread(!!user);
	const hidden = useMailboxVisibilityStore((s) => s.hiddenMailboxIds);
	const unread = totalUnread(unreadByMailbox, hidden);

	const isAgentPanelOpen = useUIStore((s) => s.isAgentPanelOpen);
	const toggleAgentPanel = useUIStore((s) => s.toggleAgentPanel);
	const startCompose = useUIStore((s) => s.startCompose);
	const reading = useUIStore((s) => s.selectedEmailId !== null) && isMailWorkspacePath(pathname);

	// Opt-in panel: its chunk and history are fetched on first open, then it
	// stays mounted so the conversation survives closing it.
	const [agentEverOpened, setAgentEverOpened] = useState(false);
	useEffect(() => {
		if (isAgentPanelOpen) setAgentEverOpened(true);
	}, [isAgentPanelOpen]);

	/*
	  Reading a message on a phone, the tab bar steps aside for the reader's own
	  action bar (Reply, Reply all, Forward, Archive, More), as Outlook's does.
	  Two bars stacked there cost 112px of an 844px screen. The frame's bottom
	  padding follows through `--app-tabbar-h`, which the attribute zeroes.
	*/
	useEffect(() => {
		const root = document.documentElement;
		if (reading) root.dataset.reading = "";
		else delete root.dataset.reading;
		return () => {
			delete root.dataset.reading;
		};
	}, [reading]);

	// Compose from the tab bar: where a page hosts the composer (the mail
	// workspace, People) open it there; anywhere else, in the last mailbox.
	const compose = useCallback(() => {
		if (isMailWorkspacePath(pathname) || activeModule(pathname) === "people") {
			startCompose();
			return;
		}
		const target = rememberedMailbox;
		if (!target) return;
		navigate(mailHref(target));
		startCompose();
	}, [pathname, rememberedMailbox, navigate, startCompose]);

	/*
	  Licence locked: one full-page screen instead of the app. Admins can still
	  reach guided setup (its Connect step comes before the licence step) and
	  Settings → Licence. The API answers 402 for everything else anyway.
	*/
	const isAdmin = user?.role === "admin";
	const lockAllowsPage = isAdmin && (pathname === "/onboarding" || pathname === "/settings/licence");
	if (licence?.locked && !lockAllowsPage) {
		return <LicenceLockScreen view={licence} isAdmin={isAdmin} onSignOut={onSignOut} />;
	}

	return (
		<>
			<TopNav
				brandName={branding?.appName}
				logoUrl={brandingLogoUrl(branding)}
				accentColor={branding?.accentColor}
				onSignOut={onSignOut}
				user={user}
				onToggleAgent={toggleAgentPanel}
				agentOpen={isAgentPanelOpen}
				zones={configData?.zones ?? []}
				brandHref={mailHref(rememberedMailbox)}
				unread={unread}
				lastMailboxId={rememberedMailbox}
			/>
			{!reading && <AppTabBar unread={unread} lastMailboxId={rememberedMailbox} onCompose={compose} />}

			<Outlet />

			{/*
			  Agent panel, on every page: an overlay below `xl`, docked at `xl`
			  (the page frame reserves 400px for it). Off Mail it works in the last
			  mailbox opened, which its header names.
			*/}
			{agentEverOpened && agentMailbox && (
				<div
					className={cn(
						"fixed bottom-[var(--app-tabbar-h)] right-0 top-[var(--app-topbar-h)] z-40 w-full transform border-l border-border bg-card shadow-lg transition-transform duration-300 sm:w-[400px]",
						isAgentPanelOpen ? "translate-x-0" : "translate-x-full",
					)}
					aria-hidden={!isAgentPanelOpen}
					inert={!isAgentPanelOpen}
				>
					{/* Keyed so switching mailbox starts that mailbox's conversation. */}
					<LazyAgentPanel key={agentMailbox} mailboxId={agentMailbox} onClose={toggleAgentPanel} />
				</div>
			)}

			<CommandPalette />
		</>
	);
}
