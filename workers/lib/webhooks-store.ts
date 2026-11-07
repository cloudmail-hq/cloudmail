// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Storage for outbound webhooks: endpoints, deliveries and the attempt log.
 *
 * Runs over a minimal SQL interface, like `AuthStore`, so the same code backs
 * `WebhookDO` and the unit tests (`node:sqlite`). No network here: the Durable
 * Object fetches, then hands each outcome back to {@link WebhookStore.recordAttempt},
 * which owns every scheduling decision.
 *
 * One global instance. Volume is "a few events per message", and keeping
 * endpoints and their deliveries in one SQLite database is what makes
 * "enqueue once per matching endpoint" and the auto-disable counter plain
 * transactions.
 */

import {
	WEBHOOK_MAX_ATTEMPTS,
	isWebhookEventType,
	shouldAutoDisable,
	webhookRetryDelayMs,
	type WebhookEventType,
} from "../../shared/webhooks";

export interface WebhookSql {
	exec(query: string, ...bindings: unknown[]): { toArray(): any[] };
}

export type WebhookTransaction = <T>(fn: () => T) => T;

export type DeliveryStatus = "pending" | "retrying" | "delivered" | "failed";

export interface WebhookEndpoint {
	id: string;
	name: string;
	url: string;
	events: WebhookEventType[];
	/** Mailbox addresses this endpoint hears about, or null for all of them. */
	mailboxes: string[] | null;
	enabled: boolean;
	/** Why it is off when the system switched it off; null when a person did. */
	disabledReason: string | null;
	/** Last four characters of the secret, so a person can tell two apart. */
	secretHint: string;
	createdBy: string | null;
	createdAt: number;
	updatedAt: number;
	consecutiveFailures: number;
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
}

export interface WebhookAttempt {
	attempt: number;
	statusCode: number | null;
	durationMs: number;
	error: string | null;
	at: number;
}

export interface WebhookDelivery {
	id: string;
	endpointId: string;
	eventId: string;
	eventType: WebhookEventType;
	mailbox: string;
	status: DeliveryStatus;
	attempts: number;
	nextAttemptAt: number | null;
	lastStatusCode: number | null;
	lastError: string | null;
	lastDurationMs: number | null;
	createdAt: number;
	updatedAt: number;
	test: boolean;
	attemptLog?: WebhookAttempt[];
}

/** What the DO needs to send one delivery. */
export interface DueDelivery {
	id: string;
	endpointId: string;
	url: string;
	secret: string;
	eventType: WebhookEventType;
	payload: string;
	attempt: number;
}

export interface AttemptOutcome {
	statusCode: number | null;
	durationMs: number;
	error: string | null;
}

/** Deliveries kept per endpoint; older finished ones are pruned. */
export const DELIVERIES_KEPT_PER_ENDPOINT = 100;

/**
 * How long a claimed delivery is held before another run may take it.
 * Comfortably above the 10 s request timeout, so a delivery is never sent twice
 * concurrently, while one abandoned by an evicted object is picked up again.
 */
export const CLAIM_LEASE_MS = 2 * 60_000;

const MAX_ERROR_LENGTH = 500;

