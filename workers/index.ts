// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import {
	canServeInline,
	storeAttachments,
	attachmentKey,
	sanitizeAttachmentFilename,
	type StoredAttachment,
} from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildOutgoingHeaders,
	recordDelivery,
	sendRejection,
	listMailboxes,
	assertMessageWithinSizeLimit,
	MessageTooLargeError,
	extractPriority,
	resolveInboundRecipients,
	resolveThreadedSend,
	textToHtml,
} from "./lib/email-helpers";
import {
	AttachmentPayloadSchema,
	SendEmailRequestSchema,
	type EmailFull,
} from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import {
	INSTANCE_IDEMPOTENT_ROUTES,
	MAILBOX_IDEMPOTENT_ROUTES,
	mountIdempotency,
} from "./lib/idempotency";
import {
	trackOutgoingHtml,
	trackingBaseUrlFromRequest,
} from "./lib/tracking-send";
import { trackingOptOutStore } from "./lib/tracking-opt-outs";
import { canMoveInto, Folders } from "../shared/folders";
import { isBlockedAttachment } from "../shared/attachment-types";
import { messageToMbox, type ExportableMessage } from "../shared/mbox";
import { resolveMessageDate } from "../shared/dates";
import { cleanSenderName } from "../shared/sender-name";
import { threadCandidates } from "../shared/message-ids";
import { autoDraftSkipReason, isAutoDraftEnabled } from "../shared/auto-draft";
import { decideForward } from "../shared/forwarding";
import { forwardInboundMessage } from "./lib/forwarding";
import { backgroundLocked } from "./lib/licence";
import { licenceRoutes } from "./routes/licence";
import {
	MailboxSettingsPatchSchema,
	defaultMailboxSettings,
	mergeMailboxSettings,
	parseStoredMailboxSettings,
} from "../shared/mailbox-settings";
import { decideAutoReply } from "../shared/auto-reply";
import {
	evaluateRules,
	MAX_RULE_CLAUSES,
	MAX_RULE_VALUE_LENGTH,
	MAX_RULES,
	type RuleOutcome,
} from "../shared/rules";
import {
	describeDsnFailure,
	extractOriginalMessageId,
	isDeliveryStatusNotification,
	parseDsn,
} from "../shared/dsn";
import {
	classifySpam,
	serializeSpamSignals,
	type SpamVerdict,
} from "../shared/spam";
import {
	mergePeople,
	filterPeople,
	sortPeople,
	paginate,
	type MailboxPersonRow,
	type PeopleSortKey,
	type SortDirection,
} from "../shared/people";
import type { Env } from "./types";
import {
	requireAdmin,
	requireAnyCapability,
	requireCapability,
	requireMailbox,
	resolvePrincipal,
	type MailboxContext,
} from "./lib/mailbox";
import { tokenScopeGuard } from "./lib/token-scope-guard";
import { purgeMailbox, purgeMailboxAuditLog } from "./lib/mailbox-purge";
import { agentInboxRoutes } from "./routes/agent-inboxes";
import { forgetAgentInboxForMailbox } from "./lib/agent-inboxes";
import { eventsRoutes } from "./routes/events";
import { stateResponse } from "./lib/mailbox-state";
import { timed, timedMiddleware } from "./lib/server-timing";
import { describeAuthority } from "./lib/token-authority";
import {
	accessCapabilities,
	FULL_ACCESS_ROLE,
	MAILBOX_CAPABILITIES,
	MAILBOX_ROLES,
	ROLE_CAPABILITIES,
	type MailboxCapability,
} from "./lib/capabilities";
import {
	AUDIT_PAGE_SIZE,
	auditActorRole,
	auditFilterFromQuery,
	listAudit,
	recordAudit,
	recordAuditDeferred,
} from "./lib/audit";
import { rateLimitGuard } from "./lib/rate-limit";
import { resolveAuthMode } from "./auth/config";
import {
	canAccessMailbox,
	canDo,
	deleteGrant,
	getGrant,
	isValidPrincipalId,
	listGrants,
	normalizeAddress,
	parseAdminEmails,
	putGrant,
	sendAttributionFor,
	visibleMailboxes,
	type Role,
} from "./lib/authz";
import { BULK_LIMIT } from "./durableObject/bulk";
import { migrate } from "./routes/migrate";
import { openApiRoutes } from "./routes/openapi";
import { suppressionRoutes } from "./routes/suppressions";
import { approvalRoutes } from "./routes/approvals";
import { analyticsRoutes } from "./routes/analytics";
import { usageRoutes } from "./routes/usage";
import { sendingHealthRoutes } from "./routes/sending-health";
import { FOLLOWUP_SEND_PATHS, followupRoutes, followupSendHook } from "./routes/followups";
import { assistantRoutes } from "./routes/assistant";
import { productRoutes } from "./routes/products";
import { privacyRoutes } from "./routes/privacy";
import { cloudflareRoutes } from "./routes/cloudflare";
import { cloudflareSetupRoutes } from "./routes/cloudflare-setup";
import { getPrivacySettings } from "./lib/privacy";
import { triageRoutes } from "./routes/triage";
import { semanticRoutes } from "./routes/semantic";
import { hybridSearch, semanticDeps } from "./lib/semantic";
import { importRoutes } from "./routes/import";
import { aiProviderRoutes, requireAiAdmin, requireAiPerson } from "./routes/ai-providers";
// Registers the gateway client loader with the router (bring-your-own AI gateway).
import "./lib/ai-gateway-factory";
import { decideInboundScreening, schedulePostIngest } from "./lib/inbound-triage";
import { schedulePushForNewMail } from "./lib/push";
import { pushRoutes } from "./routes/push";
import { applySendCompliance } from "./lib/send-compliance";
import { httpRefusal, preSend, requestActor, type QuotaStub } from "./lib/pre-send";
import { actorNeedsGate, type HoldPayload } from "./lib/agent-send-gate";
import { listOf } from "./lib/held-send";
import { previewEnrollment } from "./lib/held-enrollment";
import { noteProviderSuppression } from "./lib/suppressions";
import {
	onFeedbackReportForCompliance,
	onInboundForCompliance,
	type ComplaintStub,
} from "./lib/inbound-compliance";
import { assessInboundTrust, computeSenderWarnings } from "./lib/inbound-trust";
import { withMessageSecurity } from "./lib/message-security";
import { serializeSenderWarnings } from "../shared/sender-warning-types";
import { webhooks } from "./routes/webhooks";
import { domainOfAddress, getZones, isDomainAllowed } from "./lib/zones";
import { routeInbound } from "./lib/inbound-routing";
import {
	aliasRoutes,
	domainsRoutes,
	loadStoredDomains,
	aliasOwnerOf,
	senderAddressesFor,
} from "./routes/domains";

// V2 Services - Templates, Sequences
import * as templates from "./lib/templates";
import * as sequences from "./lib/sequences";
import {
	APP_NAME_MAX_LENGTH,
	BRANDING_LOGO_KEY,
	LogoValidationError,
	MAX_LOGO_BYTES,
	TAGLINE_MAX_LENGTH,
	deleteBrandingLogo,
	getBranding,
	isHexColor,
	putBrandingLogo,
	resetBranding,
	updateBranding,
} from "./lib/branding";
import {
	PreferencesPatchSchema,
	getPreferences,
	updatePreferences,
} from "./lib/preferences";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	/**
	 * Validated, where this used to be `z.record(z.any())`.
	 *
	 * The agent reads this blob back and concatenates `agentSystemPrompt` into
	 * the model's system prompt, so an unconstrained record let any caller store
	 * arbitrary instructions of arbitrary length for the AI to obey. `.strict()`
	 * also stops the blob re-growing keys that nothing reads and nothing checks.
	 */
	settings: MailboxSettingsPatchSchema.optional(),
});

/**
 * A settings update.
 *
 * The route used to cast `await c.req.json()` to `{ settings: Record<string,
 * unknown> }` and store it verbatim, which is the same unvalidated path into the
 * agent prompt that `CreateMailboxBody` had.
 */
const UpdateMailboxBody = z.object({
	settings: MailboxSettingsPatchSchema,
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
	/**
	 * Files to store against the draft, same encoding as the send routes.
	 *
	 * Only meaningful together with `replace_attachments`. Drafts previously had
	 * no attachment field at all, so anything staged in the composer was silently
	 * dropped the moment autosave ran — the user got the draft back with the
	 * files missing and no indication why.
	 */
	attachments: AttachmentPayloadSchema.array().optional(),
	/**
	 * Whether `attachments` is the draft's complete new set.
	 *
	 * Autosave fires on a timer and re-encoding unchanged files on every keystroke
	 * burst would be wasteful, so the composer sets this only when the set has
	 * actually changed. Absent, the stored attachments are left untouched.
	 */
	replace_attachments: z.boolean().optional(),
});

/**
 * Slug for an R2-backed resource.
 *
 * Constrained rather than free text because the value becomes part of an object
 * key: `templates/${slug}.json`. Unvalidated, a missing field wrote
 * `templates/undefined.json` and a slug containing `/` or `..` could address a
 * key outside the intended prefix.
 */
const RESOURCE_SLUG = z
	.string()
	.min(1)
	.max(100)
	.regex(
		/^[a-z0-9][a-z0-9-]*$/,
		"slug must be lowercase letters, digits and hyphens",
	);

const CreateTemplateBody = z.object({
	slug: RESOURCE_SLUG,
	name: z.string().min(1).max(200),
	subject: z.string().max(1000),
	bodyHtml: z.string(),
});

const UpdateTemplateBody = z.object({
	name: z.string().min(1).max(200).optional(),
	subject: z.string().max(1000).optional(),
	bodyHtml: z.string().optional(),
});

/**
 * One step of a sequence.
 *
 * `delayHours` is the gap after the previous step, so 0 is valid (send two
 * things at once) but negative is not — enrollment accumulates these into a
 * schedule, and a negative delay would place a later step before an earlier one.
 */
const SequenceStepBody = z.object({
	order: z.number().int().min(1),
	templateSlug: RESOURCE_SLUG,
	delayHours: z.number().min(0).max(24 * 365),
});

const CreateSequenceBody = z.object({
	name: z.string().min(1).max(200),
	steps: SequenceStepBody.array().min(1).max(50),
});

const UpdateSequenceBody = z.object({
	name: z.string().min(1).max(200).optional(),
	steps: SequenceStepBody.array().min(1).max(50).optional(),
});

const EnrollBody = z.object({
	personId: z.string().min(1),
	personEmail: z.string().email(),
	personName: z.string().nullish(),
	fromAddress: z.string().email(),
	variables: z.record(z.string()).optional(),
	skipSteps: z.number().int().array().optional(),
	delayOverrides: z.record(z.number().min(0)).optional(),
});

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const CreateLabelBody = z.object({
	name: z.string().min(1).max(100),
	color: z.string().regex(HEX_COLOR, "color must be a hex value like #3b82f6").optional(),
	parent_id: z.string().nullable().optional(),
	sort_order: z.number().int().optional(),
});

const UpdateLabelBody = z
	.object({
		name: z.string().min(1).max(100).optional(),
		color: z.string().regex(HEX_COLOR, "color must be a hex value like #3b82f6").optional(),
		parent_id: z.string().nullable().optional(),
		sort_order: z.number().int().optional(),
	})
	.refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

const SetEmailLabelsBody = z.object({
	label_ids: z.array(z.string().min(1)).max(50),
});

const AddEmailLabelBody = z.object({ label_id: z.string().min(1) });

const CreateSignatureBody = z.object({
	name: z.string().min(1).max(100),
	body_html: z.string().max(50_000),
	is_default: z.boolean().optional(),
});

const UpdateSignatureBody = z
	.object({
		name: z.string().min(1).max(100).optional(),
		body_html: z.string().max(50_000).optional(),
		is_default: z.boolean().optional(),
	})
	.refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

/** Snooze takes an absolute ISO timestamp or a relative delay — exactly one. */
const SnoozeBody = z
	.object({
		until: z.string().optional(),
		delay_seconds: z.number().int().positive().max(365 * 24 * 60 * 60).optional(),
	})
	.refine((d) => Boolean(d.until) !== (d.delay_seconds !== undefined), {
		message: "Provide exactly one of 'until' or 'delay_seconds'",
	});

const PriorityBody = z.object({
	priority: z.enum(["high", "low"]).nullable(),
});

/**
 * Scheduling fields for POST /scheduled-sends, parsed alongside
 * SendEmailRequestSchema rather than merged into it: that schema carries a
 * `.refine()` and so cannot be `.extend()`ed.
 */
const ScheduleFieldsBody = z
	.object({
		send_at: z.string().optional(),
		delay_seconds: z.number().int().positive().max(90 * 24 * 60 * 60).optional(),
		/**
		 * Id of the message this one answers or forwards. When set, threading is
		 * derived from that message server-side instead of from client-supplied
		 * `in_reply_to` / `references` — see the handler for why that matters.
		 */
		reply_to_email_id: z.string().optional(),
		/**
		 * Whether `reply_to_email_id` is being answered or forwarded. Only a reply
		 * implies the thread has been read, matching routes/reply-forward.ts.
		 */
		threaded_mode: z.enum(["reply", "forward"]).optional(),
		/**
		 * The draft this send was composed from, to be destroyed once the message
		 * is safely queued.
		 *
		 * Superseding the draft used to be a second request from the client —
		 * `DELETE /emails/:id?permanent=1` — which made sending a draft require
		 * `deletePermanently`. The `agent` preset does not hold that, so an agent
		 * grant queued the message, got a 403 on the follow-up, and was told the
		 * send had failed; pressing Send again sent a second copy. Destroying the
		 * row here instead keeps it under the authority that is actually being
		 * exercised, and closes the window where the message was queued and the
		 * draft still existed.
		 */
		supersedes_draft_id: z.string().optional(),
	})
	.refine((d) => Boolean(d.send_at) !== (d.delay_seconds !== undefined), {
		message: "Provide exactly one of 'send_at' or 'delay_seconds'",
	});

const BlockSenderBody = z.object({
	pattern: z.string().min(3).max(320),
	reason: z.string().max(500).nullable().optional(),
});

/**
 * A filter rule as the client sends it.
 *
 * Conditions and actions are validated structurally here so a malformed clause
 * is rejected at the edge rather than stored and then quietly ignored on the
 * delivery path, where nobody would see the failure.
 */
const RuleConditionBody = z.object({
	field: z.enum([
		"from",
		"to",
		"cc",
		"recipient",
		"subject",
		"body",
		"has_attachment",
	]),
	operator: z.enum([
		"contains",
		"not_contains",
		"equals",
		"starts_with",
		"ends_with",
		"domain_is",
		"is_true",
	]),
	value: z.string().max(MAX_RULE_VALUE_LENGTH).optional(),
});

const RuleActionBody = z.object({
	type: z.enum([
		"move_to_folder",
		"apply_label",
		"mark_read",
		"star",
		"trash",
		"set_priority",
		"skip_auto_draft",
	]),
	value: z.string().max(200).optional(),
});

const CreateRuleBody = z.object({
	name: z.string().min(1).max(120),
	enabled: z.boolean().optional(),
	match_type: z.enum(["all", "any"]).optional(),
	conditions: z.array(RuleConditionBody).min(1).max(MAX_RULE_CLAUSES),
	actions: z.array(RuleActionBody).min(1).max(MAX_RULE_CLAUSES),
	stop_processing: z.boolean().optional(),
});

const UpdateRuleBody = z.object({
	name: z.string().min(1).max(120).optional(),
	enabled: z.boolean().optional(),
	match_type: z.enum(["all", "any"]).optional(),
	conditions: z.array(RuleConditionBody).min(1).max(MAX_RULE_CLAUSES).optional(),
	actions: z.array(RuleActionBody).min(1).max(MAX_RULE_CLAUSES).optional(),
	stop_processing: z.boolean().optional(),
});

const ReorderRulesBody = z.object({
	ids: z.array(z.string().min(1)).max(MAX_RULES),
});

/**
 * One action applied to a set of messages.
 *
 * A discriminated union rather than a bag of optional fields, so "move without
 * a folder" or "label without a label id" is rejected by the parse instead of
 * being caught in the handler. `BULK_LIMIT` is enforced here as well as in the
 * storage layer to keep an oversized request cheap to reject.
 */
const BulkIds = z.array(z.string().min(1)).min(1).max(BULK_LIMIT);

const BulkActionBody = z.discriminatedUnion("action", [
	z.object({ action: z.literal("read"), ids: BulkIds }),
	z.object({ action: z.literal("unread"), ids: BulkIds }),
	z.object({ action: z.literal("star"), ids: BulkIds }),
	z.object({ action: z.literal("unstar"), ids: BulkIds }),
	z.object({ action: z.literal("delete"), ids: BulkIds }),
	z.object({ action: z.literal("delete_permanently"), ids: BulkIds }),
	z.object({ action: z.literal("restore"), ids: BulkIds }),
	z.object({ action: z.literal("move"), ids: BulkIds, folder_id: z.string().min(1) }),
	z.object({ action: z.literal("label"), ids: BulkIds, label_id: z.string().min(1) }),
	z.object({ action: z.literal("unlabel"), ids: BulkIds, label_id: z.string().min(1) }),
]);

/** Both scopes are optional; omitting them clears unread across the mailbox. */
const MarkAllReadBody = z
	.object({
		folder: z.string().min(1).optional(),
		label_id: z.string().min(1).optional(),
	})
	.optional();

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

/**
 * Narrow a client-supplied sort direction to the two values the DO accepts.
 *
 * The DO splices the direction into hand-written SQL for the threaded queries,
 * so it must never see an arbitrary string. Anything unrecognised becomes
 * undefined and the DO applies its own default rather than failing the request.
 */
