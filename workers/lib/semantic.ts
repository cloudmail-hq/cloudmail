// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hybrid search and "Ask my inbox", Worker side.
 *
 * ## Authorization
 *
 * The caller passes the mailboxes the principal may read (already narrowed by
 * `canDo(read)` and any token mailbox allowlist). Nothing here widens that:
 *
 *   1. each Vectorize query runs in that mailbox's own namespace *and* filters
 *      on `metadata.mailbox`;
 *   2. every match is dropped unless its metadata names a mailbox in the
 *      readable set *and* the namespace it was asked from;
 *   3. hydration asks that mailbox's own Durable Object for the email id, so a
 *      vector that somehow points elsewhere resolves to nothing.
 *
 * ## Degradation
 *
 * No `SEMANTIC_INDEX` binding, no `AI` binding, the admin toggle off, or a
 * Vectorize/AI error: search returns the full-text results and says so
 * (`semantic: false`), and Ask retrieves with full-text only.
 */

import type { Env } from "../types";
import {
	ASK_MAX_SOURCES,
	ASK_SOURCE_CHARS,
	ASK_SYSTEM_PROMPT,
	INSUFFICIENT_MESSAGE,
	MAX_QUESTION_CHARS,
	buildAskPrompt,
	hitKey,
	keywordQuery,
	looksLikeQuestion,
	mailboxNamespace,
	parseAskAnswer,
	questionText,
	reciprocalRankFusion,
	type AskAnswer,
	type AskSource,
} from "../../shared/semantic";
import { cleanBodyForSummary } from "../../shared/ai-summary";
import { toPlainSnippet } from "../../shared/plain-snippet";
import { randomBoundary } from "../../shared/untrusted-content";
import type { AiConfig } from "../../shared/ai-settings";
import { aiFor, roleEnabled, type AiHandle } from "./ai-router";
import { getAiConfig } from "./ai-config";
import { embeddingModelKey, type HydratedHit, type VectorizeIndexLike } from "../durableObject/semantic";

/** Mailboxes one hybrid query fans out to. Matches the unified inbox. */
export const SEMANTIC_MAILBOX_CAP = 20;
/** Vector matches asked for per mailbox (Vectorize allows 50 with metadata). */
export const VECTOR_TOP_K = 20;
/** Full-text rows taken per mailbox for fusion. */
export const FTS_TOP_K = 20;

export interface SemanticDeps {
	ai: AiHandle | undefined;
	index: VectorizeIndexLike | undefined;
	config: Pick<AiConfig, "semantic">;
	/** The mailbox's Durable Object, narrowed to what this module calls. */
	stub: (mailbox: string) => SemanticMailboxStub;
}

export interface SemanticMailboxStub {
	searchEmails(o: { query: string; folder?: string; page?: number; limit?: number }): Promise<Record<string, unknown>[]>;
	hydrateSemanticHits(ids: string[], options?: { includeAll?: boolean; bodyChars?: number }): Promise<HydratedHit[]>;
	recordSemanticQuery?(): Promise<void>;
	/** The model this mailbox's vectors came from (`provider:model`). Optional for older stubs and tests. */
	semanticEmbeddingModel?(): Promise<string>;
}

/** The binding, or undefined when the index was never created. */
export function semanticIndex(env: Env): VectorizeIndexLike | undefined {
	const index = (env as { SEMANTIC_INDEX?: unknown }).SEMANTIC_INDEX;
	return index && typeof (index as VectorizeIndexLike).query === "function" ? (index as VectorizeIndexLike) : undefined;
}

export async function semanticDeps(env: Env): Promise<SemanticDeps> {
	return {
		// With a gateway active and embeddings off (or unusable), vector search is
		// unavailable and search uses full-text; Ask still answers from FTS hits.
		ai: (await roleEnabled(env, "embeddings")) ? aiFor(env, { feature: "semantic" }) : undefined,
		index: semanticIndex(env),
		config: await getAiConfig(env.BUCKET),
		stub: (mailbox) => env.MAILBOX.get(env.MAILBOX.idFromName(mailbox)) as unknown as SemanticMailboxStub,
	};
}

/** Whether vector retrieval can run at all. */
export function semanticAvailable(deps: Pick<SemanticDeps, "ai" | "index" | "config">): boolean {
	return !!deps.ai && !!deps.index && deps.config.semantic;
}

