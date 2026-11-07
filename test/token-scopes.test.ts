// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Scoped API tokens: the intersection model.
 *
 * Effective authority = user grants ∩ token scopes ∩ token mailbox allowlist,
 * applied inside the authz query functions so every caller (REST, MCP, agent
 * socket) gets it. The properties pinned here:
 *
 * - an unscoped token is byte-for-byte the user's principal (backwards compat)
 * - scopes and mailboxes only ever narrow; a scope the grant does not back is inert
 * - the restriction survives the MCP principal header round trip
 * - instance-level routes fail closed for scoped tokens
 */

import { describe, expect, it } from "vitest";
import {
	applyTokenRestriction,
	canAccessMailbox,
	canDo,
	capabilitiesForScopes,
	decidePrincipal,
	hasTokenScope,
	isAdmin,
	isAdminFor,
	mailboxCapabilities,
	principalFromProps,
	sendAttributionFor,
	visibleMailboxes,
	type Principal,
} from "../workers/lib/authz";
import { MAILBOX_CAPABILITIES } from "../workers/lib/capabilities";
import { requiredTokenScope, tokenScopeDecision } from "../workers/lib/token-scope-guard";
import { app } from "../workers/index";
import { describeAuthority } from "../workers/lib/token-authority";
import {
	TOKEN_SCOPES,
	isMailboxSubset,
	isScopeSubset,
	normalizeTokenMailboxes,
	normalizeTokenScopes,
} from "../shared/token-scopes";

const ADMIN = "owner@example.com";
const MEMBER = "member@example.com";
const SUPPORT = "support@example.com";
const SALES = "sales@example.com";

function admin(): Principal {
	return decidePrincipal({
		adminEmails: [ADMIN],
		identity: { kind: "user", id: ADMIN, subject: null },
	});
}

/** A member with owner access to support@ and viewer access to sales@. */
function member(): Principal {
	return decidePrincipal({
		adminEmails: [ADMIN],
		identity: { kind: "user", id: MEMBER, subject: null },
		grant: {
			id: MEMBER,
			kind: "user",
			role: "member",
			mailboxes: [SUPPORT, SALES],
			access: [
				{ id: SUPPORT, role: "owner" },
				{ id: SALES, role: "viewer" },
			],
			updatedAt: "",
		},
	});
}

describe("normalization", () => {
	it("keeps null as unrestricted and drops unknown scopes", () => {
		expect(normalizeTokenScopes(null)).toBeNull();
		expect(normalizeTokenScopes(undefined)).toBeNull();
		expect(normalizeTokenScopes(["mail:send", "bogus", "mail:read", "mail:read"])).toEqual([
			"mail:read",
			"mail:send",
		]);
		// Garbage narrows to nothing; it never widens to everything.
		expect(normalizeTokenScopes("admin")).toEqual([]);
		expect(normalizeTokenMailboxes([" Support@Example.com ", SUPPORT])).toEqual([SUPPORT]);
		expect(normalizeTokenMailboxes(null)).toBeNull();
	});

	it("subset checks treat null as everything", () => {
		expect(isScopeSubset(["mail:read"], null)).toBe(true);
		expect(isScopeSubset(null, ["mail:read"])).toBe(false);
		expect(isScopeSubset(["mail:read", "mail:send"], ["mail:read"])).toBe(false);
		expect(isMailboxSubset([SUPPORT], [SUPPORT, SALES])).toBe(true);
		expect(isMailboxSubset(null, [SUPPORT])).toBe(false);
	});

	it("every scope maps to known capabilities, and null scopes mean all of them", () => {
		expect([...capabilitiesForScopes(null)].sort()).toEqual([...MAILBOX_CAPABILITIES].sort());
		expect([...capabilitiesForScopes([])]).toEqual([]);
		const all = capabilitiesForScopes([...TOKEN_SCOPES]);
		expect([...all].sort()).toEqual([...MAILBOX_CAPABILITIES].sort());
	});
});

