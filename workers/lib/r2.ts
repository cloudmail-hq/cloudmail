// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Reading whole collections out of R2.
 *
 * Several features store one JSON object per record under a shared prefix —
 * templates, sequences, enrollments, scheduled sequence steps, API keys,
 * mailbox settings — and every one of them listed that prefix with a bare
 * `bucket.list({ prefix })`.
 *
 * That call returns at most 1000 keys. Past that it sets `truncated` and hands
 * back a cursor, and none of the callers looked at either: the 1001st template
 * simply did not exist as far as the app was concerned. For the sequence
 * dispatcher that is worse than a missing row in a list, because
 * `getPendingEmails` drives the cron — a busy deployment would quietly stop
 * sending the steps that sorted past the first page, with nothing logged.
 *
 * R2Bucket is an ambient global from the generated worker-configuration.d.ts.
 * Do not import it from @cloudflare/workers-types — the two declarations are
 * structurally incompatible and every call site fails to typecheck.
 */

/**
 * Keys per `list` call. 1000 is also the server-side maximum, so asking for it
 * explicitly just documents the page size that the loop below is built around.
 */
const LIST_PAGE_SIZE = 1000;

/**
 * Objects fetched at once by {@link listJsonUnderPrefix}.
 *
 * These collections are read with one `get` per key, so paging past 1000
 * records means strictly more round trips than before this file existed. Doing
 * them one at a time is what would turn a large backlog into a cron tick that
 * runs out of wall clock; a modest fan-out keeps the latency flat without
 * spending the Worker's subrequest budget all at once.
 */
const READ_CONCURRENCY = 25;

/**
 * Every key under `prefix`, following the list cursor to the end.
 */
export async function listAllKeys(
	bucket: R2Bucket,
	prefix: string,
): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;

	do {
		const page = await bucket.list({
			prefix,
			limit: LIST_PAGE_SIZE,
			cursor,
		});

		for (const object of page.objects) keys.push(object.key);

		// `cursor` is only present on a truncated page, and passing a stale one
		// would restart the walk rather than end it.
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	return keys;
}

/**
 * Read and parse every JSON object stored under `prefix`.
 *
 * Objects that have vanished between the list and the read, or that do not
 * parse, are skipped rather than thrown: these prefixes are written by earlier
 * versions of the app and by hand during support, and one malformed record
 * should not make an entire collection unreadable. Callers that need to know a
 * specific record is missing should `get` it by key instead.
 *
 * Order follows key order, which is what the R2 list returns; callers that care
 * about a particular order sort the result themselves.
 */
export async function listJsonUnderPrefix<T>(
	bucket: R2Bucket,
	prefix: string,
): Promise<T[]> {
	const keys = await listAllKeys(bucket, prefix);
	const records: T[] = [];

	for (let i = 0; i < keys.length; i += READ_CONCURRENCY) {
		const batch = await Promise.all(
			keys.slice(i, i + READ_CONCURRENCY).map(async (key) => {
				const object = await bucket.get(key);
				if (!object) return undefined;
				try {
					return await object.json<T>();
				} catch {
					return undefined;
				}
			}),
		);

		for (const record of batch) {
			if (record !== undefined) records.push(record);
		}
	}

	return records;
}
