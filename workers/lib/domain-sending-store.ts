/**
 * Per-domain sending settings, one row per hostname in the global AuthDO
 * database (migrations `0026_domain_sending`, `0027_domain_sending_events`).
 * No row means Cloudflare.
 *
 * Like the Cloudflare connection (`./cf-connection-store.ts`), the store only
 * ever sees ciphertext: the `seal*` helpers encrypt in the Worker before the
 * RPC. The HKDF info is this table's own and the AES-GCM additional data names
 * the hostname and the column, so a ciphertext copied onto another domain (or
 * into another secret column) fails to decrypt.
 *
 * The store also keeps a deployment-wide marker in `meta`
 * (`sending.any_non_cloudflare`), rewritten in the same transaction as every
 * put and delete. The transport resolver reads it to know whether a failed
 * per-domain lookup can safely fall back to Cloudflare.
 */

import type { AuthSql, AuthTransaction } from "../auth/store-core";
import { decryptSecret, encryptSecret, type SecretPurpose } from "../auth/crypto";
import type { SendingLastEvent, SendingProvider, SendingTestResult } from "../../shared/ses-sending";

export const DOMAIN_SENDING_INFO = "tapetide/domain-sending/v1";

/** `meta` key: "1" when any domain is set to a provider other than Cloudflare. */
export const ANY_NON_CLOUDFLARE_META = "sending.any_non_cloudflare";

type SecretColumn = "ses-secret" | "resend-key" | "resend-webhook-secret";

function purpose(hostname: string, column: SecretColumn): SecretPurpose {
	return { info: DOMAIN_SENDING_INFO, aad: `domain-sending:${hostname.toLowerCase()}:${column}` };
}

export function sealSesSecret(secret: string, keyMaterial: string, hostname: string): Promise<string> {
	return encryptSecret(secret, keyMaterial, purpose(hostname, "ses-secret"));
}

/** Throws on a wrong key (AUTH_SECRET changed), tampering, another domain's ciphertext or a malformed value. */
export function openSesSecret(enc: string, keyMaterial: string, hostname: string): Promise<string> {
	return decryptSecret(enc, keyMaterial, purpose(hostname, "ses-secret"));
}

export function sealResendKey(key: string, keyMaterial: string, hostname: string): Promise<string> {
	return encryptSecret(key, keyMaterial, purpose(hostname, "resend-key"));
}

export function openResendKey(enc: string, keyMaterial: string, hostname: string): Promise<string> {
	return decryptSecret(enc, keyMaterial, purpose(hostname, "resend-key"));
}

export function sealResendWebhookSecret(secret: string, keyMaterial: string, hostname: string): Promise<string> {
	return encryptSecret(secret, keyMaterial, purpose(hostname, "resend-webhook-secret"));
}

export function openResendWebhookSecret(enc: string, keyMaterial: string, hostname: string): Promise<string> {
	return decryptSecret(enc, keyMaterial, purpose(hostname, "resend-webhook-secret"));
}

export interface DomainSendingRecord {
	hostname: string;
	provider: SendingProvider;
	region: string | null;
	accessKeyId: string | null;
	/** Ciphertext from `sealSesSecret`. Never leaves the Worker in a response. */
	secretEnc: string | null;
	configurationSet: string | null;
	/** The SNS topic SES publishes events to; webhook messages from any other topic are refused. */
	snsTopicArn: string | null;
	/** Random id in the webhook path (`/hooks/<provider>/<webhookId>`). */
	webhookId: string | null;
	/** Ciphertext from `sealResendKey`. */
	resendKeyEnc: string | null;
	resendKeyLast4: string | null;
	/** Ciphertext from `sealResendWebhookSecret`. */
	resendWebhookSecretEnc: string | null;
	lastTest: SendingTestResult | null;
	lastEvent: SendingLastEvent | null;
	/** Changes on every write; the transport cache's key. */
	updatedAt: number;
	updatedBy: string | null;
}

