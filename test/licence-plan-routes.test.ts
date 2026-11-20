/**
 * The Solo domain limit through the real Hono app: `POST /api/v1/domains`
 * (Settings, CLI, SDK) refuses a second domain with a clear message, the
 * Licence page lists what the plan covers, and inbound routing still serves
 * every configured domain. The licence state is stubbed to a Solo, Unlimited
 * or pre-plans token; the token logic itself is tested in licence-plan.test.ts.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LicenceClaims } from "../shared/licence-token";

let claims: Partial<LicenceClaims> | null = null;

vi.mock("../workers/lib/licence", async (importOriginal) => {
	const real = await importOriginal<typeof import("../workers/lib/licence")>();
	const state = () => ({
		status: "active" as const,
		locked: false,
		enforcement: "enforce" as const,
		record: { deploymentId: "dep_test", token: "t", lastRefreshAt: 1, failureCount: 0 } as never,
		claims: claims as LicenceClaims | null,
		verify: null,
		host: "mail.customer.example",
	});
	return {
		...real,
		licenceState: vi.fn(async () => state()),
		isLicenceLocked: vi.fn(async () => false),
		bootLicenceCheck: vi.fn(),
	};
});

const { app } = await import("../workers/index");
const { AuthStore } = await import("../workers/auth/store-core");
const { DomainStore } = await import("../workers/lib/domain-store");
const { isDomainAllowed, invalidateStoredDomains } = await import("../workers/lib/zones");
const { loadStoredDomains } = await import("../workers/routes/domains");

const SOLO = { plan: "solo", instances: 1, max_domains: 1, max_deployments: 1, customer: { id: "c", email: null }, bind: { host: "mail.customer.example", cf_account: null }, exp: 2_000_000_000 };
const UNLIMITED = { ...SOLO, plan: "unlimited", max_domains: null };
const LEGACY = { plan: "standard", instances: 3, customer: { id: "c", email: null }, bind: { host: "mail.customer.example", cf_account: null }, exp: 2_000_000_000 };

let store: InstanceType<typeof DomainStore>;
let authStore: Record<string, unknown>;

function makeEnv(extra: Record<string, unknown> = {}) {
	const rpc = new Proxy({}, { get: (_t, name: string) => async (...args: unknown[]) => (store as any)[name](...args) });
	authStore = { idFromName: () => "global", get: () => rpc };
	return {
		AUTH_MODE: "access",
		LICENCE_ENFORCEMENT: "enforce",
		AUTH_STORE: authStore,
		BUCKET: { head: async () => null, get: async () => null, put: async () => {}, list: async () => ({ objects: [], truncated: false }) },
		MAILBOX: { idFromName: (n: string) => n, get: () => ({ getFolders: async () => [] }) },
		EMAIL_ADDRESSES: [],
		DOMAINS: "",
		...extra,
	} as never;
}

const JSON_HEADERS = { "content-type": "application/json" };
const addDomain = (env: never, hostname: string) =>
	app.request("/api/v1/domains", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ hostname }) }, env);

beforeEach(() => {
	const db = new DatabaseSync(":memory:");
	const sql = {
		exec(query: string, ...bindings: unknown[]) {
			const rows = db.prepare(query).all(...(bindings as never[])) as any[];
			return { toArray: () => rows };
		},
	};
	const tx = <T,>(fn: () => T) => fn();
	new AuthStore(sql, tx);
	store = new DomainStore(sql, tx);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("POST /api/v1/domains and the plan", () => {
	it("Solo: the first domain is added, the second is refused with an upgrade pointer", async () => {
		claims = SOLO;
		const env = makeEnv();
		expect((await addDomain(env, "first.example")).status).toBe(201);
		const res = await addDomain(env, "second.example");
		expect(res.status).toBe(403);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ code: "plan_domain_limit", maxDomains: 1, used: 1, upgradeUrl: "/settings/licence" });
		expect(String(body.error)).toMatch(/Upgrade to Unlimited/);
		expect(store.listDomains().map((d) => d.hostname)).toEqual(["first.example"]);
	});

	it("Solo with a domain from DOMAINS: no second domain", async () => {
		claims = SOLO;
		expect((await addDomain(makeEnv({ DOMAINS: "env.example" }), "other.example")).status).toBe(403);
	});

	it("Unlimited and a token from before plans add as many as they like", async () => {
		for (const c of [UNLIMITED, LEGACY]) {
			claims = c;
			const env = makeEnv();
			for (const h of ["a.example", "b.example", "c.example"]) expect((await addDomain(env, `${c.plan}-${h}`)).status).toBe(201);
		}
	});

	it("never stops serving a domain past the limit: inbound still accepts it", async () => {
		claims = SOLO;
		const env = makeEnv({ DOMAINS: "one.example,two.example" });
		invalidateStoredDomains(env);
		await loadStoredDomains(env);
		expect(isDomainAllowed(env, "one.example")).toBe(true);
		expect(isDomainAllowed(env, "two.example")).toBe(true);
	});
});

describe("GET /api/v1/licence and the plan", () => {
	it("shows the plan, its limits and the domains it doesn't cover", async () => {
		claims = SOLO;
		const env = makeEnv({ DOMAINS: "one.example,two.example" });
		const res = await app.request("/api/v1/licence", {}, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			planName: "solo",
			maxDomains: 1,
			maxDeployments: 1,
			upgradeAvailable: true,
			domains: { configured: ["one.example", "two.example"], notCovered: ["two.example"] },
		});
	});

	it("Unlimited: no domain list needed, no upgrade", async () => {
		claims = UNLIMITED;
		const body = (await (await app.request("/api/v1/licence", {}, makeEnv())).json()) as Record<string, unknown>;
		expect(body).toMatchObject({ planName: "unlimited", maxDomains: null, upgradeAvailable: false });
		expect(body.domains).toBeUndefined();
	});
});
