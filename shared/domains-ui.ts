// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Pure helpers for the domains, aliases and From-picker UI.
 *
 * Kept free of React and browser APIs so they can be unit-tested in Node.
 */

const ADDRESS_RE = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

/** Lower-cased bare address from `addr` or `Name <addr>`, or null. */
export function bareAddress(token: string | null | undefined): string | null {
	if (!token) return null;
	const trimmed = token.trim();
	const angled = trimmed.match(/<\s*([^>\s]+)\s*>/);
	const candidate = (angled ? angled[1] : trimmed).trim().toLowerCase();
	return ADDRESS_RE.test(candidate) ? candidate : null;
}

/** Every bare address in a comma-separated header-ish list. */
export function addressesIn(list: string | null | undefined): string[] {
	if (!list) return [];
	const out: string[] = [];
	for (const part of list.split(",")) {
		const addr = bareAddress(part);
		if (addr) out.push(addr);
	}
	return out;
}

/** The mailbox address first, then its aliases, de-duplicated case-insensitively. */
export function buildFromOptions(mailboxEmail: string, aliases: readonly string[] = []): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of [mailboxEmail, ...aliases]) {
		const addr = raw?.trim().toLowerCase();
		if (!addr || seen.has(addr)) continue;
		seen.add(addr);
		out.push(addr);
	}
	return out;
}

/**
 * Which address a reply should go out from.
 *
 * When the original was addressed (To or Cc) to one of the mailbox's aliases,
 * answer from that alias, so the correspondent sees the address they wrote to.
 * Otherwise the mailbox's own address.
 */
export function pickDefaultFrom(
	mailboxEmail: string,
	aliases: readonly string[],
	original?: { recipient?: string | null; cc?: string | null } | null,
): string {
	const primary = mailboxEmail.trim().toLowerCase();
	if (!original || aliases.length === 0) return primary;
	const aliasSet = new Set(aliases.map((a) => a.trim().toLowerCase()));
	const addressed = [...addressesIn(original.recipient), ...addressesIn(original.cc)];
	if (addressed.includes(primary)) return primary;
	return addressed.find((addr) => aliasSet.has(addr)) ?? primary;
}

/**
 * Swap the email inside a send payload's `from`, keeping its shape
 * (`string` or `{email, name}`).
 */
export function withFromEmail(from: string, email: string): string;
export function withFromEmail(
	from: { email: string; name?: string },
	email: string,
): { email: string; name?: string };
export function withFromEmail(
	from: string | { email: string; name?: string },
	email: string,
): string | { email: string; name?: string };
export function withFromEmail(
	from: string | { email: string; name?: string },
	email: string,
): string | { email: string; name?: string } {
	if (typeof from === "string") return email;
	return { ...from, email };
}

export type AliasCheck = { ok: true; alias: string } | { ok: false; error: string };

/**
 * Validate one alias before adding it to the list.
 *
 * `domains` is the set of hostnames this deployment receives mail for; an
 * alias on any other domain could never receive mail, so it is rejected here
 * rather than by a 400 on save. Pass an empty list to skip the domain check.
 */
export function checkAlias(
	input: string,
	{
		mailboxEmail,
		existing,
		domains = [],
	}: { mailboxEmail: string; existing: readonly string[]; domains?: readonly string[] },
): AliasCheck {
	const alias = input.trim().toLowerCase();
	if (!alias) return { ok: false, error: "Enter an address." };
	if (!ADDRESS_RE.test(alias)) return { ok: false, error: `${alias} isn't a valid address.` };
	if (alias === mailboxEmail.trim().toLowerCase()) {
		return { ok: false, error: "That's the mailbox's own address." };
	}
	if (existing.some((a) => a.trim().toLowerCase() === alias)) {
		return { ok: false, error: "That alias is already on the list." };
	}
	const domain = alias.slice(alias.lastIndexOf("@") + 1);
	if (domains.length > 0 && !domains.some((d) => d.toLowerCase() === domain)) {
		return { ok: false, error: `@${domain} isn't one of your domains.` };
	}
	return { ok: true, alias };
}

