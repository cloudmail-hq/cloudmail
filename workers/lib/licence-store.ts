/**
 * Licence state in the global AuthDO (migration `0025_licence`): this
 * deployment's `deployment_id` and the signed token the licence server
 * issued for it. One row.
 *
 * The licence KEY is never stored: it is sent once to the licence server on
 * activation (and deactivation) and dropped. Only the token it buys is kept.
 */

import type { AuthSql, AuthTransaction } from "../auth/store-core";

export interface LicenceRecord {
	deploymentId: string;
	token: string | null;
	/** Unix seconds, from the server's `refresh_after`. */
	refreshAfter: number | null;
	/** Unix seconds of the last successful activation or refresh. */
	lastRefreshAt: number | null;
	lastAttemptAt: number | null;
	/** Consecutive failed refreshes. */
	failureCount: number;
	/**
	 * A terminal answer from the licence server (`revoked`, `expired`,
	 * `payment_required`, `invalid_token`, `token_expired`), which locks the
	 * app whatever the token says. Cleared by the next successful activation
	 * or refresh.
	 */
	serverStatus: string | null;
	/** The server's `reason` alongside it, e.g. `key_replaced`. */
	serverReason: string | null;
	updatedAt: number;
}

function toRecord(row: Record<string, unknown>): LicenceRecord {
	const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
	const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
	return {
		deploymentId: String(row.deployment_id),
		token: str(row.token),
		refreshAfter: num(row.refresh_after),
		lastRefreshAt: num(row.last_refresh_at),
		lastAttemptAt: num(row.last_attempt_at),
		failureCount: Number(row.failure_count ?? 0),
		serverStatus: str(row.server_status),
		serverReason: str(row.server_reason),
		updatedAt: Number(row.updated_at),
	};
}

export class LicenceStore {
	constructor(
		private readonly sql: AuthSql,
		private readonly transaction: AuthTransaction,
	) {}

	private read(): LicenceRecord | null {
		const row = this.sql.exec(`SELECT * FROM licence WHERE id = 'default'`).toArray()[0];
		return row ? toRecord(row) : null;
	}

	/**
	 * The row, creating it (with a fresh `deployment_id`) on first use. The
	 * id is generated once and never changes: the licence server binds every
	 * token to it.
	 */
	get(now: number, newId: () => string): LicenceRecord {
		return this.transaction(() => {
			const existing = this.read();
			if (existing) return existing;
			this.sql.exec(
				`INSERT INTO licence (id, deployment_id, failure_count, updated_at) VALUES ('default', ?, 0, ?)`,
				newId(),
				now,
			);
			return this.read()!;
		});
	}

	/** A successful activation or refresh: new token, failures cleared. */
	storeToken(token: string, refreshAfter: number | null, now: number): LicenceRecord | null {
		this.sql.exec(
			`UPDATE licence SET token = ?, refresh_after = ?, last_refresh_at = ?, last_attempt_at = ?,
			   failure_count = 0, server_status = NULL, server_reason = NULL, updated_at = ?
			 WHERE id = 'default'`,
			token,
			refreshAfter,
			now,
			now,
			now,
		);
		return this.read();
	}

	/**
	 * A failed refresh. The old token is kept. `serverStatus` is set only for
	 * a terminal answer; a network error or 5xx leaves it untouched.
	 */
	recordFailure(now: number, serverStatus: string | null, serverReason: string | null): LicenceRecord | null {
		if (serverStatus) {
			this.sql.exec(
				`UPDATE licence SET failure_count = failure_count + 1, last_attempt_at = ?, server_status = ?,
				   server_reason = ?, updated_at = ? WHERE id = 'default'`,
				now,
				serverStatus,
				serverReason,
				now,
			);
		} else {
			this.sql.exec(
				`UPDATE licence SET failure_count = failure_count + 1, last_attempt_at = ?, updated_at = ? WHERE id = 'default'`,
				now,
				now,
			);
		}
		return this.read();
	}

	/** Deactivated: the token goes, the deployment id stays. */
	clearToken(now: number): LicenceRecord | null {
		this.sql.exec(
			`UPDATE licence SET token = NULL, refresh_after = NULL, failure_count = 0, server_status = NULL,
			   server_reason = NULL, updated_at = ? WHERE id = 'default'`,
			now,
		);
		return this.read();
	}

	/**
	 * Claim the refresh slot: true when no attempt was made in the last
	 * `minIntervalSeconds` (all times here are Unix seconds), so the cron and
	 * a boot check in several isolates don't
	 * all call the licence server at once.
	 */
	claimRefresh(now: number, minIntervalSeconds: number): boolean {
		return this.transaction(() => {
			const row = this.read();
			if (!row) return false;
			if (row.lastAttemptAt !== null && now - row.lastAttemptAt < minIntervalSeconds) return false;
			this.sql.exec(`UPDATE licence SET last_attempt_at = ? WHERE id = 'default'`, now);
			return true;
		});
	}
}
