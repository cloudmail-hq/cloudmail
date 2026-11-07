// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Which principal an MCP request acts as, and whose session it may use.
 *
 * The agents SDK applies `props` to an `McpAgent` only in `onStart`, i.e. once
 * per instance lifetime, and addresses the instance purely by the client-sent
 * `mcp-session-id`. Left alone, that meant a session kept the authority it was
 * started with after the grant was narrowed or the user disabled, and any
 * authenticated caller holding another user's session id acted as that user.
 *
 * `EmailMCP` now reads the principal resolved for the *current* request from a
 * Worker-set header and refuses it unless its identity matches the one the
 * session was bound to at creation. These tests cover that pure decision; the
 * `McpAgent` base class needs a Durable Object runtime, so it is mocked out.
 */

import { describe, expect, it, vi } from "vitest";
import type { AccessIdentity, Principal } from "../workers/lib/authz";

vi.mock("agents/mcp", () => ({ McpAgent: class {} }));

const {
	MCP_PRINCIPAL_HEADER,
	decodeMcpPrincipal,
	encodeMcpPrincipal,
	sameSessionBinding,
	selectCallerPrincipal,
	sessionBindingOf,
} = await import("../workers/mcp/index");

const SUPPORT = "support@tapetide.com";
const SALES = "sales@tapetide.com";

function identity(id = "alice@tapetide.com", subject: string | null = "uuid-alice"): AccessIdentity {
	return { kind: "user", id, subject };
}

function member(
	who: AccessIdentity = identity(),
	access: Array<{ id: string; role: string }> = [{ id: SUPPORT, role: "owner" }],
): Principal {
	return {
		identity: who,
		role: "member",
		mailboxes: access.map((a) => a.id),
		access: access as never,
		enforced: true,
		developmentBypass: false,
	};
}

function admin(who: AccessIdentity = identity()): Principal {
	return {
		identity: who,
		role: "admin",
		mailboxes: null,
		access: null,
		enforced: true,
		developmentBypass: false,
	};
}

describe("MCP principal header", () => {
	it("is lower-case, as the SDK's requestInfo headers are keyed", () => {
		expect(MCP_PRINCIPAL_HEADER).toBe(MCP_PRINCIPAL_HEADER.toLowerCase());
	});

	it("round-trips a principal, including non-ASCII addresses", () => {
		const p = member(identity("zoë@tapetide.com"), [{ id: SUPPORT, role: "viewer" }]);
		const decoded = decodeMcpPrincipal(encodeMcpPrincipal(p), undefined);
		expect(decoded?.identity).toEqual({ kind: "user", id: "zoë@tapetide.com", subject: "uuid-alice" });
		expect(decoded?.access).toEqual([{ id: SUPPORT, role: "viewer" }]);
		expect(decoded?.role).toBe("member");
	});

	it("produces a header-safe value", () => {
		const value = encodeMcpPrincipal(member(identity("zoë@tapetide.com")));
		expect(() => new Headers({ [MCP_PRINCIPAL_HEADER]: value })).not.toThrow();
	});

	it("rejects absent, empty, duplicated or malformed values", () => {
		expect(decodeMcpPrincipal(undefined, undefined)).toBeNull();
		expect(decodeMcpPrincipal(null, undefined)).toBeNull();
		expect(decodeMcpPrincipal("", undefined)).toBeNull();
		const v = encodeMcpPrincipal(member());
		expect(decodeMcpPrincipal([v, v], undefined)).toBeNull();
		expect(decodeMcpPrincipal("%E0%A4%A", undefined)).toBeNull();
		expect(decodeMcpPrincipal("not-json", undefined)).toBeNull();
		expect(decodeMcpPrincipal(encodeURIComponent("[1,2]"), undefined)).toBeNull();
		expect(decodeMcpPrincipal(encodeURIComponent("null"), undefined)).toBeNull();
	});

	it("cannot be used by a member to claim every mailbox", () => {
		const forged = { ...member(), mailboxes: null, access: null };
		const decoded = decodeMcpPrincipal(encodeURIComponent(JSON.stringify(forged)), undefined);
		expect(decoded?.mailboxes).toEqual([]);
		expect(decoded?.access).toEqual([]);
	});
});

describe("sessionBindingOf / sameSessionBinding", () => {
	it("binds to kind, normalized id and subject", () => {
		expect(sessionBindingOf(member(identity("Alice@Tapetide.com ")))).toEqual({
			kind: "user",
			id: "alice@tapetide.com",
			subject: "uuid-alice",
		});
	});

	it("has no binding for a principal with no identity", () => {
		expect(sessionBindingOf({ ...member(), identity: null })).toBeNull();
	});

	it("matches the same caller regardless of role or grant", () => {
		const a = sessionBindingOf(admin());
		const b = sessionBindingOf(member(identity(), []));
		expect(sameSessionBinding(a, b)).toBe(true);
	});

	it("distinguishes a different address", () => {
		expect(
			sameSessionBinding(
				sessionBindingOf(member(identity("alice@tapetide.com"))),
				sessionBindingOf(member(identity("bob@tapetide.com"))),
			),
		).toBe(false);
	});

	it("distinguishes a re-created account under the same address", () => {
		expect(
			sameSessionBinding(
				sessionBindingOf(member(identity("alice@tapetide.com", "uuid-old"))),
				sessionBindingOf(member(identity("alice@tapetide.com", "uuid-new"))),
			),
		).toBe(false);
	});

	it("distinguishes a service token from a user with the same id", () => {
		expect(
			sameSessionBinding(
				{ kind: "user", id: "x", subject: null },
				{ kind: "service", id: "x", subject: null },
			),
		).toBe(false);
	});

	it("treats null only as equal to null", () => {
		expect(sameSessionBinding(null, null)).toBe(true);
		expect(sameSessionBinding(null, sessionBindingOf(member()))).toBe(false);
		expect(sameSessionBinding(sessionBindingOf(member()), null)).toBe(false);
	});
});

