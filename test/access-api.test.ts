// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The access API's wire contract.
 *
 * `test/capabilities.test.ts` covers the model and the route gates. This covers
 * the payloads the access screen actually exchanges with the Worker, which is a
 * separate risk: the screen sends a mailbox list whose entries are *either* bare
 * strings or objects naming a role, and reads back a grant it has to render
 * without knowing the preset table. A mismatch there is invisible to a unit test
 * of either side alone.
 *
 * There is no component test here because the project has no DOM environment
 * configured — `vitest.config.ts` runs in plain Node deliberately, and adding a
 * renderer for one screen is not worth it. What is worth pinning is that every
 * shape the screen can send is accepted, and everything it needs to render is
 * returned.
 *
 * `GET /api/v1/access` also serves the role vocabulary. That is what lets the
 * screen offer exactly the presets this deployment enforces instead of a copy
 * that drifts, so the tests assert the vocabulary is present and self-consistent.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { app } from "../workers/index";
import {
	FULL_ACCESS_ROLE,
	MAILBOX_CAPABILITIES,
	MAILBOX_ROLES,
	ROLE_CAPABILITIES,
	type MailboxRole,
} from "../workers/lib/capabilities";
import type { Env } from "../workers/types";

const ADMIN = "owner@tapetide.com";
const MEMBER = "member@tapetide.com";
const SUPPORT = "support@tapetide.com";
const SALES = "sales@tapetide.com";

/** R2 double holding mailboxes and grants. */
function fakeBucket(initial: Record<string, unknown> = {}) {
	const store = new Map<string, string>(
		Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]),
	);

	return {
		async head(key: string) {
			return store.has(key) ? { key } : null;
		},
		async get(key: string) {
			const raw = store.get(key);
			return raw === undefined ? null : { json: async () => JSON.parse(raw) };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string | string[]) {
			for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
		},
		async list({ prefix = "" }: { prefix?: string } = {}) {
			return {
				objects: [...store.keys()]
					.filter((key) => key.startsWith(prefix))
					.map((key) => ({ key })),
				truncated: false as const,
			};
		},
		_store: store,
	};
}

/**
 * The real API app behind a stand-in for the Access middleware.
 *
 * `workers/index.ts` mounts `resolvePrincipal` itself, so this only has to supply
 * the verified identity that `workers/app.ts` would have set.
 */
function buildApp(options: { identity?: string; grants?: Record<string, unknown> } = {}) {
	const bucket = fakeBucket({
		[`mailboxes/${SUPPORT}.json`]: { fromName: "Support" },
		[`mailboxes/${SALES}.json`]: { fromName: "Sales" },
		...(options.grants ?? {}),
	});

	const bindings = {
		ADMIN_EMAILS: ADMIN,
		DOMAINS: "tapetide.com",
		BUCKET: bucket,
		MAILBOX: { idFromName: (name: string) => ({ name }), get: () => ({}) },
	} as unknown as Env;

	const outer = new Hono();
	outer.use("*", async (c, next) => {
		if (options.identity) {
			c.set("accessIdentity", {
				kind: "user",
				id: options.identity,
				subject: "uuid-1",
			});
		}
		return next();
	});
	outer.route("/", app);

	/**
	 * `executionCtx` is supplied because the handlers defer audit writes with
	 * `waitUntil`, exactly as the Worker runtime provides one. Awaiting the
	 * deferred work rather than dropping it means a test can assert on the log
	 * entry the request produced.
	 */
	const deferred: Promise<unknown>[] = [];
	const executionCtx = {
		waitUntil: (promise: Promise<unknown>) => {
			deferred.push(promise);
		},
		passThroughOnException: () => undefined,
	} as unknown as ExecutionContext;

	const request = async (path: string, init?: RequestInit) => {
		const res = await outer.fetch(
			new Request(`https://mailer.tapetide.com${path}`, {
				...init,
				headers: {
					"Content-Type": "application/json",
					// The API app refuses cross-site writes; this is what a same-origin
					// browser request looks like.
					"Sec-Fetch-Site": "same-origin",
					...(init?.headers as Record<string, string>),
				},
			}),
			bindings,
			executionCtx,
		);
		// Settle the audit writes so assertions see a consistent bucket.
		await Promise.all(deferred.splice(0));
		return res;
	};

	return { request, bucket };
}

/** What the screen sends: `PUT /api/v1/access` with a mixed mailbox list. */
function saveGrant(
	request: (path: string, init?: RequestInit) => Promise<Response>,
	body: unknown,
) {
	return request("/api/v1/access", { method: "PUT", body: JSON.stringify(body) });
}

