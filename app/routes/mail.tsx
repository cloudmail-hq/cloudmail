/**
 * Mail workspace: folder pane, then list, then reader (Outlook's layout
 * under the app shell's top bar).
 *
 * This is the production mail UI. The kumo-based `/mailbox/*` screens it
 * replaced are gone, so anything the workspace cannot do is a gap in the
 * product rather than a reason to fall back to another surface.
 */

import { useEffect, useRef } from "react";
import { Link, Outlet, useLocation, useParams } from "react-router";
import { Settings as SettingsIcon } from "lucide-react";
import { ModuleBar } from "~/components/ModuleBar";
import { getFolderDisplayName } from "shared/folders";
import DashboardLayout from "~/components/DashboardLayout";
import { preloadAgentPanelWhenIdle } from "~/components/lazy";
import MailSidebar from "~/components/mail/MailSidebar";
import ShortcutHelp from "~/components/mail/ShortcutHelp";
import { useKeyboardShortcuts } from "~/hooks/useKeyboardShortcuts";
import { useMailboxLiveUpdates } from "~/hooks/useMailboxLiveUpdates";
import { useMailUrlSync } from "~/hooks/useMailUrlSync";
import { useUIStore } from "~/hooks/useUIStore";
import { cn } from "~/lib/utils";
import { useFolders } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import { useSignatures } from "~/queries/signatures";

/** The name of the view a mailbox path shows: a folder, Search, Screener… */
function currentViewName(pathname: string, mailboxId: string, folders: { id: string; name: string }[]): string {
	const base = `/mail/${encodeURIComponent(mailboxId)}/`;
	const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "";
	const [first = "inbox"] = rest.split("/");
	if (first === "search") return "Search";
	if (first === "settings") return "Mailbox settings";
	if (first === "awaiting") return "Awaiting reply";
	if (first === "screener") return "Screener";
	if (first === "approvals") return "Pending approval";
	if (first === "label") return "Label";
	let id = first;
	try {
		id = decodeURIComponent(first);
	} catch {
		/* keep the raw segment */
	}
	return folders.find((f) => f.id === id)?.name ?? getFolderDisplayName(id);
}

