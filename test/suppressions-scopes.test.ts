// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Who may read and change the suppression list, and send templates, under
 * scoped API tokens. Writes are an admin area (`mailboxes:manage` or `admin`);
 * reads need `mail:read`; template sends need `sendAs`, which a token reaches
 * only through `mail:send`.
 */

import { describe, expect, it } from "vitest";
import {
	applyTokenRestriction,
	canDo,
	decidePrincipal,
	isAdminFor,
	type Principal,
} from "../workers/lib/authz";
import { requiredTokenScope, tokenScopeDecision } from "../workers/lib/token-scope-guard";
import type { TokenScope } from "../shared/token-scopes";

const ADMIN = "owner@example.com";
const BOX = "hello@product.dev";

function admin(): Principal {
	return decidePrincipal({ adminEmails: [ADMIN], identity: { kind: "user", id: ADMIN, subject: null } });
}

const scoped = (scopes: TokenScope[]) => applyTokenRestriction(admin(), { id: "t", scopes, mailboxes: null });

describe("suppression routes and token scopes", () => {
	it("maps reads to mail:read and writes to mailboxes:manage", () => {
		expect(requiredTokenScope("GET", "/api/v1/suppressions")).toBe("mail:read");
		expect(requiredTokenScope("POST", "/api/v1/suppressions/check")).toBe("mail:read");
		expect(requiredTokenScope("POST", "/api/v1/suppressions")).toBe("mailboxes:manage");
		expect(requiredTokenScope("POST", "/api/v1/suppressions/import")).toBe("mailboxes:manage");
		expect(requiredTokenScope("DELETE", "/api/v1/suppressions/sup_1")).toBe("mailboxes:manage");
		// Decided by the sendAs capability gate.
		expect(requiredTokenScope("POST", `/api/v1/mailboxes/${BOX}/template-sends`)).toBe("mailbox");
	});

	it("lets mailboxes:manage or admin write, and nothing narrower", () => {
		const write = (p: Principal) => tokenScopeDecision(p, "POST", "/api/v1/suppressions");
		expect(write(scoped(["mailboxes:manage"]))).toBeNull();
		expect(write(scoped(["admin"]))).toBeNull();
		expect(write(scoped(["mail:read", "mail:send"]))).toBe("mailboxes:manage");
		expect(isAdminFor(scoped(["admin"]), "mailboxes:manage")).toBe(true);
		expect(isAdminFor(scoped(["mail:send"]), "mailboxes:manage")).toBe(false);
	});

	it("lets a mail:read token list and check but not write", () => {
		const p = scoped(["mail:read"]);
		expect(tokenScopeDecision(p, "GET", "/api/v1/suppressions")).toBeNull();
		expect(tokenScopeDecision(p, "POST", "/api/v1/suppressions/check")).toBeNull();
		expect(tokenScopeDecision(p, "DELETE", "/api/v1/suppressions/x")).toBe("mailboxes:manage");
	});

	it("needs mail:send for template sends", () => {
		expect(canDo(scoped(["mail:send"]), BOX, "sendAs")).toBe(true);
		expect(canDo(scoped(["mail:read", "mailboxes:manage"]), BOX, "sendAs")).toBe(false);
	});
});
