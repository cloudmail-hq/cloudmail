// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Translate the free-text part of a parsed search into an FTS5 MATCH
 * expression.
 *
 * Search used to be `LIKE '%term%'` across four columns, which cannot use an
 * index: every search read every message in the mailbox. FTS5 fixes the cost
 * but has a query syntax of its own, and passing raw user input to it is both a
 * correctness problem (an apostrophe or a bare `-` is a syntax error, so the
 * search fails rather than returning nothing) and an injection surface.
 *
 * So every token is quoted, which turns FTS5 operators back into literal text,
 * and a trailing `*` is added so partial words match — people expect "invo" to
 * find "invoice" while they are still typing. Boolean structure is emitted as
 * FTS5's own `AND`/`OR`/`NOT` rather than as several separate MATCH subqueries,
 * because one MATCH over the index is dramatically cheaper than one subquery per
 * word.
 *
 * The input is an AST from `shared/search-query.ts` rather than a string: the
 * structured operators (`from:`, `label:`, `larger:`) are not full-text
 * concerns, so `toFtsMatchExpression` refuses any subtree containing them and
 * lets the SQL compiler split the query instead.
 */

import type { SearchNode } from "./search-query";

/**
 * Most MATCH clauses emitted.
 *
 * Beyond this the extra words cost index reads without narrowing the result in
 * any way the reader would notice. The parser already bounds token count; this
 * bounds what reaches the index after negation and grouping are accounted for.
 */
const MAX_CLAUSES = 12;

/**
 * Markers wrapped around matched terms by `snippet()`.
 *
 * Deliberately control characters rather than `<b>`/`</b>`: the snippet is
 * derived from message bodies, so any HTML-looking marker would be
 * indistinguishable from HTML that arrived in the mail, and rendering it as
 * markup would be an injection. These cannot occur in a readable body, so
 * splitting on them is unambiguous, and every segment is rendered as a React
 * text node — escaped by construction.
 */
export const SNIPPET_MARK_OPEN = "\u0011";
export const SNIPPET_MARK_CLOSE = "\u0012";

/** How many tokens of context `snippet()` returns around a hit. */
export const SNIPPET_TOKENS = 14;

/**
 * Strip characters FTS5 would treat as structure.
 *
 * Quoting already neutralises them, but a token of nothing but punctuation
 * quotes to `""`, which FTS5 rejects — so those tokens are dropped instead.
 */
