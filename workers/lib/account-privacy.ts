// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Self-service account export and deletion.
 *
 * ## Export
 *
 * A ZIP in R2 at `exports/<userId>/<jobId>.zip` holding:
 *
 *   - `account.json`: profile, sessions, API token metadata (never secrets),
 *     connected apps, passkey metadata, mailbox grants, and the settings of each
 *     exported mailbox (mailbox blob, tracking toggles);
 *   - `mailboxes/<address>.mbox`: every message in each mailbox the user owns,
 *     in the same format as the per-mailbox mbox export (`shared/mbox.ts`).
 *
 * Built in the background from the cron, a bounded slice per tick
 * (`EXPORT_PAGES_PER_TICK` pages of mail), into an R2 multipart upload. R2
 * wants every part but the last to be the same size, so bytes short of a full
 * part wait in `exports/<userId>/<jobId>.pending` until the next tick. The job
 * row carries the cursor, running CRC and byte offsets, so a tick that dies
 * repeats at most one slice.
 *
 * The download is `GET /api/v1/account/exports/:id/download?token=...`, a
 * signed link valid for 24 hours, then the job and the object are removed.
 *
 * ## Deletion
 *
 * `DELETE /api/v1/account` (after re-authentication) revokes every session
 * and token at once and starts a 7-day grace period. When it ends, the cron
 * purges the mailboxes the user solely owns (Durable Object storage, agent
 * chat, attachments, the mailbox record, its grants and audit history), the
 * user's grant, exports, and finally the account row. Mailboxes shared with
 * anyone else are left alone. The deletion itself stays in the deployment
 * audit log, which is the one record kept.
 */

import { messageToMbox, type ExportableMessage } from "../../shared/mbox";
import { signLink, verifyLink } from "../../shared/signed-link";
import {
	concatBytes,
	crc32Update,
	zipCentralDirectory,
	zipDataDescriptor,
	zipLocalHeader,
	zipSafeName,
	ZIP_MAX_BYTES,
	type ZipEntryRecord,
} from "../../shared/zip";
import type { AuthUser, ExportJobRecord, PrivacyStoreApi } from "../auth/types";
import type { Env } from "../types";
import { listAuditKeysForMailbox, recordAudit } from "./audit";
import {
	deleteGrant,
	getGrant,
	isAdmin,
	listGrants,
	normalizeAddress,
	revokeMailboxFromGrants,
	type Principal,
} from "./authz";
import { FULL_ACCESS_ROLE } from "./capabilities";
import { listMailboxes } from "./email-helpers";
import { forgetMailboxExists } from "./mailbox-exists";
import { getUnsubscribeSecret } from "./suppressions";

export const ACCOUNT_DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const EXPORT_LINK_TTL_MS = 24 * 60 * 60 * 1000;
/** A job that has not finished in this long is abandoned. */
export const EXPORT_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const EXPORT_PAGES_PER_TICK = 20;
export const EXPORT_PART_BYTES = 8 * 1024 * 1024;
const EXPORT_PAGE_SIZE = 50;

// ── Which mailboxes are "yours" ───────────────────────────────────

/**
 * Mailboxes the principal owns: every mailbox for an administrator, otherwise
 * those granted with the full-access `owner` role.
 */
export async function ownedMailboxes(env: Env, principal: Principal): Promise<string[]> {
	const all = (await listMailboxes(env.BUCKET)).map((m) => m.id);
	if (isAdmin(principal) || principal.access === null) return all.sort();
	const owned = new Set(
		(principal.access ?? [])
			.filter((entry) => entry.role === FULL_ACCESS_ROLE)
			.map((entry) => normalizeAddress(entry.id)),
	);
	return all.filter((id) => owned.has(normalizeAddress(id))).sort();
}

/**
 * Mailboxes to destroy with the account: owned by this user's grant and named
 * by no other grant. Admin reach does not count; an administrator deleting
 * their account must not take the whole deployment's mail with them.
 */
export async function solelyOwnedMailboxes(env: Env, email: string): Promise<string[]> {
	const me = normalizeAddress(email);
	const grants = await listGrants(env.BUCKET, "user");
	const services = await listGrants(env.BUCKET, "service");
	const mine = grants.find((g) => normalizeAddress(g.id) === me);
	if (!mine) return [];
	const others = [...grants.filter((g) => normalizeAddress(g.id) !== me), ...services];
	const shared = new Set(others.flatMap((g) => g.mailboxes.map(normalizeAddress)));
	return mine.access
		.filter((entry) => entry.role === FULL_ACCESS_ROLE)
		.map((entry) => normalizeAddress(entry.id))
		.filter((id) => !shared.has(id))
		.sort();
}

