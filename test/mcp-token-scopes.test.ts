// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Scoped API tokens across every MCP tool.
 *
 * MCP tools are not routed through the HTTP scope guard. They are narrowed by
 * the same authz functions every REST route uses: `verifyMailbox` →
 * `canAccessMailbox` / `canDo`, `readableMailboxes` → `visibleMailboxes` +
 * `canDo(read)`, `sendAttributionFor`, and `isAdminFor` for domain tools. Those
 * already intersect the user's grant with the token's scopes and mailboxes.
 *
 * What can still go wrong is a tool that skips all of them. So this test reads
 * each registration and requires a recognised gate, then checks what each
 * gated capability means for a scoped token, end to end through authz.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	applyTokenRestriction,
	canDo,
	decidePrincipal,
	hasTokenScope,
	isAdminFor,
	SCOPE_CAPABILITIES,
	sendAttributionFor,
	type Principal,
} from "../workers/lib/authz";
import type { MailboxCapability } from "../workers/lib/capabilities";
import type { TokenScope } from "../shared/token-scopes";
import { canManageEndpoint, canManageWebhooks } from "../workers/lib/webhooks";

vi.mock("agents/mcp", () => ({ McpAgent: class {} }));
const { BULK_TOOL_CAPABILITIES } = await import("../workers/lib/tools");
const { toolListDomains, toolGetDomainStatus, ADMIN_REQUIRED } = await import("../workers/lib/domain-tools");

const source = readFileSync(new URL("../workers/mcp/index.ts", import.meta.url), "utf8");