function normalizeSortDirection(value: string | undefined): "ASC" | "DESC" | undefined {
	if (!value) return undefined;
	const upper = value.toUpperCase();
	return upper === "ASC" ? "ASC" : upper === "DESC" ? "DESC" : undefined;
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();

/**
 * Response headers that stop a cross-origin page *reading* our replies.
 *
 * This is not the CSRF defence, despite the comment below once claiming it
 * "blocks all other cross-origin requests". CORS cannot block a request: the
 * browser sends it, we execute it, and only the response is withheld from the
 * calling script. Anything whose value is the side effect — changing the
 * forwarding address, sending mail, deleting a message — is unaffected.
 *
 * Requests are refused by `csrfGuard` in ./app.ts. This stays for what it is
 * actually good for: keeping response bodies out of other origins.
 */
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
/**
 * Resolve the caller's authority before the route table runs.
 *
 * Ahead of `requireMailbox` because that middleware now consults the result,
 * and mounted on all of `/api/*` so the instance-wide routes below (branding,
 * grant management, migration) can gate on the same principal.
 */
app.use("/api/*", timedMiddleware("authz", resolvePrincipal));
// Scoped API tokens: instance-level routes. Mailbox work is narrowed in authz.
app.use("/api/*", tokenScopeGuard);

// Domains added through /api/v1/domains join env DOMAINS/ZONES in `getZones`.
// Cached per isolate; a failed read leaves env domains working.
app.use("/api/*", async (c, next) => {
	await timed(c, "domains", () => loadStoredDomains(c.env));
	return next();
});

/**
 * Then bound how fast that caller may ask.
 *
 * After `resolvePrincipal` because the budget is charged per identity rather than
 * per IP — the app is behind Access, so requests arrive attributed, and a team
 * sharing one office address should not share one budget.
 */
app.use(
	"/api/*",
	timedMiddleware(
		"ratelimit",
		rateLimitGuard({
			bucket: "api",
			bindingName: "API_RATE_LIMITER",
			select: (env) => env.API_RATE_LIMITER,
			retryAfterSeconds: 60,
		}),
	),
);

app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// AI provider settings are admin-only and changed only by a person; checked
// before the idempotency layer so a refused create is never keyed.
app.use("/api/v1/ai/providers", requireAiAdmin, requireAiPerson);

// Idempotency-Key on instance-level creates (keys in AuthDO). See ./lib/idempotency.ts.
mountIdempotency(app, INSTANCE_IDEMPOTENT_ROUTES);

// Domain management and mailbox aliases. See workers/routes/domains.ts.
app.route("/api/v1/domains", domainsRoutes);
app.route("/api/v1/mailboxes", aliasRoutes);

/**
 * Capability gates, layered on top of `requireMailbox`.
 *
 * `requireMailbox` establishes that the caller may reach this mailbox at all.
 * These decide how far in they may go, and they are mounted as path middleware
 * rather than wrapped around handlers so that a route added under one of these
 * paths later inherits its gate by virtue of where it lives.
 *
 * Method-scoped throughout: a `GET` on a path is a read even where the `POST` is
 * a send, so gating the path wholesale would refuse a viewer their inbox.
 *
 * `read` itself is not gated here. Reaching this point already required a grant,
 * and every preset includes `read` — an entry with `read` revoked is refused by
 * the explicit gate on the list and message routes below.
 */

/**
 * Reading.
 *
 * Gated explicitly so a grant with `read` revoked cannot still list mail — and
 * the list has to name *every* route that reveals a message, not just the obvious
 * ones. A revocation that covers the inbox but not `labels/:labelId/emails` is
 * not a revocation; it is a detour.
 */
app.on(
	["GET"],
	[
		"/api/v1/mailboxes/:mailboxId/emails",
		"/api/v1/mailboxes/:mailboxId/emails/:id",
		// The delivery ledger carries recipients, provider ids, error detail and
		// engagement metadata — message data by any reading, so a grant with
		// `read` revoked must not reach it as a detour around `/emails/:id`.
		"/api/v1/mailboxes/:mailboxId/emails/:id/delivery-events",
		"/api/v1/mailboxes/:mailboxId/threads/:threadId",
		// An AI summary describes the messages, so it is reading them.
		"/api/v1/mailboxes/:mailboxId/threads/:threadId/summary",
		"/api/v1/mailboxes/:mailboxId/search",
		// Index status: counts only, but it is about the mailbox's mail.
		"/api/v1/mailboxes/:mailboxId/semantic",
		"/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId",
		// Every other way to get a message, or a list of them, out of the mailbox.
		"/api/v1/mailboxes/:mailboxId/labels/:labelId/emails",
		"/api/v1/mailboxes/:mailboxId/emails/:id/labels",
		"/api/v1/mailboxes/:mailboxId/snoozed",
		"/api/v1/mailboxes/:mailboxId/followups",
		"/api/v1/mailboxes/:mailboxId/emails/:id/followup",
		"/api/v1/mailboxes/:mailboxId/screener",
		"/api/v1/mailboxes/:mailboxId/inbox-tabs",
		"/api/v1/mailboxes/:mailboxId/label-prompts",
		"/api/v1/mailboxes/:mailboxId/scheduled-sends",
		"/api/v1/mailboxes/:mailboxId/muted-threads",
		"/api/v1/mailboxes/:mailboxId/signatures",
		"/api/v1/mailboxes/:mailboxId/signatures/default",
		// The export is every message at once, so it is the last route that may be
		// left off this list — a grant with `read` revoked could otherwise download
		// the whole mailbox while being refused a single message.
		"/api/v1/mailboxes/:mailboxId/export",
	],
	requireCapability("read"),
);

/**
 * Sending.
 *
 * Either sending capability passes. `sendAs` and `sendOnBehalf` differ in
 * attribution rather than in power, and they are independently grantable — a
 * viewer extended with `sendAs`, or a manager with `sendOnBehalf` revoked, both
 * exist. Gating on `sendOnBehalf` alone refused exactly those grants, so the
 * documented ability to grant `sendAs` on its own was unusable.
 *
 * Which of the two is used is still `sendAttributionFor`'s decision, inside the
 * handler, where Send As wins when both are held.
 */
const requireSend = requireAnyCapability(["sendAs", "sendOnBehalf"]);

app.on(
	["POST"],
	[
		"/api/v1/mailboxes/:mailboxId/emails",
		"/api/v1/mailboxes/:mailboxId/emails/:id/reply",
		"/api/v1/mailboxes/:mailboxId/emails/:id/forward",
		"/api/v1/mailboxes/:mailboxId/scheduled-sends",
	],
	requireSend,
);

// Cancelling a scheduled send is unsending, so it belongs with sending.
app.on(
	["DELETE"],
	"/api/v1/mailboxes/:mailboxId/scheduled-sends/:emailId",
	requireSend,
);

/**
 * Sending a queued message early is sending (Codex P1).
 *
 * Without this the route inherited only `requireMailbox`, so a `viewer` — who
 * holds neither `sendAs` nor `sendOnBehalf` — could list the Scheduled folder,
 * take an id from it, and push the message out. Read-only access would have been
 * enough to deliver mail.
 *
 * The delay is what made it reachable: every ordinary send passes through
 * Scheduled for 30 seconds, so this was not limited to messages someone had
 * deliberately scheduled for later.
 */
app.on(
	["POST"],
	"/api/v1/mailboxes/:mailboxId/scheduled-sends/:emailId/send-now",
	requireSend,
);

// Drafts are unsent, so composing one needs no authority to send.
app.on(["POST"], "/api/v1/mailboxes/:mailboxId/drafts", requireCapability("draft"));

// Asking for a fresh AI summary changes no mail; anyone who may read it may ask.
app.on(
	["POST"],
	[
		"/api/v1/mailboxes/:mailboxId/threads/:threadId/summary/refresh",
		"/api/v1/mailboxes/:mailboxId/threads/:threadId/summary/generate",
	],
	requireCapability("read"),
);

// Binning. Destroying outright is checked separately, inside the handlers that
// can destroy — `?permanent=1` and emptying the bin.
app.on(["DELETE"], "/api/v1/mailboxes/:mailboxId/emails/:id", requireCapability("delete"));
app.on(
	["POST"],
	"/api/v1/mailboxes/:mailboxId/emails/:id/restore",
	requireCapability("delete"),
);
app.on(
	["POST"],
	"/api/v1/mailboxes/:mailboxId/trash/empty",
	requireCapability("deletePermanently"),
);

/**
 * Organising: folders, labels, moves, and per-message state.
 *
 * `emails/:id` is listed for `PUT` only, deliberately. Hono runs *every* matching
 * path middleware, so including `DELETE` here as well would mean a delete had to
 * satisfy both this gate and the `delete` gate above — and a grant holding
 * `delete` with `organise` revoked could not bin a message, even though the two
 * are modelled as independent capabilities.
 */
app.on(
	["POST", "PUT", "DELETE"],
	[
		"/api/v1/mailboxes/:mailboxId/folders",
		"/api/v1/mailboxes/:mailboxId/folders/:id",
		"/api/v1/mailboxes/:mailboxId/labels",
		"/api/v1/mailboxes/:mailboxId/labels/:labelId",
		"/api/v1/mailboxes/:mailboxId/emails/:id/labels",
		"/api/v1/mailboxes/:mailboxId/emails/:id/labels/:labelId",
		"/api/v1/mailboxes/:mailboxId/emails/:id/move",
		"/api/v1/mailboxes/:mailboxId/emails/:id/snooze",
		"/api/v1/mailboxes/:mailboxId/emails/:id/followup",
		"/api/v1/mailboxes/:mailboxId/emails/:id/followup/cancel",
		"/api/v1/mailboxes/:mailboxId/triage/backfill",
		"/api/v1/mailboxes/:mailboxId/emails/:id/priority",
		"/api/v1/mailboxes/:mailboxId/emails/:id/not-spam",
		"/api/v1/mailboxes/:mailboxId/threads/:threadId/read",
		"/api/v1/mailboxes/:mailboxId/threads/:threadId/mute",
		"/api/v1/mailboxes/:mailboxId/mark-all-read",
	],
	requireCapability("organise"),
);

// Editing a message in place (flags, folder) is organising; deleting it is not.
app.on(
	["PUT"],
	"/api/v1/mailboxes/:mailboxId/emails/:id",
	requireCapability("organise"),
);

// Rules and sender lists shape what arrives, so they are their own capability.
app.on(
	["POST", "PUT", "DELETE"],
	[
		"/api/v1/mailboxes/:mailboxId/rules",
		"/api/v1/mailboxes/:mailboxId/rules/:ruleId",
		"/api/v1/mailboxes/:mailboxId/rules/reorder",
		"/api/v1/mailboxes/:mailboxId/blocked-senders",
		"/api/v1/mailboxes/:mailboxId/blocked-senders/:blockId",
		"/api/v1/mailboxes/:mailboxId/allowed-senders",
		"/api/v1/mailboxes/:mailboxId/allowed-senders/:allowId",
		// Label prompts and presets decide what arrives where, like rules.
		"/api/v1/mailboxes/:mailboxId/labels/:labelId/prompt",
		"/api/v1/mailboxes/:mailboxId/triage/presets/:key",
		// Yes and No write the allow and block lists.
		"/api/v1/mailboxes/:mailboxId/screener/:sender",
	],
	requireCapability("manageRules"),
);

/**
 * Mailbox configuration.
 *
 * `PUT /mailboxes/:mailboxId` carries `forwarding.email`, so whoever can write
 * it can redirect every message the mailbox receives to an address they control.
 * Signatures are here too because they are part of its outgoing identity.
 */
app.on(
	["PUT"],
	"/api/v1/mailboxes/:mailboxId",
	requireCapability("manageSettings"),
);
app.on(
	["POST", "PUT", "DELETE"],
	[
		"/api/v1/mailboxes/:mailboxId/signatures",
		"/api/v1/mailboxes/:mailboxId/signatures/:signatureId",
	],
	requireCapability("manageSettings"),
);
// Open/click tracking toggles and the disclosure line. See ./routes/privacy.ts.
app.on(["PATCH"], "/api/v1/mailboxes/:mailboxId/settings/tracking", requireCapability("manageSettings"));
// Mail import: starting one fills the mailbox and the IMAP form carries a
// password, so writes are settings; progress is reading. See ./routes/import.ts.
app.on(
	["POST", "PUT"],
	[
		"/api/v1/mailboxes/:mailboxId/imports",
		"/api/v1/mailboxes/:mailboxId/imports/:id/parts/:part",
		"/api/v1/mailboxes/:mailboxId/imports/:id/complete",
		"/api/v1/mailboxes/:mailboxId/imports/:id/pause",
		"/api/v1/mailboxes/:mailboxId/imports/:id/resume",
		"/api/v1/mailboxes/:mailboxId/imports/:id/cancel",
	],
	requireCapability("manageSettings"),
);
app.on(["GET"], ["/api/v1/mailboxes/:mailboxId/imports", "/api/v1/mailboxes/:mailboxId/imports/:id"], requireCapability("read"));

// Idempotency-Key on per-mailbox sends and creates, after the gates above so a
// refused caller never reserves a key. Keys live in the MailboxDO.
mountIdempotency(app, MAILBOX_IDEMPOTENT_ROUTES);

// Follow-up reminders on a successful send. See ./routes/followups.ts.
app.on(["POST"], FOLLOWUP_SEND_PATHS, followupSendHook);

/**
 * Turn an unhandled error into a response.
 *
 * Routes validate their bodies with `Schema.parse()`, which throws. Without this
 * handler every malformed request produced a bare 500 with no indication of which
 * field was wrong — indistinguishable from the server being broken, and the
 * client's `ApiError` had no message to surface. A ZodError is the caller's
 * fault, so it becomes a 400 that names the offending fields.
 *
 * Everything else is logged and reported as a generic 500: an internal message
 * can carry storage keys or addresses, and this API is reachable by anyone who
 * passes the shared Access policy.
 */
app.onError((err, c) => {
	if (err instanceof z.ZodError) {
		return c.json(
			{
				error: "Invalid request body",
				details: err.issues.map((issue) => ({
					path: issue.path.join("."),
					message: issue.message,
				})),
			},
			400,
		);
	}

	// HTTPException and friends carry their own response; let Hono use it.
	if (typeof (err as { getResponse?: unknown }).getResponse === "function") {
		return (err as unknown as { getResponse: () => Response }).getResponse();
	}

	console.error(
		`Unhandled error on ${c.req.method} ${c.req.path}:`,
		err.message,
		err.stack,
	);
	return c.json({ error: "Internal server error" }, 500);
});

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const zones = getZones(c.env);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	// `domains` is kept in the response for backward compatibility with clients
	// that predate `zones`.
	return c.json({ domains: zones.map((z) => z.domain), emailAddresses, zones });
});

// -- Branding -------------------------------------------------------
//
// Instance-wide product name, accent colour and logo. See `lib/branding.ts` for
// why this is one global record in R2 rather than a per-user row.

const BrandingUpdateSchema = z
	.object({
		appName: z
			.string()
			.trim()
			.min(1, "App name can't be empty")
			.max(APP_NAME_MAX_LENGTH, `App name must be ${APP_NAME_MAX_LENGTH} characters or fewer`)
			.optional(),
		// Nullable so the client can clear it; `""` is treated as clearing too.
		tagline: z
			.string()
			.max(TAGLINE_MAX_LENGTH, `Tagline must be ${TAGLINE_MAX_LENGTH} characters or fewer`)
			.nullish(),
		accentColor: z
			.string()
			.refine(isHexColor, "Accent colour must be a hex value like #4F46E5")
			.optional(),
	})
	.strict();

const BrandingLogoSchema = z
	.object({
		/** Base64 with no data-URL prefix, as attachments are sent. */
		content: z.string().min(1),
		filename: z.string().min(1).max(255),
		type: z.string().min(1).max(120),
	})
	.strict();

app.get("/api/v1/branding", async (c) => {
	return c.json(await getBranding(c.env.BUCKET));
});

/**
 * Branding is instance-wide, so changing it is administrator-only.
 *
 * Reads stay open to any authenticated caller — the app cannot render its own
 * header without them.
 */
app.put("/api/v1/branding", requireAdmin, async (c) => {
	const patch = BrandingUpdateSchema.parse(await c.req.json());
	return c.json(
		await updateBranding(c.env.BUCKET, {
			...patch,
			// `null` and `undefined` mean different things to the store: absent
			// leaves the tagline alone, present-but-empty clears it.
			...(patch.tagline !== undefined ? { tagline: patch.tagline ?? "" } : {}),
		}),
	);
});

app.delete("/api/v1/branding", requireAdmin, async (c) => {
	return c.json(await resetBranding(c.env.BUCKET));
});

app.put("/api/v1/branding/logo", requireAdmin, async (c) => {
	const body = BrandingLogoSchema.parse(await c.req.json());
	try {
		return c.json(await putBrandingLogo(c.env.BUCKET, body));
	} catch (e) {
		// A rejected image is the caller's fault, not a server fault, so it must
		// not fall through to the generic 500 in `app.onError`.
		if (e instanceof LogoValidationError) {
			return c.json({ error: e.message, maxBytes: MAX_LOGO_BYTES }, 400);
		}
		throw e;
	}
});

app.delete("/api/v1/branding/logo", requireAdmin, async (c) => {
	return c.json(await deleteBrandingLogo(c.env.BUCKET));
});

/**
 * Serve the logo bytes.
 *
 * Cached as immutable only when the caller passes the `v` stamp from the branding
 * record. The blob sits at one fixed key that is overwritten in place, so an
 * unversioned URL must stay revalidated or a replaced logo would never appear.
 *
 * `private` rather than `public`: nothing here is secret, but the whole app is
 * behind an Access policy and a shared cache has no business holding it.
 */
/**
 * Web app manifest, so the mail client can be installed.
 *
 * Generated rather than a static file in `public/`, because the app name, accent
 * colour and logo are all configurable at runtime (**Settings → App branding**)
 * and stored per deployment. A static `manifest.json` would name whatever the
 * upstream project was called, so an operator who rebranded would install an app
 * called something else — and would have no way to fix it without a code change,
 * which is exactly what making branding configurable was meant to avoid.
 *
 * Behind Access like everything else, which is a real constraint rather than a
 * choice: Access is enforced at the edge on the Worker route, so an
 * uncredentialed request never reaches this handler and nothing here could exempt
 * it. The `<link rel="manifest">` is therefore emitted with `crossOrigin="use-credentials"`
 * — without it the browser fetches the manifest anonymously, is bounced by Access,
 * and reports the app as non-installable with no indication why.
 *
 * The consequence worth knowing: install works for a signed-in reader, and is
 * unavailable to someone who has not authenticated yet. That is the right way
 * round for a private mailbox, and it is the same trade every route makes.
 *
 * Icons are always declared, from bundled 192px and 512px PNGs. Chromium's
 * installability criteria require *both* those sizes — a manifest with no `icons`
 * field, or one declaring only `sizes: "any"`, is not installable at all, so the
 * first version of this shipped an app that could not be installed on a fresh
 * deployment. That is the opposite of the point.
 *
 * An uploaded branding logo is added *alongside* them rather than replacing them.
 * It is a single raster of unknown dimensions, so it cannot honestly claim either
 * required size; declared as `sizes: "any"` it is available to an installer that
 * prefers it while the bundled pair keeps the app installable regardless.
 */
app.get("/manifest.webmanifest", async (c) => {
	const branding = await getBranding(c.env.BUCKET);

	const manifest: Record<string, unknown> = {
		name: branding.appName,
		short_name: branding.appName,
		...(branding.tagline ? { description: branding.tagline } : {}),
		// `/` rather than the inbox: which mailbox to open is a decision the
		// chooser route already makes, and hard-coding one here would break for
		// anyone whose mailbox is not the one that was current at install time.
		start_url: "/",
		scope: "/",
		display: "standalone",
		theme_color: branding.accentColor,
		// Matches the light theme's page background. The manifest cannot follow the
		// theme picker — it is read once at install — so this is the splash colour
		// for a cold start, not a claim about the running app.
		background_color: "#ffffff",
		// A mail client is portrait on a phone and landscape on a tablet, so it does
		// not constrain orientation.
		icons: [
			// The two sizes Chromium requires, bundled so a fresh deployment with no
			// branding logo is still installable.
			{ src: "/icon-192.png", type: "image/png", sizes: "192x192", purpose: "any" },
			{ src: "/icon-512.png", type: "image/png", sizes: "512x512", purpose: "any" },
			// `maskable` is a separate entry with its own art: a platform that applies
			// a circular mask crops the corners, so the glyph is inset further. Reusing
			// the `any` icon here is what produces the clipped-logo look on Android.
			{
				src: "/icon-512-maskable.png",
				type: "image/png",
				sizes: "512x512",
				purpose: "maskable",
			},
			// The operator's logo, offered to installers that prefer it. `sizes: "any"`
			// because the upload's real dimensions are not known here, and claiming a
			// size it might not have is worse than declining to claim one.
			...(branding.logoMimeType
				? [
						{
							src:
								branding.logoUpdatedAt !== null
									? `/api/v1/branding/logo?v=${branding.logoUpdatedAt}`
									: "/api/v1/branding/logo",
							type: branding.logoMimeType,
							sizes: "any",
							purpose: "any",
						},
					]
				: []),
		],
		// No `shortcuts`. The obvious one is Compose, but there is no URL that opens
		// the composer — it is store state inside the workspace, not a route — so a
		// shortcut would land on the inbox and appear broken. Worth adding once
		// composing has an address of its own.
	};

	return new Response(JSON.stringify(manifest), {
		headers: {
			"Content-Type": "application/manifest+json",
			// Short cache: branding can change, and an installed app re-reading a
			// stale manifest would keep the old name for a year.
			"Cache-Control": "public, max-age=300",
			"X-Content-Type-Options": "nosniff",
		},
	});
});

app.get("/api/v1/branding/logo", async (c) => {
	const branding = await getBranding(c.env.BUCKET);
	if (!branding.logoMimeType) return c.json({ error: "No logo set" }, 404);

	const obj = await c.env.BUCKET.get(BRANDING_LOGO_KEY);
	if (!obj) return c.json({ error: "No logo set" }, 404);

	const versioned =
		branding.logoUpdatedAt !== null &&
		c.req.query("v") === String(branding.logoUpdatedAt);

	const headers = new Headers();
	headers.set("Content-Type", branding.logoMimeType);
	headers.set(
		"Cache-Control",
		versioned
			? "private, max-age=31536000, immutable"
			: "private, no-cache, must-revalidate",
	);
	// The upload route restricts the type to raster images, but never let a
	// browser sniff its way to something executable in this origin regardless.
	headers.set("X-Content-Type-Options", "nosniff");
	return new Response(obj.body, { headers });
});

// -- Preferences ----------------------------------------------------
//
// Notification and display preferences. See `lib/preferences.ts` for why these
// are one global R2 record rather than per-mailbox rows, and why theme is
// deliberately not among them.

app.get("/api/v1/preferences", async (c) => {
	return c.json(await getPreferences(c.env.BUCKET));
});

/**
 * Instance-wide, so changing them is administrator-only — the same rule as
 * branding, for the same reason: one record decides how the list is drawn and
 * whether notifications fire for everyone who uses this deployment.
 *
 * Reads stay open to any authenticated caller, because the workspace cannot lay
 * itself out without them.
 *
 * The settings screen already hides the section from non-administrators, but that
 * is presentation. Without the check here the endpoint was still open to any
 * authenticated caller, and a UI-only guard is not an authorization model.
 */
app.put("/api/v1/preferences", requireAdmin, async (c) => {
	const patch = PreferencesPatchSchema.parse(await c.req.json());
	return c.json(await updatePreferences(c.env.BUCKET, patch));
});

/**
 * The signed-in caller, from the Cloudflare Access token verified in
 * `workers/app.ts`, together with what they are allowed to do.
 *
 * `role` is answered from the authorization model rather than hardcoded, and
 * `mailboxes` reports the grant (null meaning "all of them"). `enforced` tells the
 * client whether any of it is binding: while `ADMIN_EMAILS` is unset this
 * deployment still treats every authenticated caller as an administrator, and the
 * UI should be able to say so rather than implying a model that is not switched
 * on. See `workers/lib/authz.ts`.
 *
 * `kind` distinguishes a person from an Access service token. A machine caller has
 * no email, so `email` is null and `name` falls back to the token's Client ID.
 *
 * In development the Access middleware is skipped, so there is no token to read
 * and the response is an explicitly-labelled local identity.
 */
