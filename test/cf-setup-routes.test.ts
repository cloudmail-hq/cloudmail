/**
 * Discover, plan, apply and the change log (`workers/routes/cloudflare-setup.ts`)
 * against a stateful fake Cloudflare API (no network) and a real AuthStore,
 * DomainStore, CloudflareConnectionStore and DnsChangeLogStore on node:sqlite.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore, type AuthSql } from "../workers/auth/store-core";
import { CloudflareConnectionStore, sealCloudflareToken } from "../workers/lib/cf-connection-store";
import { cfConnectionDeps, invalidateCloudflareConnectionCache } from "../workers/lib/cf-connection";
import { countSpfLookups, invalidateDiscoveryCache, mapLimit } from "../workers/lib/cf-discovery";
import { DnsChangeLogStore } from "../workers/lib/dns-change-log";
import { DomainStore } from "../workers/lib/domain-store";
import { cloudflareRouteDeps } from "../workers/routes/cloudflare";
import { cloudflareSetupDeps, cloudflareSetupRoutes } from "../workers/routes/cloudflare-setup";
import type { MailboxContext } from "../workers/lib/mailbox";
import type { Env } from "../workers/types";
import type { CfPlanResponse, PlanItem } from "../shared/cf-setup";

const TOKEN = "fake-cf-token-0000000000000000000000LAST";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const Z1 = "11111111111111111111111111111111";
const Z2 = "22222222222222222222222222222222";
const Z3 = "33333333333333333333333333333333";
const FOREIGN = "99999999999999999999999999999999";
const SECRET = "route-test-secret-0123456789";
const T0 = Date.UTC(2026, 9, 29);

// -- a stateful fake Cloudflare ------------------------------------------------------

interface Rec { id: string; type: string; name: string; content: string; priority?: number; ttl?: number }
interface FakeZone {
	id: string;
	name: string;
	status: string;
	records: Rec[];
	routing: { enabled: boolean; status: string };
	catchAll: any | null;
	sending: { tag: string; name: string; enabled: boolean }[];
	sendingPlanError?: boolean;
}

class FakeCf {
	zones = new Map<string, FakeZone>();
	scripts: Record<string, { bindings: any[] }> = { "cloudmail": { bindings: [] } };
	vectorize: { exists: boolean; meta: string[] } = { exists: true, meta: [] };
	calls: { method: string; path: string; auth: string | null }[] = [];
	/** Extra SPF duplicate Cloudflare adds when enabling routing alongside an existing SPF. */
	addsDuplicateSpf = true;
	failNext: Record<string, number> = {};
	seq = 0;

	addZone(z: Partial<FakeZone> & { id: string; name: string }): FakeZone {
		const zone: FakeZone = {
			status: "active",
			records: [],
			routing: { enabled: false, status: "unconfigured" },
			catchAll: null,
			sending: [],
			...z,
		};
		this.zones.set(z.id, zone);
		return zone;
	}

	rec(zone: FakeZone, r: Omit<Rec, "id">): Rec {
		const full = { id: `r${++this.seq}`, ...r };
		zone.records.push(full);
		return full;
	}

	impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = new URL(String(input));
		const path = url.pathname.replace(/^\/client\/v4/, "");
		const method = (init.method ?? "GET").toUpperCase();
		this.calls.push({ method, path: path + url.search, auth: new Headers(init.headers).get("authorization") });
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
			new Response(JSON.stringify({ success: true, errors: [], result, ...extra }), { status: 200 });
		const err = (status: number, message: string, code = 1000) =>
			new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status });
		const key = `${method} ${path}`;
		if (this.failNext[key]) {
			this.failNext[key]--;
			return err(500, "boom");
		}

		if (method === "GET" && path === "/zones") {
			const page = Number(url.searchParams.get("page") ?? 1);
			const per = Number(url.searchParams.get("per_page") ?? 50);
			const all = [...this.zones.values()].map((z) => ({ id: z.id, name: z.name, status: z.status, account: { id: ACCOUNT } }));
			return ok(all.slice((page - 1) * per, page * per), { result_info: { total_count: all.length, page, per_page: per } });
		}
		let m = /^\/zones\/([^/]+)(\/.*)?$/.exec(path);
		if (m) {
			const zone = this.zones.get(m[1]!);
			if (!zone) return err(404, "zone not found", 1001);
			const sub = m[2] ?? "";
			if (sub === "" && method === "GET") return ok({ id: zone.id, name: zone.name, status: zone.status, account: { id: ACCOUNT }, name_servers: ["ada.ns.cloudflare.com"] });
			if (sub === "/dns_records" && method === "GET") {
				const type = url.searchParams.get("type");
				const name = url.searchParams.get("name");
				return ok(zone.records.filter((r) => (!type || r.type === type) && (!name || r.name === name)));
			}
			if (sub === "/dns_records" && method === "POST") return ok(this.rec(zone, body));
			const rm = /^\/dns_records\/([^/]+)$/.exec(sub);
			if (rm) {
				const i = zone.records.findIndex((r) => r.id === rm[1]);
				if (i === -1) return err(404, "record not found", 81044);
				if (method === "DELETE") {
					zone.records.splice(i, 1);
					return ok({ id: rm[1] });
				}
				if (method === "PUT") {
					zone.records[i] = { ...zone.records[i]!, ...body, id: rm[1]! };
					return ok(zone.records[i]);
				}
			}
			if (sub === "/email/routing" && method === "GET") return ok(zone.routing);
			if (sub === "/email/routing/dns" && method === "POST") {
				const hadSpf = zone.records.some((r) => r.type === "TXT" && r.name === zone.name && /^"?v=spf1/.test(r.content));
				zone.records = zone.records.filter((r) => !(r.type === "MX" && r.name === zone.name));
				for (const [h, p] of [["route1.mx.cloudflare.net", 13], ["route2.mx.cloudflare.net", 24], ["route3.mx.cloudflare.net", 86]] as const) {
					this.rec(zone, { type: "MX", name: zone.name, content: h, priority: p });
				}
				if (!hadSpf || this.addsDuplicateSpf) this.rec(zone, { type: "TXT", name: zone.name, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' });
				this.rec(zone, { type: "TXT", name: `cf2024-1._domainkey.${zone.name}`, content: '"v=DKIM1; p=abc"' });
				zone.routing = { enabled: true, status: "ready" };
				// Cloudflare starts every zone with a disabled drop rule.
				if (!zone.catchAll) zone.catchAll = { tag: "ca", enabled: false, matchers: [{ type: "all" }], actions: [{ type: "drop" }] };
				return ok(zone.routing);
			}
			if (sub === "/email/routing/rules/catch_all") {
				if (method === "GET") return zone.catchAll ? ok(zone.catchAll) : err(404, "not found", 1001);
				if (method === "PUT") {
					zone.catchAll = { tag: "ca", ...body };
					return ok(zone.catchAll);
				}
			}
			if (sub === "/email/sending/subdomains") {
				if (zone.sendingPlanError) return err(403, "Email Sending requires a Workers Paid plan", 10403);
				if (method === "GET") return ok(zone.sending);
				if (method === "POST") {
					const s = { tag: `snd${++this.seq}`, name: body.name, enabled: true, dkim_selector: "cf-bounce" };
					zone.sending.push(s);
					return ok(s);
				}
			}
			const sd = /^\/email\/sending\/subdomains\/([^/]+)\/dns$/.exec(sub);
			if (sd && method === "GET") return ok([{ type: "TXT", name: `cf-bounce._domainkey.${zone.name}`, content: "v=DKIM1; p=xyz" }]);
		}
		m = /^\/accounts\/([^/]+)\/workers\/scripts(?:\/([^/]+)\/settings)?$/.exec(path);
		if (m && method === "GET") {
			if (m[2]) return this.scripts[m[2]] ? ok({ bindings: this.scripts[m[2]]!.bindings }) : err(404, "script not found");
			return ok(Object.keys(this.scripts).map((id) => ({ id })));
		}
		m = /^\/accounts\/[^/]+\/vectorize\/v2\/indexes\/([^/]+)(\/metadata_index\/(list|create))?$/.exec(path);
		if (m) {
			if (!this.vectorize.exists) return err(404, "index not found");
			if (!m[2]) return ok({ name: m[1] });
			if (m[3] === "list") return ok({ metadataIndexes: this.vectorize.meta.map((p) => ({ propertyName: p, indexType: "String" })) });
			this.vectorize.meta.push(body.propertyName);
			return ok({ mutationId: "x" });
		}
		return err(404, `no route ${method} ${path}`);
	}) as typeof fetch;
}