export interface PutDomainSendingInput {
	hostname: string;
	provider: SendingProvider;
	region: string | null;
	accessKeyId: string | null;
	/** `undefined` keeps the stored ciphertext; `null` clears it. */
	secretEnc?: string | null;
	configurationSet: string | null;
	/** `undefined` keeps the stored ARN; `null` clears it. */
	snsTopicArn?: string | null;
	/** `undefined` keeps the stored key (and its last 4); `null` clears it. */
	resendKeyEnc?: string | null;
	resendKeyLast4?: string | null;
	/** `undefined` keeps the stored secret; `null` clears it. */
	resendWebhookSecretEnc?: string | null;
	/** The connection test these settings just passed; otherwise kept only when nothing it described changed. */
	lastTest?: SendingTestResult;
	updatedBy: string | null;
	now: number;
}

function parseJson<T>(value: unknown): T | null {
	if (typeof value !== "string" || !value) return null;
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}

function toProvider(value: unknown): SendingProvider {
	return value === "ses" || value === "resend" ? value : "cloudflare";
}

function toRecord(row: Record<string, unknown>): DomainSendingRecord {
	const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
	return {
		hostname: String(row.hostname),
		provider: toProvider(row.provider),
		region: str(row.region),
		accessKeyId: str(row.access_key_id),
		secretEnc: str(row.secret_enc),
		configurationSet: str(row.configuration_set),
		snsTopicArn: str(row.sns_topic_arn),
		webhookId: str(row.webhook_id),
		resendKeyEnc: str(row.resend_key_enc),
		resendKeyLast4: str(row.resend_key_last4),
		resendWebhookSecretEnc: str(row.resend_webhook_secret_enc),
		lastTest: parseJson<SendingTestResult>(row.last_test),
		lastEvent: parseJson<SendingLastEvent>(row.last_event),
		updatedAt: Number(row.updated_at ?? 0),
		updatedBy: str(row.updated_by),
	};
}

function newWebhookId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** How long a provider event id is remembered for dedupe. SNS and Svix retry for under 2 days. */
export const EVENT_DEDUPE_MS = 7 * 24 * 60 * 60 * 1000;

export class DomainSendingStore {
	constructor(
		private readonly sql: AuthSql,
		private readonly transaction: AuthTransaction,
	) {}

	get(hostname: string): DomainSendingRecord | null {
		const row = this.sql
			.exec(`SELECT * FROM domain_sending WHERE hostname = ?`, hostname.trim().toLowerCase())
			.toArray()[0];
		return row ? toRecord(row as Record<string, unknown>) : null;
	}

	/** The settings a webhook path names, or null. */
	getByWebhookId(webhookId: string): DomainSendingRecord | null {
		if (!/^[0-9a-f]{32}$/.test(webhookId)) return null;
		const row = this.sql.exec(`SELECT * FROM domain_sending WHERE webhook_id = ?`, webhookId).toArray()[0];
		return row ? toRecord(row as Record<string, unknown>) : null;
	}

	/**
	 * Insert or replace a domain's settings. Changing the provider, region or
	 * a key drops the last test (it described other settings). `updated_at`
	 * always moves forward so a cached copy keyed by it is recognised as stale.
	 * The webhook id is minted once and kept, so the URL configured at the
	 * provider stays valid across edits.
	 */
	put(input: PutDomainSendingInput): DomainSendingRecord {
		const hostname = input.hostname.trim().toLowerCase();
		return this.transaction(() => {
			const prev = this.get(hostname);
			const updatedAt = Math.max(input.now, (prev?.updatedAt ?? 0) + 1);
			const keep = <T>(next: T | undefined, old: T | null | undefined): T | null =>
				next !== undefined ? next : (old ?? null);
			const secretEnc = keep(input.secretEnc, prev?.secretEnc);
			const snsTopicArn = keep(input.snsTopicArn, prev?.snsTopicArn);
			const resendKeyEnc = keep(input.resendKeyEnc, prev?.resendKeyEnc);
			const resendKeyLast4 =
				input.resendKeyEnc === null ? null : keep(input.resendKeyLast4, prev?.resendKeyLast4);
			const resendWebhookSecretEnc = keep(input.resendWebhookSecretEnc, prev?.resendWebhookSecretEnc);
			const webhookId = prev?.webhookId ?? newWebhookId();
			// The test describes the credentials and identity, not the routing, so
			// switching provider alone keeps it.
			const sameTarget =
				prev &&
				prev.region === input.region &&
				prev.configurationSet === input.configurationSet &&
				prev.accessKeyId === input.accessKeyId &&
				input.secretEnc === undefined &&
				input.resendKeyEnc === undefined;
			const lastTest = input.lastTest
				? JSON.stringify(input.lastTest)
				: sameTarget && prev.lastTest
					? JSON.stringify(prev.lastTest)
					: null;
			this.sql.exec(
				`INSERT INTO domain_sending
				   (hostname, provider, region, access_key_id, secret_enc, configuration_set, last_test, updated_at, updated_by,
				    sns_topic_arn, webhook_id, resend_key_enc, resend_key_last4, resend_webhook_secret_enc, last_event)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(hostname) DO UPDATE SET
				   provider = excluded.provider, region = excluded.region, access_key_id = excluded.access_key_id,
				   secret_enc = excluded.secret_enc, configuration_set = excluded.configuration_set,
				   last_test = excluded.last_test, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
				   sns_topic_arn = excluded.sns_topic_arn, webhook_id = excluded.webhook_id,
				   resend_key_enc = excluded.resend_key_enc, resend_key_last4 = excluded.resend_key_last4,
				   resend_webhook_secret_enc = excluded.resend_webhook_secret_enc`,
				hostname,
				input.provider,
				input.region,
				input.accessKeyId,
				secretEnc,
				input.configurationSet,
				lastTest,
				updatedAt,
				input.updatedBy,
				snsTopicArn,
				webhookId,
				resendKeyEnc,
				resendKeyLast4,
				resendWebhookSecretEnc,
				prev?.lastEvent ? JSON.stringify(prev.lastEvent) : null,
			);
			this.writeMarker();
			return this.get(hostname)!;
		});
	}