function registrations() {
	const starts = [...source.matchAll(/this\.server\.tool\(\s*"([a-z_]+)"/g)];
	return starts.map((m, i) => ({
		name: m[1]!,
		text: source.slice(m.index!, starts[i + 1]?.index ?? source.indexOf("this.server.prompt(")),
	}));
}

type Gate =
	| { kind: "capability"; capabilities: MailboxCapability[] }
	| { kind: "bulk" }
	| { kind: "readable" }
	| { kind: "scope"; scope: TokenScope }
	| { kind: "domainAdmin" }
	| { kind: "mailboxAdmin" }
	| { kind: "instanceAdmin" }
	| { kind: "webhooks" }
	| { kind: "listing" };

/** Which gate a tool's body uses. Unknown means ungated, which fails the test. */
function gateOf(text: string): Gate | null {
	if (/BULK_TOOL_CAPABILITIES\[/.test(text)) return { kind: "bulk" };
	const verify = /verifyMailbox\(\s*mailboxId,\s*(\[[^\]]+\]|"[a-zA-Z]+")/.exec(text);
	if (verify) {
		const capabilities = [...verify[1]!.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1] as MailboxCapability);
		return { kind: "capability", capabilities };
	}
	if (/isAdminFor\(who\.principal,\s*"domains:manage"\)/.test(text)) return { kind: "domainAdmin" };
	// Agent inbox tools: admin with mailboxes:manage (or admin) on a scoped token.
	if (/isAdminFor\(who\.principal,\s*"mailboxes:manage"\)/.test(text)) return { kind: "mailboxAdmin" };
	// Usage: admin with the admin scope.
	if (/isAdminFor\(who\.principal,\s*"admin"\)/.test(text)) return { kind: "instanceAdmin" };
	// Webhook tools: token needs webhooks:manage, see workers/lib/webhooks.ts.
	if (/canManage(Webhooks|Endpoint)\(who\.principal/.test(text)) return { kind: "webhooks" };
	const scope = /hasTokenScope\(who\.principal,\s*"([a-z:]+)"\)/.exec(text);
	if (scope) return { kind: "scope", scope: scope[1] as TokenScope };
	if (/readableMailboxes\(who\.principal/.test(text)) return { kind: "readable" };
	// list_mailboxes: filtered by visibleMailboxes and reports per-mailbox capabilities.
	if (/visibleMailboxes\(who\.principal/.test(text)) return { kind: "listing" };
	return null;
}

/** The token scopes that unlock any of these capabilities. */
function scopesFor(capabilities: MailboxCapability[]): TokenScope[] {
	return (Object.keys(SCOPE_CAPABILITIES) as TokenScope[]).filter((scope) =>
		SCOPE_CAPABILITIES[scope].some((cap) => capabilities.includes(cap)),
	);
}

const SUPPORT = "support@example.com";

function admin(): Principal {
	return decidePrincipal({ adminEmails: ["o@example.com"], identity: { kind: "user", id: "o@example.com", subject: null } });
}
function scoped(scopes: TokenScope[], mailboxes: string[] | null = null): Principal {
	return applyTokenRestriction(admin(), { id: "t", scopes, mailboxes });
}

describe("every MCP tool is gated by token-aware authz", () => {
	it("no tool reaches data without a recognised gate", () => {
		expect(registrations().length).toBeGreaterThanOrEqual(44);
		const ungated = registrations()
			.filter(({ text }) => gateOf(text) === null)
			.map(({ name }) => name);
		expect(ungated).toEqual([]);
	});

	it("the mail:send tools require a send capability, which only mail:send unlocks", () => {
		const byName = Object.fromEntries(registrations().map((r) => [r.name, gateOf(r.text)]));
		for (const tool of ["send_email", "send_reply", "forward_email", "schedule_send", "send_template", "cancel_scheduled"]) {
			const gate = byName[tool];
			expect({ tool, gate }).toEqual({ tool, gate: { kind: "capability", capabilities: ["sendAs", "sendOnBehalf"] } });
			expect(scopesFor(["sendAs", "sendOnBehalf"])).toEqual(["mail:send"]);
		}
	});

	it("bulk_update maps each action to a capability that its scope must unlock", () => {
		expect(gateOf(registrations().find((r) => r.name === "bulk_update")!.text)).toEqual({ kind: "bulk" });
		for (const [action, capability] of Object.entries(BULK_TOOL_CAPABILITIES)) {
			const scopes = scopesFor([capability as MailboxCapability]);
			expect({ action, scopes }).toEqual({ action, scopes: ["mail:organize"] });
			// A read-only or send-only token cannot run any bulk action.
			expect(canDo(scoped(["mail:read"]), SUPPORT, capability as MailboxCapability)).toBe(false);
			expect(canDo(scoped(["mail:send"]), SUPPORT, capability as MailboxCapability)).toBe(false);
			expect(canDo(scoped(["mail:organize"]), SUPPORT, capability as MailboxCapability)).toBe(true);
		}
	});

	it("the webhook tools need webhooks:manage, and a mailbox-limited token cannot hold an all-mailbox hook", () => {
		const byName = Object.fromEntries(registrations().map((r) => [r.name, gateOf(r.text)]));
		expect(byName.list_webhooks).toEqual({ kind: "webhooks" });
		expect(byName.test_webhook).toEqual({ kind: "webhooks" });
		expect(canManageWebhooks(scoped(["mail:read", "mail:send"]))).toBe(false);
		expect(canManageWebhooks(scoped(["webhooks:manage"]))).toBe(true);
		expect(canManageEndpoint(scoped(["webhooks:manage"]), null)).toBe(true);
		expect(canManageEndpoint(scoped(["webhooks:manage"], [SUPPORT]), null)).toBe(false);
		expect(canManageEndpoint(scoped(["webhooks:manage"], [SUPPORT]), [SUPPORT])).toBe(true);
	});

	it("every gated capability is unlocked by at least one scope (no tool is unreachable by scoped tokens)", () => {
		for (const { name, text } of registrations()) {
			const gate = gateOf(text);
			if (gate?.kind !== "capability") continue;
			expect({ name, scopes: scopesFor(gate.capabilities).length > 0 }).toEqual({ name, scopes: true });
		}
	});
});

describe("tool outcomes for scoped tokens", () => {
	it("a read-only token cannot send through any send tool path", () => {
		const p = scoped(["mail:read"]);
		expect(canDo(p, SUPPORT, "sendAs") || canDo(p, SUPPORT, "sendOnBehalf")).toBe(false);
		expect(sendAttributionFor(p, SUPPORT)).toBeNull();
	});

	it("a send-only token can send but not read, draft or organise", () => {
		const p = scoped(["mail:send"]);
		expect(sendAttributionFor(p, SUPPORT)).toEqual({ mode: "as" });
		for (const cap of ["read", "draft", "organise", "delete", "manageRules"] as const) {
			expect(canDo(p, SUPPORT, cap)).toBe(false);
		}
	});

	it("the mailbox allowlist blocks sending from other mailboxes", () => {
		const p = scoped(["mail:send"], [SUPPORT]);
		expect(canDo(p, "sales@example.com", "sendAs")).toBe(false);
	});

	it("list_templates needs mail:read", () => {
		expect(hasTokenScope(scoped(["mail:send"]), "mail:read")).toBe(false);
		expect(hasTokenScope(scoped(["mail:read"]), "mail:read")).toBe(true);
		expect(hasTokenScope(admin(), "mail:read")).toBe(true);
	});
});

describe("domain tools", () => {
	const env = {} as never;

	it("need an admin user and domains:manage or admin on the token", () => {
		expect(isAdminFor(admin(), "domains:manage")).toBe(true);
		expect(isAdminFor(scoped(["domains:manage"]), "domains:manage")).toBe(true);
		expect(isAdminFor(scoped(["admin"]), "domains:manage")).toBe(true);
		expect(isAdminFor(scoped(["mail:read"]), "domains:manage")).toBe(false);
		const member = decidePrincipal({
			adminEmails: ["o@example.com"],
			identity: { kind: "user", id: "m@example.com", subject: null },
		});
		expect(isAdminFor(applyTokenRestriction(member, { id: "t", scopes: ["domains:manage"], mailboxes: null }), "domains:manage")).toBe(false);
	});

	it("toolListDomains and toolGetDomainStatus refuse a token without domains:manage before touching storage", async () => {
		expect(await toolListDomains(env, scoped(["mail:read", "mail:send"]))).toEqual({ error: ADMIN_REQUIRED });
		expect(await toolGetDomainStatus(env, scoped(["mail:read"]), "example.com")).toEqual({ error: ADMIN_REQUIRED });
	});

	it("domain tool registrations use the scope-aware admin check", () => {
		for (const name of ["list_domains", "get_domain_status"]) {
			const reg = registrations().find((r) => r.name === name)!;
			expect(gateOf(reg.text)).toEqual({ kind: "domainAdmin" });
		}
	});
});
