/**
 * Licence plans (workers/lib/licence-plan.ts): Solo covers one mail domain,
 * Unlimited and every token from before plans existed cover all of them.
 * The limit applies where domains are added and to sending from a domain
 * past it; inbound mail is never refused.
 *
 * Tokens are signed with a throwaway Ed25519 key, as in licence-gate.test.ts.
 */

import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore, type AuthSql } from "../workers/auth/store-core";
import { LicenceStore } from "../workers/lib/licence-store";
import {
	activateLicence,
	invalidateLicenceCache,
	licenceState,
	licenceView,
	setLicenceEnforcementForTests,
	startLicenceUpgrade,
	type LicenceDeps,
	type LicenceRpc,
} from "../workers/lib/licence";

// The test runner is a development build, where the check is off: run it as a deployed Worker does.
afterAll(() => setLicenceEnforcementForTests(false));
import {
	checkDomainAllowance,
	currentPlanLimits,
	domainUsage,
	limitPlanItems,
	orderDomains,
	refuseDomainAdd,
	remainingDomains,
	uncoveredSenderDomain,
	type DomainUsageDeps,
} from "../workers/lib/licence-plan";
import { preSend } from "../workers/lib/pre-send";
import { base64UrlEncode, planLimits, type Jwks, type LicenceClaims } from "../shared/licence-token";
import type { PlanItem } from "../shared/cf-setup";
import type { Env } from "../workers/types";

const HOST = "mail.customer.example";
const DAY = 86_400;
const KID = "test-plan-1";

let signingKey: CryptoKey;
let jwks: Jwks;

beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	signingKey = pair.privateKey;
	const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
	jwks = { keys: [{ kty: "OKP", crv: "Ed25519", x: pub.x!, kid: KID, alg: "EdDSA", use: "sig" }] };
});

/** Claims as the licence server mints them. `legacy` drops the plan fields, like a token from before plans. */
const SOLO = { plan: "solo", instances: 1, max_domains: 1, max_deployments: 1 } as const;
const UNLIMITED = { plan: "unlimited", instances: 1, max_domains: null, max_deployments: 1 } as const;
const LEGACY = { plan: "standard", instances: 3 } as const;

async function mint(claims: Partial<LicenceClaims> & { deployment_id: string }, now: number): Promise<string> {
	const full = {
		iss: "https://tapetide.com",
		aud: "tapetide-mail",
		v: 1,
		licence_id: "tlc_test",
		customer: { id: "cus_test", email: "buyer@example.org" },
		plan: "solo",
		instances: 1,
		bind: { host: HOST, cf_account: null },
		features: [],
		sub_status: "none",
		iat: now,
		nbf: now,
		exp: now + 30 * DAY,
		...claims,
	};
	const enc = new TextEncoder();
	const h = base64UrlEncode(enc.encode(JSON.stringify({ alg: "EdDSA", typ: "tapetide-lic+jwt", kid: KID })));
	const p = base64UrlEncode(enc.encode(JSON.stringify(full)));
	const sig = await crypto.subtle.sign({ name: "Ed25519" }, signingKey, enc.encode(`${h}.${p}`));
	return `${h}.${p}.${base64UrlEncode(sig)}`;
}

function adapter(db: DatabaseSync): { sql: AuthSql; tx: <T>(fn: () => T) => T } {
	return {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const rows = db.prepare(query).all(...(bindings as never[])) as any[];
				return { toArray: () => rows };
			},
		},
		tx: <T>(fn: () => T) => fn(),
	};
}

let store: LicenceStore;
let clock: number;
let rpc: LicenceRpc;
let env: Env;
let rows: { hostname: string; createdAt: number }[];

