// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox capabilities: what a principal may *do* once they are in.
 *
 * `test/authz.test.ts` covers which mailboxes a caller can reach. This covers
 * how far their authority goes inside one, which is a separate question with its
 * own failure modes:
 *
 *   - **Compatibility.** Grants written before capabilities existed list bare
 *     addresses and mean unrestricted access. Reading one as anything narrower
 *     would silently revoke authority people already rely on, so the tests pin
 *     that a plain string still means everything.
 *   - **Precedence.** A grant may add and remove capabilities on top of a preset.
 *     Revocation applies last, so a self-contradictory entry resolves the
 *     restrictive way rather than the permissive one.
 *   - **Attribution.** Send As and Send on Behalf differ in what the recipient
 *     sees, not in power. Exchange resolves "holds both" as Send As, and a
 *     principal holding neither must be refused rather than quietly sent as the
 *     mailbox — that fallback would be the identity-spoofing hole the split
 *     exists to close.
 *   - **Wiring.** The route gates are path- and method-scoped middleware, so the
 *     thing that breaks is not the capability maths but a pattern that fails to
 *     match. Only a request through the real middleware can show that.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
	canAccessMailbox,
	canDo,
	decidePrincipal,
	mailboxCapabilities,
	parseGrant,
	putGrant,
	resolvePrincipalFor,
	sendAttributionFor,
	type AccessGrant,
	type AccessIdentity,
	type Principal,
} from "../workers/lib/authz";
import {
	FULL_ACCESS_ROLE,
	MAILBOX_CAPABILITIES,
	MAILBOX_ROLES,
	ROLE_CAPABILITIES,
	accessCapabilities,
	attributionFor,
	isMailboxCapability,
	isMailboxRole,
	parseMailboxAccess,
	serializeMailboxAccess,
	type MailboxCapability,
} from "../workers/lib/capabilities";
import {
	requireAnyCapability,
	requireCapability,
	requireMailbox,
	resolvePrincipal,
	type MailboxContext,
} from "../workers/lib/mailbox";
import { buildOutgoingHeaders } from "../workers/lib/email-helpers";
import type { Env } from "../workers/types";

const ADMIN = "owner@tapetide.com";
const MEMBER = "member@tapetide.com";
const SUPPORT = "support@tapetide.com";
const SALES = "sales@tapetide.com";

function user(id = MEMBER): AccessIdentity {
	return { kind: "user", id, subject: "uuid-1" };
}

/** Lowercase identity helper for readability in the send-attribution tests. */
function principal(overrides: Partial<Principal> = {}): Principal {
	return {
		identity: user(),
		role: "member",
		mailboxes: [SUPPORT],
		access: [{ id: SUPPORT, role: "agent" }],
		enforced: true,
		developmentBypass: false,
		...overrides,
	};
}

// -- The vocabulary -------------------------------------------------

describe("capability vocabulary", () => {
	it("gives the owner preset every capability", () => {
		// `owner` is the compatibility default, so anything missing from it would
		// be authority silently lost by an existing grant.
		expect([...ROLE_CAPABILITIES.owner].sort()).toEqual(
			[...MAILBOX_CAPABILITIES].sort(),
		);
	});

	it("withholds mailbox settings from every preset below owner", () => {
		// `manageSettings` can rewrite `forwarding.email` and redirect all incoming
		// mail, which is not something a shared-inbox worker should hold. Gmail
		// withholds account settings from delegates for the same reason.
		for (const role of MAILBOX_ROLES) {
			if (role === "owner") continue;
			expect(ROLE_CAPABILITIES[role]).not.toContain("manageSettings");
		}
	});

	it("gives an agent attribution rather than anonymity", () => {
		// A shared support mailbox wants replies traceable to whoever wrote them.
		expect(ROLE_CAPABILITIES.agent).toContain("sendOnBehalf");
		expect(ROLE_CAPABILITIES.agent).not.toContain("sendAs");
	});

	it("never grants irrecoverable deletion without the recoverable kind", () => {
		// Otherwise a preset could purge the bin but not restore from it.
		for (const role of MAILBOX_ROLES) {
			if (ROLE_CAPABILITIES[role].includes("deletePermanently")) {
				expect(ROLE_CAPABILITIES[role]).toContain("delete");
			}
		}
	});

	it("lets every preset read, since reaching a mailbox implies opening it", () => {
		for (const role of MAILBOX_ROLES) {
			expect(ROLE_CAPABILITIES[role]).toContain("read");
		}
	});

	it("recognises exactly its own capabilities and roles", () => {
		expect(isMailboxCapability("sendAs")).toBe(true);
		expect(isMailboxCapability("becomeRoot")).toBe(false);
		expect(isMailboxRole("manager")).toBe(true);
		expect(isMailboxRole("superuser")).toBe(false);
	});
});