app.get("/api/v1/me", (c) => {
	const principal = c.var.principal;
	const identity = principal.identity;
	const authUser = c.var.authUser;

	/**
	 * `capabilities`: what the caller may do in each mailbox they can reach, or
	 * `null` when they may do everything everywhere.
	 *
	 * Sent expanded rather than as role names so the UI never has to know the
	 * preset table: it asks "does this list contain `sendAs`", and a preset
	 * widened server-side takes effect without a client release. Same `null`
	 * versus `[]` distinction as `mailboxes` — everything, versus nothing.
	 *
	 * For a scoped API token all three fields are the *effective* authority (user
	 * grants ∩ token scopes ∩ token mailboxes), and `token` names the scopes.
	 */
	const authority = describeAuthority(principal);
	const shared = {
		role: authority.role,
		mailboxes: authority.mailboxes,
		capabilities: authority.capabilities,
		token: authority.token,
		enforced: principal.enforced,
		kind: identity?.kind ?? null,
		/**
		 * How this deployment and this request authenticated. `userId`,
		 * `isOwner` and `totpEnabled` describe a built-in account and are null
		 * for Access and development callers, which have none.
		 */
		authMode: resolveAuthMode(c.env),
		authMethod: c.var.authMethod ?? null,
		userId: authUser?.id ?? null,
		isOwner: authUser?.isOwner ?? false,
		totpEnabled: authUser?.totpEnabled ?? false,
	};

	if (!identity) {
		return c.json({
			...shared,
			email: null,
			name: "Local development",
			authenticated: false,
		});
	}

	if (identity.kind === "service") {
		return c.json({
			...shared,
			email: null,
			// Client IDs are opaque, but naming the caller beats inventing a person.
			name: identity.id,
			authenticated: true,
		});
	}

	return c.json({
		...shared,
		email: identity.id,
		// Built-in accounts carry a display name. Access supplies none, so derive
		// one from the local part rather than inventing a placeholder.
		name: authUser?.name || identity.id.split("@")[0] || identity.id,
		authenticated: true,
	});
});

// -- Access grants (admin) ------------------------------------------
//
// Who may open which mailbox. Admin-only, because a member who could edit grants
// could grant themselves everything.
//
// People and machines are granted separately but identically. A machine is an
// Access service token, identified by the Client ID that Access puts in the
// token's `common_name` claim.

/**
 * A mailbox in a grant.
 *
 * Accepts a bare address, which means unrestricted access and is what every
 * client sent before capabilities existed, or an object naming a role. Both
 * shapes are stored as-is, so an existing UI keeps working unchanged and a
 * capability-aware one can narrow per mailbox.
 */
const AccessMailboxEntry = z.union([
	z.string().email(),
	z.object({
		id: z.string().email(),
		role: z.enum(MAILBOX_ROLES),
		/** Capabilities added on top of the preset. */
		extra: z.array(z.enum(MAILBOX_CAPABILITIES)).max(MAILBOX_CAPABILITIES.length).optional(),
		/** Capabilities withheld from it. Applied last, so it wins. */
		revoked: z.array(z.enum(MAILBOX_CAPABILITIES)).max(MAILBOX_CAPABILITIES.length).optional(),
	}),
]);

const AccessGrantBody = z.object({
	id: z.string().min(1),
	kind: z.enum(["user", "service"]),
	role: z.enum(["admin", "member"]),
	mailboxes: z.array(AccessMailboxEntry).default([]),
	/** Optional note, so an opaque Client ID can be recognised later. */
	label: z.string().trim().max(80).optional(),
});

/**
 * The deployment-wide audit log: grants, and mailbox creation and deletion.
 *
 * Administrator-only, because these entries name principals and mailboxes across
 * the whole instance rather than one mailbox someone was granted.
 */
app.get("/api/v1/access/audit", requireAdmin, async (c) => {
	const limit = Number(c.req.query("limit")) || AUDIT_PAGE_SIZE;
	return c.json(
		await listAudit(c.env.BUCKET, { mailboxId: null, limit, filter: auditFilterFromQuery((n) => c.req.query(n)) }),
	);
});

/**
 * Delegation of a single mailbox, by whoever owns it.
 *
 * `PUT /api/v1/access` is instance-wide and admin-only, because a grant record is
 * keyed by *grantee* and lists every mailbox they can reach — so writing one
 * wholesale is authority over the whole deployment. That left the most ordinary
 * delegation there is impossible: the person whose mailbox it is could not give
 * their own assistant access to it without an administrator doing it for them.
 * Both products this vocabulary comes from let the owner do it themselves.
 *
 * These routes are scoped by construction rather than by checking. They read and
 * write exactly one entry of one grant — the mailbox in the path — so an owner
 * cannot touch another mailbox's entry even by asking, and `manageDelegates` is
 * held only by `owner`, mirroring Gmail's rule that a delegate cannot re-delegate.
 */

const MailboxDelegateBody = z.object({
	id: z.string().min(1),
	kind: z.enum(["user", "service"]).default("user"),
	role: z.enum(MAILBOX_ROLES),
	extra: z.array(z.enum(MAILBOX_CAPABILITIES)).max(MAILBOX_CAPABILITIES.length).optional(),
	revoked: z.array(z.enum(MAILBOX_CAPABILITIES)).max(MAILBOX_CAPABILITIES.length).optional(),
	label: z.string().trim().max(80).optional(),
});

/** Everyone who can reach this mailbox, and how far. */
app.get(
	"/api/v1/mailboxes/:mailboxId/delegates",
	requireCapability("manageDelegates"),
	async (c: AppContext) => {
		const mailboxId = normalizeAddress(c.req.param("mailboxId")!);
		const [users, services] = await Promise.all([
			listGrants(c.env.BUCKET, "user"),
			listGrants(c.env.BUCKET, "service"),
		]);

		// Only this mailbox's entry from each grant. Returning the whole grant would
		// tell an owner which *other* mailboxes their delegate can reach, which is
		// not theirs to know.
		const delegates = [...users, ...services].flatMap((grant) => {
			const entry = grant.access.find((candidate) => candidate.id === mailboxId);
			if (!entry) return [];
			return [
				{
					id: grant.id,
					kind: grant.kind,
					role: entry.role,
					...(entry.extra ? { extra: entry.extra } : {}),
					...(entry.revoked ? { revoked: entry.revoked } : {}),
					...(grant.label ? { label: grant.label } : {}),
					/** True when their reach here comes from being an instance admin. */
					viaAdminRole: grant.role === "admin",
				},
			];
		});

		return c.json({
			delegates,
			roles: MAILBOX_ROLES.map((role) => ({
				role,
				capabilities: ROLE_CAPABILITIES[role],
			})),
			fullAccessRole: FULL_ACCESS_ROLE,
			/**
			 * Instance administrators reach this mailbox without an entry, so an owner
			 * reading a short list is not being told the whole truth. Named so the UI
			 * can say who else can get in.
			 */
			configuredAdmins: parseAdminEmails(c.env.ADMIN_EMAILS),
			enforced: c.var.principal.enforced,
		});
	},
);

/**
 * Grant one principal access to this mailbox, or change how far it reaches.
 *
 * Merges into their existing grant rather than replacing it: a delegate may hold
 * other mailboxes from other owners, and this owner has no authority over those.
 */
app.put(
	"/api/v1/mailboxes/:mailboxId/delegates",
	requireCapability("manageDelegates"),
	async (c: AppContext) => {
		const mailboxId = normalizeAddress(c.req.param("mailboxId")!);
		const body = MailboxDelegateBody.parse(await c.req.json());
		const id = normalizeAddress(body.id);

		if (!isValidPrincipalId(body.kind, id)) {
			return c.json(
				{
					error:
						body.kind === "user"
							? "Enter the email address they sign in to Cloudflare Access with."
							: "Enter the service token Client ID from Cloudflare Access, e.g. 1a2b….access",
				},
				400,
			);
		}

		// Granting yourself changes nothing and reads as a mistake.
		if (c.var.principal.identity?.id === id && c.var.principal.identity.kind === body.kind) {
			return c.json({ error: "You already have access to this mailbox." }, 400);
		}

		const existing = await getGrant(c.env.BUCKET, body.kind, id);

		/**
		 * An instance administrator already reaches every mailbox, and their grant
		 * carries `role: "admin"`. Writing a mailbox entry for them would look like
		 * a demotion in the UI while changing nothing, so refuse and say why.
		 */
		if (existing?.role === "admin") {
			return c.json(
				{ error: `${id} is an administrator and already has full access.` },
				400,
			);
		}

		const entry = {
			id: mailboxId,
			role: body.role,
			...(body.extra?.length ? { extra: body.extra } : {}),
			...(body.revoked?.length ? { revoked: body.revoked } : {}),
		};

		const others = (existing?.access ?? []).filter((e) => e.id !== mailboxId);
		const saved = await putGrant(c.env.BUCKET, {
			id,
			kind: body.kind,
			// Never promote through this route: it is scoped to one mailbox, and
			// `member` is what a grant made here can be.
			role: "member",
			mailboxes: [] as string[],
			access: [...others, entry],
			...(body.label?.trim()
				? { label: body.label.trim() }
				: existing?.label
					? { label: existing.label }
					: {}),
		});

		await recordAuditDeferred(c, {
			action: "access.grant",
			actor: c.var.principal.identity?.id ?? null,
			actorRole: auditActorRole(c.var.principal, mailboxId),
			mailboxId,
			target: id,
			detail: { kind: body.kind, role: entry.role, scope: "mailbox" },
		});

		return c.json({
			id: saved.id,
			kind: saved.kind,
			role: entry.role,
			...(entry.extra ? { extra: entry.extra } : {}),
			...(entry.revoked ? { revoked: entry.revoked } : {}),
			...(saved.label ? { label: saved.label } : {}),
		});
	},
);

/**
 * Revoke one principal's access to this mailbox.
 *
 * Drops only this mailbox's entry. A grant left with no mailboxes is deleted
 * outright rather than kept as an empty record, so the access screen does not
 * accumulate rows that grant nothing.
 */
app.delete(
	"/api/v1/mailboxes/:mailboxId/delegates/:kind/:id",
	requireCapability("manageDelegates"),
	async (c: AppContext) => {
		const mailboxId = normalizeAddress(c.req.param("mailboxId")!);
		const kind = c.req.param("kind");
		if (kind !== "user" && kind !== "service") {
			return c.json({ error: "Unknown principal kind" }, 400);
		}
		const id = normalizeAddress(decodeURIComponent(c.req.param("id")!));

		const existing = await getGrant(c.env.BUCKET, kind, id);
		if (!existing) return c.json({ error: "No such delegate" }, 404);

		// An admin's reach comes from their role, not from an entry here, so
		// removing one would silently do nothing.
		if (existing.role === "admin") {
			return c.json(
				{
					error: `${id} is an administrator. Their access is managed in Settings → Access.`,
				},
				400,
			);
		}

		const remaining = existing.access.filter((e) => e.id !== mailboxId);
		if (remaining.length === existing.access.length) {
			return c.json({ error: "No such delegate" }, 404);
		}

		if (remaining.length === 0) {
			await deleteGrant(c.env.BUCKET, kind, id);
		} else {
			await putGrant(c.env.BUCKET, {
				id,
				kind,
				role: "member",
				mailboxes: [] as string[],
				access: remaining,
				...(existing.label ? { label: existing.label } : {}),
			});
		}

		await recordAuditDeferred(c, {
			action: "access.revoke",
			actor: c.var.principal.identity?.id ?? null,
			actorRole: auditActorRole(c.var.principal, mailboxId),
			mailboxId,
			target: id,
			detail: { kind, scope: "mailbox" },
		});

		return c.body(null, 204);
	},
);

app.get("/api/v1/access", requireAdmin, async (c) => {
	const [users, services] = await Promise.all([
		listGrants(c.env.BUCKET, "user"),
		listGrants(c.env.BUCKET, "service"),
	]);

	return c.json({
		users,
		services,
		/**
		 * The configured administrators, echoed so the admin screen can show that
		 * they cannot be edited here — they come from `ADMIN_EMAILS`, and a grant
		 * record cannot demote them.
		 */
		configuredAdmins: parseAdminEmails(c.env.ADMIN_EMAILS),
		/**
		 * The role vocabulary this Worker actually enforces.
		 *
		 * Served rather than bundled into the client so the access screen offers
		 * exactly the presets the server understands. A client shipped against a
		 * newer list would otherwise render a role that gets rejected on save, and
		 * one shipped against an older list would hide a role that works.
		 */
		roles: MAILBOX_ROLES.map((role) => ({
			role,
			capabilities: ROLE_CAPABILITIES[role],
		})),
		capabilities: MAILBOX_CAPABILITIES,
		/** The role a bare mailbox entry means, for labelling existing grants. */
		fullAccessRole: FULL_ACCESS_ROLE,
		enforced: c.var.principal.enforced,
	});
});

app.put("/api/v1/access", requireAdmin, async (c) => {
	const body = AccessGrantBody.parse(await c.req.json());
	const id = normalizeAddress(body.id);

	if (!isValidPrincipalId(body.kind, id)) {
		return c.json(
			{
				error:
					body.kind === "user"
						? "Enter the email address they sign in to Cloudflare Access with."
						: "Enter the service token Client ID from Cloudflare Access, e.g. 1a2b….access",
			},
			400,
		);
	}

	// Only grant mailboxes that exist, so a typo becomes an error now rather than
	// an inexplicably empty sidebar later. Entries are a mix of bare addresses and
	// objects, so the id has to be read out of either shape before comparing.
	const requested = body.mailboxes.map((entry) =>
		typeof entry === "string" ? normalizeAddress(entry) : normalizeAddress(entry.id),
	);
	const existing = new Set(
		(await listMailboxes(c.env.BUCKET)).map((m) => normalizeAddress(m.email)),
	);
	const unknown = requested.filter((m) => !existing.has(m));
	if (unknown.length > 0) {
		return c.json({ error: `No such mailbox: ${unknown.join(", ")}` }, 400);
	}

	// One mailbox named twice would resolve to whichever entry came first, which
	// is a silent surprise rather than the error the operator wants.
	const duplicates = requested.filter((m, i) => requested.indexOf(m) !== i);
	if (duplicates.length > 0) {
		return c.json(
			{ error: `Mailbox listed more than once: ${[...new Set(duplicates)].join(", ")}` },
			400,
		);
	}

	const saved = await putGrant(c.env.BUCKET, {
		id,
		kind: body.kind,
		role: body.role as Role,
		// `putGrant` normalizes either shape into capability entries.
		mailboxes: body.mailboxes as unknown as string[],
		...(body.label ? { label: body.label } : {}),
	});

	/**
	 * Recorded because a grant change is the one action that changes what every
	 * later entry means. Deferred so the operator is not waiting on the log, and
	 * summarised rather than dumped: the roles are what an auditor scans for.
	 */
	await recordAuditDeferred(c, {
		action: "access.grant",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		target: id,
		detail: {
			kind: saved.kind,
			role: saved.role,
			mailboxes:
				saved.access.map((entry) => `${entry.id}:${entry.role}`).join(", ") || "none",
		},
	});

	return c.json(saved);
});

app.delete("/api/v1/access/:kind/:id", requireAdmin, async (c) => {
	const kind = c.req.param("kind");
	if (kind !== "user" && kind !== "service") {
		return c.json({ error: "Unknown principal kind" }, 400);
	}
	const id = normalizeAddress(decodeURIComponent(c.req.param("id")!));

	/**
	 * Removing a grant revokes access, so removing your own is a way to lock
	 * yourself out. Configured admins survive it (their authority is in
	 * `ADMIN_EMAILS`), which is exactly who this guard is not aimed at.
	 */
	const self = c.var.principal.identity;
	if (
		self &&
		self.kind === kind &&
		self.id === id &&
		!parseAdminEmails(c.env.ADMIN_EMAILS).includes(id)
	) {
		return c.json(
			{ error: "Refusing to remove your own access. Ask another administrator." },
			400,
		);
	}

	await deleteGrant(c.env.BUCKET, kind, id);
	await recordAuditDeferred(c, {
		action: "access.revoke",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		target: id,
		detail: { kind },
	});
	return c.body(null, 204);
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const requestedDomain = c.req.query("domain");
	const allMailboxes = await listMailboxes(c.env.BUCKET);

	// The bucket is shared across domains, so every mailbox is annotated with the
	// domain it belongs to and callers can narrow to a single zone.
	const annotated = allMailboxes.map((m) => ({
		...m,
		name: m.id,
		domain: domainOfAddress(m.email),
	}));

	// Hide mailboxes on domains this deployment no longer serves. Their settings
	// may still sit in the bucket from a previous deployment, but opening one
	// would show an empty inbox because no mail can route to it.
	const servedByDomain = annotated.filter((m) => isDomainAllowed(c.env, m.domain));

	/**
	 * Then hide the ones this caller has no grant for.
	 *
	 * Filtering the list matters as much as refusing the requests: this endpoint
	 * feeds the sidebar and the mailbox chooser, and a member who can see an
	 * address they cannot open only learns that by clicking it and getting a 403.
	 */
	const served = visibleMailboxes(c.var.principal, servedByDomain, (m) => m.email);

	const scopedDomain = requestedDomain
		? domainOfAddress(`x@${requestedDomain}`) || requestedDomain.toLowerCase()
		: null;
	const scoped = scopedDomain
		? served.filter((m) => m.domain === scopedDomain)
		: served;

	// Settings live in a separate R2 object per mailbox, so including them costs
	// one GET each. Opt-in via `?include=settings` so the common callers that only
	// need addresses (the sidebar, the person view) keep paying for a single list
	// call, while a settings screen avoids N round trips from the browser. A
	// mailbox whose settings fail to load is returned without them rather than
	// failing the whole list.
	if (c.req.query("include") !== "settings") return c.json(scoped);

	const withSettings = await Promise.all(
		scoped.map(async (m) => {
			try {
				const obj = await c.env.BUCKET.get(`mailboxes/${m.id}.json`);
				if (!obj) return m;
				// Resolved, not raw. The settings screen and the auto-draft toggle
				// both spread this object straight back into a PUT, and the update
				// route is now strict — echoing back an unknown key a legacy blob
				// happened to carry would fail the save. Parsing on read strips it
				// once, so the client can only ever send keys the schema knows.
				return {
					...m,
					settings: parseStoredMailboxSettings(await obj.json(), (problem) =>
						console.warn(
							`Settings for mailbox ${m.id} needed repair: ${problem}`,
						),
					),
				};
			} catch (e) {
				console.error(
					`Failed to read settings for mailbox ${m.id}:`,
					(e as Error).message,
				);
				return m;
			}
		}),
	);

	return c.json(withSettings);
});

/**
 * Sent-analytics across every mailbox the caller may see.
 *
 * A dedicated account-level endpoint rather than a per-mailbox one because the
 * panel's whole point is the roll-up: "across the mailboxes I have access to,
 * what's my delivery and engagement". It resolves the caller's visible
 * mailboxes exactly as the sidebar does (`visibleMailboxes` + the same
 * domain-served filter), then asks each mailbox's Durable Object for its own
 * aggregate over the window and sums them. Per-mailbox rows are returned
 * alongside the total so the panel can break it down.
 *
 * The window is `?days=` (default 30, clamped 1..90 to match the 31-day CF
 * retention plus headroom). Read-only; one DO round trip per visible mailbox,
 * run in parallel, with a mailbox that errors contributing zeroes rather than
 * failing the whole panel.
 */
app.get("/api/v1/analytics/sent", async (c) => {
	const days = Math.min(
		90,
		Math.max(1, Number.parseInt(c.req.query("days") ?? "30", 10) || 30),
	);
	const end = new Date();
	const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
	const window = { start: start.toISOString(), end: end.toISOString() };

	const allMailboxes = await listMailboxes(c.env.BUCKET);
	const served = allMailboxes.filter((m) =>
		isDomainAllowed(c.env, domainOfAddress(m.email)),
	);
	const visible = visibleMailboxes(c.var.principal, served, (m) => m.email);

	const perMailbox = await Promise.all(
		visible.map(async (m) => {
			try {
				const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(m.id));
				const stats = await stub.getSentAnalytics(window);
				return { mailboxId: m.id, ...stats };
			} catch (e) {
				console.error(
					`Sent analytics failed for ${m.id}:`,
					(e as Error).message,
				);
				return {
					mailboxId: m.id,
					sent: 0,
					delivered: 0,
					failed: 0,
					opened: 0,
					clicked: 0,
					failedInternal: 0,
					failedRecipient: 0,
				};
			}
		}),
	);

	const total = perMailbox.reduce(
		(acc, m) => ({
			sent: acc.sent + m.sent,
			delivered: acc.delivered + m.delivered,
			failed: acc.failed + m.failed,
			opened: acc.opened + m.opened,
			clicked: acc.clicked + m.clicked,
			failedInternal: acc.failedInternal + m.failedInternal,
			failedRecipient: acc.failedRecipient + m.failedRecipient,
		}),
		{
			sent: 0,
			delivered: 0,
			failed: 0,
			opened: 0,
			clicked: 0,
			failedInternal: 0,
			failedRecipient: 0,
		},
	);

	return c.json({ window: { days, ...window }, total, mailboxes: perMailbox });
});