// -- harness --------------------------------------------------------------------------

function adapter(db: DatabaseSync): { sql: AuthSql; tx: <T>(fn: () => T) => T } {
	return {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const rows = db.prepare(query).all(...(bindings as never[])) as any[];
				return { toArray: () => rows };
			},
		},
		tx<T>(fn: () => T): T {
			db.exec("SAVEPOINT tx");
			try {
				const out = fn();
				db.exec("RELEASE tx");
				return out;
			} catch (e) {
				db.exec("ROLLBACK TO tx");
				db.exec("RELEASE tx");
				throw e;
			}
		},
	};
}

let auth: AuthStore;
let conn: CloudflareConnectionStore;
let domains: DomainStore;
let changes: DnsChangeLogStore;
let objects: Map<string, string>;
let sessionHash: string;
let now: number;
let cf: FakeCf;

function rpc() {
	const targets: Record<string, (...a: any[]) => unknown> = {
		getCloudflareConnection: () => conn.get(),
		updateCloudflareConnection: (p, n) => conn.update(p, n),
		recordDnsChange: (i) => changes.record(i),
		getDnsChange: (id) => changes.get(id),
		listDnsChanges: (l, z) => changes.list(l, z),
		markDnsChangeReverted: (id, by, n) => changes.markReverted(id, by, n),
		clearDnsChangeReverted: (id) => changes.clearReverted(id),
		listDomains: () => domains.listDomains(),
		getDomain: (id) => domains.getDomain(id),
		createDomain: (i) => domains.createDomain(i),
		updateDomain: (id, p, n) => domains.updateDomain(id, p, n),
		seedDomains: (z, n) => domains.seedDomains(z, n),
	};
	return new Proxy({}, { get: (_t, name: string) => async (...args: unknown[]) => (targets[name] ? targets[name]!(...args) : (auth as any)[name](...args)) });
}