// -- Expansion ------------------------------------------------------

describe("accessCapabilities", () => {
	it("expands a preset", () => {
		expect([...accessCapabilities({ id: SUPPORT, role: "viewer" })]).toEqual(["read"]);
	});

	it("adds extras on top of the preset", () => {
		const capabilities = accessCapabilities({
			id: SUPPORT,
			role: "viewer",
			extra: ["sendOnBehalf"],
		});
		expect(capabilities.has("read")).toBe(true);
		expect(capabilities.has("sendOnBehalf")).toBe(true);
	});

	it("withholds a revoked capability from the preset", () => {
		const capabilities = accessCapabilities({
			id: SUPPORT,
			role: "manager",
			revoked: ["deletePermanently"],
		});
		expect(capabilities.has("deletePermanently")).toBe(false);
		// The rest of the preset survives.
		expect(capabilities.has("delete")).toBe(true);
	});

	it("resolves a self-contradictory entry restrictively", () => {
		// Naming the same capability in both lists is a mistake; the safe reading of
		// a mistake is the one that grants less.
		const capabilities = accessCapabilities({
			id: SUPPORT,
			role: "viewer",
			extra: ["deletePermanently"],
			revoked: ["deletePermanently"],
		});
		expect(capabilities.has("deletePermanently")).toBe(false);
	});
});

// -- Storage compatibility -----------------------------------------

describe("parseMailboxAccess", () => {
	const normalize = (raw: string) => raw.trim().toLowerCase();

	it("reads a bare address as unrestricted access", () => {
		// The compatibility guarantee. A pre-capabilities grant means everything.
		expect(parseMailboxAccess("Support@Tapetide.com", normalize)).toEqual({
			id: SUPPORT,
			role: FULL_ACCESS_ROLE,
		});
	});

	it("reads an object naming a role", () => {
		expect(parseMailboxAccess({ id: SUPPORT, role: "agent" }, normalize)).toEqual({
			id: SUPPORT,
			role: "agent",
		});
	});

	it("keeps per-entry adjustments", () => {
		expect(
			parseMailboxAccess(
				{ id: SUPPORT, role: "agent", extra: ["sendAs"], revoked: ["delete"] },
				normalize,
			),
		).toEqual({ id: SUPPORT, role: "agent", extra: ["sendAs"], revoked: ["delete"] });
	});

	it("drops capabilities this build does not know", () => {
		// An unknown string must never widen access.
		expect(
			parseMailboxAccess(
				{ id: SUPPORT, role: "viewer", extra: ["read", "becomeRoot"] },
				normalize,
			),
		).toEqual({ id: SUPPORT, role: "viewer", extra: ["read"] });
	});

	it("falls back to full access for an unrecognised role", () => {
		// A typo in a hand-edited record should not silently strip a colleague's
		// mailbox; the operator can see and correct the role in the UI.
		expect(parseMailboxAccess({ id: SUPPORT, role: "wizard" }, normalize)).toEqual({
			id: SUPPORT,
			role: FULL_ACCESS_ROLE,
		});
	});

	it("rejects an entry that names no mailbox", () => {
		expect(parseMailboxAccess("", normalize)).toBeNull();
		expect(parseMailboxAccess({ role: "agent" }, normalize)).toBeNull();
		expect(parseMailboxAccess(null, normalize)).toBeNull();
		expect(parseMailboxAccess(42, normalize)).toBeNull();
	});
});

describe("serializeMailboxAccess", () => {
	it("writes an unrestricted entry back as a plain address", () => {
		// So enabling this feature does not rewrite every existing grant into a
		// more verbose form that says the same thing.
		expect(serializeMailboxAccess({ id: SUPPORT, role: FULL_ACCESS_ROLE })).toBe(SUPPORT);
	});

	it("keeps the object form when the entry is narrowed", () => {
		expect(serializeMailboxAccess({ id: SUPPORT, role: "agent" })).toEqual({
			id: SUPPORT,
			role: "agent",
		});
	});

	it("keeps the object form when a full-access entry carries an adjustment", () => {
		expect(
			serializeMailboxAccess({
				id: SUPPORT,
				role: FULL_ACCESS_ROLE,
				revoked: ["deletePermanently"],
			}),
		).toEqual({ id: SUPPORT, role: FULL_ACCESS_ROLE, revoked: ["deletePermanently"] });
	});
});

