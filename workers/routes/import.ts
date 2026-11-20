// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mail import API.
 *
 *   GET  /api/v1/mailboxes/:mailboxId/imports                  recent jobs
 *   POST /api/v1/mailboxes/:mailboxId/imports                  create (file upload or IMAP); Idempotency-Key
 *   GET  /api/v1/mailboxes/:mailboxId/imports/:id              one job, with progress
 *   PUT  /api/v1/mailboxes/:mailboxId/imports/:id/parts/:part  upload one part (raw bytes)
 *   POST /api/v1/mailboxes/:mailboxId/imports/:id/complete     finish the upload and queue the job
 *   POST /api/v1/mailboxes/:mailboxId/imports/:id/pause|resume|cancel
 *
 * ## Uploads
 *
 * A file import is an R2 multipart upload driven through the Worker: the
 * client creates the job with the file's size, then PUTs each part (5-50 MiB,
 * `part_size` from the create response; the last may be smaller), then calls
 * `complete`. Parts are idempotent by number, so a client resumes a broken
 * upload by asking which parts the job has (`upload.parts_uploaded`) and
 * sending the rest. Presigned URLs would need S3 API credentials the bindings
 * do not have; this way no new secret is needed.
 *
 * ## Authorization
 *
 * Writes need `manageSettings` (the gates in workers/index.ts): an import
 * fills the mailbox, and the IMAP form carries a password. Reading progress
 * needs `read`. There is no MCP tool: agents do not start imports.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import {
	IMPORT_DEFAULT_PART_BYTES,
	IMPORT_FILE_SOURCES,
	IMPORT_MAX_PART_BYTES,
	IMPORT_MAX_PARTS,
	IMPORT_MAX_UPLOAD_BYTES,
	IMPORT_MIN_PART_BYTES,
	validateImapHost,
} from "../../shared/mail-import";
import { authSecret } from "../auth/config";
import type { AuthDO } from "../auth/store";
import { auditActorRole, recordAuditDeferred } from "../lib/audit";
import { sealImportPassword } from "../lib/import-credential-store";
import type { MailboxContext } from "../lib/mailbox";

type AppContext = Context<MailboxContext>;

export const importRoutes = new Hono<MailboxContext>();

const MB = "/api/v1/mailboxes/:mailboxId";

/** The AuthDO, by name: `authStore()`'s module imports `cloudflare:workers`. */
function auth(c: AppContext): DurableObjectStub<AuthDO> {
	const ns = c.env.AUTH_STORE as unknown as DurableObjectNamespace<AuthDO>;
	return ns.get(ns.idFromName("global"));
}

const FileBody = z
	.object({
		source: z.enum(IMPORT_FILE_SOURCES),
		filename: z.string().trim().min(1).max(255),
		size_bytes: z.number().int().positive().max(IMPORT_MAX_UPLOAD_BYTES),
		part_size: z.number().int().min(IMPORT_MIN_PART_BYTES).max(IMPORT_MAX_PART_BYTES).optional(),
		folder: z.enum(["inbox", "archive"]).optional(),
	})
	.strict();

const ImapBody = z
	.object({
		source: z.literal("imap"),
		host: z.string().trim().min(1).max(253),
		username: z.string().min(1).max(320),
		password: z.string().min(1).max(1024),
		folders: z.array(z.string().min(1).max(500)).max(500).optional(),
	})
	.strict();

const CreateBody = z.discriminatedUnion("source", [FileBody, ImapBody]);

importRoutes.get(`${MB}/imports`, async (c: AppContext) => {
	const imports = await c.var.mailboxStub.listImportJobs(20);
	return c.json({ imports });
});

importRoutes.get(`${MB}/imports/:id`, async (c: AppContext) => {
	const job = await c.var.mailboxStub.getImportJob(c.req.param("id")!);
	if (!job) return c.json({ error: "Import not found" }, 404);
	return c.json(job);
});

