// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Conditional responses for the `/state` poll. */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { etagMatches, stateEtag, stateResponse, type MailboxStateBody } from "../workers/lib/mailbox-state";

const S: MailboxStateBody = { version: 41, inboxUnread: 3, inboxUnreadHighPriority: 1 };

function app(state: () => MailboxStateBody) {
	const a = new Hono();
	a.get("/state", (c) => stateResponse(c, state()));
	return (headers: Record<string, string> = {}) => a.fetch(new Request("https://x.test/state", { headers }));
}

describe("stateEtag", () => {
	it("changes whenever any field changes", () => {
		const base = stateEtag(S);
		expect(stateEtag({ ...S, version: 42 })).not.toBe(base);
		expect(stateEtag({ ...S, inboxUnread: 4 })).not.toBe(base);
		expect(stateEtag({ ...S, inboxUnreadHighPriority: 0 })).not.toBe(base);
		expect(stateEtag({ ...S })).toBe(base);
	});

	it("is a weak, quoted validator", () => {
		expect(stateEtag(S)).toMatch(/^W\/"[^"]+"$/);
	});
});

describe("etagMatches", () => {
	const tag = stateEtag(S);
	it("matches weakly, in a list, and on *", () => {
		expect(etagMatches(tag, tag)).toBe(true);
		expect(etagMatches(tag.replace(/^W\//, ""), tag)).toBe(true);
		expect(etagMatches(`W/"other", ${tag}`, tag)).toBe(true);
		expect(etagMatches("*", tag)).toBe(true);
	});
	it("does not match a different or missing tag", () => {
		expect(etagMatches(undefined, tag)).toBe(false);
		expect(etagMatches("", tag)).toBe(false);
		expect(etagMatches(stateEtag({ ...S, version: 40 }), tag)).toBe(false);
	});
});

describe("stateResponse", () => {
	it("returns the body with a validator and a revalidate-always policy", async () => {
		const res = await app(() => S)();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(S);
		expect(res.headers.get("etag")).toBe(stateEtag(S));
		// Never served from cache without asking, and never by a shared cache.
		expect(res.headers.get("cache-control")).toBe("private, no-cache");
	});

	it("answers 304 with no body when nothing changed", async () => {
		const res = await app(() => S)({ "if-none-match": stateEtag(S) });
		expect(res.status).toBe(304);
		expect(await res.text()).toBe("");
		expect(res.headers.get("etag")).toBe(stateEtag(S));
	});

	it("returns the new state once the version moves", async () => {
		let current = S;
		const request = app(() => current);
		const etag = (await request()).headers.get("etag")!;
		current = { ...S, version: S.version + 1, inboxUnread: 4 };
		const res = await request({ "if-none-match": etag });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(current);
	});
});