function makeApp(options: { admin?: boolean; method?: "session" | "token"; env?: Record<string, unknown> } = {}) {
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("authMethod", options.method ?? "session");
		c.set("authSessionHash", sessionHash);
		c.set("principal", {
			identity: { kind: "user", id: "owner@example.com", subject: null },
			role: options.admin === false ? "member" : "admin",
			mailboxes: [],
			access: [],
			enforced: true,
			developmentBypass: false,
		} as never);
		return next();
	});
	app.route("/", cloudflareSetupRoutes);
	const env = {
		AUTH_SECRET: SECRET,
		SEMANTIC_INDEX: {},
		BUCKET: { put: async (key: string, value: string) => void objects.set(key, value) },
		...options.env,
	} as unknown as Env;
	const call = (method: string, path: string, body?: unknown) =>
		app.request(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, env);
	return { call };
}

async function connect(capabilities: { name: string; status: string }[] = []) {
	conn.put({
		tokenEnc: await sealCloudflareToken(TOKEN, SECRET),
		last4: "LAST",
		accountId: ACCOUNT,
		accountName: "Acme",
		tokenKind: "account",
		capabilities: capabilities as never,
		verifiedAt: now,
		createdBy: "owner@example.com",
		now,
	});
	invalidateCloudflareConnectionCache();
}

function auditEntries(): any[] {
	return [...objects.entries()].filter(([k]) => k.startsWith("audit/")).map(([, v]) => JSON.parse(v));
}

async function getPlan(app: ReturnType<typeof makeApp>, zones: string[]): Promise<CfPlanResponse> {
	const res = await app.call("POST", "/api/v1/cloudflare/plan", { zones });
	expect(res.status).toBe(200);
	return (await res.json()) as CfPlanResponse;
}

const pick = (plan: CfPlanResponse, zoneId: string, kind: PlanItem["kind"]) => plan.items.find((i) => i.zoneId === zoneId && i.kind === kind)!;

/** Apply every auto item, plus the given confirm ids. */
async function applyAll(app: ReturnType<typeof makeApp>, zones: string[], plan: CfPlanResponse, confirm: string[] = []) {
	const items = plan.items
		.filter((i) => zones.includes(i.zoneId ?? "") || i.zoneId === null)
		.filter((i) => i.tier === "auto" || (i.tier === "confirm" && confirm.includes(i.id)))
		.map((i) => (i.tier === "confirm" ? { id: i.id, confirm: true as const } : { id: i.id }));
	return app.call("POST", "/api/v1/cloudflare/apply", { zones, planHash: plan.planHash, items });
}

beforeEach(async () => {
	const db = new DatabaseSync(":memory:");
	const { sql, tx } = adapter(db);
	auth = new AuthStore(sql, tx);
	conn = new CloudflareConnectionStore(sql, tx);
	domains = new DomainStore(sql, tx);
	changes = new DnsChangeLogStore(sql, tx);
	objects = new Map();
	now = T0;
	const owner = await auth.createOwner({ email: "owner@example.com", name: "O", passwordHash: "h", now });
	if (!owner.ok) throw new Error("setup");
	sessionHash = "sess-hash";
	await auth.createSession({ userId: owner.user.id, tokenHash: sessionHash, ip: null, userAgent: null, now });
	await auth.markSessionAuthenticated(sessionHash, now);
	cf = new FakeCf();
	cloudflareRouteDeps.store = () => rpc() as never;
	cloudflareRouteDeps.now = () => now;
	cloudflareRouteDeps.fetchImpl = cf.impl;
	cloudflareSetupDeps.store = () => rpc() as never;
	// SPF include lookups: every include resolves to a record with no further lookups.
	cloudflareSetupDeps.dohFetch = (async () =>
		new Response(JSON.stringify({ Status: 0, Answer: [{ type: 16, data: '"v=spf1 ip4:192.0.2.0/24 ~all"' }] }))) as typeof fetch;
	cfConnectionDeps.now = () => now;
	invalidateCloudflareConnectionCache();
	invalidateDiscoveryCache();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// -- helpers --------------------------------------------------------------------------

describe("mapLimit", () => {
	it("never runs more than the limit at once and keeps order", async () => {
		let active = 0;
		let peak = 0;
		const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 2));
			active--;
			return n * 2;
		});
		expect(peak).toBe(3);
		expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
	});
});

