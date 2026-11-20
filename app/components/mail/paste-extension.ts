/**
 * Composer paste handling and the formatting guards that go with it.
 *
 * - `PasteCleanup` runs every paste through `~/lib/paste-clean`: HTML loses
 *   its presentation and keeps its structure; plain text becomes Markdown
 *   structure, one code block (terminal output) or paragraphs. Shift-paste
 *   (Cmd/Ctrl+Shift+V) stays exactly the characters pasted. It remembers the
 *   raw clipboard for the last paste, outside the document and the undo
 *   history, so the composer can offer "Keep original formatting" and "Paste
 *   as plain text" for that range until the next edit.
 * - `SafeColor` and `SafeHighlight` replace `Color` and `Highlight`. They
 *   keep colours set through commands, but parse only readable ones from HTML
 *   (drafts, templates, AI drafts, quoted replies), and a highlight always
 *   carries a fixed dark text colour so it reads in both themes.
 * - `ClearFormatting`: Cmd/Ctrl+\ removes marks (links stay) and alignment.
 */

import { Extension, type Editor, type Range } from "@tiptap/core";
import { Color } from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import { TextStyle } from "@tiptap/extension-text-style";
import { DOMParser as SchemaParser } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import {
	classifyPlainText,
	cleanPastedHtml,
	markdownToHtml,
	parseCssColor,
	plainTextToHtml,
	readableStoredColor,
	terminalToHtml,
	type PasteKind,
} from "~/lib/paste-clean";

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		clearFormatting: {
			/** Remove every mark except links, and reset alignment. Empty selection: the current block. */
			clearFormatting: () => ReturnType;
		};
	}
}

// ── Paste ──────────────────────────────────────────────────────────

export interface PastedInfo {
	/** Changes for every paste, so a stale toast can tell it is stale. */
	id: number;
	kind: PasteKind;
	/** Presentational declarations and elements the cleanup dropped. */
	removed: number;
	/** Pasted `data:` images left out for being over the size ceiling. */
	droppedImages: number;
	/** Shift-paste: the user asked for exactly the characters. */
	plain: boolean;
	raw: { html: string; text: string };
}

interface PasteState {
	info: PastedInfo;
	range: Range;
}

export const pasteCleanupKey = new PluginKey<PasteState | null>("pasteCleanup");

/** Set on transactions that replace the last paste from the toast. */
export const PASTE_REPLACE_META = "pasteCleanupReplace";

export interface PasteCleanupOptions {
	/** After a paste the cleanup changed: formatting dropped, or text converted. */
	onPasted: ((info: PastedInfo, editor: Editor) => void) | null;
	/** The pasted range was edited or replaced; any offer about it is void. */
	onPasteSettled: ((id: number) => void) | null;
}

/** Whether a paste looks different from its source, so the user may want it back. */
export function pasteChangedSomething(info: PastedInfo): boolean {
	if (info.droppedImages > 0) return true;
	if (info.plain) return false;
	if (info.kind === "markdown" || info.kind === "terminal") return true;
	return info.kind === "html" && info.removed > 0;
}

function inertBody(html: string): HTMLElement {
	return new window.DOMParser().parseFromString(html, "text/html").body;
}

