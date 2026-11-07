// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Suppression list and template-send API.
 *
 *   GET    /api/v1/suppressions              list (q, scope, reason, limit, offset)
 *   POST   /api/v1/suppressions              add one or many
 *   POST   /api/v1/suppressions/import       bulk import (CSV body or JSON {csv})
 *   POST   /api/v1/suppressions/check        which of these addresses are suppressed
 *   DELETE /api/v1/suppressions/:id          remove one
 *   POST   /api/v1/mailboxes/:mailboxId/template-sends   render + send a template
 *
 * Mounted at the root of the API app (paths below are absolute). Reading and
 * checking is open to any signed-in caller, because the composer warns about a
 * suppressed recipient for every member. Changing the list is admin-only: it
 * decides who the whole deployment may mail, which is the same tier as
 * branding and mailbox management.
 */

import { trackOutgoingHtml, trackingBaseUrlFromRequest, type TrackingStub } from "../lib/tracking-send";
import { trackingOptOutStore } from "../lib/tracking-opt-outs";
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
	MAX_IMPORT_ROWS,
	SUPPRESSION_REASONS,
	normalizeSuppressionAddress,
	normalizeSuppressionScope,
	parseSuppressionCsv,
	isRecipientSuppressedError,
	type SuppressionReason,
} from "../../shared/suppressions";
import { Folders } from "../../shared/folders";
import { sendEmail } from "../email-sender";
import { describeSendError } from "../../shared/send-errors";
import { canAccessMailbox, canDo } from "../lib/authz";
import { generateMessageId, recordDelivery } from "../lib/email-helpers";
import { requireAdminScope, requireCapability, type MailboxContext } from "../lib/mailbox";
import { handleHardBounce, suppressionStore } from "../lib/suppressions";
import { httpRefusal, preSend, requestActor, type QuotaStub } from "../lib/pre-send";
import { actorNeedsGate, type HoldPayload } from "../lib/agent-send-gate";
import type { ComposedDraft } from "../lib/held-send";
import { bulkCompliance } from "../lib/send-compliance";
import * as templates from "../lib/templates";
import { productTemplateVariables } from "../lib/products";

type AppContext = Context<MailboxContext>;

export const suppressionRoutes = new Hono<MailboxContext>();

/**
 * Writing the list: an administrator, and a scoped token must hold
 * `mailboxes:manage` (or `admin`). Same tier as creating mailboxes, since it
 * decides who every mailbox on the deployment may mail.
 */
const requireSuppressionWrite = requireAdminScope("mailboxes:manage");

const Reason = z.enum(SUPPRESSION_REASONS);

const AddEntry = z.object({
	address: z.string().min(3).max(320),
	scope: z.string().max(253).optional(),
	reason: Reason.default("manual"),
});

const AddBody = z.union([
	AddEntry,
	z.object({ entries: AddEntry.array().min(1).max(1000) }),
]);

const CheckBody = z.object({
	addresses: z.array(z.string().max(320)).min(1).max(200),
	/** Sending mailbox or domain. Omit to report entries in any scope. */
	from: z.string().max(320).optional(),
});

function sourceFor(c: AppContext, channel: string): string {
	const id = c.var.principal?.identity?.id;
	return id ? `${channel}:${id}` : channel;
}

suppressionRoutes.get("/api/v1/suppressions", async (c) => {
	const limit = Number(c.req.query("limit") ?? 50);
	const offset = Number(c.req.query("offset") ?? 0);
	const reason = c.req.query("reason");
	const scopeRaw = c.req.query("scope");
	const scope = scopeRaw ? normalizeSuppressionScope(scopeRaw) : undefined;
	if (scopeRaw && !scope) return c.json({ error: "Invalid scope" }, 400);
	if (reason && !(SUPPRESSION_REASONS as readonly string[]).includes(reason)) {
		return c.json({ error: "Invalid reason" }, 400);
	}
	const page = await suppressionStore(c.env).listSuppressions({
		query: c.req.query("q") ?? undefined,
		scope: scope ?? undefined,
		reason: reason ?? undefined,
		limit: Number.isFinite(limit) ? limit : 50,
		offset: Number.isFinite(offset) ? offset : 0,
	});
	return c.json(page);
});

