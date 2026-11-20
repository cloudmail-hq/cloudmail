// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * IMAP import credentials, stored in the global AuthDO database (migration
 * `0020_import_credentials`).
 *
 * The store only ever sees ciphertext: `sealImportPassword` encrypts in the
 * Worker with AUTH_SECRET-derived key material before the RPC, the same way
 * TOTP secrets are kept at rest. The HKDF info differs from TOTP's, and the
 * AES-GCM additional data is the job id, so a ciphertext copied onto another
 * job (or into the TOTP column) fails to decrypt.
 */

import type { AuthSql, AuthTransaction } from "../auth/store-core";
import { decryptSecret, encryptSecret, type SecretPurpose } from "../auth/crypto";

const PURPOSE_INFO = "tapetide-import-imap-v1";

function purpose(jobId: string): SecretPurpose {
	return { info: PURPOSE_INFO, aad: `import:${jobId}` };
}

export function sealImportPassword(password: string, keyMaterial: string, jobId: string): Promise<string> {
	return encryptSecret(password, keyMaterial, purpose(jobId));
}

export function openImportPassword(enc: string, keyMaterial: string, jobId: string): Promise<string> {
	return decryptSecret(enc, keyMaterial, purpose(jobId));
}

export class ImportCredentialStore {
	constructor(
		private readonly sql: AuthSql,
		private readonly transaction: AuthTransaction,
	) {}

	put(input: { jobId: string; mailboxId: string; secretEnc: string; now: number }): void {
		this.sql.exec(
			`INSERT INTO import_credentials (job_id, mailbox_id, secret_enc, created_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(job_id) DO UPDATE SET secret_enc = excluded.secret_enc, mailbox_id = excluded.mailbox_id`,
			input.jobId,
			input.mailboxId,
			input.secretEnc,
			input.now,
		);
	}

	/** The ciphertext, only for the mailbox that owns the job. */
	get(jobId: string, mailboxId: string): string | null {
		const row = this.sql
			.exec(`SELECT secret_enc FROM import_credentials WHERE job_id = ? AND mailbox_id = ?`, jobId, mailboxId)
			.toArray()[0];
		return row ? String(row.secret_enc) : null;
	}

	delete(jobId: string): boolean {
		return this.sql.exec(`DELETE FROM import_credentials WHERE job_id = ? RETURNING job_id`, jobId).toArray().length > 0;
	}

	/** Every credential of a mailbox, for mailbox deletion. */
	deleteForMailbox(mailboxId: string): number {
		return this.transaction(
			() => this.sql.exec(`DELETE FROM import_credentials WHERE mailbox_id = ? RETURNING job_id`, mailboxId).toArray().length,
		);
	}
}
