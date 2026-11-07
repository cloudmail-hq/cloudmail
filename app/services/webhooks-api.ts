// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Client for `/api/v1/webhooks`. See workers/routes/webhooks.ts. */

import type { WebhookEventType } from "shared/webhooks";
import { request } from "./api";

export interface WebhookEndpoint {
	id: string;
	name: string;
	url: string;
	events: WebhookEventType[];
	mailboxes: string[] | null;
	enabled: boolean;
	disabledReason: string | null;
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

export type WebhookDeliveryStatus = "pending" | "retrying" | "delivered" | "failed";

export interface WebhookDelivery {
	id: string;
	endpointId: string;
	eventId: string;
	eventType: WebhookEventType;
	mailbox: string;
	status: WebhookDeliveryStatus;
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

export interface WebhookInput {
	name: string;
	url: string;
	events: WebhookEventType[];
	mailboxes: string[] | null;
	enabled?: boolean;
}

const BASE = "/api/v1/webhooks";
const json = (method: string, body?: unknown): RequestInit => ({
	method,
	body: body === undefined ? undefined : JSON.stringify(body),
});
const id = (value: string) => encodeURIComponent(value);

export const webhooksApi = {
	list: () => request<{ webhooks: WebhookEndpoint[] }>(BASE).then((r) => r.webhooks),
	create: (input: WebhookInput) =>
		request<{ webhook: WebhookEndpoint; secret: string }>(BASE, json("POST", input)),
	update: (webhookId: string, patch: Partial<WebhookInput>) =>
		request<{ webhook: WebhookEndpoint }>(`${BASE}/${id(webhookId)}`, json("PATCH", patch)).then((r) => r.webhook),
	remove: (webhookId: string) => request<{ status: string }>(`${BASE}/${id(webhookId)}`, json("DELETE")),
	rotateSecret: (webhookId: string) =>
		request<{ webhook: WebhookEndpoint; secret: string }>(`${BASE}/${id(webhookId)}/rotate-secret`, json("POST")),
	test: (webhookId: string) =>
		request<{ delivery: WebhookDelivery | null }>(`${BASE}/${id(webhookId)}/test`, json("POST")).then((r) => r.delivery),
	deliveries: (webhookId: string) =>
		request<{ deliveries: WebhookDelivery[] }>(`${BASE}/${id(webhookId)}/deliveries?limit=50`).then((r) => r.deliveries),
	retry: (deliveryId: string) =>
		request<{ delivery: WebhookDelivery | null }>(`${BASE}/deliveries/${id(deliveryId)}/retry`, json("POST")).then(
			(r) => r.delivery,
		),
};
