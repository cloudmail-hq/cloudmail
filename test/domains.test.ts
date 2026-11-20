/**
 * Multi-domain management: zone union, DNS audit parsing, inbound routing
 * (alias + catch-all), the Cloudflare client's request shapes, idempotent
 * provisioning, and the domain store against real SQLite.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore, type AuthSql } from "../workers/auth/store-core";
import { CloudflareClient, cloudflareClientFromEnv, workerScriptName } from "../workers/lib/cloudflare-api";
import {
	answerKey,
	auditDomain,
	auditQueries,
	decodeTxt,
	evaluateAudit,
	expectedRecords,
	manualSteps,
	parseDohResponse,
	type DnsAnswers,
} from "../workers/lib/dns-audit";
import { describeCatchAll, dkimFromSending, provisionDomain, statusAfterProvision } from "../workers/lib/domain-provision";
import { DomainStore, withoutRealMailboxes } from "../workers/lib/domain-store";
import {
	resolveInboundMailbox,
	ROUTING_LOOKUP_TIMEOUT_MS,
	selectTargetAddress,
	withTimeout,
	type InboundRoutingDeps,
	type RoutingLookup,
} from "../workers/lib/inbound-routing";
import { validateSender, SenderValidationError } from "../workers/lib/email-helpers";
import {
	getEnvZones,
	getZones,
	invalidateStoredDomains,
	isDomainAllowed,
	mergeZones,
	refreshStoredDomains,
	setStoredDomains,
	STORED_DOMAINS_TTL_MS,
} from "../workers/lib/zones";
import type { Env } from "../workers/types";

// -- helpers ----------------------------------------------------------------------

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

/** A fresh env object; the AUTH_STORE identity keys the stored-domain cache. */
const env = (vars: Record<string, unknown> = {}) => ({ AUTH_STORE: {}, ...vars }) as unknown as Env;

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };

/** fetch mock that records calls and answers from a route table. */
function mockFetch(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
	const calls: Call[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const call: Call = {
			url,
			method,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
			headers: (init?.headers ?? {}) as Record<string, string>,
		};
		calls.push(call);
		const path = url.replace("https://api.cloudflare.com/client/v4", "");
		const key = Object.keys(routes).find((k) => {
			const [m, p] = k.split(" ");
			return m === method && (p === path || (p.endsWith("*") && path.startsWith(p.slice(0, -1))));
		});
		if (!key) return new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: `no route ${method} ${path}` }] }), { status: 404 });
		const { status = 200, body } = routes[key](call);
		return new Response(JSON.stringify(body), { status });
	});
	return { impl: impl as unknown as typeof fetch, calls };
}

const ok = (result: unknown) => ({ body: { success: true, errors: [], result } });

// -- zones union ------------------------------------------------------------------

describe("zone union", () => {
	it("keeps env domains first and appends stored ones", () => {
		const zones = mergeZones(getEnvZones(env({ DOMAINS: "tapetide.com" })), [
			{ hostname: "producta.com", displayName: "Product A", zoneId: "z1" },
			{ hostname: "tapetide.com", displayName: "tapetide.com", zoneId: null },
		]);
		expect(zones.map((z) => z.domain)).toEqual(["tapetide.com", "producta.com"]);
		expect(zones[1]).toEqual({ id: "producta.com", domain: "producta.com", name: "Product A", zoneId: "z1" });
	});

	it("lets a stored row fill the name and zone id env left unset, never override them", () => {
		const fromDomains = mergeZones(getEnvZones(env({ DOMAINS: "a.com" })), [
			{ hostname: "a.com", displayName: "Alpha", zoneId: "zz" },
		]);
		expect(fromDomains[0]).toMatchObject({ name: "Alpha", zoneId: "zz" });

		const fromZones = mergeZones(
			getEnvZones(env({ ZONES: JSON.stringify([{ domain: "a.com", name: "Env name", zoneId: "env" }]) })),
			[{ hostname: "a.com", displayName: "DB name", zoneId: "db" }],
		);
		expect(fromZones[0]).toMatchObject({ name: "Env name", zoneId: "env" });
	});

	it("getZones serves env only until stored domains are loaded", async () => {
		const e = env({ DOMAINS: "tapetide.com" });
		expect(getZones(e).map((z) => z.domain)).toEqual(["tapetide.com"]);
		expect(isDomainAllowed(e, "producta.com")).toBe(false);

		await refreshStoredDomains(e, async () => [{ hostname: "producta.com", displayName: "A", zoneId: null }]);
		expect(getZones(e).map((z) => z.domain)).toEqual(["tapetide.com", "producta.com"]);
		expect(isDomainAllowed(e, "PRODUCTA.com")).toBe(true);
	});

	it("caches within the TTL, reloads after it or on invalidate", async () => {
		const e = env();
		const load = vi.fn(async () => [{ hostname: "x.com", displayName: "x.com", zoneId: null }]);
		await refreshStoredDomains(e, load, 1000);
		await refreshStoredDomains(e, load, 1000 + STORED_DOMAINS_TTL_MS - 1);
		expect(load).toHaveBeenCalledTimes(1);
		await refreshStoredDomains(e, load, 1000 + STORED_DOMAINS_TTL_MS);
		expect(load).toHaveBeenCalledTimes(2);
		invalidateStoredDomains(e);
		await refreshStoredDomains(e, load, 1000 + STORED_DOMAINS_TTL_MS);
		expect(load).toHaveBeenCalledTimes(3);
	});

	it("a failed load keeps env domains and the last good list", async () => {
		const e = env({ DOMAINS: "tapetide.com" });
		setStoredDomains(e, [{ hostname: "b.com", displayName: "b.com", zoneId: null }], 0);
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		await refreshStoredDomains(e, async () => { throw new Error("DO down"); }, STORED_DOMAINS_TTL_MS + 1);
		spy.mockRestore();
		expect(getZones(e).map((z) => z.domain)).toEqual(["tapetide.com", "b.com"]);
	});

	it("an empty config still allows every domain (existing dev behaviour)", () => {
		expect(isDomainAllowed(env(), "anything.dev")).toBe(true);
	});
});

