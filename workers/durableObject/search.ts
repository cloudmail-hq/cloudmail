// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Compile a parsed search query into SQL.
 *
 * ## How the query is split
 *
 * A search mixes two things that want completely different execution
 * strategies, so the compiler routes each to whichever can answer it:
 *
 *   - **Free text and phrases → FTS5 `MATCH`.** The words someone typed are
 *     answered by the `emails_fts` index. `shared/fts.ts` renders the text
 *     portion of the AST as a single FTS5 expression — including `NOT` and `OR`
 *     — because one MATCH over the index costs one index traversal, while a
 *     subquery per word costs one per word.
 *   - **Structured operators → SQL predicates.** `label:` needs the
 *     `email_labels` join, `filename:` needs `attachments`, `larger:` needs a
 *     computed byte length, and folder/flags/dates are columns. None of these
 *     are full-text concerns and FTS5 cannot express them at all.
 *
 * The text portion is *hoisted* out of the top-level conjunction when it can be,
 * so it becomes one MATCH inside a CTE. That is also what makes highlighting
 * possible: FTS5 only offers `snippet()` in a query that matches against the
 * index itself, so a text term buried in an inline `rowid IN (…)` subquery can
 * filter but can never be quoted from. Text nested inside an `OR` with a
 * structured operator cannot be hoisted without changing what the query means,
 * so it stays an inline subquery and contributes no snippet.
 *
 * ## Parameter binding
 *
 * Every value is bound, never interpolated. `#addParam` returns a placeholder
 * that is reused when one value feeds several columns — `to:x` tests three
 * columns with one bound parameter rather than three. That reuse is what keeps a
 * search inside the `SQL_MAX_BOUND_PARAMS` budget: the parser caps the AST at
 * `MAX_NODES` nodes and every node costs at most one parameter, so no reachable
 * query approaches the limit. Dropping a predicate to fit would silently
 * *broaden* the result set, which is the worst way for a search to fail, so the
 * budget holds by construction and is asserted rather than accommodated.
 *
 * Placeholders are numbered, and the CTE that carries the MATCH is textually
 * ahead of the WHERE clause, so predicate numbering has to start after the
 * clauses the statement puts first. That offset is the reason statement assembly
 * lives here beside the compiler instead of at the call site — splitting them
 * once meant the DO had to know how many parameters the CTE had used.
 */

import {
	SNIPPET_MARK_CLOSE,
	SNIPPET_MARK_OPEN,
	SNIPPET_TOKENS,
	toFtsMatchExpression,
} from "../../shared/fts";
import { Folders } from "../../shared/folders";
import type { SearchNode } from "../../shared/search-query";
import { hasFolderScope, includesEverywhere } from "../../shared/search-query";
import { SQL_MAX_BOUND_PARAMS } from "./bulk";
import * as threading from "./threading";
import { engagementColumnsSql } from "./engagement";

/** LIMIT and OFFSET, which the list statement binds after every predicate. */
const RESERVED_PARAMS = 2;

/** Predicate that is always true, for an operator that constrains nothing. */
const ALWAYS_TRUE = "1 = 1";

/** Body characters returned when there is no MATCH to derive a snippet from. */
const PLAIN_SNIPPET_LENGTH = 300;

export type TextMode = "fts" | "like";

/**
 * A message's size in bytes.
 *
 * `CAST(… AS BLOB)` because `LENGTH()` on text counts characters, so a body of
 * accented or CJK text measured as characters reports a fraction of what it
 * costs — and `larger:`/`smaller:` are asked about the size shown in the client,
 * which is bytes. Attachments dominate that number, so they are summed in rather
 * than ignored.
 */
function sizeBytesSql(idExpr: string, prefix: string): string {
	return `(
		LENGTH(CAST(COALESCE(${prefix}body, '') AS BLOB))
		+ LENGTH(CAST(COALESCE(${prefix}subject, '') AS BLOB))
		+ COALESCE((SELECT SUM(a.size) FROM attachments a WHERE a.email_id = ${idExpr}), 0)
	)`;
}

class Compiler {
	readonly #prefix: string;
	readonly #idExpr: string;
	readonly #mode: TextMode;
	readonly #offset: number;
	readonly #params: (string | number)[] = [];
	/** Placeholders already bound, so one value is never bound twice. */
	readonly #placeholders = new Map<string, string>();

