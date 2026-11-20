// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Response hardening headers.
 *
 * The app served none of these: no CSP on the document, nothing to stop it being
 * framed, and MIME sniffing left to the browser. The only policy in the codebase
 * was inside the sandboxed email iframe, which protects the message body rather
 * than the application around it.
 *
 * The awkward constraint is that `EmailIframe` uses `srcdoc`, and a local-scheme
 * document inherits its parent's CSP — so the effective policy for a message body
 * is the *intersection* of the document policy and the iframe's own. Two features
 * die if this policy is too tight: the remote-image opt-in, which widens the
 * iframe's `img-src` to `https:`, and the iframe's inline height reporter. Both
 * are pinned below, because the failure mode is silent.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import {
	ATTACHMENT_CSP,
	BASE_SECURITY_HEADERS,
	DOCUMENT_CSP,
	isAttachmentPath,
	isHtmlResponse,
	securityHeadersFor,
	withSecurityHeaders,
} from "../workers/lib/security-headers";

/** Parse a policy string into directive -> sources. */
function directives(policy: string): Record<string, string[]> {
	const parsed: Record<string, string[]> = {};
	for (const part of policy.split(";")) {
		const [name, ...sources] = part.trim().split(/\s+/);
		if (name) parsed[name] = sources;
	}
	return parsed;
}

describe("static asset headers", () => {
	/**
	 * Static assets are served before the Worker runs, so `public/_headers` is
	 * the only way they get these headers. It must say exactly what the Worker
	 * says, or two responses from the same origin disagree.
	 */
	it("public/_headers repeats every base header, value for value", () => {
		const file = readFileSync(resolve(__dirname, "../public/_headers"), "utf8");
		const lines = file.split("\n").filter((l) => /^\s+[A-Za-z-]+:/.test(l));
		const declared = Object.fromEntries(
			lines.map((l) => {
				const [name, ...rest] = l.trim().split(":");
				return [name!.toLowerCase(), rest.join(":").trim()];
			}),
		);
		for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
			expect(declared[name.toLowerCase()], name).toBe(value);
		}
		expect(file).toMatch(/^\/\*$/m);
	});

	it("sends HSTS with includeSubDomains and without preload", () => {
		expect(BASE_SECURITY_HEADERS["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains");
	});
});

describe("document policy", () => {
	const csp = directives(DOCUMENT_CSP);

	it("defaults to same-origin only", () => {
		expect(csp["default-src"]).toEqual(["'self'"]);
	});

	it("refuses to be framed, and forbids plugins and base rewriting", () => {
		expect(csp["frame-ancestors"]).toEqual(["'none'"]);
		expect(csp["object-src"]).toEqual(["'none'"]);
		expect(csp["base-uri"]).toEqual(["'self'"]);
		expect(csp["form-action"]).toEqual(["'self'"]);
	});

	it("blocks script from other origins", () => {
		// The point of the policy, given inline cannot be forbidden yet.
		expect(csp["script-src"]).toContain("'self'");
		expect(csp["script-src"]).not.toContain("https:");
		expect(csp["script-src"]).not.toContain("*");
	});

	it("allows inline script, which SSR hydration and the iframe both need", () => {
		// React Router serves hydration state inline, and the email iframe's
		// height reporter inherits this policy. Removing this breaks first paint
		// and message sizing; it is a known limitation, not an oversight.
		expect(csp["script-src"]).toContain("'unsafe-inline'");
	});

	it("limits img-src to same-origin, since remote images arrive through the /img/ proxy", () => {
		// The iframe inherits this policy, so this is the backstop that stops a
		// remote image which escaped the proxy rewrite from loading at all.
		expect(csp["img-src"]).toEqual(["'self'", "data:", "blob:"]);
		expect(csp["img-src"]).not.toContain("https:");
		expect(csp["img-src"]).not.toContain("http:");
		expect(csp["img-src"]).not.toContain("*");
	});

	it("permits the srcdoc frame the reading pane creates", () => {
		expect(csp["frame-src"]).toContain("'self'");
		expect(csp["frame-src"]).toContain("data:");
		expect(csp["frame-src"]).toContain("blob:");
	});

	it("keeps connections same-origin, which covers the agent WebSocket", () => {
		// CSP3 'self' matches ws/wss on the same host, so the agent panel works
		// without opening this up to arbitrary wss: origins.
		expect(csp["connect-src"]).toEqual(["'self'"]);
	});
});