suppressionRoutes.post("/api/v1/suppressions/check", async (c) => {
	const body = CheckBody.parse(await c.req.json());
	const addresses = body.addresses
		.map(normalizeSuppressionAddress)
		.filter((a): a is string => a !== null);
	const domain = body.from
		? (body.from.includes("@") ? body.from.split("@").pop()! : body.from).toLowerCase()
		: null;
	const items = await suppressionStore(c.env).findSuppressions(addresses, domain);
	return c.json({ items });
});

suppressionRoutes.post("/api/v1/suppressions", requireSuppressionWrite, async (c) => {
	const parsed = AddBody.parse(await c.req.json());
	const raw = "entries" in parsed ? parsed.entries : [parsed];
	const entries: { address: string; scope: string; reason: SuppressionReason; source: string }[] = [];
	const errors: { index: number; error: string }[] = [];
	raw.forEach((entry, index) => {
		const address = normalizeSuppressionAddress(entry.address);
		const scope = normalizeSuppressionScope(entry.scope);
		if (!address) errors.push({ index, error: "not an email address" });
		else if (!scope) errors.push({ index, error: "scope must be \"global\" or a domain" });
		else entries.push({ address, scope, reason: entry.reason, source: sourceFor(c, "api") });
	});
	if (entries.length === 0) return c.json({ error: "No valid entries", errors }, 400);
	const result = await suppressionStore(c.env).addSuppressions(entries, Date.now());
	return c.json({ ...result, errors }, result.added > 0 ? 201 : 200);
});

suppressionRoutes.post("/api/v1/suppressions/import", requireSuppressionWrite, async (c) => {
	const contentType = c.req.header("content-type") ?? "";
	let csv: string;
	let reason: SuppressionReason | undefined;
	let scope: string | undefined;
	if (contentType.includes("application/json")) {
		const body = z
			.object({
				csv: z.string().max(5_000_000),
				reason: Reason.optional(),
				scope: z.string().max(253).optional(),
			})
			.parse(await c.req.json());
		csv = body.csv;
		reason = body.reason;
		scope = body.scope;
	} else {
		csv = await c.req.text();
		if (csv.length > 5_000_000) return c.json({ error: "Import is limited to 5 MB" }, 413);
		const r = c.req.query("reason");
		if (r && !(SUPPRESSION_REASONS as readonly string[]).includes(r)) {
			return c.json({ error: "Invalid reason" }, 400);
		}
		reason = r as SuppressionReason | undefined;
		scope = c.req.query("scope") ?? undefined;
	}
	const defaultScope = normalizeSuppressionScope(scope);
	if (!defaultScope) return c.json({ error: "Invalid scope" }, 400);

	const parsed = parseSuppressionCsv(csv, {
		defaultReason: reason,
		defaultScope,
		source: sourceFor(c, "csv"),
	});
	if (parsed.entries.length === 0) {
		return c.json({ error: "No valid rows to import", errors: parsed.errors.slice(0, 100) }, 400);
	}
	const result = await suppressionStore(c.env).addSuppressions(parsed.entries, Date.now());
	return c.json({
		added: result.added,
		existing: result.existing,
		rows: parsed.entries.length,
		maxRows: MAX_IMPORT_ROWS,
		// Capped: a file of 10,000 typos should not echo 10,000 errors back.
		errors: parsed.errors.slice(0, 100),
		errorCount: parsed.errors.length,
	});
});

suppressionRoutes.delete("/api/v1/suppressions/:id", requireSuppressionWrite, async (c) => {
	const deleted = await suppressionStore(c.env).deleteSuppression(c.req.param("id"));
	if (!deleted) return c.json({ error: "Suppression not found" }, 404);
	return c.json({ success: true });
});

// ── Template sends ─────────────────────────────────────────────────