describe("parseGrant", () => {
	it("widens a pre-capabilities record to full access", () => {
		const parsed = parseGrant(
			{ id: MEMBER, role: "member", mailboxes: [SUPPORT, SALES] },
			"user",
		);
		expect(parsed?.access).toEqual([
			{ id: SUPPORT, role: FULL_ACCESS_ROLE },
			{ id: SALES, role: FULL_ACCESS_ROLE },
		]);
	});

	it("reads a mixed record, since narrowing is per mailbox", () => {
		// The realistic shape: someone owns their own mailbox and is an agent on a
		// shared one. That is the case this whole feature exists for.
		const parsed = parseGrant(
			{
				id: MEMBER,
				role: "member",
				mailboxes: [MEMBER, { id: SUPPORT, role: "agent" }],
			},
			"user",
		);
		expect(parsed?.access).toEqual([
			{ id: MEMBER, role: FULL_ACCESS_ROLE },
			{ id: SUPPORT, role: "agent" },
		]);
	});

	it("derives the flat mailbox list from the access entries", () => {
		// The two must not be able to disagree about what is reachable.
		const parsed = parseGrant(
			{ id: MEMBER, role: "member", mailboxes: [{ id: SUPPORT, role: "viewer" }] },
			"user",
		);
		expect(parsed?.mailboxes).toEqual([SUPPORT]);
	});

	it("keeps the first entry when a mailbox is named twice", () => {
		// Unioning two roles for one mailbox would be a quiet escalation.
		const parsed = parseGrant(
			{
				id: MEMBER,
				role: "member",
				mailboxes: [{ id: SUPPORT, role: "viewer" }, { id: SUPPORT, role: "owner" }],
			},
			"user",
		);
		expect(parsed?.access).toEqual([{ id: SUPPORT, role: "viewer" }]);
		expect(parsed?.mailboxes).toEqual([SUPPORT]);
	});
});

describe("putGrant", () => {
	function bucket() {
		const store = new Map<string, string>();
		return {
			binding: {
				async put(key: string, value: string) {
					store.set(key, value);
				},
			} as unknown as R2Bucket,
			store,
		};
	}

	it("round-trips a narrowed grant through storage", async () => {
		const { binding, store } = bucket();
		await putGrant(binding, {
			id: MEMBER,
			kind: "user",
			role: "member",
			mailboxes: [],
			access: [{ id: SUPPORT, role: "agent" }],
		});

		const written = JSON.parse(store.get(`access/users/${MEMBER}.json`)!);
		expect(written.mailboxes).toEqual([{ id: SUPPORT, role: "agent" }]);
		// And reading it back yields the same authority.
		expect(parseGrant(written, "user")?.access).toEqual([{ id: SUPPORT, role: "agent" }]);
	});

	it("stores a plain address for an unrestricted entry", async () => {
		const { binding, store } = bucket();
		await putGrant(binding, {
			id: MEMBER,
			kind: "user",
			role: "member",
			mailboxes: [SUPPORT],
		});

		expect(JSON.parse(store.get(`access/users/${MEMBER}.json`)!).mailboxes).toEqual([
			SUPPORT,
		]);
	});

	it("accepts a bare mailbox list from callers that predate capabilities", async () => {
		const { binding, store } = bucket();
		await putGrant(binding, {
			id: MEMBER,
			kind: "user",
			role: "member",
			mailboxes: ["Support@Tapetide.com"],
		});

		expect(JSON.parse(store.get(`access/users/${MEMBER}.json`)!).mailboxes).toEqual([
			SUPPORT,
		]);
	});
});

// -- Resolution -----------------------------------------------------

describe("mailboxCapabilities", () => {
	it("gives an unrestricted principal everything", () => {
		const admin = decidePrincipal({ adminEmails: [ADMIN], identity: user(ADMIN) });
		expect(mailboxCapabilities(admin, SALES).size).toBe(MAILBOX_CAPABILITIES.length);
	});

	it("gives a narrowed grant exactly its preset", () => {
		expect([...mailboxCapabilities(principal(), SUPPORT)].sort()).toEqual(
			[...ROLE_CAPABILITIES.agent].sort(),
		);
	});

	it("gives nothing for a mailbox the principal cannot reach", () => {
		// A caller that forgot to check reachability still gets a refusal.
		expect(mailboxCapabilities(principal(), SALES).size).toBe(0);
	});

	it("ignores casing in the mailbox address", () => {
		expect(canDo(principal(), "Support@Tapetide.com", "read")).toBe(true);
	});
});

