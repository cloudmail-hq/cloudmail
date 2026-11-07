/**
 * The setup planner's tier rules (workers/lib/setup-plan.ts): the safety
 * contract for what onboarding apply may do without asking.
 */

import { describe, expect, it } from "vitest";
import type { DnsRecordLite, PlanItem, WorkerDiscovery, ZoneDiscovery } from "../shared/cf-setup";
import {
	PLAN_DMARC,
	buildSetupPlan,
	classifyMxProvider,
	dependencyOrder,
	mergeSpfInclude,
	planHash,
	spfDecision,
	spfLookupTerms,
	txtText,
	type PlanInput,
} from "../workers/lib/setup-plan";

const Z = "fedcba9876543210fedcba9876543210";
const HOST = "example.com";

const CF_MX: DnsRecordLite[] = [
	{ id: "m1", type: "MX", name: HOST, content: "route1.mx.cloudflare.net", priority: 13 },
	{ id: "m2", type: "MX", name: HOST, content: "route2.mx.cloudflare.net", priority: 24 },
];
const GOOGLE_MX: DnsRecordLite[] = [
	{ id: "g1", type: "MX", name: HOST, content: "aspmx.l.google.com", priority: 1 },
	{ id: "g2", type: "MX", name: HOST, content: "alt1.aspmx.l.google.com", priority: 5 },
];
const spf = (content: string, id = "s1"): DnsRecordLite => ({ id, type: "TXT", name: HOST, content });

function zone(over: Partial<ZoneDiscovery> & { dns?: Partial<ZoneDiscovery["dns"]> } = {}): ZoneDiscovery {
	const { dns, ...rest } = over;
	const z: ZoneDiscovery = {
		zoneId: Z,
		name: HOST,
		status: "active",
		managed: false,
		envDomain: false,
		detail: "full",
		routing: { enabled: false, status: "unconfigured" },
		catchAll: null,
		catchAllToUs: false,
		sending: [],
		dns: { mx: [], spf: [], dmarc: [], tlsRpt: [], mtaSts: [], ...dns },
		mxProvider: "none",
		spfLookups: 0,
		denied: [],
		...rest,
	};
	if (!rest.mxProvider) z.mxProvider = classifyMxProvider(z.dns.mx);
	return z;
}

const WORKER_OK: WorkerDiscovery = { configured: "tapetide-agentic-inbox", source: "default", found: true, mailboxScripts: null, canPersist: true };

function plan(over: Partial<PlanInput> = {}): PlanItem[] {
	return buildSetupPlan({
		zones: [zone()],
		worker: WORKER_OK,
		vectorize: null,
		missingCapabilities: [],
		templateUrl: "https://dash.cloudflare.com/?to=/:account/api-tokens",
		...over,
	});
}

function item(items: PlanItem[], kind: PlanItem["kind"], zoneId: string | null = Z): PlanItem | undefined {
	return items.find((i) => i.kind === kind && i.zoneId === zoneId);
}

const tier = (items: PlanItem[], kind: PlanItem["kind"]) => item(items, kind)?.tier;

