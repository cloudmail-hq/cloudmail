/**
 * Templates and sequences are shared by every mailbox, and a sequence step
 * loads its template when it sends, as the enrolment's mailbox. Before this
 * test, any signed-in member could rewrite or delete either, so a viewer of
 * `support@` could change what an administrator's `ceo@` sequence sends next.
 * Writes are administrator-only; reading stays open to members, who send with
 * templates and enrol people from mailboxes they can send from.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { app } from "../workers/index";
import type { Env } from "../workers/types";

const ADMIN = "owner@tapetide.com";
const MEMBER = "member@tapetide.com";
const SUPPORT = "support@tapetide.com";

const TEMPLATE = { id: "t1", slug: "welcome", name: "Welcome", subject: "Hi", bodyHtml: "<p>Hi</p>", createdAt: 1, updatedAt: 1 };
const SEQUENCE = { id: "seq1", name: "Onboarding", steps: [{ order: 1, templateSlug: "welcome", delayHours: 0 }], createdAt: 1, updatedAt: 1 };

function fakeBucket(initial: Record<string, unknown>) {
	const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
	return {
		async head(key: string) {
			return store.has(key) ? { key } : null;
		},
		async get(key: string) {
			const raw = store.get(key);
			return raw === undefined ? null : { json: async () => JSON.parse(raw), text: async () => raw };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string | string[]) {
			for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
		},
		async list({ prefix = "" }: { prefix?: string } = {}) {
			return {
				objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
				truncated: false as const,
			};
		},
		store,
	};
}

function build(identity: string) {
	const bucket = fakeBucket({
		[`mailboxes/${SUPPORT}.json`]: {},
		// A member who owns support@ outright (what an invite grants).
		[`access/users/${MEMBER}.json`]: { id: MEMBER, role: "member", mailboxes: [SUPPORT] },
		"templates/welcome.json": TEMPLATE,
		"sequences/seq1.json": SEQUENCE,
	});
	const env = {
		AUTH_MODE: "access",
		ADMIN_EMAILS: ADMIN,
		DOMAINS: "tapetide.com",
		BUCKET: bucket,
		MAILBOX: { idFromName: (n: string) => ({ n }), get: () => ({}) },
	} as unknown as Env;
	const outer = new Hono();
	outer.use("*", async (c, next) => {
		c.set("accessIdentity" as never, { kind: "user", id: identity, subject: "s" } as never);
		return next();
	});
	outer.route("/", app);
	const request = (path: string, init: RequestInit = {}) =>
		outer.fetch(
			new Request(`https://mailer.tapetide.com${path}`, {
				...init,
				headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
			}),
			env,
			{ waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
		);
	return { request, bucket };
}

const newTemplate = JSON.stringify({ slug: "promo", name: "Promo", subject: "s", bodyHtml: "<p>x</p>" });
const changedTemplate = JSON.stringify({ subject: "Phish", bodyHtml: '<p><a href="https://evil.example">x</a></p>' });
const newSequence = JSON.stringify({ name: "Drip", steps: [{ order: 1, templateSlug: "welcome", delayHours: 0 }] });

describe("template and sequence writes", () => {
	it("a member can read templates and sequences", async () => {
		const { request } = build(MEMBER);
		expect((await request("/api/v1/templates")).status).toBe(200);
		expect((await request("/api/v1/templates/welcome")).status).toBe(200);
		expect((await request("/api/v1/sequences")).status).toBe(200);
		expect((await request("/api/v1/sequences/seq1")).status).toBe(200);
	});

	it("a member cannot create, change or delete a template", async () => {
		const { request, bucket } = build(MEMBER);
		expect((await request("/api/v1/templates", { method: "POST", body: newTemplate })).status).toBe(403);
		expect((await request("/api/v1/templates/welcome", { method: "PUT", body: changedTemplate })).status).toBe(403);
		expect((await request("/api/v1/templates/welcome", { method: "DELETE" })).status).toBe(403);
		expect(bucket.store.has("templates/promo.json")).toBe(false);
		expect(JSON.parse(bucket.store.get("templates/welcome.json")!)).toMatchObject({ subject: "Hi" });
	});

	it("a member cannot create, change or delete a sequence", async () => {
		const { request, bucket } = build(MEMBER);
		expect((await request("/api/v1/sequences", { method: "POST", body: newSequence })).status).toBe(403);
		expect((await request("/api/v1/sequences/seq1", { method: "PUT", body: newSequence })).status).toBe(403);
		expect((await request("/api/v1/sequences/seq1", { method: "DELETE" })).status).toBe(403);
		expect(bucket.store.has("sequences/seq1.json")).toBe(true);
		expect([...bucket.store.keys()].filter((k) => k.startsWith("sequences/"))).toEqual(["sequences/seq1.json"]);
	});

	it("an administrator can still change them", async () => {
		const { request, bucket } = build(ADMIN);
		expect((await request("/api/v1/templates", { method: "POST", body: newTemplate })).status).toBe(201);
		expect((await request("/api/v1/templates/welcome", { method: "PUT", body: JSON.stringify({ subject: "Hello" }) })).status).toBe(200);
		expect(JSON.parse(bucket.store.get("templates/welcome.json")!)).toMatchObject({ subject: "Hello" });
		expect((await request("/api/v1/sequences", { method: "POST", body: newSequence })).status).toBe(201);
		expect((await request("/api/v1/templates/promo", { method: "DELETE" })).status).toBe(200);
	});
});
