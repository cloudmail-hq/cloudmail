/**
 * The deployment origin (`workers/lib/deployment-origin.ts`, AuthDO migration
 * `0024_deployment_origin`): resolution order, which origins may be recorded,
 * persistence and change detection, cron sends with no origin, and a static
 * check that no runtime path names the vendor's host.
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_MIGRATION_NAMES, AuthStore, type AuthSql } from "../workers/auth/store-core";
import { DeploymentOriginStore } from "../workers/lib/deployment-origin-store";
import {
	ORIGIN_CACHE_MS,
	deploymentOrigin,
	originRank,
	recordDeploymentOrigin,
	resetDeploymentOriginCache,
	resetNoOriginWarning,
	type DeploymentOriginRpc,
} from "../workers/lib/deployment-origin";
import { dispatchDueSequenceEmails } from "../workers/lib/sequence-dispatch";
import { buildUnsubscribeLink } from "../workers/lib/suppressions";
import { authStoreBinding, fakeBucket } from "./helpers/suppression-store";
import type { Env } from "../workers/types";

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

let store: DeploymentOriginStore;
let rpc: DeploymentOriginRpc & { reads: number; writes: number };
let env: Env;
let clock: number;

beforeEach(() => {
	const db = new DatabaseSync(":memory:");
	const { sql, tx } = adapter(db);
	new AuthStore(sql, tx); // runs the migrations
	store = new DeploymentOriginStore(sql, tx);
	rpc = {
		reads: 0,
		writes: 0,
		async getDeploymentOrigin() {
			rpc.reads++;
			const r = store.get();
			return r ? { origin: r.origin, rank: r.rank } : null;
		},
		async recordDeploymentOrigin(origin, rank, source, now) {
			rpc.writes++;
			return store.record(origin, rank, source, now);
		},
	};
	env = { AUTH_STORE: {} } as unknown as Env;
	clock = 1_000_000;
	resetDeploymentOriginCache(env);
});

const deps = () => ({ rpc, now: () => clock });

describe("migration", () => {
	it("is appended after 0023_dns_change_log", () => {
		const i = AUTH_MIGRATION_NAMES.indexOf("0024_deployment_origin");
		expect(i).toBe(AUTH_MIGRATION_NAMES.indexOf("0023_dns_change_log") + 1);
	});
});

describe("resolution order", () => {
	it("APP_URL, then the stored origin, then nothing", async () => {
		expect(await deploymentOrigin(env, deps())).toBeNull();

		await recordDeploymentOrigin(env, "https://mail.customer.example/inbox", "request", deps());
		expect(await deploymentOrigin(env, deps())).toBe("https://mail.customer.example");

		const configured = { ...env, APP_URL: "https://configured.example/path" } as Env;
		expect(await deploymentOrigin(configured, deps())).toBe("https://configured.example");
	});

	it("ignores an APP_URL that is not a valid http(s) URL", async () => {
		const bad = { AUTH_STORE: {}, APP_URL: "ftp://x" } as unknown as Env;
		expect(await deploymentOrigin(bad, { rpc: null })).toBeNull();
	});

	it("returns null, not a vendor host, when the store is unreachable", async () => {
		const broken: DeploymentOriginRpc = {
			getDeploymentOrigin: async () => {
				throw new Error("down");
			},
			recordDeploymentOrigin: async () => {
				throw new Error("down");
			},
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await deploymentOrigin(env, { rpc: broken })).toBeNull();
		vi.restoreAllMocks();
	});
});

describe("which origins count", () => {
	it("https only; http is refused except localhost", () => {
		expect(originRank("http://mail.customer.example/")).toBeNull();
		expect(originRank("https://mail.customer.example/")).toEqual({ origin: "https://mail.customer.example", rank: 2 });
		expect(originRank("https://app.acct.workers.dev/")).toEqual({ origin: "https://app.acct.workers.dev", rank: 1 });
		expect(originRank("http://localhost:5173/")).toEqual({ origin: "http://localhost:5173", rank: 0 });
		expect(originRank("not a url")).toBeNull();
	});

	it("records http only never", async () => {
		await recordDeploymentOrigin(env, "http://mail.customer.example/", "request", deps());
		expect(store.get()).toBeNull();
	});

	it("localhost or workers.dev only when nothing better was ever seen", async () => {
		await recordDeploymentOrigin(env, "http://localhost:5173/", "request", deps());
		expect(store.get()?.origin).toBe("http://localhost:5173");

		clock += ORIGIN_CACHE_MS;
		await recordDeploymentOrigin(env, "https://app.acct.workers.dev/", "request", deps());
		expect(store.get()?.origin).toBe("https://app.acct.workers.dev");

		clock += ORIGIN_CACHE_MS;
		await recordDeploymentOrigin(env, "https://mail.customer.example/", "request", deps());
		expect(store.get()?.origin).toBe("https://mail.customer.example");

		// Visiting on workers.dev or localhost again never displaces the custom domain.
		clock += ORIGIN_CACHE_MS;
		await recordDeploymentOrigin(env, "https://app.acct.workers.dev/", "request", deps());
		await recordDeploymentOrigin(env, "http://localhost:5173/", "request", deps());
		expect(store.get()?.origin).toBe("https://mail.customer.example");
	});

	it("the store itself refuses a downgrade, whatever an isolate's cache says", () => {
		store.record("https://mail.customer.example", 2, "request", 1);
		expect(store.record("https://app.acct.workers.dev", 1, "request", 2)).toEqual({
			origin: "https://mail.customer.example",
			changed: false,
		});
	});
});

describe("persistence and change detection", () => {
	it("writes once, then not again while the origin is unchanged", async () => {
		await recordDeploymentOrigin(env, "https://mail.customer.example/a", "request", deps());
		await recordDeploymentOrigin(env, "https://mail.customer.example/b", "request", deps());
		await recordDeploymentOrigin(env, "https://mail.customer.example/c", "request", deps());
		expect(rpc.writes).toBe(1);
		// The cache answers reads inside the window.
		expect(rpc.reads).toBe(1);
	});

	it("refreshes when the custom domain changes", async () => {
		await recordDeploymentOrigin(env, "https://old.customer.example/", "request", deps());
		clock += ORIGIN_CACHE_MS;
		await recordDeploymentOrigin(env, "https://new.customer.example/", "request", deps());
		expect(store.get()?.origin).toBe("https://new.customer.example");
		expect(await deploymentOrigin(env, deps())).toBe("https://new.customer.example");
	});

	it("survives a new isolate (the row is in the AuthDO)", async () => {
		await recordDeploymentOrigin(env, "https://mail.customer.example/", "setup", deps());
		resetDeploymentOriginCache(env);
		expect(await deploymentOrigin(env, deps())).toBe("https://mail.customer.example");
		expect(store.get()?.source).toBe("setup");
	});
});

describe("only trusted requests record the origin", () => {
	const app = readFileSync(join(__dirname, "../workers/app.ts"), "utf8");
	const routes = readFileSync(join(__dirname, "../workers/auth/routes.ts"), "utf8");

	it("the recorder runs after the auth gate and only for a session or Access identity", () => {
		const gate = app.indexOf('app.use("*", createAuthGate(authDeps));');
		const rec = app.indexOf('recordDeploymentOrigin(c.env, c.req.url, "request")');
		expect(gate).toBeGreaterThan(-1);
		expect(rec).toBeGreaterThan(gate);
		const block = app.slice(gate, rec);
		expect(block).toMatch(/method === "session" \|\| method === "access"\) && c\.var\.accessIdentity/);
		expect(app.match(/recordDeploymentOrigin\(/g)).toHaveLength(1);
	});

	it("/setup records it only after the setup token and owner creation succeed", () => {
		const start = routes.indexOf('routes.post("/setup"');
		const end = routes.indexOf('routes.post("/login"');
		const setup = routes.slice(start, end);
		const rec = setup.indexOf('recordDeploymentOrigin(c.env, c.req.url, "setup")');
		expect(rec).toBeGreaterThan(setup.indexOf("secretsEqual"));
		expect(rec).toBeGreaterThan(setup.indexOf("if (!result.ok)"));
		expect(routes.match(/recordDeploymentOrigin\(/g)).toHaveLength(1);
	});
});

describe("cron sends with no origin", () => {
	function sequenceEnv(appUrl?: string) {
		const { AUTH_STORE } = authStoreBinding();
		const bucket = fakeBucket();
		const now = Math.floor(Date.now() / 1000);
		bucket.store.set("sequences/seq-1.json", JSON.stringify({ id: "seq-1", name: "Onboarding", steps: [], createdAt: 0, updatedAt: 0 }));
		bucket.store.set("templates/welcome.json", JSON.stringify({ id: "w", slug: "welcome", name: "w", subject: "Hi", bodyHtml: '<p>Hello <a href="https://example.org/x">x</a> {{unsubscribe_url}}</p>', createdAt: 0, updatedAt: 0 }));
		bucket.store.set("sequence-enrollments/enr-1.json", JSON.stringify({ id: "enr-1", sequenceId: "seq-1", personId: "p", personEmail: "reader@example.org", personName: null, fromAddress: "hello@product.dev", status: "active", variables: {}, enrolledAt: now, cancelledAt: null }));
		bucket.store.set("sequence-emails/s1.json", JSON.stringify({ id: "s1", enrollmentId: "enr-1", stepOrder: 1, templateSlug: "welcome", scheduledAt: now - 60, status: "pending", sentAt: null, sentEmailId: null }));
		const sent: any[] = [];
		const e = {
			AUTH_STORE,
			BUCKET: bucket,
			UNSUBSCRIBE_SECRET: "s",
			...(appUrl ? { APP_URL: appUrl } : {}),
			MAILBOX: {
				idFromName: (n: string) => n,
				get: () => ({
					checkSendRateLimit: async () => null,
					createEmail: async () => {},
					recordDelivery: async () => {},
					getTrackingSettings: async () => ({ openTracking: true, clickTracking: true, attachmentTracking: false }),
					getOrCreateTrackingSecret: async () => "tracking-secret",
				}),
			},
			EMAIL: { send: async (m: unknown) => (sent.push(m), { messageId: "p" }) },
		} as unknown as Env;
		return { env: e, sent };
	}

	it("skips tracking and unsubscribe instrumentation, sends anyway, and warns once", async () => {
		resetNoOriginWarning();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { env: e, sent } = sequenceEnv();
		expect((await dispatchDueSequenceEmails(e)).sent).toBe(1);
		const m = sent[0];
		expect(m.html).not.toContain("/t/o/");
		expect(m.html).not.toContain("/t/c/");
		expect(m.html).not.toContain("/u/");
		expect(m.html).not.toContain("{{unsubscribe_url}}");
		expect(m.headers?.["List-Unsubscribe"]).toBeUndefined();
		expect(JSON.stringify(m)).not.toContain("tapetide.com");
		expect(warn.mock.calls.filter((c) => String(c[0]).includes("No deployment origin"))).toHaveLength(1);
		vi.restoreAllMocks();
	});

	it("instruments normally once an origin is known", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { env: e, sent } = sequenceEnv("https://mail.customer.example");
		expect((await dispatchDueSequenceEmails(e)).sent).toBe(1);
		expect(sent[0].html).toContain("https://mail.customer.example/t/o/");
		expect(sent[0].headers["List-Unsubscribe"]).toMatch(/^<https:\/\/mail\.customer\.example\/u\//);
		vi.restoreAllMocks();
	});

	it("buildUnsubscribeLink returns null rather than another host", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { AUTH_STORE } = authStoreBinding();
		const e = { AUTH_STORE, UNSUBSCRIBE_SECRET: "s" } as unknown as Env;
		expect(await buildUnsubscribeLink(e, { recipient: "r@example.org", fromAddress: "a@product.dev" })).toBeNull();
		vi.restoreAllMocks();
	});
});

/**
 * No runtime code path may name the vendor's host. Comments may (the template
 * build rewrites docs), and so may dev-only fixtures. The check strips
 * comments, then fails on any remaining `tapetide.com`.
 */