/** The part of a mailbox address after `@`, lower-cased. */
export function domainOf(email: string): string {
	const at = email.lastIndexOf("@");
	return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

/** Mailboxes on a given domain, for the catch-all picker. */
export function mailboxesOnDomain<T extends { email: string }>(mailboxes: readonly T[], hostname: string): T[] {
	const host = hostname.toLowerCase();
	return mailboxes.filter((m) => domainOf(m.email) === host);
}

/** Validate a hostname typed into "Add domain". */
export function checkHostname(input: string): { ok: true; hostname: string } | { ok: false; error: string } {
	const hostname = input.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
	if (!hostname) return { ok: false, error: "Enter a domain." };
	if (hostname.length > 253 || !/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(hostname)) {
		return { ok: false, error: `${hostname} isn't a valid domain name.` };
	}
	return { ok: true, hostname };
}

// -- DNS status table -----------------------------------------------------------

export type DnsRowStatus = "pass" | "warn" | "fail" | "unchecked";

/** The record and audit shapes this module reads (structural, so the Worker types fit). */
export interface DnsRecordLike {
	purpose: string;
	type: string;
	name: string;
	value: string;
	priority?: number;
	note?: string;
}

export interface DnsCheckLike {
	id: string;
	type: string;
	name: string;
	status: "pass" | "warn" | "fail";
	expected: string;
	found: string[];
	message: string;
}

export interface DnsStatusRow {
	/** The audit check id, e.g. `mx`, `bounce_spf`. */
	id: string;
	label: string;
	/** What the record is for, in a few words. */
	role: string;
	type: string;
	name: string;
	status: DnsRowStatus;
	/** Values to publish, one per record (MX as `"<priority> <host>"`). */
	expected: string[];
	/** What DNS answered at the last check. */
	found: string[];
	message: string | null;
	/** Set when the expected value is a placeholder Cloudflare generates (DKIM keys). */
	generated: boolean;
	note: string | null;
}

/**
 * The rows the Domains page shows, in a fixed order: inbound MX, SPF and DKIM,
 * then the return-path (bounce) MX and SPF and the sending DKIM, then DMARC.
 */
const DNS_ROWS: { id: string; label: string; role: string; purpose: string; type: string }[] = [
	{ id: "mx", label: "MX", role: "Receives mail", purpose: "routing", type: "MX" },
	{ id: "spf", label: "SPF", role: "Authorises Cloudflare to send", purpose: "routing", type: "TXT" },
	{ id: "dkim", label: "DKIM (routing)", role: "Signs forwarded mail", purpose: "routing", type: "TXT" },
	{ id: "bounce_mx", label: "Bounce MX", role: "Return path: receives bounces", purpose: "sending", type: "MX" },
	{ id: "bounce_spf", label: "Return-path SPF", role: "Return path: authorises sending", purpose: "sending", type: "TXT" },
	{ id: "sending_dkim", label: "DKIM (sending)", role: "Signs mail you send", purpose: "sending", type: "TXT" },
	{ id: "dmarc", label: "DMARC", role: "Tells receivers what to do on failure", purpose: "dmarc", type: "TXT" },
];

const isSpf = (v: string) => /^v=spf1(\s|$)/i.test(v.trim());
const isGenerated = (v: string) => /^\(.*\)$/.test(v.trim());

function recordValue(r: DnsRecordLike): string {
	return r.type === "MX" && r.priority != null ? `${r.priority} ${r.value}` : r.value;
}

/**
 * Join the expected records with the last audit into one row per check.
 *
 * Records are matched to a row by purpose and type, then by role: the apex SPF
 * and the routing DKIM are both routing TXT records, so SPF takes the `v=spf1`
 * value and DKIM takes the `_domainkey` name. Without an audit every row is
 * "unchecked".
 */
export function dnsStatusRows(
	records: readonly DnsRecordLike[],
	audit: { checks: readonly DnsCheckLike[] } | null | undefined,
): DnsStatusRow[] {
	const checks = new Map((audit?.checks ?? []).map((c) => [c.id, c]));
	const rows: DnsStatusRow[] = [];
	for (const spec of DNS_ROWS) {
		const matching = records.filter((r) => {
			if (r.purpose !== spec.purpose || r.type !== spec.type) return false;
			const dkim = r.name.toLowerCase().includes("._domainkey.");
			if (spec.id === "spf" || spec.id === "bounce_spf") return !dkim && isSpf(r.value);
			if (spec.id === "dkim" || spec.id === "sending_dkim") return dkim;
			return true;
		});
		const check = checks.get(spec.id);
		if (matching.length === 0 && !check) continue;
		rows.push({
			id: spec.id,
			label: spec.label,
			role: spec.role,
			type: spec.type,
			name: matching[0]?.name ?? check?.name ?? "",
			status: check?.status ?? "unchecked",
			expected: matching.length > 0 ? matching.map(recordValue) : check?.expected ? [check.expected] : [],
			found: check?.found ?? [],
			message: check?.message ?? null,
			generated: matching.some((r) => isGenerated(r.value)),
			note: matching.find((r) => r.note)?.note ?? null,
		});
	}
	return rows;
}

/** Counts for the table's summary line. */
export function dnsStatusSummary(rows: readonly DnsStatusRow[]): Record<DnsRowStatus, number> {
	const out: Record<DnsRowStatus, number> = { pass: 0, warn: 0, fail: 0, unchecked: 0 };
	for (const r of rows) out[r.status] += 1;
	return out;
}

export type StatusTone = "success" | "warning" | "danger" | "muted";

/** Badge tone for a domain, routing, sending or audit status string. */
export function statusTone(status: string | null | undefined): StatusTone {
	switch (status) {
		case "active":
		case "ready":
		case "enabled":
		case "pass":
		case "ok":
			return "success";
		case "pending":
		case "warn":
		case "manual":
		case "skipped":
		case "unconfigured":
		case "unlocked":
		case "disabled":
			return "warning";
		case "error":
		case "fail":
		case "misconfigured":
		case "missing":
			return "danger";
		default:
			return "muted";
	}
}