describe("backwards compatibility", () => {
	it("a token with neither scopes nor mailboxes returns the user's principal unchanged", () => {
		for (const base of [admin(), member()]) {
			const applied = applyTokenRestriction(base, { id: "legacy", scopes: null, mailboxes: null });
			expect(applied).toBe(base);
			expect(applied.token).toBeUndefined();
		}
	});

	it("an unscoped admin token is still an admin with every capability everywhere", () => {
		const p = applyTokenRestriction(admin(), { id: "legacy", scopes: null, mailboxes: null });
		expect(isAdmin(p)).toBe(true);
		expect(canDo(p, "anything@example.com", "deletePermanently")).toBe(true);
		expect(sendAttributionFor(p, SUPPORT)).toEqual({ mode: "as" });
		expect(describeAuthority(p)).toMatchObject({ role: "admin", mailboxes: null, capabilities: null, token: null });
	});

	it("no token at all (a session) is unaffected", () => {
		const p = applyTokenRestriction(member(), undefined);
		expect(canDo(p, SUPPORT, "manageSettings")).toBe(true);
	});
});

describe("intersection", () => {
	it("scopes narrow the user's capabilities", () => {
		const p = applyTokenRestriction(member(), { id: "t", scopes: ["mail:read"], mailboxes: null });
		expect(canDo(p, SUPPORT, "read")).toBe(true);
		expect(canDo(p, SUPPORT, "sendAs")).toBe(false);
		expect(canDo(p, SUPPORT, "organise")).toBe(false);
		expect(sendAttributionFor(p, SUPPORT)).toBeNull();
		expect([...mailboxCapabilities(p, SUPPORT)]).toEqual(["read"]);
	});

	it("a scope the user's grant does not back grants nothing", () => {
		// sales@ is viewer: read only. mail:send on the token cannot add sending.
		const p = applyTokenRestriction(member(), { id: "t", scopes: ["mail:read", "mail:send"], mailboxes: null });
		expect(canDo(p, SALES, "read")).toBe(true);
		expect(canDo(p, SALES, "sendAs")).toBe(false);
		expect(canDo(p, SALES, "sendOnBehalf")).toBe(false);
		// And a mailbox outside the grant stays unreachable.
		expect(canAccessMailbox(p, "other@example.com")).toBe(false);
	});

	it("the mailbox allowlist narrows reach, for admins too", () => {
		const p = applyTokenRestriction(admin(), { id: "t", scopes: null, mailboxes: [SUPPORT] });
		expect(canAccessMailbox(p, SUPPORT)).toBe(true);
		expect(canAccessMailbox(p, "Support@Example.com")).toBe(true);
		expect(canAccessMailbox(p, SALES)).toBe(false);
		expect(canDo(p, SALES, "read")).toBe(false);
		expect(canDo(p, SUPPORT, "deletePermanently")).toBe(true);
		expect(
			visibleMailboxes(p, [{ email: SUPPORT }, { email: SALES }], (m) => m.email).map((m) => m.email),
		).toEqual([SUPPORT]);
	});

	it("allowlist ∩ grants: listing a mailbox the user cannot reach does not add it", () => {
		const p = applyTokenRestriction(member(), { id: "t", scopes: null, mailboxes: [SALES, "other@example.com"] });
		expect(canAccessMailbox(p, SALES)).toBe(true);
		expect(canAccessMailbox(p, "other@example.com")).toBe(false);
		expect(canAccessMailbox(p, SUPPORT)).toBe(false);
		expect(describeAuthority(p).mailboxes).toEqual([SALES]);
	});

	it("admin needs both the role and the admin scope", () => {
		expect(isAdmin(applyTokenRestriction(admin(), { id: "t", scopes: ["mail:read"], mailboxes: null }))).toBe(false);
		expect(isAdmin(applyTokenRestriction(admin(), { id: "t", scopes: ["admin"], mailboxes: null }))).toBe(true);
		expect(isAdmin(applyTokenRestriction(member(), { id: "t", scopes: ["admin"], mailboxes: null }))).toBe(false);
		// A mailbox-only restriction is mail scopes only: never admin (security
		// review of #101). Admin-class scopes count only when listed.
		const mailboxOnly = applyTokenRestriction(admin(), { id: "t", scopes: null, mailboxes: [SUPPORT] });
		expect(isAdmin(mailboxOnly)).toBe(false);
		expect(mailboxOnly.token?.scopes).toEqual(["mail:read", "mail:send", "mail:draft", "mail:organize"]);
		expect(
			isAdmin(applyTokenRestriction(admin(), { id: "t", scopes: ["admin"], mailboxes: [SUPPORT] })),
		).toBe(true);
	});

	it("send-only on an admin sends as the mailbox but cannot read it", () => {
		const p = applyTokenRestriction(admin(), { id: "t", scopes: ["mail:send"], mailboxes: null });
		expect(sendAttributionFor(p, SUPPORT)).toEqual({ mode: "as" });
		expect(canDo(p, SUPPORT, "read")).toBe(false);
	});

	it("an empty scope list grants no mailbox capability", () => {
		const p = applyTokenRestriction(admin(), { id: "t", scopes: [], mailboxes: null });
		for (const cap of MAILBOX_CAPABILITIES) expect(canDo(p, SUPPORT, cap)).toBe(false);
		expect(hasTokenScope(p, "mail:read")).toBe(false);
	});

	it("/me reports the effective capabilities and the token's scopes", () => {
		const p = applyTokenRestriction(member(), { id: "t1", scopes: ["mail:read", "mail:draft"], mailboxes: null });
		const view = describeAuthority(p);
		expect(view.token).toEqual({ id: "t1", scopes: ["mail:read", "mail:draft"], mailboxes: null });
		expect(view.capabilities).toEqual([
			{ mailboxId: SUPPORT, role: "owner", capabilities: ["read", "draft"] },
			{ mailboxId: SALES, role: "viewer", capabilities: ["read"] },
		]);
		const adminView = describeAuthority(applyTokenRestriction(admin(), { id: "t2", scopes: ["mail:read"], mailboxes: null }));
		expect(adminView.role).toBe("member");
		expect(adminView.capabilities).toEqual([{ mailboxId: "*", role: "token", capabilities: ["read"] }]);
	});
});

