/**
 * The app shell: one top bar (with the section links) and one phone tab bar,
 * the same on every page. No left app rail.
 *
 * The rules (which module is active, what search covers, the one unread
 * definition) are pure and tested directly. The layout guarantees are tested
 * by rendering the chrome at different routes and asserting the markup is the
 * same apart from `aria-current`, plus source checks that pages can no longer
 * inject controls into it. The real-browser measurement on every route is
 * `scripts/measure-chrome.js`; numbers are in the PR.
 */

import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
	activeModule,
	isMailWorkspacePath,
	mailboxFromPath,
	mailHref,
	mailTarget,
	MORE_MODULES,
	NAV_MODULES,
	SETTINGS_MODULE,
	searchHref,
	searchScope,
	totalUnread,
} from "~/lib/app-nav";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const ROUTES = [
	"/",
	"/mail/ceo%40acme.com/inbox",
	"/mail/ceo%40acme.com/inbox?m=abc",
	"/mail/ceo%40acme.com/screener",
	"/mail/ceo%40acme.com/awaiting",
	"/mail/ceo%40acme.com/label/l1",
	"/mail/ceo%40acme.com/settings",
	"/mail/all/inbox",
	"/mail/all/search?q=x",
	"/people",
	"/templates",
	"/templates/new",
	"/sequences",
	"/sequences/s1",
	"/analytics/overview",
	"/settings/account",
	"/settings/domains",
	"/nope",
];

describe("module model", () => {
	it("lists the top bar's sections in order; Settings is in the account menu", () => {
		expect(NAV_MODULES.map((m) => m.id)).toEqual(["mail", "people", "templates", "sequences", "analytics"]);
		expect(SETTINGS_MODULE.path).toBe("/settings");
		// The phone tab bar: Mail, People, Analytics, More, Compose. More holds the rest.
		expect([...MORE_MODULES]).toEqual(["templates", "sequences", "settings"]);
	});

	it("maps every route to one module; Mail is every mailbox and All inboxes", () => {
		// The mailbox list is part of Mail, with Mail's pane.
		expect(activeModule("/")).toBe("mail");
		expect(activeModule("/mail/a%40b.com/inbox")).toBe("mail");
		expect(activeModule("/mail/all/inbox")).toBe("mail");
		expect(activeModule("/mail/a%40b.com/settings")).toBe("mail");
		expect(activeModule("/people")).toBe("people");
		expect(activeModule("/templates/x/edit")).toBe("templates");
		expect(activeModule("/sequences/new")).toBe("sequences");
		expect(activeModule("/analytics/dmarc")).toBe("analytics");
		expect(activeModule("/settings")).toBe("settings");
		expect(activeModule("/settingsx")).toBeNull();
		expect(activeModule("/nope")).toBeNull();
	});

	it("reads the mailbox from the URL, never treating `all` as one", () => {
		expect(mailboxFromPath("/mail/a%40b.com/inbox")).toBe("a@b.com");
		expect(mailboxFromPath("/mail/all/inbox")).toBeNull();
		expect(mailboxFromPath("/mail/%E0%A4%A/inbox")).toBeNull();
		expect(mailboxFromPath("/people")).toBeNull();
		expect(isMailWorkspacePath("/mail/a%40b.com/inbox")).toBe(true);
		expect(isMailWorkspacePath("/mail/a%40b.com/settings")).toBe(false);
	});

	it("searches the open mailbox, or all inboxes anywhere else", () => {
		expect(searchScope("/mail/a%40b.com/sent")).toEqual({ kind: "mailbox", mailboxId: "a@b.com" });
		expect(searchHref(searchScope("/mail/a%40b.com/sent"), "from:x y")).toBe("/mail/a%40b.com/search?q=from%3Ax%20y");
		for (const path of ["/", "/mail/all/inbox", "/people", "/analytics/overview", "/settings/account"]) {
			expect(searchHref(searchScope(path), "inv")).toBe("/mail/all/search?q=inv");
		}
	});

	it("sends Mail into a mailbox: the last one used if still readable, else the first", () => {
		expect(mailHref("a@b.com")).toBe("/mail/a%40b.com/inbox");
		expect(mailHref(null)).toBe("/");
		const boxes = [{ id: "a@b.com" }, { id: "c@b.com" }];
		expect(mailTarget("c@b.com", boxes)).toBe("c@b.com");
		expect(mailTarget("gone@b.com", boxes)).toBe("a@b.com");
		expect(mailTarget(null, boxes)).toBe("a@b.com");
		expect(mailTarget(null, [])).toBeNull();
	});

	it("has one unread definition: Inbox unread over visible readable mailboxes", () => {
		const by = { "a@x.com": 220, "b@x.com": 4699, "c@x.com": 0 };
		expect(totalUnread(by)).toBe(4919);
		expect(totalUnread(by, ["B@x.com"])).toBe(220);
		expect(totalUnread(undefined)).toBe(0);
		expect(totalUnread({ "a@x.com": -1, "b@x.com": Number.NaN })).toBe(0);
	});
});