describe("SPF helpers", () => {
	it("reads quoted and split TXT content", () => {
		expect(txtText('"v=spf1 include:a.com" " ~all"')).toBe("v=spf1 include:a.com ~all");
		expect(txtText("v=spf1 -all")).toBe("v=spf1 -all");
	});

	it("adds the Cloudflare include before the all term, in the same record and quoting", () => {
		expect(mergeSpfInclude('"v=spf1 include:_spf.google.com ~all"')).toBe('"v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all"');
		expect(mergeSpfInclude("v=spf1 ip4:1.2.3.4 -all")).toBe("v=spf1 ip4:1.2.3.4 include:_spf.mx.cloudflare.net -all");
		expect(mergeSpfInclude("v=spf1 a mx")).toBe("v=spf1 a mx include:_spf.mx.cloudflare.net");
		expect(mergeSpfInclude("v=spf1 redirect=_spf.example.net")).toBe("v=spf1 include:_spf.mx.cloudflare.net redirect=_spf.example.net");
	});

	it("counts lookup terms", () => {
		expect(spfLookupTerms("v=spf1 a mx include:x.com ip4:1.1.1.1 exists:%{i}.y ~all")).toHaveLength(4);
	});

	it("decides: absent, has include, mergeable, multiple, too many lookups, unknown lookups", () => {
		expect(spfDecision([], 0).state).toBe("absent");
		expect(spfDecision([spf("v=spf1 include:_spf.mx.cloudflare.net ~all")], 1).state).toBe("has_include");
		expect(spfDecision([spf("v=spf1 include:_spf.google.com ~all")], 4)).toMatchObject({ state: "mergeable", lookups: 5 });
		expect(spfDecision([spf("v=spf1 a ~all"), spf("v=spf1 mx ~all", "s2")], 0).state).toBe("multiple");
		expect(spfDecision([spf("v=spf1 include:big.example ~all")], 9)).toMatchObject({ state: "mergeable", lookups: 10 });
		expect(spfDecision([spf("v=spf1 include:big.example ~all")], 10)).toMatchObject({ state: "too_many_lookups", lookups: 11 });
		expect(spfDecision([spf("v=spf1 include:x.example ~all")], null).state).toBe("lookups_unknown");
		// No lookup terms at all: nothing to resolve.
		expect(spfDecision([spf("v=spf1 ip4:1.2.3.4 ~all")], null).state).toBe("mergeable");
	});
});

describe("MX provider", () => {
	it("classifies", () => {
		expect(classifyMxProvider([])).toBe("none");
		expect(classifyMxProvider(CF_MX)).toBe("cloudflare");
		expect(classifyMxProvider(GOOGLE_MX)).toBe("google");
		expect(classifyMxProvider([{ type: "MX", name: HOST, content: "example-com.mail.protection.outlook.com" }])).toBe("microsoft");
		expect(classifyMxProvider([{ type: "MX", name: HOST, content: "mx.zoho.eu" }])).toBe("zoho");
		expect(classifyMxProvider([{ type: "MX", name: HOST, content: "mx.fastmail.com" }])).toBe("other");
	});
});

describe("a brand-new mail domain", () => {
	const items = plan();

	it("is all auto: add, routing, catch-all, sending, DMARC p=none", () => {
		expect(tier(items, "add_domain")).toBe("auto");
		expect(tier(items, "enable_routing")).toBe("auto");
		expect(tier(items, "catch_all")).toBe("auto");
		expect(tier(items, "sending_domain")).toBe("auto");
		expect(tier(items, "dmarc_create")).toBe("auto");
		expect(item(items, "dmarc_create")!.after).toEqual([{ type: "TXT", name: `_dmarc.${HOST}`, content: PLAN_DMARC }]);
		expect(PLAN_DMARC).toBe("v=DMARC1; p=none;");
		expect(item(items, "spf_merge")).toBeUndefined();
		expect(item(items, "mx_replace")).toBeUndefined();
	});

	it("uses stable ids and orders dependencies", () => {
		expect(item(items, "enable_routing")!.id).toBe(`${Z}:enable_routing`);
		expect(item(items, "catch_all")!.dependsOn).toEqual([`${Z}:add_domain`, `${Z}:enable_routing`]);
		const order = dependencyOrder([item(items, "catch_all")!, item(items, "enable_routing")!, item(items, "add_domain")!]).map((i) => i.kind);
		expect(order).toEqual(["add_domain", "enable_routing", "catch_all"]);
	});

	it("marks optional hardening and DMARC reports manual", () => {
		expect(tier(items, "mta_sts")).toBe("manual");
		expect(tier(items, "tls_rpt")).toBe("manual");
		expect(tier(items, "dmarc_reports")).toBe("manual");
	});

	it("is deterministic", () => {
		expect(plan()).toEqual(items);
	});
});

