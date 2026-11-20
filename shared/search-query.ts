// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Parse a Gmail-style search query into an AST.
 *
 * This replaces a regex that swept operators out of the string into a flat bag
 * of filters. That shape could not represent the three things people actually
 * type: `-from:spam@x` (negation), `from:a OR from:b` (alternation) and
 * `(a OR b) c` (grouping). A flat bag also silently lost repeated operators —
 * two `from:` terms overwrote each other — and because it deleted matched
 * substrings from the free text with `String.replace`, a query like
 * `subject:report report` deleted the wrong `report`.
 *
 * The module lives in `shared/` rather than `app/` because the worker is what
 * turns a query into SQL. Parsing on the client and shipping a dozen flat query
 * parameters meant the server could never express anything the flat shape could
 * not, so the operator set was pinned to the weakest link. Now the raw string
 * crosses the wire and the worker parses it with this exact code.
 *
 * Grammar (recursive descent, precedence low to high):
 *
 *     expr    := or
 *     or      := and ( "OR" and )*
 *     and     := unary+                 // juxtaposition is AND
 *     unary   := "-" unary | primary
 *     primary := "(" expr ")" | "{" expr "}" | operator | phrase | word
 *
 * `{ }` is Gmail's OR sugar: its contents are joined with OR rather than AND.
 *
 * Every failure mode degrades to free text. A search box is not a compiler
 * prompt: an unterminated quote, a stray `)` or `larger:banana` must still
 * search for what was typed instead of throwing, because the alternative the
 * user sees is a broken results page.
 */

/** Longest input parsed. Beyond this the tail is dropped, not rejected. */
const MAX_QUERY_LENGTH = 512;
/** Most tokens read. Bounds work on a pathological paste. */
const MAX_TOKENS = 64;
/** Deepest nesting honoured, so `((((…))))` cannot exhaust the stack. */
const MAX_DEPTH = 8;
/**
 * Most nodes built.
 *
 * This is the parser-side half of the bound-parameter budget: the SQL compiler
 * binds at most two parameters per node, so capping nodes here keeps a single
 * search statement clear of `SQL_MAX_BOUND_PARAMS` without the compiler having
 * to drop predicates — dropping one would silently *broaden* the result set,
 * which is the worst way for a search to fail.
 */
const MAX_NODES = 40;

/** Flags reachable through `is:` and `has:`. */
export type SearchFlag =
	| "read"
	| "unread"
	| "starred"
	| "unstarred"
	| "attachment"
	| "muted"
	| "important"
	| "snoozed";

/** Operators that compile to SQL predicates rather than full-text matching. */
export type SearchOperator =
	| {
		field: "from" | "to" | "cc" | "bcc" | "subject" | "label" | "filename";
		value: string;
	}
	/** A folder id or name; `anywhere` means "do not scope, and include Trash/Spam". */
	| { field: "folder"; value: string }
	| { field: "flag"; value: SearchFlag }
	/** Absolute or relative date bound, already normalised to an ISO string. */
	| { field: "date"; cmp: ">=" | "<="; value: string }
	/** Size bound in bytes, suffixes already expanded. */
	| { field: "size"; cmp: ">=" | "<="; bytes: number };

export type OperatorNode = { type: "operator" } & SearchOperator;

/** A free-text leaf. `phrase` marks input that was quoted. */
export interface TermNode {
	type: "term";
	value: string;
	phrase: boolean;
}

export type SearchNode =
	| { type: "and"; children: SearchNode[] }
	| { type: "or"; children: SearchNode[] }
	| { type: "not"; child: SearchNode }
	| TermNode
	| OperatorNode;

export interface ParseOptions {
	/**
	 * Clock used to resolve `older_than:`/`newer_than:`.
	 *
	 * Injected so tests can assert exact bounds; relative dates resolved from
	 * the wall clock are untestable.
	 */
	now?: Date;
}

