// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Storage for the spam-rate circuit breaker (AuthDO table `sending_health`,
 * migration `0012_sending_health`). Pure SQL over the AuthDO's database, kept
 * out of `store-core.ts` like `DomainStore`, so it is testable on `node:sqlite`.
 */

import {
	emptyDomainHealth,
	nextDomainHealth,
	type HealthLevel,
	type HealthNotification,
	type SendingDomainHealth,
	type SpamRateEvaluation,
} from "../../shared/sending-health";

export interface HealthSql {
	exec(query: string, ...bindings: unknown[]): { toArray(): any[] };
}
export type HealthTransaction = <T>(fn: () => T) => T;

function fromRow(row: any): SendingDomainHealth {
	return {
		domain: String(row.domain),
		level: String(row.level) as HealthLevel,
		spam_rate: row.spam_rate === null || row.spam_rate === undefined ? null : Number(row.spam_rate),
		complaints: Number(row.complaints ?? 0),
		delivered: Number(row.delivered ?? 0),
		source: row.source ?? null,
		provider_status: row.provider_status ?? null,
		evaluated_at: row.evaluated_at === null || row.evaluated_at === undefined ? null : Number(row.evaluated_at),
		bulk_paused: Number(row.bulk_paused ?? 0) === 1,
		paused_at: row.paused_at === null || row.paused_at === undefined ? null : Number(row.paused_at),
		paused_reason: row.paused_reason ?? null,
		resumed_at: row.resumed_at === null || row.resumed_at === undefined ? null : Number(row.resumed_at),
		resumed_by: row.resumed_by ?? null,
		notified_level: (row.notified_level ?? null) as HealthLevel | null,
	};
}

const LAST_RUN_KEY = "sending_health_last_run";

export class SendingHealthStore {
	constructor(
		private readonly sql: HealthSql,
		private readonly transaction: HealthTransaction,
	) {}

	private write(row: SendingDomainHealth): void {
		this.sql.exec(
			`INSERT INTO sending_health
				(domain, level, spam_rate, complaints, delivered, source, provider_status, evaluated_at,
				 bulk_paused, paused_at, paused_reason, resumed_at, resumed_by, notified_level)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(domain) DO UPDATE SET
				level = excluded.level, spam_rate = excluded.spam_rate, complaints = excluded.complaints,
				delivered = excluded.delivered, source = excluded.source, provider_status = excluded.provider_status,
				evaluated_at = excluded.evaluated_at, bulk_paused = excluded.bulk_paused,
				paused_at = excluded.paused_at, paused_reason = excluded.paused_reason,
				resumed_at = excluded.resumed_at, resumed_by = excluded.resumed_by,
				notified_level = excluded.notified_level`,
			row.domain,
			row.level,
			row.spam_rate,
			row.complaints,
			row.delivered,
			row.source,
			row.provider_status,
			row.evaluated_at,
			row.bulk_paused ? 1 : 0,
			row.paused_at,
			row.paused_reason,
			row.resumed_at,
			row.resumed_by,
			row.notified_level,
		);
	}

	list(): SendingDomainHealth[] {
		return this.sql
			.exec(`SELECT * FROM sending_health ORDER BY domain ASC`)
			.toArray()
			.map(fromRow);
	}

	get(domain: string): SendingDomainHealth | null {
		const row = this.sql.exec(`SELECT * FROM sending_health WHERE domain = ?`, domain.toLowerCase()).toArray()[0];
		return row ? fromRow(row) : null;
	}

	/** Whether bulk sends from `domain` are paused. Cheap; on every bulk send. */
	isBulkPaused(domain: string): { paused: boolean; reason: string | null } {
		const row = this.sql
			.exec(`SELECT bulk_paused, paused_reason FROM sending_health WHERE domain = ?`, domain.toLowerCase())
			.toArray()[0];
		return { paused: Number(row?.bulk_paused ?? 0) === 1, reason: row?.paused_reason ?? null };
	}

	/** Apply an evaluation atomically; returns the new row and whether to notify. */
	record(
		domain: string,
		evaluation: SpamRateEvaluation & { source: string; providerStatus?: string | null },
		now: number,
	): { health: SendingDomainHealth; notify: HealthNotification } {
		const key = domain.toLowerCase();
		return this.transaction(() => {
			const prev = this.get(key) ?? emptyDomainHealth(key);
			const { next, notify } = nextDomainHealth(prev, evaluation, now);
			next.domain = key;
			this.write(next);
			return { health: next, notify };
		});
	}

	/** Lift a pause. Returns null when the domain has no row. */
	resume(domain: string, by: string | null, now: number): SendingDomainHealth | null {
		const key = domain.toLowerCase();
		return this.transaction(() => {
			const prev = this.get(key);
			if (!prev) return null;
			const next: SendingDomainHealth = {
				...prev,
				bulk_paused: false,
				paused_at: null,
				paused_reason: null,
				resumed_at: now,
				resumed_by: by,
			};
			this.write(next);
			return next;
		});
	}

	/**
	 * Claim the next evaluation run: true when the last run was at least
	 * `intervalMs` ago (or never), recording `now` as the new last run. One
	 * statement-pair inside a transaction, so two cron ticks cannot both win.
	 * Kept in the AuthDO `meta` table.
	 */
	claimEvaluation(now: number, intervalMs: number): boolean {
		return this.transaction(() => {
			const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, LAST_RUN_KEY).toArray()[0];
			const last = row ? Number(row.value) : 0;
			if (Number.isFinite(last) && now - last < intervalMs) return false;
			this.sql.exec(
				`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				LAST_RUN_KEY,
				String(now),
			);
			return true;
		});
	}

	/** Pause by hand (an administrator stopping bulk mail pre-emptively). */
	pause(domain: string, reason: string, now: number): SendingDomainHealth {
		const key = domain.toLowerCase();
		return this.transaction(() => {
			const prev = this.get(key) ?? emptyDomainHealth(key);
			const next: SendingDomainHealth = { ...prev, domain: key, bulk_paused: true, paused_at: now, paused_reason: reason };
			this.write(next);
			return next;
		});
	}
}
