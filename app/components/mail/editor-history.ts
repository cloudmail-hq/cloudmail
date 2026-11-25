/**
 * Undo history around content the composer puts into the editor.
 *
 * A body loaded from outside (a draft, a reply opening) is not an edit: Cmd+Z
 * must not take it back out, and must not reach the draft that was open in the
 * same composer before it. A change the host makes to the open body (a
 * signature arriving late, or swapped for another From) is not an edit either,
 * and it must not move the caret or drop what the user can undo. An insert the
 * user asks for (a template, a signature) is one edit: one Cmd+Z removes all
 * of it, and nothing typed just before or after it rides along.
 */

import { createDocument, type Editor, type Range } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { EditorState, Selection, TextSelection } from "@tiptap/pm/state";

/**
 * Load a new document: no `update` event (so no autosave), no undo step, an
 * empty history, and the caret at the start.
 *
 * The content goes in through a transaction first, so plugins that append to
 * it (the trailing paragraph) still run. ProseMirror's history has no reset
 * command; its documented way is a fresh state with the same plugins, which
 * re-creates every plugin's state from the new document. The editor keeps its
 * view, focus and DOM.
 */
export function replaceContent(editor: Editor, html: string): void {
	editor.chain().setMeta("addToHistory", false).setContent(html, { emitUpdate: false }).run();
	clearHistory(editor);
}

/** Empty the undo history and put the caret at the start, keeping the document. */
export function clearHistory(editor: Editor): void {
	const { state, view } = editor;
	view.updateState(
		EditorState.create({ doc: state.doc, plugins: state.plugins, selection: Selection.atStart(state.doc) }),
	);
}

/**
 * Bring the open document to `html` by replacing only the part that differs,
 * outside the undo history and without an `update` event. The caret and the
 * history map through the change, so the user keeps typing where they were
 * and Cmd+Z still undoes their own typing.
 */
export function patchContent(editor: Editor, html: string): void {
	const { state } = editor;
	const next = createDocument(html, editor.schema, editor.options.parseOptions);
	const start = state.doc.content.findDiffStart(next.content);
	if (start == null) return;
	const end = state.doc.content.findDiffEnd(next.content);
	if (!end) return;
	let { a: endA, b: endB } = end;
	// For an insert or delete at a repeated run, the end scan overshoots the
	// start; move both ends past it.
	const overlap = start - Math.min(endA, endB);
	if (overlap > 0) {
		endA += overlap;
		endB += overlap;
	}
	let tr = state.tr.replace(start, endA, next.slice(start, endB));
	if (!tr.doc.eq(next)) {
		// The slice didn't fit back as the same structure; replace the whole
		// document and keep the caret near where it was.
		const caret = state.selection.from;
		tr = state.tr.replaceWith(0, state.doc.content.size, next.content);
		tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caret, tr.doc.content.size))));
	}
	editor.view.dispatch(tr.setMeta("addToHistory", false).setMeta("preventUpdate", true));
}

/**
 * Where the writer's own text ends: the end of the last line before the
 * signature block, or before a reply's quote at the bottom, or the end of the
 * document when it has neither. A reopened draft continues from here rather
 * than inside its signature or the quoted original.
 */
export function endOfMessageText(doc: ProseMirrorNode): number {
	let boundary = doc.childCount;
	for (let i = 0; i < doc.childCount; i++) {
		if (doc.child(i).type.name === "signatureBlock") {
			boundary = i;
			break;
		}
	}
	if (boundary === doc.childCount) {
		// A quote at the bottom, ignoring the empty lines after it.
		let last = doc.childCount - 1;
		while (last >= 0 && doc.child(last).type.name === "paragraph" && doc.child(last).content.size === 0) last--;
		if (last > 0 && doc.child(last).type.name === "blockquote") boundary = last;
	}
	if (boundary === 0) return Selection.atStart(doc).from;
	let pos = 0;
	for (let i = 0; i < boundary; i++) pos += doc.child(i).nodeSize;
	return Selection.near(doc.resolve(pos), -1).from;
}

/** Start a new undo group, so the next change can't merge into the last one. */
export function endUndoGroup(editor: Editor): void {
	if (editor.isDestroyed) return;
	editor.view.dispatch(closeHistory(editor.state.tr));
}

/**
 * Insert `html` at `at` (a position, or a range it replaces) as an undo step
 * of its own, and focus the editor. The caret ends after the insert unless
 * `keepCaret` is set.
 */
export function insertAsOneStep(
	editor: Editor,
	at: number | Range,
	html: string,
	{ keepCaret = false }: { keepCaret?: boolean } = {},
): boolean {
	const done = editor
		.chain()
		.focus()
		.command(({ tr }) => {
			closeHistory(tr);
			return true;
		})
		.insertContentAt(at, html, { updateSelection: !keepCaret })
		.run();
	endUndoGroup(editor);
	return done;
}
