// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Privacy and data controls API.
 *
 *   GET    /api/v1/mailboxes/:mailboxId/settings/tracking   the mailbox's tracking toggles
 *   PATCH  /api/v1/mailboxes/:mailboxId/settings/tracking   change them (manageSettings)
 *   GET    /api/v1/privacy                                   the operator's notice settings (public)
 *   PUT    /api/v1/privacy                                   edit them (admin)
 *   GET    /api/v1/account/deletion                          pending self-deletion, if any
 *   DELETE /api/v1/account                                   delete my account (re-auth, 7-day grace)
 *   POST   /api/v1/account/deletion/cancel                   cancel it
 *   GET    /api/v1/account/exports                           my exports
 *   POST   /api/v1/account/exports                           start one
 *   GET    /api/v1/account/exports/:id/download?token=...    fetch it by signed link
 *
 * Mounted on the API app behind `requireMailbox` (per-mailbox paths) and the
 * token-scope guard. The account routes need a signed-in built-in account
 * and, to start an export or a deletion, a browser session that re-confirmed
 * its password or passkey in the last 15 minutes (`/api/auth/passkeys/reauth`).
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import {
	mergePrivacySettings,
	PrivacySettingsInputSchema,
} from "../../shared/privacy";
import { PASSKEY_REAUTH_MS } from "../auth/passkeys";
import type { AuthDO } from "../auth/store";
import type { AuthStoreApi, PrivacyStoreApi } from "../auth/types";
import {
	ACCOUNT_DELETION_GRACE_MS,
	EXPORT_JOB_MAX_AGE_MS,
	exportDownloadToken,
	initialExportState,
	ownedMailboxes,
	solelyOwnedMailboxes,
	verifyExportDownloadToken,
} from "../lib/account-privacy";
import { auditActorRole, recordAuditDeferred } from "../lib/audit";
import { isAdmin } from "../lib/authz";
import { DISCLOSURE_TEXT_MAX } from "../durableObject/features";
import type { MailboxContext } from "../lib/mailbox";
import { getPrivacySettings, putPrivacySettings } from "../lib/privacy";

type AppContext = Context<MailboxContext>;
type Store = AuthStoreApi & PrivacyStoreApi;

export const privacyRoutes = new Hono<MailboxContext>();

const MB = "/api/v1/mailboxes/:mailboxId";

/** Overridable in tests. */
export const privacyDeps = {
	store: (c: AppContext): Store => {
		const ns = c.env.AUTH_STORE as unknown as DurableObjectNamespace<AuthDO>;
		return ns.get(ns.idFromName("global")) as unknown as Store;
	},
	now: () => Date.now(),
};

// ── Tracking toggles ──────────────────────────────────────────────

const TrackingPatch = z
	.object({
		openTracking: z.boolean(),
		clickTracking: z.boolean(),
		attachmentTracking: z.boolean(),
		disclosureEnabled: z.boolean(),
		disclosureText: z.string().max(DISCLOSURE_TEXT_MAX).nullable(),
	})
	.partial()
	.strict();

privacyRoutes.get(`${MB}/settings/tracking`, async (c: AppContext) => {
	return c.json(await c.var.mailboxStub.getTrackingSettings());
});

privacyRoutes.patch(`${MB}/settings/tracking`, async (c: AppContext) => {
	const patch = TrackingPatch.parse(await c.req.json());
	const mailboxId = decodeURIComponent(c.req.param("mailboxId")!);
	const next = await c.var.mailboxStub.updateTrackingSettings(patch);
	await recordAuditDeferred(c, {
		action: "mailbox.tracking",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, mailboxId),
		mailboxId,
		detail: {
			open: next.openTracking,
			click: next.clickTracking,
			attachment: next.attachmentTracking,
			disclosure: next.disclosureEnabled,
		},
	});
	return c.json(next);
});

// ── Privacy notice settings ───────────────────────────────────────

privacyRoutes.get("/api/v1/privacy", async (c: AppContext) => {
	return c.json(await getPrivacySettings(c.env.BUCKET));
});

privacyRoutes.put("/api/v1/privacy", async (c: AppContext) => {
	if (!isAdmin(c.var.principal)) return c.json({ error: "Administrator access required" }, 403);
	const patch = PrivacySettingsInputSchema.parse(await c.req.json());
	const merged = mergePrivacySettings(await getPrivacySettings(c.env.BUCKET), patch, privacyDeps.now());
	await putPrivacySettings(c.env.BUCKET, merged);
	await recordAuditDeferred(c, {
		action: "privacy.settings",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		mailboxId: null,
	});
	return c.json(merged);
});

// ── Account: shared guards ────────────────────────────────────────

function needsAccount(c: AppContext): Response | null {
	if (!c.var.authUser) {
		return c.json({ error: "Account features need a built-in account (password mode).", code: "no_account" }, 400);
	}
	return null;
}

/** A browser session that re-confirmed its user in the last 15 minutes. */
async function needsFreshSession(c: AppContext, store: Store): Promise<Response | null> {
	if (c.var.authMethod !== "session" || !c.var.authSessionHash) {
		return c.json(
			{ error: "This action requires a signed-in browser session, not an API token.", code: "session_required" },
			403,
		);
	}
	const at = await store.getSessionAuthenticatedAt(c.var.authSessionHash);
	if (at === null || privacyDeps.now() - at >= PASSKEY_REAUTH_MS) {
		return c.json(
			{ error: "Confirm it's you with your password or a passkey first.", code: "reauth_required" },
			403,
		);
	}
	return null;
}

// ── Account deletion ──────────────────────────────────────────────

