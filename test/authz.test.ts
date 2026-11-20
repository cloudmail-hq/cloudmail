// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Authorization: who is asking, and which mailboxes they may touch.
 *
 * Cloudflare Access authenticated the reader and nothing authorized them: the
 * verified identity was read once, to print a name in the corner, and every other
 * route ignored it. Anyone who passed the shared Access policy could open, send
 * from and delete any mailbox in the deployment.
 *
 * Three properties have to hold at once here, and they pull against each other.
 * A configured deployment must fail *closed* — no grant means no access, and a
 * request body must not be able to name a mailbox the caller was not given. An
 * unconfigured deployment must keep working exactly as before, because enforcing
 * by default would lock existing operators out of their own mail on the first
 * request after deploy. And machines must be grantable the same way people are,
 * because Access is enforced at the edge and a service token is the only machine
 * credential that can actually reach this code.
 *
 * The branch order in `decidePrincipal` is the security property, so it is pinned
 * case by case below, followed by the middleware that consumes it.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
	agentTargetFromPath,
	canAccessMailbox,
	decidePrincipal,
	identityFromTokenPayload,
	isAdmin,
	isAdminEmailsMisconfigured,
	isValidPrincipalId,
	normalizeAddress,
	parseAdminEmails,
	parseGrant,
	principalFromProps,
	resolvePrincipalFor,
	revokeMailboxFromGrants,
	visibleMailboxes,
	type AccessGrant,
	type AccessIdentity,
	type Principal,
} from "../workers/lib/authz";
import { FULL_ACCESS_ROLE } from "../workers/lib/capabilities";
import {
	requireAdmin,
	requireMailbox,
	resolvePrincipal,
	type MailboxContext,
} from "../workers/lib/mailbox";
import type { Env } from "../workers/types";

const ADMIN = "owner@tapetide.com";
const MEMBER = "member@tapetide.com";
const SUPPORT = "support@tapetide.com";
const SALES = "sales@tapetide.com";
/** Shape Access uses for a service token Client ID. */
const SERVICE = "e367826f93b8d71185e03fe518aff3b4.access";

function user(id = MEMBER): AccessIdentity {
	return { kind: "user", id, subject: "uuid-1" };
}

function service(id = SERVICE): AccessIdentity {
	// Access sends an empty `sub` for service tokens.
	return { kind: "service", id, subject: null };
}

/**
 * A stored grant.
 *
 * `access` mirrors `mailboxes` at full authority unless a test overrides it,
 * which is what a record written before capabilities existed resolves to. Tests
 * that care about narrowing pass `access` explicitly.
 */
