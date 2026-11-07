/**
 * Template variables for the editor: detection, sample values and preview
 * substitution.
 *
 * Matches the server's `{{word}}` syntax (`workers/lib/templates.ts`), so the
 * preview shows exactly the placeholders a send would fill. Unknown variables
 * are left as written, as the server does.
 */

export const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

/** Variables offered as chips even before the template uses them. */
export const COMMON_VARIABLES = ["first_name", "company_name", "unsubscribe_url"] as const;

/** Plausible values so a preview reads like a real message. */
export const SAMPLE_VALUES: Record<string, string> = {
	first_name: "Alex",
	last_name: "Rivera",
	name: "Alex Rivera",
	email: "alex@example.com",
	company_name: "Acme Inc.",
	company: "Acme Inc.",
	unsubscribe_url: "https://example.com/unsubscribe",
};

/** Distinct variable names in the order they first appear. */
export function extractVariables(...texts: string[]): string[] {
	const seen = new Set<string>();
	for (const text of texts) {
		for (const match of text.matchAll(VARIABLE_PATTERN)) seen.add(match[1]);
	}
	return [...seen];
}

/** The chips to show: the template's own variables, then the common ones. */
export function variableChips(used: string[]): string[] {
	return [...new Set([...used, ...COMMON_VARIABLES])];
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** A sample value for any variable: a known one, or a readable stand-in. */
export function sampleValue(name: string, overrides: Record<string, string> = {}): string {
	return overrides[name] ?? SAMPLE_VALUES[name] ?? name.replace(/_/g, " ");
}

/**
 * Substitute sample values. `html` escapes each value, since the body is
 * markup and a value is plain text.
 */
export function renderPreview(
	text: string,
	options: { html?: boolean; values?: Record<string, string> } = {},
): string {
	return text.replace(VARIABLE_PATTERN, (_match, name: string) => {
		const value = sampleValue(name, options.values);
		return options.html ? escapeHtml(value) : value;
	});
}

/** Insert `{{name}}` into a plain string at a selection, returning the new caret. */
export function insertVariableAt(
	text: string,
	name: string,
	start: number,
	end: number = start,
): { text: string; caret: number } {
	const token = `{{${name}}}`;
	const s = Math.max(0, Math.min(start, text.length));
	const e = Math.max(s, Math.min(end, text.length));
	return { text: text.slice(0, s) + token + text.slice(e), caret: s + token.length };
}

/** Template slugs: lowercase, digits and single dashes. */
export function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

/**
 * Markup the rich editor can't round-trip (layout tables, inline styles,
 * <style> blocks). Opening such a body in rich mode would silently simplify
 * it, so the editor starts in HTML source instead.
 */
export function needsHtmlMode(html: string): boolean {
	return /<(style|html|body|head|center|font)\b|<div\b|\sstyle\s*=|<table\b[^>]*\b(bgcolor|width|cellpadding)\b/i.test(html);
}