export const PasteCleanup = Extension.create<PasteCleanupOptions>({
	name: "pasteCleanup",
	// Ahead of Link's and CodeBlock's paste handlers, so it sees every paste.
	priority: 1100,

	addOptions() {
		return { onPasted: null, onPasteSettled: null };
	},

	addProseMirrorPlugins() {
		const options = this.options;
		const editor = this.editor;
		let nextId = 1;
		/** What the parse step found, picked up by handlePaste for the same paste. */
		let parsed: { kind: PasteKind; removed: number; plain: boolean; droppedImages: number } | null = null;
		/** Filled by handlePaste, consumed by the paste transaction. */
		let pending: PastedInfo | null = null;

		return [
			new Plugin<PasteState | null>({
				key: pasteCleanupKey,
				state: {
					init: () => null,
					apply(tr: Transaction, value, oldState: EditorState, newState: EditorState) {
						if (tr.getMeta("uiEvent") === "paste" && pending) {
							const info = pending;
							pending = null;
							const from = tr.mapping.map(oldState.selection.from, -1);
							const to = Math.max(from, newState.selection.from);
							return { info, range: { from, to } };
						}
						if (!value) return null;
						if (tr.getMeta(PASTE_REPLACE_META)) return null;
						// Plugins' follow-up steps (autolink, trailing paragraph) are part of
						// the same paste: follow the range. Any other edit ends the offer.
						if (tr.docChanged && tr.getMeta("appendedTransaction")) {
							return {
								info: value.info,
								range: { from: tr.mapping.map(value.range.from, -1), to: tr.mapping.map(value.range.to, 1) },
							};
						}
						if (tr.docChanged) return null;
						return value;
					},
				},
				props: {
					transformPastedText(text, plain) {
						parsed = { kind: "text", removed: 0, plain, droppedImages: 0 };
						return text;
					},
					transformPastedHTML(html) {
						const result = cleanPastedHtml(html);
						parsed = { kind: result.kind, removed: result.removed, plain: false, droppedImages: result.droppedImages };
						return result.html;
					},
					clipboardTextParser(text, $context, plain, view) {
						const kind = plain ? "text" : classifyPlainText(text);
						parsed = { kind, removed: 0, plain, droppedImages: 0 };
						const html =
							kind === "markdown"
								? markdownToHtml(text)
								: kind === "terminal"
									? terminalToHtml(text)
									: plainTextToHtml(text);
						return SchemaParser.fromSchema(view.state.schema).parseSlice(inertBody(html), {
							context: $context,
						});
					},
					handlePaste(view, event, slice) {
						const data = (event as ClipboardEvent).clipboardData;
						const found = parsed;
						parsed = null;
						// Shift-paste means exactly these characters. Insert it ourselves,
						// without the `uiEvent: paste` meta, so TipTap's paste rules
						// (`**bold**`, autolink) leave it alone. Code blocks already get raw
						// text from ProseMirror and keep the default path.
						if (found?.plain && !view.state.selection.$from.parent.type.spec.code && slice.size > 0) {
							pending = null;
							view.dispatch(
								view.state.tr
									.replaceSelection(slice)
									.scrollIntoView()
									.setMeta("paste", true)
									.setMeta("preventAutolink", true),
							);
							return true;
						}
						pending = found
							? {
									id: nextId++,
									...found,
									raw: {
										html: data?.getData("text/html") ?? "",
										text: data?.getData("text/plain") ?? "",
									},
								}
							: null;
						return false;
					},
				},
				view: () => ({
					update(view, prevState) {
						const now = pasteCleanupKey.getState(view.state);
						const before = pasteCleanupKey.getState(prevState);
						if (now === before) return;
						if (before && before.info.id !== now?.info.id) options.onPasteSettled?.(before.info.id);
						if (now && pasteChangedSomething(now.info)) {
							const info = now.info;
							// Out of the update cycle: the callback may dispatch.
							queueMicrotask(() => options.onPasted?.(info, editor));
						}
					},
				}),
			}),
		];
	},
});

/**
 * Replace the last paste with other content (the toast's actions). Returns
 * false when that paste has since been edited, in which case nothing happens.
 */
export function replaceLastPaste(editor: Editor, id: number, html: string): boolean {
	const state = pasteCleanupKey.getState(editor.state);
	if (!state || state.info.id !== id) return false;
	return editor
		.chain()
		.focus()
		.insertContentAt(state.range, html, { parseOptions: { preserveWhitespace: false } })
		.setMeta(PASTE_REPLACE_META, true)
		.setMeta("preventAutolink", true)
		.run();
}

// ── Colour ─────────────────────────────────────────────────────────

/** The last `color` declaration in an element's style attribute. */
function declaredColor(element: HTMLElement): string | null {
	const style = element.getAttribute("style");
	if (!style) return null;
	let found: string | null = null;
	for (const decl of style.split(";")) {
		const i = decl.indexOf(":");
		if (i > 0 && decl.slice(0, i).trim().toLowerCase() === "color") found = decl.slice(i + 1).trim();
	}
	return found;
}