// ── Tokenizer ──────────────────────────────────────────────────────

type Token =
	| { kind: "lparen" }
	| { kind: "rparen" }
	| { kind: "lbrace" }
	| { kind: "rbrace" }
	| { kind: "or" }
	| { kind: "minus" }
	| { kind: "word"; value: string; phrase: boolean }
	| { kind: "operator"; key: string; value: string; phrase: boolean };

/** Operators recognised as structure. Anything else stays free text. */
const OPERATOR_KEYS: Record<string, true> = {
	from: true,
	to: true,
	cc: true,
	bcc: true,
	subject: true,
	in: true,
	is: true,
	has: true,
	label: true,
	filename: true,
	before: true,
	after: true,
	larger: true,
	smaller: true,
	older_than: true,
	newer_than: true,
};

/**
 * Characters that end a bare word.
 *
 * Whitespace is listed beside the structural characters so the tokenizer has a
 * single lookup for "this ends a word" rather than two conditions that can
 * drift apart as one of them gains a case.
 */
const WORD_BREAK: Record<string, true> = {
	"(": true,
	")": true,
	"{": true,
	"}": true,
	" ": true,
	"\t": true,
	"\n": true,
	"\r": true,
};

/**
 * Structural characters alone, mapped to the token they emit.
 *
 * Typed to the payload-free token kinds so pushing the looked-up kind needs no
 * cast — a cast here would happily accept `"word"`, which carries a value the
 * lookup cannot supply.
 */
const STRUCTURAL_TOKEN: Record<
	string,
	Extract<Token, { kind: "lparen" | "rparen" | "lbrace" | "rbrace" }>["kind"]
> = {
	"(": "lparen",
	")": "rparen",
	"{": "lbrace",
	"}": "rbrace",
};

/**
 * Read a quoted string starting at the opening quote.
 *
 * An unterminated quote consumes to end of input rather than failing, so
 * `subject:"report` searches for `report` while the user is still typing the
 * closing quote.
 */
function readQuoted(input: string, start: number): { value: string; next: number } {
	let i = start + 1;
	let value = "";
	while (i < input.length && input[i] !== '"') {
		value += input[i];
		i++;
	}
	// Skip the closing quote when there is one.
	return { value, next: i < input.length ? i + 1 : i };
}

/** Read a bare run of characters up to whitespace or a structural character. */
function readBare(input: string, start: number): { value: string; next: number } {
	let i = start;
	let value = "";
	while (i < input.length && !WORD_BREAK[input[i]]) {
		value += input[i];
		i++;
	}
	return { value, next: i };
}

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < input.length && tokens.length < MAX_TOKENS) {
		const ch = input[i];

		// Whitespace only separates; it produces no token.
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			i++;
			continue;
		}

		const structural = STRUCTURAL_TOKEN[ch];
		if (structural) {
			tokens.push({ kind: structural });
			i++;
			continue;
		}

		// `-` is negation only where something follows it to negate. Inside a
		// word it is a hyphen, so `well-known` stays one term rather than
		// becoming `well AND NOT known` — `readBare` keeps it because `-` is not
		// a word break. A `-` before whitespace or at end of input negates
		// nothing, so it is dropped rather than becoming a term: `invoice -` is
		// a half-typed query, and searching for a literal `-` finds nothing.
		if (ch === "-") {
			const following = input[i + 1];
			const stray = following === undefined
				|| following === " "
				|| following === "\t"
				|| following === "\n"
				|| following === "\r";
			// Openers are deliberately not stray: `-(a b)` negates the group.
			if (!stray) tokens.push({ kind: "minus" });
			i++;
			continue;
		}

		if (ch === '"') {
			const { value, next } = readQuoted(input, i);
			i = next;
			if (value.trim()) tokens.push({ kind: "word", value: value.trim(), phrase: true });
			continue;
		}

		const bare = readBare(input, i);
		if (!bare.value) {
			// A lone `-` or other unreadable character: skip it rather than
			// looping forever.
			i++;
			continue;
		}

		// Uppercase `OR` only. Gmail treats lowercase `or` as a word, and so do
		// people who write "cats or dogs" meaning both words.
		if (bare.value === "OR") {
			tokens.push({ kind: "or" });
			i = bare.next;
			continue;
		}

		const colon = bare.value.indexOf(":");
		const key = colon > 0 ? bare.value.slice(0, colon).toLowerCase() : "";

		if (colon > 0 && OPERATOR_KEYS[key]) {
			// Value may be quoted immediately after the colon: from:"John Doe".
			const afterColon = i + colon + 1;
			if (input[afterColon] === '"') {
				const { value, next } = readQuoted(input, afterColon);
				i = next;
				tokens.push({ kind: "operator", key, value, phrase: true });
			} else {
				const value = bare.value.slice(colon + 1);
				i = bare.next;
				tokens.push({ kind: "operator", key, value, phrase: false });
			}
			continue;
		}

		i = bare.next;
		tokens.push({ kind: "word", value: bare.value, phrase: false });
	}

	return tokens;
}

