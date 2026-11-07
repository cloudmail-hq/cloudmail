/**
 * The persisted deployment origin (migration `0024_deployment_origin` in the
 * global AuthDO). One row: the public origin this deployment was last reached
 * on by a trusted request, and how good that origin is (`rank`).
 *
 * See `workers/lib/deployment-origin.ts` for who may write it and when.
 */

import type { AuthSql, AuthTransaction } from "../auth/store-core";

export interface DeploymentOriginRecord {
	origin: string;
	/** 2 = https custom domain, 1 = https `*.workers.dev`, 0 = localhost. */
	rank: number;
	/** `request` or `setup`. */
	source: string;
	updatedAt: number;
}

export interface RecordOriginResult {
	/** The origin stored after this call (the previous one when this was refused). */
	origin: string;
	changed: boolean;
}

export class DeploymentOriginStore {
	constructor(
		private readonly sql: AuthSql,
		private readonly transaction: AuthTransaction,
	) {}

	get(): DeploymentOriginRecord | null {
		const row = this.sql
			.exec(`SELECT origin, rank, source, updated_at FROM deployment_origin WHERE id = 'default'`)
			.toArray()[0];
		if (!row) return null;
		return {
			origin: String(row.origin),
			rank: Number(row.rank),
			source: String(row.source),
			updatedAt: Number(row.updated_at),
		};
	}

	/**
	 * Store `origin` unless a better one is already known. A higher rank always
	 * wins; the same rank replaces the stored origin when it differs (the
	 * deployment moved). A lower rank never replaces a higher one, so a visit
	 * on `*.workers.dev` or localhost leaves a custom domain in place.
	 */
	record(origin: string, rank: number, source: string, now: number): RecordOriginResult {
		return this.transaction(() => {
			const current = this.get();
			if (current && (current.rank > rank || current.origin === origin)) {
				return { origin: current.origin, changed: false };
			}
			this.sql.exec(
				`INSERT INTO deployment_origin (id, origin, rank, source, first_seen_at, updated_at)
				 VALUES ('default', ?, ?, ?, ?, ?)
				 ON CONFLICT (id) DO UPDATE SET origin = excluded.origin, rank = excluded.rank,
				   source = excluded.source, updated_at = excluded.updated_at`,
				origin,
				rank,
				source,
				now,
				now,
			);
			return { origin, changed: true };
		});
	}
}
