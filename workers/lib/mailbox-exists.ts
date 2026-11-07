/**
 * Per-isolate memo of "this mailbox exists", for `requireMailbox`.
 *
 * Every `/api/v1/mailboxes/:id/*` request used to begin with an R2
 * `HEAD mailboxes/<id>.json`. That round trip was most of the fixed cost of a
 * mailbox call, and the client pays it every few seconds for the `/state`
 * poll alone. The answer almost never changes, so the hot path stops waiting
 * for it.
 *
 * Stale-while-revalidate: a positive answer younger than `FRESH_MS` is used
 * as is; one up to `MAX_AGE_MS` old is used while a background HEAD refreshes
 * it; anything older is looked up inline. So a deleted mailbox is refused on
 * the first request after a background check notices (one poll interval in
 * practice), and never later than `MAX_AGE_MS`.
 *
 * What keeps this from weakening anything:
 *
 * - **Only existence is cached, never authority.** `requireMailbox` still runs
 *   `canAccessMailbox` on every request against a principal resolved for that
 *   request, so a revoked grant takes effect immediately.
 * - **Only positive answers are cached.** A mailbox that does not exist is
 *   looked up again each time, so a new mailbox works the moment it is created.
 * - **Only reads use it.** Writes always ask R2 inline, so a stale entry can at
 *   worst let a GET reach a mailbox deleted seconds ago — whose Durable Object
 *   has been purged, so there is nothing left to read — and never writes data
 *   into one.
 * - **Cleared on delete.** The deleting isolate forgets the mailbox at once.
 */

/** A positive answer this young is used without a background check. */
export const MAILBOX_EXISTS_FRESH_MS = 1_000;
/** Hard ceiling on how long a positive answer is trusted at all. */
export const MAILBOX_EXISTS_MAX_AGE_MS = 10_000;

/** Bound on entries, so a scan of random ids cannot grow the map forever. */
const MAX_ENTRIES = 1_000;

interface Entry {
	/** When R2 last confirmed the mailbox. */
	at: number;
	/** A background refresh in flight, so concurrent reads share one HEAD. */
	refreshing?: Promise<unknown>;
}

const known = new Map<string, Entry>();

/**
 * Bumped by `forgetMailboxExists`. A lookup that started before a forget must
 * not write its (now possibly stale) positive answer back afterwards, or a
 * background refresh in flight during a delete would resurrect the mailbox.
 */
const generations = new Map<string, number>();
const generationOf = (id: string) => generations.get(id) ?? 0;

function isRead(method: string): boolean {
	const m = method.toUpperCase();
	return m === "GET" || m === "HEAD";
}

function remember(mailboxId: string, at: number): void {
	// Re-insert so iteration order tracks the last confirmation, and eviction
	// drops the least recently confirmed entry.
	known.delete(mailboxId);
	if (known.size >= MAX_ENTRIES) {
		// Oldest insertion first: Map iteration order is insertion order.
		const oldest = known.keys().next().value;
		if (oldest !== undefined) known.delete(oldest);
	}
	known.set(mailboxId, { at });
}

async function lookup(
	mailboxId: string,
	head: () => Promise<unknown>,
	now: () => number,
): Promise<boolean> {
	const generation = generationOf(mailboxId);
	const exists = (await head()) != null;
	if (generation !== generationOf(mailboxId)) {
		// Forgotten while the HEAD was in flight: report what R2 said, but leave
		// the memo empty so the next request asks again.
		return exists;
	}
	if (exists) remember(mailboxId, now());
	else known.delete(mailboxId);
	return exists;
}

export interface MailboxExistsOptions {
	/** Request method; only GET and HEAD may use the memo. */
	method: string;
	/** The authoritative lookup (an R2 HEAD in production). */
	head: () => Promise<unknown>;
	/** Keeps a background refresh alive past the response (`ctx.waitUntil`). */
	waitUntil?: (promise: Promise<unknown>) => void;
	now?: () => number;
}

/** Whether `mailboxId` has a settings object. */
export async function mailboxExists(
	mailboxId: string,
	{ method, head, waitUntil, now = Date.now }: MailboxExistsOptions,
): Promise<boolean> {
	if (!isRead(method)) return lookup(mailboxId, head, now);

	const entry = known.get(mailboxId);
	const age = entry ? now() - entry.at : Infinity;
	if (!entry || age >= MAILBOX_EXISTS_MAX_AGE_MS) return lookup(mailboxId, head, now);

	if (age >= MAILBOX_EXISTS_FRESH_MS && !entry.refreshing) {
		const refresh = lookup(mailboxId, head, now)
			.catch((e) => {
				// A failed refresh leaves the entry to age out; the next inline
				// lookup surfaces the error.
				console.error(`mailbox existence refresh failed for ${mailboxId}:`, (e as Error).message);
			})
			.finally(() => {
				const current = known.get(mailboxId);
				if (current?.refreshing === refresh) current.refreshing = undefined;
			});
		entry.refreshing = refresh;
		waitUntil?.(refresh);
	}
	return true;
}

/** Forget a mailbox, e.g. right after deleting it. */
export function forgetMailboxExists(mailboxId: string): void {
	known.delete(mailboxId);
	generations.set(mailboxId, generationOf(mailboxId) + 1);
	// Bounded like the memo itself; an old generation only matters while a
	// lookup is in flight, which is milliseconds.
	if (generations.size > MAX_ENTRIES) {
		const oldest = generations.keys().next().value;
		if (oldest !== undefined && oldest !== mailboxId) generations.delete(oldest);
	}
}

/** Test hook. */
export function clearMailboxExistsCache(): void {
	known.clear();
	generations.clear();
}
