// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The stored Cloudflare connection (Settings → Cloudflare connection), one row
 * in the global AuthDO database (migration `0022_cloudflare_connection`).
 *
 * Like the IMAP credentials (`./import-credential-store.ts`), the store only
 * ever sees ciphertext: `sealCloudflareToken` encrypts in the Worker with
 * AUTH_SECRET-derived key material before the RPC. The HKDF info is this
 * table's own, so a ciphertext moved into another secret column (or the TOTP
 * one) fails to decrypt.
 */

import type { AuthSql, AuthTransaction } from "../auth/store-core";
import { decryptSecret, encryptSecret, type SecretPurpose } from "../auth/crypto";
import type { CfCapability, CfTokenKind } from "../../shared/cf-connection";

export const CF_CONNECTION_PURPOSE: SecretPurpose = { info: "tapetide/cf-connection/v1", aad: "default" };

export function sealCloudflareToken(token: string, keyMaterial: string): Promise<string> {
	return encryptSecret(token, keyMaterial, CF_CONNECTION_PURPOSE);
}

/** Throws on a wrong key (AUTH_SECRET changed), tampering or a malformed value. */
export function openCloudflareToken(enc: string, keyMaterial: string): Promise<string> {
	return decryptSecret(enc, keyMaterial, CF_CONNECTION_PURPOSE);
}

export interface CloudflareConnectionRecord {
	/** Ciphertext from `sealCloudflareToken`. Never leaves the Worker in a response. */
	tokenEnc: string;
	/** Last 4 characters of the token, for display and audit. */
	last4: string;
	accountId: string | null;
	accountName: string | null;
	/** Set by discovery when `WORKER_SCRIPT_NAME` is unset and the default is wrong. */
	workerScriptName: string | null;
	tokenKind: CfTokenKind | null;
	capabilities: CfCapability[];
	verifiedAt: number | null;
	createdBy: string | null;
	createdAt: number;
	/** Changes on every write; the resolver's cache key. */
	updatedAt: number;
}

export interface PutCloudflareConnectionInput {
	tokenEnc: string;
	last4: string;
	accountId: string | null;
	accountName: string | null;
	tokenKind: CfTokenKind;
	capabilities: CfCapability[];
	verifiedAt: number;
	createdBy: string | null;
	now: number;
	/** Omitted: a replaced token keeps the discovered script name. */
	workerScriptName?: string | null;
}

export interface CloudflareConnectionPatch {
	capabilities?: CfCapability[];
	verifiedAt?: number;
	workerScriptName?: string | null;
	accountName?: string | null;
}

function parseCapabilities(raw: unknown): CfCapability[] {
	if (typeof raw !== "string" || !raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as CfCapability[]) : [];
	} catch {
		return [];
	}
}

function toRecord(row: Record<string, unknown>): CloudflareConnectionRecord {
	const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
	const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
	const kind = str(row.token_kind);
	return {
		tokenEnc: String(row.token_enc ?? ""),
		last4: String(row.last4 ?? ""),
		accountId: str(row.account_id),
		accountName: str(row.account_name),
		workerScriptName: str(row.worker_script_name),
		tokenKind: kind === "user" || kind === "account" ? kind : null,
		capabilities: parseCapabilities(row.capabilities),
		verifiedAt: num(row.verified_at),
		createdBy: str(row.created_by),
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
	};
}

export class CloudflareConnectionStore {
	constructor(
		private readonly sql: AuthSql,
		private readonly transaction: AuthTransaction,
	) {}

	get(): CloudflareConnectionRecord | null {
		const row = this.sql.exec(`SELECT * FROM cloudflare_connection WHERE id = 'default'`).toArray()[0];
		return row ? toRecord(row as Record<string, unknown>) : null;
	}

	/**
	 * Insert or replace the token. `updated_at` always moves forward, even for
	 * two writes in the same millisecond, so a cached copy keyed by it is
	 * always recognised as stale.
	 */
	put(input: PutCloudflareConnectionInput): CloudflareConnectionRecord {
		return this.transaction(() => {
			const prev = this.get();
			const updatedAt = Math.max(input.now, (prev?.updatedAt ?? 0) + 1);
			const script = input.workerScriptName !== undefined ? input.workerScriptName : (prev?.workerScriptName ?? null);
			this.sql.exec(
				`INSERT INTO cloudflare_connection
				   (id, token_enc, last4, account_id, account_name, worker_script_name, token_kind, capabilities,
				    verified_at, created_by, created_at, updated_at)
				 VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   token_enc = excluded.token_enc, last4 = excluded.last4, account_id = excluded.account_id,
				   account_name = excluded.account_name, worker_script_name = excluded.worker_script_name,
				   token_kind = excluded.token_kind, capabilities = excluded.capabilities,
				   verified_at = excluded.verified_at, created_by = excluded.created_by,
				   created_at = excluded.created_at, updated_at = excluded.updated_at`,
				input.tokenEnc,
				input.last4,
				input.accountId,
				input.accountName,
				script,
				input.tokenKind,
				JSON.stringify(input.capabilities),
				input.verifiedAt,
				input.createdBy,
				input.now,
				updatedAt,
			);
			return this.get()!;
		});
	}

	/** Change the probe results or discovered metadata, never the token. Null when not connected. */
	update(patch: CloudflareConnectionPatch, now: number): CloudflareConnectionRecord | null {
		return this.transaction(() => {
			const prev = this.get();
			if (!prev) return null;
			const updatedAt = Math.max(now, prev.updatedAt + 1);
			this.sql.exec(
				`UPDATE cloudflare_connection SET capabilities = ?, verified_at = ?, worker_script_name = ?, account_name = ?, updated_at = ?
				 WHERE id = 'default'`,
				JSON.stringify(patch.capabilities ?? prev.capabilities),
				patch.verifiedAt ?? prev.verifiedAt,
				patch.workerScriptName !== undefined ? patch.workerScriptName : prev.workerScriptName,
				patch.accountName !== undefined ? patch.accountName : prev.accountName,
				updatedAt,
			);
			return this.get();
		});
	}

	delete(): boolean {
		return this.sql.exec(`DELETE FROM cloudflare_connection WHERE id = 'default' RETURNING id`).toArray().length > 0;
	}
}