	constructor(tableAlias: string, mode: TextMode, paramOffset: number) {
		this.#prefix = tableAlias ? `${tableAlias}.` : "";
		this.#idExpr = `${this.#prefix}id`;
		this.#mode = mode;
		this.#offset = paramOffset;
	}

	get params(): (string | number)[] {
		return this.#params;
	}

	/**
	 * Bind a value and return its placeholder.
	 *
	 * Identical values collapse onto one placeholder. That is not merely a
	 * saving: it is what lets a predicate spanning six columns cost one
	 * parameter, which is how this file's budget arithmetic holds.
	 */
	#addParam(value: string | number): string {
		const key = `${typeof value}:${value}`;
		const existing = this.#placeholders.get(key);
		if (existing) return existing;

		this.#params.push(value);
		const placeholder = `?${this.#offset + this.#params.length}`;
		this.#placeholders.set(key, placeholder);
		return placeholder;
	}

	/** Text matched through the index. */
	#ftsCondition(expression: string): string {
		// Join on rowid rather than id: `emails_fts` is an external-content
		// table over `emails`, so its rowid *is* the message's rowid.
		return `${this.#prefix}rowid IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ${this.#addParam(expression)})`;
	}

	/**
	 * Text matched by scanning, for a mailbox whose index does not exist yet.
	 *
	 * One bound parameter drives all six columns.
	 */
	#likeCondition(value: string): string {
		const p = this.#addParam(`%${value}%`);
		const columns = ["subject", "body", "sender", "recipient", "cc", "bcc"];
		return `(${columns.map((c) => `${this.#prefix}${c} LIKE ${p}`).join(" OR ")})`;
	}

	#term(node: Extract<SearchNode, { type: "term" }>): string | null {
		const trimmed = node.value.trim();
		if (!trimmed) return null;
		if (this.#mode === "like") return this.#likeCondition(trimmed);

		const expression = toFtsMatchExpression({ ...node, value: trimmed });
		// Punctuation alone cannot be tokenised by FTS5, so it is matched by a
		// scan rather than silently returning nothing.
		return expression ? this.#ftsCondition(expression) : this.#likeCondition(trimmed);
	}

	#operator(node: Extract<SearchNode, { type: "operator" }>): string | null {
		const prefix = this.#prefix;

		switch (node.field) {
			case "from":
				return `${prefix}sender LIKE ${this.#addParam(`%${node.value}%`)}`;
			case "to": {
				// Spans cc and bcc, which is what this operator already did
				// before `cc:` and `bcc:` existed. Narrowing it to the To header
				// would quietly stop matching mail people have been finding this
				// way; the explicit operators serve anyone wanting the
				// distinction.
				const p = this.#addParam(`%${node.value}%`);
				return `(${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p} OR ${prefix}bcc LIKE ${p})`;
			}
			case "cc":
				return `${prefix}cc LIKE ${this.#addParam(`%${node.value}%`)}`;
			case "bcc":
				return `${prefix}bcc LIKE ${this.#addParam(`%${node.value}%`)}`;
			case "subject":
				return `${prefix}subject LIKE ${this.#addParam(`%${node.value}%`)}`;
			case "label": {
				// Matched on name or id with one parameter, because the sidebar
				// shows names while everything stored references ids — and the
				// person typing `label:` is reading the sidebar.
				const p = this.#addParam(node.value);
				return `EXISTS (
					SELECT 1 FROM email_labels el
					JOIN labels l ON l.id = el.label_id
					WHERE el.email_id = ${this.#idExpr}
					  AND (l.name = ${p} COLLATE NOCASE OR l.id = ${p})
				)`;
			}
			case "filename": {
				// Substring, not equality: `filename:pdf` is how people ask for
				// a file type, and requiring the whole name answers that with
				// nothing.
				const p = this.#addParam(`%${node.value}%`);
				return `EXISTS (
					SELECT 1 FROM attachments a
					WHERE a.email_id = ${this.#idExpr} AND a.filename LIKE ${p}
				)`;
			}
			case "folder": {
				// `in:anywhere` is not a folder — it is the absence of the
				// default Trash/Spam exclusion, applied in `compileSearch`. Here
				// it must constrain nothing.
				if (node.value === "anywhere") return ALWAYS_TRUE;
				const p = this.#addParam(node.value);
				return `${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`;
			}
			case "flag":
				return this.#flag(node.value);
			case "date":
				return `${prefix}date ${node.cmp} ${this.#addParam(node.value)}`;
			case "size":
				return `${sizeBytesSql(this.#idExpr, prefix)} ${node.cmp} ${this.#addParam(node.bytes)}`;
		}
	}

	#flag(flag: Extract<SearchNode, { type: "operator"; field: "flag" }>["value"]): string {
		const prefix = this.#prefix;

		switch (flag) {
			case "read":
				return `${prefix}read = 1`;
			case "unread":
				// Coalesced because `read` is nullable in mailboxes created
				// before it gained a default, where NULL means unread.
				return `COALESCE(${prefix}read, 0) = 0`;
			case "starred":
				return `${prefix}starred = 1`;
			case "unstarred":
				return `COALESCE(${prefix}starred, 0) = 0`;
			case "attachment":
				// Inline parts don't count, matching the list filter and the
				// paperclip indicator: a `cid:` image embedded in the body is
				// not an attachment to the person searching for one.
				return threading.hasAttachmentSql(this.#idExpr);
			case "muted":
				return `${prefix}thread_id IN (SELECT thread_id FROM muted_threads)`;
			case "important":
				// Priority is a header-derived hint, and 'high' is what the list
				// renders as the important marker — so `is:important` has to mean
				// the same thing or the two disagree about the same message.
				return `${prefix}priority = ${this.#addParam("high")}`;
			case "snoozed":
				return `${prefix}snoozed_until IS NOT NULL`;
		}
	}

	/** Compile any subtree. Null means "this constrains nothing". */
	compile(node: SearchNode): string | null {
		switch (node.type) {
			case "term":
				return this.#term(node);

			case "operator":
				return this.#operator(node);

			case "not": {
				const inner = this.compile(node.child);
				if (!inner) return null;
				/*
				 * Negation has to treat "did not hold" and "could not be
				 * evaluated" alike. `NOT (sender LIKE '%x%')` is NULL when
				 * `sender` is NULL, and NULL is not true, so `-from:x` excluded
				 * messages with no sender — the result set they most obviously
				 * belong in. Coalescing to 0 first fixes that.
				 */
				return `COALESCE(${inner}, 0) = 0`;
			}

			case "and": {
				const parts = node.children
					.map((child) => this.compile(child))
					.filter((sql): sql is string => sql !== null);
				if (parts.length === 0) return null;
				return parts.length === 1 ? parts[0] : `(${parts.join(" AND ")})`;
			}

			case "or": {
				const parts: string[] = [];
				for (const child of node.children) {
					const sql = this.compile(child);
					// A branch that constrains nothing leaves the whole
					// alternation unconstrained: `a OR <anything>` is satisfied
					// by every row. Saying so beats dropping the branch, which
					// would narrow to `a` and hide results that were asked for.
					if (!sql) return ALWAYS_TRUE;
					parts.push(sql);
				}
				if (parts.length === 0) return null;
				return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
			}
		}
	}
}