// ── Export: links ─────────────────────────────────────────────────

interface ExportLinkPayload {
	j: string;
	u: string;
	exp: number;
}

export async function exportDownloadToken(env: Env, job: ExportJobRecord, now = Date.now()): Promise<string> {
	const exp = Math.min(job.expiresAt, now + EXPORT_LINK_TTL_MS);
	return signLink<ExportLinkPayload>({ j: job.id, u: job.userId, exp }, await linkSecret(env));
}

export async function verifyExportDownloadToken(
	env: Env,
	token: string,
	now = Date.now(),
): Promise<{ jobId: string; userId: string } | null> {
	const payload = await verifyLink<ExportLinkPayload>(token, await linkSecret(env), now);
	return payload ? { jobId: payload.j, userId: payload.u } : null;
}

/** Derived from the unsubscribe secret with a fixed label, so no new secret is needed. */
async function linkSecret(env: Env): Promise<string> {
	return `export-link:${await getUnsubscribeSecret(env)}`;
}

// ── Export: the builder ───────────────────────────────────────────

/** The resumable part of a job, stored as JSON in `export_jobs.state`. */
export interface ExportState {
	email: string;
	mailboxes: string[];
	/** Index into `mailboxes` of the mbox being written; `mailboxes.length` = all done. */
	mailboxIndex: number;
	cursor: { date: string; id: string } | null;
	/** An mbox entry is open (local header written, descriptor not yet). */
	entryOpen: boolean;
	entryCrc: number;
	entrySize: number;
	entryOffset: number;
	entries: ZipEntryRecord[];
	/** Bytes of archive produced so far (uploaded parts + pending). */
	written: number;
	uploadId: string | null;
	parts: R2UploadedPart[];
	/** Bytes waiting in the pending object. */
	pendingBytes: number;
	accountJsonDone: boolean;
}

export function initialExportState(email: string, mailboxes: string[]): ExportState {
	return {
		email,
		mailboxes,
		mailboxIndex: 0,
		cursor: null,
		entryOpen: false,
		entryCrc: 0,
		entrySize: 0,
		entryOffset: 0,
		entries: [],
		written: 0,
		uploadId: null,
		parts: [],
		pendingBytes: 0,
		accountJsonDone: false,
	};
}

export function exportObjectKey(job: Pick<ExportJobRecord, "id" | "userId">): string {
	return `exports/${job.userId}/${job.id}.zip`;
}
function pendingKey(job: Pick<ExportJobRecord, "id" | "userId">): string {
	return `exports/${job.userId}/${job.id}.pending`;
}

/** What the builder needs from the mailbox stub. */
export interface ExportMailboxStub {
	exportPage(options: { limit?: number; afterDate?: string; afterId?: string }): Promise<{
		messages: Record<string, unknown>[];
		attachments: Record<string, { filename: string; mimetype: string; size: number }[]>;
		done: boolean;
		cursor?: { date: string; id: string };
	}>;
	getTrackingSettings?(): Promise<unknown>;
}

export interface ExportDeps {
	bucket: R2Bucket;
	mailbox: (id: string) => ExportMailboxStub;
	/** account.json content, built when the archive starts. */
	accountJson: () => Promise<unknown>;
	now?: () => number;
	partBytes?: number;
	pagesPerTick?: number;
}

const encoder = new TextEncoder();

/** Accumulates output for one tick, flushing full parts to the multipart upload. */
class PartWriter {
	private chunks: Uint8Array[] = [];
	private size = 0;
	constructor(
		private readonly deps: ExportDeps,
		private readonly state: ExportState,
		private readonly job: ExportJobRecord,
		private readonly partBytes: number,
		carried: Uint8Array | null,
	) {
		if (carried && carried.length) {
			this.chunks.push(carried);
			this.size = carried.length;
		}
	}

	write(bytes: Uint8Array): void {
		if (bytes.length === 0) return;
		this.chunks.push(bytes);
		this.size += bytes.length;
		this.state.written += bytes.length;
		if (this.state.written > ZIP_MAX_BYTES) throw new Error("export is larger than 4 GiB");
	}

