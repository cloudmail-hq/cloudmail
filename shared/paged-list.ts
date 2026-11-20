// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Helpers for "load more" lists built from server pages.
 *
 * Offset pages shift while new rows arrive, so page 2 can repeat the last rows
 * of page 1. Flattening keeps the first occurrence of each id, which is the
 * position the reader has already seen.
 */

export function flattenPages<T>(pages: readonly (readonly T[])[], idOf: (item: T) => string): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const page of pages) {
		for (const item of page) {
			const id = idOf(item);
			if (seen.has(id)) continue;
			seen.add(id);
			out.push(item);
		}
	}
	return out;
}

/** The next 1-based page to request, or undefined when everything is loaded. */
export function nextPageNumber(loadedPages: number, pageSize: number, total: number): number | undefined {
	if (pageSize <= 0) return undefined;
	return loadedPages * pageSize < total ? loadedPages + 1 : undefined;
}
