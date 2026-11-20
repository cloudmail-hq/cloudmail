// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The per-isolate mailbox-existence memo behind `requireMailbox`.
 *
 * The properties that matter are the ones that keep it from weakening
 * authorization: a deleted mailbox stops resolving within seconds, writes
 * always ask R2, and only positive answers are remembered.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	MAILBOX_EXISTS_FRESH_MS,
	MAILBOX_EXISTS_MAX_AGE_MS,
	clearMailboxExistsCache,
	forgetMailboxExists,
	mailboxExists,
} from "../workers/lib/mailbox-exists";
import { requireMailbox, resolvePrincipal, type MailboxContext } from "../workers/lib/mailbox";
import type { Env } from "../workers/types";

const MB = "support@example.com";

/** An R2 stand-in whose contents a test can change, counting HEADs. */
function bucket(initial: string[] = [MB]) {
	const present = new Set(initial);
	const head = vi.fn(async (id: string) => (present.has(id) ? { key: id } : null));
	return { present, head };
}

let clock = 1_000_000;
const now = () => clock;

beforeEach(() => {
	clearMailboxExistsCache();
	clock = 1_000_000;
});

describe("mailboxExists", () => {
	it("serves a fresh positive read from memory", async () => {
		const b = bucket();
		const opts = { method: "GET", head: () => b.head(MB), now };
		expect(await mailboxExists(MB, opts)).toBe(true);
		clock += MAILBOX_EXISTS_FRESH_MS - 1;
		expect(await mailboxExists(MB, opts)).toBe(true);
		expect(b.head).toHaveBeenCalledTimes(1);
	});

	it("never caches a negative answer, so a new mailbox works at once", async () => {
		const b = bucket([]);
		const opts = { method: "GET", head: () => b.head(MB), now };
		expect(await mailboxExists(MB, opts)).toBe(false);
		b.present.add(MB);
		expect(await mailboxExists(MB, opts)).toBe(true);
		expect(b.head).toHaveBeenCalledTimes(2);
	});

	it("always asks R2 for a write", async () => {
		const b = bucket();
		await mailboxExists(MB, { method: "GET", head: () => b.head(MB), now });
		b.present.delete(MB);
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			expect(await mailboxExists(MB, { method, head: () => b.head(MB), now })).toBe(false);
		}
		expect(b.head).toHaveBeenCalledTimes(5);
	});

	it("revalidates a stale entry in the background and then refuses a deleted mailbox", async () => {
		const b = bucket();
		const pending: Promise<unknown>[] = [];
		const opts = { method: "GET", head: () => b.head(MB), now, waitUntil: (p: Promise<unknown>) => pending.push(p) };
		await mailboxExists(MB, opts);

		b.present.delete(MB);
		clock += MAILBOX_EXISTS_FRESH_MS;
		// Still answered from memory, but a check is now in flight.
		expect(await mailboxExists(MB, opts)).toBe(true);
		expect(pending).toHaveLength(1);
		await Promise.all(pending);

		// The check saw the deletion: the very next read is refused.
		expect(await mailboxExists(MB, opts)).toBe(false);
	});

	it("shares one background check between concurrent reads", async () => {
		const b = bucket();
		const pending: Promise<unknown>[] = [];
		const opts = { method: "GET", head: () => b.head(MB), now, waitUntil: (p: Promise<unknown>) => pending.push(p) };
		await mailboxExists(MB, opts);
		clock += MAILBOX_EXISTS_FRESH_MS;
		await Promise.all([mailboxExists(MB, opts), mailboxExists(MB, opts), mailboxExists(MB, opts)]);
		expect(pending).toHaveLength(1);
		await Promise.all(pending);
		expect(b.head).toHaveBeenCalledTimes(2);
	});

	it("never trusts an entry past the hard ceiling, even if no background check landed", async () => {
		const b = bucket();
		// No waitUntil and no stale read in between: nothing refreshed the entry.
		await mailboxExists(MB, { method: "GET", head: () => b.head(MB), now });
		b.present.delete(MB);
		clock += MAILBOX_EXISTS_MAX_AGE_MS;
		expect(await mailboxExists(MB, { method: "GET", head: () => b.head(MB), now })).toBe(false);
	});

	it("forgets a mailbox on delete", async () => {
		const b = bucket();
		const opts = { method: "GET", head: () => b.head(MB), now };
		await mailboxExists(MB, opts);
		b.present.delete(MB);
		forgetMailboxExists(MB);
		expect(await mailboxExists(MB, opts)).toBe(false);
	});

	it("does not let a refresh in flight during a delete resurrect the mailbox", async () => {
		const b = bucket();
		await mailboxExists(MB, { method: "GET", head: () => b.head(MB), now });
		clock += MAILBOX_EXISTS_FRESH_MS;

		// A background HEAD that answers "exists" only after the delete happened.
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const pending: Promise<unknown>[] = [];
		const slowHead = async () => {
			await gate;
			return { key: MB };
		};
		expect(await mailboxExists(MB, { method: "GET", head: slowHead, now, waitUntil: (p) => pending.push(p) })).toBe(true);

		b.present.delete(MB);
		forgetMailboxExists(MB);
		release();
		await Promise.all(pending);

		// The late positive answer was discarded: the next read asks R2.
		expect(await mailboxExists(MB, { method: "GET", head: () => b.head(MB), now })).toBe(false);
	});

	it("keeps a failed background check from throwing into the request", async () => {
		const pending: Promise<unknown>[] = [];
		let fail = false;
		const head = async () => {
			if (fail) throw new Error("R2 unavailable");
			return { key: MB };
		};
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await mailboxExists(MB, { method: "GET", head, now });
		fail = true;
		clock += MAILBOX_EXISTS_FRESH_MS;
		expect(await mailboxExists(MB, { method: "GET", head, now, waitUntil: (p) => pending.push(p) })).toBe(true);
		await expect(Promise.all(pending)).resolves.toBeDefined();
		errors.mockRestore();
	});
});

describe("requireMailbox with the memo", () => {
	function app(present: Set<string>) {
		const head = vi.fn(async (key: string) => {
			const id = key.replace(/^mailboxes\//, "").replace(/\.json$/, "");
			return present.has(id) ? { key } : null;
		});
		const env = {
			AUTH_MODE: "access",
			BUCKET: { head, get: async () => null },
			MAILBOX: { idFromName: (n: string) => ({ n }), get: () => ({}) },
		} as unknown as Env;
		const a = new Hono<MailboxContext>();
		a.use("*", async (c, next) => {
			c.set("developmentBypass", true);
			return next();
		});
		a.use("/api/*", resolvePrincipal);
		a.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);
		a.get("/api/v1/mailboxes/:mailboxId/state", (c) => c.json({ ok: true }));
		a.post("/api/v1/mailboxes/:mailboxId/emails", (c) => c.json({ ok: true }));
		const req = (method: string) =>
			a.fetch(new Request(`https://x.test/api/v1/mailboxes/${MB}/${method === "GET" ? "state" : "emails"}`, { method }), env);
		return { req, head };
	}

	it("skips the R2 HEAD on a repeated read but not on a write", async () => {
		const present = new Set([MB]);
		const { req, head } = app(present);
		expect((await req("GET")).status).toBe(200);
		expect((await req("GET")).status).toBe(200);
		expect(head).toHaveBeenCalledTimes(1);

		present.delete(MB);
		// A write after deletion is refused immediately, despite the warm memo.
		expect((await req("POST")).status).toBe(404);
		// And the write's answer cleared the memo for reads too.
		expect((await req("GET")).status).toBe(404);
	});
});