// ── Value normalisation ────────────────────────────────────────────

const SIZE_RE = /^(\d+)\s*([kmb]?)b?$/i;

/**
 * Expand a `larger:`/`smaller:` value to bytes.
 *
 * Returns null for anything unparseable so the caller can fall back to free
 * text; `larger:soon` is a typo, not a size, and answering it with "no results"
 * hides the typo.
 */
export function parseSizeBytes(raw: string): number | null {
	const match = SIZE_RE.exec(raw.trim());
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return null;
	const unit = match[2].toLowerCase();
	if (unit === "k") return value * 1024;
	if (unit === "m") return value * 1024 * 1024;
	return value;
}

const AGE_RE = /^(\d+)\s*([dmy])$/i;

/**
 * Resolve an `older_than:`/`newer_than:` value to an absolute ISO instant.
 *
 * `m` is months, not minutes, matching Gmail. Months and years shift the
 * calendar field rather than multiplying days, so `older_than:1y` means "before
 * this date last year" and does not drift on leap years.
 */
export function parseAgeBoundary(raw: string, now: Date): string | null {
	const match = AGE_RE.exec(raw.trim());
	if (!match) return null;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount)) return null;

	const at = new Date(now.getTime());
	const unit = match[2].toLowerCase();

	if (unit === "d") {
		at.setUTCDate(at.getUTCDate() - amount);
	} else {
		/*
		 * Shifting a month off a day the target month does not have overflows
		 * forward: March 31 with `setUTCMonth(1)` becomes March 3, so
		 * `older_than:1m` asked on the 31st returned a boundary *later* than the
		 * day it was asked on, and the operator excluded almost nothing. Pinning
		 * to the 1st before the shift and clamping afterwards gives the last day
		 * of the target month, which is what "a month earlier" means.
		 */
		const day = at.getUTCDate();
		at.setUTCDate(1);
		if (unit === "m") at.setUTCMonth(at.getUTCMonth() - amount);
		else at.setUTCFullYear(at.getUTCFullYear() - amount);
		// Day 0 of the next month is the last day of this one.
		const lastDay = new Date(
			Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0),
		).getUTCDate();
		at.setUTCDate(Math.min(day, lastDay));
	}

	return at.toISOString();
}

/**
 * Normalise a `before:`/`after:` value to an ISO instant.
 *
 * Bare `YYYY-MM-DD` is pinned to UTC explicitly. `new Date("2025-01-01")` is
 * already UTC but `new Date("2025/01/01")` is local, so the two spellings
 * otherwise disagreed by up to a day at the boundary.
 */
