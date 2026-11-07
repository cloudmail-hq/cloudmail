// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Managed domains and mailbox aliases, stored in the global AuthDO database.
 *
 * The tables are created by the `0006_domains` migration in
 * `workers/auth/store-core.ts`; this module only reads and writes them. It runs
 * over the same minimal SQL interface as `AuthStore`, so tests exercise it
 * against `node:sqlite` and the Durable Object runs it against
 * `ctx.storage.sql`.
 *
 * Every method is synchronous. Multi-statement changes (deleting a domain and
 * the aliases on it, replacing a mailbox's alias set) run in one transaction.
 */

import type { AuthSql, AuthTransaction } from "../auth/store-core";
import { randomId } from "../auth/crypto";

export type DomainStatus = "pending" | "active" | "error";

export interface DkimInfo {
	selector: string;
	name: string;
	value: string | null;
}

/** A DNS record Cloudflare (or we) expect to exist for a domain. */
export interface DnsRecordSpec {
	purpose: "routing" | "sending" | "dmarc";
	type: "MX" | "TXT" | "CNAME";
	name: string;
	value: string;
	priority?: number;
	note?: string;
}

export interface DomainRecord {
	id: string;
	hostname: string;
	displayName: string;
	zoneId: string | null;
	status: DomainStatus;
	routingStatus: string | null;
	sendingStatus: string | null;
	sendingSubdomainId: string | null;
	dkim: DkimInfo | null;
	catchAllMailbox: string | null;
	lastError: string | null;
	createdAt: number;
	updatedAt: number;
	lastCheckedAt: number | null;
}

/** A domain row plus the cached JSON blobs the detail view needs. */
export interface DomainDetailRecord extends DomainRecord {
	sendingDns: DnsRecordSpec[] | null;
	lastAudit: unknown | null;
	lastProvision: unknown | null;
}

export interface DomainPatch {
	displayName?: string;
	zoneId?: string | null;
	status?: DomainStatus;
	routingStatus?: string | null;
	sendingStatus?: string | null;
	sendingSubdomainId?: string | null;
	dkim?: DkimInfo | null;
	sendingDns?: DnsRecordSpec[] | null;
	catchAllMailbox?: string | null;
	lastError?: string | null;
	lastAudit?: unknown | null;
	lastProvision?: unknown | null;
	lastCheckedAt?: number | null;
}

export type CreateDomainResult =
	| { ok: true; domain: DomainRecord }
	| { ok: false; reason: "exists" };

export type SetAliasesResult =
	| { ok: true; aliases: string[] }
	| { ok: false; reason: "taken"; address: string; owner: string };

/**
 * `aliases` minus any address that is itself a real mailbox.
 *
 * Mailbox creation refuses an address that is an alias, but a row can still
 * predate that check or race it. Whoever reads aliases for authority (sending
 * as an address, filing its delivery events) filters through this, so a real
 * mailbox always wins over a stale alias.
 */
export async function withoutRealMailboxes(
	aliases: string[],
	isMailbox: (address: string) => Promise<boolean>,
): Promise<string[]> {
	const checks = await Promise.all(aliases.map(async (a) => [a, await isMailbox(a)] as const));
	return checks.filter(([, real]) => !real).map(([a]) => a);
}

/** Upper bound on aliases per mailbox; keeps one row from fanning out unbounded. */
export const MAX_ALIASES_PER_MAILBOX = 50;

const COLUMNS = `id, hostname, display_name, zone_id, status, routing_status, sending_status,
	sending_subdomain_id, dkim_selector, dkim_name, dkim_value, sending_dns, catch_all_mailbox,
	last_error, last_audit, last_provision, created_at, updated_at, last_checked_at`;

function parseJson<T>(raw: unknown): T | null {
	if (typeof raw !== "string" || raw === "") return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		// A corrupt cache column is a missing cache, not a broken domain.
		return null;
	}
}

function str(v: unknown): string | null {
	return v === null || v === undefined ? null : String(v);
}

function toStatus(v: unknown): DomainStatus {
	return v === "active" || v === "error" ? v : "pending";
}

function toDomain(row: any): DomainRecord {
	return {
		id: String(row.id),
		hostname: String(row.hostname),
		displayName: String(row.display_name),
		zoneId: str(row.zone_id),
		status: toStatus(row.status),
		routingStatus: str(row.routing_status),
		sendingStatus: str(row.sending_status),
		sendingSubdomainId: str(row.sending_subdomain_id),
		dkim: row.dkim_selector
			? {
					selector: String(row.dkim_selector),
					name: String(row.dkim_name ?? ""),
					value: str(row.dkim_value),
				}
			: null,
		catchAllMailbox: str(row.catch_all_mailbox),
		lastError: str(row.last_error),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		lastCheckedAt: row.last_checked_at === null || row.last_checked_at === undefined
			? null
			: Number(row.last_checked_at),
	};
}