describe("countSpfLookups", () => {
	it("follows includes and stops past the limit", async () => {
		const doh = (async (input: RequestInfo | URL) => {
			const name = new URL(String(input)).searchParams.get("name");
			const data = name === "a.example" ? '"v=spf1 include:b.example include:c.example ~all"' : '"v=spf1 a mx ~all"';
			return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 16, data }] }));
		}) as typeof fetch;
		// a(1) → b(2: a, mx) + c(2: a, mx) = 1 + 1 + 2 + 1 + 2 = 7
		expect(await countSpfLookups("v=spf1 include:a.example ~all", doh)).toBe(7);
	});

	it("is null when an include can't be resolved", async () => {
		const fail = (async () => new Response("x", { status: 500 })) as typeof fetch;
		expect(await countSpfLookups("v=spf1 include:a.example ~all", fail)).toBeNull();
	});
});

// -- discover -------------------------------------------------------------------------

describe("GET /api/v1/cloudflare/discover", () => {
	it("412 without a token, admin-only", async () => {
		expect((await makeApp().call("GET", "/api/v1/cloudflare/discover")).status).toBe(412);
		await connect();
		expect((await makeApp({ admin: false }).call("GET", "/api/v1/cloudflare/discover")).status).toBe(403);
	});

	it("lists zones active first with apex summary, and is read-only and cached 60 s", async () => {
		await connect();
		cf.addZone({ id: Z2, name: "pending.dev", status: "pending" });
		const g = cf.addZone({ id: Z1, name: "gmail-here.com" });
		cf.rec(g, { type: "MX", name: "gmail-here.com", content: "aspmx.l.google.com", priority: 1 });
		const app = makeApp();
		const res = await app.call("GET", "/api/v1/cloudflare/discover");
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.zones.map((z: any) => [z.name, z.status])).toEqual([["gmail-here.com", "active"], ["pending.dev", "pending"]]);
		expect(body.zones[0]).toMatchObject({ mxProvider: "google", detail: "summary" });
		expect(body.worker).toMatchObject({ found: true });
		expect(body.vectorize).toMatchObject({ index: "present", metadataIndex: "missing" });
		expect(body.cached).toBe(false);
		expect(cf.calls.every((c) => c.method === "GET")).toBe(true);
		expect(cf.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
		expect(JSON.stringify(body)).not.toContain(TOKEN);

		const n = cf.calls.length;
		const again = (await (await app.call("GET", "/api/v1/cloudflare/discover")).json()) as any;
		expect(again.cached).toBe(true);
		expect(cf.calls.length).toBe(n);
		now += 61_000;
		expect(((await (await app.call("GET", "/api/v1/cloudflare/discover")).json()) as any).cached).toBe(false);
	});

	it("caps at 200 zones and pages 50 at a time", async () => {
		await connect();
		for (let i = 0; i < 230; i++) cf.addZone({ id: i.toString(16).padStart(32, "0"), name: `z${String(i).padStart(3, "0")}.com`, status: "pending" });
		const body = (await (await makeApp().call("GET", "/api/v1/cloudflare/discover")).json()) as any;
		expect(body.zones).toHaveLength(200);
		expect(body.zoneCount).toBe(230);
		expect(body.truncated).toBe(true);
		expect(cf.calls.filter((c) => c.path.startsWith("/zones?")).length).toBe(4);
	});

	it("reports a zone read failure on that zone only", async () => {
		await connect();
		cf.addZone({ id: Z1, name: "a.com" });
		cf.addZone({ id: Z2, name: "b.com" });
		cf.failNext[`GET /zones/${Z1}/dns_records`] = 5;
		const body = (await (await makeApp().call("GET", "/api/v1/cloudflare/discover")).json()) as any;
		const a = body.zones.find((z: any) => z.zoneId === Z1);
		const b = body.zones.find((z: any) => z.zoneId === Z2);
		expect(a.error).toContain("500");
		expect(b.error).toBeUndefined();
	});

	it("finds the one Worker with a MailboxDO binding when the default name is wrong", async () => {
		await connect();
		cf.scripts = {
			"my-mail": { bindings: [{ type: "durable_object_namespace", name: "MAILBOX", class_name: "MailboxDO" }] },
			"other": { bindings: [{ type: "durable_object_namespace", name: "MAILBOX", class_name: "MailboxDO", script_name: "my-mail" }] },
			"blog": { bindings: [] },
		};
		const body = (await (await makeApp().call("GET", "/api/v1/cloudflare/discover")).json()) as any;
		expect(body.worker).toMatchObject({ found: false, mailboxScripts: ["my-mail"], canPersist: true });
	});
});