export function parseDateBoundary(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	const ymd = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(trimmed);
	if (ymd) {
		const [, y, m, d] = ymd;
		const at = new Date(
			Date.UTC(Number(y), Number(m) - 1, Number(d), 0, 0, 0, 0),
		);
		if (Number.isNaN(at.getTime())) return null;
		return at.toISOString();
	}

	const at = new Date(trimmed);
	if (Number.isNaN(at.getTime())) return null;
	return at.toISOString();
}

const FLAG_ALIASES: Record<string, SearchFlag> = {
	read: "read",
	unread: "unread",
	starred: "starred",
	unstarred: "unstarred",
	muted: "muted",
	important: "important",
	snoozed: "snoozed",
};

/**
 * Turn one operator token into an operator node.
 *
 * Returns null when the value does not make sense for the key, which sends the
 * token back to the free-text path with its original spelling intact.
 */
function toOperatorNode(
	token: Extract<Token, { kind: "operator" }>,
	now: Date,
): OperatorNode | null {
	const value = token.value.trim();
	if (!value) return null;

	switch (token.key) {
		case "from":
		case "to":
		case "cc":
		case "bcc":
		case "subject":
		case "label":
		case "filename":
			return { type: "operator", field: token.key, value };
		case "in":
			return { type: "operator", field: "folder", value: value.toLowerCase() };
		case "is": {
			const flag = FLAG_ALIASES[value.toLowerCase()];
			return flag ? { type: "operator", field: "flag", value: flag } : null;
		}
		case "has":
			return value.toLowerCase() === "attachment"
				? { type: "operator", field: "flag", value: "attachment" }
				: null;
		case "before": {
			const iso = parseDateBoundary(value);
			return iso ? { type: "operator", field: "date", cmp: "<=", value: iso } : null;
		}
		case "after": {
			const iso = parseDateBoundary(value);
			return iso ? { type: "operator", field: "date", cmp: ">=", value: iso } : null;
		}
		case "older_than": {
			const iso = parseAgeBoundary(value, now);
			return iso ? { type: "operator", field: "date", cmp: "<=", value: iso } : null;
		}
		case "newer_than": {
			const iso = parseAgeBoundary(value, now);
			return iso ? { type: "operator", field: "date", cmp: ">=", value: iso } : null;
		}
		case "larger": {
			const bytes = parseSizeBytes(value);
			return bytes === null ? null : { type: "operator", field: "size", cmp: ">=", bytes };
		}
		case "smaller": {
			const bytes = parseSizeBytes(value);
			return bytes === null ? null : { type: "operator", field: "size", cmp: "<=", bytes };
		}
		default:
			return null;
	}
}

// ── Parser ─────────────────────────────────────────────────────────

/** Thrown internally to abandon a parse; never escapes `parseSearchQuery`. */
class ParseAbort extends Error {}

class Parser {
	#tokens: Token[];
	#pos = 0;
	#nodes = 0;
	readonly #now: Date;

	constructor(tokens: Token[], now: Date) {
		this.#tokens = tokens;
		this.#now = now;
	}

