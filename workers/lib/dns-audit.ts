// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Live DNS audit for a mail domain, and the record set it is audited against.
 *
 * Lookups use DNS-over-HTTPS (`cloudflare-dns.com/dns-query`, JSON flavour)
 * because Workers have no resolver API. Everything except `queryDns` is pure:
 * `parseDohResponse` turns a DoH body into answers and `evaluateAudit` turns
 * answers into verdicts, so both are unit-tested without a network.
 *
 * Verdicts are `pass`, `warn` or `fail`. A lookup that errors is a `warn`
 * ("could not check"), never a `fail`: a resolver hiccup must not paint a
 * working domain red.
 */

import type { DnsRecordSpec } from "./domain-store";

export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 5000;

/** Cloudflare Email Routing's inbound MX hosts. */
export const CF_MX_HOSTS = ["route1.mx.cloudflare.net", "route2.mx.cloudflare.net", "route3.mx.cloudflare.net"];
export const CF_SPF_INCLUDE = "include:_spf.mx.cloudflare.net";
/** DKIM selector Email Routing publishes at the apex. */
export const ROUTING_DKIM_SELECTOR = "cf2024-1";
/** Subdomain Email Sending uses for bounces, and its default DKIM selector. */
export const SENDING_BOUNCE_LABEL = "cf-bounce";
export const SUGGESTED_DMARC = "v=DMARC1; p=reject;";

export type DnsType = "MX" | "TXT" | "CNAME";
export type AuditStatus = "pass" | "warn" | "fail";

export interface AuditCheck {
	id: "mx" | "spf" | "dkim" | "bounce_mx" | "bounce_spf" | "sending_dkim" | "dmarc";
	label: string;
	type: DnsType;
	name: string;
	status: AuditStatus;
	expected: string;
	found: string[];
	message: string;
}

export interface DomainAudit {
	checkedAt: number;
	summary: AuditStatus;
	checks: AuditCheck[];
}

// -- DoH ----------------------------------------------------------------------

const TYPE_CODES: Record<DnsType, number> = { CNAME: 5, MX: 15, TXT: 16 };

interface DohBody {
	Status?: number;
	Answer?: { name?: string; type?: number; data?: string }[];
}

/** Join a TXT answer's quoted character-strings into one value. */
export function decodeTxt(data: string): string {
	const chunks = data.match(/"((?:[^"\\]|\\.)*)"/g);
	if (!chunks) return data.trim();
	return chunks.map((c) => c.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}

/**
 * Answers of the requested type from a DoH JSON body.
 *
 * NOERROR (0) and NXDOMAIN (3) both mean "nothing there" and yield `[]`; any
 * other status (SERVFAIL, REFUSED…) throws so the caller can tell "missing"
 * from "could not check". CNAME answers chained ahead of the target are
 * skipped by type. MX data is normalised to `"<priority> <host>"` with the
 * trailing dot dropped and the host lowercased.
 */
export function parseDohResponse(body: unknown, type: DnsType): string[] {
	const json = (body ?? {}) as DohBody;
	const status = typeof json.Status === "number" ? json.Status : 2;
	if (status !== 0 && status !== 3) throw new Error(`DNS status ${status}`);
	const code = TYPE_CODES[type];
	return (json.Answer ?? [])
		.filter((a) => a.type === code && typeof a.data === "string")
		.map((a) => {
			const data = a.data as string;
			if (type === "TXT") return decodeTxt(data);
			if (type === "MX") {
				const [prio, host = ""] = data.trim().split(/\s+/);
				return `${prio} ${host.replace(/\.$/, "").toLowerCase()}`;
			}
			return data.trim().replace(/\.$/, "").toLowerCase();
		});
}