app.post("/api/v1/mailboxes", requireAdmin, async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	// Reject domains this deployment does not serve. Creating such a mailbox would
	// produce a Durable Object that no inbound route can ever reach.
	if (!isDomainAllowed(c.env, domainOfAddress(email))) {
		return c.json(
			{
				error: `Domain not served by this deployment. Configured domains: ${
					getZones(c.env).map((z) => z.domain).join(", ") || "(none)"
				}`,
			},
			400,
		);
	}
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists" }, 409);
	// An alias owner can send as the address; a mailbox here would inherit that.
	const aliasOwner = await aliasOwnerOf(c.env, email);
	if (aliasOwner) {
		return c.json(
			{ error: `${email} is an alias of ${aliasOwner}. Remove the alias from that mailbox first.` },
			409,
		);
	}
	// The request body is a patch over the defaults rather than the whole blob, so
	// a create that sends only `fromName` still persists every key and no reader
	// has to decide what an absent `autoDraft` means.
	const finalSettings = mergeMailboxSettings(
		defaultMailboxSettings(name),
		settings ?? {},
	);
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();
	// New mailboxes follow the deployment's tracking default (chosen at setup,
	// editable under Settings > Privacy). Existing mailboxes are never touched.
	if (!(await getPrivacySettings(c.env.BUCKET)).trackingDefault) {
		await stub.updateTrackingSettings({ openTracking: false, clickTracking: false, attachmentTracking: false });
	}

	await recordAuditDeferred(c, {
		action: "mailbox.create",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		mailboxId: email,
	});

	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	return c.json({
		id: mailboxId,
		name: mailboxId,
		email: mailboxId,
		settings: parseStoredMailboxSettings(await obj.json(), (problem) =>
			console.warn(
				`Settings for mailbox ${mailboxId} needed repair: ${problem}`,
			),
		),
	});
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	// Throws a ZodError for an unknown or malformed key; `app.onError` turns that
	// into a 400 naming the offending field, the shape every other route uses.
	const { settings } = UpdateMailboxBody.parse(await c.req.json());
	/**
	 * The agent send policy (mode and allowlist) is what holds API-token and
	 * OAuth sends for approval, so only a person in the app may change it: a
	 * token with `mailboxes:manage` setting `auto` or allowlisting an address
	 * would release its own sends.
	 */
	if (settings && "agentSend" in settings && settings.agentSend !== undefined) {
		const method = c.var.authMethod ?? c.var.principal.credential?.method;
		if (method === "token" || method === "oauth") {
			return c.json(
				{
					error: "The agent send policy can only be changed by a signed-in person in the app, not with an API token or connected app.",
					code: "person_required",
				},
				403,
			);
		}
	}
	const key = `mailboxes/${mailboxId}.json`;
	// A GET rather than the old HEAD: the merge below needs the current value,
	// and this is still the existence check.
	const existing = await c.env.BUCKET.get(key);
	if (!existing) return c.json({ error: "Not found" }, 404);

	// Merge rather than replace. Storing the body verbatim forced every client to
	// resend the entire blob to avoid destroying fields it did not touch — the
	// inbox row's auto-draft switch and the settings screen each spread a
	// snapshot for exactly that reason — and two concurrent saves each reverted
	// the other's change. Patching server-side makes a partial update safe.
	const merged = mergeMailboxSettings(
		parseStoredMailboxSettings(await existing.json(), (problem) =>
			console.warn(
				`Settings for mailbox ${mailboxId} needed repair: ${problem}`,
			),
		),
		settings,
	);
	await c.env.BUCKET.put(key, JSON.stringify(merged));

	/**
	 * The highest-value write in the app: this body can carry `forwarding.email`,
	 * so whoever writes it can redirect every message the mailbox receives.
	 * Whether forwarding is now on is recorded because that is the change an
	 * auditor scans for; the address itself is not, since the log is readable by
	 * whoever manages the mailbox and should not become a copy of its config.
	 */
	await recordAuditDeferred(c, {
		action: "mailbox.settings",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, mailboxId),
		mailboxId,
		detail: { forwardingEnabled: merged.forwarding?.enabled === true },
	});

	return c.json({
		id: mailboxId,
		name: mailboxId,
		email: mailboxId,
		settings: merged,
	});
});

/**
 * R2 accepts at most 1000 keys per bulk delete call.
 */
const R2_DELETE_BATCH_SIZE = 1000;

/**
 * Drop attachment blobs for rows that are already gone.
 *
 * Failures are logged, not thrown: the rows have been deleted, so the user's
 * action succeeded, and reporting an error here would invite a retry that has
 * nothing left to delete. A leaked blob is the cheaper outcome.
 */
async function deleteAttachmentBlobs(
	bucket: R2Bucket,
	keys: string[],
): Promise<void> {
	for (let i = 0; i < keys.length; i += R2_DELETE_BATCH_SIZE) {
		await bucket
			.delete(keys.slice(i, i + R2_DELETE_BATCH_SIZE))
			.catch((e) =>
				console.error("attachment cleanup failed:", (e as Error).message),
			);
	}
}

/**
 * Destroying a mailbox is administrator-only.
 *
 * `requireMailbox` has already established that the caller may *use* this
 * mailbox. Deleting it also purges its Durable Object, its agent chat history
 * and its attachment blobs, which is not a thing to hand to everyone who was
 * granted the inbox to answer mail in.
 */
app.delete("/api/v1/mailboxes/:mailboxId", requireAdmin, async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);

	// Durable Object, routing, attachments, agent history, grants, then the
	// settings object last. See ./lib/mailbox-purge.ts.
	await purgeMailbox(c.env, mailboxId);
	// An agent inbox deleted as a plain mailbox: end its token and webhook too.
	c.executionCtx.waitUntil(forgetAgentInboxForMailbox(c.env, mailboxId));

	/**
	 * Record the deletion, then destroy the mailbox's own log.
	 *
	 * Order matters: the entry goes to the instance scope, which survives, while
	 * the per-mailbox entries are removed so a re-created address does not inherit
	 * activity that never happened in it. The deletion therefore stays answerable
	 * without the history it deleted being attributed to its successor.
	 */
	await recordAudit(c.env.BUCKET, {
		action: "mailbox.delete",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		mailboxId: null,
		target: mailboxId,
	});

	c.executionCtx.waitUntil(purgeMailboxAuditLog(c.env.BUCKET, mailboxId));

	return c.body(null, 204);
});

// -- People (cross-mailbox) -----------------------------------------

/** Default page size for the person list; mirrors the frontend's default. */
const PEOPLE_PAGE_SIZE = 40;

/**
 * Mailbox addresses this deployment actually serves.
 *
 * The bucket outlives configuration changes, so it can hold settings for
 * domains we no longer route. Those mailboxes can never receive mail, and
 * including them in the person view would contribute nothing but latency.
 */
async function servedMailboxAddresses(env: Env): Promise<string[]> {
	const all = await listMailboxes(env.BUCKET);
	return all
		.map((m) => m.email)
		.filter((email) => isDomainAllowed(env, domainOfAddress(email)));
}

/**
 * The mailboxes a person view may aggregate for this caller.
 *
 * The person screens are cross-mailbox by design, which makes them the one place
 * where a per-mailbox grant could be bypassed wholesale: fanning out to every
 * served address would hand a member the contents of inboxes they were never
 * given. Narrowing the fan-out is also cheaper than filtering afterwards,
 * because the messages are never fetched at all.
 */
async function permittedMailboxAddresses(
	c: AppContext,
): Promise<string[]> {
	const served = await servedMailboxAddresses(c.env);
	return visibleMailboxes(c.var.principal, served, (address) => address);
}

/**
 * Person-centric inbox: one row per correspondent, aggregated across every
 * mailbox we serve.
 *
 * Fans out to each MailboxDO, then merges, filters, sorts and paginates in the
 * Worker (see `shared/people.ts`). Merging has to happen after aggregation
 * because a person who wrote to two of our addresses is one row here but two
 * rows across the DOs.
 *
 * A single unreachable mailbox degrades its own contribution rather than
 * failing the request — a partial inbox is far more useful than an error page.
 */
app.get("/api/v1/people", async (c) => {
	const folder = c.req.query("folder") || Folders.INBOX;
	const page = Number(c.req.query("page")) || 1;
	const pageSize = Number(c.req.query("pageSize")) || PEOPLE_PAGE_SIZE;

	const addresses = await permittedMailboxAddresses(c);

	const settled = await Promise.allSettled(
		addresses.map(async (address) => {
			const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(address));
			const people = (await (
				stub as unknown as {
					getPeople: (o: { folder: string }) => Promise<MailboxPersonRow[]>;
				}
			).getPeople({ folder })) as MailboxPersonRow[];
			return { mailbox: address, people };
		}),
	);

	const perMailbox: { mailbox: string; people: MailboxPersonRow[] }[] = [];
	const failed: string[] = [];

	settled.forEach((result, i) => {
		if (result.status === "fulfilled") {
			perMailbox.push(result.value);
		} else {
			failed.push(addresses[i]);
			console.error(
				`Failed to aggregate people for ${addresses[i]}:`,
				(result.reason as Error)?.message,
			);
		}
	});

	const filtered = filterPeople(mergePeople(perMailbox), {
		search: c.req.query("search"),
		unread: boolQuery(c, "unread"),
		hasAttachment: boolQuery(c, "hasAttachment"),
		recipient: c.req.query("recipient"),
	});

	const sorted = sortPeople(filtered, {
		key: (c.req.query("sortKey") as PeopleSortKey) || "recency",
		direction: (c.req.query("sortDirection") as SortDirection) || "desc",
	});

	const result = paginate(sorted, page, pageSize);

	return c.json({
		people: result.items,
		total: result.total,
		page: result.page,
		pageSize: result.pageSize,
		/** Mailboxes that failed to respond, so the UI can say so. */
		degraded: failed,
	});
});

/**
 * One person's full correspondence, newest first, across every mailbox.
 *
 * Bodies are truncated to a snippet here; the UI expands a message into its
 * full conversation through the existing thread endpoint.
 */
app.get("/api/v1/people/:person/emails", async (c) => {
	const person = decodeURIComponent(c.req.param("person")!).trim().toLowerCase();
	if (!person) return c.json({ error: "Person address is required" }, 400);

	const limit = Number(c.req.query("limit")) || 100;
	const addresses = await permittedMailboxAddresses(c);

	type PersonEmailRow = Record<string, unknown> & { mailboxId: string };

	const settled = await Promise.allSettled(
		addresses.map(async (address): Promise<PersonEmailRow[]> => {
			const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(address));
			const emails = await (
				stub as unknown as {
					getPersonEmails: (o: {
						person: string;
						limit: number;
					}) => Promise<Record<string, unknown>[]>;
				}
			).getPersonEmails({ person, limit });
			// Tag each row so the UI knows which mailbox to query for the thread.
			return emails.map((e) => ({ ...e, mailboxId: address }));
		}),
	);

	const emails = settled
		.flatMap((r) => (r.status === "fulfilled" ? r.value : []))
		.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
		.slice(0, limit);

	return c.json({ emails, total: emails.length });
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = normalizeSortDirection(c.req.query("sortDirection"));
	const stub = c.var.mailboxStub;

	// Opt-in narrowing flags. `boolQuery` returns undefined when absent, which
	// the DO reads as "don't filter" — see ListFilterOptions.
	const filters = {
		unread: boolQuery(c, "unread"),
		starred: boolQuery(c, "starred"),
		has_attachment: boolQuery(c, "has_attachment"),
	};

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({
			folder, page, limit, sortColumn, sortDirection, ...filters,
		});
		// The count has to carry the same filters or the pager offers pages the
		// filtered query cannot fill.
		const totalCount = await (stub as any).countThreadedEmails(folder, filters);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({
		folder, thread_id, page, limit, sortColumn, sortDirection, ...filters,
	});
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id, ...filters });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	let { to, cc, bcc, html, text } = body;
	const { from, subject, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(
			to,
			from,
			mailboxId,
			await senderAddressesFor(c.env, mailboxId),
		));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	// Bulk mail: drop suppressed recipients, refuse when the domain's bulk
	// sending is paused, add the unsubscribe link and List-Id. Transactional
	// (the default) goes through the same gate with transactional semantics:
	// hard bounces and complaints block, unsubscribes only warn. See
	// ./lib/pre-send.ts and ./lib/send-compliance.ts.
	const bulk = body.transactional === false || body.list === true;
	let complianceHeaders: Record<string, string> = {};
	let suppressedRecipients: { address: string; reason: string; scope: string }[] = [];
	let suppressionWarnings: { address: string; reason: string; scope: string }[] = [];
	if (bulk) {
		const compliance = await applySendCompliance(c.env, {
			to, cc, bcc, fromEmail, html, text, requestUrl: c.req.url,
		});
		if (!compliance.ok) {
			return c.json(
				{ error: "Every recipient is on the suppression list", code: "all_suppressed", suppressed: compliance.suppressed },
				422,
			);
		}
		to = compliance.to;
		cc = compliance.cc.length ? compliance.cc : undefined;
		bcc = compliance.bcc.length ? compliance.bcc : undefined;
		({ html, text } = compliance);
		complianceHeaders = compliance.headers;
		suppressedRecipients = compliance.suppressed;
		toStr = compliance.to.join(", ").toLowerCase();
	}

	/**
	 * Whose name this leaves under.
	 *
	 * The path gate established that the caller may send at all; this decides
	 * how. `sendAs` yields no `Sender:` header, so the message is
	 * indistinguishable from one the mailbox owner sent. `sendOnBehalf` names the
	 * actual sender, which is what makes a shared-inbox reply attributable.
	 *
	 * `null` cannot normally reach here — the gate refuses first — but a grant
	 * holding `sendOnBehalf` with no resolvable identity would produce it, and
	 * falling back to an unattributed send is precisely the hole the split
	 * exists to close.
	 */
	const attribution = sendAttributionFor(c.var.principal, mailboxId);
	if (!attribution) {
		return c.json(
			{ error: "You do not have permission to send from this mailbox" },
			403,
		);
	}
	const onBehalfOf = attribution.mode === "onBehalfOf" ? attribution.sender : null;
	// Email Service's per-message limits (50 recipients, 32 attachments, 5 MiB,
	// header allowlist), checked before anything is stored or sent.
	const outgoingHeaders = {
		...buildOutgoingHeaders({
			inReplyTo: in_reply_to,
			references: references || [],
		}),
		// The unsubscribe pair for bulk sends, validated with everything else.
		...complianceHeaders,
	};
	const stub = c.var.mailboxStub;
	// The shared pre-send gate: provider limits, the mailbox's caps, the bulk
	// circuit breaker and suppressions. Nothing is stored before it passes.
	const gate = await preSend(
		c.env,
		{
			kind: bulk ? "bulk" : "transactional",
			from: fromEmail,
			mailboxId,
			to, cc, bcc, html, text, attachments,
			headers: outgoingHeaders,
			actor: requestActor(c),
			// What an API token or OAuth grant gets held with: this exact message,
			// so approving sends what the reviewer saw (`workers/lib/held-send.ts`).
			hold: {
				action: "send_email",
				subject,
				payload: {
					composed: [
						{
							kind: bulk ? "bulk" : "transactional",
							to: listOf(to),
							cc: listOf(cc),
							bcc: listOf(bcc),
							from,
							subject,
							html,
							text,
							headers: outgoingHeaders,
							rawAttachments: attachments,
							row: {
								threadId: thread_id || in_reply_to || null,
								inReplyTo: in_reply_to || null,
								references: references || [],
								rawHeaders: null,
							},
							trackingBaseUrl: trackingBaseUrlFromRequest(c.req.url),
						},
					],
				} satisfies HoldPayload,
			},
		},
		{ quota: () => stub as unknown as QuotaStub },
	);
	if (!gate.ok) return c.json(...httpRefusal(gate));
	if (!bulk) {
		// Transactional: a hard bounce or complaint removed that recipient.
		to = gate.to;
		cc = gate.cc.length ? gate.cc : undefined;
		bcc = gate.bcc.length ? gate.bcc : undefined;
		toStr = gate.to.join(", ").toLowerCase();
		suppressedRecipients = gate.suppressed;
		suppressionWarnings = gate.warnings;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		// Handed to the provider below, inside `waitUntil`; `recordDelivery`
		// moves it to `sent` (with the provider's id) or `failed`.
		delivery_status: "queued",
		// NO `message-id` entry: the provider assigns the real one and
		// `recordDelivery` writes it to the `message_id` COLUMN once the send
		// returns. A stale entry here would win over that column in the `.eml` and
		// mbox exporters (both prefer a stored header and skip a key already
		// present), so a downloaded message would carry an id that was never sent.
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
		]),
	}, attachmentData);

	/**
	 * Instrument the OUTGOING copy for open/click tracking, per the mailbox's
	 * settings. The stored Sent copy above keeps the original untouched HTML —
	 * only the recipient's copy carries the pixel and wrapped links. Tokens carry
	 * the local `messageId`; attribution is per-recipient only for a
	 * single-recipient send; the size is re-checked and tracking dropped if it
	 * would push the message over the limit. See ./lib/tracking-send.ts.
	 */
	const outgoingHtml = await trackOutgoingHtml({
		stub,
		mailboxId,
		emailId: messageId,
		html,
		baseUrl: trackingBaseUrlFromRequest(c.req.url),
		to: toStr,
		cc,
		bcc,
		text,
		attachments,
		track: body.track,
		optOuts: trackingOptOutStore(c.env),
		fromAddress: fromEmail,
	});

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to, cc, bcc, from, subject, html: outgoingHtml, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			// Threading only. `Message-ID` and `Sender` are NOT sent: Email Service
			// rejects both (the first is platform-generated, the second is not
			// allowlisted) and a rejected header fails the entire message — which is
			// exactly how every outgoing email silently stopped being delivered.
			headers: outgoingHeaders,
		}, gate.clearance)
			// Record the outcome on the row instead of only logging it. The 202 above
			// is sent before delivery is attempted, so without this a hard rejection
			// leaves a message sitting in Sent looking delivered — the failure mode
			// that hid this bug for the entire life of the fork.
			.then(async (result) => {
				await recordDelivery(stub, messageId, { providerMessageId: result.messageId });
			})
			.catch(async (e) => {
				console.error("Deferred email delivery failed:", (e as Error).message);
				await recordDelivery(stub, messageId, { thrown: e });
				await noteProviderSuppression(c.env, [toStr, ...[cc, bcc].flat()].join(",").split(","), e);
			}),
	);

	/**
	 * A delegated send is the case this log exists for: `From:` carries the
	 * mailbox's own address, so without an entry here there is no record of who
	 * actually sent it. `attribution` answers that — `as` leaves no trace in the
	 * message itself, which is exactly why it is worth recording.
	 *
	 * Recipients are counted rather than listed, and the subject is omitted: a log
	 * that quoted mail would be a second copy of the mailbox.
	 */
	await recordAuditDeferred(c, {
		action: "mail.send",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, mailboxId),
		mailboxId,
		detail: {
			attribution: attribution.mode === "as" ? "as" : "onBehalfOf",
			recipients: toStr.split(",").length,
		},
	});

	return c.json(
		{
			id: messageId,
			status: "sent",
			...(bulk || suppressedRecipients.length ? { suppressed: suppressedRecipients } : {}),
			// Transactional only: suppressed for bulk mail, but delivered anyway.
			...(suppressionWarnings.length ? { suppression_warnings: suppressionWarnings } : {}),
		},
		202,
	);
});

/**
 * Save a draft.
 *
 * Updates in place when `draft_id` names an existing draft, and creates one
 * otherwise. It used to delete the old row and insert a replacement on every
 * save, which minted a new id each time, orphaned that row's attachments, and
 * briefly left the draft existing nowhere; the composer then had to chase the
 * moving id to avoid filling Drafts with near-identical copies.
 */
app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const {
		to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id,
		attachments, replace_attachments,
	} = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;

	// A draft counts against the same per-message ceiling as a send: accepting
	// something here that could never be sent just defers the failure to the
	// moment the user presses Send.
	if (replace_attachments) {
		try {
			assertMessageWithinSizeLimit({ html: body, attachments });
		} catch (e) {
			if (e instanceof MessageTooLargeError) return c.json({ error: e.message }, 413);
			throw e;
		}
	}

	const now = new Date().toISOString();
	const fields = {
		subject: subject || "",
		recipient: (to || "").toLowerCase(),
		cc: cc?.toLowerCase() || null,
		bcc: bcc?.toLowerCase() || null,
		body,
		date: now,
		in_reply_to: in_reply_to || null,
	};

	// Reuse the row when it is still there. `updateDraft` returns false for an
	// unknown id or a non-draft, so a draft deleted in another tab falls through
	// to a fresh create rather than failing the save.
	const updated = draft_id
		? await (stub as any).updateDraft(draft_id, {
				...fields,
				thread_id: thread_id || in_reply_to || draft_id,
			})
		: false;

	const draftId = updated ? draft_id! : crypto.randomUUID();

	if (!updated) {
		await stub.createEmail(Folders.DRAFT, {
			...fields,
			id: draftId,
			sender: mailboxId.toLowerCase(),
			email_references: null,
			thread_id: thread_id || in_reply_to || draftId,
		}, []);
	}

	if (replace_attachments) {
		const stored = await storeAttachments(c.env.BUCKET, draftId, attachments);
		const staleKeys = await (stub as any).replaceAttachments(draftId, stored);
		// Best-effort blob cleanup. The rows are already gone, so a failure here
		// leaks bytes rather than showing the user a stale attachment.
		if (staleKeys.length > 0) {
			c.executionCtx.waitUntil(
				Promise.all(
					staleKeys.map((key: string) =>
						c.env.BUCKET.delete(key).catch((e: unknown) =>
							console.error("Failed to delete replaced draft attachment:", key, e),
						),
					),
				),
			);
		}
	}

	return c.json(
		{
			id: draftId,
			status: "draft",
			subject: subject || "",
			recipient: to || "",
			date: now,
		},
		updated ? 200 : 201,
	);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	const [secured] = await withMessageSecurity(c.env, [email]);
	return new Response(JSON.stringify(secured), {
		headers: { "Content-Type": "application/json" },
	});
});