describe("base headers", () => {
	it("sends nosniff, no-referrer and a frame denial", () => {
		expect(BASE_SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
		// Paths carry mailbox addresses and message ids.
		expect(BASE_SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
		expect(BASE_SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
	});

	it("sets HSTS for a year without committing to preload", () => {
		const hsts = BASE_SECURITY_HEADERS["Strict-Transport-Security"]!;
		expect(hsts).toContain("max-age=31536000");
		// `preload` is a browser-vendor list entry that is hard to walk back.
		expect(hsts).not.toContain("preload");
	});
});

describe("securityHeadersFor", () => {
	it("adds the document policy to HTML", () => {
		const headers = securityHeadersFor({ contentType: "text/html; charset=utf-8" });
		expect(headers["Content-Security-Policy"]).toBe(DOCUMENT_CSP);
	});

	it("does not add a document policy to JSON", () => {
		// It would protect nothing there, and a policy on every API response is
		// noise that invites someone to loosen the real one.
		const headers = securityHeadersFor({ contentType: "application/json" });
		expect(headers["Content-Security-Policy"]).toBeUndefined();
		// The transport and sniffing protections still apply.
		expect(headers["X-Content-Type-Options"]).toBe("nosniff");
	});

	it("gives attachments a policy that permits nothing", () => {
		// Attacker-supplied bytes from our own origin.
		const headers = securityHeadersFor({
			contentType: "image/png",
			isAttachment: true,
		});
		expect(headers["Content-Security-Policy"]).toBe(ATTACHMENT_CSP);
		expect(headers["Content-Security-Policy"]).toContain("sandbox");
	});

	it("prefers the attachment policy over the document one", () => {
		// An HTML attachment is exactly the case that must not get the permissive
		// document policy.
		const headers = securityHeadersFor({
			contentType: "text/html",
			isAttachment: true,
		});
		expect(headers["Content-Security-Policy"]).toBe(ATTACHMENT_CSP);
	});
});

describe("isHtmlResponse", () => {
	it("matches text/html with or without parameters", () => {
		expect(isHtmlResponse("text/html")).toBe(true);
		expect(isHtmlResponse("text/html; charset=utf-8")).toBe(true);
		expect(isHtmlResponse("TEXT/HTML")).toBe(true);
	});

	it("does not match anything else", () => {
		expect(isHtmlResponse(null)).toBe(false);
		expect(isHtmlResponse("application/json")).toBe(false);
		// Not HTML, and must not inherit the permissive document policy.
		expect(isHtmlResponse("application/xhtml+xml")).toBe(false);
		expect(isHtmlResponse("image/svg+xml")).toBe(false);
	});
});

describe("isAttachmentPath", () => {
	it("matches the attachment download route", () => {
		expect(
			isAttachmentPath(
				"/api/v1/mailboxes/a@b.com/emails/msg-1/attachments/att-1",
			),
		).toBe(true);
	});

	it("does not match neighbouring routes", () => {
		for (const path of [
			"/api/v1/mailboxes/a@b.com/emails/msg-1",
			"/api/v1/mailboxes/a@b.com/emails",
			"/api/v1/branding/logo",
			"/mail/a@b.com/inbox",
			"/",
		]) {
			expect(isAttachmentPath(path), path).toBe(false);
		}
	});
});

describe("applied to responses", () => {
	/** The middleware as `workers/app.ts` mounts it. */
	function buildApp() {
		const app = new Hono();

		// The real middleware body, not a copy of it. An earlier version of this
		// test inlined the header loop, which is exactly why it missed that
		// mutating an immutable response throws.
		app.use("*", async (c, next) => {
			try {
				await next();
			} finally {
				if (c.res) c.res = withSecurityHeaders(c.res, c.req.url);
			}
		});

		app.get("/", (c) => c.html("<!DOCTYPE html><p>hi"));
		app.get("/api/v1/config", (c) => c.json({ ok: true }));
		app.get("/api/v1/mailboxes/:id/emails/:emailId/attachments/:attId", (c) =>
			c.body("bytes", 200, { "Content-Type": "image/png" }),
		);
		// A route that sets its own policy, to prove it is not overwritten.
		app.get("/custom", (c) =>
			c.body("x", 200, { "Content-Security-Policy": "default-src 'none'" }),
		);
		app.post("/blocked", (c) => c.json({ error: "nope" }, 403));
		// Stands in for `/mcp` and `/agents/*`, which return a Durable Object's
		// response verbatim. workerd marks those headers immutable.
		app.get("/mcp", () => immutableResponse('{"jsonrpc":"2.0"}'));
		app.get("/boom", () => {
			throw new Error("handler blew up");
		});

		return (path: string, init?: RequestInit) =>
			app.fetch(new Request(`https://mailer.tapetide.com${path}`, init));
	}

	/** A response whose headers reject mutation, as workerd's do. */
	function immutableResponse(body: string): Response {
		const res = new Response(body, {
			headers: { "Content-Type": "application/json" },
		});
		const guard = () => {
			throw new TypeError("Can't modify immutable headers.");
		};
		Object.defineProperty(res, "headers", {
			value: new Proxy(res.headers, {
				get(target, prop, receiver) {
					if (prop === "set" || prop === "append" || prop === "delete") {
						return guard;
					}
					const value = Reflect.get(target, prop, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}),
		});
		return res;
	}

	it("hardens the SSR document", async () => {
		const res = await buildApp()("/");

		expect(res.headers.get("content-security-policy")).toBe(DOCUMENT_CSP);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
	});

	it("hardens API responses without giving them a document policy", async () => {
		const res = await buildApp()("/api/v1/config");

		expect(res.headers.get("content-security-policy")).toBeNull();
		expect(res.headers.get("x-frame-options")).toBe("DENY");
	});

	it("locks down attachment downloads", async () => {
		const res = await buildApp()(
			"/api/v1/mailboxes/a@b.com/emails/msg-1/attachments/att-1",
		);

		expect(res.headers.get("content-security-policy")).toBe(ATTACHMENT_CSP);
	});

	it("does not overwrite a policy a route chose deliberately", async () => {
		const res = await buildApp()("/custom");
		expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
	});

	it("still hardens a refusal", async () => {
		// A 403 from the CSRF guard or the Access check is a response from this
		// origin like any other.
		const res = await buildApp()("/blocked", { method: "POST" });

		expect(res.status).toBe(403);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("hardens a Durable Object response instead of failing on it", async () => {
		// `/mcp` and `/agents/*` proxy the stub's response straight out, and its
		// headers are immutable. Setting them in place throws, which would turn
		// every MCP call into a 500.
		const res = await buildApp()("/mcp");

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('{"jsonrpc":"2.0"}');
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
	});

	it("leaves a WebSocket upgrade alone", () => {
		// The agent handshake. A 101 has no headers a client can read, and the
		// response object refuses mutation.
		const upgrade = { status: 101, webSocket: {}, headers: new Headers() };

		expect(
			withSecurityHeaders(
				upgrade as unknown as Response,
				"https://mailer.tapetide.com/agents/email-agent/a@b.com",
			),
		).toBe(upgrade);
	});
});