// -- DNS audit --------------------------------------------------------------------

describe("DoH parsing", () => {
	it("joins quoted TXT chunks and unescapes", () => {
		expect(decodeTxt('"v=DKIM1; k=rsa; " "p=ABC"')).toBe("v=DKIM1; k=rsa; p=ABC");
		expect(decodeTxt('"say \\"hi\\""')).toBe('say "hi"');
		expect(decodeTxt("unquoted")).toBe("unquoted");
	});

	it("normalises MX answers and drops chained CNAMEs", () => {
		const body = {
			Status: 0,
			Answer: [
				{ name: "a.com.", type: 5, data: "alias.a.com." },
				{ name: "a.com.", type: 15, data: "13 Route1.MX.Cloudflare.net." },
			],
		};
		expect(parseDohResponse(body, "MX")).toEqual(["13 route1.mx.cloudflare.net"]);
	});

	it("treats NXDOMAIN as empty and SERVFAIL as an error", () => {
		expect(parseDohResponse({ Status: 3 }, "TXT")).toEqual([]);
		expect(() => parseDohResponse({ Status: 2 }, "TXT")).toThrow();
	});
});

const HOST = "producta.com";
function healthyAnswers(): DnsAnswers {
	const q = (name: string, type: "MX" | "TXT") => answerKey(name, type);
	const mx = ["13 route1.mx.cloudflare.net", "24 route2.mx.cloudflare.net", "86 route3.mx.cloudflare.net"];
	return {
		[q(HOST, "MX")]: mx,
		[q(HOST, "TXT")]: ["v=spf1 include:_spf.mx.cloudflare.net ~all", "google-site-verification=x"],
		[q(`cf2024-1._domainkey.${HOST}`, "TXT")]: ["v=DKIM1; h=sha256; k=rsa; p=MIIB"],
		[q(`cf-bounce.${HOST}`, "MX")]: mx,
		[q(`cf-bounce.${HOST}`, "TXT")]: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
		[q(`cf-bounce._domainkey.${HOST}`, "TXT")]: ["v=DKIM1; p=MIIC"],
		[q(`_dmarc.${HOST}`, "TXT")]: [],
	};
}
const byId = (audit: ReturnType<typeof evaluateAudit>, id: string) => audit.checks.find((c) => c.id === id)!;