describe("enable_routing", () => {
	it("is auto with only Cloudflare MX and an SPF that already includes Cloudflare", () => {
		const items = plan({ zones: [zone({ dns: { mx: CF_MX, spf: [spf("v=spf1 include:_spf.mx.cloudflare.net ~all")] } })] });
		expect(tier(items, "enable_routing")).toBe("auto");
		expect(item(items, "spf_merge")).toBeUndefined();
	});

	it("is confirm, after spf_merge, when another SPF exists (never two SPF records)", () => {
		const items = plan({ zones: [zone({ dns: { spf: [spf('"v=spf1 include:_spf.google.com ~all"')] } })] });
		const merge = item(items, "spf_merge")!;
		expect(merge.tier).toBe("confirm");
		expect(merge.before).toEqual([spf('"v=spf1 include:_spf.google.com ~all"')]);
		expect(merge.after).toEqual([spf('"v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all"')]);
		const routing = item(items, "enable_routing")!;
		expect(routing.tier).toBe("confirm");
		expect(routing.dependsOn).toContain(merge.id);
		// The routing item does not claim to add an SPF record of its own.
		expect(routing.after!.some((r) => r.type === "TXT")).toBe(false);
	});

	it("is done when routing is enabled and ready", () => {
		const items = plan({ zones: [zone({ routing: { enabled: true, status: "ready" }, dns: { mx: CF_MX } })] });
		expect(tier(items, "enable_routing")).toBe("done");
	});

	it("is manual when SPF is ambiguous, so it can't create a second record", () => {
		const two = plan({ zones: [zone({ dns: { spf: [spf("v=spf1 a ~all"), spf("v=spf1 mx ~all", "s2")] } })] });
		expect(tier(two, "spf_merge")).toBe("manual");
		expect(tier(two, "enable_routing")).toBe("manual");
		expect(tier(two, "catch_all")).toBe("manual");
	});

	it("is manual when the token lacks Zone Settings Write", () => {
		const items = plan({ missingCapabilities: ["routing"] });
		expect(tier(items, "enable_routing")).toBe("manual");
		expect(item(items, "token_permission", null)!.title).toContain("Zone Settings Write");
	});
});

describe("foreign MX", () => {
	const items = plan({ zones: [zone({ dns: { mx: GOOGLE_MX, spf: [spf("v=spf1 include:_spf.google.com ~all")] } })] });

	it("needs a confirmed mx_replace listing the exact records, with a provider warning", () => {
		const mx = item(items, "mx_replace")!;
		expect(mx.tier).toBe("confirm");
		expect(mx.before).toEqual(GOOGLE_MX);
		expect(mx.detail).toContain("Google Workspace");
		expect(mx.detail).toMatch(/stops going/);
	});

	it("routing, catch-all and sending all wait on it and are confirm, never auto", () => {
		const routing = item(items, "enable_routing")!;
		expect(routing.tier).toBe("confirm");
		expect(routing.dependsOn).toEqual(expect.arrayContaining([`${Z}:mx_replace`, `${Z}:spf_merge`]));
		expect(tier(items, "catch_all")).toBe("confirm");
		const sending = item(items, "sending_domain")!;
		expect(sending.tier).toBe("confirm");
		expect(sending.dependsOn).toContain(`${Z}:mx_replace`);
		expect(items.filter((i) => i.zoneId === Z && i.tier === "auto").map((i) => i.kind).sort()).toEqual(["add_domain", "dmarc_create"]);
	});

	it("without DNS write everything that needs the MX gone is manual", () => {
		const noDns = plan({ zones: [zone({ dns: { mx: GOOGLE_MX } })], missingCapabilities: ["dns.read"] });
		expect(tier(noDns, "mx_replace")).toBe("manual");
		expect(tier(noDns, "enable_routing")).toBe("manual");
		expect(tier(noDns, "sending_domain")).toBe("manual");
	});
});

describe("SPF lookup limit", () => {
	it("a merge past 10 lookups is manual", () => {
		const items = plan({ zones: [zone({ dns: { spf: [spf("v=spf1 include:a.example include:b.example ~all")] }, spfLookups: 10 })] });
		const merge = item(items, "spf_merge")!;
		expect(merge.tier).toBe("manual");
		expect(merge.detail).toContain("11");
		expect(tier(items, "enable_routing")).toBe("manual");
	});

	it("an uncountable record is manual", () => {
		const items = plan({ zones: [zone({ dns: { spf: [spf("v=spf1 include:a.example ~all")] }, spfLookups: null })] });
		expect(tier(items, "spf_merge")).toBe("manual");
	});
});