export interface HybridHit {
	mailboxId: string;
	id: string;
	thread_id: string | null;
	folder_id: string;
	subject: string | null;
	sender: string | null;
	sender_name: string | null;
	recipient: string | null;
	date: string | null;
	read: boolean;
	starred: boolean;
	snippet: string | null;
	/** `fts`, `vector` or both: which retrievers found it. */
	matched: ("fts" | "vector")[];
	score: number;
	/** Present when `bodyChars` was asked for (Ask). Untrusted. */
	body?: string | null;
}

export interface HybridResult {
	results: HybridHit[];
	/** True when vector retrieval contributed. */
	semantic: boolean;
	/** Why it did not, when it did not. */
	fallback?: "unavailable" | "disabled" | "error";
	mailboxes: string[];
	truncated: string[];
}

interface VectorCandidate {
	key: string;
	mailbox: string;
	emailId: string;
	score: number;
}

/**
 * Vector matches for one mailbox, with the authz filter applied to what
 * Vectorize returned. Exported for the authz test.
 */
export function acceptMatches(mailbox: string, readable: ReadonlySet<string>, matches: VectorizeMatch[]): VectorCandidate[] {
	const m = mailbox.toLowerCase();
	if (!readable.has(m)) return [];
	const out: VectorCandidate[] = [];
	const seen = new Set<string>();
	for (const match of matches) {
		const meta = (match.metadata ?? {}) as Record<string, unknown>;
		const metaMailbox = typeof meta.mailbox === "string" ? meta.mailbox.toLowerCase() : null;
		const emailId = typeof meta.email_id === "string" ? meta.email_id : null;
		// Never trust the index alone: the vector must say it belongs to the
		// mailbox it was asked from, and that mailbox must be readable.
		if (!metaMailbox || metaMailbox !== m || !readable.has(metaMailbox) || !emailId) continue;
		if (match.namespace && match.namespace !== mailboxNamespace(m)) continue;
		if (seen.has(emailId)) continue; // several chunks of one message
		seen.add(emailId);
		out.push({ key: hitKey(m, emailId), mailbox: m, emailId, score: match.score });
	}
	return out;
}

async function vectorCandidates(
	deps: SemanticDeps,
	mailboxes: string[],
	readable: ReadonlySet<string>,
	query: string,
): Promise<VectorCandidate[][]> {
	const resolved = await deps.ai!.resolve("embeddings");
	const current = embeddingModelKey(resolved.providerId, resolved.modelId);
	// A mailbox whose vectors came from another model (the admin changed it and
	// that mailbox hasn't re-indexed yet) is searched with full-text only: a
	// query vector is never compared with another model's vectors.
	const [vector, stamps] = await Promise.all([
		resolved.embed([query]).then((v) => v[0]),
		Promise.all(
			mailboxes.map(async (m) => {
				try {
					return (await deps.stub(m).semanticEmbeddingModel?.()) ?? null;
				} catch {
					return null;
				}
			}),
		),
	]);
	return Promise.all(
		mailboxes.map(async (mailbox, i) => {
			const stamp = stamps[i];
			// Pre-stamp mailboxes keep main's behaviour until their first semantic run stamps them.
			if (resolved.fallback || (stamp && stamp !== "unstamped" && stamp !== current)) return [];
			const res = await deps.index!.query(vector!, {
				topK: VECTOR_TOP_K,
				namespace: mailboxNamespace(mailbox),
				returnMetadata: "indexed" as never,
				filter: { mailbox: { $eq: mailbox } },
			});
			return acceptMatches(mailbox, readable, res.matches ?? []);
		}),
	);
}

/** Rows from the existing full-text search, as fusion candidates. */
async function ftsCandidates(
	deps: SemanticDeps,
	mailboxes: string[],
	query: string,
	folder?: string,
): Promise<{ mailbox: string; rows: Record<string, unknown>[] }[]> {
	if (!query.trim()) return mailboxes.map((mailbox) => ({ mailbox, rows: [] }));
	const settled = await Promise.allSettled(
		mailboxes.map(async (mailbox) => ({
			mailbox,
			rows: await deps.stub(mailbox).searchEmails({ query, folder, page: 1, limit: FTS_TOP_K }),
		})),
	);
	return settled.map((s, i) =>
		s.status === "fulfilled" ? s.value : { mailbox: mailboxes[i]!, rows: [] },
	);
}

