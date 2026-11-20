// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The public tracking endpoint's security behaviour, with a fake mailbox
 * namespace so no Durable Object is needed. What matters here is what a
 * recipient (and a prober) gets back and what gets recorded — the crypto itself
 * is covered in `tracking-token.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import {
	handleClickRedirect,
	handleOpenPixel,
} from "../workers/lib/tracking-endpoint";
import { signTrackingToken } from "../shared/tracking-token";

const SECRET = "c".repeat(64);

/**
 * A fake env whose stub records engagement into an array.
 *
 * `BUCKET.head` stands in for the mailbox registry the endpoint checks BEFORE it
 * instantiates a Durable Object; `created` records every `idFromName` call so a
 * test can assert that an unregistered mailbox never allocates one.
 */
function fakeEnv(
	recorded: unknown[],
	options: {
		messageExists?: boolean;
		registered?: boolean;
		secret?: string | null;
		created?: string[];
		throwOn?: "head" | "secret";
	} = {},
) {
	const {
		messageExists = true,
		registered = true,
		secret = SECRET,
		created = [],
		throwOn,
	} = options;

	const stub = {
		async getTrackingSecret() {
			if (throwOn === "secret") throw new Error("DO unreachable");
			return secret;
		},
		async recordEngagement(event: unknown) {
			recorded.push(event);
			return messageExists;
		},
	};
	return {
		BUCKET: {
			async head(key: string) {
				if (throwOn === "head") throw new Error("R2 down");
				return registered ? { key } : null;
			},
		},
		MAILBOX: {
			idFromName: (name: string) => {
				created.push(name);
				return { name };
			},
			get: () => stub,
		},
	} as unknown as Parameters<typeof handleOpenPixel>[1];
}

/** Run any waitUntil promises the handler scheduled. */
function collectWaitUntil() {
	const pending: Promise<unknown>[] = [];
	return {
		waitUntil: (p: Promise<unknown>) => pending.push(p),
		flush: () => Promise.all(pending),
	};
}

describe("open pixel", () => {
	it("returns a GIF and records an open for a valid token", async () => {
		const recorded: unknown[] = [];
		const env = fakeEnv(recorded);
		const token = await signTrackingToken(
			{
				mailboxId: "support@tapetide.com",
				emailId: "local-1",
				recipient: "user@example.org",
				kind: "opened",
			},
			SECRET,
		);
		const wu = collectWaitUntil();

		const res = await handleOpenPixel(token, env, wu.waitUntil);
		await wu.flush();

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/gif");
		expect(recorded).toHaveLength(1);
		expect((recorded[0] as { type: string }).type).toBe("opened");
	});

	it("STILL returns a GIF for a bad token, and records nothing", async () => {
		// A prober must not be able to tell a real token from a fake one, and a
		// legitimate reader must never see a broken image.
		const recorded: unknown[] = [];
		const env = fakeEnv(recorded);
		const wu = collectWaitUntil();

		const res = await handleOpenPixel("garbage.token", env, wu.waitUntil);
		await wu.flush();

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/gif");
		expect(recorded).toHaveLength(0);
	});

	it("does not cache the pixel, so a second open re-fetches", async () => {
		const env = fakeEnv([]);
		const res = await handleOpenPixel("x", env, () => {});
		expect(res.headers.get("Cache-Control")).toContain("no-store");
	});

	it("never allocates a Durable Object for an unregistered mailbox", async () => {
		// The mailbox id is readable WITHOUT the signature, so it is attacker
		// controlled. Instantiating a DO from it would run migrations and persist
		// storage for any name, unauthenticated and unrated — so the registry is
		// checked first and no DO may be created when the mailbox is not real.
		const created: string[] = [];
		const recorded: unknown[] = [];
		const env = fakeEnv(recorded, { registered: false, created });
		const token = await signTrackingToken(
			{
				mailboxId: "attacker-chosen@nowhere.example",
				emailId: "x",
				recipient: null,
				kind: "opened",
			},
			SECRET,
		);

		const res = await handleOpenPixel(token, env, () => {});

		expect(res.status).toBe(200); // still a GIF, no information leaked
		expect(created).toEqual([]); // and nothing was allocated
		expect(recorded).toHaveLength(0);
	});

	it("rejects a token for a mailbox that has no secret yet", async () => {
		// No secret means the mailbox never sent tracked mail, so no valid token for
		// it can exist — and the endpoint must not mint one to find that out.
		const recorded: unknown[] = [];
		const env = fakeEnv(recorded, { secret: null });
		const token = await signTrackingToken(
			{
				mailboxId: "support@tapetide.com",
				emailId: "x",
				recipient: null,
				kind: "opened",
			},
			SECRET,
		);
		const res = await handleOpenPixel(token, env, () => {});
		expect(res.status).toBe(200);
		expect(recorded).toHaveLength(0);
	});

	it("still returns the pixel when verification throws", async () => {
		// A transient R2/DO failure must not become a 500 — that would show a broken
		// image in a legitimate reader's mail and break the uniform-response
		// property a prober would otherwise exploit.
		const recorded: unknown[] = [];
		vi.spyOn(console, "error").mockImplementation(() => {});
		const env = fakeEnv(recorded, { throwOn: "head" });
		const res = await handleOpenPixel("anything", env, () => {});
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/gif");
	});
});

describe("click redirect", () => {
	it("302s to the signed URL and records a click", async () => {
		const recorded: unknown[] = [];
		const env = fakeEnv(recorded);
		const token = await signTrackingToken(
			{
				mailboxId: "support@tapetide.com",
				emailId: "local-2",
				recipient: "user@example.org",
				kind: "clicked",
				url: "https://tapetide.com/pricing",
			},
			SECRET,
		);
		const wu = collectWaitUntil();

		const res = await handleClickRedirect(token, env, wu.waitUntil);
		await wu.flush();

		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("https://tapetide.com/pricing");
		expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect((recorded[0] as { type: string }).type).toBe("clicked");
	});

	it("REFUSES a bad token instead of redirecting — no open redirect", async () => {
		const recorded: unknown[] = [];
		const env = fakeEnv(recorded);
		const res = await handleClickRedirect("garbage", env, () => {});
		expect(res.status).toBe(400);
		expect(res.headers.get("Location")).toBeNull();
		expect(recorded).toHaveLength(0);
	});

	it("refuses a non-http destination even if it were somehow signed", async () => {
		const env = fakeEnv([]);
		const token = await signTrackingToken(
			{
				mailboxId: "support@tapetide.com",
				emailId: "local-3",
				recipient: null,
				kind: "clicked",
				url: "javascript:alert(1)",
			},
			SECRET,
		);
		const res = await handleClickRedirect(token, env, () => {});
		expect(res.status).toBe(400);
	});

	it("refuses a click token that carries no URL", async () => {
		const env = fakeEnv([]);
		const token = await signTrackingToken(
			{
				mailboxId: "support@tapetide.com",
				emailId: "local-4",
				recipient: null,
				kind: "clicked",
			},
			SECRET,
		);
		const res = await handleClickRedirect(token, env, () => {});
		expect(res.status).toBe(400);
	});
});