importRoutes.post(`${MB}/imports`, async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase();
	const body = CreateBody.parse(await c.req.json());
	const id = `imp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

	if (body.source === "imap") {
		const host = validateImapHost(body.host);
		if (!host.ok) return c.json({ error: host.error }, 400);
		const store = auth(c);
		const secret = await sealImportPassword(body.password, await authSecret(c.env, store), id);
		await store.putImportCredential({ jobId: id, mailboxId, secretEnc: secret, now: Date.now() });
		// The credential must not outlive a job that was never created.
		const created = await c.var.mailboxStub
			.createImportJob({
				id,
				source: "imap",
				status: "queued",
				label: `${body.username}@${host.host}`,
				mailbox: mailboxId,
				imapHost: host.host,
				imapUsername: body.username,
				options: body.folders?.length ? { folders: body.folders } : null,
			})
			.catch(async (e: unknown) => {
				await store.deleteImportCredential(id).catch(() => {});
				throw e;
			});
		if ("error" in created) {
			await store.deleteImportCredential(id);
			return c.json({ error: created.error }, 409);
		}
		await recordAuditDeferred(c, {
			action: "mailbox.import",
			actor: c.var.principal.identity?.id ?? null,
			actorRole: auditActorRole(c.var.principal, mailboxId),
			mailboxId,
			detail: { source: "imap", host: host.host, job: id },
		});
		return c.json(created.job, 201);
	}

	const partSize = body.part_size ?? IMPORT_DEFAULT_PART_BYTES;
	const partsTotal = Math.max(1, Math.ceil(body.size_bytes / partSize));
	if (partsTotal > IMPORT_MAX_PARTS) {
		return c.json({ error: `That file needs more than ${IMPORT_MAX_PARTS} parts; use a larger part_size.` }, 400);
	}
	const r2Key = `imports/${mailboxId}/${id}`;
	const upload = await c.env.BUCKET.createMultipartUpload(r2Key, {
		httpMetadata: { contentType: "application/octet-stream" },
	});
	const created = await c.var.mailboxStub.createImportJob({
		id,
		source: body.source,
		status: "uploading",
		label: body.filename,
		mailbox: mailboxId,
		r2Key,
		uploadId: upload.uploadId,
		partSize,
		partsTotal,
		sizeBytes: body.size_bytes,
		options: body.folder ? { folder: body.folder } : null,
	});
	if ("error" in created) {
		await upload.abort().catch(() => {});
		return c.json({ error: created.error }, 409);
	}
	await recordAuditDeferred(c, {
		action: "mailbox.import",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, mailboxId),
		mailboxId,
		detail: { source: body.source, filename: body.filename, size: body.size_bytes, job: id },
	});
	return c.json(created.job, 201);
});

importRoutes.put(`${MB}/imports/:id/parts/:part`, async (c: AppContext) => {
	const id = c.req.param("id")!;
	const n = Number(c.req.param("part"));
	const info = await c.var.mailboxStub.getImportUpload(id);
	if (!info) return c.json({ error: "Import not found" }, 404);
	if (info.status !== "uploading" || !info.uploadId || !info.r2Key || !info.partSize || !info.partsTotal) {
		return c.json({ error: "This import is not accepting uploads." }, 409);
	}
	if (!Number.isInteger(n) || n < 1 || n > info.partsTotal) {
		return c.json({ error: `Part number must be 1-${info.partsTotal}.` }, 400);
	}
	const isLast = n === info.partsTotal;
	const expected = isLast ? (info.sizeBytes ?? 0) - info.partSize * (info.partsTotal - 1) : info.partSize;
	const declared = Number(c.req.header("content-length") ?? NaN);
	if (Number.isFinite(declared) && declared !== expected) {
		return c.json({ error: `Part ${n} must be exactly ${expected} bytes.` }, 400);
	}
	// Read whole (at most 50 MiB): R2 needs a known length, and the size check
	// must hold even when the client sent no Content-Length.
	const bytes = new Uint8Array(await c.req.arrayBuffer());
	if (bytes.byteLength !== expected) {
		return c.json({ error: `Part ${n} must be exactly ${expected} bytes; got ${bytes.byteLength}.` }, 400);
	}
	const upload = c.env.BUCKET.resumeMultipartUpload(info.r2Key, info.uploadId);
	const part = await upload.uploadPart(n, bytes);
	const job = await c.var.mailboxStub.recordImportPart(id, { n, etag: part.etag, size: bytes.byteLength });
	if (!job) return c.json({ error: "This import is not accepting uploads." }, 409);
	return c.json(job);
});

importRoutes.post(`${MB}/imports/:id/complete`, async (c: AppContext) => {
	const id = c.req.param("id")!;
	const info = await c.var.mailboxStub.getImportUpload(id);
	if (!info) return c.json({ error: "Import not found" }, 404);
	if (info.status !== "uploading") {
		const job = await c.var.mailboxStub.getImportJob(id);
		return c.json(job);
	}
	const missing: number[] = [];
	for (let n = 1; n <= (info.partsTotal ?? 0); n++) if (!info.parts.some((p) => p.n === n)) missing.push(n);
	if (missing.length > 0) {
		return c.json({ error: `Parts still missing: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", …" : ""}`, missing }, 409);
	}
	const upload = c.env.BUCKET.resumeMultipartUpload(info.r2Key!, info.uploadId!);
	await upload.complete(info.parts.map((p) => ({ partNumber: p.n, etag: p.etag })));
	const head = await c.env.BUCKET.head(info.r2Key!);
	const job = await c.var.mailboxStub.startImportJob(id, head?.size ?? info.sizeBytes ?? 0);
	return c.json(job);
});

for (const action of ["pause", "resume", "cancel"] as const) {
	importRoutes.post(`${MB}/imports/:id/${action}`, async (c: AppContext) => {
		const result = await c.var.mailboxStub.transitionImportJob(c.req.param("id")!, action);
		if ("error" in result) return c.json({ error: result.error }, result.status);
		return c.json(result.job);
	});
}