/**
 * The delivery timeline for one message: every ledger event, oldest first.
 *
 * A separate endpoint rather than folding the events into `getEmail` because the
 * reading pane loads the message body eagerly and the timeline lazily — most
 * messages are read without anyone expanding "delivery details", and inbound
 * mail has no timeline at all. Gated by the same `requireMailbox` as every other
 * route under this path, so it is only reachable for a mailbox the caller may
 * see.
 */
app.get(
	"/api/v1/mailboxes/:mailboxId/emails/:id/delivery-events",
	async (c: AppContext) => {
		const id = c.req.param("id")!;

		/**
		 * The message has to still exist.
		 *
		 * `delivery_events` deliberately has no foreign key — a late bounce or a
		 * click can arrive after a message is gone, and losing the event would
		 * recreate the blindness this feature fixes — so the ledger outlives a
		 * permanent delete or an Empty Trash. Without this check anyone holding an
		 * old message id could still read its recipients, error detail, provider id
		 * and engagement metadata after `/emails/:id` had begun answering 404.
		 *
		 * Gating on the message rather than pruning the ledger keeps the audit
		 * trail intact while making it unreachable, which is the behaviour the
		 * ledger's own no-foreign-key reasoning asks for.
		 */
		const email = await c.var.mailboxStub.getEmail(id);
		if (!email) return c.json({ error: "Email not found" }, 404);

		const events = await c.var.mailboxStub.getDeliveryEvents(id);
		return c.json({ events });
	},
);

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

/**
 * Delete a message.
 *
 * Two-stage, like every mail client: this bins the message and answers
 * `{ status: "trashed" }`, and only destroys it when it is already in Trash or
 * Spam. `?permanent=1` skips the bin, which is what a draft superseded by the
 * copy just queued for sending needs — routing that through Trash would leave
 * a duplicate of everything ever sent sitting in the bin.
 *
 * Still 204 on a destroy so existing callers that ignore the body are
 * unaffected.
 */
app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const permanent = c.req.query("permanent") === "1";

	// The path gate only established `delete`, which is the recoverable kind.
	// Skipping the bin destroys the message outright, so it needs the stronger
	// capability — checked here because it is a query parameter, not a path.
	if (permanent && !canDo(c.var.principal, c.req.param("mailboxId")!, "deletePermanently")) {
		return c.json(
			{
				error:
					"You do not have permission to do this in this mailbox (deletePermanently)",
				capability: "deletePermanently",
			},
			403,
		);
	}

	const outcome = await c.var.mailboxStub.deleteEmail(id, { permanent });
	if (outcome === null) return c.json({ error: "Not found" }, 404);

	await deleteAttachmentBlobs(c.env.BUCKET, outcome.attachmentKeys);

	/**
	 * Binning and destroying are recorded as different actions, because only one is
	 * recoverable. `mail.delete` is the trail for "where did that go";
	 * `mail.destroy` is the trail for "that is gone and nobody can get it back".
	 */
	await recordAuditDeferred(c, {
		action: outcome.trashed > 0 ? "mail.delete" : "mail.destroy",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, c.req.param("mailboxId")!),
		mailboxId: c.req.param("mailboxId")!,
		detail: { messages: 1 },
	});

	return outcome.trashed > 0 ? c.json({ status: "trashed" }) : c.body(null, 204);
});

/**
 * Put a binned message back where it came from.
 *
 * 404 when the message is not in Trash, so an Undo pressed after the bin was
 * emptied says so rather than silently doing nothing.
 */
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/restore", async (c: AppContext) => {
	const restored = await c.var.mailboxStub.restoreEmails([c.req.param("id")!]);
	return restored > 0
		? c.json({ status: "restored" })
		: c.json({ error: "Not in Trash" }, 404);
});

/** Destroy everything in Trash. Not reversible, and the UI confirms first. */
app.post("/api/v1/mailboxes/:mailboxId/trash/empty", async (c: AppContext) => {
	const { deleted, attachmentKeys } = await c.var.mailboxStub.emptyTrash();
	await deleteAttachmentBlobs(c.env.BUCKET, attachmentKeys);

	// Irreversible and unbounded in size, so the count is the interesting part.
	await recordAuditDeferred(c, {
		action: "mail.destroy",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, c.req.param("mailboxId")!),
		mailboxId: c.req.param("mailboxId")!,
		detail: { messages: deleted, scope: "trash" },
	});

	return c.json({ deleted });
});

/**
 * File a message into a folder.
 *
 * Drafts and Scheduled are refused with a distinct message, because "Folder not
 * found" would be a lie about a folder that plainly exists — see `canMoveInto`
 * for why membership of those two cannot be granted by a move.
 */
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };

	if (!canMoveInto(folderId)) {
		return c.json({ error: `Messages cannot be moved into ${folderId}` }, 400);
	}

	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

/**
 * The messages of one conversation.
 *
 * `?folder=` is the view asking, and it narrows the answer: in Trash or Spam a
 * conversation shows only the messages actually in that folder, everywhere else
 * it shows everything except those two. Without it the reading pane rendered the
 * whole conversation inside Trash, so deleting one message looked like deleting
 * the thread. Optional, so existing API callers are unaffected.
 */
app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const emails = await (c.var.mailboxStub as any).getThreadEmails(
		c.req.param("threadId")!,
		folder ? { folder } : {},
	);
	return c.json(await withMessageSecurity(c.env, emails));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

/**
 * Delete a custom folder.
 *
 * Answers 200 with what moved rather than 204, because deleting a folder that
 * held mail is not a silent operation: the contents are relocated to the inbox
 * and the client needs to say so. See `workers/durableObject/folders.ts` for
 * why they are relocated instead of deleted with the folder.
 */
app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const result = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	if (!result.deleted) {
		return result.reason === "not_found"
			? c.json({ error: "Folder not found" }, 404)
			: c.json({ error: "That folder cannot be deleted" }, 400);
	}
	return c.json({
		status: "deleted",
		relocated: result.relocated,
		movedTo: result.movedTo,
	});
});

// -- Search ---------------------------------------------------------

/**
 * Search a mailbox.
 *
 * The raw query string is forwarded rather than a set of parsed filters. The
 * client used to parse operators and send one query parameter per filter, which
 * capped what search could express at whatever that flat shape held — there was
 * nowhere to put negation, OR or grouping. Parsing is now the DO's job, using the
 * same `shared/search-query.ts` the client uses to validate as you type.
 */
app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	// `mode=hybrid`: full-text and vectors merged (./lib/semantic.ts). Falls back
	// to full-text alone, and says so, when the index is missing or off.
	if (c.req.query("mode") === "hybrid") {
		const mailbox = decodeURIComponent(c.req.param("mailboxId")!).toLowerCase();
		const text = c.req.query("query") || "";
		const result = await hybridSearch(await semanticDeps(c.env), [mailbox], text, {
			folder: c.req.query("folder") || undefined,
			limit: intQuery(c, "limit"),
		});
		return c.json({ emails: result.results, totalCount: result.results.length, semantic: result.semantic, fallback: result.fallback ?? null });
	}
	const searchOpts = {
		query: c.req.query("query") || "",
		// Scopes the search when the query names no folder; `in:` overrides it.
		folder: c.req.query("folder"),
	};
	// Named rather than `as any` so the two RPC signatures are still checked at
	// this call site; `searchEmails`/`countSearchResults` are not on the base
	// stub type that `mailboxStub` is declared as.
	const stub = c.var.mailboxStub as unknown as {
		searchEmails: (o: typeof searchOpts & { page?: number; limit?: number }) => Promise<unknown>;
		countSearchResults: (o: typeof searchOpts) => Promise<number>;
	};
	const emails = await stub.searchEmails({
		...searchOpts,
		page: intQuery(c, "page"),
		limit: intQuery(c, "limit"),
	});
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Labels ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/labels", async (c: AppContext) =>
	c.json(await c.var.mailboxStub.getLabels()),
);