describe("canDo", () => {
	it("lets a viewer read but not send, delete or organise", () => {
		const viewer = principal({ access: [{ id: SUPPORT, role: "viewer" }] });
		expect(canDo(viewer, SUPPORT, "read")).toBe(true);
		for (const capability of ["sendOnBehalf", "delete", "organise", "manageSettings"] as const) {
			expect(canDo(viewer, SUPPORT, capability)).toBe(false);
		}
	});

	it("lets an agent bin a message but not destroy it", () => {
		const agent = principal();
		expect(canDo(agent, SUPPORT, "delete")).toBe(true);
		expect(canDo(agent, SUPPORT, "deletePermanently")).toBe(false);
	});

	it("withholds settings from a manager", () => {
		const manager = principal({ access: [{ id: SUPPORT, role: "manager" }] });
		expect(canDo(manager, SUPPORT, "manageRules")).toBe(true);
		expect(canDo(manager, SUPPORT, "manageSettings")).toBe(false);
	});

	it("honours a per-grant addition", () => {
		const agent = principal({
			access: [{ id: SUPPORT, role: "agent", extra: ["sendAs"] }],
		});
		expect(canDo(agent, SUPPORT, "sendAs")).toBe(true);
	});

	it("honours a per-grant revocation", () => {
		const manager = principal({
			access: [{ id: SUPPORT, role: "manager", revoked: ["deletePermanently"] }],
		});
		expect(canDo(manager, SUPPORT, "deletePermanently")).toBe(false);
	});

	it("keeps two mailboxes in one grant independent", () => {
		// The headline case: full authority over your own mail, agent on the shared
		// inbox. Neither may leak into the other.
		const both = principal({
			mailboxes: [MEMBER, SUPPORT],
			access: [
				{ id: MEMBER, role: FULL_ACCESS_ROLE },
				{ id: SUPPORT, role: "agent" },
			],
		});
		expect(canDo(both, MEMBER, "manageSettings")).toBe(true);
		expect(canDo(both, SUPPORT, "manageSettings")).toBe(false);
	});

	it("grants everything to a principal on an unenforced deployment", () => {
		// The compatibility guarantee, restated at the capability layer.
		const unenforced = decidePrincipal({ adminEmails: [], identity: user() });
		for (const capability of MAILBOX_CAPABILITIES) {
			expect(canDo(unenforced, SUPPORT, capability)).toBe(true);
		}
	});
});

describe("resolvePrincipalFor", () => {
	function bucket(objects: Record<string, unknown>) {
		const store = new Map(
			Object.entries(objects).map(([key, value]) => [key, JSON.stringify(value)]),
		);
		return {
			async get(key: string) {
				const raw = store.get(key);
				return raw === undefined ? null : { json: async () => JSON.parse(raw) };
			},
		} as unknown as R2Bucket;
	}

	it("resolves capabilities from a stored narrowed grant", async () => {
		const resolved = await resolvePrincipalFor({
			adminEmailsRaw: ADMIN,
			bucket: bucket({
				[`access/users/${MEMBER}.json`]: {
					id: MEMBER,
					role: "member",
					mailboxes: [{ id: SUPPORT, role: "viewer" }],
				},
			}),
			identity: user(),
		});

		expect(canAccessMailbox(resolved, SUPPORT)).toBe(true);
		expect(canDo(resolved, SUPPORT, "read")).toBe(true);
		expect(canDo(resolved, SUPPORT, "delete")).toBe(false);
	});

	it("resolves a pre-capabilities grant as full access", async () => {
		const resolved = await resolvePrincipalFor({
			adminEmailsRaw: ADMIN,
			bucket: bucket({
				[`access/users/${MEMBER}.json`]: {
					id: MEMBER,
					role: "member",
					mailboxes: [SUPPORT],
				},
			}),
			identity: user(),
		});

		for (const capability of MAILBOX_CAPABILITIES) {
			expect(canDo(resolved, SUPPORT, capability)).toBe(true);
		}
	});
});

// -- Send attribution ----------------------------------------------