const MIGRATIONS: { name: string; statements: string[] }[] = [
	{
		name: "0001_webhooks",
		statements: [
			`CREATE TABLE IF NOT EXISTS webhook_endpoints (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				url TEXT NOT NULL,
				secret TEXT NOT NULL,
				events TEXT NOT NULL,
				mailboxes TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				disabled_reason TEXT,
				created_by TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				consecutive_failures INTEGER NOT NULL DEFAULT 0,
				failing_since INTEGER,
				last_success_at INTEGER,
				last_failure_at INTEGER
			)`,
			`CREATE TABLE IF NOT EXISTS webhook_deliveries (
				id TEXT PRIMARY KEY,
				endpoint_id TEXT NOT NULL,
				event_id TEXT NOT NULL,
				event_type TEXT NOT NULL,
				mailbox TEXT NOT NULL,
				payload TEXT NOT NULL,
				status TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at INTEGER,
				last_status_code INTEGER,
				last_error TEXT,
				last_duration_ms INTEGER,
				is_test INTEGER NOT NULL DEFAULT 0,
				-- Held while an attempt is in flight. Separate from next_attempt_at
				-- so a manual retry during a long backoff is not mistaken for a
				-- concurrent send, and disabling an endpoint cannot clear it.
				lease_until INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)`,
			// One delivery per event per endpoint: a re-sent event (a retried
			// handler, a double-reported bounce) is a no-op, not a second POST.
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_deliveries_event
				ON webhook_deliveries(endpoint_id, event_id)`,
			`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
				ON webhook_deliveries(status, next_attempt_at)`,
			`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint
				ON webhook_deliveries(endpoint_id, created_at DESC)`,
			`CREATE TABLE IF NOT EXISTS webhook_attempts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				delivery_id TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				status_code INTEGER,
				duration_ms INTEGER NOT NULL,
				error TEXT,
				at INTEGER NOT NULL
			)`,
			`CREATE INDEX IF NOT EXISTS idx_webhook_attempts_delivery
				ON webhook_attempts(delivery_id)`,
		],
	},
];

export const WEBHOOK_MIGRATION_NAMES = MIGRATIONS.map((m) => m.name);

function parseJsonArray(value: unknown): string[] {
	if (typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

function rowToEndpoint(row: any): WebhookEndpoint {
	const mailboxes = row.mailboxes == null ? null : parseJsonArray(row.mailboxes);
	return {
		id: String(row.id),
		name: String(row.name),
		url: String(row.url),
		events: parseJsonArray(row.events).filter(isWebhookEventType),
		mailboxes,
		enabled: Number(row.enabled) === 1,
		disabledReason: row.disabled_reason ?? null,
		secretHint: String(row.secret).slice(-4),
		createdBy: row.created_by ?? null,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		consecutiveFailures: Number(row.consecutive_failures ?? 0),
		lastSuccessAt: row.last_success_at == null ? null : Number(row.last_success_at),
		lastFailureAt: row.last_failure_at == null ? null : Number(row.last_failure_at),
	};
}

function rowToDelivery(row: any): WebhookDelivery {
	return {
		id: String(row.id),
		endpointId: String(row.endpoint_id),
		eventId: String(row.event_id),
		eventType: row.event_type as WebhookEventType,
		mailbox: String(row.mailbox),
		status: row.status as DeliveryStatus,
		attempts: Number(row.attempts),
		nextAttemptAt: row.next_attempt_at == null ? null : Number(row.next_attempt_at),
		lastStatusCode: row.last_status_code == null ? null : Number(row.last_status_code),
		lastError: row.last_error ?? null,
		lastDurationMs: row.last_duration_ms == null ? null : Number(row.last_duration_ms),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		test: Number(row.is_test) === 1,
	};
}

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export interface CreateEndpointInput {
	name: string;
	url: string;
	secret: string;
	events: WebhookEventType[];
	mailboxes: string[] | null;
	enabled: boolean;
	createdBy: string | null;
	now: number;
}

export interface UpdateEndpointInput {
	name?: string;
	url?: string;
	events?: WebhookEventType[];
	mailboxes?: string[] | null;
	enabled?: boolean;
	now: number;
}

export interface EnqueueInput {
	eventId: string;
	type: WebhookEventType;
	mailbox: string;
	/** The complete JSON body, identical for every endpoint and every retry. */
	payload: string;
	now: number;
}

export class WebhookStore {
	constructor(
		private readonly sql: WebhookSql,
		private readonly transaction: WebhookTransaction,
	) {
		this.migrate();
	}

	private migrate(): void {
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS applied_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
		);
		const applied = new Set(
			this.sql.exec(`SELECT name FROM applied_migrations`).toArray().map((r) => String(r.name)),
		);
		for (const m of MIGRATIONS) {
			if (applied.has(m.name)) continue;
			this.transaction(() => {
				for (const stmt of m.statements) this.sql.exec(stmt);
				this.sql.exec(`INSERT INTO applied_migrations (name, applied_at) VALUES (?, ?)`, m.name, Date.now());
			});
		}
	}

	private one(query: string, ...bindings: unknown[]): any | undefined {
		return this.sql.exec(query, ...bindings).toArray()[0];
	}

	// ── Endpoints ──────────────────────────────────────────────────

	listEndpoints(): WebhookEndpoint[] {
		return this.sql
			.exec(`SELECT * FROM webhook_endpoints ORDER BY created_at ASC`)
			.toArray()
			.map(rowToEndpoint);
	}

	getEndpoint(id: string): WebhookEndpoint | null {
		const row = this.one(`SELECT * FROM webhook_endpoints WHERE id = ?`, id);
		return row ? rowToEndpoint(row) : null;
	}

	createEndpoint(input: CreateEndpointInput): WebhookEndpoint {
		const id = newId("wh");
		this.sql.exec(
			`INSERT INTO webhook_endpoints
				(id, name, url, secret, events, mailboxes, enabled, created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			input.name,
			input.url,
			input.secret,
			JSON.stringify(input.events),
			input.mailboxes === null ? null : JSON.stringify(input.mailboxes),
			input.enabled ? 1 : 0,
			input.createdBy,
			input.now,
			input.now,
		);
		return this.getEndpoint(id)!;
	}

	updateEndpoint(id: string, patch: UpdateEndpointInput): WebhookEndpoint | null {
		return this.transaction(() => {
			const current = this.getEndpoint(id);
			if (!current) return null;
			const enabled = patch.enabled ?? current.enabled;
			// Turning an endpoint back on is a person saying "it works now", so the
			// failure streak that switched it off starts over.
			const reEnabled = enabled && !current.enabled;
			this.sql.exec(
				`UPDATE webhook_endpoints
				    SET name = ?, url = ?, events = ?, mailboxes = ?, enabled = ?,
				        disabled_reason = CASE WHEN ? = 1 THEN NULL ELSE disabled_reason END,
				        consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures END,
				        failing_since = CASE WHEN ? = 1 THEN NULL ELSE failing_since END,
				        updated_at = ?
				  WHERE id = ?`,
				patch.name ?? current.name,
				patch.url ?? current.url,
				JSON.stringify(patch.events ?? current.events),
				patch.mailboxes === undefined
					? current.mailboxes === null
						? null
						: JSON.stringify(current.mailboxes)
					: patch.mailboxes === null
						? null
						: JSON.stringify(patch.mailboxes),
				enabled ? 1 : 0,
				enabled ? 1 : 0,
				reEnabled ? 1 : 0,
				reEnabled ? 1 : 0,
				patch.now,
				id,
			);
			// Switched off by hand: nothing queued should go out afterwards.
			if (!enabled && current.enabled) this.abandonQueued(id, "Endpoint disabled", patch.now);
			return this.getEndpoint(id);
		});
	}

	rotateSecret(id: string, secret: string, now: number): WebhookEndpoint | null {
		this.sql.exec(`UPDATE webhook_endpoints SET secret = ?, updated_at = ? WHERE id = ?`, secret, now, id);
		return this.getEndpoint(id);
	}

	deleteEndpoint(id: string): boolean {
		return this.transaction(() => {
			if (!this.getEndpoint(id)) return false;
			this.sql.exec(
				`DELETE FROM webhook_attempts WHERE delivery_id IN
					(SELECT id FROM webhook_deliveries WHERE endpoint_id = ?)`,
				id,
			);
			this.sql.exec(`DELETE FROM webhook_deliveries WHERE endpoint_id = ?`, id);
			this.sql.exec(`DELETE FROM webhook_endpoints WHERE id = ?`, id);
			return true;
		});
	}

	/** Event types any enabled endpoint wants for this mailbox. */
	wantedTypes(mailbox: string): WebhookEventType[] {
		const address = mailbox.toLowerCase();
		const out = new Set<WebhookEventType>();
		for (const endpoint of this.listEndpoints()) {
			if (!endpoint.enabled) continue;
			if (endpoint.mailboxes !== null && !endpoint.mailboxes.includes(address)) continue;
			for (const type of endpoint.events) out.add(type);
		}
		return [...out];
	}

	// ── Deliveries ─────────────────────────────────────────────────

	/**
	 * Queue one event for every enabled endpoint subscribed to it. Returns how
	 * many deliveries were created; an event already queued for an endpoint is
	 * skipped, so replaying an event is safe.
	 */
	enqueue(input: EnqueueInput): number {
		const address = input.mailbox.toLowerCase();
		return this.transaction(() => {
			let created = 0;
			for (const endpoint of this.listEndpoints()) {
				if (!endpoint.enabled || !endpoint.events.includes(input.type)) continue;
				if (endpoint.mailboxes !== null && !endpoint.mailboxes.includes(address)) continue;
				const exists = this.one(
					`SELECT 1 AS x FROM webhook_deliveries WHERE endpoint_id = ? AND event_id = ?`,
					endpoint.id,
					input.eventId,
				);
				if (exists) continue;
				this.sql.exec(
					`INSERT INTO webhook_deliveries
						(id, endpoint_id, event_id, event_type, mailbox, payload, status, attempts,
						 next_attempt_at, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
					newId("whd"),
					endpoint.id,
					input.eventId,
					input.type,
					address,
					input.payload,
					input.now,
					input.now,
					input.now,
				);
				created += 1;
			}
			return created;
		});
	}

	/** A test delivery for one endpoint, regardless of its event list. */
	createTestDelivery(endpointId: string, input: EnqueueInput): string | null {
		if (!this.getEndpoint(endpointId)) return null;
		const id = newId("whd");
		this.sql.exec(
			`INSERT INTO webhook_deliveries
				(id, endpoint_id, event_id, event_type, mailbox, payload, status, attempts,
				 next_attempt_at, is_test, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, 1, ?, ?)`,
			id,
			endpointId,
			input.eventId,
			input.type,
			input.mailbox.toLowerCase(),
			input.payload,
			input.now,
			input.now,
		);
		return id;
	}

	/**
	 * Take up to `limit` due deliveries and lease them, so a concurrent run (an
	 * alarm overlapping a manual retry) cannot send the same one twice.
	 */
	claimDue(now: number, limit: number): DueDelivery[] {
		return this.transaction(() => {
			const rows = this.sql
				.exec(
					`SELECT d.id, d.endpoint_id, d.event_type, d.payload, d.attempts, e.url, e.secret
					   FROM webhook_deliveries d
					   JOIN webhook_endpoints e ON e.id = d.endpoint_id
					  WHERE d.status IN ('pending', 'retrying')
					    AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?
					    AND (d.lease_until IS NULL OR d.lease_until <= ?)
					    AND e.enabled = 1
					  ORDER BY d.next_attempt_at ASC
					  LIMIT ?`,
					now,
					now,
					limit,
				)
				.toArray();
			for (const row of rows) {
				this.sql.exec(`UPDATE webhook_deliveries SET lease_until = ? WHERE id = ?`, now + CLAIM_LEASE_MS, row.id);
			}
			return rows.map((row) => ({
				id: String(row.id),
				endpointId: String(row.endpoint_id),
				url: String(row.url),
				secret: String(row.secret),
				eventType: row.event_type as WebhookEventType,
				payload: String(row.payload),
				attempt: Number(row.attempts) + 1,
			}));
		});
	}

	/** Claim one delivery for an immediate send (test, manual retry). */
	claimOne(deliveryId: string, now: number): DueDelivery | null {
		return this.transaction(() => {
			const row = this.one(
				`SELECT d.id, d.endpoint_id, d.event_type, d.payload, d.attempts, d.lease_until,
				        e.url, e.secret
				   FROM webhook_deliveries d
				   JOIN webhook_endpoints e ON e.id = d.endpoint_id
				  WHERE d.id = ?`,
				deliveryId,
			);
			if (!row) return null;
			// Being sent right now by another run, whatever its status says.
			if (row.lease_until != null && Number(row.lease_until) > now) return null;
			this.sql.exec(`UPDATE webhook_deliveries SET lease_until = ? WHERE id = ?`, now + CLAIM_LEASE_MS, deliveryId);
			return {
				id: String(row.id),
				endpointId: String(row.endpoint_id),
				url: String(row.url),
				secret: String(row.secret),
				eventType: row.event_type as WebhookEventType,
				payload: String(row.payload),
				attempt: Number(row.attempts) + 1,
			};
		});
	}

	/**
	 * File the outcome of one attempt and decide what happens next: delivered,
	 * retried on the backoff schedule, or failed for good. Also keeps the
	 * endpoint's failure streak and switches it off when the streak says it is
	 * dead. Returns the updated delivery and whether the endpoint was disabled.
	 */
	recordAttempt(
		deliveryId: string,
		outcome: AttemptOutcome,
		now: number,
	): { delivery: WebhookDelivery; endpointDisabled: boolean } | null {
		return this.transaction(() => {
			const row = this.one(`SELECT * FROM webhook_deliveries WHERE id = ?`, deliveryId);
			if (!row) return null;
			const attempts = Number(row.attempts) + 1;
			const ok = outcome.error === null && outcome.statusCode !== null && outcome.statusCode >= 200 && outcome.statusCode < 300;
			const error = ok ? null : (outcome.error ?? `HTTP ${outcome.statusCode}`).slice(0, MAX_ERROR_LENGTH);
			const isTest = Number(row.is_test) === 1;
			const endpointEnabled =
				Number(this.one(`SELECT enabled FROM webhook_endpoints WHERE id = ?`, row.endpoint_id)?.enabled) === 1;

			let status: DeliveryStatus;
			let nextAttemptAt: number | null = null;
			if (ok) {
				status = "delivered";
			} else if (isTest || !endpointEnabled) {
				// A test is a question asked now; retrying it later answers nobody.
				// A manual retry on a disabled endpoint gets one try: the scheduler
				// skips disabled endpoints, so "retrying" would never resolve.
				status = "failed";
			} else {
				const delay = webhookRetryDelayMs(attempts);
				if (delay === null) {
					status = "failed";
				} else {
					status = "retrying";
					nextAttemptAt = now + delay;
				}
			}

			this.sql.exec(
				`UPDATE webhook_deliveries
				    SET status = ?, attempts = ?, next_attempt_at = ?, last_status_code = ?,
				        last_error = ?, last_duration_ms = ?, updated_at = ?, lease_until = NULL
				  WHERE id = ?`,
				status,
				attempts,
				nextAttemptAt,
				outcome.statusCode,
				error,
				Math.round(outcome.durationMs),
				now,
				deliveryId,
			);
			this.sql.exec(
				`INSERT INTO webhook_attempts (delivery_id, attempt, status_code, duration_ms, error, at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				deliveryId,
				attempts,
				outcome.statusCode,
				Math.round(outcome.durationMs),
				error,
				now,
			);

			const endpointDisabled = this.trackEndpointHealth(String(row.endpoint_id), ok, now);
			this.prune(String(row.endpoint_id));
			return {
				delivery: rowToDelivery(this.one(`SELECT * FROM webhook_deliveries WHERE id = ?`, deliveryId)),
				endpointDisabled,
			};
		});
	}

	private trackEndpointHealth(endpointId: string, ok: boolean, now: number): boolean {
		if (ok) {
			this.sql.exec(
				`UPDATE webhook_endpoints
				    SET consecutive_failures = 0, failing_since = NULL, last_success_at = ?
				  WHERE id = ?`,
				now,
				endpointId,
			);
			return false;
		}
		this.sql.exec(
			`UPDATE webhook_endpoints
			    SET consecutive_failures = consecutive_failures + 1,
			        failing_since = COALESCE(failing_since, ?),
			        last_failure_at = ?
			  WHERE id = ?`,
			now,
			now,
			endpointId,
		);
		const row = this.one(
			`SELECT enabled, consecutive_failures, failing_since FROM webhook_endpoints WHERE id = ?`,
			endpointId,
		);
		if (!row || Number(row.enabled) !== 1) return false;
		const failingSince = row.failing_since == null ? null : Number(row.failing_since);
		if (!shouldAutoDisable(Number(row.consecutive_failures), failingSince, now)) return false;
		const reason = `Disabled automatically after ${row.consecutive_failures} consecutive failed deliveries.`;
		this.sql.exec(
			`UPDATE webhook_endpoints SET enabled = 0, disabled_reason = ?, updated_at = ? WHERE id = ?`,
			reason,
			now,
			endpointId,
		);
		this.abandonQueued(endpointId, reason, now);
		return true;
	}

	/** Fail everything still queued for an endpoint that has been switched off. */
	private abandonQueued(endpointId: string, reason: string, now: number): void {
		this.sql.exec(
			`UPDATE webhook_deliveries
			    SET status = 'failed', next_attempt_at = NULL,
			        last_error = COALESCE(last_error, ?), updated_at = ?
			  WHERE endpoint_id = ? AND status IN ('pending', 'retrying')`,
			reason,
			now,
			endpointId,
		);
	}

	/** Keep the newest {@link DELIVERIES_KEPT_PER_ENDPOINT} finished deliveries. */
	private prune(endpointId: string): void {
		const stale = this.sql
			.exec(
				`SELECT id FROM webhook_deliveries
				  WHERE endpoint_id = ? AND status IN ('delivered', 'failed')
				  ORDER BY created_at DESC, id DESC
				  LIMIT -1 OFFSET ?`,
				endpointId,
				DELIVERIES_KEPT_PER_ENDPOINT,
			)
			.toArray()
			.map((r) => String(r.id));
		for (const id of stale) {
			this.sql.exec(`DELETE FROM webhook_attempts WHERE delivery_id = ?`, id);
			this.sql.exec(`DELETE FROM webhook_deliveries WHERE id = ?`, id);
		}
	}

	getDelivery(id: string): WebhookDelivery | null {
		const row = this.one(`SELECT * FROM webhook_deliveries WHERE id = ?`, id);
		if (!row) return null;
		return { ...rowToDelivery(row), attemptLog: this.attemptsFor([id]).get(id) ?? [] };
	}

	listDeliveries(endpointId: string, limit = 50): WebhookDelivery[] {
		const capped = Math.max(1, Math.min(limit, DELIVERIES_KEPT_PER_ENDPOINT));
		const deliveries = this.sql
			.exec(
				`SELECT * FROM webhook_deliveries WHERE endpoint_id = ?
				  ORDER BY created_at DESC, id DESC LIMIT ?`,
				endpointId,
				capped,
			)
			.toArray()
			.map(rowToDelivery);
		const log = this.attemptsFor(deliveries.map((d) => d.id));
		return deliveries.map((d) => ({ ...d, attemptLog: log.get(d.id) ?? [] }));
	}

	private attemptsFor(ids: string[]): Map<string, WebhookAttempt[]> {
		const out = new Map<string, WebhookAttempt[]>();
		if (ids.length === 0) return out;
		const placeholders = ids.map(() => "?").join(",");
		const rows = this.sql
			.exec(
				`SELECT delivery_id, attempt, status_code, duration_ms, error, at
				   FROM webhook_attempts WHERE delivery_id IN (${placeholders})
				  ORDER BY id ASC`,
				...ids,
			)
			.toArray();
		for (const row of rows) {
			const list = out.get(String(row.delivery_id)) ?? [];
			list.push({
				attempt: Number(row.attempt),
				statusCode: row.status_code == null ? null : Number(row.status_code),
				durationMs: Number(row.duration_ms),
				error: row.error ?? null,
				at: Number(row.at),
			});
			out.set(String(row.delivery_id), list);
		}
		return out;
	}

	/** When the alarm should next fire, or null when nothing is queued. */
	nextWakeAt(): number | null {
		const row = this.one(
			// A leased delivery is due again when its lease runs out, which is what
			// rescues one abandoned by an evicted object.
			`SELECT MIN(MAX(d.next_attempt_at, COALESCE(d.lease_until, 0))) AS at
			   FROM webhook_deliveries d
			   JOIN webhook_endpoints e ON e.id = d.endpoint_id
			  WHERE d.status IN ('pending', 'retrying') AND d.next_attempt_at IS NOT NULL
			    AND e.enabled = 1`,
		);
		return row?.at == null ? null : Number(row.at);
	}
}

export { WEBHOOK_MAX_ATTEMPTS };
