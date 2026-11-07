// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Delegation of a single mailbox, by whoever owns it.
 *
 * `PUT /api/v1/access` is admin-only for a structural reason: a grant record is
 * keyed by *grantee* and lists every mailbox they can reach, so writing one
 * wholesale is authority over the whole deployment. That made the most ordinary
 * delegation there is impossible — the person whose mailbox it is could not give
 * their own assistant access without an administrator doing it for them.
 *
 * These routes exist to close that, which means the interesting tests are not
 * "does it work" but "what stops it becoming a way around the admin gate":
 *
 *   - An owner may write only *their own mailbox's* entry. A delegate who holds
 *     other mailboxes from other owners must come back unchanged.
 *   - Nothing here may set `role: "admin"`, or the scoped route becomes a
 *     promotion route.
 *   - `manageDelegates` is held only by `owner`, so an agent or manager on a
 *     shared inbox cannot re-delegate it — Gmail's rule, and the reason a
 *     delegate cannot hand out what was handed to them.
 *   - Reading the list must not leak which *other* mailboxes a delegate holds.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { app } from "../workers/index";
import { FULL_ACCESS_ROLE } from "../workers/lib/capabilities";
import type { Env } from "../workers/types";

const ADMIN = "owner@tapetide.com";
const RAHUL = "rahul@tapetide.com";
const ASSISTANT = "assistant@tapetide.com";
const SUPPORT = "support@tapetide.com";
const SALES = "sales@tapetide.com";
const SERVICE = "e367826f93b8d71185e03fe518aff3b4.access";

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

/** A stored grant, in the shape `parseGrant` reads. */
function grant(
	id: string,
	mailboxes: (string | { id: string; role: string })[],
	extra: Record<string, unknown> = {},
) {
	return {
		id,
		kind: "user",
		role: "member",
		mailboxes,
		updatedAt: "2026-01-01T00:00:00.000Z",
		...extra,
	};
}

function buildApp(options: { identity?: string; grants?: Record<string, unknown> } = {}) {
	const bucket = fakeBucket({
		[`mailboxes/${SUPPORT}.json`]: { fromName: "Support" },
		[`mailboxes/${SALES}.json`]: { fromName: "Sales" },
		[`mailboxes/${RAHUL}.json`]: { fromName: "Rahul" },
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
			c.set("accessIdentity", { kind: "user", id: options.identity, subject: "uuid-1" });
		}
		return next();
	});
	outer.route("/", app);

	const deferred: Promise<unknown>[] = [];
	const executionCtx = {
		waitUntil: (p: Promise<unknown>) => void deferred.push(p),
		passThroughOnException: () => undefined,
	} as unknown as ExecutionContext;

	const request = async (path: string, init?: RequestInit) => {
		const res = await outer.fetch(
			new Request(`https://mailer.tapetide.com${path}`, {
				...init,
				headers: {
					"Content-Type": "application/json",
					"Sec-Fetch-Site": "same-origin",
					...(init?.headers as Record<string, string>),
				},
			}),
			bindings,
			executionCtx,
		);
		await Promise.all(deferred.splice(0));
		return res;
	};

	return { request, bucket };
}

/** Grants that make Rahul the owner of his own mailbox and an agent on support. */
function rahulOwnsHisOwn(extra: Record<string, unknown> = {}) {
	return {
		[`access/users/${RAHUL}.json`]: grant(RAHUL, [
			RAHUL,
			{ id: SUPPORT, role: "agent" },
		]),
		...extra,
	};
}

const delegatesPath = (mailbox: string) =>
	`/api/v1/mailboxes/${encodeURIComponent(mailbox)}/delegates`;

// -- Who may delegate ----------------------------------------------

