/**
 * The service worker never touches mail or auth, and `public/sw.js` agrees with
 * `shared/sw-policy.ts`.
 *
 * The worker is a static file and cannot import the TypeScript module, so it
 * carries its own copy of the routing rules. This evaluates the real file in a
 * sandbox with stub worker globals and checks every case against the module,
 * so the two cannot drift.
 */

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { isCacheableShell, swStrategy } from "../shared/sw-policy";
import { safeNotificationUrl } from "../shared/push-policy";

const ORIGIN = "https://mailer.example.com";

function loadWorker() {
	const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
	const listeners: Record<string, unknown> = {};
	const hook: Record<string, unknown> = {};
	const sandbox = {
		self: {
			addEventListener: (type: string, fn: unknown) => {
				listeners[type] = fn;
			},
			location: { origin: ORIGIN },
			skipWaiting: () => {},
			clients: { claim: async () => {} },
		},
		caches: {},
		URL,
		globalThis: { __TT_SW_TEST__: hook },
	};
	runInNewContext(source, sandbox);
	return {
		listeners,
		strategy: hook.strategy as (r: { method: string; url: string; mode?: string }, o: string) => string,
		isCacheableShell: hook.isCacheableShell as (r: unknown) => boolean,
		safeNotificationUrl: hook.safeNotificationUrl as (raw: unknown, origin: string) => string,
		notificationFor: hook.notificationFor as (p: unknown) => { title: string; options: any },
	};
}

const CASES: { method: string; path: string; mode?: string; expected: string }[] = [
	// Mail, auth and protocols: never intercepted.
	{ method: "GET", path: "/api/v1/mailboxes", expected: "bypass" },
	{ method: "GET", path: "/api/auth/state", expected: "bypass" },
	{ method: "GET", path: "/api", expected: "bypass" },
	{ method: "GET", path: "/api/v1/mailboxes/a@b.c/emails", mode: "navigate", expected: "bypass" },
	{ method: "GET", path: "/mcp", expected: "bypass" },
	{ method: "GET", path: "/oauth/authorize", mode: "navigate", expected: "bypass" },
	{ method: "GET", path: "/agents/email-agent/x", expected: "bypass" },
	{ method: "GET", path: "/cdn-cgi/access/logout", mode: "navigate", expected: "bypass" },
	{ method: "GET", path: "/.well-known/oauth-authorization-server", expected: "bypass" },
	// React Router data requests carry the same content as the API.
	{ method: "GET", path: "/mail/a@b.c/inbox.data", expected: "bypass" },
	{ method: "GET", path: "/__manifest", expected: "bypass" },
	// Never anything but GET.
	{ method: "POST", path: "/assets/app-abc.js", expected: "bypass" },
	{ method: "POST", path: "/", mode: "navigate", expected: "bypass" },
	// A prefix match is a path segment, not a string prefix.
	{ method: "GET", path: "/apiary", mode: "navigate", expected: "navigate" },
	// Pages and hashed assets.
	{ method: "GET", path: "/", mode: "navigate", expected: "navigate" },
	{ method: "GET", path: "/mail/a@b.c/inbox", mode: "navigate", expected: "navigate" },
	{ method: "GET", path: "/assets/root-Bx12.js", expected: "cache-first" },
	{ method: "GET", path: "/assets/index-9f.css", expected: "cache-first" },
	// Unhashed files are left to HTTP caching.
	{ method: "GET", path: "/manifest.webmanifest", expected: "bypass" },
	{ method: "GET", path: "/icon-192.png", expected: "bypass" },
];