describe("sendAttributionFor", () => {
	it("sends as the mailbox for an unrestricted principal", () => {
		// What full access has always meant; an owner is not acting on anyone's
		// behalf when sending from their own address.
		const admin = decidePrincipal({ adminEmails: [ADMIN], identity: user(ADMIN) });
		expect(sendAttributionFor(admin, SUPPORT)).toEqual({ mode: "as" });
	});

	it("attributes an agent's send to the agent", () => {
		expect(sendAttributionFor(principal(), SUPPORT)).toEqual({
			mode: "onBehalfOf",
			sender: MEMBER,
		});
	});

	it("prefers Send As when a principal holds both", () => {
		// Exchange: "If a user has both Send As and Send on Behalf permissions to a
		// mailbox or group, the Send As permission is always used."
		const manager = principal({ access: [{ id: SUPPORT, role: "manager" }] });
		expect(ROLE_CAPABILITIES.manager).toContain("sendOnBehalf");
		expect(sendAttributionFor(manager, SUPPORT)).toEqual({ mode: "as" });
	});

	it("refuses a viewer rather than sending unattributed", () => {
		// Falling back to `{mode:"as"}` here would be silent identity spoofing.
		const viewer = principal({ access: [{ id: SUPPORT, role: "viewer" }] });
		expect(sendAttributionFor(viewer, SUPPORT)).toBeNull();
	});

	it("refuses a mailbox the principal cannot reach", () => {
		expect(sendAttributionFor(principal(), SALES)).toBeNull();
	});

	it("refuses when there is no principal at all", () => {
		// A route that never resolved identity must not be able to send.
		expect(sendAttributionFor(undefined, SUPPORT)).toBeNull();
	});

	it("refuses on-behalf-of with no identity to attribute it to", () => {
		// Sending as the mailbox instead would defeat the whole distinction.
		expect(
			attributionFor(new Set<MailboxCapability>(["sendOnBehalf"]), null),
		).toBeNull();
	});
});

describe("buildOutgoingHeaders", () => {
	/**
	 * `Sender` USED to be emitted here to attribute an on-behalf-of send, and
	 * these tests asserted it. Email Service does not allowlist `Sender`, and a
	 * rejected header fails the entire message — so the attribution header was
	 * one of the two reasons no mail was being delivered at all.
	 *
	 * Attribution is not lost: the audit log records who sent from whose mailbox
	 * (`mail.send` with `attribution`), which is the durable record. What is gone
	 * is the wire header, because the provider will not carry it.
	 */
	it("never emits Sender, which the provider refuses", () => {
		const headers = buildOutgoingHeaders({ inReplyTo: "parent" });
		expect(headers).not.toHaveProperty("Sender");
	});

	it("carries the threading fields, which ARE allowlisted", () => {
		const headers = buildOutgoingHeaders({
			inReplyTo: "parent",
			references: ["root", "parent"],
		});
		expect(headers["In-Reply-To"]).toBe("<parent>");
		expect(headers.References).toBe("<root> <parent>");
		// The id the provider will assign is not ours to send.
		expect(headers).not.toHaveProperty("Message-ID");
	});
});

// -- Route enforcement ---------------------------------------------

/**
 * The middleware chain as `workers/index.ts` mounts it.
 *
 * Method-scoped capability gates over `requireMailbox`, with handlers that only
 * report they were reached. What is under test is the wiring: whether each
 * pattern matches the request it is meant to gate, and leaves alone the ones it
 * is not.
 */
function buildApp(env: { grants?: StoredGrant[]; identity?: AccessIdentity | null }) {
	const store = new Map<string, string>();
	for (const address of [SUPPORT, SALES]) {
		store.set(`mailboxes/${address}.json`, JSON.stringify({ fromName: address }));
	}
	for (const record of env.grants ?? []) {
		store.set(`access/users/${record.id}.json`, JSON.stringify(record));
	}

	const bindings = {
		ADMIN_EMAILS: ADMIN,
		BUCKET: {
			async head(key: string) {
				return store.has(key) ? { key } : null;
			},
			async get(key: string) {
				const raw = store.get(key);
				return raw === undefined ? null : { json: async () => JSON.parse(raw) };
			},
		},
		MAILBOX: { idFromName: (name: string) => ({ name }), get: () => ({}) },
	} as unknown as Env;

	const app = new Hono<MailboxContext>();

	app.use("*", async (c, next) => {
		if (env.identity) c.set("accessIdentity", env.identity);
		return next();
	});
	app.use("/api/*", resolvePrincipal);
	app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

	// The same gates, in the same order, as the real mount.
	app.on(
		["GET"],
		[
			"/api/v1/mailboxes/:mailboxId/emails",
			// The export is the whole mailbox in one request, so it belongs on the
			// same gate as any single message.
			"/api/v1/mailboxes/:mailboxId/export",
		],
		requireCapability("read"),
	);
	// Sending accepts either capability, as the real mount does: the two differ in
	// attribution rather than in power and are independently grantable.
	app.on(
		["POST"],
		"/api/v1/mailboxes/:mailboxId/emails",
		requireAnyCapability(["sendAs", "sendOnBehalf"]),
	);
	app.on(["POST"], "/api/v1/mailboxes/:mailboxId/drafts", requireCapability("draft"));
	app.on(
		["DELETE"],
		"/api/v1/mailboxes/:mailboxId/emails/:id",
		requireCapability("delete"),
	);
	app.on(
		["POST"],
		"/api/v1/mailboxes/:mailboxId/trash/empty",
		requireCapability("deletePermanently"),
	);
	app.on(["POST"], "/api/v1/mailboxes/:mailboxId/labels", requireCapability("organise"));
	app.on(["POST"], "/api/v1/mailboxes/:mailboxId/rules", requireCapability("manageRules"));
	app.on(["PUT"], "/api/v1/mailboxes/:mailboxId", requireCapability("manageSettings"));

	app.get("/api/v1/mailboxes/:mailboxId/emails", (c) => c.json({ reached: "list" }));
	app.get("/api/v1/mailboxes/:mailboxId/export", (c) => c.json({ reached: "export" }));
	app.post("/api/v1/mailboxes/:mailboxId/emails", (c) => c.json({ reached: "send" }));
	app.post("/api/v1/mailboxes/:mailboxId/drafts", (c) => c.json({ reached: "draft" }));
	app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", (c) => c.json({ reached: "bin" }));
	app.post("/api/v1/mailboxes/:mailboxId/trash/empty", (c) => c.json({ reached: "purge" }));
	app.post("/api/v1/mailboxes/:mailboxId/labels", (c) => c.json({ reached: "label" }));
	app.post("/api/v1/mailboxes/:mailboxId/rules", (c) => c.json({ reached: "rule" }));
	app.put("/api/v1/mailboxes/:mailboxId", (c) => c.json({ reached: "settings" }));

	return (path: string, init?: RequestInit) =>
		app.fetch(new Request(`https://mailer.tapetide.com${path}`, init), bindings);
}