describe("DNS audit", () => {
	it("passes a fully configured domain; missing DMARC is only a warning", () => {
		const audit = evaluateAudit(HOST, healthyAnswers(), { now: 1 });
		expect(audit.checks.map((c) => [c.id, c.status])).toEqual([
			["mx", "pass"],
			["spf", "pass"],
			["dkim", "pass"],
			["bounce_mx", "pass"],
			["bounce_spf", "pass"],
			["sending_dkim", "pass"],
			["dmarc", "warn"],
		]);
		expect(byId(audit, "dmarc").expected).toBe("v=DMARC1; p=reject;");
		expect(audit.summary).toBe("warn");
	});

	it("warns, not fails, when DMARC already exists, and does not drag the summary down", () => {
		const a = healthyAnswers();
		a[answerKey(`_dmarc.${HOST}`, "TXT")] = ["v=DMARC1; p=none; rua=mailto:x@y"];
		const audit = evaluateAudit(HOST, a);
		expect(byId(audit, "dmarc").status).toBe("warn");
		expect(byId(audit, "dmarc").message).toMatch(/already exists/);
		expect(audit.summary).toBe("pass");
	});

	it("fails duplicate DMARC and duplicate SPF", () => {
		const a = healthyAnswers();
		a[answerKey(`_dmarc.${HOST}`, "TXT")] = ["v=DMARC1; p=none", "v=DMARC1; p=reject"];
		a[answerKey(HOST, "TXT")] = ["v=spf1 include:_spf.mx.cloudflare.net ~all", "v=spf1 include:other ~all"];
		const audit = evaluateAudit(HOST, a);
		expect(byId(audit, "dmarc").status).toBe("fail");
		expect(byId(audit, "spf").status).toBe("fail");
		expect(audit.summary).toBe("fail");
	});

	it("warns when SPF is missing the Cloudflare include, fails when absent", () => {
		const a = healthyAnswers();
		a[answerKey(HOST, "TXT")] = ["v=spf1 include:_spf.google.com ~all"];
		expect(byId(evaluateAudit(HOST, a), "spf")).toMatchObject({ status: "warn", message: expect.stringMatching(/missing include:_spf\.mx\.cloudflare\.net/) });
		a[answerKey(HOST, "TXT")] = [];
		expect(byId(evaluateAudit(HOST, a), "spf").status).toBe("fail");
	});

	it("fails MX on another provider, warns on a mix", () => {
		const a = healthyAnswers();
		a[answerKey(HOST, "MX")] = ["1 aspmx.l.google.com"];
		expect(byId(evaluateAudit(HOST, a), "mx").status).toBe("fail");
		a[answerKey(HOST, "MX")] = ["1 aspmx.l.google.com", "13 route1.mx.cloudflare.net"];
		expect(byId(evaluateAudit(HOST, a), "mx").status).toBe("warn");
	});

	it("fails a revoked (empty) DKIM key", () => {
		const a = healthyAnswers();
		a[answerKey(`cf2024-1._domainkey.${HOST}`, "TXT")] = ["v=DKIM1; p="];
		expect(byId(evaluateAudit(HOST, a), "dkim").status).toBe("fail");
	});

	it("reports a failed lookup as warn, never fail", () => {
		const a = healthyAnswers();
		a[answerKey(HOST, "MX")] = null;
		expect(byId(evaluateAudit(HOST, a), "mx")).toMatchObject({ status: "warn", message: expect.stringMatching(/Could not check/) });
	});

	it("uses the sending DKIM selector Cloudflare reported", () => {
		expect(auditQueries(HOST, "sel1").map((q) => q.name)).toContain(`sel1._domainkey.${HOST}`);
	});

	it("queries DoH with the json accept header", async () => {
		const seen: { url: string; accept: string | undefined }[] = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			seen.push({ url, accept: (init?.headers as Record<string, string>)?.accept });
			return new Response(JSON.stringify({ Status: 3 }), { status: 200 });
		}) as unknown as typeof fetch;
		const audit = await auditDomain(HOST, { fetchImpl });
		expect(seen).toHaveLength(7);
		expect(seen[0].url).toBe(`https://cloudflare-dns.com/dns-query?name=${HOST}&type=MX`);
		expect(seen.every((s) => s.accept === "application/dns-json")).toBe(true);
		expect(byId(audit, "mx").status).toBe("fail");
	});

	it("lists every record a manual operator needs", () => {
		const records = expectedRecords(HOST);
		expect(records.filter((r) => r.type === "MX" && r.name === HOST).map((r) => r.value)).toEqual([
			"route1.mx.cloudflare.net",
			"route2.mx.cloudflare.net",
			"route3.mx.cloudflare.net",
		]);
		expect(records.some((r) => r.name === `cf-bounce.${HOST}` && r.type === "TXT" && r.value.includes("include:_spf.mx.cloudflare.net"))).toBe(true);
		expect(records.find((r) => r.purpose === "dmarc")).toMatchObject({ name: `_dmarc.${HOST}`, value: "v=DMARC1; p=reject;" });
		expect(manualSteps(HOST, "my-worker").join("\n")).toMatch(/Send to a Worker" → my-worker/);
	});

	it("prefers the sending records Cloudflare returned over the template", () => {
		const records = expectedRecords(HOST, {
			sendingDns: [{ purpose: "sending", type: "TXT", name: `x._domainkey.${HOST}`, value: "v=DKIM1; p=REAL" }],
		});
		expect(records.filter((r) => r.purpose === "sending")).toEqual([
			{ purpose: "sending", type: "TXT", name: `x._domainkey.${HOST}`, value: "v=DKIM1; p=REAL" },
		]);
	});
});