	#peek(): Token | undefined {
		return this.#tokens[this.#pos];
	}

	/**
	 * Charge a node against the budget.
	 *
	 * Aborting rather than truncating keeps the guarantee simple: either the
	 * whole query parsed, or we fall back to free text over the whole query. A
	 * half-parsed AST would apply some of what was typed and ignore the rest,
	 * which is indistinguishable from a bug.
	 */
	#charge() {
		if (++this.#nodes > MAX_NODES) throw new ParseAbort("node budget exceeded");
	}

	/**
	 * Parse the token stream.
	 *
	 * Tokens left over mean a stray closer like `a )`. They are ignored rather
	 * than raised, because the part that did parse is still what was meant.
	 */
	parse(): SearchNode | null {
		return this.#parseOr(0);
	}

	#parseOr(depth: number): SearchNode | null {
		const children: SearchNode[] = [];
		const first = this.#parseAnd(depth);
		if (first) children.push(first);

		while (this.#peek()?.kind === "or") {
			this.#pos++;
			const next = this.#parseAnd(depth);
			if (next) children.push(next);
		}

		if (children.length === 0) return null;
		if (children.length === 1) return children[0];
		this.#charge();
		return { type: "or", children };
	}

	#parseAnd(depth: number): SearchNode | null {
		const children: SearchNode[] = [];

		for (;;) {
			const token = this.#peek();
			if (!token) break;
			// `OR` belongs to the caller; closers end this group.
			if (token.kind === "or" || token.kind === "rparen" || token.kind === "rbrace") break;

			const node = this.#parseUnary(depth);
			if (node) children.push(node);
			else if (this.#peek() === token) {
				// Nothing consumed and nothing produced: skip the token so the
				// loop cannot spin.
				this.#pos++;
			}
		}

		if (children.length === 0) return null;
		if (children.length === 1) return children[0];
		this.#charge();
		return { type: "and", children };
	}

	#parseUnary(depth: number): SearchNode | null {
		if (this.#peek()?.kind === "minus") {
			this.#pos++;
			const child = this.#parseUnary(depth);
			// A dangling `-` negates nothing; drop it rather than inventing a
			// node that matches everything.
			if (!child) return null;
			this.#charge();
			return { type: "not", child };
		}
		return this.#parsePrimary(depth);
	}

	#parsePrimary(depth: number): SearchNode | null {
		const token = this.#peek();
		if (!token) return null;

		if (token.kind === "lparen" || token.kind === "lbrace") {
			if (depth >= MAX_DEPTH) throw new ParseAbort("too deeply nested");
			const brace = token.kind === "lbrace";
			this.#pos++;
			const inner = brace ? this.#parseBraceGroup(depth + 1) : this.#parseOr(depth + 1);
			const closer = brace ? "rbrace" : "rparen";
			if (this.#peek()?.kind === closer) this.#pos++;
			return inner;
		}

		if (token.kind === "operator") {
			this.#pos++;
			this.#charge();
			// A rejected operator falls back to the literal text that was typed,
			// spelling included, so `larger:banana` searches for that string
			// instead of vanishing into a size predicate that cannot exist.
			return (
				toOperatorNode(token, this.#now) ?? {
					type: "term",
					value: token.value ? `${token.key}:${token.value}` : `${token.key}:`,
					phrase: token.phrase,
				}
			);
		}

		if (token.kind === "word") {
			this.#pos++;
			this.#charge();
			return { type: "term", value: token.value, phrase: token.phrase };
		}

		return null;
	}

	/**
	 * `{ a b c }` is Gmail's sugar for `a OR b OR c`.
	 *
	 * Implemented by collecting the group's terms and joining them with OR
	 * rather than by reusing `#parseAnd`, which would join them with AND and
	 * make the braces silently meaningless.
	 */
	#parseBraceGroup(depth: number): SearchNode | null {
		const children: SearchNode[] = [];

		for (;;) {
			const token = this.#peek();
			if (!token || token.kind === "rbrace") break;
			if (token.kind === "or") { this.#pos++; continue; }

			const node = this.#parseUnary(depth);
			if (node) children.push(node);
			else if (this.#peek() === token) this.#pos++;
		}

		if (children.length === 0) return null;
		if (children.length === 1) return children[0];
		this.#charge();
		return { type: "or", children };
	}
}

/**
 * Split a query into whitespace-delimited free-text terms.
 *
 * The degraded path. Quotes and operator colons are kept as literal text
 * because at this point we have decided not to interpret them.
 */
function freeTextFallback(input: string): SearchNode | null {
	const words = input.split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);
	if (words.length === 0) return null;
	const children: TermNode[] = words.map((value) => ({
		type: "term",
		value,
		phrase: false,
	}));
	return children.length === 1 ? children[0] : { type: "and", children };
}