	/** Record a connection test. Does not move `updated_at`: routing did not change. */
	recordTest(hostname: string, result: SendingTestResult): DomainSendingRecord | null {
		const key = hostname.trim().toLowerCase();
		this.sql.exec(`UPDATE domain_sending SET last_test = ? WHERE hostname = ?`, JSON.stringify(result), key);
		return this.get(key);
	}

	/** Record the latest webhook event for the status line. Does not move `updated_at`. */
	recordEvent(hostname: string, event: SendingLastEvent): void {
		this.sql.exec(
			`UPDATE domain_sending SET last_event = ? WHERE hostname = ?`,
			JSON.stringify(event),
			hostname.trim().toLowerCase(),
		);
	}

	/**
	 * Remember a provider event id (SNS MessageId, svix-id). True the first time,
	 * false for a duplicate. Old ids are pruned on the way.
	 */
	markEventSeen(eventId: string, now: number): boolean {
		return this.transaction(() => {
			this.sql.exec(`DELETE FROM domain_sending_events_seen WHERE seen_at < ?`, now - EVENT_DEDUPE_MS);
			const wrote = this.sql
				.exec(
					`INSERT INTO domain_sending_events_seen (event_id, seen_at) VALUES (?, ?)
					 ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
					eventId.slice(0, 200),
					now,
				)
				.toArray();
			return wrote.length > 0;
		});
	}

	/** Forget an event id, so a provider retry is processed again (the first attempt failed). */
	forgetEvent(eventId: string): void {
		this.sql.exec(`DELETE FROM domain_sending_events_seen WHERE event_id = ?`, eventId.slice(0, 200));
	}

	/** Forget the domain's settings, secrets included. It sends through Cloudflare again. */
	delete(hostname: string): boolean {
		return this.transaction(() => {
			const removed =
				this.sql
					.exec(`DELETE FROM domain_sending WHERE hostname = ? RETURNING hostname`, hostname.trim().toLowerCase())
					.toArray().length > 0;
			this.writeMarker();
			return removed;
		});
	}

	/** "1" when any domain sends through a provider other than Cloudflare, else "0". */
	anyNonCloudflare(): boolean {
		const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, ANY_NON_CLOUDFLARE_META).toArray()[0] as
			| { value?: unknown }
			| undefined;
		if (row) return String(row.value) === "1";
		// Never written (a store older than the marker): compute it once.
		return this.writeMarker();
	}

	private writeMarker(): boolean {
		const any =
			this.sql.exec(`SELECT 1 AS x FROM domain_sending WHERE provider <> 'cloudflare' LIMIT 1`).toArray().length > 0;
		this.sql.exec(
			`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			ANY_NON_CLOUDFLARE_META,
			any ? "1" : "0",
		);
		return any;
	}
}