describe("who may delegate", () => {
	it("lets the owner of a mailbox delegate it", async () => {
		// The whole point: no administrator needed for your own mailbox.
		const { request } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });

		const res = await request(delegatesPath(RAHUL), {
			method: "PUT",
			body: JSON.stringify({ id: ASSISTANT, role: "agent" }),
		});

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({ id: ASSISTANT, role: "agent" });
	});

	it("refuses an agent on a shared mailbox", async () => {
		// Gmail's rule: a delegate cannot re-delegate. Rahul is an agent on support,
		// so he may work in it and may not hand it out.
		const { request } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });

		const res = await request(delegatesPath(SUPPORT), {
			method: "PUT",
			body: JSON.stringify({ id: ASSISTANT, role: "viewer" }),
		});

		expect(res.status).toBe(403);
		await expect(res.json()).resolves.toMatchObject({ capability: "manageDelegates" });
	});

	it("refuses a manager, who runs a mailbox without owning it", async () => {
		const { request } = buildApp({
			identity: RAHUL,
			grants: {
				[`access/users/${RAHUL}.json`]: grant(RAHUL, [{ id: SUPPORT, role: "manager" }]),
			},
		});

		expect(
			(
				await request(delegatesPath(SUPPORT), {
					method: "PUT",
					body: JSON.stringify({ id: ASSISTANT, role: "viewer" }),
				})
			).status,
		).toBe(403);
	});

	it("refuses a mailbox the caller cannot reach at all", async () => {
		const { request } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });

		const res = await request(delegatesPath(SALES), {
			method: "PUT",
			body: JSON.stringify({ id: ASSISTANT, role: "agent" }),
		});
		// Reachability is decided before capability, so this is the access refusal.
		expect(res.status).toBe(403);
		await expect(res.json()).resolves.toMatchObject({
			error: "You do not have access to this mailbox",
		});
	});

	it("lets an administrator delegate any mailbox", async () => {
		const { request } = buildApp({ identity: ADMIN });

		expect(
			(
				await request(delegatesPath(SUPPORT), {
					method: "PUT",
					body: JSON.stringify({ id: ASSISTANT, role: "agent" }),
				})
			).status,
		).toBe(200);
	});
});

// -- What stops it being a way around the admin gate ---------------

describe("escalation limits", () => {
	it("leaves a delegate's other mailboxes untouched", async () => {
		// The structural risk: this owner has no authority over the mailboxes some
		// other owner granted, so those entries must survive verbatim.
		const { request, bucket } = buildApp({
			identity: RAHUL,
			grants: {
				...rahulOwnsHisOwn(),
				[`access/users/${ASSISTANT}.json`]: grant(ASSISTANT, [
					{ id: SALES, role: "manager" },
				]),
			},
		});

		await request(delegatesPath(RAHUL), {
			method: "PUT",
			body: JSON.stringify({ id: ASSISTANT, role: "viewer" }),
		});

		const stored = JSON.parse(bucket._store.get(`access/users/${ASSISTANT}.json`)!);
		expect(stored.mailboxes).toEqual([
			{ id: SALES, role: "manager" },
			{ id: RAHUL, role: "viewer" },
		]);
	});

	it("cannot promote anyone to administrator", async () => {
		// `role` in the body is the *mailbox* role, and the grant's own role is
		// pinned to `member`. Even asking for admin has nowhere to land.
		const { request, bucket } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });

		await request(delegatesPath(RAHUL), {
			method: "PUT",
			body: JSON.stringify({ id: ASSISTANT, role: "owner" }),
		});

		const stored = JSON.parse(bucket._store.get(`access/users/${ASSISTANT}.json`)!);
		expect(stored.role).toBe("member");
	});

	it("rejects a role this deployment does not enforce", async () => {
		const { request } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });

		expect(
			(
				await request(delegatesPath(RAHUL), {
					method: "PUT",
					body: JSON.stringify({ id: ASSISTANT, role: "admin" }),
				})
			).status,
		).toBe(400);
	});

	it("refuses to write an entry for an existing administrator", async () => {
		// Their reach comes from their role, so an entry would change nothing while
		// looking in the UI like a demotion.
		const { request } = buildApp({
			identity: RAHUL,
			grants: {
				...rahulOwnsHisOwn(),
				[`access/users/${ASSISTANT}.json`]: grant(ASSISTANT, [], { role: "admin" }),
			},
		});

		const res = await request(delegatesPath(RAHUL), {
			method: "PUT",
			body: JSON.stringify({ id: ASSISTANT, role: "viewer" }),
		});
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({
			error: `${ASSISTANT} is an administrator and already has full access.`,
		});
	});

	it("refuses granting to yourself", async () => {
		const { request } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });

		const res = await request(delegatesPath(RAHUL), {
			method: "PUT",
			body: JSON.stringify({ id: RAHUL, role: "viewer" }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects an identifier that is not valid for its kind", async () => {
		const { request } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });

		expect(
			(
				await request(delegatesPath(RAHUL), {
					method: "PUT",
					body: JSON.stringify({ id: "not-an-address", kind: "user", role: "agent" }),
				})
			).status,
		).toBe(400);
	});
});

