/**
 * Inline snippets: `;name` in the composer expands a template.
 *
 * Pure helpers only. The TipTap extension in `components/mail/SnippetSuggestion`
 * wires these to the editor; everything that decides *what* happens lives here
 * so it can be tested without a DOM.
 */

import { extractEmailAddress, splitEmailList } from "~/lib/utils";
import { fuzzyFilter } from "~/lib/fuzzy";

/** Same grammar as the server's `renderTemplate` (`workers/lib/templates.ts`). */
export const VARIABLE_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/** The character that opens the snippet picker. */
export const SNIPPET_CHAR = ";";

/**
 * Whether text before the caret should open the picker, and with what query.
 *
 * Opens on `;` at the start of a line or after whitespace or an opening
 * bracket, followed by zero or more word characters. That keeps ordinary
 * punctuation — "one; two", "&nbsp;", a URL with `;jsessionid` — from popping
 * a menu mid-sentence, which is why `;` is safe as a trigger at all.
 *
 * Returns the query (possibly empty) and the offset of the `;`.
 */
export function matchSnippetTrigger(
	textBeforeCaret: string,
): { query: string; from: number } | null {
	const match = /(^|[\s(\[{"'“‘]);([\w-]{0,40})$/u.exec(textBeforeCaret);
	if (!match) return null;
	return { query: match[2], from: match.index + match[1].length };
}

export interface SnippetRecipient {
	email: string;
	/** Display name, when one is known. */
	name?: string | null;
}

/**
 * The first To recipient, parsed from the composer's comma-separated field.
 *
 * Accepts `Name <a@b>` tokens as well as bare addresses. A `knownNames` map
 * fills in a display name for a bare address when the app has seen one — the
 * sender of the message being replied to, typically.
 */
export function firstRecipient(
	to: string,
	knownNames: Record<string, string | null | undefined> = {},
): SnippetRecipient | null {
	for (const token of splitEmailList(to)) {
		const email = extractEmailAddress(token);
		if (!email) continue;
		const angled = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(token);
		const fromToken = angled?.[1]?.trim() || null;
		const known = knownNames[email.toLowerCase()]?.trim() || null;
		return { email, name: fromToken || known };
	}
	return null;
}

/**
 * Variables a snippet can fill from the recipient.
 *
 * Only names that are actually known are filled. A guessed first name taken
 * from an address local part ("info", "j.smith") is worse in a sent message
 * than a visible placeholder the writer has to deal with, so an unknown name
 * stays a placeholder.
 */
export function recipientVariables(
	recipient: SnippetRecipient | null,
): Record<string, string> {
	if (!recipient) return {};
	const vars: Record<string, string> = { email: recipient.email };
	const name = recipient.name?.trim();
	if (name && !name.includes("@")) {
		vars.name = name;
		vars.full_name = name;
		const parts = name.split(/\s+/);
		vars.first_name = parts[0];
		if (parts.length > 1) vars.last_name = parts[parts.length - 1];
	}
	return vars;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Class the editor decorates every unfilled `{{name}}` with. */
export const PLACEHOLDER_CLASS = "snippet-var";

/**
 * Fill a template body for insertion.
 *
 * Known variables are substituted, HTML-escaped because names come from mail
 * headers, which are untrusted. Unknown ones stay as the literal `{{name}}`.
 * The editor highlights those with a decoration rather than a mark, so nothing
 * extra reaches the sent HTML and text typed over a placeholder doesn't
 * inherit a highlight. Returns the HTML and the names left unfilled.
 */
export function fillTemplate(
	html: string,
	variables: Record<string, string>,
): { html: string; unfilled: string[] } {
	const unfilled: string[] = [];
	const out = html.replace(VARIABLE_PATTERN, (_match, name: string) => {
		const value = variables[name];
		if (value !== undefined && value !== "") return escapeHtml(value);
		if (!unfilled.includes(name)) unfilled.push(name);
		return `{{${name}}}`;
	});
	return { html: out, unfilled };
}

/**
 * The placeholder Tab (or Shift+Tab) should select next.
 *
 * `ranges` are document positions of each `{{name}}`, in order; `selection` is
 * the current one. No wrapping: past the last placeholder Tab gets its usual
 * meaning back, so a keyboard user can always Tab out of the editor even with
 * a placeholder left unfilled.
 */
export function nextPlaceholder(
	ranges: readonly { from: number; to: number }[],
	selection: { from: number; to: number },
	direction: 1 | -1 = 1,
): { from: number; to: number } | null {
	const isCurrent = (r: { from: number; to: number }) =>
		r.from === selection.from && r.to === selection.to;
	if (direction === 1) {
		return ranges.find((r) => r.from >= selection.from && !isCurrent(r)) ?? null;
	}
	return (
		[...ranges].reverse().find((r) => r.to <= selection.to && !isCurrent(r)) ?? null
	);
}

/** Every `{{name}}` in a run of text, as offsets into it. */
export function findPlaceholders(text: string): { from: number; to: number; name: string }[] {
	const found: { from: number; to: number; name: string }[] = [];
	for (const match of text.matchAll(VARIABLE_PATTERN)) {
		if (match.index === undefined) continue;
		found.push({ from: match.index, to: match.index + match[0].length, name: match[1] });
	}
	return found;
}

export interface SnippetTemplate {
	slug: string;
	name: string;
	subject?: string;
	bodyHtml: string;
}

/** Templates for the picker, best match first. Empty query keeps the given order. */
export function rankSnippets<T extends SnippetTemplate>(
	templates: readonly T[],
	query: string,
	limit = 8,
): T[] {
	return fuzzyFilter(templates, query, (template) => ({
		title: template.name,
		subtitle: template.slug,
		keywords: template.subject ? [template.subject] : [],
	})).slice(0, limit);
}
