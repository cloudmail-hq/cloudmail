// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** `Server-Timing` on API responses, and the immutable cache rule for hashed assets. */

import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { serverTiming, timed, timedMiddleware } from "../workers/lib/server-timing";

function app() {
	const a = new Hono();
	a.use("*", serverTiming);
	a.use("*", timedMiddleware("auth", async (_c, next) => next()));
	a.get("/api/x", async (c) => {
		await timed(c, "do", async () => 1);
		return c.json({ ok: true });
	});
	a.get("/api/short", timedMiddleware("gate", async (c) => c.json({ no: true }, 403)));
	a.get("/page", (c) => c.text("hi"));
	return a;
}

describe("serverTiming", () => {
	it("reports each stage and the total on /api responses", async () => {
		const res = await app().fetch(new Request("https://x.test/api/x"));
		const header = res.headers.get("server-timing") ?? "";
		expect(header).toMatch(/auth;dur=\d+(\.\d)?/);
		expect(header).toMatch(/do;dur=/);
		expect(header).toMatch(/total;dur=/);
	});

	it("records a middleware that short-circuits", async () => {
		const res = await app().fetch(new Request("https://x.test/api/short"));
		expect(res.status).toBe(403);
		expect(res.headers.get("server-timing")).toMatch(/gate;dur=/);
	});

	it("leaves pages alone", async () => {
		const res = await app().fetch(new Request("https://x.test/page"));
		expect(res.headers.get("server-timing")).toBeNull();
	});
});

describe("public/_headers", () => {
	const rules = readFileSync(new URL("../public/_headers", import.meta.url), "utf8")
		.split("\n")
		.filter((l) => l.trim() && !l.trim().startsWith("#"));

	it("marks hashed build output immutable for a year", () => {
		const at = rules.findIndex((l) => l.trim() === "/assets/*");
		expect(at).toBeGreaterThanOrEqual(0);
		expect(rules[at + 1].trim()).toBe("Cache-Control: public, max-age=31536000, immutable");
	});

	it("does not touch HTML, the service worker or the manifest", () => {
		// Only `/assets/*` may be long-cached: those URLs change with every build.
		// Other blocks (the `/*` security headers) may exist but must not set a
		// cache policy, or the service worker and manifest would be pinned.
		const blocks: { path: string; headers: string[] }[] = [];
		for (const l of rules) {
			if (!/^\s/.test(l)) blocks.push({ path: l.trim(), headers: [] });
			else blocks.at(-1)?.headers.push(l.trim().toLowerCase());
		}
		const caching = blocks.filter((b) => b.headers.some((h) => h.startsWith("cache-control:")));
		expect(caching.map((b) => b.path)).toEqual(["/assets/*"]);
	});
});
