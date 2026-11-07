/**
 * `;snippet` expansion and `{{variable}}` placeholders for the composer.
 *
 * Two ProseMirror plugins in one extension:
 *
 * - A TipTap suggestion on `;`. The popup itself is React (`SnippetMenu`); this
 *   side only reports open / query / position and forwards the arrow keys, so
 *   the extension stays free of rendering.
 * - A decoration over every `{{name}}` left in the document, plus Tab and
 *   Shift+Tab to select them in turn. Decorations rather than a mark, so the
 *   highlight never reaches the sent HTML and nothing typed over a placeholder
 *   inherits it.
 *
 * What triggers, how variables are filled and where Tab goes are pure functions
 * in `~/lib/snippets`, tested without an editor.
 */

import { Extension, type Editor, type Range } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import Suggestion, { exitSuggestion } from "@tiptap/suggestion";
import {
	PLACEHOLDER_CLASS,
	SNIPPET_CHAR,
	VARIABLE_PATTERN,
	fillTemplate,
	matchSnippetTrigger,
	nextPlaceholder,
	type SnippetTemplate,
} from "~/lib/snippets";

export const snippetPluginKey = new PluginKey("snippet-suggestion");
const placeholderPluginKey = new PluginKey("snippet-placeholders");

/** What the React popup needs to render. */
export interface SnippetMenuState {
	open: boolean;
	query: string;
	range: Range | null;
	/** Caret rectangle, for positioning. */
	rect: DOMRect | null;
}

export interface SnippetHandlers {
	/** Popup state changed. */
	onState: (state: SnippetMenuState) => void;
	/** Arrow / Enter / Tab while the popup is open. True when handled. */
	onKey: (event: KeyboardEvent) => boolean;
}

export interface SnippetOptions {
	/**
	 * Called on every keystroke, so the editor doesn't need rebuilding when
	 * templates load or the recipient changes.
	 *
	 * A function, not a ref object: `Extension.configure` deep-merges options,
	 * which copies a `{ current }` object and freezes it at its value at
	 * configure time (null). Functions are passed through as they are.
	 */
	getHandlers: () => SnippetHandlers | null;
}

/** Every `{{name}}` in the document, as document positions. */
export function placeholderRanges(doc: PMNode): { from: number; to: number }[] {
	const ranges: { from: number; to: number }[] = [];
	doc.descendants((node, pos) => {
		if (!node.isText || !node.text) return;
		for (const match of node.text.matchAll(VARIABLE_PATTERN)) {
			if (match.index === undefined) continue;
			ranges.push({ from: pos + match.index, to: pos + match.index + match[0].length });
		}
	});
	return ranges;
}

/** Select the first placeholder at or after `from`. True when there was one. */
export function selectPlaceholderFrom(editor: Editor, from: number): boolean {
	const target = placeholderRanges(editor.state.doc).find((r) => r.from >= from);
	if (!target) return false;
	editor.view.dispatch(
		editor.state.tr
			.setSelection(TextSelection.create(editor.state.doc, target.from, target.to))
			.scrollIntoView(),
	);
	return true;
}

/**
 * Replace `range` (the `;query` text, or an empty range at the caret) with a
 * filled template, then select its first unfilled placeholder.
 */
export function insertSnippet(
	editor: Editor,
	range: Range,
	template: SnippetTemplate,
	variables: Record<string, string>,
): void {
	const { html, unfilled } = fillTemplate(template.bodyHtml, variables);
	editor.chain().focus().insertContentAt(range, html).run();
	if (unfilled.length > 0) selectPlaceholderFrom(editor, range.from);
}

export const SnippetExtension = Extension.create<SnippetOptions>({
	name: "snippets",

	// Above the list extensions, whose Tab indents a list item: inside a list,
	// a pending placeholder is the more specific intent.
	priority: 1000,

	addOptions() {
		return { getHandlers: () => null };
	},

	addKeyboardShortcuts() {
		const step = (direction: 1 | -1) => () => {
			const { state, view } = this.editor;
			const target = nextPlaceholder(
				placeholderRanges(state.doc),
				{ from: state.selection.from, to: state.selection.to },
				direction,
			);
			if (!target) return false;
			view.dispatch(
				state.tr
					.setSelection(TextSelection.create(state.doc, target.from, target.to))
					.scrollIntoView(),
			);
			return true;
		};
		return { Tab: step(1), "Shift-Tab": step(-1) };
	},

	addProseMirrorPlugins() {
		const getHandlers = this.options.getHandlers;
		const editor = this.editor;
		const closed: SnippetMenuState = { open: false, query: "", range: null, rect: null };

		const suggestion = Suggestion({
			editor,
			pluginKey: snippetPluginKey,
			char: SNIPPET_CHAR,
			// The trigger rule is ours (`matchSnippetTrigger`): start of block or
			// after whitespace, so "a; b" and "&amp;" never open the menu.
			findSuggestionMatch: ({ $position }) => {
				const parent = $position.parent;
				if (!parent.isTextblock) return null;
				const before = parent.textBetween(0, $position.parentOffset, undefined, "￼");
				const match = matchSnippetTrigger(before);
				if (!match) return null;
				const start = $position.start();
				const from = start + match.from;
				const to = $position.pos;
				return { range: { from, to }, query: match.query, text: before.slice(match.from) };
			},
			render: () => {
				const publish = (props: { query: string; range: Range; clientRect?: (() => DOMRect | null) | null }) =>
					getHandlers()?.onState({
						open: true,
						query: props.query,
						range: props.range,
						rect: props.clientRect?.() ?? null,
					});
				return {
					onStart: publish,
					onUpdate: publish,
					onExit: () => getHandlers()?.onState(closed),
					onKeyDown: ({ event }) => {
						// A key the picker uses must stop here: the composer
						// minimises on Escape and sends on ⌘↵ from a React
						// listener further up, which would otherwise see it too.
						if (event.key === "Escape") {
							event.stopPropagation();
							getHandlers()?.onState(closed);
							// After this handler returns, so the plugin's own state
							// update isn't dispatched from inside its keydown.
							queueMicrotask(() => {
								if (!editor.isDestroyed) exitSuggestion(editor.view, snippetPluginKey);
							});
							return true;
						}
						const handled = getHandlers()?.onKey(event) ?? false;
						if (handled) event.stopPropagation();
						return handled;
					},
				};
			},
		});

		const placeholders = new Plugin({
			key: placeholderPluginKey,
			props: {
				decorations(state) {
					const ranges = placeholderRanges(state.doc);
					if (ranges.length === 0) return null;
					return DecorationSet.create(
						state.doc,
						ranges.map((r) =>
							Decoration.inline(r.from, r.to, {
								class: PLACEHOLDER_CLASS,
								// Read out as what it is, not as brace punctuation.
								"aria-label": "placeholder",
							}),
						),
					);
				},
			},
		});

		return [suggestion, placeholders];
	},
});

/** Close the popup from outside (after an insert, say). */
export function closeSnippetMenu(editor: Editor): void {
	exitSuggestion(editor.view, snippetPluginKey);
}