function fromFtsRow(mailbox: string, row: Record<string, unknown>): Omit<HybridHit, "matched" | "score"> {
	return {
		mailboxId: mailbox,
		id: String(row.id),
		thread_id: (row.thread_id as string | null) ?? null,
		folder_id: String(row.folder_id ?? ""),
		subject: (row.subject as string | null) ?? null,
		sender: (row.sender as string | null) ?? null,
		sender_name: (row.sender_name as string | null) ?? null,
		recipient: (row.recipient as string | null) ?? null,
		date: (row.date as string | null) ?? null,
		read: !!row.read,
		starred: !!row.starred,
		snippet: (row.snippet as string | null) ?? null,
	};
}

export interface HybridOptions {
	/** Text for the full-text side. Defaults to `query`. */
	ftsQuery?: string;
	folder?: string;
	limit?: number;
	/** Include body text (for Ask). */
	bodyChars?: number;
}

/**
 * Hybrid search over `readable` mailboxes: full-text and vectors, merged by
 * reciprocal rank fusion, hydrated from each mailbox's own Durable Object.
 */
export async function hybridSearch(
	deps: SemanticDeps,
	readable: readonly string[],
	query: string,
	options: HybridOptions = {},
): Promise<HybridResult> {
	const sorted = [...new Set(readable.map((m) => m.toLowerCase()))].sort();
	const mailboxes = sorted.slice(0, SEMANTIC_MAILBOX_CAP);
	const truncated = sorted.slice(SEMANTIC_MAILBOX_CAP);
	const readableSet = new Set(sorted);
	const limit = Math.min(Math.max(options.limit ?? 25, 1), 50);

	// A question as full-text would AND every word; its keywords OR'd find candidates.
	const ftsText = options.ftsQuery ?? (looksLikeQuestion(query) ? keywordQuery(query) : query);
	const ftsPromise = ftsCandidates(deps, mailboxes, ftsText, options.folder);

	let semantic = false;
	let fallback: HybridResult["fallback"];
	let vectorLists: VectorCandidate[][] = [];
	if (!deps.config.semantic) fallback = "disabled";
	else if (!deps.ai || !deps.index) fallback = "unavailable";
	else if (query.trim()) {
		try {
			vectorLists = await vectorCandidates(deps, mailboxes, readableSet, query.slice(0, MAX_QUESTION_CHARS));
			semantic = true;
			await Promise.allSettled(mailboxes.map((m) => deps.stub(m).recordSemanticQuery?.()));
		} catch (e) {
			console.warn("semantic search: vector retrieval failed, using full-text only:", (e as Error).message);
			fallback = "error";
		}
	}

	const ftsPages = await ftsPromise;
	const ftsRows = new Map<string, Omit<HybridHit, "matched" | "score">>();
	// Interleave per-mailbox FTS rankings by rank, so one mailbox cannot fill the list.
	const ftsList: { key: string }[] = [];
	const maxLen = Math.max(0, ...ftsPages.map((p) => p.rows.length));
	for (let r = 0; r < maxLen; r++) {
		for (const page of ftsPages) {
			const row = page.rows[r];
			if (!row || !readableSet.has(page.mailbox)) continue;
			const key = hitKey(page.mailbox, String(row.id));
			ftsRows.set(key, fromFtsRow(page.mailbox, row));
			ftsList.push({ key });
		}
	}
	const vectorList = vectorLists.flat().sort((a, b) => b.score - a.score);
	const vectorKeys = new Set(vectorList.map((v) => v.key));

	const fused = reciprocalRankFusion([ftsList, vectorList]).slice(0, limit);

	// Hydrate: vector-only hits, and every hit when bodies are wanted.
	const needs = new Map<string, string[]>();
	for (const hit of fused) {
		if (ftsRows.has(hit.key) && !options.bodyChars) continue;
		const [mailbox, emailId] = hit.key.split("\u0000") as [string, string];
		if (!readableSet.has(mailbox)) continue;
		needs.set(mailbox, [...(needs.get(mailbox) ?? []), emailId]);
	}
	const hydrated = new Map<string, HydratedHit>();
	await Promise.all(
		[...needs].map(async ([mailbox, ids]) => {
			try {
				const rows = await deps.stub(mailbox).hydrateSemanticHits(ids, {
					includeAll: options.folder === "anywhere",
					bodyChars: options.bodyChars,
				});
				for (const row of rows) hydrated.set(hitKey(mailbox, row.id), row);
			} catch (e) {
				console.warn(`semantic search: hydrating ${mailbox} failed:`, (e as Error).message);
			}
		}),
	);

	const results: HybridHit[] = [];
	for (const hit of fused) {
		const [mailbox] = hit.key.split("\u0000") as [string, string];
		const h = hydrated.get(hit.key);
		const base = h
			? {
					mailboxId: mailbox,
					id: h.id,
					thread_id: h.thread_id,
					folder_id: h.folder_id,
					subject: h.subject,
					sender: h.sender,
					sender_name: h.sender_name,
					recipient: h.recipient,
					date: h.date,
					read: h.read,
					starred: h.starred,
					snippet: ftsRows.get(hit.key)?.snippet ?? h.snippet,
				}
			: ftsRows.get(hit.key);
		// A vector hit that did not hydrate (deleted, Spam/Trash, or not in this
		// mailbox) is dropped: the index is never the source of truth.
		if (!base || !readableSet.has(base.mailboxId)) continue;
		results.push({
			...base,
			matched: [...(ftsRows.has(hit.key) ? (["fts"] as const) : []), ...(vectorKeys.has(hit.key) ? (["vector"] as const) : [])],
			score: Number(hit.rrf.toFixed(6)),
			...(options.bodyChars ? { body: h?.body ?? null } : {}),
		});
	}

	return { results, semantic, ...(fallback ? { fallback } : {}), mailboxes, truncated };
}

