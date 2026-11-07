// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The OpenAPI document against the routes the Worker actually serves.
 *
 * The spec is hand-written, so the risk is drift: a route added without a spec
 * entry, or a spec entry for a route that was removed or renamed. Both are
 * caught by walking `app.routes`.
 *
 * `app.routes` lists middleware alongside handlers — `app.use` as method `ALL`,
 * and the path-scoped capability gates (`app.on([...], paths, requireCapability(...))`)
 * and inline `requireAdmin` / `requireCapability` as ordinary method entries.
 * Middleware is `(c, next)`; every route handler is `(c)`, so `handler.length < 2`
 * separates them.
 */

import { describe, expect, it } from "vitest";
import { app } from "../workers/index";
import {
	API_TOKEN_SCOPE_VALUES,
	openApiDocument,
	openApiOperations,
	type OperationObject,
	type SchemaObject,
} from "../workers/lib/openapi";
import { renderApiDocsHtml } from "../workers/lib/openapi-html";
import { requiredTokenScope } from "../workers/lib/token-scope-guard";

/** Nothing is tolerated: the spec route itself is mounted on the same app. */
const TOLERATED_ABSENT = new Set<string>();

const key = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

function appRouteKeys(): Set<string> {
	const keys = new Set<string>();
	for (const r of app.routes) {
		if (r.method === "ALL") continue;
		if (!r.path.startsWith("/api/v1")) continue;
		if (r.handler.length >= 2) continue; // middleware: (c, next)
		keys.add(key(r.method, r.path));
	}
	return keys;
}

function allOperations(): Array<{ method: string; path: string; op: OperationObject }> {
	const out: Array<{ method: string; path: string; op: OperationObject }> = [];
	for (const [path, item] of Object.entries(openApiDocument.paths)) {
		for (const [method, op] of Object.entries(item)) {
			out.push({ method, path, op: op as OperationObject });
		}
	}
	return out;
}

describe("route walk", () => {
	it("finds real handlers and excludes middleware", () => {
		const keys = appRouteKeys();
		// Sanity: the heuristic is not discarding everything, nor keeping gates.
		expect(keys.size).toBeGreaterThan(90);
		expect(keys.has("GET /api/v1/me")).toBe(true);
		// `app.on(["POST","PUT","DELETE"], ".../folders", gate)` registers a PUT
		// with no handler behind it; it must not count as a route.
		expect(keys.has("PUT /api/v1/mailboxes/:mailboxId/folders")).toBe(false);
		// Inline `requireAdmin` middleware is dropped, its handler kept.
		const branding = app.routes.filter((r) => r.method === "PUT" && r.path === "/api/v1/branding");
		expect(branding.map((r) => r.handler.length).sort()).toEqual([1, 2]);
	});
});

describe("OpenAPI document coverage", () => {
	it("documents every /api/v1 route the app serves", () => {
		const documented = new Set(openApiOperations().map((o) => key(o.method, o.path)));
		const missing = [...appRouteKeys()].filter((k) => !documented.has(k));
		expect(missing).toEqual([]);
	});

	it("documents no operation the app does not serve", () => {
		const served = appRouteKeys();
		const extra = openApiOperations()
			.map((o) => key(o.method, o.path))
			.filter((k) => !served.has(k) && !TOLERATED_ABSENT.has(k));
		expect(extra).toEqual([]);
	});

	it("openApiOperations lists each operation once, in Hono form", () => {
		const ops = openApiOperations();
		const keys = ops.map((o) => key(o.method, o.path));
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys.length).toBe(allOperations().length);
		for (const o of ops) {
			expect(o.method).toBe(o.method.toUpperCase());
			expect(o.path).not.toMatch(/[{}]/);
		}
	});
});