describe("service worker routing", () => {
	const worker = loadWorker();

	it("registers install, activate, fetch, message and push handlers", () => {
		for (const type of ["install", "activate", "fetch", "message", "push", "notificationclick", "pushsubscriptionchange"]) {
			expect(typeof worker.listeners[type]).toBe("function");
		}
	});

	for (const c of CASES) {
		it(`${c.method} ${c.path}${c.mode ? ` (${c.mode})` : ""} -> ${c.expected}`, () => {
			const request = { method: c.method, url: ORIGIN + c.path, mode: c.mode };
			expect(swStrategy({ ...request, origin: ORIGIN })).toBe(c.expected);
			expect(worker.strategy(request, ORIGIN)).toBe(c.expected);
		});
	}

	it("ignores other origins (fonts, Turnstile)", () => {
		const request = { method: "GET", url: "https://fonts.gstatic.com/x.woff2", mode: "cors" };
		expect(swStrategy({ ...request, origin: ORIGIN })).toBe("bypass");
		expect(worker.strategy(request, ORIGIN)).toBe("bypass");
	});
});

describe("app shell caching", () => {
	const worker = loadWorker();
	const response = (over: Partial<{ status: number; redirected: boolean; type: string; contentType: string }>) => {
		const r = { status: 200, redirected: false, type: "basic", contentType: "text/html; charset=utf-8", ...over };
		return {
			plain: r,
			fetchLike: { ...r, headers: { get: () => r.contentType } },
		};
	};

	const cases: [string, ReturnType<typeof response>, boolean][] = [
		["a 200 HTML page", response({}), true],
		// The sign-in bounce must never become the offline shell.
		["a redirected page", response({ redirected: true }), false],
		["an error page", response({ status: 500 }), false],
		["a 404", response({ status: 404 }), false],
		["an opaque response", response({ type: "opaque" }), false],
		["JSON", response({ contentType: "application/json" }), false],
	];

	for (const [name, r, expected] of cases) {
		it(`${expected ? "caches" : "does not cache"} ${name}`, () => {
			expect(isCacheableShell(r.plain)).toBe(expected);
			expect(worker.isCacheableShell(r.fetchLike)).toBe(expected);
		});
	}
});

describe("push notifications", () => {
	const worker = loadWorker();

	it("click targets agree with shared/push-policy", () => {
		for (const raw of ["/mail/a%40b.c/inbox?m=1", "/settings/notifications", "https://evil.example/", "//evil.example", "javascript:alert(1)", "", 42, undefined]) {
			expect(worker.safeNotificationUrl(raw, ORIGIN)).toBe(safeNotificationUrl(raw, ORIGIN));
		}
	});

	it("shows the payload, keeps action tokens in data, and drops unknown actions", () => {
		const n = worker.notificationFor({
			title: "Ada",
			body: "Hello",
			tag: "mail:x:t",
			url: "/mail/x/inbox?m=1",
			actions: [
				{ action: "archive", title: "Archive", token: "tok-a" },
				{ action: "read", title: "Mark read", token: "tok-r" },
				{ action: "delete", title: "Delete", token: "tok-d" },
			],
		});
		expect(n.title).toBe("Ada");
		expect(n.options.body).toBe("Hello");
		expect(n.options.tag).toBe("mail:x:t");
		expect(n.options.data.url).toBe("/mail/x/inbox?m=1");
		expect(n.options.data.tokens).toEqual({ archive: "tok-a", read: "tok-r" });
		expect(n.options.actions.map((a: { action: string }) => a.action)).toEqual(["archive", "read"]);
	});

	it("falls back to a generic notification for an empty or odd payload", () => {
		const n = worker.notificationFor(null);
		expect(n.title).toBe("cloudmail");
		expect(n.options.data.url).toBe("/");
		expect(n.options.actions).toEqual([]);
		expect(worker.notificationFor({ url: "https://evil.example" }).options.data.url).toBe("/");
	});
});

describe("registration", () => {
	it("is production-only, so dev never serves stale modules", () => {
		const root = readFileSync(new URL("../app/root.tsx", import.meta.url), "utf8");
		expect(root).toMatch(/if \(import\.meta\.env\.PROD\) registerServiceWorker\(\)/);
	});

	it("clears the worker's caches on sign-out", () => {
		const auth = readFileSync(new URL("../app/queries/auth.ts", import.meta.url), "utf8");
		expect(auth).toContain("clearServiceWorkerCaches()");
	});
});