	private async upload(): Promise<R2MultipartUpload> {
		if (this.state.uploadId) return this.deps.bucket.resumeMultipartUpload(exportObjectKey(this.job), this.state.uploadId);
		const upload = await this.deps.bucket.createMultipartUpload(exportObjectKey(this.job), {
			httpMetadata: { contentType: "application/zip" },
		});
		this.state.uploadId = upload.uploadId;
		return upload;
	}

	/** Upload every full part held; keep the remainder. */
	async flushFullParts(): Promise<void> {
		while (this.size >= this.partBytes) {
			const all = concatBytes(this.chunks);
			const part = all.slice(0, this.partBytes);
			const rest = all.slice(this.partBytes);
			const upload = await this.upload();
			this.state.parts.push(await upload.uploadPart(this.state.parts.length + 1, part));
			this.chunks = rest.length ? [rest] : [];
			this.size = rest.length;
		}
	}

	/** Save what is left for the next tick. */
	async park(): Promise<void> {
		await this.flushFullParts();
		const rest = concatBytes(this.chunks);
		this.state.pendingBytes = rest.length;
		if (rest.length) await this.deps.bucket.put(pendingKey(this.job), rest);
		else await this.deps.bucket.delete(pendingKey(this.job));
	}

	/** Write the final part and complete. Returns the archive size. */
	async finish(): Promise<number> {
		await this.flushFullParts();
		const rest = concatBytes(this.chunks);
		if (this.state.parts.length === 0) {
			// Small archive: one plain put, no multipart needed.
			await this.deps.bucket.put(exportObjectKey(this.job), rest, {
				httpMetadata: { contentType: "application/zip" },
			});
		} else {
			const upload = await this.upload();
			if (rest.length) this.state.parts.push(await upload.uploadPart(this.state.parts.length + 1, rest));
			await upload.complete(this.state.parts);
		}
		await this.deps.bucket.delete(pendingKey(this.job));
		return this.state.written;
	}
}

function openEntry(state: ExportState, writer: PartWriter, name: string, now: Date): void {
	state.entryOffset = state.written;
	writer.write(zipLocalHeader(name, now));
	state.entryOpen = true;
	state.entryCrc = 0;
	state.entrySize = 0;
	state.entries.push({ name, crc: 0, size: 0, offset: state.entryOffset });
}

function writeEntryData(state: ExportState, writer: PartWriter, bytes: Uint8Array): void {
	state.entryCrc = crc32Update(state.entryCrc, bytes);
	state.entrySize += bytes.length;
	writer.write(bytes);
}

function closeEntry(state: ExportState, writer: PartWriter): void {
	writer.write(zipDataDescriptor(state.entryCrc, state.entrySize));
	const last = state.entries[state.entries.length - 1];
	last.crc = state.entryCrc;
	last.size = state.entrySize;
	state.entryOpen = false;
}

/**
 * Advance one job by a bounded slice. Returns the new state and whether the
 * archive is complete. Pure over its dependencies, so tests drive it with an
 * in-memory bucket and fake mailboxes.
 */
export async function advanceExport(
	job: ExportJobRecord,
	state: ExportState,
	deps: ExportDeps,
): Promise<{ state: ExportState; done: boolean; size?: number }> {
	const now = new Date((deps.now ?? Date.now)());
	const partBytes = deps.partBytes ?? EXPORT_PART_BYTES;
	let carried: Uint8Array | null = null;
	if (state.pendingBytes > 0) {
		const obj = await deps.bucket.get(pendingKey(job));
		if (!obj) throw new Error("export lost its pending bytes");
		carried = new Uint8Array(await obj.arrayBuffer());
	}
	const writer = new PartWriter(deps, state, job, partBytes, carried);

	if (!state.accountJsonDone) {
		const json = encoder.encode(JSON.stringify(await deps.accountJson(), null, 2));
		openEntry(state, writer, "account.json", now);
		writeEntryData(state, writer, json);
		closeEntry(state, writer);
		state.accountJsonDone = true;
	}

	let pages = 0;
	const budget = deps.pagesPerTick ?? EXPORT_PAGES_PER_TICK;
	while (state.mailboxIndex < state.mailboxes.length && pages < budget) {
		const mailboxId = state.mailboxes[state.mailboxIndex];
		if (!state.entryOpen) openEntry(state, writer, `mailboxes/${zipSafeName(mailboxId)}.mbox`, now);
		const page = await deps.mailbox(mailboxId).exportPage(
			state.cursor
				? { limit: EXPORT_PAGE_SIZE, afterDate: state.cursor.date, afterId: state.cursor.id }
				: { limit: EXPORT_PAGE_SIZE },
		);
		pages += 1;
		for (const message of page.messages) {
			const row = message as unknown as ExportableMessage;
			writeEntryData(state, writer, encoder.encode(messageToMbox(row, page.attachments[row.id] ?? [])));
		}
		await writer.flushFullParts();
		if (page.done || !page.cursor) {
			closeEntry(state, writer);
			state.mailboxIndex += 1;
			state.cursor = null;
		} else {
			state.cursor = page.cursor;
		}
	}

	if (state.mailboxIndex >= state.mailboxes.length) {
		writer.write(zipCentralDirectory(state.entries, state.written, now));
		const size = await writer.finish();
		state.pendingBytes = 0;
		return { state, done: true, size };
	}
	await writer.park();
	return { state, done: false };
}