/**
 * A grant record as it exists in storage.
 *
 * Narrowing lives inside `mailboxes` because that is the single field `putGrant`
 * writes: entries are plain strings where full access is meant and objects where
 * it is not. `access` is derived on read, so a fixture that put the role only in
 * an `access` field would be widened straight back to full access — which is
 * exactly what a real record edited that way would do.
 *
 * Typed as the stored shape rather than `AccessGrant` so the mixed entry list is
 * expressible without casting away the difference.
 */
interface StoredGrant {
	id: string;
	kind: "user" | "service";
	role: "admin" | "member";
	mailboxes: (string | { id: string; role: string })[];
	updatedAt: string;
}

function grantWith(role: string, mailboxId = SUPPORT): StoredGrant {
	return {
		id: MEMBER,
		kind: "user",
		role: "member",
		mailboxes: [{ id: mailboxId, role }],
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("requireCapability", () => {
	it("lets an agent read, draft, send and organise", async () => {
		const request = buildApp({ identity: user(), grants: [grantWith("agent")] });

		for (const [method, path] of [
			["GET", `/api/v1/mailboxes/${SUPPORT}/emails`],
			["POST", `/api/v1/mailboxes/${SUPPORT}/emails`],
			["POST", `/api/v1/mailboxes/${SUPPORT}/drafts`],
			["POST", `/api/v1/mailboxes/${SUPPORT}/labels`],
			["DELETE", `/api/v1/mailboxes/${SUPPORT}/emails/abc`],
		] as const) {
			const res = await request(path, { method });
			expect(res.status, `${method} ${path}`).toBe(200);
		}
	});

	it("refuses an agent the things a manager owns", async () => {
		const request = buildApp({ identity: user(), grants: [grantWith("agent")] });

		for (const [method, path] of [
			["POST", `/api/v1/mailboxes/${SUPPORT}/trash/empty`],
			["POST", `/api/v1/mailboxes/${SUPPORT}/rules`],
			["PUT", `/api/v1/mailboxes/${SUPPORT}`],
		] as const) {
			const res = await request(path, { method });
			expect(res.status, `${method} ${path}`).toBe(403);
		}
	});

	it("names the missing capability, so the UI can explain the refusal", async () => {
		const request = buildApp({ identity: user(), grants: [grantWith("viewer")] });

		const res = await request(`/api/v1/mailboxes/${SUPPORT}/emails`, { method: "POST" });
		expect(res.status).toBe(403);
		// Both acceptable capabilities are named: "you need sendOnBehalf" is
		// misleading advice when sendAs would also have been enough.
		await expect(res.json()).resolves.toEqual({
			error:
				"You do not have permission to do this in this mailbox (sendAs or sendOnBehalf)",
			capability: "sendAs",
			capabilities: ["sendAs", "sendOnBehalf"],
		});
	});

	it("lets a grant extended with only sendAs send", async () => {
		// The bug this covers: gating on `sendOnBehalf` alone refused a viewer
		// extended with `sendAs`, making the documented independent grant unusable.
		const request = buildApp({
			identity: user(),
			grants: [
				{
					id: MEMBER,
					kind: "user",
					role: "member",
					mailboxes: [{ id: SUPPORT, role: "viewer", extra: ["sendAs"] }],
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});

		const res = await request(`/api/v1/mailboxes/${SUPPORT}/emails`, { method: "POST" });
		expect(res.status).toBe(200);
	});

	it("refuses the export to a grant with read revoked", async () => {
		// The hole this closes: the read gate covered every message route but not the
		// export, so a caller refused a single message could still download all of
		// them in one request.
		const request = buildApp({
			identity: user(),
			grants: [
				{
					id: MEMBER,
					kind: "user",
					role: "member",
					mailboxes: [{ id: SUPPORT, role: "owner", revoked: ["read"] }],
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});

		await expect(
			request(`/api/v1/mailboxes/${SUPPORT}/emails`).then((r) => r.status),
		).resolves.toBe(403);
		await expect(
			request(`/api/v1/mailboxes/${SUPPORT}/export`).then((r) => r.status),
		).resolves.toBe(403);
	});

	it("lets a reader export", async () => {
		const request = buildApp({ identity: user(), grants: [grantWith("viewer")] });
		const res = await request(`/api/v1/mailboxes/${SUPPORT}/export`);
		expect(res.status).toBe(200);
	});

	it("lets a viewer read while refusing every write", async () => {
		const request = buildApp({ identity: user(), grants: [grantWith("viewer")] });

		expect((await request(`/api/v1/mailboxes/${SUPPORT}/emails`)).status).toBe(200);
		for (const [method, path] of [
			["POST", `/api/v1/mailboxes/${SUPPORT}/emails`],
			["POST", `/api/v1/mailboxes/${SUPPORT}/drafts`],
			["POST", `/api/v1/mailboxes/${SUPPORT}/labels`],
			["DELETE", `/api/v1/mailboxes/${SUPPORT}/emails/abc`],
		] as const) {
			expect((await request(path, { method })).status, `${method} ${path}`).toBe(403);
		}
	});

	it("does not let a write gate block the read on the same path", async () => {
		// The gates are method-scoped; a shared path must not refuse a GET.
		const request = buildApp({ identity: user(), grants: [grantWith("viewer")] });
		expect((await request(`/api/v1/mailboxes/${SUPPORT}/emails`)).status).toBe(200);
	});

	it("lets an owner do everything, which is the pre-capabilities behaviour", async () => {
		const request = buildApp({
			identity: user(),
			grants: [grantWith(FULL_ACCESS_ROLE)],
		});

		for (const [method, path] of [
			["GET", `/api/v1/mailboxes/${SUPPORT}/emails`],
			["POST", `/api/v1/mailboxes/${SUPPORT}/emails`],
			["POST", `/api/v1/mailboxes/${SUPPORT}/trash/empty`],
			["POST", `/api/v1/mailboxes/${SUPPORT}/rules`],
			["PUT", `/api/v1/mailboxes/${SUPPORT}`],
		] as const) {
			expect((await request(path, { method })).status, `${method} ${path}`).toBe(200);
		}
	});

	it("treats a bare-address grant as an owner grant", async () => {
		// End-to-end compatibility: an existing record keeps working unchanged.
		const request = buildApp({
			identity: user(),
			grants: [
				{
					id: MEMBER,
					kind: "user",
					role: "member",
					mailboxes: [SUPPORT],
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});

		expect((await request(`/api/v1/mailboxes/${SUPPORT}`, { method: "PUT" })).status).toBe(
			200,
		);
	});

	it("gives an admin every capability without a per-mailbox grant", async () => {
		const request = buildApp({ identity: user(ADMIN) });
		expect((await request(`/api/v1/mailboxes/${SALES}`, { method: "PUT" })).status).toBe(200);
	});

	it("still refuses a mailbox outside the grant before asking about capability", async () => {
		// Reachability is decided first, so the answer is "no access", not "no
		// permission" — the caller should not learn which capability they lack for
		// a mailbox they cannot open at all.
		const request = buildApp({ identity: user(), grants: [grantWith("owner")] });

		const res = await request(`/api/v1/mailboxes/${SALES}/emails`);
		expect(res.status).toBe(403);
		await expect(res.json()).resolves.toEqual({
			error: "You do not have access to this mailbox",
		});
	});

	it("applies the capability to the mailbox in the path, not another in the grant", async () => {
		const request = buildApp({
			identity: user(),
			grants: [
				{
					id: MEMBER,
					kind: "user",
					role: "member",
					// Agent on the shared inbox, owner of their own: the headline case.
					mailboxes: [{ id: SUPPORT, role: "agent" }, SALES],
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});

		// Owner on sales, agent on support: settings only on the former.
		expect((await request(`/api/v1/mailboxes/${SALES}`, { method: "PUT" })).status).toBe(200);
		expect((await request(`/api/v1/mailboxes/${SUPPORT}`, { method: "PUT" })).status).toBe(
			403,
		);
	});
});


/**
 * The real read gate, read from source.
 *
 * The suite above mirrors the mount, so a route removed from the real gate would
 * not fail it — which is exactly how `/export` came to be missing in the first
 * place. This reads `workers/index.ts` and requires every route that reveals a
 * message to be named there.
 *
 * Source text rather than the module: importing it needs Worker bindings.
 */
describe("the real read gate", () => {
	const source = readFileSync(
		new URL("../workers/index.ts", import.meta.url),
		"utf8",
	);
	const gate = source.slice(
		source.indexOf('app.on(\n\t["GET"],'),
		source.indexOf('requireCapability("read"),'),
	);

	it("names every route that hands back a message", () => {
		// Anything that returns mail, or a list of it, has to be here. A revocation
		// that covers the inbox but not one of these is a detour, not a revocation.
		for (const route of [
			"/api/v1/mailboxes/:mailboxId/emails",
			"/api/v1/mailboxes/:mailboxId/emails/:id",
			"/api/v1/mailboxes/:mailboxId/threads/:threadId",
			"/api/v1/mailboxes/:mailboxId/search",
			"/api/v1/mailboxes/:mailboxId/labels/:labelId/emails",
			"/api/v1/mailboxes/:mailboxId/snoozed",
			"/api/v1/mailboxes/:mailboxId/scheduled-sends",
			"/api/v1/mailboxes/:mailboxId/muted-threads",
			// The whole mailbox at once, so the most important of the lot.
			"/api/v1/mailboxes/:mailboxId/export",
		]) {
			expect({ route, gated: gate.includes(`"${route}"`) }).toEqual({
				route,
				gated: true,
			});
		}
	});
});

/**
 * The real SEND gate, read from source.
 *
 * Same reasoning as the read gate above, and it exists because the same mistake
 * happened again: `…/scheduled-sends/:emailId/send-now` shipped mounted under only
 * `requireMailbox`, so a `viewer` holding neither `sendAs` nor `sendOnBehalf` could
 * list the Scheduled folder, take an id, and deliver the message. Read-only access
 * was enough to send mail.
 *
 * The send delay is what made that reachable rather than theoretical: every
 * ordinary send passes through Scheduled for its undo window, so the exposure was
 * not limited to messages someone had deliberately scheduled for later.
 *
 * A suite that mirrored the mount could not catch this — it would assert whatever
 * the mount happens to say. So this reads `workers/index.ts` and requires every
 * route that puts a message on the wire to be named in the gate.
 */
describe("the real send gate", () => {
	const source = readFileSync(
		new URL("../workers/index.ts", import.meta.url),
		"utf8",
	);
	/**
	 * From the gate's definition to the drafts mount, which is the first thing
	 * after it that is deliberately NOT send-gated ("drafts are unsent"). Bounding
	 * it that way means a new send route added below the region fails this test
	 * rather than sliding in ungated.
	 */
	const gate = source.slice(
		source.indexOf("const requireSend = "),
		source.indexOf('/api/v1/mailboxes/:mailboxId/drafts"'),
	);

	it("names every route that delivers a message", () => {
		for (const route of [
			"/api/v1/mailboxes/:mailboxId/emails",
			"/api/v1/mailboxes/:mailboxId/emails/:id/reply",
			"/api/v1/mailboxes/:mailboxId/emails/:id/forward",
			"/api/v1/mailboxes/:mailboxId/scheduled-sends",
			// Unsending is sending: pulling a message back needs the same authority.
			"/api/v1/mailboxes/:mailboxId/scheduled-sends/:emailId",
			// Skipping the wait is still sending — the P1 this test exists for.
			"/api/v1/mailboxes/:mailboxId/scheduled-sends/:emailId/send-now",
		]) {
			expect({ route, gated: gate.includes(`"${route}"`) }).toEqual({
				route,
				gated: true,
			});
		}
	});

	it("gates the region with requireSend rather than something weaker", () => {
		// The routes being listed is only half of it; they have to be listed under
		// the capability gate. Three mounts share it, so three references.
		expect(gate.match(/requireSend,/g)?.length).toBe(3);
	});
});
