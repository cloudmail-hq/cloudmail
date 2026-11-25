/**
 * HTML on its way into and out of the composer's editor.
 *
 * Mail HTML marks an empty line as `<p><br></p>` (Gmail and Apple Mail write
 * `<div><br></div>`), because an empty `<p></p>` collapses to nothing in some
 * clients. ProseMirror reads that `<br>` as a line break inside the paragraph,
 * so a blank line opened as a two-line gap, and typing on it went after an
 * invisible break, which also stopped "- " and "1. " from starting a list. A
 * `<br>` that ends a block is the same: browsers draw nothing for it, the
 * editor drew an extra line.
 *
 * So the editor reads empty lines as empty paragraphs and writes them back as
 * `<p><br></p>`, and a body makes the round trip through it unchanged.
 */

const EMPTY_DIV_LINE = /<div(\s[^>]*)?>\s*<br\s*\/?>\s*<\/div>/gi;
const TRAILING_BREAK = /<br\s*\/?>\s*(<\/(?:p|div|li|h[1-6])>)/gi;
const EMPTY_PARAGRAPH = /<p(\s[^>]*)?><\/p>/g;
const TRAILING_EMPTY_PARAGRAPHS = /(?:<p(?:\s[^>]*)?>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>\s*)+$/i;

/** HTML as the editor should load it: empty lines as empty paragraphs. */
export function normalizeEditorInput(html: string): string {
	return html
		.replace(EMPTY_DIV_LINE, (match, attrs: string | undefined) =>
			attrs && /email-signature/.test(attrs) ? match : "<p></p>",
		)
		.replace(TRAILING_BREAK, "$1");
}

/** Empty paragraphs as `<p><br></p>`, which every mail client draws as a line. */
export function serializeEditorHtml(html: string): string {
	return html.replace(EMPTY_PARAGRAPH, (_match, attrs: string | undefined) => `<p${attrs ?? ""}><br></p>`);
}

/**
 * Drop empty paragraphs at the very end. The editor keeps one after a
 * signature or quote so there is somewhere to click; the message doesn't
 * need it.
 */
export function trimTrailingEmptyParagraphs(html: string): string {
	return html.replace(TRAILING_EMPTY_PARAGRAPHS, "");
}

/**
 * The editor's content as the composer stores and sends it. Every host
 * compares against this form, so a body the editor only loaded is not an edit.
 */
export function editorBodyHtml(editor: { getHTML(): string }): string {
	return trimTrailingEmptyParagraphs(serializeEditorHtml(editor.getHTML()));
}