// -- Reading the list ----------------------------------------------

describe("listing delegates", () => {
	it("returns only this mailbox's entry for each delegate", async () => {
		// An owner has no business knowing which *other* mailboxes their delegate
		// can reach.
		const { request } = buildApp({
			identity: RAHUL,
			grants: {
				...rahulOwnsHisOwn(),
				[`access/users/${ASSISTANT}.json`]: grant(ASSISTANT, [
					{ id: RAHUL, role: "viewer" },
					{ id: SALES, role: "manager" },
				]),
			},
		});

		const body = (await (await request(delegatesPath(RAHUL))).json()) as {
			delegates: { id: string; role: string }[];
		};

		const assistant = body.delegates.find((d) => d.id === ASSISTANT)!;
		expect(assistant.role).toBe("viewer");
		expect(JSON.stringify(body)).not.toContain(SALES);
	});

	it("includes the owner's own entry", async () => {
		const { request } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });

		const body = (await (await request(delegatesPath(RAHUL))).json()) as {
			delegates: { id: string; role: string }[];
		};
		expect(body.delegates.find((d) => d.id === RAHUL)?.role).toBe(FULL_ACCESS_ROLE);
	});

	it("names the administrators who reach it without an entry", async () => {
		// A short list would otherwise imply nobody else can get in.
		const { request } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });

		const body = (await (await request(delegatesPath(RAHUL))).json()) as {
			configuredAdmins: string[];
		};
		expect(body.configuredAdmins).toContain(ADMIN);
	});

	it("serves the role vocabulary the Worker enforces", async () => {
		const { request } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });

		const body = (await (await request(delegatesPath(RAHUL))).json()) as {
			roles: { role: string }[];
			fullAccessRole: string;
		};
		expect(body.roles.map((r) => r.role)).toEqual(["viewer", "agent", "manager", "owner"]);
		expect(body.fullAccessRole).toBe(FULL_ACCESS_ROLE);
	});

	it("refuses an agent reading the list", async () => {
		const { request } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });
		expect((await request(delegatesPath(SUPPORT))).status).toBe(403);
	});
});

// -- Revoking ------------------------------------------------------

describe("revoking a delegate", () => {
	it("drops only this mailbox's entry", async () => {
		const { request, bucket } = buildApp({
			identity: RAHUL,
			grants: {
				...rahulOwnsHisOwn(),
				[`access/users/${ASSISTANT}.json`]: grant(ASSISTANT, [
					{ id: RAHUL, role: "viewer" },
					{ id: SALES, role: "manager" },
				]),
			},
		});

		const res = await request(`${delegatesPath(RAHUL)}/user/${encodeURIComponent(ASSISTANT)}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(204);

		const stored = JSON.parse(bucket._store.get(`access/users/${ASSISTANT}.json`)!);
		expect(stored.mailboxes).toEqual([{ id: SALES, role: "manager" }]);
	});

	it("deletes a grant left with no mailboxes", async () => {
		// Otherwise the access screen accumulates rows that grant nothing.
		const { request, bucket } = buildApp({
			identity: RAHUL,
			grants: {
				...rahulOwnsHisOwn(),
				[`access/users/${ASSISTANT}.json`]: grant(ASSISTANT, [{ id: RAHUL, role: "viewer" }]),
			},
		});

		await request(`${delegatesPath(RAHUL)}/user/${encodeURIComponent(ASSISTANT)}`, {
			method: "DELETE",
		});

		expect(bucket._store.has(`access/users/${ASSISTANT}.json`)).toBe(false);
	});

	it("404s a delegate who has no entry here", async () => {
		const { request } = buildApp({
			identity: RAHUL,
			grants: {
				...rahulOwnsHisOwn(),
				[`access/users/${ASSISTANT}.json`]: grant(ASSISTANT, [{ id: SALES, role: "viewer" }]),
			},
		});

		expect(
			(
				await request(`${delegatesPath(RAHUL)}/user/${encodeURIComponent(ASSISTANT)}`, {
					method: "DELETE",
				})
			).status,
		).toBe(404);
	});

	it("refuses to revoke an administrator here", async () => {
		const { request } = buildApp({
			identity: RAHUL,
			grants: {
				...rahulOwnsHisOwn(),
				[`access/users/${ASSISTANT}.json`]: grant(ASSISTANT, [], { role: "admin" }),
			},
		});

		const res = await request(`${delegatesPath(RAHUL)}/user/${encodeURIComponent(ASSISTANT)}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(400);
	});

	it("rejects an unknown principal kind", async () => {
		const { request } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });

		expect(
			(await request(`${delegatesPath(RAHUL)}/robot/${ASSISTANT}`, { method: "DELETE" })).status,
		).toBe(400);
	});
});