function toDetail(row: any): DomainDetailRecord {
	const sendingDns = parseJson<DnsRecordSpec[]>(row.sending_dns);
	return {
		...toDomain(row),
		sendingDns: Array.isArray(sendingDns) ? sendingDns : null,
		lastAudit: parseJson(row.last_audit),
		lastProvision: parseJson(row.last_provision),
	};
}

export class DomainStore {
	constructor(
		private readonly sql: AuthSql,
		private readonly transaction: AuthTransaction,
	) {}

	private all(query: string, ...bindings: unknown[]): any[] {
		return this.sql.exec(query, ...bindings).toArray();
	}

	private one(query: string, ...bindings: unknown[]): any | null {
		return this.all(query, ...bindings)[0] ?? null;
	}

	// -- domains ---------------------------------------------------------------

	listDomains(): DomainRecord[] {
		return this.all(`SELECT ${COLUMNS} FROM domains ORDER BY hostname`).map(toDomain);
	}

	/** Look a domain up by id or by hostname. */
	getDomain(idOrHostname: string): DomainDetailRecord | null {
		const key = idOrHostname.trim().toLowerCase();
		const row =
			this.one(`SELECT ${COLUMNS} FROM domains WHERE id = ?`, idOrHostname.trim()) ??
			this.one(`SELECT ${COLUMNS} FROM domains WHERE hostname = ?`, key);
		return row ? toDetail(row) : null;
	}

	createDomain(input: {
		hostname: string;
		displayName?: string;
		zoneId?: string | null;
		catchAllMailbox?: string | null;
		now: number;
	}): CreateDomainResult {
		const hostname = input.hostname.trim().toLowerCase();
		return this.transaction((): CreateDomainResult => {
			if (this.one(`SELECT id FROM domains WHERE hostname = ?`, hostname)) {
				return { ok: false, reason: "exists" };
			}
			const id = randomId("dom");
			this.sql.exec(
				`INSERT INTO domains (id, hostname, display_name, zone_id, status, catch_all_mailbox, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
				id,
				hostname,
				input.displayName?.trim() || hostname,
				input.zoneId?.trim() || null,
				input.catchAllMailbox?.trim().toLowerCase() || null,
				input.now,
				input.now,
			);
			return { ok: true, domain: toDomain(this.one(`SELECT ${COLUMNS} FROM domains WHERE id = ?`, id)) };
		});
	}

	/**
	 * Insert any of `zones` that has no row yet. Existing rows are untouched, so
	 * an operator's edits survive a redeploy. Returns how many were inserted.
	 */
	seedDomains(zones: { domain: string; name: string; zoneId?: string }[], now: number): number {
		return this.transaction(() => {
			let inserted = 0;
			for (const zone of zones) {
				const hostname = zone.domain.trim().toLowerCase();
				if (!hostname) continue;
				if (this.one(`SELECT id FROM domains WHERE hostname = ?`, hostname)) continue;
				this.sql.exec(
					`INSERT INTO domains (id, hostname, display_name, zone_id, status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
					randomId("dom"),
					hostname,
					zone.name || hostname,
					zone.zoneId ?? null,
					now,
					now,
				);
				inserted++;
			}
			return inserted;
		});
	}

	/** `seedDomains` then `listDomains`, so a cold isolate needs one RPC, not two. */
	seedAndListDomains(zones: { domain: string; name: string; zoneId?: string }[], now: number): DomainRecord[] {
		this.seedDomains(zones, now);
		return this.listDomains();
	}

	updateDomain(id: string, patch: DomainPatch, now: number): DomainDetailRecord | null {
		const sets: string[] = [];
		const values: unknown[] = [];
		const set = (column: string, value: unknown) => {
			sets.push(`${column} = ?`);
			values.push(value);
		};
		if (patch.displayName !== undefined) set("display_name", patch.displayName.trim() || null);
		if (patch.zoneId !== undefined) set("zone_id", patch.zoneId);
		if (patch.status !== undefined) set("status", patch.status);
		if (patch.routingStatus !== undefined) set("routing_status", patch.routingStatus);
		if (patch.sendingStatus !== undefined) set("sending_status", patch.sendingStatus);
		if (patch.sendingSubdomainId !== undefined) set("sending_subdomain_id", patch.sendingSubdomainId);
		if (patch.dkim !== undefined) {
			set("dkim_selector", patch.dkim?.selector ?? null);
			set("dkim_name", patch.dkim?.name ?? null);
			set("dkim_value", patch.dkim?.value ?? null);
		}
		if (patch.sendingDns !== undefined) set("sending_dns", patch.sendingDns ? JSON.stringify(patch.sendingDns) : null);
		if (patch.catchAllMailbox !== undefined) set("catch_all_mailbox", patch.catchAllMailbox?.toLowerCase() ?? null);
		if (patch.lastError !== undefined) set("last_error", patch.lastError);
		if (patch.lastAudit !== undefined) set("last_audit", patch.lastAudit === null ? null : JSON.stringify(patch.lastAudit));
		if (patch.lastProvision !== undefined) set("last_provision", patch.lastProvision === null ? null : JSON.stringify(patch.lastProvision));
		if (patch.lastCheckedAt !== undefined) set("last_checked_at", patch.lastCheckedAt);

		// display_name is NOT NULL; an empty patch value keeps the hostname.
		const idx = sets.indexOf("display_name = ?");
		return this.transaction(() => {
			const row = this.one(`SELECT hostname FROM domains WHERE id = ?`, id);
			if (!row) return null;
			if (idx !== -1 && values[idx] === null) values[idx] = row.hostname;
			set("updated_at", now);
			this.sql.exec(`UPDATE domains SET ${sets.join(", ")} WHERE id = ?`, ...values, id);
			return toDetail(this.one(`SELECT ${COLUMNS} FROM domains WHERE id = ?`, id));
		});
	}