// ── Ask ────────────────────────────────────────────────────────────

export interface AskResult extends AskAnswer {
	question: string;
	semantic: boolean;
	mailboxes: string[];
	/** The sources retrieved, cited or not, so a client can show "based on". */
	sources: { n: number; mailboxId: string; email_id: string; subject: string; from: string | null; date: string | null }[];
}

/** The passage of a message the model sees: its cleaned text, bounded. */
export function sourcePassage(hit: Pick<HybridHit, "body" | "snippet">): string {
	const cleaned = cleanBodyForSummary(hit.body ?? "");
	const text = cleaned || toPlainSnippet(hit.body ?? "") || hit.snippet || "";
	return text.slice(0, ASK_SOURCE_CHARS);
}

/**
 * Run the answer model (role `ask_answer`). On Workers AI this asks for
 * `reasoning_effort: "none"` first, then retries without it.
 */
async function runAnswerModel(ai: AiHandle, system: string, user: string): Promise<string | null> {
	const model = await ai.resolve("ask_answer");
	return model.text({ system, user, maxTokens: 500, temperature: 0.1, reasoning: "none" });
}

/**
 * Answer a question from the caller's mail, with citations.
 *
 * Retrieval is hybrid (FTS on the question's keywords, vectors on the whole
 * question). Every passage reaches the model inside a random-boundary fence,
 * after the fixed safety preamble. With no passages the model is not called.
 */
export async function askInbox(
	deps: SemanticDeps,
	readable: readonly string[],
	rawQuestion: string,
): Promise<AskResult> {
	const question = questionText(rawQuestion).slice(0, MAX_QUESTION_CHARS);
	const retrieval = await hybridSearch(deps, readable, question, {
		ftsQuery: keywordQuery(question),
		limit: ASK_MAX_SOURCES,
		bodyChars: ASK_SOURCE_CHARS * 4,
	});

	const sources: AskSource[] = retrieval.results
		.map((hit) => ({ hit, text: sourcePassage(hit) }))
		.filter(({ text }) => text.trim().length > 0)
		.slice(0, ASK_MAX_SOURCES)
		.map(({ hit, text }, i) => ({
			n: i + 1,
			mailbox: hit.mailboxId,
			email_id: hit.id,
			thread_id: hit.thread_id,
			folder: hit.folder_id || null,
			subject: hit.subject ?? "",
			from: hit.sender_name ? `${hit.sender_name} <${hit.sender ?? ""}>` : hit.sender,
			date: hit.date,
			text,
		}));

	const listed = sources.map((s) => ({
		n: s.n,
		mailboxId: s.mailbox,
		email_id: s.email_id,
		subject: s.subject,
		from: s.from,
		date: s.date,
	}));
	const base = { question, semantic: retrieval.semantic, mailboxes: retrieval.mailboxes, sources: listed };

	if (sources.length === 0 || !deps.ai) {
		return { ...base, answer: INSUFFICIENT_MESSAGE, insufficient: true, citations: [] };
	}

	const raw = await runAnswerModel(deps.ai, ASK_SYSTEM_PROMPT, buildAskPrompt(question, sources, randomBoundary()));
	return { ...base, ...parseAskAnswer(raw, sources) };
}