describe("catch_all", () => {
	it("is confirm when any rule exists, including Cloudflare's default disabled drop", () => {
		const drop = { enabled: false, matchers: [{ type: "all" }], actions: [{ type: "drop" }] };
		const items = plan({ zones: [zone({ catchAll: drop })] });
		const ca = item(items, "catch_all")!;
		expect(ca.tier).toBe("confirm");
		expect(ca.before).toEqual([{ type: "CATCH_ALL", name: HOST, content: "disabled: drop" }]);
		expect(ca.detail).toMatch(/dropped instead of bounced/);
	});

	it("is confirm when routing was already enabled, even with no rule", () => {
		const items = plan({ zones: [zone({ routing: { enabled: true, status: "ready" }, dns: { mx: CF_MX } })] });
		expect(tier(items, "catch_all")).toBe("confirm");
	});

	it("is done when it already delivers here", () => {
		const items = plan({ zones: [zone({ catchAllToUs: true, catchAll: { enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: ["tapetide-agentic-inbox"] }] } })] });
		expect(tier(items, "catch_all")).toBe("done");
	});

	it("is manual without Email Routing Rules Write", () => {
		expect(tier(plan({ missingCapabilities: ["routing.rules"] }), "catch_all")).toBe("manual");
	});
});

describe("DMARC", () => {
	it("is never touched when one exists", () => {
		const items = plan({ zones: [zone({ dns: { dmarc: [{ id: "d1", type: "TXT", name: `_dmarc.${HOST}`, content: "v=DMARC1; p=reject; rua=mailto:x@y" }] } })] });
		expect(tier(items, "dmarc_create")).toBe("done");
		expect(item(items, "dmarc_reports")).toBeUndefined();
		expect(items.some((i) => i.kind === "dmarc_tighten")).toBe(false);
	});

	it("two DMARC records is manual", () => {
		const d = (id: string): DnsRecordLite => ({ id, type: "TXT", name: `_dmarc.${HOST}`, content: "v=DMARC1; p=none" });
		expect(tier(plan({ zones: [zone({ dns: { dmarc: [d("a"), d("b")] } })] }), "dmarc_create")).toBe("manual");
	});
});

describe("zone states", () => {
	it("a pending zone is one manual nameserver item", () => {
		const items = plan({ zones: [zone({ status: "pending", nameServers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] })] });
		const zoneItems = items.filter((i) => i.zoneId === Z);
		expect(zoneItems.map((i) => [i.kind, i.tier])).toEqual([["zone_pending", "manual"]]);
		expect(zoneItems[0]!.manualSteps!.join(" ")).toContain("ada.ns.cloudflare.com");
	});

	it("a zone that could not be read is manual, never guessed empty", () => {
		const items = plan({ zones: [zone({ error: "DNS: Cloudflare API 500" })] });
		expect(items.filter((i) => i.zoneId === Z).map((i) => [i.kind, i.tier])).toEqual([["zone_error", "manual"]]);
	});

	it("a managed domain's add_domain is done", () => {
		expect(tier(plan({ zones: [zone({ managed: true })] }), "add_domain")).toBe("done");
	});

	it("a DOMAINS/ZONES domain never gets an auto item", () => {
		const items = plan({ zones: [zone({ managed: true, envDomain: true })] });
		expect(items.filter((i) => i.zoneId === Z && i.tier === "auto")).toEqual([]);
		expect(tier(items, "enable_routing")).toBe("confirm");
		expect(tier(items, "dmarc_create")).toBe("confirm");
	});
});

describe("Email Sending", () => {
	it("plan error is a manual plan_upgrade", () => {
		const items = plan({ zones: [zone({ sendingPlanError: "Email Sending requires a paid plan" })] });
		expect(tier(items, "plan_upgrade")).toBe("manual");
		expect(item(items, "sending_domain")).toBeUndefined();
	});

	it("an existing subdomain is done", () => {
		expect(tier(plan({ zones: [zone({ sending: [{ tag: "t", name: HOST, enabled: true }] })] }), "sending_domain")).toBe("done");
	});
});