// ── Export: account.json ──────────────────────────────────────────

export async function buildAccountJson(
	env: Env,
	store: Pick<
		import("../auth/types").AuthStoreApi,
		"getUser" | "listSessions" | "listApiTokens" | "listOAuthGrants" | "listPasskeys"
	>,
	user: AuthUser,
	mailboxes: string[],
	now: number,
): Promise<unknown> {
	const [sessions, tokens, apps, passkeys, grant] = await Promise.all([
		store.listSessions(user.id, now),
		store.listApiTokens(user.id),
		store.listOAuthGrants(user.id),
		store.listPasskeys(user.id),
		getGrant(env.BUCKET, "user", user.email),
	]);
	const mailboxSettings: Record<string, unknown> = {};
	for (const id of mailboxes) {
		const settings = await env.BUCKET.get(`mailboxes/${id}.json`).then((o) => (o ? o.json() : null)).catch(() => null);
		let tracking: unknown = null;
		try {
			tracking = await (env.MAILBOX.get(env.MAILBOX.idFromName(id)) as unknown as {
				getTrackingSettings(): Promise<unknown>;
			}).getTrackingSettings();
		} catch {
			/* reported as null */
		}
		mailboxSettings[id] = { settings, tracking };
	}
	return {
		exportedAt: new Date(now).toISOString(),
		format: "tapetide-account-export/1",
		profile: {
			id: user.id,
			email: user.email,
			name: user.name,
			isOwner: user.isOwner,
			twoFactorEnabled: user.totpEnabled,
			createdAt: new Date(user.createdAt).toISOString(),
			lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
		},
		sessions: sessions.map((s) => ({
			createdAt: new Date(s.createdAt).toISOString(),
			lastSeenAt: new Date(s.lastSeenAt).toISOString(),
			ip: s.ip,
			userAgent: s.userAgent,
		})),
		// Metadata only. Token secrets are stored hashed and never leave the server.
		apiTokens: tokens.map((t) => ({
			id: t.id,
			name: t.name,
			scopes: t.scopes,
			mailboxes: t.mailboxes,
			createdAt: new Date(t.createdAt).toISOString(),
			lastUsedAt: t.lastUsedAt ? new Date(t.lastUsedAt).toISOString() : null,
			expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : null,
		})),
		connectedApps: apps.map((a) => ({
			client: a.clientName,
			redirectHost: a.redirectHost,
			createdAt: new Date(a.createdAt).toISOString(),
		})),
		passkeys: passkeys.map((p) => ({
			name: p.name,
			createdAt: new Date(p.createdAt).toISOString(),
			lastUsedAt: p.lastUsedAt ? new Date(p.lastUsedAt).toISOString() : null,
		})),
		mailboxAccess: grant?.access ?? [],
		mailboxes: mailboxSettings,
	};
}

// ── Export: the cron step ─────────────────────────────────────────

