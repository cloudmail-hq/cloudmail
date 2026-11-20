// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Every Cloudflare change onboarding apply makes, so each one can be listed
 * and reverted (migration `0023_dns_change_log` in the global AuthDO).
 *
 * One row per DNS record created, updated or deleted, and per catch-all rule
 * overwritten (`record_type = 'catch_all'`). `before_json` / `after_json` are
 * the exact record (with Cloudflare's record id) or rule. Never a token.
 */

import type { AuthSql, AuthTransaction } from "../auth/store-core";
import { randomId } from "../auth/crypto";
import type { CfDnsChange } from "../../shared/cf-setup";

export type DnsChangeAction = "create" | "update" | "delete";

export interface RecordDnsChangeInput {
	zoneId: string;
	zoneName: string | null;
	recordType: string;
	name: string;
	action: DnsChangeAction;
	before: unknown | null;
	after: unknown | null;
	planItem: string | null;
	appliedBy: string | null;
	now: number;
}

/** Rows kept; older ones are pruned on insert. */
export const DNS_CHANGE_LOG_KEEP = 1000;

function parse(raw: unknown): unknown | null {
	if (typeof raw !== "string" || raw === "") return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function toChange(row: Record<string, unknown>): CfDnsChange {
	const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
	const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
	const action = String(row.action);
	return {
		id: String(row.id),
		zoneId: String(row.zone_id),
		zoneName: str(row.zone_name),
		recordType: String(row.record_type),
		name: String(row.name),
		action: action === "update" || action === "delete" ? action : "create",
		before: parse(row.before_json),
		after: parse(row.after_json),
		planItem: str(row.plan_item),
		appliedAt: Number(row.applied_at),
		appliedBy: str(row.applied_by),
		revertedAt: num(row.reverted_at),
		revertedBy: str(row.reverted_by),
	};
}

export class DnsChangeLogStore {
	constructor(
		private readonly sql: AuthSql,
		private readonly transaction: AuthTransaction,
	) {}

	record(input: RecordDnsChangeInput): CfDnsChange {
		return this.transaction(() => {
			const id = randomId("dnc");
			this.sql.exec(
				`INSERT INTO dns_change_log
				   (id, zone_id, zone_name, record_type, name, action, before_json, after_json, plan_item, applied_at, applied_by)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				input.zoneId,
				input.zoneName,
				input.recordType,
				input.name.toLowerCase(),
				input.action,
				input.before === null || input.before === undefined ? null : JSON.stringify(input.before),
				input.after === null || input.after === undefined ? null : JSON.stringify(input.after),
				input.planItem,
				input.now,
				input.appliedBy,
			);
			this.sql.exec(
				`DELETE FROM dns_change_log WHERE id NOT IN (SELECT id FROM dns_change_log ORDER BY applied_at DESC, rowid DESC LIMIT ?)`,
				DNS_CHANGE_LOG_KEEP,
			);
			return this.get(id)!;
		});
	}

	get(id: string): CfDnsChange | null {
		const row = this.sql.exec(`SELECT * FROM dns_change_log WHERE id = ?`, id).toArray()[0];
		return row ? toChange(row as Record<string, unknown>) : null;
	}

	/** Newest first. */
	list(limit = 100, zoneId?: string): CfDnsChange[] {
		const n = Math.max(1, Math.min(500, Math.floor(limit)));
		const rows = zoneId
			? this.sql.exec(`SELECT * FROM dns_change_log WHERE zone_id = ? ORDER BY applied_at DESC, rowid DESC LIMIT ?`, zoneId, n).toArray()
			: this.sql.exec(`SELECT * FROM dns_change_log ORDER BY applied_at DESC, rowid DESC LIMIT ?`, n).toArray();
		return rows.map((r) => toChange(r as Record<string, unknown>));
	}

	/** Mark reverted; null when unknown or already reverted (so two reverts can't both run). */
	markReverted(id: string, by: string | null, now: number): CfDnsChange | null {
		const changed = this.sql
			.exec(`UPDATE dns_change_log SET reverted_at = ?, reverted_by = ? WHERE id = ? AND reverted_at IS NULL RETURNING id`, now, by, id)
			.toArray();
		return changed.length ? this.get(id) : null;
	}

	/** Undo `markReverted` when the Cloudflare call behind it failed. */
	clearReverted(id: string): void {
		this.sql.exec(`UPDATE dns_change_log SET reverted_at = NULL, reverted_by = NULL WHERE id = ?`, id);
	}
}