describe("Worker name", () => {
	const missing = (over: Partial<WorkerDiscovery>): WorkerDiscovery => ({ ...WORKER_OK, found: false, mailboxScripts: [], ...over });

	it("exactly one MailboxDO script is auto and the catch-all waits on it", () => {
		const items = plan({ worker: missing({ mailboxScripts: ["my-mail"] }) });
		const w = item(items, "worker_name", null)!;
		expect(w.tier).toBe("auto");
		expect(w.after).toEqual([{ type: "WORKER", name: "catch-all target", content: "my-mail" }]);
		expect(item(items, "catch_all")!.dependsOn).toContain("account:worker_name");
	});

	it("none or several is manual, and the catch-all is manual too", () => {
		for (const scripts of [[], ["a", "b"]]) {
			const items = plan({ worker: missing({ mailboxScripts: scripts }) });
			expect(item(items, "worker_name", null)!.tier).toBe("manual");
			expect(tier(items, "catch_all")).toBe("manual");
		}
	});

	it("WORKER_SCRIPT_NAME env naming no script is manual (env wins)", () => {
		expect(item(plan({ worker: missing({ source: "env", mailboxScripts: ["my-mail"] }) }), "worker_name", null)!.tier).toBe("manual");
	});

	it("with CF_API_TOKEN (nowhere to save) a single match is manual", () => {
		expect(item(plan({ worker: missing({ mailboxScripts: ["my-mail"], canPersist: false }) }), "worker_name", null)!.tier).toBe("manual");
	});

	it("found is done; scripts unreadable adds nothing", () => {
		expect(item(plan(), "worker_name", null)!.tier).toBe("done");
		expect(item(plan({ worker: { ...WORKER_OK, found: null } }), "worker_name", null)).toBeUndefined();
	});
});

describe("token permissions", () => {
	it("each missing capability is a manual item naming the exact permission", () => {
		const items = plan({ missingCapabilities: ["sending", "vectorize"] });
		const perms = items.filter((i) => i.kind === "token_permission");
		expect(perms.map((i) => i.id)).toEqual(["account:token_permission:sending", "account:token_permission:vectorize"]);
		expect(perms[0]!.title).toContain("Email Sending Write");
		expect(perms[0]!.manualSteps!.join(" ")).toContain("5df633d6b41c42bcaf5b4a62b9d14b64");
		expect(perms.every((i) => i.tier === "manual")).toBe(true);
	});

	it("a 403 seen on a zone counts as missing", () => {
		const items = plan({ zones: [zone({ denied: ["sending"] })] });
		expect(item(items, "token_permission", null)?.id).toBe("account:token_permission:sending");
		expect(tier(items, "sending_domain")).toBe("manual");
	});
});

describe("Vectorize", () => {
	it("missing metadata index is auto; present is done; missing index is manual", () => {
		const v = (index: "present" | "missing", metadataIndex: "present" | "missing" | "unknown") =>
			item(plan({ vectorize: { indexName: "tapetide-mail-semantic", index, metadataIndex } }), "vectorize_metadata_index", null);
		expect(v("present", "missing")!.tier).toBe("auto");
		expect(v("present", "present")!.tier).toBe("done");
		expect(v("missing", "unknown")!.tier).toBe("manual");
		expect(v("present", "unknown")).toBeUndefined();
	});
});

describe("planHash", () => {
	it("changes when a before record or a tier changes, not otherwise", async () => {
		const base = plan({ zones: [zone({ dns: { mx: GOOGLE_MX } })] });
		const same = plan({ zones: [zone({ dns: { mx: GOOGLE_MX } })] });
		expect(await planHash(base)).toBe(await planHash(same));
		const edited = plan({ zones: [zone({ dns: { mx: [GOOGLE_MX[0]!, { ...GOOGLE_MX[1]!, content: "alt2.aspmx.l.google.com" }] } })] });
		expect(await planHash(edited)).not.toBe(await planHash(base));
		const ruleAppeared = plan({ zones: [zone({ dns: { mx: GOOGLE_MX }, catchAll: { enabled: true, matchers: [{ type: "all" }], actions: [{ type: "forward", value: ["a@b.c"] }] } })] });
		expect(await planHash(ruleAppeared)).not.toBe(await planHash(base));
	});
});
