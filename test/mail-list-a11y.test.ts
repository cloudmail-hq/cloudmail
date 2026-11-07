import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import MailList from "~/components/mail/MailList";

// `getSnippetText` -> `stripHtml` reaches for `DOMParser`, which the project's
// node-environment Vitest config does not provide. The snippets here are plain
// text, so tag-stripping is all the shim owes it.
//
// Cast because assigning a stub onto the global object is exactly the case the
// compiler cannot express: nothing to validate at runtime, and the real
// `DOMParser` interface is far wider than the one method under test.
const globals = globalThis as typeof globalThis & { DOMParser: unknown };
globals.DOMParser = class {
	parseFromString(html: string) {
		return { body: { textContent: html.replace(/<[^>]*>/g, "") } };
	}
};

/**
 * The UI store is mocked rather than driven with `setState`.
 *
 * Zustand v5 hands `useSyncExternalStore` `getInitialState` as the server
 * snapshot, so under `renderToStaticMarkup` a `setState` before the render is
 * invisible and every row would report no cursor and nothing ticked. Mocking the
 * hook is what lets this assert the cursor markup at all.
 */
const state = vi.hoisted(() => ({
	current: {
		selectedEmailId: null as string | null,
		cursorEmailId: null as string | null,
		selectionAnchorId: null as string | null,
		checkedEmailIds: [] as string[],
	},
}));

vi.mock("~/hooks/useUIStore", () => ({
	useUIStore: () => ({
		...state.current,
		selectEmail: () => {},
		closePanel: () => {},
		setNavigableRows: () => {},
		setCursorEmailId: () => {},
		toggleChecked: () => {},
		setCheckedEmailIds: () => {},
		clearChecked: () => {},
	}),
}));

const email = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	mailbox_id: "mb",
	sender: `${id}@example.com`,
	recipient: "me@example.com",
	subject: `Subject ${id}`,
	snippet: `Snippet body for ${id}`,
	date: "2026-08-20T00:00:00.000Z",
	read: false,
	starred: false,
	folder: "inbox",
	...over,
});

function render(cursorId: string | null, checked: string[] = []) {
	state.current = {
		selectedEmailId: null,
		cursorEmailId: cursorId,
		selectionAnchorId: null,
		checkedEmailIds: checked,
	};
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return renderToStaticMarkup(
		h(
			QueryClientProvider,
			{ client: qc },
			h(MailList as never, {
				mailboxId: "mb",
				title: "Inbox",
				emails: [
					email("a"),
					email("b"),
					email("c", { delivery_status: "failed" }),
				],
				totalCount: 3,
				isRefreshing: false,
				page: 1,
				onPageChange: () => {},
				onRefresh: () => {},
				empty: null,
				collectionKey: "folder:inbox",
			}),
		),
	);
}

it("renders the list as an ARIA listbox naming the cursor row", () => {
	const html = render("b", ["a"]);

	expect(html).toContain('role="listbox"');
	expect(html).toContain('aria-multiselectable="true"');
	expect(html).toContain('aria-label="Inbox — 3 conversations"');
	// The cursor row is named, and by the collection-scoped id.
	expect(html).toContain('aria-activedescendant="mailrow-folder:inbox-b"');
	expect(html).toContain('id="mailrow-folder:inbox-b"');

	// Every row is an option, and only the ticked one reports selected.
	expect(html.match(/role="option"/g)).toHaveLength(3);
	expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
	expect(html.match(/aria-selected="false"/g)).toHaveLength(2);

	// One tab stop for the whole list, never one per row.
	expect(html.match(/tabindex="0"/g)).toHaveLength(1);
	// The old per-row `role="button"` is gone.
	expect(html).not.toContain('role="button"');
});

it("gives the cursor row a marker distinct from open and checked", () => {
	const cursorAndChecked = render("b", ["b"]);
	const rows = cursorAndChecked.split('role="option"').slice(1);

	// Ring plus solid rail: two cues, so the cursor survives high-contrast modes
	// and rows already tinted by the open state.
	expect(rows[1]).toContain("ring-2 ring-inset ring-ring");
	expect(rows[1]).toContain("absolute inset-y-0 left-0 w-[3px] bg-ring");
	expect(rows[0]).not.toContain("ring-2 ring-inset ring-ring");

	// The cursor has no fill of its own any more — ring and rail mark it — so a
	// row that is both cursor and checked keeps the selection tint underneath.
	expect(rows[1]).toContain("bg-accent-subtle/60");
	expect(rows[1]).toContain('aria-selected="true"');
	expect(rows[1]).toContain('checked=""');

	// Checked without the cursor gets the selection tint.
	const checkedOnly = render(null, ["b"]);
	expect(checkedOnly.split('role="option"')[2]).toContain("bg-accent-subtle/60");

	// The open row's violet treatment is untouched by all of this.
	expect(rows[1]).not.toContain("border-l-violet");
});

it("shows hover actions on the cursor row so a keyboard reaches them", () => {
	const html = render("b");
	const rows = html.split('role="option"').slice(1);
	expect(rows).toHaveLength(3);
	// Cursor row's action cluster is flex; the others stay hidden.
	expect(rows[1]).toContain("group-hover:flex flex");
	expect(rows[0]).toContain("group-hover:flex hidden");
	expect(rows[2]).toContain("group-hover:flex hidden");
});

it("keeps main's density, preview and delivery behaviour", () => {
	const html = render(null);
	// cozy default geometry survived the a11y merge.
	expect(html).toContain("gap-3 pl-5 pr-3 py-2.5");
	// previewText default true draws the snippet.
	expect(html).toContain("Snippet body for a");
	// #44's bounce cue, still labelled (React escapes the apostrophe).
	expect(html).toContain("aria-label=\"Couldn&#x27;t be sent\"");
	// No cursor => nothing named, and no row claims to be current.
	expect(html).not.toContain("aria-activedescendant");
});

it("meets the SC 2.5.8 24px floor on every row action", () => {
	const html = render("b");
	// The inline star came out of the row in #75; starring now lives in the
	// filter bar and the cursor row's More menu, so there is no per-row star
	// target left for this floor to apply to. Asserting its 24px box here
	// would only re-test a control the row no longer renders.
	//
	// Whatever the row does render still has to clear 24px, and nothing may
	// reintroduce the 17x17 target that `p-0.5` around a 13px glyph produced.
	expect(html).not.toContain("shrink-0 p-0.5");
	// Checkbox: 16px control padded out to 24px.
	expect(html).toContain("h-4 w-4 cursor-pointer accent-violet box-content p-1");
	// Action buttons carry the floor beside their density size.
	expect(html).toContain("h-6 w-6 min-h-6 min-w-6");
	// The icons themselves did not grow.
	expect(html).toContain('width="13" height="13"');
});
