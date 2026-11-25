/** Group address API: admin-only, address and member validation, audit. */

import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { app } from "../workers/index";
import { groupDeps } from "../workers/routes/groups";
import type { MailGroup } from "../workers/lib/domain-store";
import type { Env } from "../workers/types";

const ADMIN = "boss@tapetide.com";
const MEMBER = "alice@tapetide.com";

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
			return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false as const };
		},
		store,
	};
}

const original = groupDeps.store;
afterEach(() => {
	groupDeps.store = original;
});

function build(identity: string) {
	const groups = new Map<string, MailGroup>();
	groupDeps.store = () => ({
		listGroups: async () => [...groups.values()],
		getGroup: async (a) => groups.get(a) ?? null,
		putGroup: async (input, now) => {
			const g = { address: input.address, name: input.name, members: input.members, createdAt: groups.get(input.address)?.createdAt ?? now, updatedAt: now };
			groups.set(input.address, g);
			return g;
		},
		deleteGroup: async (a) => groups.delete(a),
		allAliases: async () => ({ "hello@tapetide.com": "alice@tapetide.com" }),
	});
	const bucket = fakeBucket({
		"mailboxes/alice@tapetide.com.json": {},
		"mailboxes/bob@tapetide.com.json": {},
		[`access/users/${MEMBER}.json`]: { id: MEMBER, role: "member", mailboxes: ["alice@tapetide.com"] },
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
	return { request, groups };
}

const put = (members: string[], name = "") => ({ method: "PUT", body: JSON.stringify({ name, members }) });
const path = (a: string) => `/api/v1/groups/${encodeURIComponent(a)}`;

describe("group addresses API", () => {
	it("an administrator creates, updates, lists and deletes a group", async () => {
		const { request, groups } = build(ADMIN);
		const created = await request(path("Team@Tapetide.com"), put(["alice@tapetide.com", "BOB@tapetide.com"], "Team"));
		expect(created.status).toBe(201);
		expect(groups.get("team@tapetide.com")?.members).toEqual(["alice@tapetide.com", "bob@tapetide.com"]);
		expect((await request(path("team@tapetide.com"), put(["bob@tapetide.com"]))).status).toBe(200);
		const list = (await (await request("/api/v1/groups")).json()) as { groups: MailGroup[] };
		expect(list.groups.map((g) => g.address)).toEqual(["team@tapetide.com"]);
		expect((await request(path("team@tapetide.com"), { method: "DELETE" })).status).toBe(204);
		expect((await request(path("team@tapetide.com"), { method: "DELETE" })).status).toBe(404);
	});

	it("refuses a member", async () => {
		const { request } = build(MEMBER);
		expect((await request("/api/v1/groups")).status).toBe(403);
		expect((await request(path("team@tapetide.com"), put(["alice@tapetide.com"]))).status).toBe(403);
	});

	it("refuses an address that is a mailbox, an alias, or off this deployment's domains", async () => {
		const { request } = build(ADMIN);
		expect((await request(path("alice@tapetide.com"), put(["bob@tapetide.com"]))).status).toBe(409);
		expect((await request(path("hello@tapetide.com"), put(["bob@tapetide.com"]))).status).toBe(409);
		expect((await request(path("team@elsewhere.com"), put(["bob@tapetide.com"]))).status).toBe(400);
		expect((await request(path("not-an-address"), put(["bob@tapetide.com"]))).status).toBe(400);
	});

	it("refuses members that are not mailboxes here, and an empty list", async () => {
		const { request } = build(ADMIN);
		const res = await request(path("team@tapetide.com"), put(["alice@tapetide.com", "stranger@gmail.com"]));
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("stranger@gmail.com");
		expect((await request(path("team@tapetide.com"), put([]))).status).toBe(400);
	});
});