app.post("/api/v1/mailboxes/:mailboxId/labels", async (c: AppContext) => {
	const { name, color, parent_id, sort_order } = CreateLabelBody.parse(await c.req.json());
	const label = await c.var.mailboxStub.createLabel(
		name.trim(),
		color,
		parent_id ?? null,
		sort_order ?? 0,
	);
	return label
		? c.json(label, 201)
		: c.json({ error: "A label with that name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/labels/:labelId", async (c: AppContext) => {
	const patch = UpdateLabelBody.parse(await c.req.json());
	const label = await c.var.mailboxStub.updateLabel(c.req.param("labelId")!, patch);
	return label
		? c.json(label)
		: c.json({ error: "Label not found or name already in use" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/labels/:labelId", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteLabel(c.req.param("labelId")!);
	return ok ? c.body(null, 204) : c.json({ error: "Label not found" }, 404);
});

app.get("/api/v1/mailboxes/:mailboxId/labels/:labelId/emails", async (c: AppContext) => {
	const labelId = c.req.param("labelId")!;
	const stub = c.var.mailboxStub;
	const filters = {
		unread: boolQuery(c, "unread"),
		starred: boolQuery(c, "starred"),
		has_attachment: boolQuery(c, "has_attachment"),
	};
	const emails = await stub.getEmailsByLabel(labelId, {
		page: intQuery(c, "page"),
		limit: intQuery(c, "limit"),
		sortColumn: c.req.query("sortColumn") as any,
		sortDirection: normalizeSortDirection(c.req.query("sortDirection")),
		...filters,
	});
	// Same filters as the list, so the pager cannot offer an empty page.
	const totalCount = await stub.countEmailsByLabel(labelId, filters);
	return c.json({ emails, totalCount });
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id/labels", async (c: AppContext) =>
	c.json(await c.var.mailboxStub.getEmailLabels(c.req.param("id")!)),
);

// Replaces the whole label set, so the UI can submit a checkbox list directly.
app.put("/api/v1/mailboxes/:mailboxId/emails/:id/labels", async (c: AppContext) => {
	const { label_ids } = SetEmailLabelsBody.parse(await c.req.json());
	const labels = await c.var.mailboxStub.setEmailLabels(c.req.param("id")!, label_ids);
	return labels ? c.json(labels) : c.json({ error: "Email not found" }, 404);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/labels", async (c: AppContext) => {
	const { label_id } = AddEmailLabelBody.parse(await c.req.json());
	const ok = await c.var.mailboxStub.addEmailLabel(c.req.param("id")!, label_id);
	return ok
		? c.json({ status: "labelled" })
		: c.json({ error: "Email or label not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id/labels/:labelId", async (c: AppContext) => {
	await c.var.mailboxStub.removeEmailLabel(c.req.param("id")!, c.req.param("labelId")!);
	return c.body(null, 204);
});

// -- Bulk actions ---------------------------------------------------

/**
 * Which capability each bulk action requires.
 *
 * Exhaustive over `BulkActionBody.action` via `satisfies`, so adding an action to
 * the schema without deciding its authority fails to typecheck rather than
 * defaulting to whatever the weakest entry happens to be.
 */
const BULK_ACTION_CAPABILITIES = {
	read: "organise",
	unread: "organise",
	star: "organise",
	unstar: "organise",
	move: "organise",
	label: "organise",
	unlabel: "organise",
	delete: "delete",
	delete_permanently: "deletePermanently",
	restore: "delete",
} as const satisfies Record<
	z.infer<typeof BulkActionBody>["action"],
	MailboxCapability
>;

/**
 * Apply one action to a set of messages.
 *
 * A single endpoint rather than one per action, because the selection bar in
 * the UI is a single control whose available actions grow over time; adding
 * `archive` later should not mean another round of route plumbing.
 *
 * `affected` is the number of rows that actually changed, which can be lower
 * than `ids.length` when a message was deleted by someone else, or already held
 * the value being set. The UI reports it so a partial result is visible rather
 * than silently assumed successful.
 */
app.post("/api/v1/mailboxes/:mailboxId/emails/bulk", async (c: AppContext) => {
	const body = BulkActionBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;

	// One endpoint, several distinct authorities. The gate has to follow the
	// action in the body: a single path gate would have to be the weakest of
	// them, and `delete_permanently` would ride in on it.
	const required = BULK_ACTION_CAPABILITIES[body.action];
	if (!canDo(c.var.principal, c.req.param("mailboxId")!, required)) {
		return c.json(
			{
				error: `You do not have permission to do this in this mailbox (${required})`,
				capability: required,
			},
			403,
		);
	}

	switch (body.action) {
		case "read":
		case "unread": {
			const affected = await stub.bulkUpdateFlags(body.ids, {
				read: body.action === "read",
			});
			return c.json({ affected });
		}
		case "star":
		case "unstar": {
			const affected = await stub.bulkUpdateFlags(body.ids, {
				starred: body.action === "star",
			});
			return c.json({ affected });
		}
		case "move": {
			// Refused before the DO for the same reason as the single move, and so a
			// bulk selection cannot be used to get around it.
			if (!canMoveInto(body.folder_id)) {
				return c.json(
					{ error: `Messages cannot be moved into ${body.folder_id}` },
					400,
				);
			}

			const affected = await stub.bulkMoveEmails(body.ids, body.folder_id);
			return affected === null
				? c.json({ error: "Folder not found" }, 400)
				: c.json({ affected });
		}
		case "label":
		case "unlabel": {
			const affected = await stub.bulkSetLabel(
				body.ids,
				body.label_id,
				body.action === "label",
			);
			return affected === null
				? c.json({ error: "Label not found" }, 404)
				: c.json({ affected });
		}
		// Trash-first, matching the single-message route: a selection spanning the
		// inbox and the bin trashes the former and destroys the latter, so both
		// counts come back and the UI can word the toast honestly.
		case "delete":
		case "delete_permanently": {
			const { trashed, deleted, attachmentKeys } = await stub.bulkDeleteEmails(
				body.ids,
				{ permanent: body.action === "delete_permanently" },
			);
			await deleteAttachmentBlobs(c.env.BUCKET, attachmentKeys);
			return c.json({ affected: trashed + deleted, trashed, deleted });
		}
		case "restore": {
			const affected = await stub.restoreEmails(body.ids);
			return c.json({ affected });
		}
	}
});

/**
 * Clear unread state across a folder, a label, or the whole mailbox.
 *
 * Separate from the bulk endpoint because it takes a scope rather than an id
 * list — the point is not having to enumerate thousands of ids client-side.
 */
app.post("/api/v1/mailboxes/:mailboxId/mark-all-read", async (c: AppContext) => {
	const body = MarkAllReadBody.parse(await c.req.json().catch(() => undefined));
	const affected = await c.var.mailboxStub.markAllRead({
		folder: body?.folder,
		labelId: body?.label_id,
	});
	return c.json({ affected });
});

// -- Signatures -----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/signatures", async (c: AppContext) =>
	c.json(await c.var.mailboxStub.getSignatures()),
);

app.get("/api/v1/mailboxes/:mailboxId/signatures/default", async (c: AppContext) =>
	c.json({ signature: await c.var.mailboxStub.getDefaultSignature() }),
);

app.post("/api/v1/mailboxes/:mailboxId/signatures", async (c: AppContext) => {
	const { name, body_html, is_default } = CreateSignatureBody.parse(await c.req.json());
	return c.json(
		await c.var.mailboxStub.createSignature(name, body_html, is_default ?? false),
		201,
	);
});

app.put("/api/v1/mailboxes/:mailboxId/signatures/:signatureId", async (c: AppContext) => {
	const patch = UpdateSignatureBody.parse(await c.req.json());
	const sig = await c.var.mailboxStub.updateSignature(c.req.param("signatureId")!, patch);
	return sig ? c.json(sig) : c.json({ error: "Signature not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/signatures/:signatureId", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteSignature(c.req.param("signatureId")!);
	return ok ? c.body(null, 204) : c.json({ error: "Signature not found" }, 404);
});

// -- Snooze ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/snoozed", async (c: AppContext) =>
	c.json(await c.var.mailboxStub.getSnoozedEmails()),
);

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/snooze", async (c: AppContext) => {
	const parsed = SnoozeBody.parse(await c.req.json());
	const untilMs = parsed.until
		? Date.parse(parsed.until)
		: Date.now() + parsed.delay_seconds! * 1000;

	if (Number.isNaN(untilMs)) return c.json({ error: "Invalid 'until' timestamp" }, 400);
	if (untilMs <= Date.now()) {
		return c.json({ error: "Snooze time must be in the future" }, 400);
	}

	const email = await c.var.mailboxStub.snoozeEmail(
		c.req.param("id")!,
		new Date(untilMs).toISOString(),
	);
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id/snooze", async (c: AppContext) => {
	const email = await c.var.mailboxStub.unsnoozeEmail(c.req.param("id")!);
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

// -- Priority -------------------------------------------------------

app.put("/api/v1/mailboxes/:mailboxId/emails/:id/priority", async (c: AppContext) => {
	const { priority } = PriorityBody.parse(await c.req.json());
	const email = await c.var.mailboxStub.setEmailPriority(c.req.param("id")!, priority);
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

// -- Scheduled send / undo send -------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/scheduled-sends", async (c: AppContext) =>
	c.json(await c.var.mailboxStub.listScheduledSends()),
);

/**
 * Queue an outbound message for later delivery.
 *
 * Takes the same body as POST /emails plus either `send_at` (ISO) or
 * `delay_seconds`. A short `delay_seconds` is how Undo Send works: the message
 * waits in the Scheduled folder and DELETE cancels it.
 *
 * Because Undo Send routes *ordinary* sends through here, this path has to be a
 * full peer of POST /emails and the reply/forward routes — anything it drops is
 * dropped from every send. Hence the `raw_headers` record (which is where the
 * From display name survives to delivery) and the server-side `References`
 * chain for replies.
 */
app.post("/api/v1/mailboxes/:mailboxId/scheduled-sends", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const raw = await c.req.json();
	const body = SendEmailRequestSchema.parse(raw);
	const schedule = ScheduleFieldsBody.parse(raw);
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	/**
	 * Superseding a draft is the `draft` authority, checked before anything is
	 * stored or queued.
	 *
	 * Position is deliberate on both sides. It has to come before
	 * `storeAttachments` below, or a refused request has already written R2 objects
	 * that no message will ever reference and nothing will ever delete — and since
	 * every retry mints a fresh message id, each one leaks another copy. It also
	 * has to come before `createScheduledEmail`: the client used to destroy the
	 * draft in a second request after this route returned 201, so a refusal arrived
	 * once the message was already on its way, and the composer — which cannot tell
	 * a failed send from a failed cleanup — reported the send itself as failed.
	 * Refusing up front means the send either happens and the draft goes, or
	 * neither does.
	 */
	if (
		schedule.supersedes_draft_id &&
		!canDo(c.var.principal, mailboxId, "draft")
	) {
		return c.json(
			{
				error: "You do not have permission to do this in this mailbox (draft)",
				capability: "draft",
			},
			403,
		);
	}

	const sendAtMs = schedule.send_at
		? Date.parse(schedule.send_at)
		: Date.now() + schedule.delay_seconds! * 1000;
	if (Number.isNaN(sendAtMs)) return c.json({ error: "Invalid 'send_at' timestamp" }, 400);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(
			to,
			from,
			mailboxId,
			await senderAddressesFor(c.env, mailboxId),
		));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	// Same per-message limits as an immediate send. Refused now rather than when
	// the alarm fires, which would be minutes later and after the composer had
	// already told the user it was sent. (Threading headers are rebuilt at
	// delivery and trimmed to fit, so they are not part of this check.)
	{
		const rejected = sendRejection({ to, cc, bcc, html, text, attachments });
		if (rejected) return c.json(rejected.body, rejected.status);
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const sendAtIso = new Date(sendAtMs).toISOString();

	// Threading. A client can only tell us the immediate parent, but RFC 5322
	// §3.6.4 wants the whole ancestry in `References` — without it the recipient's
	// client shows the reply as a new conversation. So when we're told which
	// message this answers, rebuild the chain from it exactly as the reply route
	// does rather than trusting what was posted.
	let replyMsgId = in_reply_to || null;
	let replyReferences = references ?? [];
	let resolvedThreadId = thread_id || in_reply_to || messageId;
	let threadToMarkRead: string | null = null;

	if (schedule.reply_to_email_id) {
		const threading = await resolveThreadedSend(
			c.var.mailboxStub,
			schedule.reply_to_email_id,
			schedule.threaded_mode ?? "reply",
		);
		if (!threading) return c.json({ error: "Original email not found" }, 404);

		replyMsgId = threading.inReplyTo;
		replyReferences = threading.references;
		resolvedThreadId = threading.threadId;
		threadToMarkRead = threading.markThreadRead;
	}

	/**
	 * Whose name this will leave under, resolved now rather than at delivery.
	 *
	 * The cron dispatcher fires with no caller attached, so it cannot ask who
	 * scheduled the message — the answer has to be persisted here, while the
	 * principal is still in hand.
	 *
	 * This matters more than the direct send path does: Undo Send routes *ordinary*
	 * sends through here, so without this an `agent` grant's every message would
	 * leave un-attributed, as though sent by the mailbox owner. That is exactly the
	 * Send As behaviour the capability split exists to withhold.
	 */
	const scheduledAttribution = sendAttributionFor(c.var.principal, mailboxId);
	if (!scheduledAttribution) {
		return c.json(
			{ error: "You do not have permission to send from this mailbox" },
			403,
		);
	}
	/*
	 * The permission check above is still load-bearing — it is what refuses a
	 * caller with no send grant — but its `onBehalfOf` address is no longer
	 * persisted into `raw_headers`.
	 *
	 * It was stored so the cron dispatcher could emit `Sender:` at delivery. Email
	 * Service does not allowlist that header and rejects the entire message for it,
	 * so keeping the value would only let the exported source claim recipients
	 * received a header they never got. The audit entry below records the
	 * attribution instead.
	 */







	/**
	 * An API token or OAuth grant passes the pre-send gate (and its approval
	 * rule) now, while the credential is in hand: the alarm that delivers this
	 * later has no caller, so a short delay must not be a way around approval.
	 * A held message is stored with its `send_at` and queued only on approval.
	 * Browser sessions skip this here (delivery runs the gate as always).
	 */
	const scheduleActor = requestActor(c);
	if (actorNeedsGate(scheduleActor)) {
		const gate = await preSend(c.env, {
			kind: "transactional",
			from: fromEmail,
			mailboxId,
			to, cc, bcc, html, text, attachments,
			// The quota is the one at delivery.
			quotaChecked: true,
			actor: scheduleActor,
			hold: {
				action: "schedule_send",
				subject,
				payload: {
					composed: [
						{
							kind: "transactional",
							to: listOf(to),
							cc: listOf(cc),
							bcc: listOf(bcc),
							from,
							subject,
							html,
							text,
							rawAttachments: attachments,
							row: {
								threadId: resolvedThreadId === messageId ? null : resolvedThreadId,
								inReplyTo: replyMsgId,
								references: replyReferences,
								rawHeaders: JSON.stringify([
									{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
									{ key: "subject", value: subject },
									...(replyMsgId ? [{ key: "in-reply-to", value: `<${replyMsgId}>` }] : []),
									...(replyReferences.length ? [{ key: "references", value: replyReferences.map((r) => `<${r}>`).join(" ") }] : []),
								]),
							},
							markThreadRead: threadToMarkRead,
							sendAt: sendAtIso,
							trackingBaseUrl: trackingBaseUrlFromRequest(c.req.url),
						},
					],
				} satisfies HoldPayload,
			},
		});
		if (!gate.ok) return c.json(...httpRefusal(gate));
	}

	// After every refusal above, so a refused request leaves no R2 objects behind.
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	// Rate limiting is deliberately deferred to delivery time: the quota that
	// matters is the one in force when the message actually goes out.
	await c.var.mailboxStub.createScheduledEmail(
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
			bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
			date: sendAtIso,
			body: html || text || "",
			in_reply_to: replyMsgId,
			email_references:
				replyReferences.length > 0 ? JSON.stringify(replyReferences) : null,
			thread_id: resolvedThreadId,
			message_id: outgoingMessageId,
			// `sender` is a bare address, so the From display name would otherwise be
			// lost between here and delivery. Delivery reads it back out of this.
			raw_headers: JSON.stringify([
				{
					key: "from",
					value: typeof from === "string" ? from : `${from.name} <${from.email}>`,
				},
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject },
				{ key: "date", value: sendAtIso },
				// Neither `message-id` nor `sender` is persisted any more, and both
				// omissions matter (Codex P2 x2).
				//
				// `message-id`: the provider assigns the real one at delivery and
				// `recordDelivery` writes it to the `message_id` COLUMN. An entry here
				// would outrank that column in the `.eml`/mbox exporters, which prefer
				// a stored header and skip a key already present.
				//
				// `sender`: `buildHeaders` used to read this back and put it on the
				// wire, but Email Service does not allowlist `Sender` and rejects the
				// whole message for it. Keeping it stored would make the exported
				// source claim recipients received an on-behalf-of header they never
				// got. Attribution lives in the audit log (`mail.send`), which is a
				// record of who acted rather than a claim about what was transmitted.
				...(replyMsgId ? [{ key: "in-reply-to", value: `<${replyMsgId}>` }] : []),
				...(replyReferences.length > 0
					? [
							{
								key: "references",
								value: replyReferences.map((r) => `<${r}>`).join(" "),
							},
						]
					: []),
			]),
		},
		attachmentData,
		sendAtIso,
		// Delivery runs in the alarm with no request, so the tracking origin is
		// captured now. Instrumenting happens once, at delivery.
		{ trackingBaseUrl: trackingBaseUrlFromRequest(c.req.url), mailboxId, track: body.track },
	);

	// Replying implies you've read the conversation, and that's true the moment
	// you hit send — not whenever delivery happens to fire.
	if (threadToMarkRead) await c.var.mailboxStub.markThreadRead(threadToMarkRead);

	/**
	 * The draft goes now the message is safely queued, and only now.
	 *
	 * After `createScheduledEmail`, so a failure to store the outgoing copy leaves
	 * the user's text where they can still find it. Scoped to the Drafts folder by
	 * the DO, so a send cannot be used to destroy a received message by passing
	 * its id. An unknown id reports zero and is ignored — the draft having already
	 * been tidied up elsewhere is not a reason to fail a send that has happened.
	 */
	let supersededDraft = false;
	if (schedule.supersedes_draft_id) {
		/**
		 * Never fatal. The message is queued by this point, so a transient RPC or SQL
		 * failure here must not turn a successful send into a 500: the composer would
		 * report a failed send for mail already on its way, and the retry would queue
		 * a duplicate — which is the entire bug this route exists to remove, arriving
		 * from one step further along.
		 *
		 * The cost of swallowing it is a draft left in Drafts, which the user can see
		 * and discard. The cost of surfacing it is a duplicate send. `superseded_draft`
		 * reports what actually happened either way.
		 */
		try {
			const { deleted, attachmentKeys } =
				await c.var.mailboxStub.destroySupersededDraft(
					schedule.supersedes_draft_id,
				);
			supersededDraft = deleted > 0;
			await deleteAttachmentBlobs(c.env.BUCKET, attachmentKeys);
		} catch (e) {
			console.error(
				`Queued ${messageId} but could not supersede draft ${schedule.supersedes_draft_id}:`,
				e,
			);
		}
	}

	return c.json(
		{
			id: messageId,
			status: "scheduled",
			send_at: sendAtIso,
			superseded_draft: supersededDraft,
		},
		201,
	);
});

app.delete("/api/v1/mailboxes/:mailboxId/scheduled-sends/:emailId", async (c: AppContext) => {
	const result = await c.var.mailboxStub.cancelScheduledSend(c.req.param("emailId")!);
	if (!result) return c.json({ error: "Scheduled send not found" }, 404);
	if (!result.cancelled) {
		return c.json({ error: `Cannot cancel — already ${result.status}` }, 409);
	}
	return c.json({ status: "cancelled" });
});

/**
 * Send a queued message now, skipping the rest of its delay.
 *
 * The counterpart to DELETE on this resource: one abandons the wait, the other
 * abandons the delay. Both exist so the undo window is not a period in which the
 * only available action is to wait.
 *
 * Delivery reuses the alarm's own code path, so this cannot produce a second
 * copy or a different `Message-ID` — it is the same send, earlier.
 *
 * 409 when the alarm already took the message (the likely race, since a 30s
 * window and a button are competing for one row), and 503 when the mailbox is
 * over its send quota: the message stays queued and the alarm will carry it, so
 * that is a "not yet", not a failure.
 */
app.post(
	"/api/v1/mailboxes/:mailboxId/scheduled-sends/:emailId/send-now",
	async (c: AppContext) => {
		const result = await c.var.mailboxStub.sendScheduledNow(c.req.param("emailId")!);
		if (!result) return c.json({ error: "Scheduled send not found" }, 404);

		switch (result.status) {
			case "sent":
				return c.json({ status: "sent" });
			case "already":
				return c.json({ error: `Cannot send — already ${result.current}` }, 409);
			case "deferred":
				return c.json({ error: result.error }, 503);
			default:
				return c.json(
					{
						error: result.exhausted
							? `Delivery failed and the message has been saved to Drafts: ${result.error}`
							: `Delivery failed, and will be retried: ${result.error}`,
					},
					502,
				);
		}
	},
);

// -- Blocked senders ------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/blocked-senders", async (c: AppContext) =>
	c.json(await c.var.mailboxStub.getBlockedSenders()),
);

app.post("/api/v1/mailboxes/:mailboxId/blocked-senders", async (c: AppContext) => {
	const { pattern, reason } = BlockSenderBody.parse(await c.req.json());
	const blocked = await c.var.mailboxStub.blockSender(pattern, reason ?? null);
	return blocked
		? c.json(blocked, 201)
		: c.json({ error: "Sender is already blocked" }, 409);
});

app.delete("/api/v1/mailboxes/:mailboxId/blocked-senders/:blockId", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.unblockSender(c.req.param("blockId")!);
	return ok ? c.body(null, 204) : c.json({ error: "Block rule not found" }, 404);
});

// -- Allowed senders ------------------------------------------------
//
// Senders exempt from heuristic spam scoring. Populated mainly by "Not spam"
// below rather than by hand, and editable here so a mistake can be undone.

app.get("/api/v1/mailboxes/:mailboxId/allowed-senders", async (c: AppContext) =>
	c.json(await (c.var.mailboxStub as any).getAllowedSenders()),
);

app.post("/api/v1/mailboxes/:mailboxId/allowed-senders", async (c: AppContext) => {
	const { pattern, reason } = BlockSenderBody.parse(await c.req.json());
	const allowed = await (c.var.mailboxStub as any).allowSender(
		pattern,
		reason ?? null,
	);
	return allowed
		? c.json(allowed, 201)
		: c.json({ error: "Sender is already allowed" }, 409);
});

app.delete("/api/v1/mailboxes/:mailboxId/allowed-senders/:allowId", async (c: AppContext) => {
	const ok = await (c.var.mailboxStub as any).disallowSender(
		c.req.param("allowId")!,
	);
	return ok ? c.body(null, 204) : c.json({ error: "Allow rule not found" }, 404);
});

/**
 * Mark a message as not spam.
 *
 * A dedicated route rather than a plain move plus an unblock, because the parts
 * have to happen together: moving the message alone left the sender blocked and
 * still scoring as spam, so the next message from them went straight back —
 * which is what "Not spam" is supposed to prevent.
 */
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/not-spam", async (c: AppContext) => {
	const result = await (c.var.mailboxStub as any).markNotSpam(
		c.req.param("id")!,
	);
	return result ? c.json(result) : c.json({ error: "Email not found" }, 404);
});

// -- Export ---------------------------------------------------------

/**
 * Download the whole mailbox as mbox.
 *
 * "Let me have my mail" is the one missing feature that is not an inconvenience
 * but a lock-in. Gmail answers it with Takeout, which produces mbox; Thunderbird,
 * Apple Mail and every migration tool read mbox; and a GDPR Article 20 request has
 * to be answerable in a "structured, commonly used and machine-readable format".
 *
 * **Streamed, not buffered.** The response body is a `ReadableStream` fed a page
 * at a time from the Durable Object, so peak memory is one page rather than one
 * mailbox. Buffering would work fine in testing and fail in production on exactly
 * the mailboxes worth exporting — and a Worker that runs out of memory mid-export
 * produces a truncated file that still looks like a download that worked.
 *
 * Because the status line is sent before the first page is read, an error partway
 * through cannot become a 500. The stream is aborted instead, so the transfer
 * fails visibly rather than delivering a silently short archive that the reader
 * would keep and the mailbox they deleted afterwards would not be in.
 *
 * Gated on `read` alongside every other route that reveals a message. An export
 * is the whole mailbox in one request, so leaving it off that list let a grant
 * with `read` revoked download everything while being refused a single message.
 *
 * Still an open question whether `read` is *enough*: an export is a complete copy,
 * which is a larger act than opening any one message, and a `viewer` on a shared
 * inbox can now take all of it. Requiring something stronger is a policy decision
 * about what a viewer is for, not a defect, so it is noted rather than assumed.
 */
app.get("/api/v1/mailboxes/:mailboxId/export", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const stub = c.var.mailboxStub;

	const total = await (stub as unknown as { countAllEmails(): Promise<number> })
		.countAllEmails()
		.catch(() => 0);

	/**
	 * Messages fetched per pull.
	 *
	 * Small enough that one page of full bodies is comfortably inside the DO
	 * response limit, large enough that a big mailbox does not cost thousands of
	 * round trips.
	 */
	const PAGE = 50;
	let cursor: { date: string; id: string } | undefined;

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			// One page per pull, so backpressure from a slow client actually slows the
			// reads rather than racing ahead and buffering the whole mailbox.
			try {
				const page = await (
					stub as unknown as {
						exportPage(options: {
							limit?: number;
							afterDate?: string;
							afterId?: string;
						}): Promise<{
							messages: Record<string, unknown>[];
							attachments: Record<
								string,
								{ filename: string; mimetype: string; size: number }[]
							>;
							done: boolean;
							cursor?: { date: string; id: string };
						}>;
					}
				).exportPage(
					cursor
						? { limit: PAGE, afterDate: cursor.date, afterId: cursor.id }
						: { limit: PAGE },
				);

				for (const message of page.messages) {
					const row = message as unknown as ExportableMessage;
					controller.enqueue(
						encoder.encode(messageToMbox(row, page.attachments[row.id] ?? [])),
					);
				}

				if (page.done || !page.cursor) {
					controller.close();
					return;
				}
				cursor = page.cursor;
			} catch (e) {
				// Abort rather than close: a closed stream is a complete file, and a
				// truncated archive that looks complete is the worst outcome here.
				console.error("Mailbox export failed:", (e as Error).message);
				controller.error(e);
			}
		},
	});

	const filename = `${mailboxId.replace(/[^\w.@-]+/g, "_")}-${new Date()
		.toISOString()
		.slice(0, 10)}.mbox`;

	return new Response(stream, {
		headers: {
			// RFC 4155 registers this media type for the format.
			"Content-Type": "application/mbox",
			"Content-Disposition": `attachment; filename="${filename}"`,
			// No Content-Length: the size is not known before the last page is read,
			// and a wrong one would truncate the download.
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			// Advisory, for a UI that wants to show progress.
			"X-Message-Count": String(total),
		},
	});
});

// -- Change polling -------------------------------------------------
//
// The client polls this instead of refetching every list on a timer: two
// single-row reads, so it is cheap enough to run every few seconds and gives
// the UI a way to notice new mail promptly.

app.get("/api/v1/mailboxes/:mailboxId/state", async (c: AppContext) => {
	const state = await timed(c, "do", () => c.var.mailboxStub.getMailboxState());
	return stateResponse(c, state);
});

// -- Access log -----------------------------------------------------

/**
 * Who has done what in this mailbox.
 *
 * Gated on `manageSettings` rather than `read`: the log names everyone who has
 * touched the mailbox, so it answers questions about colleagues rather than about
 * mail. An agent on a shared inbox can work in it without being able to see who
 * else has, while whoever is trusted with its configuration can.
 *
 * Newest first, and bounded — see `workers/lib/audit.ts` for why the key layout
 * makes that a single page read rather than a scan.
 */
app.get(
	"/api/v1/mailboxes/:mailboxId/audit",
	requireCapability("manageSettings"),
	async (c: AppContext) => {
		const limit = Number(c.req.query("limit")) || AUDIT_PAGE_SIZE;
		return c.json(
			await listAudit(c.env.BUCKET, {
				mailboxId: c.req.param("mailboxId")!,
				limit,
				filter: auditFilterFromQuery((n) => c.req.query(n)),
			}),
		);
	},
);

// -- Filter rules ---------------------------------------------------
//
// Rules run on the delivery path, so the clause limits enforced by the schemas
// above matter: an unbounded rule list would turn every inbound message into a
// timeout. `RuleLimitError` from the storage layer is the second line of
// defence and is reported as a 422 rather than a 500.

app.get("/api/v1/mailboxes/:mailboxId/rules", async (c: AppContext) =>
	c.json(await c.var.mailboxStub.getRules()),
);

app.post("/api/v1/mailboxes/:mailboxId/rules", async (c: AppContext) => {
	const body = CreateRuleBody.parse(await c.req.json());
	try {
		return c.json(await c.var.mailboxStub.createRule(body), 201);
	} catch (e) {
		if ((e as Error).name === "RuleLimitError") {
			return c.json({ error: (e as Error).message }, 422);
		}
		throw e;
	}
});

app.put("/api/v1/mailboxes/:mailboxId/rules/:ruleId", async (c: AppContext) => {
	const body = UpdateRuleBody.parse(await c.req.json());
	try {
		const rule = await c.var.mailboxStub.updateRule(c.req.param("ruleId")!, body);
		return rule ? c.json(rule) : c.json({ error: "Rule not found" }, 404);
	} catch (e) {
		if ((e as Error).name === "RuleLimitError") {
			return c.json({ error: (e as Error).message }, 422);
		}
		throw e;
	}
});

app.delete("/api/v1/mailboxes/:mailboxId/rules/:ruleId", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteRule(c.req.param("ruleId")!);
	return ok ? c.body(null, 204) : c.json({ error: "Rule not found" }, 404);
});

/** Full id sequence, so a reorder is one request regardless of how it was made. */
app.post("/api/v1/mailboxes/:mailboxId/rules/reorder", async (c: AppContext) => {
	const { ids } = ReorderRulesBody.parse(await c.req.json());
	const updated = await c.var.mailboxStub.reorderRules(ids);
	return c.json({ updated });
});

// -- Muted conversations --------------------------------------------
//
// Mute is keyed by thread so it also applies to replies that have not arrived
// yet: new messages in a muted thread are filed to Archive, already read.

app.get("/api/v1/mailboxes/:mailboxId/muted-threads", async (c: AppContext) =>
	c.json(await c.var.mailboxStub.listMutedThreads()),
);

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/mute", async (c: AppContext) => {
	await c.var.mailboxStub.muteThread(c.req.param("threadId")!);
	return c.json({ muted: true });
});