describe("no runtime path names tapetide.com", () => {
	const root = join(__dirname, "..");
	/** Files whose code (not just comments) may mention it, with the reason. */
	const ALLOW = new Map<string, string>([
		// Dev-only analytics fixtures, imported behind `import.meta.env.DEV`.
		["app/components/analytics/fixtures.ts", "dev-only fixtures"],
	]);
	/**
	 * Exact lines naming the vendor's OWN services, which every deployment
	 * talks to on purpose: the licence server, the purchase portal and the
	 * licence token issuer. None stands in for this deployment's host. Exact
	 * text, so a new mention anywhere else still fails.
	 */
	const VENDOR_SERVICE_LINES: [string, string][] = [
		["workers/lib/licence.ts", 'export const DEFAULT_LICENCE_SERVER_URL = "https://licence.tapetide.com";'],
		["workers/lib/licence.ts", 'export const LICENCE_MANAGE_URL = "https://tapetide.com/account";'],
		["shared/licence-token.ts", 'export const TOKEN_ISSUER = "https://tapetide.com";'],
		["app/components/licence/LicenceParts.tsx", 'export const BUY_URL = "https://tapetide.com/cloudmail";'],
	];

	function walk(dir: string): string[] {
		return readdirSync(dir).flatMap((name) => {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) return walk(p);
			return /\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith(".d.ts") ? [p] : [];
		});
	}

	/** Remove // and /* *\/ comments, keeping strings and template literals intact. */
	function stripComments(src: string): string {
		let out = "";
		let i = 0;
		while (i < src.length) {
			const c = src[i];
			const n = src[i + 1];
			if (c === '"' || c === "'" || c === "`") {
				let j = i + 1;
				while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
				out += src.slice(i, j + 1);
				i = j + 1;
			} else if (c === "/" && n === "/") {
				while (i < src.length && src[i] !== "\n") i++;
			} else if (c === "/" && n === "*") {
				const end = src.indexOf("*/", i + 2);
				i = end === -1 ? src.length : end + 2;
			} else {
				out += c;
				i++;
			}
		}
		return out;
	}

	it("in workers/, shared/ and app/", () => {
		const offenders: string[] = [];
		for (const dir of ["workers", "shared", "app"]) {
			for (const file of walk(join(root, dir))) {
				const rel = relative(root, file);
				if (ALLOW.has(rel)) continue;
				const code = stripComments(readFileSync(file, "utf8"));
				code.split("\n").forEach((line, i) => {
					const t = line.trim();
					if (!/tapetide\.com/i.test(t)) return;
					if (VENDOR_SERVICE_LINES.some(([f, l]) => f === rel && l === t)) return;
					offenders.push(`${rel}:${i + 1}: ${t.slice(0, 120)}`);
				});
			}
		}
		expect(offenders).toEqual([]);
	});

	it("the comment stripper keeps strings that look like comments", () => {
		expect(stripComments('const a = "https://x.test"; // tapetide.com')).toBe('const a = "https://x.test"; ');
		expect(stripComments("/* tapetide.com */ const b = 1;")).toBe(" const b = 1;");
	});
});