describe("MCP principal round trip", () => {
	it("keeps the token restriction through JSON (the MCP principal header)", () => {
		const p = applyTokenRestriction(admin(), { id: "t", scopes: ["mail:read"], mailboxes: [SUPPORT] });
		const decoded = principalFromProps({ principal: JSON.parse(JSON.stringify(p)) }, ADMIN, { forceEnforced: true });
		expect(decoded.token).toEqual({ id: "t", scopes: ["mail:read"], mailboxes: [SUPPORT] });
		expect(canAccessMailbox(decoded, SALES)).toBe(false);
		expect(canDo(decoded, SUPPORT, "sendAs")).toBe(false);
		expect(canDo(decoded, SUPPORT, "read")).toBe(true);
	});

	it("a forged token entry can only narrow", () => {
		const forged = { ...member(), token: { id: "x", scopes: ["admin", "nonsense"], mailboxes: null } };
		const decoded = principalFromProps({ principal: forged }, ADMIN, { forceEnforced: true });
		expect(isAdmin(decoded)).toBe(false);
		expect(canDo(decoded, SUPPORT, "read")).toBe(false);
	});
});

const IN_HANDLER_GATES = new Set([
	"DELETE /api/v1/mailboxes/:mailboxId",
	"POST /api/v1/mailboxes/:mailboxId/emails/bulk",
]);