app.delete("/api/v1/mailboxes/:mailboxId/threads/:threadId/mute", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.unmuteThread(c.req.param("threadId")!);
	return ok ? c.json({ muted: false }) : c.json({ error: "Thread was not muted" }, 404);
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);

	/**
	 * A refused part is refused here too, not just hidden in the UI.
	 *
	 * There is no blob for a blocked attachment, so this would 404 anyway — but
	 * relying on that would make the control an accident of storage rather than a
	 * decision, and it would evaporate the moment anything wrote a blob for a row
	 * like this. Answering 403 with the reason also gives an API client something
	 * it can act on, where "not found" invites a retry.
	 *
	 * The filename is re-checked rather than trusted to the column, so a row
	 * written before migration 23 — when nothing set `blocked` — is still refused
	 * if it names an executable.
	 */
	if (attachment.blocked || isBlockedAttachment(attachment.filename)) {
		return c.json(
			{
				error:
					"This attachment was blocked because its file type can run code on your computer.",
				blocked: true,
			},
			403,
		);
	}

	const obj = await c.env.BUCKET.get(attachmentKey(emailId, attachmentId, attachment.filename));
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);

	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);

	// The same URL backs three things: the download link, the `cid:` images
	// rewritten into the message body, and the preview overlay. Only the first
	// wants an attachment disposition — forcing it on all three made browsers
	// download a PDF the reader asked to preview, and is why inline images and
	// the preview pane behaved inconsistently across browsers.
	//
	// Inline is opt-in via the query string rather than inferred from the
	// mimetype: the caller knows whether it is embedding or offering the file,
	// and an image is legitimately either. `canServeInline` then decides whether
	// this app is willing to honour the request, against an allowlist of types
	// safe to render in its own origin — see the note there for why the previous
	// deny-list of executable types was the wrong shape.
	const inline = canServeInline(
		attachment.mimetype,
		c.req.query("disposition"),
	);

	// Strip control characters and quotes before interpolating: a raw filename
	// can carry either and split the response header.
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set(
		"Content-Disposition",
		inline
			? "inline"
			: `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
	);

	// Blob content is immutable once written — the key contains the attachment
	// id. `private` rather than `public` so a shared cache cannot serve one
	// mailbox's attachment to another caller.
	headers.set("Cache-Control", "private, max-age=31536000, immutable");
	// Belt and braces alongside the allowlist above: even for a type we agreed to
	// serve inline, the browser must honour the declared `Content-Type` rather
	// than sniffing the bytes and deciding a `text/plain` part is really HTML.
	headers.set("X-Content-Type-Options", "nosniff");

	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

/**
 * The inbound email event, narrowed to what this handler reads.
 *
 * `to` and `from` are the SMTP envelope addresses that Cloudflare Email Routing
 * supplies. They were previously absent from this type, so the envelope
 * recipient — the only address guaranteed to be present, and the one the message
 * was actually delivered to — was invisible to the handler, which fell back to
 * parsing the `To:` header.
 */
interface InboundEmailEvent {
	raw: ReadableStream;
	rawSize: number;
	/** Envelope recipient. */
	to?: string;
	/** Envelope sender. */
	from?: string;
}

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;


async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

async function receiveEmail(event: InboundEmailEvent, env: Env, ctx: ExecutionContext) {
	const receivedAt = new Date();
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	// Envelope recipient first, then the To: header. See
	// `resolveInboundRecipients`: keying off the header alone rejected — and so
	// bounced — legitimate mail that carries no To:, such as anything Bcc'd to us.
	const allRecipients = resolveInboundRecipients({
		envelopeTo: event.to,
		headerTo: (parsedEmail.to ?? []).map((t) => t.address),
	});
	if (allRecipients.length === 0) {
		throw new Error("received email with no recipient in envelope or headers");
	}
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	// Exact mailbox, then alias, then the domain's catch-all; EMAIL_ADDRESSES
	// still restricts. See `workers/lib/inbound-routing.ts`.
	const route = await routeInbound(env, allRecipients);
	if (!route) {
		console.log(`Ignoring email: no mailbox, alias or catch-all for ${allRecipients.join(", ")}`);
		return;
	}
	const mailboxId = route.mailboxId;
	if (route.via !== "direct") {
		console.log(`Delivering mail for ${route.deliveredTo} to ${mailboxId} (${route.via}).`);
	}

	const messageId = crypto.randomUUID();
	const mailboxObj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!mailboxObj) { console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`); return; }

	/**
	 * Settings are read once and shared by auto-draft, forwarding and auto-reply
	 * below.
	 *
	 * `parseStoredMailboxSettings` never throws and never returns a partial
	 * object, which is what the three consumers below need: this used to be a
	 * hand-written optional type over raw `.json()`, so each one carried its own
	 * `?? {}` and its own cast, and a blob whose `autoReply` was written as a
	 * string reached `decideAutoReply` unexamined. A malformed blob now costs the
	 * mailbox its customisations, not its mail.
	 */
	let mailboxSettings = defaultMailboxSettings();
	try {
		mailboxSettings = parseStoredMailboxSettings(
			await mailboxObj.json(),
			(problem) =>
				console.warn(
					`Settings for mailbox ${mailboxId} needed repair: ${problem}`,
				),
		);
	} catch (e) {
		// Unparseable JSON, not merely an unexpected shape — the parser handles
		// the latter, only `.json()` itself can throw here.
		console.error(`Failed to parse settings for mailbox ${mailboxId}:`, (e as Error).message);
	}
	const autoDraftEnabled = isAutoDraftEnabled(mailboxSettings);

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

	// Blocked senders are filed into Spam rather than dropped. Discarding the
	// message outright would let a mis-typed block rule silently destroy mail
	// with no way to notice or recover it.
	const senderAddress = (parsedEmail.from?.address || "").toLowerCase();
	const senderBlocked = senderAddress ? await stub.isSenderBlocked(senderAddress) : false;
	let targetFolder: string = senderBlocked ? Folders.SPAM : Folders.INBOX;
	if (senderBlocked) {
		console.log(`Sender ${senderAddress} is blocked for ${mailboxId}; filing to Spam.`);
	}

	// An explicit block wins over the allowlist: both are deliberate, and "I do
	// not want this sender" is the more specific of the two intents.
	// Authentication verdicts from our own MX only; see ./lib/inbound-trust.ts.
	const trust = assessInboundTrust(parsedEmail.headers, senderAddress);

	const senderAllowed =
		!senderBlocked && senderAddress
			? await (stub as any).isSenderAllowed(senderAddress)
			: false;

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inboundMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

	/**
	 * Refuse a message this mailbox already holds.
	 *
	 * Cloudflare retries the email handler when it throws, and this function
	 * mints a fresh `crypto.randomUUID()` for the row's primary key on each
	 * attempt — so a retry looked like an entirely new message. Anything that
	 * threw *after* the insert therefore stored the message twice, and the
	 * `listMailboxes` await feeding the loop guards sits in exactly that window.
	 *
	 * Checked before the attachment uploads rather than just before the insert,
	 * so a duplicate delivery does not also leave a second copy of every blob
	 * orphaned in R2 under a key nothing references.
	 *
	 * Enforced here rather than with a UNIQUE index: rows violating it may already
	 * exist from before this check, and a migration that fails throws out of the
	 * Durable Object constructor, which would make the mailbox permanently
	 * unreachable.
	 */
	if (inboundMessageId && (await (stub as any).hasMessageId(inboundMessageId))) {
		console.log(
			`Ignoring duplicate delivery of <${inboundMessageId}> for ${mailboxId}.`,
		);
		return;
	}

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = sanitizeAttachmentFilename(att.filename);
			const size =
				typeof att.content === "string" ? att.content.length : att.content.byteLength;

			/**
			 * An executable or script part is recorded but never stored.
			 *
			 * The blob is what a reader can download and run, so not writing it is
			 * the control; the row is what stops the refusal being silent. Checked
			 * on the sanitised filename, which is the name the download endpoint
			 * would serve — checking the raw one could pass a name that sanitising
			 * then turns back into an executable.
			 *
			 * The message itself is still delivered. The body may be the point, and
			 * discarding legitimate mail because of one bad part is a worse failure
			 * than the one being prevented. See `shared/attachment-types.ts`.
			 */
			if (isBlockedAttachment(filename)) {
				console.log(
					`Blocked attachment ${filename} on inbound message for ${mailboxId}`,
				);
				attachmentData.push({
					id: attId,
					email_id: messageId,
					filename,
					mimetype: att.mimeType,
					size,
					content_id: att.contentId || null,
					disposition: att.disposition || "attachment",
					blocked: true,
				});
				continue;
			}

			await env.BUCKET.put(attachmentKey(messageId, attId, filename), att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	// In-Reply-To names the immediate parent, and References runs oldest-first, so
	// the closest known ancestor is at the end. Ask the mailbox which of these it
	// already stores before trusting a raw external id as a thread key. Parsed by
	// bracket rather than by whitespace, so `<a><b>` yields both ids.
	const {
		inReplyTo,
		references: emailReferences,
		candidates: ancestorIds,
	} = threadCandidates({
		inReplyTo: parsedEmail.inReplyTo,
		references: parsedEmail.references,
	});
	let threadId = messageId;

	/**
	 * Whether this message joins a conversation the mailbox already holds.
	 *
	 * Recorded here because spam scoring needs it below: continuing an existing
	 * thread is the strongest cheap indication that a message is wanted, and
	 * recomputing it would mean repeating these lookups.
	 */
	let inKnownThread = false;

	if (ancestorIds.length > 0) {
		const localThread = await (stub as any).findThreadByMessageIds(ancestorIds);
		inKnownThread = !!localThread;
		threadId = localThread || emailReferences[0] || inReplyTo || messageId;
	} else {
		const subjectThread = await (stub as any).findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined);
		if (subjectThread) {
			threadId = subjectThread;
			inKnownThread = true;
		}
	}


	/**
	 * Filing decisions, made before the row is written.
	 *
	 * Rules and mute both change where a message lands and how it is flagged, and
	 * evaluating them up front means one insert with the right values rather than
	 * an insert into the inbox followed by a correction — which the user would
	 * see as mail appearing and then jumping away.
	 *
	 * Blocked senders skip both: that mail is already being filed to Spam, and
	 * running rules over it would let a rule pull it back out.
	 */
	let ruleOutcome: RuleOutcome | null = null;
	let threadMuted = false;
	let spamVerdict: SpamVerdict | null = null;

	if (!senderBlocked) {
		threadMuted = await stub.isThreadMuted(threadId);
		if (threadMuted) {
			// A muted conversation is one the user has explicitly stopped caring
			// about, so a new reply is filed away and pre-read rather than
			// re-surfacing the thread in the inbox.
			targetFolder = Folders.ARCHIVE;
			console.log(`Thread ${threadId} is muted for ${mailboxId}; archiving.`);
		}

		try {
			const activeRules = await stub.getEnabledRules();
			if (activeRules.length > 0) {
				ruleOutcome = evaluateRules(activeRules, {
					from: senderAddress,
					to: allRecipients,
					cc: ccRecipients,
					subject: parsedEmail.subject || "",
					body: parsedEmail.text || parsedEmail.html || "",
					hasAttachment: (parsedEmail.attachments ?? []).some(
						(att) => (att.disposition || "attachment") !== "inline",
					),
				});

				/**
				 * A rule's destination is checked before it is used.
				 *
				 * `rules.actions` stores a folder id inside its JSON, which no foreign
				 * key polices — so deleting a custom folder leaves any rule that filed
				 * mail into it pointing at nothing. `createEmail` rejects an unknown
				 * folder, and that throw happens *outside* this try block, so inbound
				 * mail matching such a rule would fail, be retried, and eventually
				 * bounce. Filing to the inbox instead is visible and recoverable.
				 */
				if (ruleOutcome.folder) {
					const known = await stub.getFolders();
					if (known.some((f) => f.id === ruleOutcome!.folder)) {
						targetFolder = ruleOutcome.folder;
					} else {
						console.error(
							`Rule for ${mailboxId} targets missing folder "${ruleOutcome.folder}"; filing to ${targetFolder} instead.`,
						);
					}
				}
			}
		} catch (e) {
			// A broken rule must not cost us the message: log and deliver as
			// normal.
			console.error(
				`Rule evaluation failed for ${mailboxId}:`,
				(e as Error).message,
			);
			ruleOutcome = null;
		}

		/**
		 * Heuristic spam scoring, last and least authoritative.
		 *
		 * Runs only when nothing more definite has already decided where the
		 * message goes. A rule the user wrote, a thread they muted and a sender
		 * they allowlisted are all explicit instructions; a score is a guess, and
		 * a guess must not override an instruction. In particular a rule that
		 * files mail into a folder is the user saying they want to see it there.
		 */
		if (!senderAllowed && targetFolder === Folders.INBOX && !ruleOutcome?.folder) {
			try {
				spamVerdict = classifySpam({
					from: senderAddress,
					fromName: parsedEmail.from?.name ?? null,
					replyTo: parsedEmail.replyTo?.[0]?.address ?? null,
					subject: parsedEmail.subject ?? null,
					body: parsedEmail.text || parsedEmail.html || null,
					auth: trust.auth,
					attachmentNames: attachmentData
						.filter((att) => att.disposition !== "inline")
						.map((att) => att.filename),
					inKnownThread,
					isKnownCorrespondent: senderAddress
						? await (stub as any).hasSentTo(senderAddress)
						: false,
				});

				if (spamVerdict.isSpam) {
					targetFolder = Folders.SPAM;
					console.log(
						`Filing message for ${mailboxId} to Spam (score ${spamVerdict.score}): ` +
							spamVerdict.signals
								.filter((s) => s.weight > 0)
								.map((s) => s.id)
								.join(", "),
					);
				}
			} catch (e) {
				// Same rule as above: a scoring bug must cost us the verdict, not
				// the message.
				console.error(
					`Spam scoring failed for ${mailboxId}:`,
					(e as Error).message,
				);
				spamVerdict = null;
			}
		}
	}

	/**
	 * Local addresses: the loop guards in forwarding and auto-reply below, and
	 * the impersonation warnings just after this.
	 *
	 * Read once and before the insert. A failure degrades to an empty list rather
	 * than throwing: an unknown address is treated as external, so the guards may
	 * act where they would otherwise have declined, but stored mail is never put
	 * at risk to find out.
	 */
	let localMailboxes: string[] = [];
	try {
		localMailboxes = (await listMailboxes(env.BUCKET)).map(
			(box) => box.email ?? box.id,
		);
	} catch (e) {
		console.error(
			`Could not list mailboxes for the loop guards on ${mailboxId}:`,
			(e as Error).message,
		);
	}

	// Screener: first-time senders wait for a Yes or No. After rules, blocks,
	// mute and spam, so it only ever diverts mail bound for the Inbox. See
	// ./lib/inbound-triage.ts.
	if (!senderBlocked) {
		targetFolder = await decideInboundScreening(stub, {
			settings: mailboxSettings,
			folder: targetFolder,
			ruleFiled: !!ruleOutcome?.folder,
			senderAllowed,
			inKnownThread,
			sender: senderAddress,
			localMailboxes,
			headers: parsedEmail.headers ?? [],
			contentTypes: (parsedEmail.attachments ?? []).map((att) => att.mimeType ?? ""),
			envelopeSender: event.from ?? null,
		});
	}

	// Reader warnings, stored on the row. Never fatal: a detection bug costs the
	// warning, not the message.
	let securityWarnings: string | null = null;
	if (!senderBlocked && senderAddress) {
		try {
			const [hasReceived, hasSent, frequent] = await Promise.all([
				(stub as any).hasReceivedFrom(senderAddress) as Promise<boolean>,
				(stub as any).hasSentTo(senderAddress) as Promise<boolean>,
				(stub as any).getFrequentCorrespondents() as Promise<{ address: string; name: string | null }[]>,
			]);
			securityWarnings = serializeSenderWarnings(
				computeSenderWarnings({
					from: senderAddress,
					fromName: parsedEmail.from?.name ?? null,
					html: parsedEmail.html || null,
					hasHistory: hasReceived || hasSent,
					inKnownThread,
					sources: {
						mailboxId,
						mailboxName: mailboxSettings.fromName || null,
						localMailboxes,
						ownDomains: [...new Set([...getZones(env).map((z) => z.domain), domainOfAddress(mailboxId)])],
						frequent,
					},
				}),
			);
		} catch (e) {
			console.error(`Sender warnings failed for ${mailboxId}:`, (e as Error).message);
		}
	}

	await stub.createEmail(targetFolder, {
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(), recipient: allRecipients.join(", "),
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: resolveMessageDate(parsedEmail.date, receivedAt),
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: inboundMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
		// postal-mime has already decoded RFC 2047; `cleanSenderName` drops a
		// "name" that is only the address again.
		sender_name: cleanSenderName(parsedEmail.from?.name, parsedEmail.from?.address),
		// A rule's priority beats the sender's own header: the mailbox owner's
		// opinion about what matters outranks the sender's.
		priority: ruleOutcome?.priority ?? extractPriority(parsedEmail.headers),
		read: ruleOutcome?.markRead || threadMuted,
		starred: ruleOutcome?.star ?? false,
		// Recorded even when the verdict was "not spam": a score the user can see
		// is what makes the filter debuggable, and it is what "Not spam" clears.
		spam_score: spamVerdict?.score ?? null,
		spam_signals: spamVerdict ? serializeSpamSignals(spamVerdict.signals) : null,
		security_warnings: securityWarnings,
	}, attachmentData);

	/**
	 * Licence locked: the message is stored (above) with its rule folder and
	 * labels. Bounce, complaint and unsubscribe handling still run; they send
	 * nothing and protect recipients. AI triage, push, webhooks, forwarding,
	 * auto-reply and auto-draft are skipped: features of the locked app.
	 * `backgroundLocked` never throws, so this cannot make the handler fail
	 * and the mail bounce; an unreadable licence state counts as locked, which
	 * only skips extras.
	 */
	const licenceLocked = await backgroundLocked(env);

	// Labels need the row to exist, so they are the one part of a rule outcome
	// applied after the insert.
	if (ruleOutcome && ruleOutcome.labelIds.length > 0) {
		try {
			await stub.applyRuleLabels(messageId, ruleOutcome.labelIds);
		} catch (e) {
			console.error(
				`Applying rule labels failed for ${mailboxId}:`,
				(e as Error).message,
			);
		}
	}

	if (licenceLocked) console.log(`Licence required: stored ${messageId} for ${mailboxId}; app features skipped.`);

	// Auto-labels and the Screener verdict, queued for the mailbox alarm's
	// post-ingest job (the same run as thread summaries). After rule labels, so
	// rules win. Never throws. See ./lib/triage.ts.
	let triageQueued = false;
	if (!licenceLocked && !senderBlocked && !(ruleOutcome && ruleOutcome.labelIds.length > 0)) {
		triageQueued = schedulePostIngest(ctx, stub, mailboxId, messageId, targetFolder, mailboxSettings);
	}

	// Web Push, after storage and the triage job. Inbox mail only; the mailbox
	// holds it back until triage when a label could auto-archive it. See ./lib/push.ts.
	if (!licenceLocked && !senderBlocked) {
		schedulePushForNewMail(env, ctx, stub, {
			mailboxId, emailId: messageId, deliveredTo: route.deliveredTo, folder: targetFolder, triageQueued,
		});
	}

	if (ruleOutcome && ruleOutcome.matchedRuleIds.length > 0) {
		console.log(
			`Rules ${ruleOutcome.matchedRuleIds.join(", ")} matched for ${mailboxId}; filed to ${targetFolder}.`,
		);
	}

	// `message.received` webhook, after rule labels so the payload carries them.
	// Not for blocked senders: the user asked never to see them. Other spam is
	// sent, flagged `spam: true`, so receivers can filter. Background and never
	// throws, so it cannot re-run this handler.
	if (!licenceLocked && !senderBlocked) {
		ctx.waitUntil(stub.emitReceivedWebhook(messageId, mailboxId).catch(() => {}));
	}

	/**
	 * Bounce correlation.
	 *
	 * Deliberately after the insert, and with no `return`: a delivery-status
	 * notification is stored and delivered like any other message. Swallowing it
	 * would leave the user with a message marked "bounced" and no way to read the
	 * remote server's actual words, which is the only thing that says whether the
	 * address was wrong, the mailbox was full, or a policy rejected it.
	 *
	 * The raw message is what gets parsed rather than `parsedEmail.text`. The
	 * machine-readable fields live in a `message/delivery-status` part and the
	 * original's headers in a `message/rfc822` part, neither of which postal-mime
	 * surfaces as body text — reading only the text would find the human-readable
	 * preamble and none of the fields worth having.
	 *
	 * Failures here are logged and swallowed. This runs after the message is
	 * durably stored, and a throw would re-run the whole handler: Cloudflare
	 * retries the email handler, so a bug in bounce parsing would cost us inbound
	 * mail. Not knowing what a bounce said is much cheaper than that.
	 */
	let complianceBounce: { status: string | null; recipient: string | null; matchedSentRow: boolean } | null | undefined;
	try {
		const dsnHeaders: Record<string, string | undefined> = {};
		for (const h of parsedEmail.headers ?? []) {
			if (h.key) dsnHeaders[h.key.toLowerCase()] = h.value;
		}

		const isDsn = isDeliveryStatusNotification({
			headers: dsnHeaders,
			// postal-mime files parts it does not treat as body — including
			// `message/delivery-status` — as attachments, so this is where an
			// enumerable part list comes from.
			contentTypes: (parsedEmail.attachments ?? []).map((att) => att.mimeType ?? ""),
			sender: senderAddress,
			envelopeSender: event.from ?? null,
		});

		if (isDsn) {
			complianceBounce = null;
			const rawText = new TextDecoder("utf-8", { fatal: false }).decode(rawEmail);
			const report = parseDsn(rawText);

			if (report.permanent) {
				const originalId = extractOriginalMessageId(rawText);
				const marked = await stub.markBounced(
					originalId,
					describeDsnFailure(report),
					report.recipient,
				);
				complianceBounce = { status: report.status, recipient: report.recipient, matchedSentRow: !!marked };
				console.log(
					marked
						? `Bounce for ${mailboxId}: marked ${marked.emailId} as bounced (${report.status ?? report.action}).`
						: `Bounce for ${mailboxId} reports <${originalId ?? "unknown"}>, which this mailbox did not send; stored as ordinary mail.`,
				);
			} else {
				// A 4.x.x delay is not a failure yet — the message may still arrive,
				// and marking it bounced is a claim the user cannot undo.
				console.log(
					`Delivery notification for ${mailboxId} is not a permanent failure (${report.status ?? report.action ?? "no status"}); stored without marking.`,
				);
			}
		}
	} catch (e) {
		console.error(
			`Bounce correlation failed for ${mailboxId}:`,
			(e as Error).message,
		);
	}

	// Feedback-loop (ARF) spam complaints: a permanent `complaint` suppression for
	// the recipient of the message the report names. After storage, never throws.
	// See ./lib/inbound-compliance.ts.
	ctx.waitUntil(onFeedbackReportForCompliance(env, {
		mailboxId,
		headers: Object.fromEntries((parsedEmail.headers ?? []).map((h) => [(h.key ?? "").toLowerCase(), h.value])),
		contentTypes: (parsedEmail.attachments ?? []).map((att) => att.mimeType ?? ""),
		raw: rawEmail,
		senderAuthenticated: trust.authenticated,
		// The original's sender picks the mailbox (a report may arrive at abuse@);
		// only addresses that are mailboxes here are consulted.
		stubFor: async (address) =>
			address === mailboxId
				? (stub as unknown as ComplaintStub)
				: (await env.BUCKET.head(`mailboxes/${address}.json`))
					? (env.MAILBOX.get(env.MAILBOX.idFromName(address)) as unknown as ComplaintStub)
					: null,
	}));

	// Hard-bounce suppression, mailto unsubscribe and sequence stop-on-reply.
	// After storage, never throws. See ./lib/inbound-compliance.ts.
	ctx.waitUntil(onInboundForCompliance(env, {
		mailboxId,
		sender: senderAddress,
		subject: parsedEmail.subject,
		header: (name) => (parsedEmail.headers ?? []).find((h) => (h.key ?? "").toLowerCase() === name)?.value ?? undefined,
		// `undefined`: not a DSN. `null`: a DSN that is not an actionable failure.
		bounce: complianceBounce,
		// Gates unsubscribe-by-email: a forged From must not suppress a third party.
		senderAuthenticated: trust.authenticated,
	}));

	// Blocked mail skips both forwarding and the auto-draft agent: no point
	// relaying, or spending AI tokens drafting a reply to, something the user
	// asked never to see.
	if (senderBlocked) return;

	// Licence locked: no forwarding, auto-reply or auto-draft. Bounce, complaint
	// and unsubscribe handling above still ran: they protect recipients and send
	// nothing, and they keep held sends correct for when the licence returns.
	if (licenceLocked) return;

	// Forwarding runs after the message is durably stored, so a provider failure
	// can never cost us received mail. Dispatched through `waitUntil` because the
	// inbound handler must not wait on an outbound round trip.
	const forwardDecision = decideForward({
		settings: mailboxSettings.forwarding,
		mailboxId,
		localMailboxes,
		inboundHeaderKeys: (parsedEmail.headers ?? []).map((h) => h.key ?? ""),
	});

	if (forwardDecision.skip && forwardDecision.skip !== "disabled") {
		console.log(
			`Not forwarding message for ${mailboxId}: ${forwardDecision.skip}`,
		);
	}

	// Not for mail whose authentication failed: forwarding it relays a forgery
	// under this mailbox's name to someone who trusts this mailbox.
	if (forwardDecision.target && trust.failed) {
		console.log(`Not forwarding message for ${mailboxId}: sender authentication failed`);
	} else if (forwardDecision.target) {
		const target = forwardDecision.target;
		ctx.waitUntil(
			forwardInboundMessage({
				binding: env.EMAIL,
				env,
				mailboxId,
				mailboxName: mailboxSettings.fromName || null,
				target,
				parsed: parsedEmail,
				to: allRecipients,
				cc: ccRecipients,
			}).catch((e) =>
				console.error(
					`Forwarding to ${target} failed for ${mailboxId}:`,
					(e as Error).message,
				),
			),
		);
	}

	/**
	 * Vacation auto-reply.
	 *
	 * Runs after storage and forwarding, and only for mail a human is expected to
	 * read: a muted thread or a message a rule filed away is not something the
	 * sender should get an "I'm away" notice about.
	 *
	 * `decideAutoReply` refuses mailing lists, bounces and other responders; the
	 * mailbox additionally rations one reply per correspondent per cooldown
	 * window. Both are needed — the header checks stop loops with well-behaved
	 * systems, the cooldown stops them with everything else.
	 */
	if (!threadMuted && !ruleOutcome?.folder) {
		const headerFor = (key: string) =>
			(parsedEmail.headers ?? []).find(
				(h) => (h.key ?? "").toLowerCase() === key,
			)?.value ?? undefined;

		const autoReply = decideAutoReply({
			settings: mailboxSettings.autoReply,
			mailboxId,
			sender: senderAddress,
			headerKeys: (parsedEmail.headers ?? []).map((h) => h.key ?? ""),
			header: headerFor,
			localMailboxes,
		});

		if (autoReply.skip && autoReply.skip !== "disabled") {
			console.log(
				`Not auto-replying for ${mailboxId}: ${autoReply.skip}`,
			);
		}

		// Only to an authenticated sender. A forged From would make this mailbox
		// mail an innocent third party on a spammer's behalf (backscatter).
		if (autoReply.target && !trust.authenticated) {
			console.log(`Not auto-replying for ${mailboxId}: sender not authenticated`);
		} else if (autoReply.target) {
			const target = autoReply.target;
			const settings = mailboxSettings.autoReply;
			ctx.waitUntil(
				(async () => {
					// Claimed inside waitUntil so the inbound handler is not held up,
					// but before the send so two concurrent messages cannot both win.
					if (!(await stub.claimAutoReply(target))) {
						console.log(
							`Auto-reply to ${target} suppressed: already sent recently.`,
						);
						return;
					}

					const message = settings.message.trim();
					const autoReplyHeaders: Record<string, string> = {
						"Auto-Submitted": "auto-replied",
						"X-Auto-Response-Suppress": "All",
						...(inboundMessageId ? { "In-Reply-To": `<${inboundMessageId}>` } : {}),
					};
					// Automated mail: any suppression (an unsubscribe included) stops
					// it, and it counts against the mailbox's caps.
					const gate = await preSend(env, {
						kind: "automated",
						from: mailboxId,
						mailboxId,
						to: target,
						text: message,
						html: textToHtml(message),
						headers: autoReplyHeaders,
					});
					if (!gate.ok) {
						console.log(`Auto-reply to ${target} not sent: ${gate.error}`);
						return;
					}
					await sendEmail(env.EMAIL, {
						to: target,
						from: mailboxSettings.fromName
							? { email: mailboxId, name: mailboxSettings.fromName }
							: mailboxId,
						subject: autoReply.subject ?? "Automatic reply",
						text: message,
						// Same helper the agent and reply paths use, so an away notice
						// keeps its line breaks in clients that strip inline styles.
						html: textToHtml(message),
						// RFC 3834: mark our own notice as automatic so the other
						// side's responder does not answer it, and we do not end up
						// in a two-machine conversation.
						headers: autoReplyHeaders,
					}, gate.clearance);
				})().catch((e) =>
					console.error(
						`Auto-reply to ${target} failed for ${mailboxId}:`,
						(e as Error).message,
					),
				),
			);
		}
	}

	if (!autoDraftEnabled) {
		console.log(`Auto-draft disabled for ${mailboxId}; skipping agent trigger.`);
		return;
	}

	// A rule can opt a conversation out of the agent — useful for the automated
	// mail that arrives constantly and never needs a considered reply.
	if (ruleOutcome?.skipAutoDraft) {
		console.log(`A rule skipped auto-draft for message ${messageId}.`);
		return;
	}

	// Nobody wants a drafted reply to a conversation they muted.
	if (threadMuted) {
		console.log(`Thread ${threadId} is muted; skipping auto-draft.`);
		return;
	}

	/**
	 * Nothing filed away from the inbox gets a drafted reply.
	 *
	 * Spam was the gap. The blocked-sender check above returns early and says why
	 * — "no point spending AI tokens drafting a reply to something the user asked
	 * never to see" — but the spam verdict only assigns `targetFolder` and falls
	 * through, so every junk message still cost three to four model calls to draft
	 * a reply into a folder nobody opens.
	 *
	 * Phrased against `targetFolder` rather than the spam verdict specifically, so
	 * any future rule that files a message out of the inbox inherits the same
	 * behaviour instead of needing its own gate.
	 */
	if (targetFolder !== Folders.INBOX) {
		console.log(
			`Message ${messageId} was filed to ${targetFolder}; skipping auto-draft.`,
		);
		return;
	}

	// Robots get no drafted reply: bounces, list mail, noreply senders and
	// anything marked Auto-Submitted / Precedence: bulk. See `autoDraftSkipReason`.
	const draftSkip = autoDraftSkipReason({
		headers: Object.fromEntries(
			(parsedEmail.headers ?? [])
				.filter((h) => h.key)
				.map((h) => [h.key!.toLowerCase(), h.value]),
		),
		sender: senderAddress,
		envelopeSender: event.from ?? null,
		contentTypes: (parsedEmail.attachments ?? []).map((att) => att.mimeType ?? ""),
		folder: targetFolder,
	});
	if (draftSkip) {
		console.log(`Message ${messageId} is automated (${draftSkip}); skipping auto-draft.`);
		return;
	}

	const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
	ctx.waitUntil(agentStub.fetch(new Request("https://agents/onNewEmail", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, emailId: messageId, sender: (parsedEmail.from?.address || "").toLowerCase(), subject: parsedEmail.subject || "", threadId }),
	})).catch((e) => console.error("Auto-draft trigger failed:", (e as Error).message)));
}

