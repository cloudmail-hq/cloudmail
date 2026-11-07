// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Sequence enrollment is per-mailbox even though sequences are not.
 *
 * An enrollment's `fromAddress` decides which mailbox the cron sends its steps
 * as, so enrolling and unenrolling need a send capability on it, and listing
 * enrollments must not reveal those from mailboxes the caller cannot reach.
 * Before the security review of #101, enroll only checked that the mailbox was
 * reachable (so a viewer could schedule sends), and list / unenroll checked
 * nothing.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { app } from "../workers/index";
import type { Env } from "../workers/types";

const ADMIN = "owner@tapetide.com";
const VIEWER = "viewer@tapetide.com";
const AGENT = "agent@tapetide.com";
const SUPPORT = "support@tapetide.com";
const SALES = "sales@tapetide.com";

function fakeBucket(initial: Record<string, unknown>) {
	const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
	return {
		async head(key: string) {
			return store.has(key) ? { key } : null;
		},
		async get(key: string) {
			const raw = store.get(key);
			return raw === undefined ? null : { json: async () => JSON.parse(raw) };
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
		_store: store,
	};
}

const enrollment = (id: string, fromAddress: string) => ({
	id,
	sequenceId: "seq1",
	personId: `p-${id}`,
	personEmail: `${id}@example.org`,
	personName: null,
	fromAddress,
	status: "active",
	variables: {},
	enrolledAt: 1,
	cancelledAt: null,
});

function build(identity: string) {
	const bucket = fakeBucket({
		[`mailboxes/${SUPPORT}.json`]: {},
		[`mailboxes/${SALES}.json`]: {},
		[`access/users/${VIEWER}.json`]: { id: VIEWER, role: "member", mailboxes: [{ id: SUPPORT, role: "viewer" }] },
		[`access/users/${AGENT}.json`]: { id: AGENT, role: "member", mailboxes: [{ id: SUPPORT, role: "agent" }] },
		"sequences/seq1.json": { id: "seq1", name: "Onboarding", steps: [{ order: 1, templateSlug: "t", delayHours: 0 }] },
		"sequence-enrollments/e-support.json": enrollment("e-support", SUPPORT),
		"sequence-enrollments/e-sales.json": enrollment("e-sales", SALES),
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

const enrollBody = (fromAddress: string) =>
	JSON.stringify({ personId: "new", personEmail: "new@example.org", fromAddress });

describe("sequence enrollment authorization", () => {
	it("a viewer cannot enroll from a mailbox they can only read", async () => {
		const { request } = build(VIEWER);
		const res = await request("/api/v1/sequences/seq1/enroll", { method: "POST", body: enrollBody(SUPPORT) });
		expect(res.status).toBe(403);
	});

	it("a member cannot enroll from a mailbox outside their grant", async () => {
		const { request } = build(AGENT);
		const res = await request("/api/v1/sequences/seq1/enroll", { method: "POST", body: enrollBody(SALES) });
		expect(res.status).toBe(403);
	});

	it("an agent (sendOnBehalf) passes the authorization check", async () => {
		const { request } = build(AGENT);
		const res = await request("/api/v1/sequences/seq1/enroll", { method: "POST", body: enrollBody(SUPPORT) });
		expect(res.status).not.toBe(403);
	});

	it("lists only enrollments from reachable mailboxes", async () => {
		const { request } = build(VIEWER);
		const list = (await (await request("/api/v1/sequences/seq1/enrollments")).json()) as { id: string }[];
		expect(list.map((e) => e.id)).toEqual(["e-support"]);
		const all = (await (await build(ADMIN).request("/api/v1/sequences/seq1/enrollments")).json()) as { id: string }[];
		expect(all.map((e) => e.id).sort()).toEqual(["e-sales", "e-support"]);
	});

	it("unenrolling needs a send capability on the enrollment's mailbox", async () => {
		// Unreachable mailbox: looks like it does not exist.
		const agent = build(AGENT);
		expect((await agent.request("/api/v1/sequences/enrollments/e-sales", { method: "DELETE" })).status).toBe(404);
		// Reachable, read-only: refused.
		const viewer = build(VIEWER);
		expect((await viewer.request("/api/v1/sequences/enrollments/e-support", { method: "DELETE" })).status).toBe(403);
		// Reachable with send: allowed.
		expect((await agent.request("/api/v1/sequences/enrollments/e-support", { method: "DELETE" })).status).toBe(200);
	});

	it("the person enrollment lookup hides an enrollment from an unreachable mailbox", async () => {
		const { request } = build(VIEWER);
		const res = (await (await request("/api/v1/sequences/people/p-e-sales/enrollment")).json()) as {
			enrollment: unknown;
		};
		expect(res.enrollment).toBeNull();
	});
});