	/** Delete a domain and every alias on it. */
	deleteDomain(id: string): boolean {
		return this.transaction(() => {
			const row = this.one(`SELECT hostname FROM domains WHERE id = ?`, id);
			if (!row) return false;
			this.sql.exec(
				`DELETE FROM mailbox_aliases WHERE substr(address, instr(address, '@') + 1) = ?`,
				row.hostname,
			);
			this.sql.exec(`DELETE FROM domains WHERE id = ?`, id);
			return true;
		});
	}

	// -- aliases ---------------------------------------------------------------

	listAliases(mailboxId: string): string[] {
		return this.all(
			`SELECT address FROM mailbox_aliases WHERE mailbox_id = ? ORDER BY address`,
			mailboxId.toLowerCase(),
		).map((r) => String(r.address));
	}

	/** Every alias, as address → mailbox. */
	allAliases(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const r of this.all(`SELECT address, mailbox_id FROM mailbox_aliases`)) {
			out[String(r.address)] = String(r.mailbox_id);
		}
		return out;
	}

	/**
	 * Replace a mailbox's alias set. Refuses, changing nothing, when an address
	 * already belongs to another mailbox. Callers validate the addresses
	 * themselves (syntax, served domain, not itself a mailbox).
	 */
	setAliases(mailboxId: string, addresses: string[], now: number): SetAliasesResult {
		const owner = mailboxId.toLowerCase();
		const wanted = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))]
			.filter((a) => a !== owner)
			.sort();
		return this.transaction((): SetAliasesResult => {
			for (const address of wanted) {
				const row = this.one(`SELECT mailbox_id FROM mailbox_aliases WHERE address = ?`, address);
				if (row && String(row.mailbox_id) !== owner) {
					return { ok: false, reason: "taken", address, owner: String(row.mailbox_id) };
				}
			}
			this.sql.exec(`DELETE FROM mailbox_aliases WHERE mailbox_id = ?`, owner);
			for (const address of wanted) {
				this.sql.exec(
					`INSERT INTO mailbox_aliases (address, mailbox_id, created_at) VALUES (?, ?, ?)`,
					address,
					owner,
					now,
				);
			}
			return { ok: true, aliases: wanted };
		});
	}

	/**
	 * Forget a deleted mailbox: drop its aliases and clear it as any domain's
	 * catch-all, so re-creating the address later does not silently restore
	 * routing nobody asked for.
	 */
	forgetMailbox(mailboxId: string, now: number): void {
		const id = mailboxId.toLowerCase();
		this.transaction(() => {
			this.sql.exec(`DELETE FROM mailbox_aliases WHERE mailbox_id = ?`, id);
			this.sql.exec(
				`UPDATE domains SET catch_all_mailbox = NULL, updated_at = ? WHERE catch_all_mailbox = ?`,
				now,
				id,
			);
		});
	}

	/**
	 * What inbound routing needs for a set of recipients, in one call: which of
	 * them are aliases, and the catch-all of every domain they sit on.
	 */
	routingLookup(addresses: string[]): {
		aliases: Record<string, string>;
		catchAll: Record<string, string>;
	} {
		const aliases: Record<string, string> = {};
		const catchAll: Record<string, string> = {};
		const domains = new Set<string>();
		for (const raw of addresses) {
			const address = raw.trim().toLowerCase();
			const row = this.one(`SELECT mailbox_id FROM mailbox_aliases WHERE address = ?`, address);
			if (row) aliases[address] = String(row.mailbox_id);
			const at = address.lastIndexOf("@");
			if (at !== -1) domains.add(address.slice(at + 1));
		}
		for (const domain of domains) {
			const row = this.one(
				`SELECT catch_all_mailbox FROM domains WHERE hostname = ? AND catch_all_mailbox IS NOT NULL`,
				domain,
			);
			if (row) catchAll[domain] = String(row.catch_all_mailbox);
		}
		return { aliases, catchAll };
	}
}