function grant(overrides: Partial<AccessGrant> = {}): AccessGrant {
	const mailboxes = overrides.mailboxes ?? [SUPPORT];
	return {
		id: MEMBER,
		kind: "user",
		role: "member",
		mailboxes,
		access: mailboxes.map((id) => ({ id, role: FULL_ACCESS_ROLE })),
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("parseAdminEmails", () => {
	it("treats an unset or empty value as no administrators", () => {
		// This is what disables enforcement, so it has to be unambiguous.
		expect(parseAdminEmails(undefined)).toEqual([]);
		expect(parseAdminEmails(null)).toEqual([]);
		expect(parseAdminEmails("")).toEqual([]);
		expect(parseAdminEmails("   ")).toEqual([]);
	});

	it("splits, trims, lowercases and deduplicates", () => {
		expect(parseAdminEmails(" Owner@Tapetide.com , member@tapetide.com ")).toEqual([
			ADMIN,
			MEMBER,
		]);
		expect(parseAdminEmails("a@b.com,a@b.com,A@B.com")).toEqual(["a@b.com"]);
	});

	it("drops entries that are not a single address", () => {
		// A semicolon instead of a comma yields one nonsense entry that grants
		// nobody. Kept, it would switch enforcement on and lock the operator out
		// with nothing to explain why — so it is dropped instead.
		expect(parseAdminEmails("owner@tapetide.com;other@tapetide.com")).toEqual([]);
		expect(parseAdminEmails("owner@tapetide.com other@tapetide.com")).toEqual([]);
		expect(parseAdminEmails("owner@@tapetide.com")).toEqual([]);
		expect(parseAdminEmails("@tapetide.com")).toEqual([]);
		expect(parseAdminEmails("owner@localhost")).toEqual([]);
		expect(parseAdminEmails("owner@.com")).toEqual([]);
		expect(parseAdminEmails("owner@tapetide.")).toEqual([]);
		expect(parseAdminEmails("notanemail")).toEqual([]);
	});

	it("keeps the good entries alongside a bad one", () => {
		expect(parseAdminEmails("owner@tapetide.com,notanemail")).toEqual([ADMIN]);
	});
});

describe("isAdminEmailsMisconfigured", () => {
	it("is false when the value is absent, which is a deliberate choice", () => {
		expect(isAdminEmailsMisconfigured(undefined)).toBe(false);
		expect(isAdminEmailsMisconfigured("")).toBe(false);
		expect(isAdminEmailsMisconfigured("   ")).toBe(false);
	});

	it("is false when the value parses", () => {
		expect(isAdminEmailsMisconfigured(ADMIN)).toBe(false);
	});

	it("is true when something was set but nothing usable came out", () => {
		// "Not configured" and "configured wrong" both leave enforcement off and
		// are otherwise indistinguishable, which is why this exists.
		expect(isAdminEmailsMisconfigured("owner@tapetide.com;other@tapetide.com")).toBe(
			true,
		);
		expect(isAdminEmailsMisconfigured("nonsense")).toBe(true);
	});
});

describe("identityFromTokenPayload", () => {
	it("reads a person from an identity-provider token", () => {
		// Documented shape: email plus a user UUID in `sub`.
		expect(
			identityFromTokenPayload({
				email: "User@Example.com",
				sub: "7335d417-61da-459d-899c-0a01c76a2f94",
			}),
		).toEqual({
			kind: "user",
			id: "user@example.com",
			subject: "7335d417-61da-459d-899c-0a01c76a2f94",
		});
	});

	it("reads a machine from a service-token payload", () => {
		// Documented shape: `common_name` is the Client ID and `sub` is empty.
		expect(
			identityFromTokenPayload({ common_name: SERVICE, sub: "" }),
		).toEqual({ kind: "service", id: SERVICE, subject: null });
	});

	it("prefers the email when a token somehow carries both", () => {
		// A person is the more specific claim; `common_name` is also where an mTLS
		// certificate name lands, so it must not shadow a real identity.
		const identity = identityFromTokenPayload({
			email: MEMBER,
			common_name: SERVICE,
			sub: "uuid",
		});

		expect(identity).toEqual({ kind: "user", id: MEMBER, subject: "uuid" });
	});

	it("returns null for a token that names nobody", () => {
		// Refused downstream rather than defaulted to anything.
		expect(identityFromTokenPayload({})).toBeNull();
		expect(identityFromTokenPayload({ sub: "" })).toBeNull();
		expect(identityFromTokenPayload({ email: 42, common_name: null })).toBeNull();
		// An "email" with no @ is not an identity we can match a grant against.
		expect(identityFromTokenPayload({ email: "nonsense" })).toBeNull();
		expect(identityFromTokenPayload({ common_name: "   " })).toBeNull();
	});
});

describe("isValidPrincipalId", () => {
	it("requires an address for a person", () => {
		expect(isValidPrincipalId("user", MEMBER)).toBe(true);
		expect(isValidPrincipalId("user", SERVICE)).toBe(false);
		expect(isValidPrincipalId("user", "nonsense")).toBe(false);
	});

	it("accepts an Access Client ID for a machine", () => {
		expect(isValidPrincipalId("service", SERVICE)).toBe(true);
		// The `.access` suffix is not required: `common_name` is whatever Access
		// put there, and pinning a format the platform may change would reject
		// valid callers.
		expect(isValidPrincipalId("service", "ci-deploy-bot")).toBe(true);
	});

	it("rejects a machine id that is unsafe as a storage key", () => {
		// These become R2 object keys, so a slash would name something else.
		expect(isValidPrincipalId("service", "a/b")).toBe(false);
		expect(isValidPrincipalId("service", "..")).toBe(false);
		expect(isValidPrincipalId("service", "")).toBe(false);
		expect(isValidPrincipalId("service", "has space")).toBe(false);
		// An email pasted into the machine field is a mistake worth catching.
		expect(isValidPrincipalId("service", MEMBER)).toBe(false);
		expect(isValidPrincipalId("service", "x".repeat(201))).toBe(false);
	});
});

describe("decidePrincipal — unconfigured deployment", () => {
	const unconfigured = { adminEmails: [] };

	it("keeps the historical model: any authenticated caller is an admin", () => {
		const principal = decidePrincipal({ ...unconfigured, identity: user() });

		expect(principal.role).toBe("admin");
		// null, not [] — "every mailbox", which is what this deployment meant.
		expect(principal.mailboxes).toBeNull();
		expect(canAccessMailbox(principal, SALES)).toBe(true);
	});

	it("reports that none of it is binding", () => {
		// The UI needs to be able to say "authorization is not switched on" rather
		// than implying a model that is not in force.
		expect(decidePrincipal({ ...unconfigured, identity: user() }).enforced).toBe(
			false,
		);
	});
});

describe("decidePrincipal — configured deployment", () => {
	const configured = { adminEmails: [ADMIN] };

	it("makes a configured address an admin, with no grant needed", () => {
		const principal = decidePrincipal({ ...configured, identity: user(ADMIN) });

		expect(principal.role).toBe("admin");
		expect(principal.mailboxes).toBeNull();
		expect(principal.enforced).toBe(true);
	});

	it("ignores casing when matching the configured admin", () => {
		expect(
			decidePrincipal({
				adminEmails: ["Owner@Tapetide.com"],
				identity: user("OWNER@tapetide.com"),
			}).role,
		).toBe("admin");
	});

	it("gives a member exactly the mailboxes in their grant", () => {
		const principal = decidePrincipal({
			...configured,
			identity: user(),
			grant: grant({ mailboxes: [SUPPORT] }),
		});

		expect(principal.role).toBe("member");
		expect(canAccessMailbox(principal, SUPPORT)).toBe(true);
		expect(canAccessMailbox(principal, SALES)).toBe(false);
	});

	it("refuses an authenticated stranger who has no grant", () => {
		const principal = decidePrincipal({
			...configured,
			identity: user("stranger@elsewhere.com"),
			grant: null,
		});

		// [] and null must not be conflated: this is the case that would fail open.
		expect(principal.mailboxes).toEqual([]);
		expect(canAccessMailbox(principal, SUPPORT)).toBe(false);
		expect(isAdmin(principal)).toBe(false);
	});

	it("refuses a verified token that carries no identity", () => {
		const principal = decidePrincipal({ ...configured, identity: null });

		expect(principal.role).toBe("member");
		expect(principal.mailboxes).toEqual([]);
		expect(canAccessMailbox(principal, SUPPORT)).toBe(false);
	});

	it("honours a grant that promotes someone to admin", () => {
		// So admins can be appointed from the UI without editing Worker vars.
		const principal = decidePrincipal({
			...configured,
			identity: user(),
			grant: grant({ role: "admin" }),
		});

		expect(principal.role).toBe("admin");
		expect(principal.mailboxes).toBeNull();
	});

	it("ignores a grant addressed to somebody else", () => {
		const principal = decidePrincipal({
			...configured,
			identity: user(),
			grant: grant({ id: "someone.else@tapetide.com", mailboxes: [SALES] }),
		});

		expect(principal.mailboxes).toEqual([]);
		expect(canAccessMailbox(principal, SALES)).toBe(false);
	});

	it("normalizes granted addresses so casing cannot defeat the check", () => {
		const principal = decidePrincipal({
			...configured,
			identity: user(),
			grant: grant({ mailboxes: ["Support@Tapetide.com"] }),
		});

		expect(canAccessMailbox(principal, "SUPPORT@tapetide.com")).toBe(true);
	});

	it("does not let a member's own grant list make them an admin", () => {
		const principal = decidePrincipal({
			...configured,
			identity: user(),
			grant: grant({ mailboxes: [SUPPORT, SALES] }),
		});

		expect(isAdmin(principal)).toBe(false);
	});
});

describe("decidePrincipal — machines", () => {
	const configured = { adminEmails: [ADMIN] };

	it("grants a service token the mailboxes in its grant", () => {
		const principal = decidePrincipal({
			...configured,
			identity: service(),
			grant: grant({ id: SERVICE, kind: "service", mailboxes: [SUPPORT] }),
		});

		expect(principal.role).toBe("member");
		expect(canAccessMailbox(principal, SUPPORT)).toBe(true);
		expect(canAccessMailbox(principal, SALES)).toBe(false);
	});

	it("refuses a service token with no grant", () => {
		const principal = decidePrincipal({ ...configured, identity: service() });

		expect(principal.mailboxes).toEqual([]);
		expect(canAccessMailbox(principal, SUPPORT)).toBe(false);
	});

	it("will not match a machine against a person's grant of the same id", () => {
		// The kinds are stored separately and granted separately. A grant that
		// matched on id alone would let one cross into the other.
		const principal = decidePrincipal({
			...configured,
			identity: service("shared-id"),
			grant: grant({ id: "shared-id", kind: "user", mailboxes: [SUPPORT] }),
		});

		expect(principal.mailboxes).toEqual([]);
	});

	it("never reads ADMIN_EMAILS for a machine", () => {
		// `ADMIN_EMAILS` names people. A machine is only ever an admin by an
		// explicit grant, so even an id equal to a configured admin gets nothing.
		const principal = decidePrincipal({
			...configured,
			identity: service(ADMIN),
		});

		expect(principal.role).toBe("member");
		expect(principal.mailboxes).toEqual([]);
	});

	it("allows an explicitly granted admin machine", () => {
		const principal = decidePrincipal({
			...configured,
			identity: service(),
			grant: grant({ id: SERVICE, kind: "service", role: "admin" }),
		});

		expect(principal.role).toBe("admin");
		expect(principal.mailboxes).toBeNull();
	});
});

describe("decidePrincipal — local development", () => {
	it("grants full access when there is no Access token to authorize", () => {
		// Access is skipped entirely on localhost, so there is no identity to
		// check. Enforcing here would only make the app unusable in development.
		const principal = decidePrincipal({
			adminEmails: [ADMIN],
			identity: null,
			developmentBypass: true,
		});

		expect(principal.role).toBe("admin");
		expect(principal.mailboxes).toBeNull();
		expect(principal.developmentBypass).toBe(true);
	});

	it("is a separate signal from a missing identity", () => {
		// The two are indistinguishable by the context variable alone, and only one
		// of them is safe to treat as full access. A verified Access service token
		// also arrives without an email.
		const production = decidePrincipal({
			adminEmails: [ADMIN],
			identity: null,
			developmentBypass: false,
		});

		expect(production.role).toBe("member");
		expect(production.developmentBypass).toBe(false);
	});
});

describe("visibleMailboxes", () => {
	const all = [SUPPORT, SALES, "billing@tapetide.com"];
	const identity = (address: string) => address;

	it("returns everything for a principal with no restriction", () => {
		const admin = decidePrincipal({ adminEmails: [], identity: user(ADMIN) });
		expect(visibleMailboxes(admin, all, identity)).toEqual(all);
	});

	it("narrows to the granted mailboxes", () => {
		const member = decidePrincipal({
			adminEmails: [ADMIN],
			identity: user(),
			grant: grant({ mailboxes: [SALES] }),
		});

		expect(visibleMailboxes(member, all, identity)).toEqual([SALES]);
	});

	it("returns nothing for a principal with no grant", () => {
		const stranger = decidePrincipal({
			adminEmails: [ADMIN],
			identity: user("stranger@elsewhere.com"),
		});

		expect(visibleMailboxes(stranger, all, identity)).toEqual([]);
	});

	it("does not invent rows for granted mailboxes that no longer exist", () => {
		// The grant is filtered against the caller's list rather than trusted as
		// the list, so a stale grant cannot conjure a phantom sidebar entry.
		const member = decidePrincipal({
			adminEmails: [ADMIN],
			identity: user(),
			grant: grant({ mailboxes: [SUPPORT, "deleted@tapetide.com"] }),
		});

		expect(visibleMailboxes(member, all, identity)).toEqual([SUPPORT]);
	});
});

describe("parseGrant", () => {
	it("reads a well-formed record", () => {
		expect(
			parseGrant(
				{
					id: "Member@Tapetide.com",
					role: "member",
					mailboxes: ["Support@Tapetide.com"],
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
				"user",
			),
		).toEqual({
			id: MEMBER,
			kind: "user",
			role: "member",
			mailboxes: [SUPPORT],
			// A bare address predates capabilities and means unrestricted access.
			access: [{ id: SUPPORT, role: FULL_ACCESS_ROLE }],
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
	});

	it("takes the kind from where the record was found, not from the record", () => {
		// A field that disagreed with its own storage location could otherwise
		// promote a machine into the set of people.
		const parsed = parseGrant(
			{ id: SERVICE, kind: "user", role: "member", mailboxes: [] },
			"service",
		);

		expect(parsed?.kind).toBe("service");
	});

	it("rejects an id that is invalid for its kind", () => {
		// A person's record under the machine prefix, or vice versa.
		expect(parseGrant({ id: SERVICE, role: "member" }, "user")).toBeNull();
		expect(parseGrant({ id: MEMBER, role: "member" }, "service")).toBeNull();
	});

	it("still reads records written before machines existed", () => {
		// Those carried the address as `email` rather than `id`.
		expect(parseGrant({ email: MEMBER, role: "member" }, "user")?.id).toBe(MEMBER);
	});

	it("rejects records with no usable id", () => {
		expect(parseGrant(null, "user")).toBeNull();
		expect(parseGrant("member@tapetide.com", "user")).toBeNull();
		expect(parseGrant({ role: "admin" }, "user")).toBeNull();
		expect(parseGrant({ id: "notanemail", role: "admin" }, "user")).toBeNull();
	});

	it("treats anything but an explicit admin role as a member", () => {
		// A truncated or hand-edited record must not read as an escalation.
		for (const role of [undefined, null, "", "Admin", "superuser", 1, true]) {
			const parsed = parseGrant({ id: MEMBER, role, mailboxes: [] }, "user");
			expect(parsed?.role, `role: ${String(role)}`).toBe("member");
		}
	});

	it("defaults a missing or malformed mailbox list to no access", () => {
		expect(parseGrant({ id: MEMBER, role: "member" }, "user")?.mailboxes).toEqual([]);
		expect(
			parseGrant({ id: MEMBER, role: "member", mailboxes: SUPPORT }, "user")
				?.mailboxes,
		).toEqual([]);
		// Non-string entries are dropped rather than coerced into a match.
		expect(
			parseGrant(
				{ id: MEMBER, role: "member", mailboxes: [SUPPORT, 42, null] },
				"user",
			)?.mailboxes,
		).toEqual([SUPPORT]);
	});

	it("keeps a label, which is how an opaque Client ID gets recognised", () => {
		expect(
			parseGrant(
				{ id: SERVICE, role: "member", mailboxes: [], label: "  CI bot  " },
				"service",
			)?.label,
		).toBe("CI bot");
	});
});

describe("normalizeAddress", () => {
	it("trims and lowercases", () => {
		expect(normalizeAddress("  Support@Tapetide.COM ")).toBe(SUPPORT);
	});
});

describe("agentTargetFromPath", () => {
	it("reads the mailbox out of an agent route", () => {
		// PartyServer routes /agents/{namespace}/{name}/..., and for the email
		// agent the instance name is the mailbox address.
		expect(agentTargetFromPath(`/agents/email-agent/${SUPPORT}`)).toBe(SUPPORT);
		expect(agentTargetFromPath(`/agents/email-agent/${SUPPORT}/get-messages`)).toBe(
			SUPPORT,
		);
	});

	it("decodes a percent-encoded address", () => {
		expect(
			agentTargetFromPath(`/agents/email-agent/${encodeURIComponent(SUPPORT)}`),
		).toBe(SUPPORT);
	});

	it("returns null when there is no mailbox to authorize", () => {
		expect(agentTargetFromPath("/agents")).toBeNull();
		expect(agentTargetFromPath("/agents/email-agent")).toBeNull();
		expect(agentTargetFromPath("/api/v1/mailboxes")).toBeNull();
	});
});

describe("principalFromProps", () => {
	const member: Principal = {
		identity: user(),
		role: "member",
		mailboxes: [SUPPORT],
		access: [{ id: SUPPORT, role: FULL_ACCESS_ROLE }],
		enforced: true,
		developmentBypass: false,
	};

	it("round-trips a principal across the Durable Object boundary", () => {
		// Props are JSON, so this is the real trip: serialize, parse, rebuild.
		const restored = principalFromProps(
			JSON.parse(JSON.stringify({ principal: member })),
			ADMIN,
		);

		expect(restored).toEqual(member);
		expect(canAccessMailbox(restored, SUPPORT)).toBe(true);
		expect(canAccessMailbox(restored, SALES)).toBe(false);
	});

	it("round-trips a machine principal", () => {
		const machine: Principal = {
			identity: service(),
			role: "member",
			mailboxes: [SALES],
			enforced: true,
			developmentBypass: false,
		};

		const restored = principalFromProps(
			JSON.parse(JSON.stringify({ principal: machine })),
			ADMIN,
		);

		expect(restored.identity?.kind).toBe("service");
		expect(canAccessMailbox(restored, SALES)).toBe(true);
	});

	it("preserves an admin's reach", () => {
		const restored = principalFromProps(
			{
				principal: {
					identity: user(ADMIN),
					role: "admin",
					mailboxes: null,
					enforced: true,
				},
			},
			ADMIN,
		);

		expect(restored.mailboxes).toBeNull();
		expect(canAccessMailbox(restored, SALES)).toBe(true);
	});

	it("refuses a member that claims every mailbox", () => {
		// `mailboxes: null` means "all of them". Only an admin may carry it, so a
		// member record claiming it is narrowed rather than honoured.
		const restored = principalFromProps(
			{
				principal: {
					identity: user(),
					role: "member",
					mailboxes: null,
					enforced: true,
				},
			},
			ADMIN,
		);

		expect(restored.mailboxes).toEqual([]);
		expect(canAccessMailbox(restored, SUPPORT)).toBe(false);
	});

	it("denies everything when props are missing and enforcement is on", () => {
		// A session persisted before authorization existed arrives with no
		// authority. Falling back to configuration fails closed.
		for (const props of [undefined, null, {}, { principal: null }, "nonsense"]) {
			const restored = principalFromProps(props, ADMIN);
			expect(restored.role, JSON.stringify(props)).toBe("member");
			expect(canAccessMailbox(restored, SUPPORT)).toBe(false);
		}
	});

	it("falls back to full access when enforcement is off", () => {
		const restored = principalFromProps(undefined, undefined);

		expect(restored.role).toBe("admin");
		expect(canAccessMailbox(restored, SALES)).toBe(true);
	});

	it("treats an unrecognised role as a member", () => {
		const restored = principalFromProps(
			{ principal: { identity: user(), role: "superuser", mailboxes: [SUPPORT] } },
			ADMIN,
		);

		expect(restored.role).toBe("member");
	});
});

// -- Storage and middleware ------------------------------------------

/** Minimal R2 stand-in: enough of the surface these paths touch. */
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
			if (raw === undefined) return null;
			return { json: async () => JSON.parse(raw), text: async () => raw };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
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

function grantKeyFor(record: AccessGrant): string {
	const prefix = record.kind === "user" ? "access/users/" : "access/services/";
	return `${prefix}${record.id}.json`;
}

describe("resolvePrincipalFor", () => {
	const bucket = (grants: AccessGrant[] = []) => {
		const objects: Record<string, unknown> = {};
		for (const record of grants) objects[grantKeyFor(record)] = record;
		return fakeBucket(objects) as unknown as R2Bucket;
	};

	it("reads the grant for a member", async () => {
		const principal = await resolvePrincipalFor({
			adminEmailsRaw: ADMIN,
			bucket: bucket([grant({ mailboxes: [SALES] })]),
			identity: user(),
		});

		expect(principal.mailboxes).toEqual([SALES]);
	});

	it("reads the grant for a service token", async () => {
		const principal = await resolvePrincipalFor({
			adminEmailsRaw: ADMIN,
			bucket: bucket([
				grant({ id: SERVICE, kind: "service", mailboxes: [SUPPORT] }),
			]),
			identity: service(),
		});

		expect(principal.mailboxes).toEqual([SUPPORT]);
	});

	it("does not find a machine's grant under the people prefix", async () => {
		// Same id, wrong prefix: the kinds are separate namespaces.
		const principal = await resolvePrincipalFor({
			adminEmailsRaw: ADMIN,
			bucket: bucket([grant({ id: SERVICE, kind: "user", mailboxes: [SUPPORT] })]),
			identity: service(),
		});

		expect(principal.mailboxes).toEqual([]);
	});

	it("does not read a grant it cannot need", async () => {
		// A configured admin and an unenforced deployment are both decided from
		// configuration, so the hot path costs no R2 round trip.
		let reads = 0;
		const counting = {
			get: async () => {
				reads += 1;
				return null;
			},
		} as unknown as R2Bucket;

		await resolvePrincipalFor({
			adminEmailsRaw: ADMIN,
			bucket: counting,
			identity: user(ADMIN),
		});
		await resolvePrincipalFor({
			adminEmailsRaw: undefined,
			bucket: counting,
			identity: user(),
		});

		expect(reads).toBe(0);
	});

	it("denies a caller whose grant does not exist", async () => {
		const principal = await resolvePrincipalFor({
			adminEmailsRaw: ADMIN,
			bucket: bucket(),
			identity: user("stranger@elsewhere.com"),
		});

		expect(principal.mailboxes).toEqual([]);
	});
});

describe("revokeMailboxFromGrants", () => {
	it("strips a deleted mailbox from every grant that named it", async () => {
		// Otherwise deleting and re-creating an address would silently restore
		// everyone's access to it.
		const bucket = fakeBucket({
			"access/users/member@tapetide.com.json": grant({
				mailboxes: [SUPPORT, SALES],
			}),
			"access/users/other@tapetide.com.json": grant({
				id: "other@tapetide.com",
				mailboxes: [SALES],
			}),
			[`access/services/${SERVICE}.json`]: grant({
				id: SERVICE,
				kind: "service",
				mailboxes: [SUPPORT],
			}),
		});

		const updated = await revokeMailboxFromGrants(
			bucket as unknown as R2Bucket,
			SUPPORT,
		);

		// Two records named it: one person and one machine.
		expect(updated).toBe(2);
		expect(
			JSON.parse(bucket._store.get("access/users/member@tapetide.com.json")!)
				.mailboxes,
		).toEqual([SALES]);
		expect(
			JSON.parse(bucket._store.get(`access/services/${SERVICE}.json`)!).mailboxes,
		).toEqual([]);
		// Untouched.
		expect(
			JSON.parse(bucket._store.get("access/users/other@tapetide.com.json")!)
				.mailboxes,
		).toEqual([SALES]);
	});

	it("does nothing when no grant names it", async () => {
		const bucket = fakeBucket({
			"access/users/member@tapetide.com.json": grant({ mailboxes: [SALES] }),
		});

		expect(
			await revokeMailboxFromGrants(bucket as unknown as R2Bucket, SUPPORT),
		).toBe(0);
	});
});

/**
 * The middleware chain as `workers/index.ts` mounts it, over fake bindings.
 *
 * `resolvePrincipal` then `requireMailbox`, with the trailing wildcard that also
 * matches the bare mailbox path — the ordering and the pattern are both part of
 * what is being tested.
 */
function buildApp(env: {
	adminEmails?: string;
	mailboxes?: string[];
	grants?: AccessGrant[];
	identity?: AccessIdentity | null;
	developmentBypass?: boolean;
}) {
	const objects: Record<string, unknown> = {};
	for (const address of env.mailboxes ?? [SUPPORT, SALES]) {
		objects[`mailboxes/${address}.json`] = { fromName: address };
	}
	for (const record of env.grants ?? []) objects[grantKeyFor(record)] = record;

	const bindings = {
		// These cases pin the Access-mode model, including "unconfigured means
		// everyone is admin". Password mode is always enforced; that is covered in
		// test/auth-middleware.test.ts.
		AUTH_MODE: "access",
		ADMIN_EMAILS: env.adminEmails,
		BUCKET: fakeBucket(objects),
		MAILBOX: { idFromName: (name: string) => ({ name }), get: () => ({}) },
	} as unknown as Env;

	const app = new Hono<MailboxContext>();

	// Stand in for the Access middleware in workers/app.ts.
	app.use("*", async (c, next) => {
		if (env.developmentBypass) c.set("developmentBypass", true);
		if (env.identity) c.set("accessIdentity", env.identity);
		return next();
	});

	app.use("/api/*", resolvePrincipal);
	app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

	app.get("/api/v1/mailboxes/:mailboxId", (c) => c.json({ opened: true }));
	app.get("/api/v1/mailboxes/:mailboxId/emails", (c) => c.json({ listed: true }));
	app.post("/api/v1/admin-only", requireAdmin, (c) => c.json({ did: true }));
	app.get("/api/v1/whoami", (c) => c.json(c.var.principal as Principal));

	return (path: string, init?: RequestInit) =>
		app.fetch(new Request(`https://mailer.tapetide.com${path}`, init), bindings);
}

describe("requireMailbox", () => {
	it("lets a member into a mailbox they were granted", async () => {
		const request = buildApp({
			adminEmails: ADMIN,
			identity: user(),
			grants: [grant({ mailboxes: [SUPPORT] })],
		});

		expect((await request(`/api/v1/mailboxes/${SUPPORT}/emails`)).status).toBe(200);
	});

	it("refuses a member the mailbox they were not granted", async () => {
		const request = buildApp({
			adminEmails: ADMIN,
			identity: user(),
			grants: [grant({ mailboxes: [SUPPORT] })],
		});

		const res = await request(`/api/v1/mailboxes/${SALES}/emails`);
		expect(res.status).toBe(403);
		await expect(res.json()).resolves.toEqual({
			error: "You do not have access to this mailbox",
		});
	});

	it("also covers the bare mailbox path, not just its sub-routes", async () => {
		// Hono's trailing wildcard matches `/mailboxes/:id` too, which is what makes
		// this one middleware sufficient for read, update and delete of the mailbox
		// itself. If that ever changes, those routes lose their check.
		const request = buildApp({
			adminEmails: ADMIN,
			identity: user(),
			grants: [grant({ mailboxes: [SUPPORT] })],
		});

		expect((await request(`/api/v1/mailboxes/${SALES}`)).status).toBe(403);
		expect((await request(`/api/v1/mailboxes/${SUPPORT}`)).status).toBe(200);
	});

	it("refuses an authenticated caller with no grant at all", async () => {
		const request = buildApp({
			adminEmails: ADMIN,
			identity: user("stranger@elsewhere.com"),
		});

		expect((await request(`/api/v1/mailboxes/${SUPPORT}/emails`)).status).toBe(403);
	});

	it("lets a configured admin into every mailbox", async () => {
		const request = buildApp({ adminEmails: ADMIN, identity: user(ADMIN) });

		expect((await request(`/api/v1/mailboxes/${SUPPORT}/emails`)).status).toBe(200);
		expect((await request(`/api/v1/mailboxes/${SALES}/emails`)).status).toBe(200);
	});

	it("admits a granted service token", async () => {
		// The machine path all the way through the middleware: an Access service
		// token is a first-class caller, not a special case.
		const request = buildApp({
			adminEmails: ADMIN,
			identity: service(),
			grants: [grant({ id: SERVICE, kind: "service", mailboxes: [SUPPORT] })],
		});

		expect((await request(`/api/v1/mailboxes/${SUPPORT}/emails`)).status).toBe(200);
		expect((await request(`/api/v1/mailboxes/${SALES}/emails`)).status).toBe(403);
	});

	it("refuses an ungranted service token", async () => {
		const request = buildApp({ adminEmails: ADMIN, identity: service() });

		expect((await request(`/api/v1/mailboxes/${SUPPORT}/emails`)).status).toBe(403);
	});

	it("keeps an unconfigured deployment working for everyone", async () => {
		// The compatibility guarantee: no ADMIN_EMAILS, no behaviour change.
		const request = buildApp({ identity: user() });

		expect((await request(`/api/v1/mailboxes/${SALES}/emails`)).status).toBe(200);
	});

	it("still 404s a mailbox that does not exist, before authorizing it", async () => {
		const request = buildApp({ adminEmails: ADMIN, identity: user(ADMIN) });

		expect(
			(await request("/api/v1/mailboxes/nope@tapetide.com/emails")).status,
		).toBe(404);
	});

	it("matches a URL-encoded mailbox id against the grant", async () => {
		// The route param arrives percent-encoded from the browser; the grant does
		// not. Decoding has to happen before the comparison.
		const request = buildApp({
			adminEmails: ADMIN,
			identity: user(),
			grants: [grant({ mailboxes: [SUPPORT] })],
		});

		expect(
			(await request(`/api/v1/mailboxes/${encodeURIComponent(SUPPORT)}/emails`))
				.status,
		).toBe(200);
	});
});

describe("requireAdmin", () => {
	it("refuses a member", async () => {
		const request = buildApp({
			adminEmails: ADMIN,
			identity: user(),
			grants: [grant()],
		});

		const res = await request("/api/v1/admin-only", { method: "POST" });
		expect(res.status).toBe(403);
		await expect(res.json()).resolves.toEqual({
			error: "Administrator access required",
		});
	});

	it("admits a configured admin", async () => {
		const request = buildApp({ adminEmails: ADMIN, identity: user(ADMIN) });
		expect((await request("/api/v1/admin-only", { method: "POST" })).status).toBe(200);
	});

	it("admits a grant-promoted admin", async () => {
		const request = buildApp({
			adminEmails: ADMIN,
			identity: user(),
			grants: [grant({ role: "admin" })],
		});

		expect((await request("/api/v1/admin-only", { method: "POST" })).status).toBe(200);
	});

	it("refuses a service token that was only granted mailboxes", async () => {
		// A machine reaching an instance-wide route is worth refusing even though
		// it is a legitimate caller for the mailbox routes.
		const request = buildApp({
			adminEmails: ADMIN,
			identity: service(),
			grants: [grant({ id: SERVICE, kind: "service", mailboxes: [SUPPORT] })],
		});

		expect((await request("/api/v1/admin-only", { method: "POST" })).status).toBe(403);
	});

	it("admits everyone while enforcement is off", async () => {
		const request = buildApp({ identity: user() });
		expect((await request("/api/v1/admin-only", { method: "POST" })).status).toBe(200);
	});
});

describe("resolvePrincipal", () => {
	it("reports the grant it resolved", async () => {
		const request = buildApp({
			adminEmails: ADMIN,
			identity: user(),
			grants: [grant({ mailboxes: [SUPPORT] })],
		});

		await expect((await request("/api/v1/whoami")).json()).resolves.toEqual({
			identity: user(),
			role: "member",
			mailboxes: [SUPPORT],
			access: [{ id: SUPPORT, role: FULL_ACCESS_ROLE }],
			enforced: true,
			developmentBypass: false,
		});
	});

	it("grants development full access without an identity", async () => {
		const request = buildApp({ adminEmails: ADMIN, developmentBypass: true });

		const principal = (await (await request("/api/v1/whoami")).json()) as Principal;
		expect(principal.role).toBe("admin");
		expect(principal.mailboxes).toBeNull();
	});
});