describe("mailbox writes are always capability-gated", () => {
	it("every non-GET route under /mailboxes/:mailboxId has a gate, so 'mailbox' is never a pass-through", () => {
		// The scope guard defers mailbox writes to the capability gates. A write
		// route with no gate would let any scoped token through unchecked.
		const handlers = app.routes.filter(
			(r) =>
				r.method !== "ALL" &&
				r.method !== "GET" &&
				r.handler.length < 2 &&
				/^\/api\/v1\/mailboxes\/:mailboxId(\/|$)/.test(r.path),
		);
		const gated = new Set(
			app.routes.filter((r) => r.method !== "ALL" && r.handler.length >= 2).map((r) => `${r.method} ${r.path}`),
		);
		const ungated = handlers
			.map((h) => `${h.method} ${h.path}`)
			.filter((k) => !gated.has(k))
			// Gated inside the handler with `canDo`, which applies the token
			// intersection: DELETE /mailboxes/:id is requireAdmin (admin ∧
			// mailboxes:manage), and bulk checks the capability its `action` needs.
			.filter((k) => !IN_HANDLER_GATES.has(k));
		expect(ungated).toEqual([]);
	});
});

describe("mailbox-only token on an admin account (security review of #101)", () => {
	const p = () => applyTokenRestriction(admin(), { id: "t", scopes: null, mailboxes: [SUPPORT] });

	it("keeps mail access to its mailbox", () => {
		expect(canDo(p(), SUPPORT, "read")).toBe(true);
		expect(sendAttributionFor(p(), SUPPORT)).toEqual({ mode: "as" });
		expect(canDo(p(), SUPPORT, "organise")).toBe(true);
		expect(canAccessMailbox(p(), SALES)).toBe(false);
	});

	it("loses every admin-class scope", () => {
		for (const scope of ["admin", "domains:manage", "webhooks:manage", "mailboxes:manage"] as const) {
			expect({ scope, held: hasTokenScope(p(), scope) }).toEqual({ scope, held: false });
		}
		expect(isAdmin(p())).toBe(false);
		expect(isAdminFor(p(), "domains:manage")).toBe(false);
		// mailboxes:manage capabilities are not carried by mail scopes either.
		expect(canDo(p(), SUPPORT, "manageSettings")).toBe(false);
		expect(canDo(p(), SUPPORT, "manageDelegates")).toBe(false);
	});

	it("is refused on every route in the reported exploit", () => {
		for (const [m, path] of [
			["PUT", "/api/v1/access"],
			["GET", "/api/v1/access"],
			["DELETE", "/api/v1/access/user/x@example.com"],
			["PATCH", "/api/v1/domains/d1"],
			["DELETE", "/api/v1/domains/d1"],
			["GET", "/api/v1/access/audit"],
			["POST", "/api/v1/mailboxes"],
			["PUT", "/api/v1/branding"],
			["POST", "/api/v1/_migrate/mailboxes/x@example.com"],
			["PUT", `/api/v1/mailboxes/${SUPPORT}/aliases`],
		]) {
			expect({ m, path, refused: tokenScopeDecision(p(), m, path) !== null }).toEqual({ m, path, refused: true });
		}
		// Its own mail still works through the guard.
		expect(tokenScopeDecision(p(), "GET", `/api/v1/mailboxes/${SUPPORT}/emails`)).toBeNull();
		expect(tokenScopeDecision(p(), "GET", "/api/v1/me")).toBeNull();
	});

	it("a fully legacy token is untouched", () => {
		const legacy = applyTokenRestriction(admin(), { id: "t", scopes: null, mailboxes: null });
		expect(legacy.token).toBeUndefined();
		expect(isAdmin(legacy)).toBe(true);
		expect(tokenScopeDecision(legacy, "PUT", "/api/v1/access")).toBeNull();
	});
});

