/**
 * Fuzzy matching for the command palette and the `;` snippet picker.
 *
 * Small and deterministic on purpose: a palette is only useful if the same
 * keystrokes land on the same row every time, so the scoring is a fixed ladder
 * rather than anything adaptive.
 *
 * 1. Exact match.
 * 2. Prefix of the whole text ("arc" → "Archive").
 * 3. Prefix of a word ("tom" → "Snooze until tomorrow").
 * 4. Substring anywhere.
 * 5. Initials / subsequence ("mau" → "Mark as unread"), scored by how many
 *    characters land on word starts or run consecutively, and penalised for
 *    the gaps between them.
 *
 * A query with spaces that doesn't match as a whole is tried word by word,
 * and every word has to match somewhere.
 */

const EXACT = 1000;
const PREFIX = 900;
const WORD_PREFIX = 800;
const SUBSTRING = 700;
/** Subsequence scores stay below every literal match. */
const SUBSEQUENCE_CAP = 600;

/** Lowercase, strip accents and collapse whitespace. */
export function normalize(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

function isWordStart(text: string, index: number): boolean {
	if (index === 0) return true;
	return /[^\p{L}\p{N}]/u.test(text[index - 1]);
}

/**
 * Characters of `query` in order within `text`, as chunks of word starts.
 *
 * Every character has to either continue the previous match or begin a word,
 * and the first has to begin one. That accepts initials ("mau" → Mark As
 * Unread) and word-prefix chunks ("snotom" → SNOoze until TOMorrow), and
 * rejects letters scattered mid-word ("arc" inside "Reply in a full-screen
 * composer"), which in a 60-row list are noise, not intent.
 *
 * A small backtracking search, because the greedy first occurrence of a
 * letter is often mid-word while a later one starts a word.
 */
function subsequenceScore(query: string, text: string): number | null {
	const chars = [...query.replace(/ /g, "")];
	let best: number | null = null;

	const search = (qi: number, previous: number, score: number, budget: { left: number }) => {
		if (budget.left-- <= 0) return;
		if (qi === chars.length) {
			if (best === null || score > best) best = score;
			return;
		}
		const char = chars[qi];
		for (let at = text.indexOf(char, previous + 1); at !== -1; at = text.indexOf(char, at + 1)) {
			const consecutive = at === previous + 1 && qi > 0;
			const wordStart = isWordStart(text, at);
			if (!consecutive && !wordStart) continue;
			// Continuing a chunk is worth more than starting a new word; gaps cost.
			const gap = qi === 0 ? at : at - previous - 1;
			search(qi + 1, at, score + 10 + (consecutive ? 15 : 8) - Math.min(gap, 20) * 0.5, budget);
		}
	};
	search(0, -1, 0, { left: 2000 });
	if (best === null) return null;
	return Math.min(best, SUBSEQUENCE_CAP - 1) - text.length * 0.1;
}

function literalScore(query: string, text: string): number | null {
	if (text === query) return EXACT;
	if (text.startsWith(query)) return PREFIX - (text.length - query.length) * 0.5;
	const at = text.indexOf(query);
	if (at === -1) return null;
	let index = at;
	// The first occurrence may sit mid-word while a later one starts a word.
	while (index !== -1) {
		if (isWordStart(text, index)) return WORD_PREFIX - index * 0.5;
		index = text.indexOf(query, index + 1);
	}
	return SUBSTRING - at * 0.5;
}

/**
 * How well `query` matches `text`, or null for no match. Higher is better.
 * An empty query matches everything with score 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
	const q = normalize(query);
	if (!q) return 0;
	const t = normalize(text);
	if (!t) return null;

	const literal = literalScore(q, t);
	if (literal !== null) return literal;

	const words = q.split(" ");
	if (words.length > 1) {
		// Every word has to land; the weakest one sets the score.
		let weakest = Infinity;
		for (const word of words) {
			const score = literalScore(word, t) ?? subsequenceScore(word, t);
			if (score === null) return null;
			weakest = Math.min(weakest, score);
		}
		return Math.min(weakest, SUBSEQUENCE_CAP) - 1;
	}

	if (q.length < 2) return null;
	return subsequenceScore(q, t);
}

export interface FuzzyFields {
	/** Primary text. Matches here count in full. */
	title: string;
	/** Secondary text (an address, a folder path). */
	subtitle?: string;
	/** Synonyms that should find the item. */
	keywords?: readonly string[];
}

/** Best score across an item's fields, with secondary fields discounted. */
export function scoreFields(query: string, fields: FuzzyFields): number | null {
	let best: number | null = fuzzyScore(query, fields.title);
	const consider = (score: number | null, weight: number) => {
		if (score === null) return;
		const weighted = score * weight;
		if (best === null || weighted > best) best = weighted;
	};
	if (fields.subtitle) consider(fuzzyScore(query, fields.subtitle), 0.85);
	for (const keyword of fields.keywords ?? []) {
		consider(fuzzyScore(query, keyword), 0.9);
	}
	return best;
}

/**
 * Filter and sort `items` by `query`. Stable: equal scores keep input order,
 * so callers control tie-breaks by the order they pass items in.
 */
export function fuzzyFilter<T>(
	items: readonly T[],
	query: string,
	fields: (item: T) => FuzzyFields,
	boost: (item: T) => number = () => 0,
): T[] {
	const scored: { item: T; score: number; index: number }[] = [];
	items.forEach((item, index) => {
		const score = scoreFields(query, fields(item));
		if (score === null) return;
		scored.push({ item, score: score + boost(item), index });
	});
	scored.sort((a, b) => b.score - a.score || a.index - b.index);
	return scored.map((entry) => entry.item);
}