export default function MailRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();

	// Prefetch what child views and the composer need. Signatures are warmed
	// here because the composer only prefills once, on open, and would miss a
	// signature still in flight at that moment.
	useMailbox(mailboxId);
	useSignatures(mailboxId);
	const { data: folders = [] } = useFolders(mailboxId);
	const { pathname } = useLocation();

	const {
		isSidebarOpen,
		openSidebar,
		closeSidebar,
		closePanel,
		closeCompose,
		selectedEmailId,
	} = useUIStore();

	/**
	 * Whether a message is open, which is the only thing that makes the folder
	 * rail expensive.
	 *
	 * Browsing, the rail costs 208px out of a list that has the whole frame — it
	 * is free. Reading, the same 208px comes off the message, and between 768px
	 * and 1024px that is the difference between a readable column and a cropped
	 * one. So the rail keeps its place while browsing at every width, and gives it
	 * up while reading on anything narrower than `lg`, where the drawer below
	 * takes over. Nothing becomes unreachable: closing the message brings it back,
	 * and the drawer trigger is on screen at exactly the widths the rail is not.
	 */
	const paneOpen = selectedEmailId !== null;

	const { isHelpOpen, closeHelp } = useKeyboardShortcuts();

	// The open message lives in `?m=` too: deep links, reload, and Back closing
	// the reader on a phone. See `useMailUrlSync`.
	useMailUrlSync();

	const { stalled } = useMailboxLiveUpdates(mailboxId, {
		mailboxLabel: mailboxId,
	});

	// The agent panel and the composer are split out of the route bundle (see
	// ~/components/lazy). Fetch them once the inbox has painted, so the `c`
	// shortcut and the agent toggle stay instant without delaying first content.
	useEffect(() => preloadAgentPanelWhenIdle({ alsoComposer: true }), []);

	// Switching mailbox must not leave another mailbox's message open.
	const prevMailboxRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (prevMailboxRef.current && mailboxId !== prevMailboxRef.current) {
			closePanel();
			closeCompose();
			closeSidebar();
		}
		prevMailboxRef.current = mailboxId;
	}, [mailboxId, closePanel, closeCompose, closeSidebar]);

	/**
	 * Opening or closing a message closes the folder drawer.
	 *
	 * The drawer and the docked rail are the same rail at two widths, and which
	 * one is on screen depends on `paneOpen` — so without this, a drawer left open
	 * while reading is hidden by CSS the moment the message closes and then
	 * reappears unbidden the next time one is opened. Closing it on the transition
	 * keeps the flag and what is visible in agreement.
	 */
	useEffect(() => {
		closeSidebar();
	}, [selectedEmailId, closeSidebar]);

	if (!mailboxId) return null;

	// The current folder (or view) for the phone toolbar's folder button.
	const here = currentViewName(pathname, mailboxId, folders);

	return (
		// The workspace divides the window between the folder pane, the list and
		// the reader, each scrolling on its own, so it needs a viewport-sized frame.
		// Search, notifications and the agent are the app shell's, on every page.
		<DashboardLayout fillViewport>
			{/*
			  No width cap.

			  This was `mx-auto max-w-[1600px] md:px-4`, which on a 1920px display
			  left 160px of empty gutter on each side and then took another 32px in
			  padding — 352px, roughly the width of the message list, spent on
			  nothing. A mailbox is a two-pane reading tool; the wider the window, the
			  more of the message and the more of each subject line fits, so the
			  window is the right width and there is no editorial reason to cap it.
			*/}
			<div className="flex min-h-0 w-full flex-1 flex-col">
				{/*
				  What is left of the workspace toolbar: one button, on the widths that
				  need it.

				  Search, notifications and the agent are global, in the app shell's top
				  bar. What stays here is the mailbox's own: the folder drawer trigger and
				  mailbox settings, on the widths where the folder pane is not on screen
				  (the pane carries both otherwise). Which widths those are depends on
				  whether a message is open; see `paneOpen`.
				*/}
				<ModuleBar
					label={here}
					navLabel="Folders"
					onOpen={openSidebar}
					// Shown up to `lg` while reading, where the folder pane gives way.
					className={paneOpen ? "md:flex lg:hidden" : undefined}
					actions={
						<>
							{stalled && <span className="text-[10px] font-light text-text-tertiary">reconnecting…</span>}
							{/* Mailbox settings: in the folder pane where it is on screen, here otherwise. */}
							<Link
								to={`/mail/${encodeURIComponent(mailboxId)}/settings`}
								aria-label="Mailbox settings"
								title="Mailbox settings"
								className="inline-flex h-11 w-11 items-center justify-center rounded-[6px] text-text-secondary hover:bg-bg-muted hover:text-text-primary"
							>
								<SettingsIcon size={16} aria-hidden />
							</Link>
						</>
					}
				/>

				{/* Rail + content */}
				{/*
				  Fills whatever is left, rather than being told how tall to be.

				  `h-[calc(100vh-8.5rem)]` hard-coded a guess at the chrome above it —
				  136px — which was wrong the moment the top bar changed height, and on a
				  short laptop screen the `min-h-[440px]` floor pushed the frame past the
				  bottom of the window with no way to scroll to it. Now the page frame is
				  the viewport and this is the flex child that takes the remainder, so the
				  arithmetic is the browser's problem.
				*/}
				{/*
				  Flush with the bar, not an inset card. A floating rounded frame under
				  an attached bar gave the page two edge systems; one surface divided
				  by hairlines is how Gmail and Fastmail lay out the same three panes.
				*/}
				<div className="flex min-h-0 flex-1 overflow-hidden bg-card">
					{/* Desktop rail */}
					{/*
					  208px, from 232. The rail holds one word and a count; the width was
					  set by nothing in particular, and 24px of it belongs to the list.
					*/}
					<div
						className={cn(
							"hidden w-[208px] shrink-0",
							paneOpen ? "lg:block" : "md:block",
						)}
					>
						<MailSidebar mailboxId={mailboxId} />
					</div>

					{/* Rail as a drawer, wherever the rail itself is not on screen */}
					{isSidebarOpen && (
						<>
							<button
								type="button"
								aria-label="Close folders"
								onClick={closeSidebar}
								className={cn(
									"fixed inset-0 z-40 bg-black/40",
									paneOpen ? "lg:hidden" : "md:hidden",
								)}
							/>
							<div
								className={cn(
									// Safe areas: the drawer runs the full height, under the
									// notch and the home indicator in standalone mode.
									"pt-safe pb-safe pl-safe fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] bg-card shadow-2xl",
									paneOpen ? "lg:hidden" : "md:hidden",
								)}
							>
								<MailSidebar mailboxId={mailboxId} onNavigate={closeSidebar} />
							</div>
						</>
					)}

					<div className="min-w-0 flex-1">
						<Outlet />
					</div>
				</div>
			</div>

			{/*
			  No floating Compose: on a phone the app tab bar has Compose in the same
			  thumb zone, and a button floating over it overlapped the bar.
			*/}
			<ShortcutHelp open={isHelpOpen} onClose={closeHelp} />
		</DashboardLayout>
	);
}