export async function queryDns(name: string, type: DnsType, fetchImpl: typeof fetch = fetch): Promise<string[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
	try {
		const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`;
		const res = await fetchImpl(url, {
			headers: { accept: "application/dns-json" },
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`DoH ${res.status}`);
		return parseDohResponse(await res.json(), type);
	} finally {
		clearTimeout(timer);
	}
}

// -- expected records -----------------------------------------------------------

export interface ExpectedRecordOptions {
	/** DKIM selector Email Sending reported for this domain, if known. */
	sendingDkimSelector?: string | null;
	/** Records Email Sending reported for this domain (from the API), if known. */
	sendingDns?: DnsRecordSpec[] | null;
}

/** Names the audit checks, derived from the hostname and sending selector. */
export function auditNames(hostname: string, sendingDkimSelector?: string | null) {
	const bounce = `${SENDING_BOUNCE_LABEL}.${hostname}`;
	return {
		apex: hostname,
		routingDkim: `${ROUTING_DKIM_SELECTOR}._domainkey.${hostname}`,
		bounce,
		sendingDkim: `${sendingDkimSelector || SENDING_BOUNCE_LABEL}._domainkey.${hostname}`,
		dmarc: `_dmarc.${hostname}`,
	};
}

/**
 * Every DNS record a fully onboarded domain needs, in the order the dashboard
 * shows them. DKIM public keys are generated by Cloudflare, so without API
 * access their value is a pointer to the dashboard rather than the key.
 */
export function expectedRecords(hostname: string, options: ExpectedRecordOptions = {}): DnsRecordSpec[] {
	const n = auditNames(hostname, options.sendingDkimSelector);
	const records: DnsRecordSpec[] = [];
	CF_MX_HOSTS.forEach((host, i) =>
		records.push({ purpose: "routing", type: "MX", name: n.apex, value: host, priority: [13, 24, 86][i] ?? 10 }),
	);
	records.push({ purpose: "routing", type: "TXT", name: n.apex, value: `v=spf1 ${CF_SPF_INCLUDE} ~all` });
	records.push({
		purpose: "routing",
		type: "TXT",
		name: n.routingDkim,
		value: "(DKIM key generated by Cloudflare when Email Routing is enabled)",
		note: "Created automatically by Email Routing; copy it from the dashboard if adding by hand.",
	});

	const sending = options.sendingDns?.filter((r) => r.purpose === "sending") ?? [];
	if (sending.length > 0) {
		records.push(...sending);
	} else {
		CF_MX_HOSTS.forEach((host, i) =>
			records.push({ purpose: "sending", type: "MX", name: n.bounce, value: host, priority: [13, 24, 86][i] ?? 10 }),
		);
		records.push({ purpose: "sending", type: "TXT", name: n.bounce, value: `v=spf1 ${CF_SPF_INCLUDE} ~all` });
		records.push({
			purpose: "sending",
			type: "TXT",
			name: n.sendingDkim,
			value: "(DKIM key generated by Cloudflare when the sending domain is added)",
			note: "Shown under Email Sending → domain → DNS records.",
		});
	}
	records.push({
		purpose: "dmarc",
		type: "TXT",
		name: n.dmarc,
		value: SUGGESTED_DMARC,
		note: "Only if the domain has no DMARC record yet. Never publish two.",
	});
	return records;
}

/** Plain-language steps for an operator without `CF_API_TOKEN`. */
export function manualSteps(hostname: string, workerScriptName: string): string[] {
	return [
		`Add ${hostname} to Cloudflare (DNS must be on Cloudflare) if it is not already a zone.`,
		`Dashboard → ${hostname} → Email → Email Routing → Enable. Let it add the MX, SPF and DKIM records.`,
		`Email Routing → Routing rules → Catch-all address → Action "Send to a Worker" → ${workerScriptName} → Save, and make sure it is enabled.`,
		`Email → Email Sending → Add domain → ${hostname}. Add the cf-bounce MX/TXT and DKIM records it lists.`,
		`If ${hostname} has no DMARC record, add TXT _dmarc.${hostname} = "${SUGGESTED_DMARC}". If one exists, keep it.`,
		`Back here, press "Re-check DNS" until every row passes.`,
	];
}

// -- evaluation -------------------------------------------------------------------

/** Answers per `"<name>|<type>"`; `null` means the lookup failed. */
export type DnsAnswers = Record<string, string[] | null>;

export const answerKey = (name: string, type: DnsType) => `${name.toLowerCase()}|${type}`;

/** The lookups `evaluateAudit` reads. */
export function auditQueries(hostname: string, sendingDkimSelector?: string | null): { name: string; type: DnsType }[] {
	const n = auditNames(hostname, sendingDkimSelector);
	return [
		{ name: n.apex, type: "MX" },
		{ name: n.apex, type: "TXT" },
		{ name: n.routingDkim, type: "TXT" },
		{ name: n.bounce, type: "MX" },
		{ name: n.bounce, type: "TXT" },
		{ name: n.sendingDkim, type: "TXT" },
		{ name: n.dmarc, type: "TXT" },
	];
}

const unknown = (base: Omit<AuditCheck, "status" | "found" | "message">): AuditCheck => ({
	...base,
	status: "warn",
	found: [],
	message: "Could not check: the DNS lookup failed. Try again in a moment.",
});

function mxHost(answer: string): string {
	return answer.split(/\s+/)[1] ?? answer;
}

function checkMx(id: "mx" | "bounce_mx", label: string, name: string, answers: string[] | null): AuditCheck {
	const base = { id, label, type: "MX" as const, name, expected: CF_MX_HOSTS.join(", ") };
	if (answers === null) return unknown(base);
	const hosts = answers.map(mxHost);
	const cf = hosts.filter((h) => CF_MX_HOSTS.includes(h));
	const other = hosts.filter((h) => !CF_MX_HOSTS.includes(h));
	if (hosts.length === 0) {
		return { ...base, status: "fail", found: [], message: "No MX records. Mail to this name cannot be delivered." };
	}
	if (cf.length === 0) {
		return { ...base, status: "fail", found: answers, message: "MX points at another mail provider, not Cloudflare." };
	}
	if (other.length > 0) {
		return {
			...base,
			status: "warn",
			found: answers,
			message: "Cloudflare MX is present alongside other providers; some mail may land elsewhere.",
		};
	}
	if (cf.length < CF_MX_HOSTS.length) {
		return { ...base, status: "warn", found: answers, message: "Only some Cloudflare MX hosts are present." };
	}
	return { ...base, status: "pass", found: answers, message: "Cloudflare MX records are in place." };
}

function checkSpf(id: "spf" | "bounce_spf", label: string, name: string, answers: string[] | null): AuditCheck {
	const base = { id, label, type: "TXT" as const, name, expected: `v=spf1 ${CF_SPF_INCLUDE} ~all` };
	if (answers === null) return unknown(base);
	const spf = answers.filter((v) => /^v=spf1(\s|$)/i.test(v.trim()));
	if (spf.length === 0) return { ...base, status: "fail", found: [], message: "No SPF record." };
	if (spf.length > 1) {
		return { ...base, status: "fail", found: spf, message: "More than one SPF record; receivers treat that as a permanent error. Merge them." };
	}
	if (!spf[0].toLowerCase().split(/\s+/).includes(CF_SPF_INCLUDE)) {
		return { ...base, status: "warn", found: spf, message: `SPF exists but is missing ${CF_SPF_INCLUDE}.` };
	}
	return { ...base, status: "pass", found: spf, message: "SPF includes Cloudflare." };
}

function checkDkim(id: "dkim" | "sending_dkim", label: string, name: string, answers: string[] | null): AuditCheck {
	const base = { id, label, type: "TXT" as const, name, expected: "v=DKIM1; k=rsa; p=…" };
	if (answers === null) return unknown(base);
	const keys = answers.filter((v) => /(^|;)\s*p=/i.test(v) || /v=DKIM1/i.test(v));
	if (keys.length === 0) return { ...base, status: "fail", found: answers, message: "No DKIM key published at this name." };
	if (keys.some((k) => /(^|;)\s*p=\s*(;|$)/i.test(k))) {
		return { ...base, status: "fail", found: keys, message: "DKIM key is empty (revoked)." };
	}
	return { ...base, status: "pass", found: keys, message: "DKIM key is published." };
}

function checkDmarc(name: string, answers: string[] | null): AuditCheck {
	const base = { id: "dmarc" as const, label: "DMARC", type: "TXT" as const, name, expected: SUGGESTED_DMARC };
	if (answers === null) return unknown(base);
	const dmarc = answers.filter((v) => /^v=DMARC1/i.test(v.trim()));
	if (dmarc.length === 0) {
		return { ...base, status: "warn", found: [], message: `No DMARC record. Add "${SUGGESTED_DMARC}" (or p=none to monitor first).` };
	}
	if (dmarc.length > 1) {
		return { ...base, status: "fail", found: dmarc, message: "More than one DMARC record; receivers ignore both. Keep one." };
	}
	return {
		...base,
		status: "warn",
		found: dmarc,
		message: "A DMARC record already exists. Keep it and do not add the suggested one; check its policy still suits this sender.",
	};
}

const RANK: Record<AuditStatus, number> = { pass: 0, warn: 1, fail: 2 };

/** Worst status, with DMARC's advisory warning not dragging a healthy domain down. */
export function summarize(checks: AuditCheck[]): AuditStatus {
	let worst: AuditStatus = "pass";
	for (const c of checks) {
		const status = c.id === "dmarc" && c.status === "warn" && c.found.length > 0 ? "pass" : c.status;
		if (RANK[status] > RANK[worst]) worst = status;
	}
	return worst;
}

/** Pure: verdicts for a hostname given the answers to `auditQueries`. */
export function evaluateAudit(
	hostname: string,
	answers: DnsAnswers,
	options: { sendingDkimSelector?: string | null; now?: number } = {},
): DomainAudit {
	const n = auditNames(hostname, options.sendingDkimSelector);
	const get = (name: string, type: DnsType) => {
		const v = answers[answerKey(name, type)];
		return v === undefined ? null : v;
	};
	const checks: AuditCheck[] = [
		checkMx("mx", "Inbound MX", n.apex, get(n.apex, "MX")),
		checkSpf("spf", "SPF", n.apex, get(n.apex, "TXT")),
		checkDkim("dkim", "Routing DKIM", n.routingDkim, get(n.routingDkim, "TXT")),
		checkMx("bounce_mx", "Bounce MX", n.bounce, get(n.bounce, "MX")),
		checkSpf("bounce_spf", "Bounce SPF", n.bounce, get(n.bounce, "TXT")),
		checkDkim("sending_dkim", "Sending DKIM", n.sendingDkim, get(n.sendingDkim, "TXT")),
		checkDmarc(n.dmarc, get(n.dmarc, "TXT")),
	];
	return { checkedAt: options.now ?? Date.now(), summary: summarize(checks), checks };
}

/** Run every lookup (in parallel) and evaluate. Never throws. */
export async function auditDomain(
	hostname: string,
	options: { sendingDkimSelector?: string | null; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<DomainAudit> {
	const queries = auditQueries(hostname, options.sendingDkimSelector);
	const results = await Promise.all(
		queries.map(async (q) => {
			try {
				return [answerKey(q.name, q.type), await queryDns(q.name, q.type, options.fetchImpl)] as const;
			} catch {
				return [answerKey(q.name, q.type), null] as const;
			}
		}),
	);
	return evaluateAudit(hostname, Object.fromEntries(results), options);
}
