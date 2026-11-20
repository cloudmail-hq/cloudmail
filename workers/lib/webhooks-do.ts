// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The global webhook Durable Object (`idFromName("global")`).
 *
 * Its own object rather than tables in AuthDO: deliveries are write-heavy and
 * retried on a timer, and an alarm is the natural way to fire "in exactly five
 * minutes". AuthDO sits on every authenticated request, and it should not be
 * the thing doing outbound HTTP.
 *
 * Every send happens in here: an RPC from the Worker enqueues and returns at
 * once, then the object drains its own queue. So mail handling never waits on
 * a slow endpoint, and a retry needs no request to carry it.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import {
	WebhookStore,
	type CreateEndpointInput,
	type UpdateEndpointInput,
	type EnqueueInput,
	type WebhookDelivery,
	type WebhookEndpoint,
} from "./webhooks-store";
import { attemptDelivery } from "./webhooks-deliver";
import { backgroundLocked } from "./licence";
import type { WebhookEventType } from "../../shared/webhooks";

/** Deliveries sent per drain pass. Sends run in parallel within a batch. */
const DRAIN_BATCH = 10;
/** Passes per alarm, so a large backlog yields rather than running unbounded. */
const DRAIN_PASSES = 5;
/** While the licence is locked, how often to look again. */
const LICENCE_PAUSE_MS = 10 * 60 * 1000;

export class WebhookDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	private store!: WebhookStore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.store = new WebhookStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
		});
	}

	// ── Endpoints ──────────────────────────────────────────────────

	async listEndpoints(): Promise<WebhookEndpoint[]> {
		return this.store.listEndpoints();
	}

	async getEndpoint(id: string): Promise<WebhookEndpoint | null> {
		return this.store.getEndpoint(id);
	}

	async createEndpoint(input: CreateEndpointInput): Promise<WebhookEndpoint> {
		return this.store.createEndpoint(input);
	}

	async updateEndpoint(id: string, patch: UpdateEndpointInput): Promise<WebhookEndpoint | null> {
		const updated = this.store.updateEndpoint(id, patch);
		await this.rearm();
		return updated;
	}

	async rotateSecret(id: string, secret: string, now: number): Promise<WebhookEndpoint | null> {
		return this.store.rotateSecret(id, secret, now);
	}

	async deleteEndpoint(id: string): Promise<boolean> {
		const deleted = this.store.deleteEndpoint(id);
		await this.rearm();
		return deleted;
	}

	/** Event types some enabled endpoint wants for this mailbox. Cheap pre-check. */
	async wantedTypes(mailbox: string): Promise<WebhookEventType[]> {
		return this.store.wantedTypes(mailbox);
	}

	// ── Deliveries ─────────────────────────────────────────────────

	/**
	 * Queue events and start sending in the background. Returns as soon as the
	 * rows are written, before any HTTP happens.
	 */
	async enqueue(events: EnqueueInput[]): Promise<{ queued: number }> {
		let queued = 0;
		for (const event of events) queued += this.store.enqueue(event);
		if (queued > 0) {
			// Alarm first, so the rows are covered even if this object is evicted
			// before the background drain gets to them.
			await this.rearm();
			this.ctx.waitUntil(this.drain());
		}
		return { queued };
	}

	/** Send a test payload to one endpoint now and report what happened. */
	async sendTest(endpointId: string, event: EnqueueInput): Promise<WebhookDelivery | null> {
		const id = this.store.createTestDelivery(endpointId, event);
		if (!id) return null;
		return this.sendNow(id);
	}

	/** Re-send one delivery now, whatever its state. */
	async retryDelivery(deliveryId: string): Promise<WebhookDelivery | null> {
		if (!this.store.getDelivery(deliveryId)) return null;
		return this.sendNow(deliveryId);
	}

	async getDelivery(id: string): Promise<WebhookDelivery | null> {
		return this.store.getDelivery(id);
	}

	async listDeliveries(endpointId: string, limit?: number): Promise<WebhookDelivery[]> {
		return this.store.listDeliveries(endpointId, limit);
	}

	private async sendNow(deliveryId: string): Promise<WebhookDelivery | null> {
		// Locked: report the delivery as it stands, send nothing.
		if (await backgroundLocked(this.env)) return this.store.getDelivery(deliveryId);
		const due = this.store.claimOne(deliveryId, Date.now());
		// Already being sent by the scheduler; report its current state.
		if (!due) return this.store.getDelivery(deliveryId);
		try {
			const outcome = await attemptDelivery(due);
			this.store.recordAttempt(due.id, outcome, Date.now());
		} finally {
			await this.rearm();
		}
		return this.store.getDelivery(deliveryId);
	}

	/** Send everything that is due, then arm the alarm for the next one. */
	private async drain(): Promise<void> {
		// Licence locked: deliveries to the customer's endpoints pause. Nothing
		// is claimed, so rows and attempt counts are untouched, and the alarm is
		// pushed out a fixed interval rather than to the (already due) next
		// row, which would fire again at once.
		if (await backgroundLocked(this.env)) {
			if (this.store.nextWakeAt() !== null) await this.ctx.storage.setAlarm(Date.now() + LICENCE_PAUSE_MS);
			return;
		}
		try {
			for (let pass = 0; pass < DRAIN_PASSES; pass++) {
				const batch = this.store.claimDue(Date.now(), DRAIN_BATCH);
				if (batch.length === 0) break;
				await Promise.all(
					batch.map(async (due) => {
						const outcome = await attemptDelivery(due);
						try {
							this.store.recordAttempt(due.id, outcome, Date.now());
						} catch (e) {
							console.error(`webhook: recording attempt for ${due.id} failed:`, (e as Error).message);
						}
					}),
				);
			}
		} catch (e) {
			console.error("webhook: drain failed:", (e as Error).message);
		} finally {
			await this.rearm();
		}
	}

	private async rearm(): Promise<void> {
		const next = this.store.nextWakeAt();
		if (next === null) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		const now = Date.now();
		const current = await this.ctx.storage.getAlarm();
		// Keep an earlier alarm that is still in the future; replace a missing,
		// later, or already-passed one (an alarm in the past may be the one that
		// is running right now, and will not fire again).
		if (current === null || current > next || current <= now) {
			await this.ctx.storage.setAlarm(Math.max(next, now));
		}
	}

	async alarm(): Promise<void> {
		await this.drain();
	}

	/**
	 * Backstop called from the five-minute cron: send anything overdue and make
	 * sure an alarm is armed. Normally a no-op; it exists so a lost alarm delays
	 * retries by minutes rather than stranding them.
	 */
	async kick(): Promise<void> {
		const next = this.store.nextWakeAt();
		if (next !== null && next <= Date.now()) await this.drain();
		else await this.rearm();
	}
}