// ==================== V2 API: Templates ====================

app.get("/api/v1/templates", async (c) => {
	const list = await templates.listTemplates(c.env.BUCKET);
	return c.json(list);
});

app.get("/api/v1/templates/:slug", async (c) => {
	const slug = c.req.param("slug")!;
	const template = await templates.getTemplate(c.env.BUCKET, slug);
	if (!template) return c.json({ error: "Template not found" }, 404);
	return c.json(template);
});

app.post("/api/v1/templates", async (c) => {
	const body = CreateTemplateBody.parse(await c.req.json());
	try {
		const template = await templates.createTemplate(c.env.BUCKET, body);
		return c.json(template, 201);
	} catch (e) {
		if ((e as Error).message.includes("already exists")) {
			return c.json({ error: "Template with this slug already exists" }, 409);
		}
		throw e;
	}
});

app.put("/api/v1/templates/:slug", async (c) => {
	const slug = c.req.param("slug")!;
	const body = UpdateTemplateBody.parse(await c.req.json());
	const template = await templates.updateTemplate(c.env.BUCKET, slug, body);
	if (!template) return c.json({ error: "Template not found" }, 404);
	return c.json(template);
});

app.delete("/api/v1/templates/:slug", async (c) => {
	const slug = c.req.param("slug")!;
	const deleted = await templates.deleteTemplate(c.env.BUCKET, slug);
	if (!deleted) return c.json({ error: "Template not found" }, 404);
	return c.json({ success: true });
});

// ==================== V2 API: Sequences ====================

app.get("/api/v1/sequences", async (c) => {
	const list = await sequences.listSequences(c.env.BUCKET);
	return c.json(list);
});

app.get("/api/v1/sequences/:id", async (c) => {
	const id = c.req.param("id")!;
	const sequence = await sequences.getSequence(c.env.BUCKET, id);
	if (!sequence) return c.json({ error: "Sequence not found" }, 404);
	return c.json(sequence);
});

app.post("/api/v1/sequences", async (c) => {
	const body = CreateSequenceBody.parse(await c.req.json());
	const sequence = await sequences.createSequence(c.env.BUCKET, body);
	return c.json(sequence, 201);
});

app.put("/api/v1/sequences/:id", async (c) => {
	const id = c.req.param("id")!;
	const body = UpdateSequenceBody.parse(await c.req.json());
	const sequence = await sequences.updateSequence(c.env.BUCKET, id, body);
	if (!sequence) return c.json({ error: "Sequence not found" }, 404);
	return c.json(sequence);
});

app.delete("/api/v1/sequences/:id", async (c) => {
	const id = c.req.param("id")!;
	const deleted = await sequences.deleteSequence(c.env.BUCKET, id);
	if (!deleted) return c.json({ error: "Sequence not found" }, 404);
	return c.json({ success: true });
});

// Sequence Enrollments
/** Send as or on behalf of `mailbox`: what enrolling or unenrolling needs. */
function canSendFrom(principal: MailboxContext["Variables"]["principal"], mailbox: string): boolean {
	return canDo(principal, mailbox, "sendAs") || canDo(principal, mailbox, "sendOnBehalf");
}

app.get("/api/v1/sequences/:id/enrollments", async (c) => {
	const id = c.req.param("id")!;
	const enrollments = await sequences.listEnrollmentsWithDetails(c.env.BUCKET, id);
	// Only enrollments sent from a mailbox the caller (and their token's
	// allowlist) can reach: each carries recipients and scheduled content.
	return c.json(enrollments.filter((e) => canAccessMailbox(c.var.principal, e.fromAddress)));
});

app.post("/api/v1/sequences/:id/enroll", async (c) => {
	const sequenceId = c.req.param("id")!;
	const body = EnrollBody.parse(await c.req.json());

	/**
	 * `fromAddress` decides which mailbox the drip steps are sent as, and the
	 * cron dispatcher acts on it later with no caller attached. Without this
	 * check a member could enroll a contact "from" a mailbox they were never
	 * granted and have the scheduler send it for them — the grant model bypassed
	 * by a field in a request body.
	 */
	// Reaching the mailbox is not enough: enrolling schedules sends from it, so
	// it needs a send capability (a viewer could enroll before). `canDo` also
	// applies a token's scopes and mailbox allowlist.
	if (!canSendFrom(c.var.principal, body.fromAddress)) {
		return c.json(
			{ error: "You do not have permission to send from that mailbox" },
			403,
		);
	}

	/**
	 * Enrolling schedules mail the cron dispatcher sends later with no caller,
	 * so an API token or OAuth grant passes the pre-send gate (and its approval
	 * rule) now. A hold stores the sequence and every rendered step for the
	 * preview; approving enrolls exactly this request.
	 */
	const enrollActor = requestActor(c);
	if (actorNeedsGate(enrollActor)) {
		const preview = await previewEnrollment(c.env, {
			sequenceId,
			personId: body.personId,
			personEmail: body.personEmail,
			personName: body.personName ?? null,
			fromAddress: body.fromAddress,
			variables: body.variables,
			skipSteps: body.skipSteps,
			delayOverrides: body.delayOverrides,
		});
		if (!preview) return c.json({ error: "Sequence not found" }, 404);
		const gate = await preSend(c.env, {
			kind: "bulk",
			from: body.fromAddress,
			mailboxId: body.fromAddress.toLowerCase(),
			to: body.personEmail,
			// Each step is counted against the cap when it is sent.
			quotaChecked: true,
			actor: enrollActor,
			hold: { action: "sequence_enroll", subject: `Sequence: ${preview.sequenceName}`, payload: { enrollment: preview } satisfies HoldPayload },
		});
		if (!gate.ok) return c.json(...httpRefusal(gate));
	}

	try {
		const result = await sequences.enrollPerson(c.env.BUCKET, {
			sequenceId,
			personId: body.personId,
			personEmail: body.personEmail,
			personName: body.personName ?? null,
			// Delay overrides are keyed by step order as a string, matching how
			// enrollPerson looks them up.
			fromAddress: body.fromAddress,
			variables: body.variables,
			skipSteps: body.skipSteps,
			delayOverrides: body.delayOverrides,
		});
		return c.json(result, 201);
	} catch (e) {
		const msg = (e as Error).message;
		if (msg.includes("already enrolled")) {
			return c.json({ error: msg }, 409);
		}
		if (msg.includes("not found")) {
			return c.json({ error: msg }, 404);
		}
		throw e;
	}
});

app.get("/api/v1/sequences/people/:personId/enrollment", async (c) => {
	const personId = c.req.param("personId")!;
	const found = await sequences.getPersonEnrollment(c.env.BUCKET, personId);
	// Same allowlist as the enrollment list: hide one from an unreachable mailbox.
	const enrollment = found && canAccessMailbox(c.var.principal, found.fromAddress) ? found : null;

	if (!enrollment) {
		return c.json({ enrollment: null, scheduledEmails: [], sequenceName: null });
	}
	
	const sequence = await sequences.getSequence(c.env.BUCKET, enrollment.sequenceId);
	const scheduledEmails = await sequences.listScheduledEmails(c.env.BUCKET, enrollment.id);
	
	return c.json({
		enrollment,
		scheduledEmails,
		sequenceName: sequence?.name ?? null,
	});
});

app.delete("/api/v1/sequences/enrollments/:enrollmentId", async (c) => {
	const enrollmentId = c.req.param("enrollmentId")!;
	// Unenrolling cancels sends from the enrollment's mailbox, so it needs the
	// same authority as enrolling. Unknown and unauthorized look the same.
	const existing = await sequences.getEnrollment(c.env.BUCKET, enrollmentId);
	if (!existing || !canAccessMailbox(c.var.principal, existing.fromAddress)) {
		return c.json({ error: "Enrollment not found" }, 404);
	}
	if (!canSendFrom(c.var.principal, existing.fromAddress)) {
		return c.json({ error: "You do not have permission to send from that mailbox" }, 403);
	}
	const cancelled = await sequences.cancelEnrollment(c.env.BUCKET, enrollmentId);
	if (!cancelled) return c.json({ error: "Enrollment not found" }, 404);
	return c.json({ success: true });
});

// -- Deployment consolidation (temporary) ---------------------------

// Routes for copying mailbox data out of a retired per-domain deployment.
// Inert unless both MIGRATION_TOKEN and the LEGACY_MAILBOX binding are set.
//
// Mounted under its own prefix, never "/". The router gates itself with a
// `use("*")` middleware that 404s when MIGRATION_TOKEN is unset, and Hono scopes
// a sub-app's middleware to its mount path. Mounted at the root that gate
// matched every path, including the React Router catch-all in workers/app.ts,
// ── Analytics ─────────────────────────────────────────────────────────────────
// Aggregates delivery stats across all mailboxes the caller can see.
app.get("/api/v1/analytics", async (c) => {
	const days = Number(c.req.query("days") ?? 30);
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	const visible = visibleMailboxes(c.var.principal, allMailboxes, (m) => m.email);

	const results = await Promise.all(
		visible.map(async (m) => {
			const id = c.env.MAILBOX.idFromName(m.email);
			const stub = c.env.MAILBOX.get(id) as any;
			const stats = await stub.getAnalytics({ days });
			return { mailbox: m.email, ...stats };
		}),
	);

	// Aggregate totals
	const totals = results.reduce(
		(acc, r) => ({
			total: acc.total + r.total,
			delivered: acc.delivered + r.delivered,
			failed: acc.failed + r.failed,
			bounced: acc.bounced + r.bounced,
			pending: acc.pending + r.pending,
		}),
		{ total: 0, delivered: 0, failed: 0, bounced: 0, pending: 0 },
	);

	// Merge byDate across mailboxes
	const dateMap = new Map<string, { date: string; sent: number; delivered: number; failed: number }>();
	for (const r of results) {
		for (const d of r.byDate) {
			const existing = dateMap.get(d.date);
			if (existing) {
				existing.sent += d.sent;
				existing.delivered += d.delivered;
				existing.failed += d.failed;
			} else {
				dateMap.set(d.date, { ...d });
			}
		}
	}
	const byDate = [...dateMap.values()].sort((a, b) => a.date.localeCompare(b.date));

	return c.json({ totals, byDate, mailboxes: results.map(({ byDate: _, ...r }) => r) });
});

// so the whole UI answered `{"error":"Not found"}`. See test/migrate-mount.test.ts.
//
// Admin-only on top of the token. These routes copy whole mailboxes out of the
// legacy deployment, which is not something a member holding a grant on one
// mailbox should be able to do just because they also learned the token. The
// wildcard covers the bare prefix as well; when ADMIN_EMAILS is unset every
// authenticated caller is still an admin, so a migration in progress is
// unaffected.
// Outbound webhooks. Authorization lives in ./lib/webhooks.ts.
app.route("/api/v1/webhooks", webhooks);
// Agent inboxes and the realtime event stream. See ./routes/agent-inboxes.ts, ./routes/events.ts.
app.route("/api/v1/agent-inboxes", agentInboxRoutes);
app.route("/api/v1/events", eventsRoutes);

app.use("/api/v1/_migrate/*", requireAdmin);
app.route("/api/v1/_migrate", migrate);

// GET /api/v1/openapi.json and GET /api/docs. Public; see workers/routes/openapi.ts.
app.route("/", openApiRoutes);
// Suppression list and template sends. See ./routes/suppressions.ts.
app.route("/", suppressionRoutes);
// Agent and MCP sends waiting for approval. See ./routes/approvals.ts.
app.route("/", approvalRoutes);
// Analytics console (overview, engagement, inbound, DMARC). See ./routes/analytics.ts.
app.route("/", analyticsRoutes);
app.route("/", usageRoutes);
// Follow-up reminders: awaiting-reply list, set and cancel. See ./routes/followups.ts.
app.route("/", followupRoutes);
// AI thread summaries and the daily brief. See workers/routes/assistant.ts.
app.route("/", assistantRoutes);
// Products (per-domain identity) and the unified inbox. See ./routes/products.ts.
app.route("/", productRoutes);
// Tracking toggles, privacy notice settings, account export and deletion. See ./routes/privacy.ts.
app.route("/", privacyRoutes);
// Spam-rate circuit breaker and per-mailbox send caps. See ./routes/sending-health.ts.
app.route("/", sendingHealthRoutes);
// AI triage (label prompts, presets, tabs, backfill) and the Screener. See ./routes/triage.ts.
app.route("/", triageRoutes);
// Web Push: VAPID key, devices, preferences, test. See ./routes/push.ts.
app.route("/", pushRoutes);
// Semantic search and "Ask my inbox". See ./routes/semantic.ts.
app.route("/", semanticRoutes);

// The app licence: status, activate, refresh, deactivate. See ./routes/licence.ts.
app.route("/", licenceRoutes);
// Mail import (mbox, zip of .eml, .eml, IMAP). See ./routes/import.ts.
app.route("/", importRoutes);
// Bring-your-own AI gateway settings. See workers/routes/ai-providers.ts.
app.route("/", aiProviderRoutes);
// Settings → Cloudflare connection (admin; writes need a fresh session).
app.route("/", cloudflareRoutes);
// Cloudflare onboarding: discover, plan, apply, change log (admin; apply/revert need a fresh session).
app.route("/", cloudflareSetupRoutes);

export { app, receiveEmail };