const TemplateSendBody = z.object({
	template: z.string().min(1).max(100),
	from: z.string().email().optional(),
	recipients: z
		.array(
			z.object({
				email: z.string().email(),
				variables: z.record(z.string()).optional(),
			}),
		)
		.min(1)
		.max(50),
	/** Merged under each recipient's own variables. */
	variables: z.record(z.string()).optional(),
	/** `false`: send these untracked, whatever the mailbox setting. */
	track: z.boolean().optional(),
});

/**
 * Render a template and send one message per recipient.
 *
 * This is the bulk path: every message is non-transactional, so suppressed
 * recipients are skipped (and reported), and each message carries its own
 * signed unsubscribe link. One message per recipient is what makes the link
 * correct; a shared message could only carry one person's token.
 *
 * Sends synchronously, at most 50 per request, so the response can say what
 * actually happened to each recipient.
 */
suppressionRoutes.post("/api/v1/mailboxes/:mailboxId/template-sends", requireCapability("sendAs"), async (c) => {
	const mailboxId = decodeURIComponent(c.req.param("mailboxId")).toLowerCase();
	const body = TemplateSendBody.parse(await c.req.json());

	/**
	 * `sendAs` specifically. Template mail carries no `Sender:` attribution, so
	 * a `sendOnBehalf`-only grant would be sending unattributed bulk mail. A
	 * scoped token reaches `sendAs` only through `mail:send`: `canDo` already
	 * intersects the grant with the token's scopes (and its mailbox list).
	 */
	if (!canAccessMailbox(c.var.principal, mailboxId) || !canDo(c.var.principal, mailboxId, "sendAs")) {
		return c.json(
			{ error: "You do not have permission to do this in this mailbox (sendAs)", capability: "sendAs" },
			403,
		);
	}
	if (body.from && body.from.toLowerCase() !== mailboxId) {
		return c.json({ error: "From address must match the mailbox email address" }, 400);
	}

	const template = await templates.getTemplate(c.env.BUCKET, body.template);
	if (!template) return c.json({ error: "Template not found" }, 404);

	const stub = c.var.mailboxStub;
	const quota = () => stub as unknown as QuotaStub;

	const recipients = body.recipients.map((r) => ({ ...r, email: r.email.toLowerCase() }));
	// `{{product_name}}` and friends, for the product this mailbox sends as.
	const brandVars = await productTemplateVariables(c.env, mailboxId, new URL(c.req.url).origin);

	/** One recipient's message: the rendered template plus its compliance headers. */
	const compose = async (recipient: (typeof recipients)[number]) => {
		const variables: Record<string, string> = {
			...brandVars,
			name: recipient.email.split("@")[0] ?? "",
			email: recipient.email,
			...body.variables,
			...recipient.variables,
		};
		// Never caller-controlled: `{{unsubscribe_url}}` is left for
		// `applyUnsubscribeToHtml` to fill with the signed link below.
		delete variables.unsubscribe_url;
		const rendered = templates.renderTemplate(template, variables);
		// Unsubscribe pair, visible link and List-Id, the same for every bulk path.
		const compliance = await bulkCompliance(c.env, {
			recipient: recipient.email,
			fromAddress: mailboxId,
			listSlug: template.slug,
			listName: template.name,
			html: rendered.bodyHtml,
			requestUrl: c.req.url,
		});
		return { subject: rendered.subject, html: compliance.html ?? rendered.bodyHtml, headers: compliance.headers };
	};

	/**
	 * An API token or OAuth grant may be held for approval. The hold stores every
	 * recipient's RENDERED message, so the preview is what goes out; rendering
	 * only happens here when a hold is possible.
	 */
	const actor = requestActor(c);
	let held: ComposedDraft[] | null = null;
	if (actorNeedsGate(actor)) {
		held = [];
		for (const r of recipients) {
			const m = await compose(r);
			held.push({
				kind: "bulk",
				to: [r.email],
				from: mailboxId,
				subject: m.subject,
				html: m.html,
				headers: m.headers,
				row: { threadId: null, inReplyTo: null, references: [], rawHeaders: null },
				trackingBaseUrl: trackingBaseUrlFromRequest(c.req.url),
			});
		}
	}

	// Whole-request checks first: the cap and the bulk circuit breaker refuse
	// the batch before anything is stored or sent.
	const batch = await preSend(
		c.env,
		{
			kind: "bulk",
			from: mailboxId,
			mailboxId,
			to: recipients.map((r) => r.email),
			actor,
			...(held
				? {
						hold: {
							action: "template_send",
							subject: template.subject,
							payload: { composed: held, note: `Template "${template.name}", one message per recipient.` } satisfies HoldPayload,
						},
					}
				: {}),
		},
		{ quota },
	);
	if (!batch.ok && batch.code !== "all_suppressed") return c.json(...httpRefusal(batch));
	// Everyone suppressed is not a refusal here: each is reported as such below.
	const blocked = new Map(batch.suppressed.map((s) => [s.address, s] as const));
	const fromDomain = mailboxId.split("@")[1] ?? "";
	const results: {
		email: string;
		status: "sent" | "suppressed" | "failed";
		id?: string;
		reason?: string;
		error?: string;
	}[] = [];

	for (const recipient of recipients) {
		const hit = blocked.get(recipient.email);
		if (hit) {
			results.push({ email: recipient.email, status: "suppressed", reason: hit.reason });
			continue;
		}

		const rendered = await compose(recipient);
		const { html, headers } = rendered;

		// Per message: provider limits on the final headers and body. The cap is
		// counted once per recipient, so a batch that crosses it stops part-way
		// and reports the rest as failed.
		const gate = await preSend(
			c.env,
			{ kind: "bulk", from: mailboxId, mailboxId, to: recipient.email, html, headers },
			{ quota },
		);
		if (!gate.ok) {
			results.push(
				gate.code === "all_suppressed"
					? { email: recipient.email, status: "suppressed", reason: gate.suppressed[0]?.reason ?? "suppressed" }
					: { email: recipient.email, status: "failed", error: gate.error },
			);
			continue;
		}
		const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
		const now = new Date().toISOString();

		await stub.createEmail(
			Folders.SENT,
			{
				id: messageId,
				subject: rendered.subject,
				sender: mailboxId,
				recipient: recipient.email,
				date: now,
				body: html,
				message_id: outgoingMessageId,
				thread_id: messageId,
				raw_headers: JSON.stringify([
					{ key: "from", value: mailboxId },
					{ key: "to", value: recipient.email },
					{ key: "subject", value: rendered.subject },
					{ key: "date", value: now },
				]),
			},
			[],
		);

		// One message per recipient, so attribution here IS per recipient.
		const outgoingHtml = await trackOutgoingHtml({
			stub: stub as unknown as TrackingStub,
			mailboxId,
			emailId: messageId,
			html,
			baseUrl: trackingBaseUrlFromRequest(c.req.url),
			to: recipient.email,
			track: body.track,
			optOuts: trackingOptOutStore(c.env),
			fromAddress: mailboxId,
		});

		try {
			const sent = await sendEmail(c.env.EMAIL, {
				to: recipient.email,
				from: mailboxId,
				subject: rendered.subject,
				html: outgoingHtml ?? html,
				...(Object.keys(headers).length > 0 ? { headers } : {}),
			}, gate.clearance);
			await recordDelivery(stub, messageId, { providerMessageId: sent.messageId });
			results.push({ email: recipient.email, status: "sent", id: messageId });
		} catch (e) {
			// `sendEmail` validates limits and the header allowlist itself, so a
			// validation failure lands here too, described the same way.
			const detail = describeSendError(e);
			await recordDelivery(stub, messageId, { thrown: e });
			if (isRecipientSuppressedError(e)) {
				await handleHardBounce(c.env, {
					address: recipient.email,
					source: "provider:E_RECIPIENT_SUPPRESSED",
				});
				results.push({ email: recipient.email, status: "suppressed", id: messageId, reason: "provider" });
			} else {
				results.push({ email: recipient.email, status: "failed", id: messageId, error: detail });
			}
		}
	}

	const summary = {
		sent: results.filter((r) => r.status === "sent").length,
		suppressed: results.filter((r) => r.status === "suppressed").length,
		failed: results.filter((r) => r.status === "failed").length,
	};
	return c.json({ ...summary, results }, summary.sent > 0 ? 202 : 200);
});

