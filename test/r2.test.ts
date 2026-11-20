// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { listAllKeys, listJsonUnderPrefix } from "../workers/lib/r2";

/**
 * A bucket that pages the way R2 does.
 *
 * The cap is the point: a fake that returned everything in one call would pass
 * against the bare `list()` these helpers replaced, which is exactly the bug
 * that shipped. `maxKeys` is settable so the paging loop can be exercised with
 * a handful of keys instead of thousands.
 */
function fakeBucket(
	contents: Record<string, unknown>,
	options: { maxKeys?: number; unreadable?: string[]; missing?: string[] } = {},
) {
	const maxKeys = options.maxKeys ?? 1000;
	const unreadable = new Set(options.unreadable ?? []);
	const missing = new Set(options.missing ?? []);
	const listCalls: (string | undefined)[] = [];
	let getCount = 0;

	const bucket = {
		list: async (opts: { prefix: string; limit?: number; cursor?: string }) => {
			listCalls.push(opts.cursor);
			const all = Object.keys(contents)
				.filter((key) => key.startsWith(opts.prefix))
				.sort();

			const start = opts.cursor ? Number(opts.cursor) : 0;
			// Honour the server's own ceiling even when asked for more.
			const size = Math.min(opts.limit ?? maxKeys, maxKeys);
			const page = all.slice(start, start + size);
			const end = start + page.length;
			const truncated = end < all.length;

			return {
				objects: page.map((key) => ({ key })),
				truncated,
				...(truncated ? { cursor: String(end) } : {}),
			};
		},
		get: async (key: string) => {
			getCount += 1;
			if (missing.has(key)) return null;
			return {
				json: async () => {
					if (unreadable.has(key)) throw new SyntaxError("bad JSON");
					return contents[key];
				},
			};
		},
	};

	return {
		bucket: bucket as unknown as R2Bucket,
		listCalls,
		getCount: () => getCount,
	};
}

function keyRange(prefix: string, count: number): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (let i = 0; i < count; i += 1) {
		// Zero-padded so lexicographic key order matches numeric order.
		out[`${prefix}${String(i).padStart(5, "0")}.json`] = { n: i };
	}
	return out;
}

describe("listAllKeys", () => {
	it("returns every key from a single page", async () => {
		const { bucket, listCalls } = fakeBucket({
			"templates/a.json": {},
			"templates/b.json": {},
		});

		expect(await listAllKeys(bucket, "templates/")).toEqual([
			"templates/a.json",
			"templates/b.json",
		]);
		// No cursor needed when nothing was truncated.
		expect(listCalls).toEqual([undefined]);
	});

	/** The regression: everything past the first page used to be invisible. */
	it("follows the cursor past the 1000-key page limit", async () => {
		const { bucket, listCalls } = fakeBucket(keyRange("scheduled-emails/", 2350));

		const keys = await listAllKeys(bucket, "scheduled-emails/");

		expect(keys).toHaveLength(2350);
		expect(keys[0]).toBe("scheduled-emails/00000.json");
		expect(keys[2349]).toBe("scheduled-emails/02349.json");
		// Three pages: 1000, 1000, 350.
		expect(listCalls).toEqual([undefined, "1000", "2000"]);
	});

	it("stops when a page is exactly the page size and nothing remains", async () => {
		const { bucket, listCalls } = fakeBucket(keyRange("sequences/", 1000));

		expect(await listAllKeys(bucket, "sequences/")).toHaveLength(1000);
		// A full-but-not-truncated page must not trigger another request.
		expect(listCalls).toEqual([undefined]);
	});

	it("only returns keys under the requested prefix", async () => {
		const { bucket } = fakeBucket({
			"templates/a.json": {},
			"sequences/b.json": {},
			"api-keys/c.json": {},
		});

		expect(await listAllKeys(bucket, "sequences/")).toEqual([
			"sequences/b.json",
		]);
	});

	it("is empty for a prefix with nothing under it", async () => {
		const { bucket } = fakeBucket({ "templates/a.json": {} });
		expect(await listAllKeys(bucket, "enrollments/")).toEqual([]);
	});
});

describe("listJsonUnderPrefix", () => {
	it("reads and parses every record across pages", async () => {
		const { bucket, getCount } = fakeBucket(keyRange("enrollments/", 1200));

		const records = await listJsonUnderPrefix<{ n: number }>(
			bucket,
			"enrollments/",
		);

		expect(records).toHaveLength(1200);
		expect(getCount()).toBe(1200);
		// Order follows key order, which the callers rely on before sorting.
		expect(records[0]).toEqual({ n: 0 });
		expect(records[1199]).toEqual({ n: 1199 });
	});

	it("skips a record that does not parse rather than failing the batch", async () => {
		const { bucket } = fakeBucket(
			{
				"templates/a.json": { slug: "a" },
				"templates/b.json": { slug: "b" },
				"templates/c.json": { slug: "c" },
			},
			{ unreadable: ["templates/b.json"] },
		);

		expect(
			await listJsonUnderPrefix<{ slug: string }>(bucket, "templates/"),
		).toEqual([{ slug: "a" }, { slug: "c" }]);
	});

	it("skips a key that disappeared between the list and the read", async () => {
		const { bucket } = fakeBucket(
			{ "templates/a.json": { slug: "a" }, "templates/b.json": { slug: "b" } },
			{ missing: ["templates/a.json"] },
		);

		expect(
			await listJsonUnderPrefix<{ slug: string }>(bucket, "templates/"),
		).toEqual([{ slug: "b" }]);
	});

	it("does no reads when the prefix is empty", async () => {
		const { bucket, getCount } = fakeBucket({ "templates/a.json": {} });

		expect(await listJsonUnderPrefix(bucket, "api-keys/")).toEqual([]);
		expect(getCount()).toBe(0);
	});
});
