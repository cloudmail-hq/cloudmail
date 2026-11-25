/**
 * Owners of a mailbox are peers. An owner-role delegate may share the mailbox
 * as viewer, agent or manager, but making, changing or removing an owner is
 * an administrator's call; otherwise one owner could lock out the person the
 * mailbox belongs to. Also: callers without `manageSettings` read the
 * owner-only settings (forwarding target, agent prompt, send allowlist)
 * blanked, and only administrators browse the suppression list.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { app } from "../workers/index";
import type { Env } from "../workers/types";

const ADMIN = "boss@tapetide.com";
const ALICE = "alice@tapetide.com";
const BOB = "bob@tapetide.com";
const VIEWER = "viewer@tapetide.com";
const SALES = "sales@tapetide.com";

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
			store.set(key, typeof value === "string" ? value : JSON.stringify(value));
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
		[`mailboxes/${SALES}.json`]: {
			fromName: "Sales",
			forwarding: { enabled: true, email: "private@example.org" },
			agentSystemPrompt: "secret instructions",
		},
		// Two owners (what an invite grants) and a viewer.
		[`access/users/${ALICE}.json`]: { id: ALICE, role: "member", mailboxes: [SALES] },
		[`access/users/${BOB}.json`]: { id: BOB, role: "member", mailboxes: [SALES] },
		[`access/users/${VIEWER}.json`]: { id: VIEWER, role: "member", mailboxes: [{ id: SALES, role: "viewer" }] },
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

const delegates = `/api/v1/mailboxes/${encodeURIComponent(SALES)}/delegates`;
const put = (id: string, role: string) => ({ method: "PUT", body: JSON.stringify({ kind: "user", id, role }) });

describe("mailbox owners are peers", () => {
	it("an owner cannot demote or remove another owner", async () => {
		const { request, bucket } = build(ALICE);
		const demote = await request(delegates, put(BOB, "viewer"));
		expect(demote.status).toBe(403);
		expect(await demote.json()).toMatchObject({ code: "owner_protected" });
		const remove = await request(`${delegates}/user/${encodeURIComponent(BOB)}`, { method: "DELETE" });
		expect(remove.status).toBe(403);
		expect(JSON.parse(bucket.store.get(`access/users/${BOB}.json`)!).mailboxes).toEqual([SALES]);
	});

	it("an owner cannot make someone an owner, but can share it in a lesser role and remove that", async () => {
		const { request } = build(ALICE);
		expect((await request(delegates, put("carol@tapetide.com", "owner"))).status).toBe(403);
		expect((await request(delegates, put("carol@tapetide.com", "agent"))).status).toBe(200);
		expect((await request(`${delegates}/user/${encodeURIComponent(VIEWER)}`, { method: "DELETE" })).status).toBe(204);
	});

	it("an owner cannot make an owner by another name (a manager with owner-only extras)", async () => {
		const { request, bucket } = build(ALICE);
		for (const extra of [["manageDelegates"], ["manageSettings"], ["manageSettings", "manageDelegates"]]) {
			const res = await request(delegates, {
				method: "PUT",
				body: JSON.stringify({ kind: "user", id: "carol@tapetide.com", role: "manager", extra }),
			});
			expect(res.status, extra.join("+")).toBe(403);
		}
		expect(bucket.store.has("access/users/carol@tapetide.com.json")).toBe(false);
	});

	it("an owner-level entry under another role name is protected like an owner", async () => {
		const { request, bucket } = build(ALICE);
		bucket.store.set(
			"access/users/dan@tapetide.com.json",
			JSON.stringify({ id: "dan@tapetide.com", role: "member", mailboxes: [{ id: SALES, role: "manager", extra: ["manageDelegates"] }] }),
		);
		expect((await request(`${delegates}/user/${encodeURIComponent("dan@tapetide.com")}`, { method: "DELETE" })).status).toBe(403);
		expect((await request(delegates, put("dan@tapetide.com", "viewer"))).status).toBe(403);
	});

	it("an owner may still remove themselves", async () => {
		const { request } = build(ALICE);
		expect((await request(`${delegates}/user/${encodeURIComponent(ALICE)}`, { method: "DELETE" })).status).toBe(204);
	});

	it("an administrator can change and remove owners", async () => {
		const { request } = build(ADMIN);
		expect((await request(delegates, put(BOB, "viewer"))).status).toBe(200);
		expect((await request(delegates, put("carol@tapetide.com", "owner"))).status).toBe(200);
		expect((await request(`${delegates}/user/${encodeURIComponent(ALICE)}`, { method: "DELETE" })).status).toBe(204);
	});
});

describe("owner-only settings and the suppression list", () => {
	it("a viewer reads the forwarding target and agent prompt blanked; an owner sees them", async () => {
		const asViewer = await (await build(VIEWER).request(`/api/v1/mailboxes/${encodeURIComponent(SALES)}`)).json() as {
			settings: { fromName: string; forwarding: { email: string; enabled: boolean }; agentSystemPrompt: string };
		};
		expect(asViewer.settings.fromName).toBe("Sales");
		expect(asViewer.settings.forwarding).toMatchObject({ enabled: true, email: "" });
		expect(asViewer.settings.agentSystemPrompt).toBe("");

		const asOwner = await (await build(ALICE).request(`/api/v1/mailboxes/${encodeURIComponent(SALES)}`)).json() as {
			settings: { forwarding: { email: string }; agentSystemPrompt: string };
		};
		expect(asOwner.settings.forwarding.email).toBe("private@example.org");
		expect(asOwner.settings.agentSystemPrompt).toBe("secret instructions");
	});

	it("only an administrator browses the suppression list", async () => {
		expect((await build(ALICE).request("/api/v1/suppressions")).status).toBe(403);
	});
});