describe("selectCallerPrincipal", () => {
	const aliceBinding = sessionBindingOf(member());

	it("uses the current request's principal, not the one the session started with", () => {
		// Session opened while Alice was an admin; she has since been narrowed to viewer.
		const narrowed = member(identity(), [{ id: SUPPORT, role: "viewer" }]);
		const verdict = selectCallerPrincipal({
			header: encodeMcpPrincipal(narrowed),
			bound: sessionBindingOf(admin()),
			adminEmailsRaw: undefined,
		});
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) return;
		expect(verdict.principal.role).toBe("member");
		expect(verdict.principal.access).toEqual([{ id: SUPPORT, role: "viewer" }]);
	});

	it("applies a revoked grant immediately", () => {
		const revoked = member(identity(), []);
		const verdict = selectCallerPrincipal({
			header: encodeMcpPrincipal(revoked),
			bound: aliceBinding,
			adminEmailsRaw: undefined,
		});
		expect(verdict.ok && verdict.principal.mailboxes).toEqual([]);
	});

	it("refuses another authenticated user presenting this session's id", () => {
		const bob = admin(identity("bob@tapetide.com", "uuid-bob"));
		const verdict = selectCallerPrincipal({
			header: encodeMcpPrincipal(bob),
			bound: aliceBinding,
			adminEmailsRaw: undefined,
		});
		expect(verdict).toMatchObject({ ok: false, reason: "mismatch" });
	});

	it("refuses an identified caller on a session bound to no identity", () => {
		const verdict = selectCallerPrincipal({
			header: encodeMcpPrincipal(member(identity(), [{ id: SALES, role: "owner" }])),
			bound: null,
			adminEmailsRaw: undefined,
		});
		expect(verdict).toMatchObject({ ok: false, reason: "mismatch" });
	});

	it("refuses an anonymous caller on a session bound to someone", () => {
		const verdict = selectCallerPrincipal({
			header: encodeMcpPrincipal({ ...member(), identity: null }),
			bound: aliceBinding,
			adminEmailsRaw: undefined,
		});
		expect(verdict).toMatchObject({ ok: false, reason: "mismatch" });
	});

	it("refuses a request with no principal header at all", () => {
		const verdict = selectCallerPrincipal({
			header: undefined,
			bound: aliceBinding,
			adminEmailsRaw: undefined,
		});
		expect(verdict).toMatchObject({ ok: false, reason: "missing" });
	});

	it("refuses every caller on a legacy, unbound session", () => {
		const verdict = selectCallerPrincipal({
			header: encodeMcpPrincipal(member()),
			bound: null,
			legacy: true,
			adminEmailsRaw: undefined,
		});
		expect(verdict).toMatchObject({ ok: false, reason: "mismatch" });
	});

	it("allows an unidentified caller on an unidentified session (unenforced/dev)", () => {
		const anon: Principal = { ...admin(), identity: null, enforced: false, developmentBypass: true };
		const verdict = selectCallerPrincipal({
			header: encodeMcpPrincipal(anon),
			bound: null,
			adminEmailsRaw: undefined,
		});
		expect(verdict.ok).toBe(true);
	});
});

describe("arrivedViaAgentRouter", () => {
	it("flags requests forwarded by routeAgentRequest", async () => {
		const { arrivedViaAgentRouter } = await import("../workers/mcp/index");
		const routed = new Request("https://x/agents/email-mcp/streamable-http:abc", {
			headers: { "x-partykit-namespace": "email-mcp" },
		});
		expect(arrivedViaAgentRouter(routed)).toBe(true);
		expect(arrivedViaAgentRouter(new Request("https://x/mcp"))).toBe(false);
	});
});

describe("scoped API tokens over MCP", () => {
	it("the principal header carries the token restriction, and the agent re-applies it", async () => {
		const { applyTokenRestriction, canAccessMailbox, canDo, sendAttributionFor } = await import(
			"../workers/lib/authz"
		);
		const scoped = applyTokenRestriction(admin(), { id: "tok", scopes: ["mail:read"], mailboxes: [SUPPORT] });
		const verdict = selectCallerPrincipal({
			header: encodeMcpPrincipal(scoped),
			bound: sessionBindingOf(scoped),
			legacy: false,
			adminEmailsRaw: "",
			forceEnforced: true,
		});
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) return;
		const p = verdict.principal;
		expect(canAccessMailbox(p, SUPPORT)).toBe(true);
		expect(canAccessMailbox(p, SALES)).toBe(false);
		expect(canDo(p, SUPPORT, "read")).toBe(true);
		// send_email / send_reply / delete_email / move_email are all refused.
		expect(sendAttributionFor(p, SUPPORT)).toBeNull();
		expect(canDo(p, SUPPORT, "delete")).toBe(false);
		expect(canDo(p, SUPPORT, "organise")).toBe(false);
	});

	it("an unscoped token's header is unchanged from before scopes existed", async () => {
		const { applyTokenRestriction } = await import("../workers/lib/authz");
		const p = admin();
		expect(encodeMcpPrincipal(applyTokenRestriction(p, { id: "tok", scopes: null, mailboxes: null }))).toBe(
			encodeMcpPrincipal(p),
		);
	});
});