describe("chrome is identical on every route", () => {
	async function renderChrome(path: string) {
		const { AppTabBar } = await import("~/components/AppNav");
		const TopNav = (await import("~/components/TopNav")).default;
		const client = new QueryClient();
		const html = renderToStaticMarkup(
			h(
				QueryClientProvider,
				{ client },
				h(
					MemoryRouter,
					{ initialEntries: [path] },
					h(TopNav, {
						user: { name: "Ada", email: "ada@x.com", role: "admin" },
						onToggleAgent: () => {},
						agentOpen: false,
						unread: 220,
						lastMailboxId: "ceo@acme.com",
					}),
					h(AppTabBar, { unread: 220, lastMailboxId: "ceo@acme.com", onCompose: () => {} }),
				),
			),
		);
		return html;
	}

	// Everything that may differ between routes: which item is current, and
	// the search field's scope text (its control and size do not change).
	const normalise = (html: string) =>
		html
			.replace(/ aria-current="page"/g, "")
			.replace(
				/bg-accent\/12 text-accent-subtle-fg dark:bg-accent\/(30|40 dark:text-white)|bg-accent-subtle text-accent-subtle-fg|text-text-secondary hover:bg-bg-muted hover:text-text-primary/g,
				"STATE",
			)
			.replace(/text-accent"|text-text-secondary"/g, 'TONE"')
			.replace(/opacity-100|opacity-0/g, "OP")
			// The phone tab's active pill.
			.replace(/rounded-full transition-colors( bg-accent\/12 dark:bg-accent\/30)?"/g, 'rounded-full transition-colors"')
			.replace(/strokeWidth|stroke-width="[\d.]+"/g, "SW")
			.replace(/Search this mailbox|Search all inboxes|This mailbox|All inboxes/g, "SCOPE")
			// The scope selector: which option is chosen, and whether "this mailbox" exists.
			.replace(/ (selected|disabled)=""/g, "")
			// On a results page the field holds the query and offers to clear it.
			.replace(/ value="[^"]*"/g, ' value=""')
			.replace(/<button type="button" aria-label="Clear search"[\s\S]*?<\/button>/g, "")
			// ...and reserves room for that button on touch only while it is there.
			.replace(/touch:pr-\[5\.5rem\]|touch:pr-11/g, "TOUCHPR");

	it("renders the same top bar and tab bar markup at every route", async () => {
		const baseline = normalise(await renderChrome("/people"));
		for (const path of ROUTES) {
			expect(normalise(await renderChrome(path)), path).toBe(baseline);
		}
	});

	it("lets the search scope switch from this mailbox to all inboxes", async () => {
		const inMailbox = await renderChrome("/mail/ceo%40acme.com/inbox");
		expect(inMailbox).toMatch(/aria-label="Search scope"/);
		expect(inMailbox).toMatch(/<option value="mailbox" selected="">This mailbox<\/option>/);
		expect(inMailbox).toMatch(/<option value="all">All inboxes<\/option>/);
		// Outside a mailbox there is no "this" one to choose.
		const elsewhere = await renderChrome("/people");
		expect(elsewhere).toMatch(/<option value="mailbox" disabled="">This mailbox<\/option>/);
		expect(elsewhere).toMatch(/<option value="all" selected="">All inboxes<\/option>/);
	});

	it("puts brand, sections, search and a fixed icon set in a fixed order in the top bar", async () => {
		const html = await renderChrome("/templates");
		const bar = html.slice(html.indexOf("data-app-topbar"), html.indexOf("data-app-tabbar"));
		const order = [
			'aria-label="cloudmail"',
			'aria-label="Mail, 220 unread"',
			'aria-label="People"',
			'aria-label="Templates"',
			'aria-label="Sequences"',
			'aria-label="Analytics"',
			'aria-label="Search mail"',
			'aria-label="Advanced search"',
			'aria-label="Command palette"',
			'aria-label="Notify me about new mail"',
			'aria-label="AI agent"',
			"theme",
			'aria-label="Account: Ada"',
		];
		let at = -1;
		for (const marker of order) {
			const next = bar.indexOf(marker, at + 1);
			expect(next, marker).toBeGreaterThan(at);
			at = next;
		}
		// Page-specific controls are not in the global bar any more.
		expect(bar).not.toContain("Mailbox settings");
	});

	it("marks the current module with aria-current in a labelled nav landmark", async () => {
		const html = await renderChrome("/analytics/overview");
		const sections = html.slice(html.indexOf("data-app-sections"), html.indexOf('aria-label="Search mail"'));
		expect(html).toMatch(/<nav aria-label="App" data-app-sections/);
		expect(sections).toMatch(/aria-current="page"[^>]*aria-label="Analytics"/);
		expect(sections.match(/aria-current="page"/g)).toHaveLength(1);
		// One badge, the same number, in the top bar and the tab bar.
		expect(html.match(/aria-label="Mail, 220 unread"/g)).toHaveLength(2);
		expect(sections).toContain('href="/mail/ceo%40acme.com/inbox"');
		// Settings is in the account menu, not a section link.
		expect(sections).not.toContain('aria-label="Settings"');
	});

	it("leaves an empty phone search field room for its placeholder", async () => {
		// Empty: only Advanced (44px) sits in the field on touch, so "Search or
		// ask" fits at 360px. With text, Clear joins it and the room grows.
		const empty = await renderChrome("/people");
		const input = (html: string) => html.match(/<input[^>]*aria-label="Search mail"[^>]*>/)![0];
		expect(input(empty)).toContain("touch:pr-11");
		expect(input(empty)).not.toContain("touch:pr-[5.5rem]");
		expect(input(await renderChrome("/mail/all/search?q=x"))).toContain("touch:pr-[5.5rem]");
		// The ⌘K hint stays mouse-only.
		expect(empty).toMatch(/aria-label="Command palette"[^>]*class="[^"]*touch:hidden/);
	});

	it("shows the cloudmail mark on its blue tile, and plates an uploaded logo in dark mode only", async () => {
		const html = await renderChrome("/people");
		// No uploaded logo: the built-in mark, a white @ on the brand gradient tile.
		const mark = html.match(/<svg viewBox="0 0 64 64"[\s\S]*?<\/svg>/)![0];
		expect(mark).toContain('aria-hidden="true"');
		expect(mark).toMatch(/stop-color="#2D61DA"[\s\S]*stop-color="#12309E"/);
		expect(mark).toContain('stroke="#fff"');
		const src = read("app/components/TopNav.tsx");
		const img = src.match(/<img\s+src=\{logoUrl\}[\s\S]*?\/>/)![0];
		expect(img).toContain("dark:bg-foreground");
		expect(img.match(/className="([^"]+)"/)![1].split(/\s+/).filter((c) => /rounded|bg-|px-|py-/.test(c) && !c.startsWith("dark:"))).toEqual([]);
	});

	it("has no left app rail", async () => {
		const html = await renderChrome("/people");
		expect(html).not.toContain("data-app-rail");
		expect(read("app/index.css")).not.toContain("--app-rail-w");
		for (const file of ["app/routes/app-shell.tsx", "app/components/TopNav.tsx", "app/components/DashboardLayout.tsx"]) {
			expect(read(file), file).not.toMatch(/AppRail|app-rail-w/);
		}
	});

	it("keeps five tab-bar items with 44px targets", async () => {
		const html = await renderChrome("/people");
		const bar = html.slice(html.indexOf("data-app-tabbar"));
		const labels = [...bar.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
		expect(labels.slice(0, 5)).toEqual(["Mail, 220 unread", "People", "Analytics", "More", "Compose"]);
		expect(bar).toContain("min-h-11");
		expect(bar).toContain("pb-safe");
	});
});

describe("pages cannot change the chrome", () => {
	it("mounts the chrome once, in a layout route around every signed-in page", () => {
		const routes = read("app/routes.ts");
		expect(routes).toContain('layout("routes/app-shell.tsx", [');
		// Auth pages stay outside it.
		expect(routes.indexOf('route("login"')).toBeLessThan(routes.indexOf("layout("));
		const shell = read("app/routes/app-shell.tsx");
		for (const part of ["<TopNav", "<AppTabBar", "<Outlet />", "<CommandPalette />", "<LazyAgentPanel"]) {
			expect(shell).toContain(part);
		}
	});

	it("gives DashboardLayout no props that reach the chrome", () => {
		const layout = read("app/components/DashboardLayout.tsx");
		for (const prop of ["searchSlot", "topBarActions", "topBarMenuActions", "unreadCount", "onToggleAgent", "agentPanel"]) {
			expect(layout).not.toContain(prop);
		}
		const top = read("app/components/TopNav.tsx");
		for (const prop of ["searchSlot", "actions", "menuActions", "unreadCount"]) {
			expect(top).not.toMatch(new RegExp(`\\b${prop}\\??:`));
		}
	});

	it("sizes every piece of chrome and the page frame from the same variables", () => {
		const css = read("app/index.css");
		for (const v of ["--app-topbar-h", "--app-tabbar-h"]) expect(css).toContain(`${v}:`);
		expect(read("app/components/TopNav.tsx")).toContain("h-[var(--app-topbar-h)]");
		expect(read("app/components/AppNav.tsx")).toContain("h-[var(--app-tabbar-h)]");
		const frame = read("app/components/DashboardLayout.tsx");
		for (const v of ["pt-[var(--app-topbar-h)]", "pb-[var(--app-tabbar-h)]"]) {
			expect(frame).toContain(v);
		}
	});

	it("gives sectioned modules a pane in the same place and width as Mail's folder pane", () => {
		const pane = read("app/components/ModuleBar.tsx");
		expect(pane).toMatch(/data-module-pane[\s\S]*w-\[208px\][\s\S]*md:flex/);
		// One pane component for Settings, Analytics and the mailbox list.
		expect(read("app/components/ui/SideNavLayout.tsx")).toContain("<ModulePane");
		// Mail's pages that span mailboxes share Mail's account pane.
		expect(read("app/components/mail/MailAccountsPane.tsx")).toContain("<ModulePane");
		for (const page of ["inboxes", "mail-all", "mail-all-search"]) {
			expect(read(`app/routes/${page}.tsx`)).toContain("<MailAccountsPane");
		}
		expect(read("app/routes/mail.tsx")).toContain("w-[208px]");
		// Settings and Analytics both use it; neither re-wraps it in a centred column.
		expect(read("app/components/settings/SettingsLayout.tsx")).toContain("<SideNavLayout");
		const analytics = read("app/routes/analytics.tsx");
		expect(analytics).toContain("<SideNavLayout");
		expect(analytics).not.toContain("<PageContainer");
		expect(read("app/routes/app-settings.tsx")).not.toContain("<PageContainer");
	});

	it("keeps folder-level destinations in Mail's folder pane, not the section links", () => {
		const pane = read("app/components/mail/MailSidebar.tsx");
		for (const item of ['to="/mail/all/inbox"', "/screener`", "/awaiting`", "/approvals`", "/settings`"]) {
			expect(pane).toContain(item);
		}
		const nav = read("app/lib/app-nav.ts");
		expect(nav).not.toMatch(/path: "\/mail\/all/);
	});

	it("does not stack the tab bar with the reader's action bar or a floating Compose", () => {
		const shell = read("app/routes/app-shell.tsx");
		expect(shell).toContain("{!reading && <AppTabBar");
		expect(read("app/index.css")).toMatch(/:root\[data-reading\]\s*\{\s*--app-tabbar-h: 0px;/);
		expect(read("app/routes/mail.tsx")).not.toContain('aria-label="Compose"');
	});
});