describe("GET /api/v1/access", () => {
	it("serves the role vocabulary the screen renders from", async () => {
		// Served rather than bundled, so the screen offers exactly the presets this
		// Worker enforces.
		const { request } = buildApp({ identity: ADMIN });
		const res = await request("/api/v1/access");
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			roles: { role: MailboxRole; capabilities: string[] }[];
			capabilities: string[];
			fullAccessRole: MailboxRole;
		};

		expect(body.roles.map((r) => r.role)).toEqual([...MAILBOX_ROLES]);
		expect(body.capabilities).toEqual([...MAILBOX_CAPABILITIES]);
		expect(body.fullAccessRole).toBe(FULL_ACCESS_ROLE);
	});

	it("expands each preset, so the screen never needs the table itself", async () => {
		const { request } = buildApp({ identity: ADMIN });
		const body = (await (await request("/api/v1/access")).json()) as {
			roles: { role: MailboxRole; capabilities: string[] }[];
		};

		for (const entry of body.roles) {
			expect(entry.capabilities).toEqual([...ROLE_CAPABILITIES[entry.role]]);
		}
	});

	it("refuses a member, since the grant list is administrator-only", async () => {
		const { request } = buildApp({
			identity: MEMBER,
			grants: { [`access/users/${MEMBER}.json`]: { id: MEMBER, role: "member", mailboxes: [SUPPORT] } },
		});

		expect((await request("/api/v1/access")).status).toBe(403);
	});

	it("returns stored grants with their per-mailbox authority", async () => {
		const { request } = buildApp({
			identity: ADMIN,
			grants: {
				[`access/users/${MEMBER}.json`]: {
					id: MEMBER,
					role: "member",
					mailboxes: [{ id: SUPPORT, role: "agent" }, SALES],
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});

		const body = (await (await request("/api/v1/access")).json()) as {
			users: { id: string; mailboxes: string[]; access: { id: string; role: string }[] }[];
		};

		const grant = body.users.find((u) => u.id === MEMBER)!;
		// Both fields are present: the flat list for "which", `access` for "how far".
		expect(grant.mailboxes).toEqual([SUPPORT, SALES]);
		expect(grant.access).toEqual([
			{ id: SUPPORT, role: "agent" },
			{ id: SALES, role: FULL_ACCESS_ROLE },
		]);
	});
});

describe("PUT /api/v1/access", () => {
	it("accepts a bare address, which is what the old screen sent", async () => {
		// The compatibility guarantee at the wire level.
		const { request, bucket } = buildApp({ identity: ADMIN });

		const res = await saveGrant(request, {
			id: MEMBER,
			kind: "user",
			role: "member",
			mailboxes: [SUPPORT],
		});
		expect(res.status).toBe(200);

		const stored = JSON.parse(bucket._store.get(`access/users/${MEMBER}.json`)!);
		expect(stored.mailboxes).toEqual([SUPPORT]);
	});

	it("accepts an entry naming a role", async () => {
		const { request, bucket } = buildApp({ identity: ADMIN });

		const res = await saveGrant(request, {
			id: MEMBER,
			kind: "user",
			role: "member",
			mailboxes: [{ id: SUPPORT, role: "agent" }],
		});
		expect(res.status).toBe(200);

		const stored = JSON.parse(bucket._store.get(`access/users/${MEMBER}.json`)!);
		expect(stored.mailboxes).toEqual([{ id: SUPPORT, role: "agent" }]);
	});

	it("accepts the mixed list the screen produces", async () => {
		// The headline case: full authority over your own mail, agent on the shared
		// inbox. The screen sends full-access entries bare and narrowed ones as
		// objects, in one array.
		const { request } = buildApp({ identity: ADMIN });

		const res = await saveGrant(request, {
			id: MEMBER,
			kind: "user",
			role: "member",
			mailboxes: [SALES, { id: SUPPORT, role: "agent" }],
		});
		expect(res.status).toBe(200);

		const grant = (await res.json()) as { access: { id: string; role: string }[] };
		expect(grant.access).toEqual([
			{ id: SALES, role: FULL_ACCESS_ROLE },
			{ id: SUPPORT, role: "agent" },
		]);
	});

	it("round-trips a narrowed grant back to the screen unchanged", async () => {
		// Save then reload is the loop the operator actually performs, and the thing
		// that would break silently is the role not surviving it.
		const { request } = buildApp({ identity: ADMIN });

		await saveGrant(request, {
			id: MEMBER,
			kind: "user",
			role: "member",
			mailboxes: [{ id: SUPPORT, role: "viewer" }],
		});

		const body = (await (await request("/api/v1/access")).json()) as {
			users: { id: string; access: { id: string; role: string }[] }[];
		};
		expect(body.users.find((u) => u.id === MEMBER)?.access).toEqual([
			{ id: SUPPORT, role: "viewer" },
		]);
	});

	it("keeps per-entry adjustments", async () => {
		const { request } = buildApp({ identity: ADMIN });

		const res = await saveGrant(request, {
			id: MEMBER,
			kind: "user",
			role: "member",
			mailboxes: [{ id: SUPPORT, role: "agent", extra: ["sendAs"] }],
		});

		const grant = (await res.json()) as {
			access: { id: string; role: string; extra?: string[] }[];
		};
		expect(grant.access[0].extra).toEqual(["sendAs"]);
	});

	it("rejects a role this deployment does not enforce", async () => {
		// Better a 400 the operator sees than a record that silently reads as
		// something else.
		const { request } = buildApp({ identity: ADMIN });

		const res = await saveGrant(request, {
			id: MEMBER,
			kind: "user",
			role: "member",
			mailboxes: [{ id: SUPPORT, role: "wizard" }],
		});
		expect(res.status).toBe(400);
	});

	it("rejects a capability this deployment does not know", async () => {
		const { request } = buildApp({ identity: ADMIN });

		const res = await saveGrant(request, {
			id: MEMBER,
			kind: "user",
			role: "member",
			mailboxes: [{ id: SUPPORT, role: "agent", extra: ["becomeRoot"] }],
		});
		expect(res.status).toBe(400);
	});

	it("rejects a mailbox that does not exist, in either shape", async () => {
		// A typo should fail now rather than as an inexplicably empty sidebar later.
		const { request } = buildApp({ identity: ADMIN });

		for (const entry of ["nope@tapetide.com", { id: "nope@tapetide.com", role: "agent" }]) {
			const res = await saveGrant(request, {
				id: MEMBER,
				kind: "user",
				role: "member",
				mailboxes: [entry],
			});
			expect(res.status, JSON.stringify(entry)).toBe(400);
			await expect(res.json()).resolves.toEqual({
				error: "No such mailbox: nope@tapetide.com",
			});
		}
	});

	it("rejects one mailbox listed twice", async () => {
		// Two entries for one mailbox would resolve to whichever came first, which is
		// a silent surprise rather than the error the operator wants.
		const { request } = buildApp({ identity: ADMIN });

		const res = await saveGrant(request, {
			id: MEMBER,
			kind: "user",
			role: "member",
			mailboxes: [SUPPORT, { id: SUPPORT, role: "viewer" }],
		});
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toEqual({
			error: `Mailbox listed more than once: ${SUPPORT}`,
		});
	});

	it("refuses a member trying to grant themselves more", async () => {
		const { request } = buildApp({
			identity: MEMBER,
			grants: {
				[`access/users/${MEMBER}.json`]: { id: MEMBER, role: "member", mailboxes: [SUPPORT] },
			},
		});

		const res = await saveGrant(request, {
			id: MEMBER,
			kind: "user",
			role: "admin",
			mailboxes: [],
		});
		expect(res.status).toBe(403);
	});
});

describe("GET /api/v1/me", () => {
	it("reports what the caller may do in each mailbox", async () => {
		// The screen and the workspace both key affordances off this, so it has to
		// arrive expanded rather than as role names.
		const { request } = buildApp({
			identity: MEMBER,
			grants: {
				[`access/users/${MEMBER}.json`]: {
					id: MEMBER,
					role: "member",
					mailboxes: [{ id: SUPPORT, role: "agent" }],
				},
			},
		});

		const body = (await (await request("/api/v1/me")).json()) as {
			capabilities: { mailboxId: string; role: string; capabilities: string[] }[] | null;
		};

		expect(body.capabilities).toEqual([
			{
				mailboxId: SUPPORT,
				role: "agent",
				capabilities: [...ROLE_CAPABILITIES.agent],
			},
		]);
	});

	it("reports null for an administrator, meaning everything everywhere", async () => {
		// `null` and `[]` must stay distinct: the first is every capability, the
		// second is none.
		const { request } = buildApp({ identity: ADMIN });
		const body = (await (await request("/api/v1/me")).json()) as { capabilities: unknown };
		expect(body.capabilities).toBeNull();
	});

	it("reports an empty list for an authenticated stranger", async () => {
		const { request } = buildApp({ identity: "stranger@elsewhere.com" });
		const body = (await (await request("/api/v1/me")).json()) as { capabilities: unknown };
		expect(body.capabilities).toEqual([]);
	});
});
