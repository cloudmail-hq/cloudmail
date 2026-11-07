/**
 * The app-level navigation model, shared by the top bar's section links and
 * search field, the phone tab bar and the agent panel.
 *
 * Pure, so the rules that keep the chrome constant (one module list, one
 * active-module rule, one search scope rule) are unit-tested without a DOM.
 */

/** A top-level module: one section link. */
export type AppModuleId =
	| "mail"
	| "people"
	| "templates"
	| "sequences"
	| "analytics"
	| "settings";

export interface AppModule {
	id: AppModuleId;
	label: string;
	/** Where the entry goes. Mail is resolved per user; see `mailHref`. */
	path: string;
}

/**
 * The top bar's section links, left to right. Settings is not one of them: it
 * is in the account menu, and in the phone's More sheet. Folder-level
 * destinations (All inboxes, Screener, Awaiting reply, labels) are not here
 * either: they belong to Mail's folder pane.
 */
export const NAV_MODULES: readonly AppModule[] = [
	{ id: "mail", label: "Mail", path: "/" },
	{ id: "people", label: "People", path: "/people" },
	{ id: "templates", label: "Templates", path: "/templates" },
	{ id: "sequences", label: "Sequences", path: "/sequences" },
	{ id: "analytics", label: "Analytics", path: "/analytics" },
];

export const SETTINGS_MODULE: AppModule = { id: "settings", label: "Settings", path: "/settings" };

/** What the phone's "More" sheet lists: the modules the tab bar has no room for. */
export const MORE_MODULES: readonly AppModuleId[] = ["templates", "sequences", "settings"];

const under = (pathname: string, base: string) =>
	pathname === base || pathname.startsWith(`${base}/`);

/**
 * Which module a path belongs to. The mailbox chooser (`/`), every mailbox and
 * the unified inbox are Mail; an unknown path (the 404 page) is none.
 */
export function activeModule(pathname: string): AppModuleId | null {
	// `/` is Mail's mailbox list, with Mail's pane; Mail's section link itself
	// opens a mailbox directly.
	if (pathname === "/" || under(pathname, "/mail")) return "mail";
	for (const id of ["people", "templates", "sequences", "analytics", "settings"] as const) {
		if (under(pathname, `/${id}`)) return id;
	}
	return null;
}

/**
 * The mailbox a path is inside, or null.
 *
 * `/mail/all/*` is the unified inbox, not a mailbox called "all"; a real
 * mailbox id always contains `@`, which is how routes.ts tells them apart too.
 */
export function mailboxFromPath(pathname: string): string | null {
	const match = /^\/mail\/([^/]+)/.exec(pathname);
	if (!match) return null;
	let id: string;
	try {
		id = decodeURIComponent(match[1]);
	} catch {
		return null;
	}
	return id.includes("@") ? id : null;
}

/** Whether the path renders the mail workspace (folder pane, list, reader). */
export function isMailWorkspacePath(pathname: string): boolean {
	const mailbox = mailboxFromPath(pathname);
	if (!mailbox) return false;
	// Mailbox settings is a form under the same layout, with no list or composer.
	return !/^\/mail\/[^/]+\/settings\/?$/.test(pathname);
}

export type SearchScope = { kind: "mailbox"; mailboxId: string } | { kind: "all" };

/** The global search box searches the open mailbox, or every inbox anywhere else. */
export function searchScope(pathname: string): SearchScope {
	const mailboxId = mailboxFromPath(pathname);
	return mailboxId ? { kind: "mailbox", mailboxId } : { kind: "all" };
}

export function searchHref(scope: SearchScope, query: string): string {
	const q = encodeURIComponent(query);
	return scope.kind === "mailbox"
		? `/mail/${encodeURIComponent(scope.mailboxId)}/search?q=${q}`
		: `/mail/all/search?q=${q}`;
}

/** Whether the path is a search results page, whose `?q=` the field mirrors. */
export function isSearchPath(pathname: string): boolean {
	return /^\/mail\/[^/]+\/search\/?$/.test(pathname);
}

/**
 * Where the Mail entry goes: the last mailbox opened on this device, else the
 * chooser (which itself redirects when there is only one mailbox).
 */
export function mailHref(lastMailboxId: string | null): string {
	return lastMailboxId ? `/mail/${encodeURIComponent(lastMailboxId)}/inbox` : "/";
}

/**
 * The mailbox the Mail entry opens: the last one used here, else the first the
 * user can read. Mail then always lands in a folder with the folder pane, as
 * Outlook's does; the chooser stays one click away (account menu, mailbox
 * switcher). Null only when there is no mailbox at all.
 */
export function mailTarget(
	lastMailboxId: string | null,
	mailboxes: readonly { id: string }[],
): string | null {
	if (lastMailboxId && mailboxes.some((m) => m.id === lastMailboxId)) return lastMailboxId;
	return mailboxes[0]?.id ?? null;
}

/**
 * The one unread count the Mail entry shows, on every page: unread Inbox mail
 * summed over every readable mailbox the user has not hidden from the switcher.
 *
 * Not the open mailbox's count. That changed meaning off Mail (no mailbox is
 * open on Templates), which is how the badge came to read 220 on one page,
 * nothing on another and 999+ on a third.
 */
export function totalUnread(
	unreadByMailbox: Record<string, number> | undefined,
	hiddenMailboxIds: readonly string[] = [],
): number {
	if (!unreadByMailbox) return 0;
	const hidden = new Set(hiddenMailboxIds.map((id) => id.toLowerCase()));
	let sum = 0;
	for (const [mailbox, n] of Object.entries(unreadByMailbox)) {
		if (!hidden.has(mailbox.toLowerCase()) && Number.isFinite(n) && n > 0) sum += n;
	}
	return sum;
}
