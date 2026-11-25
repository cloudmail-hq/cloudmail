/**
 * Health and status.
 *
 *   GET /api/v1/health          public: { ok, version }. For uptime monitors;
 *                               does no work and reveals nothing else.
 *   GET /api/v1/system/status   admin: version plus a checklist of what this
 *                               deployment has and lacks (storage reachable,
 *                               secrets and limiters configured), each with
 *                               what to do about a failure.
 */

import { Hono } from "hono";
import { APP_VERSION } from "../../shared/app-version";
import { requireAdmin, type MailboxContext } from "../lib/mailbox";
import type { Env } from "../types";

export interface StatusCheck {
	id: string;
	label: string;
	ok: boolean;
	/** Shown when `ok` is false: what is wrong and how to fix it. */
	detail: string | null;
	/** A failed `required` check means something is broken, not just missing. */
	required: boolean;
}

const CHECK_TIMEOUT_MS = 3_000;

async function timed<T>(work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS} ms`)), CHECK_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function binding(env: Env, name: string): unknown {
	return (env as unknown as Record<string, unknown>)[name];
}

/** The checklist. Each probe is cheap and bounded; none changes anything. */
export async function systemChecks(env: Env): Promise<StatusCheck[]> {
	const checks: StatusCheck[] = [];

	let authOk = false;
	let authDetail: string | null = "The AUTH_STORE Durable Object binding is missing from wrangler.jsonc.";
	const ns = binding(env, "AUTH_STORE") as DurableObjectNamespace | undefined;
	if (ns) {
		try {
			await timed((ns.get(ns.idFromName("global")) as unknown as { getAuthEpoch(): Promise<number> }).getAuthEpoch());
			authOk = true;
			authDetail = null;
		} catch (e) {
			authDetail = `The account store didn't answer: ${(e as Error).message}. Check Worker logs.`;
		}
	}
	checks.push({ id: "auth_store", label: "Account store (Durable Object)", ok: authOk, detail: authDetail, required: true });

	let bucketOk = false;
	let bucketDetail: string | null = "The BUCKET R2 binding is missing.";
	if (env.BUCKET) {
		try {
			await timed(env.BUCKET.head("branding/branding.json"));
			bucketOk = true;
			bucketDetail = null;
		} catch (e) {
			bucketDetail = `R2 didn't answer: ${(e as Error).message}. Check the bucket exists and is bound.`;
		}
	}
	checks.push({ id: "bucket", label: "Mail storage (R2)", ok: bucketOk, detail: bucketDetail, required: true });

	const authSecret = typeof env.AUTH_SECRET === "string" && env.AUTH_SECRET.length >= 16;
	checks.push({
		id: "auth_secret",
		label: "AUTH_SECRET set",
		ok: authSecret,
		detail: authSecret
			? null
			: "Set the AUTH_SECRET secret (openssl rand -base64 32). Without it the key that encrypts two-factor secrets and stored tokens is kept next to them.",
		required: false,
	});

	const limiters = ["API_RATE_LIMITER", "AUTH_RATE_LIMITER", "MCP_RATE_LIMITER"].filter((n) => !binding(env, n));
	checks.push({
		id: "rate_limiters",
		label: "Rate limiting",
		ok: limiters.length === 0,
		detail: limiters.length === 0 ? null : `Missing ${limiters.join(", ")} in wrangler.jsonc "ratelimits"; requests are not rate limited.`,
		required: false,
	});

	checks.push({
		id: "semantic_index",
		label: "Semantic search (Vectorize)",
		ok: Boolean(binding(env, "SEMANTIC_INDEX")),
		detail: binding(env, "SEMANTIC_INDEX") ? null : "No SEMANTIC_INDEX binding: Ask and meaning-based search are off. Keyword search still works.",
		required: false,
	});

	checks.push({
		id: "workers_ai",
		label: "Workers AI",
		ok: Boolean(binding(env, "AI")),
		detail: binding(env, "AI") ? null : "No AI binding: summaries, triage and drafts are off unless an AI provider is configured.",
		required: false,
	});

	return checks;
}

export const systemRoutes = new Hono<MailboxContext>();

systemRoutes.get("/api/v1/health", (c) => c.json({ ok: true, version: APP_VERSION }));

systemRoutes.get("/api/v1/system/status", requireAdmin, async (c) => {
	const checks = await systemChecks(c.env);
	return c.json({
		version: APP_VERSION,
		ok: checks.every((check) => check.ok || !check.required),
		checks,
	});
});