/**
 * `Color`, parsing only colours that read on both light and dark backgrounds.
 * Paste never gets here with a colour (the cleanup strips them); this covers
 * HTML loaded through `setContent`. Colours applied with `setColor` are
 * stored as given.
 */
export const SafeColor = Color.extend({
	addGlobalAttributes() {
		return [
			{
				types: this.options.types,
				attributes: {
					color: {
						default: null,
						parseHTML: (element: HTMLElement) => readableStoredColor(declaredColor(element)),
						renderHTML: (attributes: { color?: string | null }) =>
							attributes.color ? { style: `color: ${attributes.color}` } : {},
					},
				},
			},
		];
	},
});

/** Text colour inside a highlight, fixed so a highlight reads in either theme and any reader. */
export const HIGHLIGHT_TEXT_COLOR = "#1a1a1a";

/**
 * `Highlight` with a pinned dark text colour. TipTap renders `color: inherit`,
 * which turns into light text on a yellow background in a dark composer or
 * reader. Only parseable colours are read back from HTML.
 */
export const SafeHighlight = Highlight.extend({
	addAttributes() {
		if (!this.options.multicolor) return {};
		return {
			color: {
				default: null,
				parseHTML: (element: HTMLElement) => {
					const value = element.getAttribute("data-color") || element.style.backgroundColor;
					return value && parseCssColor(value) ? value : null;
				},
				renderHTML: (attributes: { color?: string | null }) =>
					attributes.color
						? {
								"data-color": attributes.color,
								style: `background-color: ${attributes.color}; color: ${HIGHLIGHT_TEXT_COLOR}`,
							}
						: { style: `color: ${HIGHLIGHT_TEXT_COLOR}` },
			},
		};
	},
});

/**
 * `TextStyle` that only claims spans carrying a colour we keep. Stock
 * TextStyle claims every `span[style]`, so a draft full of Docs or Word spans
 * came back as empty `<span>` wrappers once their colours were dropped.
 * Colour is the only textStyle attribute this editor loads.
 */
export const SafeTextStyle = TextStyle.extend({
	parseHTML() {
		return [
			{
				tag: "span",
				consuming: false,
				getAttrs: (element: HTMLElement) => (readableStoredColor(declaredColor(element)) ? {} : false),
			},
		];
	},
});

// ── Clear formatting ───────────────────────────────────────────────

export const ClearFormatting = Extension.create({
	name: "clearFormatting",

	addCommands() {
		return {
			clearFormatting:
				() =>
				({ state, tr, dispatch }) => {
					const { selection, schema, doc } = state;
					let { from, to } = selection;
					if (selection.empty) {
						from = selection.$from.start();
						to = selection.$from.end();
					}
					if (dispatch) {
						for (const mark of Object.values(schema.marks)) {
							if (mark.name !== "link") tr.removeMark(from, to, mark);
						}
						doc.nodesBetween(from, to, (node, pos) => {
							if (node.isTextblock && node.attrs.textAlign) {
								tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: null });
							}
						});
						tr.setStoredMarks([]);
					}
					return true;
				},
		};
	},

	addKeyboardShortcuts() {
		return { "Mod-\\": () => this.editor.commands.clearFormatting() };
	},
});

// ── Links ──────────────────────────────────────────────────────────

/**
 * Autolink only what is unmistakably a link: a URL with http(s), a `www.`
 * host, or an email address (becomes mailto). Code-like tokens such as
 * `env.DEV_AUTH_BYPASS` or `config.json` stay text.
 */
export function shouldAutoLink(url: string): boolean {
	if (/^(https?:\/\/|mailto:)/i.test(url)) return true;
	if (/^www\.[^\s.]+\.[^\s]+/i.test(url)) return true;
	return /^[^\s@/:]+@[^\s@/:]+\.[a-z]{2,}$/i.test(url);
}

export const LINK_OPTIONS = {
	openOnClick: false,
	defaultProtocol: "https",
	shouldAutoLink,
} as const;