// -- plan -----------------------------------------------------------------------------

describe("POST /api/v1/cloudflare/plan", () => {
	it("400 for a zone the token can't see, or a bad body", async () => {
		await connect();
		cf.addZone({ id: Z1, name: "a.com" });
		const res = await makeApp().call("POST", "/api/v1/cloudflare/plan", { zones: [Z1, FOREIGN] });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "zone_not_visible", zones: [FOREIGN] });
		expect((await makeApp().call("POST", "/api/v1/cloudflare/plan", { zones: ["nope"] })).status).toBe(400);
		expect((await makeApp().call("POST", "/api/v1/cloudflare/plan", { zones: [Z1, Z2, Z3, FOREIGN, "4".repeat(32), "5".repeat(32)] })).status).toBe(400);
	});

	it("is read-only", async () => {
		await connect();
		cf.addZone({ id: Z1, name: "a.com" });
		await getPlan(makeApp(), [Z1]);
		expect(cf.calls.every((c) => c.method === "GET")).toBe(true);
	});
});

// -- apply --------------------------------------------------------------------------------

describe("POST /api/v1/cloudflare/apply", () => {
	it("sets up a brand-new domain end to end with auto items only, and logs each write", async () => {
		await connect();
		cf.addZone({ id: Z1, name: "fresh.com" });
		const app = makeApp();
		const plan = await getPlan(app, [Z1]);
		expect(plan.items.filter((i) => i.zoneId === Z1 && i.tier === "auto").map((i) => i.kind).sort()).toEqual(
			["add_domain", "catch_all", "dmarc_create", "enable_routing", "sending_domain"],
		);
		const res = await applyAll(app, [Z1], plan);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.results.map((r: any) => [r.id.split(":")[1], r.status])).toEqual(
			expect.arrayContaining([["add_domain", "ok"], ["enable_routing", "ok"], ["catch_all", "ok"], ["sending_domain", "ok"], ["dmarc_create", "ok"]]),
		);
		expect(body.ok).toBe(true);

		const zone = cf.zones.get(Z1)!;
		expect(zone.catchAll).toMatchObject({ enabled: true, actions: [{ type: "worker", value: ["cloudmail"] }] });
		expect(zone.records.filter((r) => r.type === "TXT" && /v=spf1/.test(r.content))).toHaveLength(1);
		expect(zone.records.find((r) => r.name === "_dmarc.fresh.com")!.content).toBe("v=DMARC1; p=none;");
		expect(zone.sending).toHaveLength(1);

		const d = domains.getDomain("fresh.com")!;
		expect(d).toMatchObject({ zoneId: Z1, status: "active", routingStatus: "ready", sendingStatus: "enabled" });

		const log = changes.list(100);
		// DMARC create, catch-all (default drop → worker), and every record routing added.
		expect(log.find((c) => c.recordType === "catch_all")).toMatchObject({ action: "update", before: { enabled: false, actions: [{ type: "drop" }] } });
		expect(log.find((c) => c.name === "_dmarc.fresh.com")).toMatchObject({ action: "create", appliedBy: "owner@example.com" });
		expect(log.filter((c) => c.recordType === "MX" && c.action === "create")).toHaveLength(3);
		const audits = auditEntries().filter((e) => e.action === "cloudflare.dns_change");
		expect(audits.length).toBeGreaterThanOrEqual(log.length);
		expect(JSON.stringify([...objects.values()])).not.toContain(TOKEN);
	});

	it("needs a fresh browser session", async () => {
		await connect();
		cf.addZone({ id: Z1, name: "fresh.com" });
		const plan = await getPlan(makeApp(), [Z1]);
		const token = await applyAll(makeApp({ method: "token" }), [Z1], plan);
		expect(token.status).toBe(403);
		expect(await token.json()).toMatchObject({ code: "session_required" });
		now = T0 + 16 * 60_000;
		const stale = await applyAll(makeApp(), [Z1], plan);
		expect(await stale.json()).toMatchObject({ code: "reauth_required" });
		expect(cf.calls.some((c) => c.method !== "GET")).toBe(false);
	});

	it("409 plan_stale when a record changed after review, and writes nothing", async () => {
		await connect();
		const z = cf.addZone({ id: Z1, name: "g.com" });
		const mx = cf.rec(z, { type: "MX", name: "g.com", content: "aspmx.l.google.com", priority: 1 });
		const app = makeApp();
		const plan = await getPlan(app, [Z1]);
		mx.content = "alt1.aspmx.l.google.com";
		const res = await applyAll(app, [Z1], plan, plan.items.filter((i) => i.tier === "confirm").map((i) => i.id));
		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.code).toBe("plan_stale");
		expect(body.planHash).not.toBe(plan.planHash);
		expect(cf.calls.some((c) => c.method !== "GET")).toBe(false);
	});

	it("refuses items on a zone not in the request, or not visible", async () => {
		await connect();
		cf.addZone({ id: Z1, name: "a.com" });
		cf.addZone({ id: Z2, name: "b.com" });
		const app = makeApp();
		const plan = await getPlan(app, [Z1]);
		const res = await app.call("POST", "/api/v1/cloudflare/apply", { zones: [Z1], planHash: plan.planHash, items: [{ id: `${Z2}:dmarc_create` }] });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "zone_not_selected" });
		const invisible = await app.call("POST", "/api/v1/cloudflare/apply", { zones: [Z1, FOREIGN], planHash: plan.planHash, items: [{ id: `${Z1}:dmarc_create` }] });
		expect(invisible.status).toBe(400);
		expect(await invisible.json()).toMatchObject({ code: "zone_not_visible" });
		expect(cf.calls.some((c) => c.method !== "GET")).toBe(false);
	});

	it("confirm items need confirm: true; manual and done items are refused", async () => {
		await connect();
		const z = cf.addZone({ id: Z1, name: "g.com" });
		cf.rec(z, { type: "MX", name: "g.com", content: "aspmx.l.google.com", priority: 1 });
		const app = makeApp();
		const plan = await getPlan(app, [Z1]);
		const res = await app.call("POST", "/api/v1/cloudflare/apply", { zones: [Z1], planHash: plan.planHash, items: [{ id: `${Z1}:mx_replace` }] });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "confirm_required" });
		const manual = await app.call("POST", "/api/v1/cloudflare/apply", { zones: [Z1], planHash: plan.planHash, items: [{ id: `${Z1}:mta_sts` }] });
		expect(await manual.json()).toMatchObject({ code: "not_applicable" });
		expect(cf.calls.some((c) => c.method !== "GET")).toBe(false);
	});

	it("auto items never touch a zone with Google MX; confirmed, it merges SPF, replaces MX and leaves one SPF", async () => {
		await connect();
		const z = cf.addZone({ id: Z1, name: "g.com" });
		cf.rec(z, { type: "MX", name: "g.com", content: "aspmx.l.google.com", priority: 1 });
		cf.rec(z, { type: "MX", name: "g.com", content: "alt1.aspmx.l.google.com", priority: 5 });
		const spf = cf.rec(z, { type: "TXT", name: "g.com", content: '"v=spf1 include:_spf.google.com ~all"' });
		const app = makeApp();
		const plan = await getPlan(app, [Z1]);

		// Auto only: the domain row and DMARC. MX and SPF untouched.
		const autoRes = (await (await applyAll(app, [Z1], plan)).json()) as any;
		expect(autoRes.results.filter((r: any) => r.id.startsWith(Z1)).map((r: any) => r.id.split(":")[1]).sort()).toEqual(["add_domain", "dmarc_create"]);
		expect(z.records.filter((r) => r.type === "MX").map((r) => r.content)).toEqual(["aspmx.l.google.com", "alt1.aspmx.l.google.com"]);
		expect(z.routing.enabled).toBe(false);

		const plan2 = await getPlan(app, [Z1]);
		const confirm = plan2.items.filter((i) => i.tier === "confirm").map((i) => i.id);
		expect(confirm.map((id) => id.split(":")[1]).sort()).toEqual(["catch_all", "enable_routing", "mx_replace", "sending_domain", "spf_merge"]);
		const res = (await (await applyAll(app, [Z1], plan2, confirm)).json()) as any;
		expect(res.results.every((r: any) => r.status === "ok")).toBe(true);

		const spfs = z.records.filter((r) => r.type === "TXT" && r.name === "g.com" && /v=spf1/.test(r.content));
		expect(spfs).toHaveLength(1);
		expect(spfs[0]!.id).toBe(spf.id);
		expect(spfs[0]!.content).toBe('"v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all"');
		expect(z.records.filter((r) => r.type === "MX").every((r) => r.content.endsWith("mx.cloudflare.net"))).toBe(true);

		const log = changes.list(100);
		expect(log.filter((c) => c.recordType === "MX" && c.action === "delete").map((c) => (c.before as any).content).sort()).toEqual(
			["alt1.aspmx.l.google.com", "aspmx.l.google.com"],
		);
		expect(log.find((c) => c.recordType === "TXT" && c.action === "update")).toMatchObject({ before: { content: '"v=spf1 include:_spf.google.com ~all"' } });
		// The duplicate Cloudflare added was logged as created then deleted.
		expect(log.filter((c) => c.recordType === "TXT" && c.name === "g.com" && c.action === "delete")).toHaveLength(1);
	});

	it("reports an error, not a throw, when two SPF records remain after enabling", async () => {
		await connect();
		const z = cf.addZone({ id: Z1, name: "fresh.com" });
		const app = makeApp();
		const plan = await getPlan(app, [Z1]);
		// Someone adds a second SPF between plan and apply... on a name the plan didn't pin.
		const original = cf.impl;
		cf.impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const res = await original(input, init);
			if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/email/routing/dns")) {
				cf.rec(z, { type: "TXT", name: "fresh.com", content: '"v=spf1 include:other.example ~all"' });
			}
			return res;
		}) as typeof fetch;
		cloudflareRouteDeps.fetchImpl = cf.impl;
		const res = (await (await applyAll(app, [Z1], plan)).json()) as any;
		const routing = res.results.find((r: any) => r.id === `${Z1}:enable_routing`);
		expect(routing.status).toBe("error");
		expect(routing.detail).toMatch(/2 SPF records/);
		expect(res.results.find((r: any) => r.id === `${Z1}:catch_all`).status).toBe("skipped");
		expect(res.ok).toBe(false);
	});

	it("mx_replace refuses when a new foreign MX appeared after the plan, and routing stays off", async () => {
		await connect();
		const z = cf.addZone({ id: Z1, name: "g.com" });
		cf.rec(z, { type: "MX", name: "g.com", content: "aspmx.l.google.com", priority: 1 });
		cf.rec(z, { type: "TXT", name: "g.com", content: '"v=spf1 include:_spf.google.com ~all"' });
		const app = makeApp();
		const plan = await getPlan(app, [Z1]);
		// The SPF write is the first change to the zone; a new MX lands right after it.
		const original = cf.impl;
		let added = false;
		cf.impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const res = await original(input, init);
			const method = init?.method ?? "GET";
			if (!added && method !== "GET" && method !== "POST" && /\/dns_records\//.test(String(input))) {
				added = true;
				cf.rec(z, { type: "MX", name: "g.com", content: "mx.other.example", priority: 20 });
			}
			return res;
		}) as typeof fetch;
		cloudflareRouteDeps.fetchImpl = cf.impl;
		const confirm = plan.items.filter((i) => i.tier === "confirm").map((i) => i.id);
		const res = (await (await applyAll(app, [Z1], plan, confirm)).json()) as any;
		expect(added).toBe(true);
		const mx = res.results.find((r: any) => r.id === `${Z1}:mx_replace`);
		expect(mx.status).toBe("error");
		expect(mx.detail).toMatch(/mx\.other\.example/);
		expect(res.results.find((r: any) => r.id === `${Z1}:enable_routing`).status).toBe("skipped");
		expect(z.routing.enabled).toBe(false);
		expect(z.records.filter((r) => r.type === "MX").map((r) => r.content).sort()).toEqual(["aspmx.l.google.com", "mx.other.example"]);
	});

	it("a failed item skips its dependents and the rest still run", async () => {
		await connect();
		cf.addZone({ id: Z1, name: "fresh.com" });
		cf.failNext[`POST /zones/${Z1}/email/routing/dns`] = 1;
		const app = makeApp();
		const plan = await getPlan(app, [Z1]);
		const res = (await (await applyAll(app, [Z1], plan)).json()) as any;
		const status = Object.fromEntries(res.results.map((r: any) => [r.id.split(":")[1], r.status]));
		expect(status).toMatchObject({ add_domain: "ok", enable_routing: "error", catch_all: "skipped", sending_domain: "ok", dmarc_create: "ok" });
	});

	it("persists a detected Worker name and the catch-all targets it", async () => {
		await connect();
		cf.scripts = { "my-mail": { bindings: [{ type: "durable_object_namespace", name: "MAILBOX", class_name: "MailboxDO" }] } };
		cf.addZone({ id: Z1, name: "fresh.com" });
		const app = makeApp();
		const plan = await getPlan(app, [Z1]);
		expect(plan.items.find((i) => i.id === "account:worker_name")!.tier).toBe("auto");
		const res = (await (await applyAll(app, [Z1], plan)).json()) as any;
		expect(res.results.find((r: any) => r.id === "account:worker_name").status).toBe("ok");
		expect(conn.get()!.workerScriptName).toBe("my-mail");
		expect(cf.zones.get(Z1)!.catchAll.actions).toEqual([{ type: "worker", value: ["my-mail"] }]);
	});

	it("creates the Vectorize metadata index", async () => {
		await connect();
		cf.addZone({ id: Z1, name: "fresh.com" });
		const app = makeApp();
		const plan = await getPlan(app, [Z1]);
		const res = await app.call("POST", "/api/v1/cloudflare/apply", {
			zones: [Z1],
			planHash: plan.planHash,
			items: [{ id: "account:vectorize_metadata_index" }],
		});
		expect(((await res.json()) as any).results[0].status).toBe("ok");
		expect(cf.vectorize.meta).toEqual(["mailbox"]);
	});

	it("plan_upgrade is manual when Email Sending is refused for the plan", async () => {
		await connect();
		cf.addZone({ id: Z1, name: "fresh.com", sendingPlanError: true });
		const plan = await getPlan(makeApp(), [Z1]);
		expect(pick(plan, Z1, "plan_upgrade").tier).toBe("manual");
	});

	it("works with the CF_API_TOKEN env token too (no stored connection)", async () => {
		cf.addZone({ id: Z1, name: "fresh.com" });
		const app = makeApp({ env: { CF_API_TOKEN: TOKEN, CF_ACCOUNT_ID: ACCOUNT } });
		const plan = await getPlan(app, [Z1]);
		const res = (await (await applyAll(app, [Z1], plan)).json()) as any;
		expect(res.ok).toBe(true);
	});
});