// -- inbound routing --------------------------------------------------------------

describe("inbound routing", () => {
	const mailboxes = new Set(["support@tapetide.com", "hello@producta.com", "catch@productb.com", "alice@tapetide.com"]);
	const table: RoutingLookup = {
		aliases: { "support@producta.com": "support@tapetide.com", "support@productb.com": "support@tapetide.com" },
		catchAll: { "productb.com": "catch@productb.com" },
	};
	const deps = (over: Partial<InboundRoutingDeps> = {}): InboundRoutingDeps => ({
		mailboxExists: async (a) => mailboxes.has(a),
		lookup: async () => table,
		isServed: (d) => ["tapetide.com", "producta.com", "productb.com"].includes(d),
		...over,
	});

	it("delivers to an exact mailbox", async () => {
		expect(await resolveInboundMailbox(["Hello@ProductA.com"], deps())).toEqual({
			mailboxId: "hello@producta.com",
			deliveredTo: "hello@producta.com",
			via: "direct",
		});
	});

	it("delivers an alias on another domain into its mailbox", async () => {
		expect(await resolveInboundMailbox(["support@producta.com"], deps())).toEqual({
			mailboxId: "support@tapetide.com",
			deliveredTo: "support@producta.com",
			via: "alias",
		});
	});

	it("falls back to the domain catch-all for unknown addresses", async () => {
		expect(await resolveInboundMailbox(["nobody@productb.com"], deps())).toMatchObject({ mailboxId: "catch@productb.com", via: "catch_all" });
	});

	it("drops unknown addresses on a domain without a catch-all", async () => {
		expect(await resolveInboundMailbox(["nobody@producta.com"], deps())).toBeNull();
	});

	it("routes only on the envelope recipient when it is on a served domain", async () => {
		// Envelope: an unknown address. Header: alice, a real mailbox. Must not
		// land in alice's inbox just because the sender also listed her.
		expect(await resolveInboundMailbox(["nobody@producta.com", "alice@tapetide.com"], deps())).toBeNull();
		// Envelope: an alias. Header: alice. The alias wins.
		expect(await resolveInboundMailbox(["support@producta.com", "alice@tapetide.com"], deps())).toMatchObject({
			mailboxId: "support@tapetide.com",
			via: "alias",
		});
	});

	it("falls back to header addresses only when the envelope is unserved or missing", async () => {
		expect(await resolveInboundMailbox(["fwd@elsewhere.net", "alice@tapetide.com"], deps())).toMatchObject({ mailboxId: "alice@tapetide.com" });
		expect(selectTargetAddress(["fwd@elsewhere.net", "alice@tapetide.com"], (d) => d === "tapetide.com")).toBe("alice@tapetide.com");
	});

	it("never consults the AuthDO for an exact mailbox", async () => {
		const lookup = vi.fn(async () => table);
		await resolveInboundMailbox(["hello@producta.com"], deps({ lookup }));
		expect(lookup).not.toHaveBeenCalled();
	});

	it("propagates a failed alias lookup instead of misrouting", async () => {
		const lookup = async () => {
			throw new Error("AuthDO unavailable");
		};
		await expect(resolveInboundMailbox(["support@producta.com", "alice@tapetide.com"], deps({ lookup }))).rejects.toThrow(
			"AuthDO unavailable",
		);
	});

	it("times out a hung lookup", async () => {
		vi.useFakeTimers();
		try {
			const hung = withTimeout(new Promise<never>(() => {}), ROUTING_LOOKUP_TIMEOUT_MS, "Alias/catch-all lookup");
			const assertion = expect(hung).rejects.toThrow(/timed out after 5000 ms/);
			await vi.advanceTimersByTimeAsync(ROUTING_LOOKUP_TIMEOUT_MS);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	it("ignores recipients on domains this deployment does not serve", async () => {
		expect(await resolveInboundMailbox(["support@other.com"], deps({ lookup: async () => ({ aliases: { "support@other.com": "support@tapetide.com" }, catchAll: {} }) }))).toBeNull();
	});

	it("ignores an alias or catch-all pointing at a deleted mailbox", async () => {
		expect(await resolveInboundMailbox(["a@producta.com"], deps({ lookup: async () => ({ aliases: { "a@producta.com": "gone@tapetide.com" }, catchAll: {} }) }))).toBeNull();
		expect(await resolveInboundMailbox(["a@productb.com"], deps({ lookup: async () => ({ aliases: {}, catchAll: { "productb.com": "gone@productb.com" } }) }))).toBeNull();
	});

	it("EMAIL_ADDRESSES keeps the old behaviour: exact mailboxes only", async () => {
		const lookup = vi.fn(async () => table);
		const restricted = deps({ allowedAddresses: ["hello@producta.com"], lookup });
		expect(await resolveInboundMailbox(["support@producta.com"], restricted)).toBeNull();
		expect(await resolveInboundMailbox(["x@y.com", "hello@producta.com"], restricted)).toMatchObject({ via: "direct" });
		expect(lookup).not.toHaveBeenCalled();
	});
});

describe("stale aliases", () => {
	it("drops an alias that has become a real mailbox", async () => {
		const real = new Set(["sales@tapetide.com"]);
		expect(
			await withoutRealMailboxes(["sales@tapetide.com", "sales@producta.com"], async (a) => real.has(a)),
		).toEqual(["sales@producta.com"]);
	});
});

describe("strict stored-domain refresh", () => {
	it("throws when nothing was ever loaded, keeps a stale list otherwise", async () => {
		const e = env();
		await expect(
			refreshStoredDomains(e, async () => { throw new Error("down"); }, 0, { strict: true }),
		).rejects.toThrow("down");
		setStoredDomains(e, [{ hostname: "b.com", displayName: "b.com", zoneId: null }], 0);
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		await refreshStoredDomains(e, async () => { throw new Error("down"); }, STORED_DOMAINS_TTL_MS + 1, { strict: true });
		spy.mockRestore();
		expect(getZones(e).map((z) => z.domain)).toEqual(["b.com"]);
	});
});

describe("sending from an alias", () => {
	it("accepts the mailbox address or an alias, refuses others", () => {
		expect(validateSender("a@b.com", "support@producta.com", "support@tapetide.com", ["support@producta.com"]).fromDomain).toBe("producta.com");
		expect(validateSender("a@b.com", { email: "Support@Tapetide.com", name: "S" }, "support@tapetide.com", []).fromEmail).toBe("support@tapetide.com");
		expect(() => validateSender("a@b.com", "x@producta.com", "support@tapetide.com", ["support@producta.com"])).toThrow(SenderValidationError);
	});
});

// -- Cloudflare client ------------------------------------------------------------

describe("CloudflareClient", () => {
	it("is only built when CF_API_TOKEN is set; script name is configurable", () => {
		expect(cloudflareClientFromEnv(env())).toBeNull();
		expect(cloudflareClientFromEnv(env({ CF_API_TOKEN: " t " }))?.workerScriptName).toBe("cloudmail");
		expect(workerScriptName(env({ WORKER_SCRIPT_NAME: "fork" }))).toBe("fork");
	});

	it("sends a bearer token and walks parent labels for the zone, scoped to the account", async () => {
		const { impl, calls } = mockFetch({
			"GET /zones?*": (call) => ok(call.url.includes("name=example.com") ? [{ id: "z1", name: "example.com" }] : []),
		});
		const client = new CloudflareClient({ token: "tok", accountId: "acc", fetchImpl: impl });
		expect(await client.findZone("mail.example.com")).toEqual({ id: "z1", name: "example.com" });
		expect(calls.map((c) => c.url)).toEqual([
			"https://api.cloudflare.com/client/v4/zones?name=mail.example.com&account.id=acc",
			"https://api.cloudflare.com/client/v4/zones?name=example.com&account.id=acc",
		]);
		expect(calls[0].headers.Authorization).toBe("Bearer tok");
	});

	it("puts the catch-all with an `all` matcher and a worker action", async () => {
		const { impl, calls } = mockFetch({ "PUT /zones/z1/email/routing/rules/catch_all": () => ok({}) });
		await new CloudflareClient({ token: "t", workerScriptName: "inbox", fetchImpl: impl }).putCatchAllToWorker("z1");
		expect(calls[0]).toMatchObject({
			method: "PUT",
			body: { enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: ["inbox"] }] },
		});
	});

	it("enables routing DNS with a name only for subdomains", async () => {
		const { impl, calls } = mockFetch({ "POST /zones/z1/email/routing/dns": () => ok({ status: "ready" }) });
		const client = new CloudflareClient({ token: "t", fetchImpl: impl });
		await client.enableRoutingDns("z1");
		await client.enableRoutingDns("z1", "mail.example.com");
		expect(calls.map((c) => c.body)).toEqual([{}, { name: "mail.example.com" }]);
	});

	it("creates, lists, gets a sending subdomain and reads its dns", async () => {
		const { impl, calls } = mockFetch({
			"POST /zones/z1/email/sending/subdomains": () => ok({ tag: "s1", name: "example.com" }),
			"GET /zones/z1/email/sending/subdomains": () => ok([]),
			"GET /zones/z1/email/sending/subdomains/s1": () => ok({ tag: "s1", name: "example.com" }),
			"GET /zones/z1/email/sending/subdomains/s1/dns": () => ok([]),
		});
		const client = new CloudflareClient({ token: "t", fetchImpl: impl });
		await client.createSendingSubdomain("z1", "example.com");
		await client.listSendingSubdomains("z1");
		await client.getSendingSubdomain("z1", "s1");
		await client.getSendingSubdomainDns("z1", "s1");
		expect(calls.map((c) => `${c.method} ${c.url.slice(36)}`)).toEqual([
			"POST /zones/z1/email/sending/subdomains",
			"GET /zones/z1/email/sending/subdomains",
			"GET /zones/z1/email/sending/subdomains/s1",
			"GET /zones/z1/email/sending/subdomains/s1/dns",
		]);
		expect(calls[0].body).toEqual({ name: "example.com" });
	});

	it("reads routing dns in both response shapes", async () => {
		let shape: unknown = [{ type: "MX", name: "a.com", content: "route1.mx.cloudflare.net" }];
		const { impl } = mockFetch({ "GET /zones/z1/email/routing/dns": () => ok(shape) });
		const client = new CloudflareClient({ token: "t", fetchImpl: impl });
		expect((await client.getRoutingDns("z1")).records).toHaveLength(1);
		shape = { record: [], errors: [{ missing: { type: "TXT", name: "a.com", content: "v=spf1" } }] };
		expect((await client.getRoutingDns("z1")).missing).toHaveLength(1);
	});

	it("surfaces Cloudflare errors with code and path", async () => {
		const { impl } = mockFetch({
			"GET /zones/z1/email/routing": () => ({ status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null } }),
		});
		await expect(new CloudflareClient({ token: "t", fetchImpl: impl }).getRoutingSettings("z1")).rejects.toThrow(
			/403 on GET \/zones\/z1\/email\/routing: code 10000: Authentication error/,
		);
	});
});