/** Advance active export jobs and remove expired ones. Never throws. */
export async function runExportTick(
	env: Env,
	store: PrivacyStoreApi & Pick<import("../auth/types").AuthStoreApi, "getUser" | "listSessions" | "listApiTokens" | "listOAuthGrants" | "listPasskeys">,
	now = Date.now(),
): Promise<void> {
	try {
		for (const job of await store.takeExpiredExportJobs(now)) {
			await env.BUCKET.delete([exportObjectKey(job), pendingKey(job)]).catch(() => {});
			if (job.status !== "ready" && job.state) {
				try {
					const state = JSON.parse(job.state) as ExportState;
					if (state.uploadId) await env.BUCKET.resumeMultipartUpload(exportObjectKey(job), state.uploadId).abort();
				} catch {
					/* best effort */
				}
			}
		}
	} catch (e) {
		console.error("export cleanup failed:", (e as Error).message);
	}

	let jobs: ExportJobRecord[] = [];
	try {
		jobs = await store.listActiveExportJobs(3);
	} catch (e) {
		console.error("export job list failed:", (e as Error).message);
		return;
	}
	for (const job of jobs) {
		try {
			const user = await store.getUser(job.userId);
			if (!user || !job.state) {
				await store.updateExportJob(job.id, { status: "failed", error: "account not found" });
				continue;
			}
			const state = JSON.parse(job.state) as ExportState;
			await store.updateExportJob(job.id, { status: "running" });
			const result = await advanceExport(job, state, {
				bucket: env.BUCKET,
				mailbox: (id) => env.MAILBOX.get(env.MAILBOX.idFromName(id)) as unknown as ExportMailboxStub,
				accountJson: () => buildAccountJson(env, store, user, state.mailboxes, now),
				now: () => now,
			});
			if (result.done) {
				await store.updateExportJob(job.id, {
					status: "ready",
					state: JSON.stringify({ ...result.state, entries: [], parts: [] }),
					objectKey: exportObjectKey(job),
					size: result.size,
					completedAt: now,
					expiresAt: now + EXPORT_LINK_TTL_MS,
				});
				console.log(`export ${job.id}: ready, ${result.size} bytes, ${state.mailboxes.length} mailbox(es)`);
			} else {
				await store.updateExportJob(job.id, { state: JSON.stringify(result.state) });
			}
		} catch (e) {
			console.error(`export ${job.id} failed:`, (e as Error).message);
			await store
				.updateExportJob(job.id, { status: "failed", error: (e as Error).message.slice(0, 200) })
				.catch(() => {});
		}
	}
}

// ── Deletion: the purge ───────────────────────────────────────────

/** Destroy one mailbox outright, the same steps as the admin delete route. */
export async function purgeMailbox(env: Env, mailboxId: string): Promise<void> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const attachmentKeys = await (stub as unknown as { purge(): Promise<string[]> }).purge();
	for (let i = 0; i < attachmentKeys.length; i += 1000) {
		await env.BUCKET.delete(attachmentKeys.slice(i, i + 1000));
	}
	try {
		await (env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId)) as unknown as {
			purge(): Promise<void>;
		}).purge();
	} catch (e) {
		console.error(`account purge: agent history for ${mailboxId}:`, (e as Error).message);
	}
	await revokeMailboxFromGrants(env.BUCKET, mailboxId).catch(() => 0);
	const auditKeys = await listAuditKeysForMailbox(env.BUCKET, mailboxId).catch(() => [] as string[]);
	for (let i = 0; i < auditKeys.length; i += 1000) await env.BUCKET.delete(auditKeys.slice(i, i + 1000));
	await env.BUCKET.delete(`mailboxes/${mailboxId}.json`);
	forgetMailboxExists(mailboxId);
}

/** Finish deletions whose grace period has passed. Never throws. */
export async function runAccountDeletionTick(
	env: Env,
	store: PrivacyStoreApi,
	options: { now?: number; forgetRouting?: (mailboxId: string) => Promise<void> } = {},
): Promise<number> {
	const now = options.now ?? Date.now();
	let due: Awaited<ReturnType<PrivacyStoreApi["listDueAccountDeletions"]>> = [];
	try {
		due = await store.listDueAccountDeletions(now, 5);
	} catch (e) {
		console.error("account deletion list failed:", (e as Error).message);
		return 0;
	}
	let completed = 0;
	for (const item of due) {
		try {
			for (const mailboxId of item.mailboxes) {
				await purgeMailbox(env, mailboxId);
				await options.forgetRouting?.(mailboxId);
			}
			const exports = await env.BUCKET.list({ prefix: `exports/${item.userId}/` });
			if (exports.objects.length) await env.BUCKET.delete(exports.objects.map((o) => o.key));
			await deleteGrant(env.BUCKET, "user", item.email);
			if (await store.completeAccountDeletion(item.userId, now)) {
				completed += 1;
				await recordAudit(env.BUCKET, {
					action: "account.delete",
					actor: null,
					actorRole: "system",
					mailboxId: null,
					target: item.email,
					detail: { mailboxesPurged: item.mailboxes.length },
				});
				console.log(`account purge: ${item.userId} removed with ${item.mailboxes.length} mailbox(es)`);
			}
		} catch (e) {
			console.error(`account purge for ${item.userId} failed; will retry:`, (e as Error).message);
		}
	}
	return completed;
}