privacyRoutes.get("/api/v1/account/deletion", async (c: AppContext) => {
	const missing = needsAccount(c);
	if (missing) return missing;
	const pending = await privacyDeps.store(c).getAccountDeletion(c.var.authUser!.id);
	return c.json({ pending: pending !== null, ...(pending ?? {}) });
});

privacyRoutes.delete("/api/v1/account", async (c: AppContext) => {
	const missing = needsAccount(c);
	if (missing) return missing;
	const store = privacyDeps.store(c);
	const user = c.var.authUser!;
	// The owner guard first: refusing it never needs a password prompt.
	if (user.isOwner) {
		return c.json(
			{
				error: "The owner can't delete their own account while they are the only owner. Transfer ownership first.",
				code: "sole_owner",
			},
			409,
		);
	}
	const stale = await needsFreshSession(c, store);
	if (stale) return stale;

	const now = privacyDeps.now();
	const mailboxes = await solelyOwnedMailboxes(c.env, user.email);
	const result = await store.scheduleAccountDeletion({
		userId: user.id,
		now,
		graceMs: ACCOUNT_DELETION_GRACE_MS,
		mailboxes,
	});
	if (!result.ok) {
		return result.reason === "sole_owner"
			? c.json({ error: "The sole owner can't delete their own account.", code: "sole_owner" }, 409)
			: c.json({ error: "Account not found", code: "not_found" }, 404);
	}
	await recordAuditDeferred(c, {
		action: "account.delete",
		actor: user.email,
		actorRole: "owner",
		mailboxId: null,
		target: user.email,
		detail: { phase: "requested", purgeAfter: new Date(result.purgeAfter).toISOString(), mailboxes: mailboxes.length },
	});
	return c.json({
		status: "scheduled",
		requestedAt: result.requestedAt,
		purgeAfter: result.purgeAfter,
		mailboxes,
	}, 202);
});

privacyRoutes.post("/api/v1/account/deletion/cancel", async (c: AppContext) => {
	const missing = needsAccount(c);
	if (missing) return missing;
	const user = c.var.authUser!;
	const cancelled = await privacyDeps.store(c).cancelAccountDeletion(user.id);
	if (!cancelled) return c.json({ error: "No deletion is pending", code: "not_found" }, 404);
	await recordAuditDeferred(c, {
		action: "account.delete",
		actor: user.email,
		actorRole: "owner",
		mailboxId: null,
		target: user.email,
		detail: { phase: "cancelled" },
	});
	return c.json({ status: "cancelled" });
});

// ── Account export ────────────────────────────────────────────────

function publicJob(job: Awaited<ReturnType<Store["getExportJob"]>> & object, downloadUrl: string | null) {
	return {
		id: job.id,
		status: job.status,
		size: job.size,
		error: job.error,
		createdAt: job.createdAt,
		completedAt: job.completedAt,
		expiresAt: job.expiresAt,
		downloadUrl,
	};
}

async function withLink(c: AppContext, job: NonNullable<Awaited<ReturnType<Store["getExportJob"]>>>) {
	if (job.status !== "ready") return publicJob(job, null);
	const token = await exportDownloadToken(c.env, job, privacyDeps.now());
	return publicJob(job, `/api/v1/account/exports/${job.id}/download?token=${encodeURIComponent(token)}`);
}

privacyRoutes.get("/api/v1/account/exports", async (c: AppContext) => {
	const missing = needsAccount(c);
	if (missing) return missing;
	const jobs = await privacyDeps.store(c).listExportJobs(c.var.authUser!.id);
	return c.json({ exports: await Promise.all(jobs.map((job) => withLink(c, job))) });
});

privacyRoutes.post("/api/v1/account/exports", async (c: AppContext) => {
	const missing = needsAccount(c);
	if (missing) return missing;
	const store = privacyDeps.store(c);
	const stale = await needsFreshSession(c, store);
	if (stale) return stale;
	const user = c.var.authUser!;
	const existing = await store.listExportJobs(user.id);
	const active = existing.find((job) => job.status === "pending" || job.status === "running");
	if (active) return c.json(await withLink(c, active), 200);

	const now = privacyDeps.now();
	const mailboxes = await ownedMailboxes(c.env, c.var.principal);
	const job = await store.createExportJob({
		id: crypto.randomUUID(),
		userId: user.id,
		now,
		expiresAt: now + EXPORT_JOB_MAX_AGE_MS,
		state: JSON.stringify(initialExportState(user.email, mailboxes)),
	});
	return c.json(await withLink(c, job), 202);
});

/**
 * The download. Two credentials: the signed-in user (the auth gate covers
 * every `/api/*` path) and a signed, expiring token bound to this job and
 * this user. A leaked link alone downloads nothing, and a stale one stops
 * working after 24 hours.
 */
privacyRoutes.get("/api/v1/account/exports/:id/download", async (c: AppContext) => {
	const missing = needsAccount(c);
	if (missing) return missing;
	const claim = await verifyExportDownloadToken(c.env, c.req.query("token") ?? "", privacyDeps.now());
	const id = c.req.param("id")!;
	if (!claim || claim.jobId !== id || claim.userId !== c.var.authUser!.id) {
		return c.json({ error: "This download link is not valid or has expired.", code: "invalid_link" }, 403);
	}
	const job = await privacyDeps.store(c).getExportJob(id);
	if (!job || job.status !== "ready" || !job.objectKey || job.userId !== claim.userId) {
		return c.json({ error: "Export not found", code: "not_found" }, 404);
	}
	const object = await c.env.BUCKET.get(job.objectKey);
	if (!object) return c.json({ error: "Export not found", code: "not_found" }, 404);
	const date = new Date(job.completedAt ?? job.createdAt).toISOString().slice(0, 10);
	return new Response(object.body, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="account-export-${date}.zip"`,
			"Content-Length": String(object.size),
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
});