/**
 * Parse a search query.
 *
 * Returns null when there is nothing to search for, which callers read as
 * "no constraints" rather than "matches nothing".
 */
export function parseSearchQuery(
	input: string | null | undefined,
	options: ParseOptions = {},
): SearchNode | null {
	if (!input) return null;
	const trimmed = input.slice(0, MAX_QUERY_LENGTH).trim();
	if (!trimmed) return null;

	const now = options.now ?? new Date();

	try {
		const parsed = new Parser(tokenize(trimmed), now).parse();
		// An input of nothing but structure (`()`, `-`) parses to nothing.
		// Searching for the literal text is more useful than searching for
		// everything.
		return parsed ?? freeTextFallback(trimmed);
	} catch {
		return freeTextFallback(trimmed);
	}
}

/** An operator the parser could not use, which it searched for as text. */
export interface SearchWarning {
	/** The operator as typed, e.g. `larger:banana`. */
	token: string;
	/** One line for the UI. */
	message: string;
}

const OPERATOR_HINTS: Record<string, string> = {
	larger: "a size like 5M or 200K",
	smaller: "a size like 5M or 200K",
	before: "a date like 2026/01/31",
	after: "a date like 2026/01/31",
	older_than: "an age like 7d, 2m or 1y",
	newer_than: "an age like 7d, 2m or 1y",
	is: "read, unread, starred, unstarred, muted, important or snoozed",
	has: "attachment",
};

/**
 * Operators in `input` that did not parse and were searched as plain text.
 *
 * `larger:banana` used to fall back silently and return nothing, which reads
 * as "no such mail" rather than "typo". The UI shows these above the results.
 */
export function searchQueryWarnings(
	input: string | null | undefined,
	options: ParseOptions = {},
): SearchWarning[] {
	if (!input) return [];
	const trimmed = input.slice(0, MAX_QUERY_LENGTH).trim();
	if (!trimmed) return [];
	const now = options.now ?? new Date();

	const warnings: SearchWarning[] = [];
	for (const token of tokenize(trimmed)) {
		if (token.kind !== "operator") continue;
		if (toOperatorNode(token, now)) continue;
		const typed = token.phrase
			? `${token.key}:"${token.value}"`
			: `${token.key}:${token.value}`;
		const hint = OPERATOR_HINTS[token.key];
		warnings.push({
			token: typed,
			message: token.value.trim()
				? `Searched for "${typed}" as text${hint ? `: ${token.key}: expects ${hint}` : ""}.`
				: `"${token.key}:" has no value, so it was searched as text.`,
		});
	}
	return warnings;
}

// ── AST helpers ────────────────────────────────────────────────────

/** Walk every node depth-first, parents before children. */
export function walkSearchNodes(
	node: SearchNode,
	visit: (node: SearchNode) => void,
): void {
	visit(node);
	if (node.type === "and" || node.type === "or") {
		for (const child of node.children) walkSearchNodes(child, visit);
	} else if (node.type === "not") {
		walkSearchNodes(node.child, visit);
	}
}

/**
 * True when the query asks to include Trash and Spam.
 *
 * Search excludes them by default — a hit in Trash reads as "it's still there"
 * when it is on its way out — so `in:anywhere` has to be detectable before
 * compilation decides whether to add the exclusion.
 */
export function includesEverywhere(node: SearchNode | null): boolean {
	if (!node) return false;
	let found = false;
	walkSearchNodes(node, (n) => {
		if (n.type === "operator" && n.field === "folder" && n.value === "anywhere") {
			found = true;
		}
	});
	return found;
}

/** True when any node scopes the search to a specific folder. */
export function hasFolderScope(node: SearchNode | null): boolean {
	if (!node) return false;
	let found = false;
	walkSearchNodes(node, (n) => {
		if (n.type === "operator" && n.field === "folder" && n.value !== "anywhere") {
			found = true;
		}
	});
	return found;
}