function sanitiseToken(token: string): string {
	return token
		// Doubling is how a quote is escaped inside an FTS5 string literal.
		.replace(/"/g, '""')
		.replace(/[\u0000-\u001f]/g, " ")
		.trim();
}

/**
 * One compiled subtree.
 *
 * `negated` travels with the expression because FTS5 has no unary NOT: `NOT x`
 * only exists as the binary `a NOT x`. A negation therefore cannot be emitted
 * where it appears; it has to be handed up to an enclosing AND that has
 * something positive to subtract it from.
 */
interface Compiled {
	expr: string;
	negated: boolean;
	/** True for a single term, so callers know parentheses are unnecessary. */
	atomic: boolean;
	/** Clauses consumed, checked against `MAX_CLAUSES`. */
	clauses: number;
}

/** Parenthesise a compound expression so it can be nested safely. */
function group(compiled: Compiled): string {
	return compiled.atomic ? compiled.expr : `(${compiled.expr})`;
}

function compile(node: SearchNode): Compiled | null {
	switch (node.type) {
		case "term": {
			const cleaned = sanitiseToken(node.value);
			// `\p{L}\p{N}` rather than \w so non-Latin scripts are searchable.
			if (!cleaned || !/[\p{L}\p{N}]/u.test(cleaned)) return null;
			// Phrases match exactly; single words match as prefixes so search
			// keeps up with typing. A trailing `*` on a phrase applies to its
			// last term, which is the same helpful behaviour.
			return {
				expr: node.phrase ? `"${cleaned}"` : `"${cleaned}"*`,
				negated: false,
				atomic: true,
				clauses: 1,
			};
		}

		case "not": {
			const child = compile(node.child);
			if (!child) return null;
			// Double negation collapses rather than nesting, since FTS5 cannot
			// express `NOT NOT x` at all.
			return { ...child, negated: !child.negated };
		}

		case "and": {
			const positives: Compiled[] = [];
			const negatives: Compiled[] = [];
			let clauses = 0;

			for (const child of node.children) {
				const compiled = compile(child);
				// A child that cannot be expressed is dropped from the MATCH.
				// Safe only because AND narrows: the SQL compiler applies the
				// same child as its own predicate, so nothing is lost. This is
				// why `or` below refuses to drop anything.
				if (!compiled) continue;
				clauses += compiled.clauses;
				if (clauses > MAX_CLAUSES) break;
				(compiled.negated ? negatives : positives).push(compiled);
			}

			// Nothing to subtract from. The caller falls back to SQL, which can
			// express a bare negation.
			if (positives.length === 0) return null;

			let expr = positives.map(group).join(" AND ");
			if (negatives.length > 0) {
				// `a NOT (b OR c)` is `a AND NOT b AND NOT c`. Written as one
				// NOT so the negatives stay grouped regardless of how FTS5
				// resolves precedence between AND and NOT.
				const excluded = negatives.map(group).join(" OR ");
				expr = `${positives.length > 1 ? `(${expr})` : expr} NOT ${negatives.length > 1 ? `(${excluded})` : excluded}`;
			}

			return {
				expr,
				negated: false,
				atomic: positives.length === 1 && negatives.length === 0 && positives[0].atomic,
				clauses,
			};
		}

		case "or": {
			const children: Compiled[] = [];
			let clauses = 0;

			for (const child of node.children) {
				const compiled = compile(child);
				// One inexpressible branch makes the whole alternation wrong:
				// dropping it would return a strict subset of what was asked
				// for, and OR is the one operator where a missing branch
				// silently loses results instead of adding them.
				if (!compiled || compiled.negated) return null;
				clauses += compiled.clauses;
				if (clauses > MAX_CLAUSES) return null;
				children.push(compiled);
			}

			if (children.length === 0) return null;
			if (children.length === 1) return children[0];

			return {
				expr: children.map(group).join(" OR "),
				negated: false,
				atomic: false,
				clauses,
			};
		}

		// Structured operators are SQL predicates, not full-text matches.
		case "operator":
			return null;
	}
}

/**
 * Build an FTS5 MATCH expression for a subtree, or null when the index cannot
 * answer it.
 *
 * Null is not "matches nothing" — it means the caller must express this subtree
 * some other way (a SQL predicate, or the pre-index `LIKE` scan). Returning an
 * empty match instead would turn "search for a word made of punctuation" into
 * "no results", which reads as data loss.
 */
export function toFtsMatchExpression(node: SearchNode | null | undefined): string | null {
	if (!node) return null;
	const compiled = compile(node);
	// A top-level negation has nothing to subtract from, so it stays SQL's job.
	if (!compiled || compiled.negated) return null;
	return compiled.expr;
}

/** One run of snippet text, flagged when `snippet()` marked it as a match. */
export interface SnippetSegment {
	text: string;
	match: boolean;
}

/**
 * Remove any marker left in a run of snippet text.
 *
 * Markers are control characters, so one surviving into the output renders as
 * invisible junk inside the result row. `snippet()` only emits them in pairs,
 * but it truncates, so an unpaired one is expected rather than exceptional —
 * and a body could in principle contain one. Applied to every emitted segment
 * so plain runs, matched runs and the tail cannot drift apart on this.
 */
function stripMarkers(text: string): string {
	return text.split(SNIPPET_MARK_OPEN).join("").split(SNIPPET_MARK_CLOSE).join("");
}

/**
 * Split a `snippet()` result into plain and matched runs.
 *
 * Returning segments rather than a marked-up string is what keeps the snippet
 * out of `dangerouslySetInnerHTML`: the caller renders each segment as text, so
 * a message body containing `<script>` renders as those characters instead of
 * executing.
 */
export function splitSnippetHighlights(
	snippet: string | null | undefined,
): SnippetSegment[] {
	if (!snippet) return [];

	const segments: SnippetSegment[] = [];
	let rest = snippet;

	while (rest.length > 0) {
		const open = rest.indexOf(SNIPPET_MARK_OPEN);
		if (open === -1) break;

		const close = rest.indexOf(SNIPPET_MARK_CLOSE, open + 1);
		// An unpaired opener means the snippet was truncated mid-highlight. Keep
		// the remainder as plain text rather than dropping text that matched.
		if (close === -1) break;

		if (open > 0) {
			const plain = stripMarkers(rest.slice(0, open));
			if (plain) segments.push({ text: plain, match: false });
		}
		const matched = stripMarkers(rest.slice(open + 1, close));
		if (matched) segments.push({ text: matched, match: true });
		rest = rest.slice(close + 1);
	}

	if (rest.length > 0) {
		const plain = stripMarkers(rest);
		if (plain) segments.push({ text: plain, match: false });
	}

	return segments;
}