beforeEach(() => {
	const db = new DatabaseSync(":memory:");
	const { sql, tx } = adapter(db);
	new AuthStore(sql, tx);
	store = new LicenceStore(sql, tx);
	clock = 1_800_000_000;
	rpc = {
		getLicence: async () => store.get(clock, () => `dep_${crypto.randomUUID()}`),
		storeLicenceToken: async (token, refreshAfter) => {
			store.get(clock, () => `dep_${crypto.randomUUID()}`);
			return store.storeToken(token, refreshAfter, clock);
		},
		recordLicenceFailure: async (status, reason) => store.recordFailure(clock, status, reason),
		clearLicenceToken: async () => store.clearToken(clock),
		claimLicenceRefresh: async (min) => store.claimRefresh(clock, min),
	};
	setLicenceEnforcementForTests(true);
	env = { APP_URL: `https://${HOST}`, AUTH_STORE: {}, DOMAINS: "" } as unknown as Env;
	rows = [];
	invalidateLicenceCache(env);
	vi.restoreAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

const deps = (extra: Partial<LicenceDeps> = {}): DomainUsageDeps => ({
	rpc,
	jwks,
	now: () => clock,
	listDomains: async () => rows,
	...extra,
});

async function holdToken(claims: Partial<LicenceClaims>): Promise<void> {
	const rec = await rpc.getLicence();
	await rpc.storeLicenceToken(await mint({ deployment_id: rec.deploymentId, ...claims }, clock), clock + DAY);
	invalidateLicenceCache(env);
}

function fakeServer(handler: (path: string, body: any) => { status: number; body: unknown }) {
	const calls: { path: string; body: any }[] = [];
	const f = (async (url: string, init: RequestInit) => {
		const path = new URL(url).pathname;
		const body = JSON.parse(String(init.body));
		calls.push({ path, body });
		const r = handler(path, body);
		return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { fetch: f, calls };
}

describe("reading the plan from the token", () => {
	it("Solo: one domain, one deployment, upgrade offered", async () => {
		await holdToken(SOLO);
		const view = licenceView(await licenceState(env, deps()), clock);
		expect(view).toMatchObject({ planName: "solo", maxDomains: 1, maxDeployments: 1, upgradeAvailable: true });
		expect(await currentPlanLimits(env, deps())).toEqual({ plan: "solo", max_domains: 1, max_deployments: 1 });
	});

	it("Unlimited: no domain limit, no upgrade", async () => {
		await holdToken(UNLIMITED);
		const view = licenceView(await licenceState(env, deps()), clock);
		expect(view).toMatchObject({ planName: "unlimited", maxDomains: null, maxDeployments: 1, upgradeAvailable: false });
	});

	it("a token from before plans (no max_domains) is Unlimited, with its old deployment count", async () => {
		await holdToken(LEGACY);
		const view = licenceView(await licenceState(env, deps()), clock);
		expect(view).toMatchObject({ planName: "unlimited", maxDomains: null, maxDeployments: 3, upgradeAvailable: false, plan: "standard" });
		expect(planLimits({ plan: "solo", instances: 1 })).toEqual({ plan: "solo", max_domains: null, max_deployments: 1 });
	});

	it("a development build is Unlimited even holding a Solo token; a deployed build is not", async () => {
		await holdToken(SOLO);
		expect((await currentPlanLimits({ ...env, LICENCE_CHECK: "off" } as unknown as Env, deps())).max_domains).toBe(1);
		setLicenceEnforcementForTests(false);
		expect((await currentPlanLimits(env, deps())).max_domains).toBeNull();
		expect((await currentPlanLimits(env)).max_domains).toBeNull();
	});

	it("no token: nothing to show, and nothing to upgrade", async () => {
		const view = licenceView(await licenceState(env, deps()), clock);
		expect(view).toMatchObject({ planName: null, maxDomains: null, upgradeAvailable: false });
	});
});

describe("domain allowance", () => {
	it("Solo allows the first domain and refuses a second, with an upgrade pointer", async () => {
		await holdToken(SOLO);
		expect(await refuseDomainAdd(env, ["first.example"], deps())).toBeNull();
		rows = [{ hostname: "first.example", createdAt: 1 }];
		const refusal = await refuseDomainAdd(env, ["second.example"], deps());
		expect(refusal).toMatchObject({ code: "plan_domain_limit", plan: "solo", maxDomains: 1, used: 1, upgradeUrl: "/settings/licence" });
		expect(refusal!.error).toMatch(/Solo licence covers one mail domain\. Upgrade to Unlimited/);
		// Re-adding (or re-configuring) the domain it already has is fine.
		expect(await refuseDomainAdd(env, ["FIRST.example"], deps())).toBeNull();
	});

	it("counts env DOMAINS that aren't stored yet", async () => {
		await holdToken(SOLO);
		const withEnv = { ...env, DOMAINS: "env.example" } as unknown as Env;
		expect(await refuseDomainAdd(withEnv, ["other.example"], deps())).not.toBeNull();
	});

	it("Unlimited and legacy tokens never refuse, and don't even read the domain list", async () => {
		const listDomains = vi.fn(async () => rows);
		for (const claims of [UNLIMITED, LEGACY]) {
			await holdToken(claims);
			rows = Array.from({ length: 12 }, (_, i) => ({ hostname: `d${i}.example`, createdAt: i }));
			expect(await refuseDomainAdd(env, ["new.example"], deps({ listDomains } as never))).toBeNull();
		}
		expect(listDomains).not.toHaveBeenCalled();
	});

	it("covers the oldest domains; env domains with no row count first", () => {
		expect(orderDomains(["b.example", "a.example"], [{ hostname: "z.example", createdAt: 5 }, { hostname: "y.example", createdAt: 9 }])).toEqual([
			"b.example",
			"a.example",
			"z.example",
			"y.example",
		]);
		expect(orderDomains(["seeded.example"], [{ hostname: "early.example", createdAt: 1 }, { hostname: "seeded.example", createdAt: 3 }])).toEqual([
			"early.example",
			"seeded.example",
		]);
	});

	it("reports domains past the limit (e.g. after an upgrade refund) without dropping any", async () => {
		await holdToken(SOLO);
		rows = [
			{ hostname: "main.example", createdAt: 1 },
			{ hostname: "extra.example", createdAt: 2 },
		];
		const usage = await domainUsage(env, deps());
		expect(usage).toMatchObject({ domains: ["main.example", "extra.example"], covered: ["main.example"], notCovered: ["extra.example"] });
		expect(remainingDomains(usage)).toBe(0);
		expect(checkDomainAllowance(usage, ["main.example"])).toBeNull();
	});
});

describe("sending from a domain past the limit", () => {
	beforeEach(async () => {
		await holdToken(SOLO);
		rows = [
			{ hostname: "main.example", createdAt: 1 },
			{ hostname: "extra.example", createdAt: 2 },
		];
	});

	it("is refused with a clear message; the covered domain sends", async () => {
		expect(await uncoveredSenderDomain(env, "me@main.example", deps())).toBeNull();
		expect(await uncoveredSenderDomain(env, "me@extra.example", deps())).toMatch(/extra\.example isn't covered by your cloudmail Solo licence, so it can receive mail but not send/);
	});

	it("pre-send blocks it with code plan_domain_limit", async () => {
		const licence = deps() as LicenceDeps;
		const r = await preSend(env, { kind: "transactional", from: "me@extra.example", mailboxId: null, to: ["x@y.example"], subject: "s", text: "t" } as never, {
			licence,
		});
		expect(r).toMatchObject({ ok: false, outcome: "block", code: "plan_domain_limit", status: 403 });
	});

	it("Unlimited sends from every domain", async () => {
		await holdToken(UNLIMITED);
		expect(await uncoveredSenderDomain(env, "me@extra.example", deps())).toBeNull();
	});
});

describe("Cloudflare setup plan", () => {
	const item = (zoneId: string, host: string, kind: string, tier: string, extra: Partial<PlanItem> = {}): PlanItem =>
		({ id: `${zoneId}:${kind}`, zoneId, hostname: host, kind, tier, title: kind, detail: "", ...extra }) as PlanItem;
	const items = [
		item("acct", "", "worker_name", "auto", { zoneId: null, hostname: null, id: "account:worker_name" }),
		item("z1", "one.example", "add_domain", "auto"),
		item("z1", "one.example", "enable_routing", "auto", { dependsOn: ["z1:add_domain"] }),
		item("z2", "two.example", "add_domain", "auto"),
		item("z2", "two.example", "enable_routing", "auto", { dependsOn: ["z2:add_domain"] }),
		item("z3", "three.example", "add_domain", "done"),
		item("z3", "three.example", "catch_all", "auto"),
	];

	it("keeps the zones that fit and turns the rest into one manual 'needs Unlimited' item", () => {
		const out = limitPlanItems(items, 1, 1);
		expect(out.filter((i) => i.zoneId === "z1").map((i) => i.tier)).toEqual(["auto", "auto"]);
		const z2 = out.filter((i) => i.zoneId === "z2");
		expect(z2).toHaveLength(1);
		expect(z2[0]).toMatchObject({ id: "z2:add_domain", tier: "manual", title: "two.example needs an Unlimited licence" });
		expect(z2[0]!.dependsOn).toBeUndefined();
		// A zone already in the app keeps its steps; account items too.
		expect(out.filter((i) => i.zoneId === "z3")).toHaveLength(2);
		expect(out[0]!.id).toBe("account:worker_name");
	});

	it("nothing left: every new zone is blocked; unlimited leaves the plan alone", () => {
		expect(limitPlanItems(items, 0, 1).filter((i) => i.tier === "manual").map((i) => i.zoneId)).toEqual(["z1", "z2"]);
		expect(limitPlanItems(items, null, null)).toBe(items);
	});
});

describe("moving and upgrading through the licence server", () => {
	it("activate reports the deployment holding the licence, then moves it with takeover", async () => {
		let takeover = false;
		const server = fakeServer((_path, body) => {
			if (!body.takeover) {
				return { status: 409, body: { error: "activation_limit_reached", max_deployments: 1, active: [{ host_hint: "m***.old.example", last_seen_at: clock - 60, stale: false }] } };
			}
			takeover = true;
			return { status: 201, body: {} };
		});
		const input = { licenceKey: "LK-TEST-KEY-1234", host: HOST, cfAccount: null, appVersion: null };
		const first = await activateLicence(env, input, deps({ fetch: server.fetch }));
		expect(first).toMatchObject({
			ok: false,
			status: 422,
			error: "activation_limit_reached",
			inUse: { code: "activation_limit_reached", maxDeployments: 1, active: [{ hostHint: "m***.old.example", lastSeenAt: clock - 60, stale: false }] },
		});
		expect(server.calls[0]!.body.takeover).toBeUndefined();

		// Second attempt asks for the move; the token the server returns is checked as usual.
		const rec = await rpc.getLicence();
		const token = await mint({ deployment_id: rec.deploymentId, ...SOLO }, clock);
		const moving = fakeServer((_p, body) => (body.takeover ? { status: 201, body: { token, refresh_after: clock + DAY } } : { status: 500, body: {} }));
		const second = await activateLicence(env, { ...input, takeover: true }, deps({ fetch: moving.fetch }));
		expect(second.ok).toBe(true);
		expect(moving.calls[0]!.body).toMatchObject({ takeover: true, deployment_id: rec.deploymentId });
		expect(takeover).toBe(false);
	});

	it("explains the 24-hour takeover limit", async () => {
		const server = fakeServer(() => ({ status: 429, body: { error: "takeover_cooldown", retry_after: 3600 } }));
		const r = await activateLicence(env, { licenceKey: "LK-TEST-KEY-1234", host: HOST, cfAccount: null, appVersion: null, takeover: true }, deps({ fetch: server.fetch }));
		expect(r).toMatchObject({ ok: false, status: 422, error: "takeover_cooldown" });
		expect((r as { message: string }).message).toMatch(/less than 24 hours ago/);
	});

	it("upgrade sends the stored token and the return URLs, and hands back only an https checkout URL", async () => {
		await holdToken(SOLO);
		const server = fakeServer(() => ({ status: 200, body: { checkout_url: "https://test.checkout.dodopayments.com/session/cks_1" } }));
		const urls = { returnUrl: `https://${HOST}/settings/licence?upgrade=done`, cancelUrl: `https://${HOST}/settings/licence` };
		const r = await startLicenceUpgrade(env, urls, deps({ fetch: server.fetch }));
		expect(r).toEqual({ ok: true, checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_1" });
		expect(server.calls[0]).toMatchObject({ path: "/v1/licence/upgrade-checkout", body: { return_url: urls.returnUrl, cancel_url: urls.cancelUrl } });
		expect(server.calls[0]!.body.token).toBe((await rpc.getLicence()).token);

		const evil = fakeServer(() => ({ status: 200, body: { checkout_url: "javascript:alert(1)" } }));
		expect((await startLicenceUpgrade(env, urls, deps({ fetch: evil.fetch }))).ok).toBe(false);
	});

	it("upgrade on an Unlimited licence says so; a revoked answer is remembered", async () => {
		await holdToken(UNLIMITED);
		const urls = { returnUrl: `https://${HOST}/x`, cancelUrl: `https://${HOST}/y` };
		const no = fakeServer(() => ({ status: 409, body: { error: "not_upgradable" } }));
		expect(await startLicenceUpgrade(env, urls, deps({ fetch: no.fetch }))).toMatchObject({ ok: false, error: "not_upgradable", message: "This licence already covers unlimited domains." });
		const gone = fakeServer(() => ({ status: 410, body: { error: "revoked", reason: "instance_deactivated" } }));
		await startLicenceUpgrade(env, urls, deps({ fetch: gone.fetch }));
		expect((await licenceState(env, deps())).status).toBe("revoked");
	});

	it("needs a token", async () => {
		const r = await startLicenceUpgrade(env, { returnUrl: "https://x/", cancelUrl: "https://x/" }, deps());
		expect(r).toMatchObject({ ok: false, error: "no_token" });
	});
});