// -- provisioning -----------------------------------------------------------------

describe("provisionDomain", () => {
	function cfState(over: { routing?: unknown; catchAll?: unknown; subdomains?: unknown[] } = {}) {
		return mockFetch({
			"GET /zones?*": () => ok([{ id: "z1", name: "example.com" }]),
			"GET /zones/z1/email/routing": () => ok(over.routing ?? { enabled: false, status: "unconfigured" }),
			"POST /zones/z1/email/routing/dns": () => ok({ enabled: true, status: "ready" }),
			// Default: no catch-all rule at all (404), the only case created without consent.
			"GET /zones/z1/email/routing/rules/catch_all": () =>
				over.catchAll
					? ok(over.catchAll)
					: { status: 404, body: { success: false, errors: [{ code: 1000, message: "not found" }], result: null } },
			"PUT /zones/z1/email/routing/rules/catch_all": () => ok({}),
			"GET /zones/z1/email/sending/subdomains": () => ok(over.subdomains ?? []),
			"POST /zones/z1/email/sending/subdomains": () => ok({ tag: "s1", name: "example.com", enabled: true, dkim_selector: "cf-bounce" }),
			"GET /zones/z1/email/sending/subdomains/s1/dns": () =>
				ok([{ type: "TXT", name: "cf-bounce._domainkey.example.com", content: "v=DKIM1; p=KEY" }]),
		});
	}
	const domain = { hostname: "example.com", zoneId: null, sendingSubdomainId: null };

	it("runs every step on a fresh zone and reports ok", async () => {
		const { impl, calls } = cfState();
		const { result, patch } = await provisionDomain(new CloudflareClient({ token: "t", fetchImpl: impl }), domain, { now: 5 });
		expect(result.steps.map((s) => [s.step, s.status])).toEqual([
			["zone", "ok"],
			["routing", "ok"],
			["catch_all", "ok"],
			["sending", "ok"],
			["sending_dns", "ok"],
		]);
		expect(result.ok).toBe(true);
		expect(patch).toMatchObject({
			zoneId: "z1",
			status: "active",
			routingStatus: "ready",
			sendingSubdomainId: "s1",
			sendingStatus: "enabled",
			dkim: { selector: "cf-bounce", name: "cf-bounce._domainkey.example.com", value: "v=DKIM1; p=KEY" },
			lastError: null,
		});
		expect(calls.filter((c) => c.method !== "GET").map((c) => c.url.slice(36))).toEqual([
			"/zones/z1/email/routing/dns",
			"/zones/z1/email/routing/rules/catch_all",
			"/zones/z1/email/sending/subdomains",
		]);
	});

	it("is idempotent: writes nothing when already provisioned", async () => {
		const { impl, calls } = cfState({
			routing: { enabled: true, status: "ready" },
			catchAll: { enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: ["tapetide-agentic-inbox"] }] },
			subdomains: [{ tag: "s1", name: "example.com", enabled: true }],
		});
		const { result } = await provisionDomain(new CloudflareClient({ token: "t", fetchImpl: impl }), domain);
		expect(result.ok).toBe(true);
		expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
	});

	it("leaves a catch-all to somewhere else unless told to overwrite", async () => {
		const other = { enabled: true, matchers: [{ type: "all" }], actions: [{ type: "forward", value: ["me@gmail.com"] }] };
		const first = cfState({ catchAll: other });
		const r1 = await provisionDomain(new CloudflareClient({ token: "t", fetchImpl: first.impl }), domain);
		expect(r1.result.steps.find((s) => s.step === "catch_all")?.status).toBe("warn");
		expect(first.calls.some((c) => c.method === "PUT")).toBe(false);
		expect(r1.patch.status).toBe("pending");

		const second = cfState({ catchAll: other });
		await provisionDomain(new CloudflareClient({ token: "t", fetchImpl: second.impl }), domain, { overwriteCatchAll: true });
		expect(second.calls.some((c) => c.method === "PUT")).toBe(true);
	});

	for (const [label, rule] of [
		["disabled", { enabled: false, matchers: [{ type: "all" }], actions: [{ type: "worker", value: ["tapetide-agentic-inbox"] }] }],
		["drop", { enabled: true, matchers: [{ type: "all" }], actions: [{ type: "drop" }] }],
		["disabled drop (Cloudflare's default)", { enabled: false, matchers: [{ type: "all" }], actions: [{ type: "drop" }] }],
	] as const) {
		it(`does not switch on a ${label} catch-all without overwrite`, async () => {
			const { impl, calls } = cfState({ catchAll: rule });
			const { result } = await provisionDomain(new CloudflareClient({ token: "t", fetchImpl: impl }), domain);
			const step = result.steps.find((s) => s.step === "catch_all")!;
			expect(step.status).toBe("warn");
			expect(step.detail).toMatch(/Left unchanged/);
			expect(calls.some((c) => c.method === "PUT")).toBe(false);
		});
	}

	it("describes a disabled catch-all as bouncing", () => {
		expect(describeCatchAll({ enabled: false, matchers: [], actions: [{ type: "drop" }] })).toMatch(/disabled .* bounce/);
	});

	it("stops dependent steps when the zone is missing", async () => {
		const { impl } = mockFetch({ "GET /zones?*": () => ok([]) });
		const { result, patch } = await provisionDomain(new CloudflareClient({ token: "t", fetchImpl: impl }), domain);
		expect(result.steps.map((s) => s.status)).toEqual(["error", "skipped", "skipped", "skipped", "skipped"]);
		expect(patch.status).toBe("error");
		expect(patch.lastError).toMatch(/^zone: /);
	});

	it("keeps going after a failed step and records the error", async () => {
		const { impl } = mockFetch({
			"GET /zones?*": () => ok([{ id: "z1", name: "example.com" }]),
			"GET /zones/z1/email/routing": () => ok({ enabled: true, status: "ready" }),
			"GET /zones/z1/email/routing/rules/catch_all": () => ok({ enabled: true, actions: [{ type: "worker", value: ["tapetide-agentic-inbox"] }], matchers: [] }),
			"GET /zones/z1/email/sending/subdomains": () => ok([]),
			"POST /zones/z1/email/sending/subdomains": () => ({ status: 401, body: { success: false, errors: [{ code: 2036, message: "MX conflict" }] } }),
		});
		const { result } = await provisionDomain(new CloudflareClient({ token: "t", fetchImpl: impl }), domain);
		expect(result.steps.find((s) => s.step === "sending")).toMatchObject({ status: "error", detail: expect.stringMatching(/another provider's MX/) });
		expect(result.steps.find((s) => s.step === "sending_dns")?.status).toBe("skipped");
		expect(result.ok).toBe(false);
	});

	it("does not touch the catch-all for a subdomain (apex only)", async () => {
		const { impl, calls } = cfState();
		const { result } = await provisionDomain(new CloudflareClient({ token: "t", fetchImpl: impl }), { ...domain, hostname: "mail.example.com" });
		expect(result.steps.find((s) => s.step === "catch_all")?.status).toBe("warn");
		expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/routing/dns"))?.body).toEqual({ name: "mail.example.com" });
	});

	it("derives DKIM from records when the subdomain has no selector", () => {
		expect(dkimFromSending("a.com", null, [{ type: "TXT", name: "sel._domainkey.a.com", content: "p=1" }])).toEqual({
			selector: "sel",
			name: "sel._domainkey.a.com",
			value: "p=1",
		});
		expect(statusAfterProvision([{ step: "zone", status: "ok", detail: "" }])).toBe("active");
	});
});

// -- domain store -----------------------------------------------------------------

describe("DomainStore", () => {
	let store: DomainStore;
	beforeEach(() => {
		const db = new DatabaseSync(":memory:");
		const { sql, tx } = adapter(db);
		new AuthStore(sql, tx); // runs the 0006_domains migration
		store = new DomainStore(sql, tx);
	});

	it("creates, refuses duplicates, and looks up by id or hostname", () => {
		const r = store.createDomain({ hostname: " ProductA.com ", now: 1 });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.domain).toMatchObject({ hostname: "producta.com", displayName: "producta.com", status: "pending" });
		expect(store.createDomain({ hostname: "producta.com", now: 2 })).toEqual({ ok: false, reason: "exists" });
		expect(store.getDomain(r.domain.id)?.hostname).toBe("producta.com");
		expect(store.getDomain("PRODUCTA.COM")?.id).toBe(r.domain.id);
	});

	it("seeds env domains once without clobbering edits", () => {
		expect(store.seedDomains([{ domain: "tapetide.com", name: "tapetide.com" }], 1)).toBe(1);
		const d = store.getDomain("tapetide.com")!;
		store.updateDomain(d.id, { displayName: "Tapetide" }, 2);
		expect(store.seedDomains([{ domain: "tapetide.com", name: "tapetide.com" }], 3)).toBe(0);
		expect(store.getDomain("tapetide.com")?.displayName).toBe("Tapetide");
	});

	it("persists provisioning results and JSON caches", () => {
		const r = store.createDomain({ hostname: "a.com", now: 1 });
		if (!r.ok) throw new Error();
		const updated = store.updateDomain(
			r.domain.id,
			{
				status: "active",
				dkim: { selector: "s", name: "s._domainkey.a.com", value: "p=1" },
				lastAudit: { summary: "pass", checks: [] },
				sendingDns: [{ purpose: "sending", type: "TXT", name: "x", value: "y" }],
				displayName: "",
			},
			5,
		)!;
		expect(updated).toMatchObject({ status: "active", displayName: "a.com", updatedAt: 5, lastAudit: { summary: "pass" } });
		expect(updated.dkim?.selector).toBe("s");
		expect(updated.sendingDns).toHaveLength(1);
	});

	it("manages aliases, refusing one already owned by another mailbox", () => {
		expect(store.setAliases("support@tapetide.com", ["Support@ProductA.com", "support@productb.com", "support@tapetide.com"], 1)).toEqual({
			ok: true,
			aliases: ["support@producta.com", "support@productb.com"],
		});
		expect(store.setAliases("help@tapetide.com", ["support@producta.com"], 2)).toMatchObject({ ok: false, owner: "support@tapetide.com" });
		expect(store.listAliases("support@tapetide.com")).toHaveLength(2);
	});

	it("routingLookup returns aliases and catch-alls in one call", () => {
		const r = store.createDomain({ hostname: "productb.com", catchAllMailbox: "catch@productb.com", now: 1 });
		if (!r.ok) throw new Error();
		store.setAliases("support@tapetide.com", ["support@producta.com"], 1);
		expect(store.routingLookup(["support@producta.com", "x@productb.com"])).toEqual({
			aliases: { "support@producta.com": "support@tapetide.com" },
			catchAll: { "productb.com": "catch@productb.com" },
		});
	});

	it("deleting a domain drops its aliases; forgetting a mailbox clears its catch-all", () => {
		const a = store.createDomain({ hostname: "producta.com", now: 1 });
		const b = store.createDomain({ hostname: "productb.com", catchAllMailbox: "support@tapetide.com", now: 1 });
		if (!a.ok || !b.ok) throw new Error();
		store.setAliases("support@tapetide.com", ["support@producta.com", "support@productb.com"], 1);
		store.deleteDomain(a.domain.id);
		expect(store.listAliases("support@tapetide.com")).toEqual(["support@productb.com"]);
		store.forgetMailbox("support@tapetide.com", 2);
		expect(store.listAliases("support@tapetide.com")).toEqual([]);
		expect(store.getDomain("productb.com")?.catchAllMailbox).toBeNull();
	});
});
