// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * One HTTP attempt at a webhook delivery. No storage: the caller files the
 * outcome with `WebhookStore.recordAttempt`, which decides what happens next.
 */

import { signWebhook, validateWebhookUrl } from "../../shared/webhooks";
import type { AttemptOutcome, DueDelivery } from "./webhooks-store";

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_USER_AGENT = "Tapetide-Webhooks/1.0";

const RESPONSE_SNIPPET_LENGTH = 200;

export function buildDeliveryHeaders(input: {
	deliveryId: string;
	eventType: string;
	timestamp: number;
	signature: string;
	attempt: number;
}): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"User-Agent": WEBHOOK_USER_AGENT,
		"X-Tapetide-Event": input.eventType,
		"X-Tapetide-Delivery": input.deliveryId,
		"X-Tapetide-Timestamp": String(input.timestamp),
		"X-Tapetide-Signature": input.signature,
		"X-Tapetide-Attempt": String(input.attempt),
	};
}

async function responseSnippet(res: Response): Promise<string> {
	try {
		// Error pages are usually HTML; keep the words, not the markup.
		const text = (await res.text())
			.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
			.replace(/<[^>]*>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return text.length > RESPONSE_SNIPPET_LENGTH ? `${text.slice(0, RESPONSE_SNIPPET_LENGTH - 1)}…` : text;
	} catch {
		return "";
	}
}

/**
 * POST the payload, signed, with a hard timeout. Never throws.
 *
 * `redirect: "manual"` so a public endpoint cannot redirect the request to an
 * address the URL guard would have refused; a 3xx is reported as a failure.
 * The URL is re-checked here too, so an endpoint stored before a guard change
 * is held to the current rule.
 */
export async function attemptDelivery(
	delivery: DueDelivery,
	options: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
): Promise<AttemptOutcome> {
	const doFetch = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const started = now();

	const check = validateWebhookUrl(delivery.url);
	if (!check.ok) return { statusCode: null, durationMs: 0, error: `Refused: ${check.error}` };

	const timestamp = Math.floor(started / 1000);
	try {
		const signature = await signWebhook(delivery.secret, timestamp, delivery.payload);
		const res = await doFetch(check.url, {
			method: "POST",
			redirect: "manual",
			signal: AbortSignal.timeout(options.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
			headers: buildDeliveryHeaders({
				deliveryId: delivery.id,
				eventType: delivery.eventType,
				timestamp,
				signature,
				attempt: delivery.attempt,
			}),
			body: delivery.payload,
		});
		const durationMs = now() - started;
		if (res.status >= 200 && res.status < 300) {
			// Drain so the connection can be reused; the body is not ours to keep.
			await res.body?.cancel().catch(() => {});
			return { statusCode: res.status, durationMs, error: null };
		}
		const snippet = res.status >= 300 && res.status < 400 ? "redirects are not followed" : await responseSnippet(res);
		return {
			statusCode: res.status,
			durationMs,
			error: snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`,
		};
	} catch (e) {
		const err = e as Error;
		const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
		return {
			statusCode: null,
			durationMs: now() - started,
			error: timedOut ? `Timed out after ${(options.timeoutMs ?? WEBHOOK_TIMEOUT_MS) / 1000}s` : err?.message || "Request failed",
		};
	}
}