/** True when a subtree is pure free text, so FTS5 alone can answer it. */
function isTextOnly(node: SearchNode): boolean {
	switch (node.type) {
		case "operator":
			return false;
		case "term":
			return true;
		case "not":
			return isTextOnly(node.child);
		case "and":
		case "or":
			return node.children.every(isTextOnly);
	}
}

export interface CompileOptions {
	/** Table alias used in the statement, e.g. `e`. Empty for none. */
	tableAlias?: string;
	/** How free text is matched. `like` is the pre-index fallback. */
	mode?: TextMode;
	/**
	 * Folder to scope to when the query names none.
	 *
	 * Used by the agent's `search_emails` tool, which receives a folder
	 * out-of-band rather than in the query string.
	 */
	defaultFolder?: string;
	/** Placeholder number already consumed by clauses earlier in the statement. */
	paramOffset?: number;
}

interface CompiledSearch {
	/** Conditions to AND together into the WHERE clause. */
	conditions: string[];
	/** Bound values, positional and aligned with the `?N` placeholders. */
	params: (string | number)[];
	/**
	 * The hoisted FTS5 expression, when one was extracted.
	 *
	 * Non-null means the statement should join the `matches` CTE, which both
	 * filters and supplies `snippet()`. Its parameter is not in `params` — the
	 * assembler binds it, because the CTE precedes the WHERE clause.
	 */
	matchExpression: string | null;
}

/**
 * Decide which top-level conjuncts the index answers and which SQL answers.
 *
 * Split out from compilation because the answer determines how many parameters
 * the statement binds *before* its predicates — the snippet CTE precedes the
 * WHERE clause — and compiling twice to discover that was both wasteful and a
 * standing invitation for the two passes to disagree.
 */