describe("shared definitions from mailbox-restricted tokens", () => {
	it("template and sequence-definition writes need admin; reads and enrollment do not", () => {
		const p = applyTokenRestriction(admin(), { id: "t", scopes: ["mail:read", "mail:draft", "mail:send"], mailboxes: [SUPPORT] });
		expect(tokenScopeDecision(p, "POST", "/api/v1/templates")).toBe("admin");
		expect(tokenScopeDecision(p, "PUT", "/api/v1/templates/welcome")).toBe("admin");
		expect(tokenScopeDecision(p, "DELETE", "/api/v1/sequences/s1")).toBe("admin");
		expect(tokenScopeDecision(p, "GET", "/api/v1/templates")).toBeNull();
		expect(tokenScopeDecision(p, "POST", "/api/v1/sequences/s1/enroll")).toBeNull();
		expect(tokenScopeDecision(p, "DELETE", "/api/v1/sequences/enrollments/e1")).toBeNull();
		const withAdmin = applyTokenRestriction(admin(), { id: "t", scopes: ["admin", "mail:draft"], mailboxes: [SUPPORT] });
		expect(tokenScopeDecision(withAdmin, "POST", "/api/v1/templates")).toBeNull();
	});

	it("a token without a mailbox allowlist keeps the mail:draft rule for templates", () => {
		const p = applyTokenRestriction(admin(), { id: "t", scopes: ["mail:draft"], mailboxes: null });
		expect(tokenScopeDecision(p, "POST", "/api/v1/templates")).toBeNull();
		const noDraft = applyTokenRestriction(admin(), { id: "t", scopes: ["mail:read"], mailboxes: null });
		expect(tokenScopeDecision(noDraft, "POST", "/api/v1/templates")).toBe("mail:draft");
	});
});

describe("route scope table", () => {
	it("mailbox reads need mail:read; writes defer to the capability gates", () => {
		expect(requiredTokenScope("GET", `/api/v1/mailboxes/${SUPPORT}/emails`)).toBe("mail:read");
		expect(requiredTokenScope("GET", `/api/v1/mailboxes/${SUPPORT}/rules`)).toBe("mail:read");
		expect(requiredTokenScope("POST", `/api/v1/mailboxes/${SUPPORT}/emails`)).toBe("mailbox");
		expect(requiredTokenScope("PUT", `/api/v1/mailboxes/${SUPPORT}`)).toBe("mailbox");
	});

	it("instance routes map to their scope", () => {
		expect(requiredTokenScope("GET", "/api/v1/me")).toBe("any");
		expect(requiredTokenScope("GET", "/api/v1/mailboxes")).toBe("any");
		expect(requiredTokenScope("POST", "/api/v1/mailboxes")).toBe("mailboxes:manage");
		expect(requiredTokenScope("DELETE", `/api/v1/mailboxes/${SUPPORT}`)).toBe("mailboxes:manage");
		expect(requiredTokenScope("GET", "/api/v1/people")).toBe("mail:read");
		expect(requiredTokenScope("POST", "/api/v1/templates")).toBe("mail:draft");
		expect(requiredTokenScope("POST", "/api/v1/sequences/s1/enroll")).toBe("mail:send");
		expect(requiredTokenScope("GET", "/api/v1/domains")).toBe("domains:manage");
		expect(requiredTokenScope("POST", "/api/v1/webhooks")).toBe("webhooks:manage");
		expect(requiredTokenScope("PUT", "/api/v1/branding")).toBe("admin");
		expect(requiredTokenScope("GET", "/api/v1/access")).toBe("admin");
	});

	it("domain routes and alias writes need domains:manage; alias reads need mail:read", () => {
		for (const [m, p] of [
			["GET", "/api/v1/domains"],
			["POST", "/api/v1/domains"],
			["PATCH", "/api/v1/domains/d1"],
			["DELETE", "/api/v1/domains/d1"],
			["POST", "/api/v1/domains/d1/verify"],
			["POST", "/api/v1/domains/d1/provision"],
			["PUT", `/api/v1/mailboxes/${SUPPORT}/aliases`],
		]) {
			expect({ m, p, s: requiredTokenScope(m, p) }).toEqual({ m, p, s: "domains:manage" });
		}
		expect(requiredTokenScope("GET", `/api/v1/mailboxes/${SUPPORT}/aliases`)).toBe("mail:read");
	});

	it("fails closed for routes it does not know", () => {
		expect(requiredTokenScope("GET", "/api/v1/something-new")).toBe("admin");
		expect(requiredTokenScope("POST", "/api/v1/_migrate/mailboxes/x")).toBe("admin");
	});
});