describe("OpenAPI document shape", () => {
	it("is OpenAPI 3.1.0", () => {
		expect(openApiDocument.openapi).toBe("3.1.0");
		expect(openApiDocument.servers).toEqual([{ url: "/" }]);
		expect(openApiDocument.security).toEqual([{ bearerAuth: [] }, { sessionCookie: [] }]);
	});

	it("serialises to JSON losslessly", () => {
		expect(JSON.parse(JSON.stringify(openApiDocument))).toEqual(openApiDocument);
	});

	it("has unique operationIds", () => {
		const ids = allOperations().map(({ op }) => op.operationId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("declares every path template parameter, and nothing more", () => {
		for (const { path, op, method } of allOperations()) {
			const inPath = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
			const declared = (op.parameters ?? [])
				.filter((p) => p.in === "path")
				.map((p) => p.name)
				.sort();
			expect(declared, `${method} ${path}`).toEqual(inPath);
			for (const p of (op.parameters ?? []).filter((p) => p.in === "path")) {
				expect(p.required, `${method} ${path} ${p.name}`).toBe(true);
			}
		}
	});

	it("tags every operation with a declared tag", () => {
		const tags = new Set(openApiDocument.tags.map((t) => t.name));
		for (const { op, method, path } of allOperations()) {
			expect(op.tags.length, `${method} ${path}`).toBe(1);
			expect(tags.has(op.tags[0]), `${method} ${path}: ${op.tags[0]}`).toBe(true);
		}
	});

	it("resolves every $ref", () => {
		const unresolved: string[] = [];
		const walk = (node: unknown): void => {
			if (Array.isArray(node)) return node.forEach(walk);
			if (!node || typeof node !== "object") return;
			const ref = (node as { $ref?: unknown }).$ref;
			if (typeof ref === "string") {
				const m = /^#\/components\/(schemas|responses)\/(.+)$/.exec(ref);
				const bucket = m ? (openApiDocument.components[m[1] as "schemas" | "responses"] as Record<string, unknown>) : undefined;
				if (!m || !bucket || !(m[2] in bucket)) unresolved.push(ref);
			}
			Object.values(node).forEach(walk);
		};
		walk(openApiDocument);
		expect(unresolved).toEqual([]);
	});

	it("describes the common error responses with the Error schema", () => {
		const errorSchema = openApiDocument.components.schemas.Error as SchemaObject;
		expect(errorSchema.properties?.error).toEqual({ type: "string" });
		for (const name of ["Unauthorized", "Forbidden", "NotFound"]) {
			const r = openApiDocument.components.responses[name];
			expect(r.content?.["application/json"].schema).toEqual({ $ref: "#/components/schemas/Error" });
		}
		for (const { op, method, path } of allOperations()) {
			if (op.security?.length === 0) continue;
			expect(op.responses["401"], `${method} ${path}`).toBeDefined();
			expect(op.responses["403"], `${method} ${path}`).toBeDefined();
		}
	});
});

describe("x-token-scope", () => {
	it("is set on every operation, from the allowed set", () => {
		for (const { op, method, path } of allOperations()) {
			expect(API_TOKEN_SCOPE_VALUES, `${method} ${path}`).toContain(op["x-token-scope"]);
		}
	});

	it("agrees with requiredTokenScope wherever the guard names a scope", () => {
		const disagreements: string[] = [];
		for (const { op, method, path } of allOperations()) {
			const concrete = path.replace(/\{[^}]+\}/g, "x");
			const guard = requiredTokenScope(method, concrete);
			if (guard === "mailbox") {
				// Decided by the capability gate, so the spec must name one.
				if (!op["x-mailbox-capability"]?.length) disagreements.push(`${method} ${path}: no capability`);
				continue;
			}
			if (guard !== op["x-token-scope"]) {
				disagreements.push(`${method} ${path}: spec ${op["x-token-scope"]}, guard ${guard}`);
			}
		}
		expect(disagreements).toEqual([]);
	});

	it("maps capability-gated routes to the matching mail scope", () => {
		const byId = Object.fromEntries(allOperations().map(({ op }) => [op.operationId, op]));
		expect(byId.sendEmail["x-token-scope"]).toBe("mail:send");
		expect(byId.saveDraft["x-token-scope"]).toBe("mail:draft");
		expect(byId.moveEmail["x-token-scope"]).toBe("mail:organize");
		expect(byId.deleteEmail["x-token-scope"]).toBe("mail:organize");
		expect(byId.emptyTrash["x-token-scope"]).toBe("mail:organize");
		expect(byId.createRule["x-token-scope"]).toBe("mailboxes:manage");
		expect(byId.updateMailbox["x-token-scope"]).toBe("mailboxes:manage");
		expect(byId.listEmails["x-token-scope"]).toBe("mail:read");
		expect(byId.getMailbox["x-token-scope"]).toBe("any");
		expect(byId.listMailboxes["x-token-scope"]).toBe("any");
		expect(byId.createMailbox["x-token-scope"]).toBe("mailboxes:manage");
		expect(byId.deleteMailbox["x-token-scope"]).toBe("mailboxes:manage");
		expect(byId.updateBranding["x-token-scope"]).toBe("admin");
		expect(byId.migrateMailbox["x-token-scope"]).toBe("admin");
		expect(byId.getOpenApiDocument["x-token-scope"]).toBe("any");
	});
});

describe("renderApiDocsHtml", () => {
	it("renders every operation and links the JSON spec", () => {
		const html = renderApiDocsHtml(openApiDocument);
		expect(html).toMatch(/^<!doctype html>/);
		expect(html).toContain('<html lang="en">');
		expect(html).toContain("<main");
		expect(html).toContain('href="/api/v1/openapi.json"');
		for (const { op } of allOperations()) expect(html).toContain(`id="${op.operationId}"`);
	});

	it("escapes document text and emits no script", () => {
		const doc = structuredClone(openApiDocument);
		const op = doc.paths["/api/v1/me"].get!;
		op.summary = `<script>alert("x")</script>`;
		op.description = `<img src=x onerror=alert(1)>`;
		const html = renderApiDocsHtml(doc);
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
	});

	it("renders backtick spans as code without unescaping them", () => {
		const doc = structuredClone(openApiDocument);
		doc.paths["/api/v1/me"].get!.description = "Send `Authorization: <b>x</b>` here";
		const html = renderApiDocsHtml(doc);
		expect(html).toContain("<code>Authorization: &lt;b&gt;x&lt;/b&gt;</code>");
		expect(html).not.toContain("<b>x</b>");
	});

	it("loads nothing external", () => {
		const html = renderApiDocsHtml(openApiDocument);
		expect(html).not.toMatch(/<(script|link|iframe)\b/i);
		expect(html).not.toMatch(/(src|href)="https?:/i);
	});
});