function planSearch(
	node: SearchNode | null,
	mode: TextMode = "fts",
): { matchExpression: string | null; structural: SearchNode[] } {
	// Text can only be hoisted from the top-level conjunction. Nested inside an
	// OR, a text branch cannot be pulled out without changing what was asked.
	const conjuncts = node ? (node.type === "and" ? node.children : [node]) : [];
	if (mode === "like") return { matchExpression: null, structural: conjuncts };

	const textNodes = conjuncts.filter(isTextOnly);
	const matchExpression = textNodes.length > 0
		? toFtsMatchExpression(
			textNodes.length === 1 ? textNodes[0] : { type: "and", children: textNodes },
		)
		: null;

	// A null expression with text present means FTS5 cannot express that text
	// alone — a bare negation, or punctuation. Those go back through the
	// predicate path, which expresses both.
	const structural = matchExpression
		? conjuncts.filter((child) => !isTextOnly(child))
		: conjuncts;

	return { matchExpression, structural };
}

/**
 * Compile a search AST into WHERE conditions and bound parameters.
 *
 * The hoisted MATCH is not among the conditions: the caller joins the CTE that
 * carries it, or adds it as a subquery when no snippet is wanted.
 */
export function compileSearch(
	node: SearchNode | null,
	options: CompileOptions = {},
): CompiledSearch {
	const { tableAlias = "", mode = "fts", defaultFolder, paramOffset = 0 } = options;
	const prefix = tableAlias ? `${tableAlias}.` : "";
	const compiler = new Compiler(tableAlias, mode, paramOffset);
	const conditions: string[] = [];

	const { matchExpression, structural } = planSearch(node, mode);

	for (const child of structural) {
		const sql = compiler.compile(child);
		if (sql) conditions.push(sql);
	}

	if (!hasFolderScope(node) && !includesEverywhere(node)) {
		if (defaultFolder) {
			// The agent's tool passes a folder out-of-band. It loses to an
			// explicit `in:`, which the guard above has already ruled out.
			const folderSql = compiler.compile({
				type: "operator",
				field: "folder",
				value: defaultFolder,
			});
			if (folderSql) conditions.push(folderSql);
		} else {
			// Deleted and junk mail stays out of unscoped results. Searching is
			// how people look for mail they still have, and a hit in Trash reads
			// as "it's still there" when it is on its way out. `in:trash` /
			// `in:spam` name a folder and `in:anywhere` opts out, so both stay
			// reachable deliberately.
			//
			// Compared against folder ids, not a name lookup: see
			// `threading.folderIdLiteral` for why matching on `folders.name` is
			// always NULL.
			conditions.push(
				`${prefix}folder_id NOT IN (${threading.folderIdLiteral(Folders.TRASH)}, ${threading.folderIdLiteral(Folders.SPAM)})`,
			);
		}
	}

	const budget = SQL_MAX_BOUND_PARAMS - paramOffset - RESERVED_PARAMS;
	if (compiler.params.length > budget) {
		// Unreachable given the parser's node cap and one parameter per node.
		// Thrown rather than handled because the alternatives — dropping a
		// predicate, or letting SQLite reject the statement — are respectively a
		// silently wrong answer and a 500 on a query the reader could not have
		// known was too complex. The DO's fallback catches this and retries with
		// a scan, which has no such limit.
		throw new Error(
			`search bound ${compiler.params.length} parameters, over the ${budget} available`,
		);
	}

	return { conditions, params: compiler.params, matchExpression };
}

/** Columns the list projection returns, less the snippet. */
const LIST_COLUMNS = `e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
			e.read, e.starred, e.in_reply_to, e.email_references,
			e.thread_id, e.folder_id, e.priority, e.snoozed_until,
			e.delivery_status, e.delivery_error, e.sender_name, e.security_warnings,
			${engagementColumnsSql("e")},
			f.name as folder_name`;

/**
 * Number of parameters the snippet CTE binds ahead of any predicate.
 *
 * Two markers, a token count and the MATCH expression.
 */
const CTE_PARAMS = 4;

export interface SearchStatement {
	sql: string;
	params: (string | number)[];
	/**
	 * True when `snippet` is an FTS5 excerpt of the raw indexed body (and so may
	 * hold markup); false when it is the stored plain-text preview.
	 */
	ftsSnippet?: boolean;
}

export interface ListOptions extends CompileOptions {
	limit: number;
	offset: number;
}

