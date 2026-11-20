// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * One-off migration endpoints for consolidating per-domain deployments.
 *
 * Background: each Worker deployment owns its own MailboxDO namespace, so a
 * mailbox served by a retired deployment is invisible to the surviving one even
 * though both share the R2 bucket holding mailbox settings. These routes copy
 * the SQLite rows across.
 *
 * Attachment blobs are not copied. They live in R2 under
 * `attachments/{emailId}/{attachmentId}/{filename}` and both deployments point
 * at the same bucket, so preserving row IDs keeps existing blobs reachable.
 *
 * Access control: every route requires `MIGRATION_TOKEN` to be configured and
 * presented via `X-Migration-Token`. Without the secret the routes 404, so a
 * normal deployment exposes nothing. This sits behind Cloudflare Access too;
 * the token guards against an authenticated teammate triggering a data move by
 * accident.
 *
 * Mounting: this router is mounted under `/api/v1/_migrate`, and the paths below
 * are relative to that prefix. Keep it that way. The token gate is a `use("*")`
 * middleware and Hono scopes a sub-app's middleware to its mount path, so
 * mounting at "/" makes the gate match every request — on a deployment without
 * `MIGRATION_TOKEN` that returned `{"error":"Not found"}` for the entire SPA.
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { domainOfAddress } from "../lib/zones";
// Single source of truth for the payload shape: the exporter decides which
// tables travel, and it discovers them from the schema at runtime.
import type { ExportShape } from "../durableObject/transfer";

const migrate = new Hono<{ Bindings: Env }>();

/**
 * Gate every route on the shared secret. Uses a length-checked comparison to
 * avoid leaking the token through response timing.
 */
migrate.use("*", async (c, next) => {
	const expected = c.env.MIGRATION_TOKEN;
	if (!expected) return c.json({ error: "Not found" }, 404);

	const provided = c.req.header("x-migration-token") ?? "";
	if (provided.length !== expected.length) {
		return c.json({ error: "Forbidden" }, 403);
	}
	let mismatch = 0;
	for (let i = 0; i < expected.length; i++) {
		mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
	}
	if (mismatch !== 0) return c.json({ error: "Forbidden" }, 403);

	if (!c.env.LEGACY_MAILBOX) {
		return c.json(
			{ error: "LEGACY_MAILBOX binding is not configured on this deployment" },
			409,
		);
	}
	return next();
});

/**
 * Compare row counts between the legacy and current namespace for a mailbox.
 * Read-only — safe to call before and after a copy to verify the outcome.
 */
migrate.get("/mailboxes/:mailboxId/status", async (c) => {
	const mailboxId = decodeURIComponent(c.req.param("mailboxId")).toLowerCase();

	const legacyStub = c.env.LEGACY_MAILBOX!.get(
		c.env.LEGACY_MAILBOX!.idFromName(mailboxId),
	);
	const currentStub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));

	const [legacy, current] = await Promise.all([
		legacyStub.stats(),
		currentStub.stats(),
	]);

	return c.json({
		mailboxId,
		legacy,
		current,
		emailsOutstanding: Math.max(legacy.emails - current.emails, 0),
	});
});

/**
 * Copy one mailbox from the legacy namespace into the current one.
 *
 * Idempotent, so it can be run again after repointing Email Routing to pick up
 * anything that landed in the old namespace in the interim. Pass `?dryRun=1` to
 * report what would be copied without writing.
 */
migrate.post("/mailboxes/:mailboxId", async (c) => {
	const mailboxId = decodeURIComponent(c.req.param("mailboxId")).toLowerCase();
	const dryRun = c.req.query("dryRun") === "1" || c.req.query("dryRun") === "true";

	// Refuse to seed a mailbox this deployment does not actually serve — that
	// would create an orphan Durable Object no route can reach.
	if (!domainOfAddress(mailboxId)) {
		return c.json({ error: "mailboxId must be a full email address" }, 400);
	}

	// Settings live in the shared bucket; their absence means the mailbox was
	// never created and the copy target would be wrong.
	const settingsKey = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(settingsKey))) {
		return c.json(
			{ error: `No mailbox settings at ${settingsKey}; create the mailbox first` },
			404,
		);
	}

	const legacyStub = c.env.LEGACY_MAILBOX!.get(
		c.env.LEGACY_MAILBOX!.idFromName(mailboxId),
	);
	const currentStub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));

	const exported = (await legacyStub.exportAll()) as unknown as ExportShape;

	if (dryRun) {
		const current = await currentStub.stats();
		return c.json({
			mailboxId,
			dryRun: true,
			wouldCopy: {
				folders: exported.folders.length,
				emails: exported.emails.length,
				attachments: exported.attachments.length,
			},
			current,
		});
	}

	const inserted = await currentStub.importAll(exported);
	const [legacy, current] = await Promise.all([
		legacyStub.stats(),
		currentStub.stats(),
	]);

	return c.json({ mailboxId, inserted, legacy, current });
});

export { migrate };
