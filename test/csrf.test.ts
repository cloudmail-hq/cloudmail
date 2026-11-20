// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cross-site request forgery defence.
 *
 * Cloudflare Access authenticates with a cookie, so every state-changing route
 * was forgeable from any page the reader visited while signed in. The app looked
 * protected because it installed `cors()` with an origin allowlist, but CORS
 * only withholds the *response* — the request still runs, which is all an
 * attacker needs when the goal is the side effect.
 *
 * Two things have to hold at once here, and they pull in opposite directions:
 * browsers must be held to same-origin for writes, and non-browser clients (MCP
 * over HTTP, the API, `curl`) must keep working. The tests below pin both, plus
 * the awkward middle cases.
 */

import { describe, expect, it } from "vitest";
import { checkCsrf } from "../workers/lib/csrf";

const TARGET = "https://mailer.tapetide.com/api/v1/mailboxes/a@b.com";

function req(
	method: string,
	headers: Record<string, string> = {},
	url = TARGET,
) {
	return {
		method,
		url,
		headers: {
			get: (name: string) => headers[name.toLowerCase()] ?? null,
		},
	};
}

describe("safe methods", () => {
	it("allows reads regardless of where they came from", () => {
		// A GET has no side effect to steal, and blocking them would break
		// legitimate embedding and prefetching.
		for (const method of ["GET", "HEAD", "OPTIONS"]) {
			expect(
				checkCsrf(req(method, { "sec-fetch-site": "cross-site" })).allowed,
			).toBe(true);
		}
	});

	it("is case-insensitive about the method", () => {
		expect(
			checkCsrf(req("get", { "sec-fetch-site": "cross-site" })).allowed,
		).toBe(true);
	});
});

describe("browser writes, judged by Sec-Fetch-Site", () => {
	it("allows the app's own requests", () => {
		expect(
			checkCsrf(req("POST", { "sec-fetch-site": "same-origin" })).allowed,
		).toBe(true);
	});

	it("allows a request the reader initiated directly", () => {
		// `none` means there was no initiator: a typed URL or a bookmark.
		expect(checkCsrf(req("POST", { "sec-fetch-site": "none" })).allowed).toBe(
			true,
		);
	});

	it("refuses a cross-site write", () => {
		const verdict = checkCsrf(req("POST", { "sec-fetch-site": "cross-site" }));
		expect(verdict.allowed).toBe(false);
		expect(verdict.reason).toContain("cross-site");
	});

	it("refuses a same-site write from a sibling subdomain", () => {
		// `same-site` would admit any subdomain of the zone, which on hosted DNS is
		// not a boundary the deployment controls.
		expect(
			checkCsrf(req("PUT", { "sec-fetch-site": "same-site" })).allowed,
		).toBe(false);
	});

	it("guards every state-changing method, not just POST", () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			expect(
				checkCsrf(req(method, { "sec-fetch-site": "cross-site" })).allowed,
			).toBe(false);
		}
	});

	it("refuses the forwarding-address change specifically", () => {
		// The highest-value target: one forged PUT redirects all future mail.
		const verdict = checkCsrf(
			req(
				"PUT",
				{ "sec-fetch-site": "cross-site", origin: "https://evil.example" },
				"https://mailer.tapetide.com/api/v1/mailboxes/a@b.com",
			),
		);
		expect(verdict.allowed).toBe(false);
	});

	it("refuses a cross-site call to the MCP endpoint", () => {
		// `/mcp` exposes send_email and delete_email, so it needs the same rule as
		// the REST API — which is why the guard is mounted on the outer app.
		expect(
			checkCsrf(
				req(
					"POST",
					{ "sec-fetch-site": "cross-site" },
					"https://mailer.tapetide.com/mcp",
				),
			).allowed,
		).toBe(false);
	});
});

describe("WebSocket handshakes", () => {
	/**
	 * A handshake is a GET, so the safe-method exemption used to wave it through,
	 * and WebSocket responses are not subject to CORS. That left `/agents/*`
	 * openable from any page the signed-in reader visited, giving an attacker a
	 * live channel to the agent's read and draft tools.
	 *
	 * Browsers do not send fetch metadata on handshakes but do always send
	 * `Origin`, which is what this leans on.
	 */
	const upgrade = (headers: Record<string, string> = {}) =>
		req("GET", { upgrade: "websocket", ...headers }, "https://mailer.tapetide.com/agents/chat");

	it("refuses a cross-origin upgrade", () => {
		const verdict = checkCsrf(upgrade({ origin: "https://evil.example" }));
		expect(verdict.allowed).toBe(false);
	});

	it("allows an upgrade from our own origin", () => {
		expect(
			checkCsrf(upgrade({ origin: "https://mailer.tapetide.com" })).allowed,
		).toBe(true);
	});

	it("is case-insensitive about the Upgrade value", () => {
		expect(
			checkCsrf(upgrade({ upgrade: "WebSocket", origin: "https://evil.example" }))
				.allowed,
		).toBe(false);
	});

	it("still allows a plain GET to the same path", () => {
		// Only the handshake is treated as state-changing; ordinary reads are not.
		expect(
			checkCsrf(
				req("GET", { origin: "https://evil.example" }, "https://mailer.tapetide.com/agents/chat"),
			).allowed,
		).toBe(true);
	});

	it("allows a non-browser upgrade that sends no Origin", () => {
		expect(checkCsrf(upgrade()).allowed).toBe(true);
	});
});

describe("clients without Sec-Fetch-Site", () => {
	it("allows a request with no Origin at all", () => {
		// MCP clients, curl, server-to-server. These supply their own credentials,
		// so there is no ambient cookie to abuse.
		expect(checkCsrf(req("POST")).allowed).toBe(true);
	});

	it("allows an Origin matching the target host", () => {
		expect(
			checkCsrf(req("POST", { origin: "https://mailer.tapetide.com" })).allowed,
		).toBe(true);
	});

	it("refuses an Origin from another host", () => {
		const verdict = checkCsrf(
			req("POST", { origin: "https://evil.example" }),
		);
		expect(verdict.allowed).toBe(false);
		expect(verdict.reason).toContain("does not match");
	});

	it("compares against the Host header when routing rewrote the URL", () => {
		// Behind a proxy the URL we see may not be the name the client used.
		expect(
			checkCsrf(
				req(
					"POST",
					{ origin: "https://mailer.tapetide.com", host: "mailer.tapetide.com" },
					"http://internal-worker.local/api/v1/mailboxes/a@b.com",
				),
			).allowed,
		).toBe(true);
	});

	it("refuses a malformed Origin rather than guessing", () => {
		const verdict = checkCsrf(req("POST", { origin: "not-a-url" }));
		expect(verdict.allowed).toBe(false);
		expect(verdict.reason).toContain("Malformed");
	});

	it("treats a port difference as a different origin", () => {
		expect(
			checkCsrf(req("POST", { origin: "https://mailer.tapetide.com:8443" }))
				.allowed,
		).toBe(false);
	});

	it("treats a subdomain as a different origin", () => {
		expect(
			checkCsrf(req("POST", { origin: "https://evil.mailer.tapetide.com" }))
				.allowed,
		).toBe(false);
	});

	it("prefers Sec-Fetch-Site over Origin when both are present", () => {
		// The header a script cannot set wins over the one it might influence.
		expect(
			checkCsrf(
				req("POST", {
					"sec-fetch-site": "cross-site",
					origin: "https://mailer.tapetide.com",
				}),
			).allowed,
		).toBe(false);
	});
});