/**
 * Assemble the search list statement.
 *
 * Two shapes, because highlighting is only available where a MATCH is: with a
 * hoisted expression the CTE supplies `snippet`, and without one the projection
 * falls back to the leading characters of the body — the same thing the list
 * showed before highlighting existed.
 */
export function searchListSql(
	node: SearchNode | null,
	options: ListOptions,
): SearchStatement {
	const { limit, offset, ...compileOptions } = options;
	// The plan is consulted before compiling because whether a MATCH is hoisted
	// decides the placeholder the predicates start numbering from — the CTE
	// carrying it is textually first. Deriving both from one plan is what keeps
	// the offset and the conditions in step.
	const { matchExpression } = planSearch(node, compileOptions.mode ?? "fts");
	const compiled = compileSearch(node, {
		...compileOptions,
		tableAlias: "e",
		paramOffset: matchExpression ? CTE_PARAMS : 0,
	});

	const params: (string | number)[] = matchExpression
		? [SNIPPET_MARK_OPEN, SNIPPET_MARK_CLOSE, SNIPPET_TOKENS, matchExpression]
		: [];
	params.push(...compiled.params);

	const where = compiled.conditions.length > 0
		? `WHERE ${compiled.conditions.join(" AND ")}`
		: "";

	// Column -1 lets FTS5 quote whichever indexed column actually matched, so a
	// subject hit is quoted from the subject rather than from an unrelated slice
	// of the body.
	//
	// The page is chosen first and only its rows are quoted. `snippet()` reads
	// the indexed text of every row it runs on, so computing it in the CTE that
	// carries the MATCH (as this once did) read the body of every hit before
	// LIMIT applied: on a cold mailbox, `in:anywhere invoice` paged in every
	// matching message to show 25 of them. The correlated lookup is a rowid seek
	// into the index, once per row on the page.
	const limitParam = `?${params.length + 1}`;
	const offsetParam = `?${params.length + 2}`;
	const sql = matchExpression
		? `WITH page AS (
			SELECT e.rowid AS rid FROM emails e
			WHERE e.rowid IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?4)
			${compiled.conditions.length > 0 ? `AND ${compiled.conditions.join(" AND ")}` : ""}
			ORDER BY e.date DESC, e.id DESC
			LIMIT ${limitParam} OFFSET ${offsetParam}
		)
		SELECT ${LIST_COLUMNS},
			(SELECT snippet(emails_fts, -1, ?1, ?2, '…', ?3)
			   FROM emails_fts
			  WHERE emails_fts MATCH ?4 AND emails_fts.rowid = e.rowid) as snippet,
			${threading.hasAttachmentSql("e.id")} as has_attachment
		FROM page p
		JOIN emails e ON e.rowid = p.rid
		LEFT JOIN folders f ON e.folder_id = f.id
		ORDER BY e.date DESC, e.id DESC`
		: `SELECT ${LIST_COLUMNS},
			COALESCE(e.snippet, SUBSTR(e.body, 1, ${PLAIN_SNIPPET_LENGTH})) as snippet,
			${threading.hasAttachmentSql("e.id")} as has_attachment
		FROM emails e
		LEFT JOIN folders f ON e.folder_id = f.id
		${where}
		ORDER BY e.date DESC, e.id DESC
		LIMIT ${limitParam} OFFSET ${offsetParam}`;

	params.push(limit, offset);
	return { sql, params, ftsSnippet: !!matchExpression };
}

/**
 * Assemble the matching count statement.
 *
 * Shares `compileSearch` with the list rather than reimplementing the
 * predicates, because a list and count that disagree produce an empty last page
 * — a bug that is invisible until someone pages to the end.
 */
export function searchCountSql(
	node: SearchNode | null,
	options: CompileOptions = {},
): SearchStatement {
	const { matchExpression } = planSearch(node, options.mode ?? "fts");
	const compiled = compileSearch(node, {
		...options,
		tableAlias: "e",
		// The count needs no snippet, so the MATCH expression alone precedes the
		// predicates rather than the CTE's full set.
		paramOffset: matchExpression ? 1 : 0,
	});

	const params: (string | number)[] = matchExpression ? [matchExpression] : [];
	params.push(...compiled.params);

	const conditions = matchExpression
		? [`e.rowid IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?1)`, ...compiled.conditions]
		: compiled.conditions;

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	return {
		sql: `SELECT COUNT(*) as total FROM emails e ${where}`,
		params,
	};
}