// -- change log + revert --------------------------------------------------------------------------

describe("changes and revert", () => {
	async function setupGoogle() {
		await connect();
		const z = cf.addZone({ id: Z1, name: "g.com" });
		cf.rec(z, { type: "MX", name: "g.com", content: "aspmx.l.google.com", priority: 1 });
		cf.rec(z, { type: "TXT", name: "g.com", content: '"v=spf1 include:_spf.google.com ~all"' });
		const app = makeApp();
		const plan = await getPlan(app, [Z1]);
		await applyAll(app, [Z1], plan, plan.items.filter((i) => i.tier === "confirm").map((i) => i.id));
		return { z, app };
	}

	it("lists recent changes newest first", async () => {
		const { app } = await setupGoogle();
		const res = await app.call("GET", "/api/v1/cloudflare/changes?limit=5");
		const body = (await res.json()) as any;
		expect(body.changes).toHaveLength(5);
		expect(body.changes[0].appliedAt).toBeGreaterThanOrEqual(body.changes[4].appliedAt);
	});

	it("restores a deleted MX record, an updated SPF and a replaced catch-all", async () => {
		const { z, app } = await setupGoogle();
		const log = changes.list(100);
		const mxDel = log.find((c) => c.recordType === "MX" && c.action === "delete")!;
		const spfUpd = log.find((c) => c.recordType === "TXT" && c.action === "update")!;
		const ca = log.find((c) => c.recordType === "catch_all")!;

		const r1 = await app.call("POST", `/api/v1/cloudflare/changes/${mxDel.id}/revert`);
		expect(r1.status).toBe(200);
		expect(z.records.some((r) => r.type === "MX" && r.content === "aspmx.l.google.com")).toBe(true);
		expect(((await r1.json()) as any).change.revertedAt).toBe(now);

		expect((await app.call("POST", `/api/v1/cloudflare/changes/${spfUpd.id}/revert`)).status).toBe(200);
		expect(z.records.find((r) => r.type === "TXT" && r.name === "g.com" && /google/.test(r.content))!.content).toBe('"v=spf1 include:_spf.google.com ~all"');

		expect((await app.call("POST", `/api/v1/cloudflare/changes/${ca.id}/revert`)).status).toBe(200);
		expect(z.catchAll).toMatchObject({ enabled: false, actions: [{ type: "drop" }] });

		const again = await app.call("POST", `/api/v1/cloudflare/changes/${mxDel.id}/revert`);
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({ code: "already_reverted" });
		expect(auditEntries().filter((e) => e.action === "cloudflare.revert")).toHaveLength(3);
	});

	it("refuses to revert over a later edit", async () => {
		const { z, app } = await setupGoogle();
		const spfUpd = changes.list(100).find((c) => c.recordType === "TXT" && c.action === "update")!;
		const rec = z.records.find((r) => r.id === (spfUpd.after as any).id)!;
		rec.content = '"v=spf1 include:_spf.mx.cloudflare.net include:new.example ~all"';
		const res = await app.call("POST", `/api/v1/cloudflare/changes/${spfUpd.id}/revert`);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "revert_conflict" });
		expect(changes.get(spfUpd.id)!.revertedAt).toBeNull();
	});

	it("never restores the duplicate SPF record apply removed", async () => {
		const { z, app } = await setupGoogle();
		const dup = changes.list(100).find((c) => c.recordType === "TXT" && c.name === "g.com" && c.action === "delete")!;
		const res = await app.call("POST", `/api/v1/cloudflare/changes/${dup.id}/revert`);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "revert_conflict" });
		expect(z.records.filter((r) => r.type === "TXT" && r.name === "g.com" && /v=spf1/.test(r.content))).toHaveLength(1);
		expect(changes.get(dup.id)!.revertedAt).toBeNull();
	});

	it("revert needs a fresh session; 404 for an unknown id", async () => {
		const { app } = await setupGoogle();
		const id = changes.list(1)[0]!.id;
		now += 16 * 60_000;
		expect((await app.call("POST", `/api/v1/cloudflare/changes/${id}/revert`)).status).toBe(403);
		await auth.markSessionAuthenticated(sessionHash, now);
		expect((await app.call("POST", "/api/v1/cloudflare/changes/dnc_nope/revert")).status).toBe(404);
	});
});