// -- Machines ------------------------------------------------------

describe("service tokens", () => {
	it("can be granted a mailbox by its owner", async () => {
		// A machine is granted exactly like a person, so an owner can wire up their
		// own automation without an administrator.
		const { request, bucket } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });

		const res = await request(delegatesPath(RAHUL), {
			method: "PUT",
			body: JSON.stringify({
				id: SERVICE,
				kind: "service",
				role: "agent",
				label: "CI bot",
			}),
		});
		expect(res.status).toBe(200);

		const stored = JSON.parse(bucket._store.get(`access/services/${SERVICE}.json`)!);
		expect(stored.mailboxes).toEqual([{ id: RAHUL, role: "agent" }]);
		expect(stored.label).toBe("CI bot");
	});

	it("is not confused with a person of the same id", async () => {
		const { request, bucket } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });

		await request(delegatesPath(RAHUL), {
			method: "PUT",
			body: JSON.stringify({ id: SERVICE, kind: "service", role: "viewer" }),
		});

		expect(bucket._store.has(`access/services/${SERVICE}.json`)).toBe(true);
		expect(bucket._store.has(`access/users/${SERVICE}.json`)).toBe(false);
	});
});

// -- Audit ---------------------------------------------------------

describe("audit", () => {
	it("records a scoped grant against the mailbox", async () => {
		// The deployment log covers instance-wide grants; this one belongs to the
		// mailbox whose owner made it.
		const { request, bucket } = buildApp({ identity: RAHUL, grants: rahulOwnsHisOwn() });

		await request(delegatesPath(RAHUL), {
			method: "PUT",
			body: JSON.stringify({ id: ASSISTANT, role: "agent" }),
		});

		const entry = [...bucket._store.entries()]
			.filter(([key]) => key.startsWith(`audit/${RAHUL}/`))
			.map(([, value]) => JSON.parse(value))
			.find((e) => e.action === "access.grant");

		expect(entry).toBeDefined();
		expect(entry.actor).toBe(RAHUL);
		expect(entry.actorRole).toBe("owner");
		expect(entry.target).toBe(ASSISTANT);
		expect(entry.detail.scope).toBe("mailbox");
	});

	it("records a revocation", async () => {
		const { request, bucket } = buildApp({
			identity: RAHUL,
			grants: {
				...rahulOwnsHisOwn(),
				[`access/users/${ASSISTANT}.json`]: grant(ASSISTANT, [{ id: RAHUL, role: "viewer" }]),
			},
		});

		await request(`${delegatesPath(RAHUL)}/user/${encodeURIComponent(ASSISTANT)}`, {
			method: "DELETE",
		});

		const entry = [...bucket._store.entries()]
			.filter(([key]) => key.startsWith(`audit/${RAHUL}/`))
			.map(([, value]) => JSON.parse(value))
			.find((e) => e.action === "access.revoke");

		expect(entry).toBeDefined();
		expect(entry.target).toBe(ASSISTANT);
	});
});
