/**
 * Guards for the mobile pass: the pieces that only show up on a phone and so
 * are easy to break from a desktop browser.
 *
 * Mostly source checks, because the test environment is Node without a layout
 * engine. The measured numbers (overflow at 390px, target sizes) are in the
 * PR; these keep the mechanisms that produce them from silently going away.
 */

import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("44px touch targets", () => {
	const css = read("app/index.css");

	it("defines a touch variant for coarse pointers and narrow windows", () => {
		expect(css).toMatch(/@custom-variant touch\s*\{[\s\S]*pointer: coarse[\s\S]*max-width: 767\.98px/);
	});

	it("floors interactive controls at 44px only under touch conditions, in the base layer", () => {
		const base = css.slice(css.indexOf("@layer base"), css.indexOf("Safe areas"));
		expect(base).toContain("@media (pointer: coarse), (max-width: 767.98px)");
		expect(base).toMatch(/button:not\(\.touch-exempt\)[\s\S]*min-height: 44px/);
		expect(base).toMatch(/min-width: 44px/);
		// In `@layer base`, so utilities on an element still win.
		expect(css.indexOf("@layer base")).toBeGreaterThan(-1);
	});

	it("never applies the floor at desktop widths with a fine pointer", () => {
		// Every 44px rule sits inside a touch media query or the `.menu-sheet`
		// phone block; none is unconditional.
		const unconditional = css
			.split(/@media[^{]+\{/)[0]
			.match(/min-height:\s*44px/g);
		expect(unconditional).toBeNull();
	});
});

describe("safe areas and PWA head", () => {
	const root = read("app/root.tsx");

	it("draws edge to edge and pads with env(safe-area-inset-*)", () => {
		expect(root).toContain("viewport-fit=cover");
		const css = read("app/index.css");
		for (const side of ["top", "bottom", "left", "right"]) {
			expect(css).toContain(`env(safe-area-inset-${side}, 0px)`);
		}
	});

	it("sets theme-color for both schemes and an apple-touch-icon", () => {
		expect(root).toMatch(/name="theme-color"\s+media="\(prefers-color-scheme: light\)"/);
		expect(root).toMatch(/name="theme-color"\s+media="\(prefers-color-scheme: dark\)"/);
		expect(root).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
		const icon = readFileSync(new URL("../public/apple-touch-icon.png", import.meta.url));
		expect(icon.subarray(12, 16).toString("ascii")).toBe("IHDR");
		expect(icon.readUInt32BE(16)).toBe(180);
		expect(icon.readUInt32BE(20)).toBe(180);
	});
});

describe("mobile mail chrome", () => {
	it("has Compose in the phone tab bar, which steps aside while reading", () => {
		// Was a floating button over the list; the app tab bar carries it now.
		const nav = read("app/components/AppNav.tsx");
		expect(nav).toContain('aria-label="Compose"');
		expect(nav).toContain("pb-safe");
		expect(read("app/routes/app-shell.tsx")).toContain("{!reading && <AppTabBar");
	});

	it("pins Reply, Reply all, Forward, Archive and More to the bottom of the reader", () => {
		const toolbar = read("app/components/mail/MessageToolbar.tsx");
		const bar = toolbar.slice(toolbar.indexOf('aria-label="Message actions"'));
		expect(bar).toContain("md:hidden");
		for (const label of ['label="Reply"', 'label="Reply all"', 'label="Forward"', 'aria-label="More actions"']) {
			expect(bar).toContain(label);
		}
		expect(toolbar).toContain('label="Back to list"');
	});

	it("opens the composer full screen below sm, portalled above the top bar", () => {
		const win = read("app/components/mail/ComposeWindow.tsx");
		expect(win).toMatch(/compact:\s*\n?\s*"inset-0 h-dvh w-full/);
		expect(win).toContain("createPortal(frame, document.body)");
	});

	it("turns menus into bottom sheets on phones", () => {
		expect(read("app/components/ui/dropdown-menu.tsx")).toContain('"menu-sheet ');
		expect(read("app/index.css")).toMatch(/\.menu-sheet\s*\{[\s\S]*border-radius: 16px 16px 0 0/);
	});

	it("names the folder once on a phone: in the module bar, not again in the list header", () => {
		// The mail route's module bar shows the folder ("Inbox ▾"); a folder list
		// keeps its header title for screen readers only below md.
		expect(read("app/routes/mail.tsx")).toMatch(/<ModuleBar\s+label=\{here\}/);
		expect(read("app/routes/mail-folder.tsx")).toMatch(/<MailList[\s\S]*?titleInModuleBar[\s\S]*?\/>/);
		const list = read("app/components/mail/MailList.tsx");
		expect(list).toMatch(/titleInModuleBar && "max-md:sr-only"/);
		expect(list).toContain("titleInModuleBar = false");
	});

	it("keeps swipe and pull-to-refresh touch-only", () => {
		expect(read("app/hooks/useSwipeRow.ts")).toContain('e.pointerType !== "touch"');
		expect(read("app/components/mail/MailList.tsx")).toContain("overscroll-y-contain");
	});
});

describe("dashboard loading state", () => {
	it("shows a skeleton, not 'No mailboxes yet', before the first fetch", async () => {
		const src = read("app/routes/inboxes.tsx");
		const skeleton = src.indexOf("<MailboxListSkeleton />");
		const empty = src.indexOf("No mailboxes yet");
		expect(skeleton).toBeGreaterThan(-1);
		// The skeleton branch is tested first.
		expect(skeleton).toBeLessThan(empty);
		expect(src).toMatch(/\{!isFetched \? \(\s*<MailboxListSkeleton \/>/);
	});
});

describe("analytics on a phone", () => {
	it("lists table rows as cards below sm instead of a sideways-scrolling table", async () => {
		const { ResponsiveTable } = await import("~/components/analytics/primitives");
		const html = renderToStaticMarkup(
			h(ResponsiveTable<{ name: string; n: number }>, {
				caption: "Senders",
				rows: [{ name: "support@tapetide.com", n: 11 }],
				rowKey: (r) => r.name,
				columns: [
					{ key: "name", header: "From", primary: true, cell: (r) => r.name },
					{ key: "n", header: "Sent", align: "right", cell: (r) => String(r.n) },
				],
			}),
		);
		expect(html).toContain('class="divide-y divide-border sm:hidden"');
		expect(html).toContain("hidden overflow-x-auto sm:block");
		// The phone layout labels each value, since there is no header row.
		expect(html).toMatch(/<dt[^>]*>Sent<\/dt>/);
	});
	it("uses the shared responsive table on the analytics page", () => {
		const src = [
			read("app/components/analytics/sending.tsx"),
			read("app/components/analytics/sections.tsx"),
		].join("\n");
		expect(src).toContain("<ResponsiveTable");
		expect(src).not.toMatch(/<table/);
	});
});

describe("settings section picker", () => {
	it("is a module bar on phones (as Mail's folders) rather than a scrolling chip strip", async () => {
		const { SettingsLayout } = await import("~/components/settings/SettingsLayout");
		const { MemoryRouter } = await import("react-router");
		const html = renderToStaticMarkup(
			h(
				QueryClientProvider,
				{ client: new QueryClient() },
				h(
					MemoryRouter,
					{ initialEntries: ["/settings/a"] },
					h(SettingsLayout, {
						basePath: "/settings",
						active: "a",
						items: [
							{ id: "a", label: "Alpha", content: "A" },
							{ id: "b", label: "Beta", content: "B" },
						],
					}),
				),
			),
		);
		// Phone-only bar naming the section; from `md` the module pane takes over.
		expect(html).toMatch(/data-module-bar[^>]*md:hidden/);
		expect(html).toContain('aria-label="Settings section: Settings · Alpha"');
		expect(html).toContain("data-module-pane");
		// Mail's phone bar is the same component.
		expect(read("app/routes/mail.tsx")).toContain("<ModuleBar");
		// No horizontal scroller left in the nav.
		expect(html).not.toContain("overflow-x-auto");
		// Each section is its own page: routed links, and only the active one renders.
		expect(html).toContain('href="/settings/b"');
		expect(html).toContain('aria-current="page"');
		expect(html).not.toContain(">B<");
	});
});
