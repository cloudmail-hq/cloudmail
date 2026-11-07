// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The OpenAPI 3.1 description of the `/api/v1` HTTP surface.
 *
 * Hand-written rather than generated: the routes validate with zod inline and
 * Hono keeps no schema metadata, so there is nothing to generate from. Drift is
 * caught by `test/openapi.test.ts`, which walks `app.routes` and fails when a
 * route is missing here or an operation here has no route.
 *
 * `x-token-scope` comes from `requiredTokenScope` (the guard that enforces it)
 * wherever that names a scope. Where the guard defers to the mailbox capability
 * gates (`"mailbox"`), the scope is the one that capability maps to, which is
 * what `authz.ts` intersects the token's scopes with.
 */

import type { MailboxCapability } from "./capabilities";
import { requiredTokenScope } from "./token-scope-guard";
import { TOKEN_SCOPES, type TokenScope } from "../../shared/token-scopes";
import { WEBHOOK_EVENT_TYPES } from "../../shared/webhooks";
import { SENDER_KINDS, TRIAGE_PRESET_KEYS } from "../../shared/ai-triage";
import { AGENT_SEND_MODES } from "../../shared/agent-inboxes";
import { IDEMPOTENT_PATHS } from "./idempotency-routes";
import { AI_ROLES } from "../../shared/ai-providers";
import { CF_CAPABILITY_NAMES } from "../../shared/cf-connection";
import { PLAN_ITEM_KINDS } from "../../shared/cf-setup";

// -- Minimal OpenAPI 3.1 types ----------------------------------------

export interface SchemaObject {
	$ref?: string;
	type?: string | string[];
	format?: string;
	description?: string;
	properties?: Record<string, SchemaObject>;
	required?: string[];
	items?: SchemaObject;
	additionalProperties?: boolean | SchemaObject;
	enum?: unknown[];
	const?: unknown;
	default?: unknown;
	oneOf?: SchemaObject[];
	anyOf?: SchemaObject[];
	allOf?: SchemaObject[];
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
	minProperties?: number;
	pattern?: string;
	contentEncoding?: string;
	contentMediaType?: string;
}

export interface ParameterObject {
	name: string;
	in: "path" | "query" | "header" | "cookie";
	required?: boolean;
	description?: string;
	schema: SchemaObject;
}

export interface MediaTypeObject {
	schema: SchemaObject;
}

export interface RequestBodyObject {
	required?: boolean;
	description?: string;
	content: Record<string, MediaTypeObject>;
}

export interface HeaderObject {
	description?: string;
	schema: SchemaObject;
}

export interface ResponseObject {
	description: string;
	headers?: Record<string, HeaderObject>;
	content?: Record<string, MediaTypeObject>;
}

export interface ReferenceObject {
	$ref: string;
}

export type SecurityRequirement = Record<string, string[]>;

export type ApiTokenScope = TokenScope | "any";

export interface OperationObject {
	operationId: string;
	tags: string[];
	summary: string;
	description?: string;
	parameters?: ParameterObject[];
	requestBody?: RequestBodyObject;
	responses: Record<string, ResponseObject | ReferenceObject>;
	security?: SecurityRequirement[];
	"x-token-scope": ApiTokenScope;
	/** Mailbox capabilities the path gate checks; any one of them suffices. */
	"x-mailbox-capability"?: MailboxCapability[];
}

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type PathItemObject = Partial<Record<HttpMethod, OperationObject>>;

export interface SecuritySchemeObject {
	type: "http" | "apiKey" | "oauth2" | "openIdConnect" | "mutualTLS";
	scheme?: string;
	bearerFormat?: string;
	name?: string;
	in?: "query" | "header" | "cookie";
	description?: string;
}

export interface OpenApiDocument {
	openapi: "3.1.0";
	info: { title: string; version: string; description?: string };
	servers: { url: string; description?: string }[];
	security: SecurityRequirement[];
	tags: { name: string; description?: string }[];
	paths: Record<string, PathItemObject>;
	components: {
		schemas: Record<string, SchemaObject>;
		responses: Record<string, ResponseObject>;
		securitySchemes: Record<string, SecuritySchemeObject>;
	};
}

/** The values `x-token-scope` may take. */
export const API_TOKEN_SCOPE_VALUES: readonly ApiTokenScope[] = [...TOKEN_SCOPES, "any"];

// -- Schema helpers ---------------------------------------------------

const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });
const str = (extra: SchemaObject = {}): SchemaObject => ({ type: "string", ...extra });
const int = (extra: SchemaObject = {}): SchemaObject => ({ type: "integer", ...extra });
const num = (extra: SchemaObject = {}): SchemaObject => ({ type: "number", ...extra });
const bool = (extra: SchemaObject = {}): SchemaObject => ({ type: "boolean", ...extra });
const email = (extra: SchemaObject = {}): SchemaObject => str({ format: "email", ...extra });
const arr = (items: SchemaObject, extra: SchemaObject = {}): SchemaObject => ({
	type: "array",
	items,
	...extra,
});
const obj = (
	properties: Record<string, SchemaObject>,
	required?: string[],
	extra: SchemaObject = {},
): SchemaObject => ({
	type: "object",
	properties,
	...(required && required.length ? { required } : {}),
	...extra,
});
/** An object whose exact shape is not pinned; extra keys are expected. */
const loose = (properties: Record<string, SchemaObject> = {}, description?: string): SchemaObject => ({
	type: "object",
	...(description ? { description } : {}),
	properties,
	additionalProperties: true,
});
const nullable = (s: SchemaObject): SchemaObject =>
	typeof s.type === "string" ? { ...s, type: [s.type, "null"] } : { anyOf: [s, { type: "null" }] };
const strEnum = (values: readonly string[], extra: SchemaObject = {}): SchemaObject =>
	str({ enum: [...values], ...extra });

const MAILBOX_ROLE_VALUES = ["viewer", "agent", "manager", "owner"];
const MAILBOX_CAPABILITY_VALUES: MailboxCapability[] = [
	"read",
	"sendAs",
	"sendOnBehalf",
	"delete",
	"deletePermanently",
	"organise",
	"draft",
	"manageRules",
	"manageSettings",
	"manageDelegates",
];
const BULK_ACTIONS = [
	"read",
	"unread",
	"star",
	"unstar",
	"delete",
	"delete_permanently",
	"restore",
	"move",
	"label",
	"unlabel",
];
const HEX_COLOR_PATTERN = "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$";
const SLUG_PATTERN = "^[a-z0-9][a-z0-9-]*$";

// -- Component schemas ------------------------------------------------

const RecipientField: SchemaObject = {
	oneOf: [email(), arr(email(), { minItems: 1 })],
	description: "One address, or a non-empty list of addresses.",
};

const RuleCondition = obj(
	{
		field: strEnum(["from", "to", "cc", "recipient", "subject", "body", "has_attachment"]),
		operator: strEnum([
			"contains",
			"not_contains",
			"equals",
			"starts_with",
			"ends_with",
			"domain_is",
			"is_true",
		]),
		value: str({ maxLength: 500 }),
	},
	["field", "operator"],
);

const RuleAction = obj(
	{
		type: strEnum([
			"move_to_folder",
			"apply_label",
			"mark_read",
			"star",
			"trash",
			"set_priority",
			"skip_auto_draft",
		]),
		value: str({ maxLength: 200 }),
	},
	["type"],
);

const SequenceStep = obj(
	{
		order: int({ minimum: 1 }),
		templateSlug: str({ minLength: 1, maxLength: 100, pattern: SLUG_PATTERN }),
		delayHours: num({ minimum: 0, maximum: 24 * 365, description: "Gap after the previous step." }),
	},
	["order", "templateSlug", "delayHours"],
);

const MailboxSettingsPatch: SchemaObject = obj(
	{
		fromName: str({ description: "Display name on outgoing mail." }),
		forwarding: obj({ enabled: bool(), email: email() }, undefined, { additionalProperties: false }),
		signature: obj({ enabled: bool(), text: str(), html: str() }, undefined, {
			additionalProperties: false,
		}),
		autoReply: obj(
			{
				enabled: bool(),
				subject: str(),
				message: str(),
				startsAt: nullable(str({ description: "Start of the auto-reply window." })),
				endsAt: nullable(str({ description: "End of the auto-reply window." })),
				knownSendersOnly: bool(),
			},
			undefined,
			{ additionalProperties: false },
		),
		autoDraft: obj({ enabled: bool() }, undefined, { additionalProperties: false }),
		followups: obj(
			{
				default: strEnum(["off", "3d", "auto"], {
					description: "What a send with no `followup` field gets, and what the composer starts from.",
				}),
				draftNudge: bool({
					description: "Ask the agent to draft a short nudge when a reminder fires. Drafts only; never sends.",
				}),
			},
			undefined,
			{ additionalProperties: false },
		),
		triage: obj(
			{
				enabled: bool({ description: "AI auto-labels from label prompts, plus header heuristics." }),
				dailyAiCap: int({ minimum: 0, maximum: 5000, description: "Workers AI calls per UTC day for triage." }),
				screenerVerdict: bool({ description: "Ask the model what a screened sender looks like." }),
			},
			undefined,
			{ additionalProperties: false },
		),
		screener: strEnum(["off", "unknown_only"], {
			description: "unknown_only files mail from first-time senders into the screener folder.",
		}),
		agentSystemPrompt: str({ description: "Extra instructions for the mailbox agent." }),
	},
	undefined,
	{
		additionalProperties: false,
		description: "A partial settings update. Unknown keys are rejected.",
	},
);

const WebhookEvents = arr(strEnum(WEBHOOK_EVENT_TYPES), { minItems: 1 });
const AgentInbox = obj({
	address: email(),
	purpose: str(),
	display_name: nullable(str()),
	send_mode: strEnum(AGENT_SEND_MODES),
	allowed_recipients: nullable(arr(str({ description: "An address, or @domain for a whole domain." }))),
	token_id: nullable(str()),
	scopes: arr(strEnum(TOKEN_SCOPES)),
	webhook_id: nullable(str()),
	webhook_url: nullable(str()),
	created_by: nullable(str()),
	created_at: int({ description: "Unix ms." }),
	expires_at: nullable(int({ description: "Unix ms; null for no expiry." })),
	expired: bool(),
	expires_in_ms: nullable(int()),
});
const WebhookAttempt = obj({
	attempt: int(),
	statusCode: nullable(int()),
	durationMs: int(),
	error: nullable(str()),
	at: int({ description: "Unix ms." }),
});

const schemas: Record<string, SchemaObject> = {
	Webhook: obj({
		id: str(),
		name: str(),
		url: str({ format: "uri", description: "Public https:// endpoint." }),
		events: WebhookEvents,
		mailboxes: nullable(arr(email(), { description: "null means every mailbox (administrators only)." })),
		enabled: bool(),
		disabledReason: nullable(str({ description: "Set when the system switched the endpoint off after repeated failures." })),
		secretHint: str({ description: "Last four characters of the signing secret. The secret itself is returned only on create and rotate." }),
		createdBy: nullable(str()),
		createdAt: int(),
		updatedAt: int(),
		consecutiveFailures: int(),
		lastSuccessAt: nullable(int()),
		lastFailureAt: nullable(int()),
	}),
	WebhookDelivery: obj({
		id: str(),
		endpointId: str(),
		eventId: str(),
		eventType: strEnum(WEBHOOK_EVENT_TYPES),
		mailbox: email(),
		status: strEnum(["pending", "retrying", "delivered", "failed"]),
		attempts: int(),
		nextAttemptAt: nullable(int()),
		lastStatusCode: nullable(int()),
		lastError: nullable(str()),
		lastDurationMs: nullable(int()),
		createdAt: int(),
		updatedAt: int(),
		test: bool(),
		attemptLog: arr(WebhookAttempt),
	}),
	Product: obj(
		{
			id: str(),
			name: str(),
			slug: str(),
			domains: arr(str()),
			aliases: arr(email()),
			displayName: nullable(str()),
			accentColor: nullable(str()),
			signatureHtml: nullable(str()),
			defaultTemplates: arr(str()),
			logoUrl: nullable(str({ description: "Public, versioned URL (/p/:id/logo)." })),
			logoMimeType: nullable(str()),
			agentPrompt: nullable(str({ description: "Administrators only." })),
			knowledgeText: nullable(str({ description: "Administrators only." })),
			knowledgeUrl: nullable(str({ description: "Administrators only." })),
			knowledgeFetchedAt: nullable(int({ description: "Administrators only. Epoch ms." })),
			createdAt: int(),
			updatedAt: int(),
		},
		["id", "name", "slug", "domains", "aliases"],
	),
	Domain: obj({
		id: str(),
		hostname: str({ description: "Lower-case domain name." }),
		displayName: str(),
		zoneId: nullable(str({ description: "Cloudflare zone id (32 hex)." })),
		status: strEnum(["pending", "active", "error"]),
		routingStatus: nullable(str()),
		sendingStatus: nullable(str()),
		sendingSubdomainId: nullable(str()),
		dkim: nullable(loose({ selector: str(), name: str(), value: str() })),
		catchAllMailbox: nullable(email()),
		source: strEnum(["env", "api"], { description: "env: from DOMAINS/ZONES config; api: added at runtime." }),
		lastError: nullable(str()),
		createdAt: int(),
		updatedAt: int(),
		lastCheckedAt: nullable(int()),
		mailboxCount: int(),
	}),
	DnsRecordSpec: loose({ type: str(), name: str(), value: str(), priority: int(), purpose: str() }),
	CloudflareInfo: obj({
		configured: bool({ description: "Whether a Cloudflare token is available: CF_API_TOKEN, or the connection in Settings → Cloudflare connection." }),
		workerScriptName: str(),
	}),
	CloudflareCapability: obj(
		{
			name: strEnum(CF_CAPABILITY_NAMES),
			status: strEnum(["ok", "missing", "unknown"]),
			detail: str(),
		},
		["name", "status"],
	),
	CloudflareConnection: obj(
		{
			connected: bool(),
			state: strEnum(["none", "connected", "reconnect_required"], {
				description: "reconnect_required: a token is stored but no longer decrypts (AUTH_SECRET changed). Paste it again.",
			}),
			source: nullable(strEnum(["env", "connection"], { description: "env: the CF_API_TOKEN secret, which always wins." })),
			accountId: nullable(str()),
			accountName: nullable(str()),
			tokenKind: nullable(strEnum(["user", "account"])),
			last4: nullable(str({ description: "Last 4 characters of the token. The token itself is never returned." })),
			verifiedAt: nullable(int()),
			workerScriptName: str(),
			capabilities: arr(ref("CloudflareCapability")),
			templateUrl: str({ description: "Cloudflare dashboard link that prefills an account token with every permission this app uses." }),
		},
		["connected", "state", "source", "accountId", "accountName", "tokenKind", "last4", "verifiedAt", "workerScriptName", "capabilities", "templateUrl"],
	),
	Licence: obj(
		{
			status: strEnum(["off", "none", "active", "grace", "expired", "invalid", "revoked"], {
				description:
					"off: enforcement is off. grace: the token is past its expiry but refresh still works (not locked). none, expired, invalid and revoked lock the app.",
			}),
			locked: bool(),
			enforcement: strEnum(["enforce", "off"]),
			plan: nullable(str()),
			expiresAt: nullable(int({ description: "Unix seconds. When the current token lapses without a refresh. Licences are one-time; this is not a renewal date." })),
			lastRefreshAt: nullable(int()),
			failureCount: int(),
			graceDaysLeft: nullable(int()),
			serverReason: nullable(str()),
			customerEmail: nullable(str()),
			instances: nullable(int()),
			manageUrl: str(),
			deploymentId: str(),
			host: nullable(str()),
		},
		["status", "locked", "enforcement"],
	),
	CloudflareDnsRecordLite: obj(
		{
			id: str({ description: "Cloudflare record id, when the record exists." }),
			type: str({ description: "DNS type, or CATCH_ALL / WORKER for a routing rule or the catch-all target." }),
			name: str(),
			content: str(),
			priority: int(),
			ttl: int(),
		},
		["type", "name", "content"],
	),
	CloudflareRoutingRule: loose({ enabled: bool(), matchers: arr(loose()), actions: arr(loose()), name: str() }),
	CloudflareZoneDiscovery: obj(
		{
			zoneId: str(),
			name: str(),
			status: str({ description: "Cloudflare zone status; only `active` zones can be set up." }),
			plan: str(),
			nameServers: arr(str()),
			managed: bool({ description: "Already a domain in this app." }),
			envDomain: bool({ description: "From DOMAINS/ZONES: live, so every change needs a confirm." }),
			detail: strEnum(["list", "summary", "full"], { description: "How much was read: list (name only), summary (apex MX/SPF + routing), full." }),
			routing: nullable(obj({ enabled: bool(), status: str() }, ["enabled", "status"])),
			catchAll: nullable(ref("CloudflareRoutingRule")),
			catchAllToUs: bool(),
			sending: arr(obj({ tag: str(), name: str(), enabled: bool() }, ["tag", "name", "enabled"])),
			sendingPlanError: str(),
			sendingError: str(),
			dns: obj(
				{
					mx: arr(ref("CloudflareDnsRecordLite")),
					spf: arr(ref("CloudflareDnsRecordLite")),
					dmarc: arr(ref("CloudflareDnsRecordLite")),
					tlsRpt: arr(ref("CloudflareDnsRecordLite")),
					mtaSts: arr(ref("CloudflareDnsRecordLite")),
				},
				["mx", "spf", "dmarc", "tlsRpt", "mtaSts"],
			),
			mxProvider: strEnum(["cloudflare", "google", "microsoft", "zoho", "other", "none"]),
			spfLookups: nullable(int({ description: "DNS lookups the single apex SPF record needs; null when not counted." })),
			denied: arr(strEnum(CF_CAPABILITY_NAMES), { description: "Capabilities a call on this zone was refused for." }),
			error: str(),
		},
		["zoneId", "name", "status", "managed", "envDomain", "detail", "routing", "catchAll", "catchAllToUs", "sending", "dns", "mxProvider", "spfLookups", "denied"],
	),
	CloudflareWorkerDiscovery: obj(
		{
			configured: str(),
			source: strEnum(["env", "connection", "default"]),
			found: nullable(bool()),
			mailboxScripts: nullable(arr(str())),
			canPersist: bool(),
		},
		["configured", "source", "found", "mailboxScripts", "canPersist"],
	),
	CloudflareVectorizeDiscovery: obj(
		{
			indexName: str(),
			index: strEnum(["present", "missing", "unknown"]),
			metadataIndex: strEnum(["present", "missing", "unknown"]),
		},
		["indexName", "index", "metadataIndex"],
	),
	CloudflareDiscovery: obj(
		{
			accountId: nullable(str()),
			tokenSource: strEnum(["env", "connection"]),
			zones: arr(ref("CloudflareZoneDiscovery")),
			zoneCount: int(),
			truncated: bool(),
			worker: ref("CloudflareWorkerDiscovery"),
			vectorize: ref("CloudflareVectorizeDiscovery"),
			missingCapabilities: arr(strEnum(CF_CAPABILITY_NAMES)),
			errors: arr(str()),
			discoveredAt: int(),
			cached: bool(),
		},
		["accountId", "tokenSource", "zones", "zoneCount", "truncated", "worker", "vectorize", "missingCapabilities", "errors", "discoveredAt", "cached"],
	),
	CloudflarePlanItem: obj(
		{
			id: str({ description: "Stable: `${zoneId}:${kind}`, `account:${kind}` or `account:token_permission:${capability}`." }),
			zoneId: nullable(str()),
			hostname: nullable(str()),
			kind: strEnum(PLAN_ITEM_KINDS),
			tier: strEnum(["auto", "confirm", "manual", "done"], {
				description: "auto: additive, applied when sent. confirm: changes something the user has; needs `confirm: true`. manual: dashboard steps. done: already in place.",
			}),
			title: str(),
			detail: str(),
			before: arr(ref("CloudflareDnsRecordLite")),
			after: arr(ref("CloudflareDnsRecordLite")),
			manualSteps: arr(str()),
			dependsOn: arr(str()),
		},
		["id", "zoneId", "hostname", "kind", "tier", "title", "detail"],
	),
	CloudflarePlan: obj(
		{
			items: arr(ref("CloudflarePlanItem")),
			planHash: str({ description: "Send back with apply. Hash of each item's tier and `before` records." }),
			zones: arr(ref("CloudflareZoneDiscovery")),
			worker: ref("CloudflareWorkerDiscovery"),
			vectorize: ref("CloudflareVectorizeDiscovery"),
		},
		["items", "planHash", "zones", "worker", "vectorize"],
	),
	CloudflareApplyResult: obj(
		{
			ok: bool({ description: "Every item applied." }),
			results: arr(
				obj(
					{
						id: str(),
						status: strEnum(["ok", "skipped", "error"]),
						detail: str(),
						changeIds: arr(str({ description: "Change log ids this item wrote." })),
					},
					["id", "status", "detail"],
				),
			),
		},
		["ok", "results"],
	),
	CloudflareDnsChange: obj(
		{
			id: str(),
			zoneId: str(),
			zoneName: nullable(str()),
			recordType: str({ description: "DNS type, or catch_all." }),
			name: str(),
			action: strEnum(["create", "update", "delete"]),
			before: { description: "The exact record or rule before; null for a create." },
			after: { description: "The exact record or rule after; null for a delete." },
			planItem: nullable(str()),
			appliedAt: int(),
			appliedBy: nullable(str()),
			revertedAt: nullable(int()),
			revertedBy: nullable(str()),
		},
		["id", "zoneId", "zoneName", "recordType", "name", "action", "before", "after", "planItem", "appliedAt", "appliedBy", "revertedAt", "revertedBy"],
	),
	Error: obj({ error: str() }, ["error"]),
	ValidationError: obj(
		{
			error: str(),
			details: arr(obj({ path: str(), message: str() }, ["path", "message"])),
		},
		["error"],
		{ description: "Returned when a request body fails validation." },
	),
	Status: obj({ status: str() }, ["status"]),
	Success: obj({ success: bool() }, ["success"]),
	Affected: obj({ affected: int() }, ["affected"]),
	Attachment: obj(
		{
			id: str(),
			filename: str(),
			mimetype: str(),
			size: int(),
			content_id: str(),
			disposition: str(),
			blocked: { type: ["boolean", "integer"], description: "Refused at delivery; no blob stored." },
		},
		["id", "filename", "mimetype", "size"],
	),
	AttachmentPayload: obj(
		{
			content: str({ contentEncoding: "base64", description: "Base64 file contents." }),
			filename: str({ description: "Executable and other blocked types are refused with 400." }),
			type: str({ description: "MIME type." }),
			disposition: strEnum(["attachment", "inline"]),
			contentId: str(),
		},
		["content", "filename", "type", "disposition"],
	),
	Email: {
		...loose(
			{
				id: str(),
				thread_id: nullable(str()),
				folder_id: nullable(str()),
				subject: str(),
				sender: str(),
				recipient: str(),
				cc: str(),
				bcc: str(),
				date: str({ format: "date-time" }),
				read: bool(),
				starred: bool(),
				body: nullable(str()),
				snippet: nullable(str()),
				summary_line: str({
					maxLength: 120,
					description:
						"AI one-line summary of the conversation, on list rows when generated. Plain text; never for Spam or Trash.",
				}),
				summary_status: strEnum(["blocked", "skipped"], {
					description: 'Present when summary_line is not a normal summary ("blocked": injection guard tripped).',
				}),
				in_reply_to: nullable(str()),
				message_id: nullable(str()),
				priority: nullable(strEnum(["high", "low"])),
				snoozed_until: nullable(str()),
				delivery_status: nullable(strEnum(["queued", "sent", "delivered", "failed", "bounced"])),
				// Engagement cache for mail this mailbox sent. "Opened" means the
				// tracking image loaded, which privacy proxies can trigger; it is not
				// proof the message was read. One pixel is shared by every recipient
				// of a multi-recipient message, so these count the message.
				opened_at: nullable(str({ format: "date-time", description: "First recorded open." })),
				last_opened_at: nullable(str({ format: "date-time", description: "Latest recorded open." })),
				open_count: int(),
				open_proxy_count: int(),
				clicked_at: nullable(str({ format: "date-time", description: "First tracked link click." })),
				click_count: int(),
				attachments: arr(ref("Attachment")),
				has_attachment: bool(),
				thread_count: int(),
				thread_unread_count: int(),
			},
			"A message. List views omit the body and attachments; thread aggregates appear only in threaded lists.",
		),
		required: ["id", "subject", "sender", "recipient", "date", "read", "starred"],
	},
	EmailPage: obj({ emails: arr(ref("Email")), totalCount: int() }, ["emails", "totalCount"]),
	DeliveryEvent: obj(
		{
			id: int(),
			email_id: str(),
			recipient: nullable(str()),
			event_type: str(),
			source: str(),
			provider_message_id: nullable(str()),
			error_cause: nullable(str()),
			error_detail: nullable(str()),
			metadata: nullable(str({ description: "Raw JSON string." })),
			occurred_at: str(),
			created_at: str(),
		},
		["id", "email_id", "event_type", "source", "occurred_at"],
	),
	SendEmailRequest: obj(
		{
			to: RecipientField,
			cc: RecipientField,
			bcc: RecipientField,
			from: {
				oneOf: [email(), obj({ email: email(), name: str() }, ["email", "name"])],
				description: "Must be the mailbox address in the path.",
			},
			subject: str(),
			html: str(),
			text: str(),
			attachments: arr(ref("AttachmentPayload")),
			in_reply_to: str(),
			references: arr(str()),
			thread_id: str(),
			transactional: bool({
				description:
					"false marks bulk mail: suppressed recipients are dropped (422 when no To is left) and a single-recipient send gets RFC 8058 List-Unsubscribe headers. Default transactional.",
			}),
			list: bool({ description: "Shorthand for transactional: false." }),
			track: bool({
				description:
					"false sends this message without open/click tracking. Omit to follow the mailbox setting; true cannot override a mailbox that has tracking off or a recipient who opted out.",
			}),
			followup: ref("FollowupRequest"),
		},
		["to", "from", "subject"],
		{ description: "At least one of `html` or `text` is required." },
	),
	TrackingSettings: obj(
		{
			openTracking: bool(),
			clickTracking: bool(),
			attachmentTracking: bool(),
			disclosureEnabled: bool({ description: "Append a short tracking disclosure line to tracked mail." }),
			disclosureText: nullable(str({ maxLength: 300, description: "Null means the default wording." })),
		},
		["openTracking", "clickTracking", "attachmentTracking", "disclosureEnabled", "disclosureText"],
	),
	RetentionPolicy: obj(
		{
			trackingEventsDays: int({ minimum: 1, maximum: 3650 }),
			deliveryEventsDays: int({ minimum: 1, maximum: 3650 }),
			agentChatDays: int({ minimum: 1, maximum: 3650 }),
			auditLogDays: int({ minimum: 365, maximum: 3650 }),
			trashDays: int({ minimum: 1, maximum: 365 }),
		},
		["trackingEventsDays", "deliveryEventsDays", "agentChatDays", "auditLogDays", "trashDays"],
	),
	PrivacySettings: obj(
		{
			controllerName: str(),
			controllerContact: str(),
			grievanceOfficerName: str(),
			grievanceOfficerEmail: str(),
			dataLocation: str(),
			additionalText: str(),
			trackingDefault: bool({ description: "Whether new mailboxes start with tracking on." }),
			retention: ref("RetentionPolicy"),
			updatedAt: int({ description: "Epoch ms; 0 when never saved." }),
		},
		["controllerName", "controllerContact", "grievanceOfficerName", "grievanceOfficerEmail", "dataLocation", "additionalText", "trackingDefault", "retention", "updatedAt"],
	),
	AccountExport: obj(
		{
			id: str(),
			status: strEnum(["pending", "running", "ready", "failed"]),
			size: nullable(int()),
			error: nullable(str()),
			createdAt: int(),
			completedAt: nullable(int()),
			expiresAt: int(),
			downloadUrl: nullable(str({ description: "Signed link, valid 24 h, for the signed-in owner only." })),
		},
		["id", "status", "createdAt", "expiresAt", "downloadUrl"],
	),
	FollowupRequest: obj(
		{
			mode: strEnum(["off", "manual", "auto"]),
			delay_seconds: int({
				minimum: 1,
				maximum: 90 * 24 * 60 * 60,
				description: "manual only: seconds after the message goes out (its send_at, for a queued send).",
			}),
			at: str({ format: "date-time", description: "manual only: an absolute time instead of delay_seconds." }),
		},
		["mode"],
		{
			additionalProperties: false,
			description:
				"Remind me if no reply. Omit to use the mailbox default (settings.followups.default). " +
				"auto runs a yes/no classifier on the message (quoted text stripped) and sets a 3-day reminder only " +
				"when it asks a question or requests an action; on classifier error no reminder is set. Set in the " +
				"background after the send is accepted, so it never fails a send.",
		},
	),
	ImportJob: obj(
		{
			id: str(),
			source: strEnum(["mbox", "zip", "eml", "imap"]),
			status: strEnum(["uploading", "queued", "running", "paused", "completed", "failed", "cancelled"]),
			label: str({ description: "Upload filename, or user@host for IMAP." }),
			created_at: str({ format: "date-time" }),
			updated_at: str({ format: "date-time" }),
			started_at: nullable(str({ format: "date-time" })),
			finished_at: nullable(str({ format: "date-time" })),
			size_bytes: nullable(int()),
			upload: nullable(
				obj(
					{ part_size: int(), parts_uploaded: int(), parts_total: int() },
					["part_size", "parts_uploaded", "parts_total"],
				),
			),
			counts: obj(
				{ imported: int(), duplicates: int(), failed: int(), skipped: int() },
				["imported", "duplicates", "failed", "skipped"],
			),
			progress: obj(
				{
					done: int(),
					total: nullable(int()),
					unit: strEnum(["bytes", "messages"]),
				},
				["done", "total", "unit"],
			),
			last_error: nullable(str()),
			imap: nullable(
				obj({
					host: str(),
					username: str(),
					folders_total: int(),
					folders_done: int(),
					current_folder: nullable(str()),
				}),
			),
		},
		["id", "source", "status", "label", "counts", "progress"],
		{
			description:
				"A mail import. Never carries a credential. `skipped` counts messages over 25 MB and empty entries; " +
				"`duplicates` counts messages the mailbox already held (by Message-ID, or content hash when there is none).",
		},
	),
	Followup: obj(
		{
			email_id: str({ description: "The outbound message being watched." }),
			thread_id: str(),
			followup_at: str({ format: "date-time", description: "When the thread returns to the Inbox if nobody replies." }),
			followup_mode: strEnum(["manual", "auto"]),
			status: strEnum(["pending", "fired", "replied", "cancelled", "done"], {
				description:
					"pending waits; fired has returned the thread to the Inbox with the Follow up label; replied, cancelled and done are closed.",
			}),
			duration_seconds: int({ description: "Kept so replying again yourself restarts the same clock." }),
			created_at: str(),
			fired_at: nullable(str()),
			resolved_at: nullable(str()),
			surfaced_email_id: nullable(str()),
			subject: nullable(str()),
			recipient: nullable(str()),
			sent_at: nullable(str()),
		},
		["email_id", "thread_id", "followup_at", "followup_mode", "status"],
	),
	SendAccepted: obj(
		{
			id: str(),
			status: str({ const: "sent" }),
			suppressed: arr(ref("SuppressedRecipient"), {
				description:
					"Recipients dropped by the pre-send gate: any suppression on a bulk send; a hard bounce or complaint on a transactional one.",
			}),
			suppression_warnings: arr(ref("SuppressedRecipient"), {
				description: "Transactional sends only: suppressed (unsubscribed, manual) recipients the message was still sent to.",
			}),
		},
		["id", "status"],
	),
	SuppressionInput: obj(
		{
			address: email(),
			scope: str({ description: 'Sending domain; omit or "global" for all.' }),
			reason: strEnum(["unsubscribed", "hard_bounce", "complaint", "manual"], { default: "manual" }),
		},
		["address"],
	),
	SuppressionAddResult: obj(
		{
			added: int(),
			existing: int(),
			items: arr(ref("Suppression")),
			errors: arr(obj({ index: int(), error: str() })),
		},
		["added", "existing"],
	),
	TemplateSendResult: obj(
		{
			sent: int(),
			suppressed: int(),
			failed: int(),
			results: arr(
				obj(
					{
						email: email(),
						status: strEnum(["sent", "suppressed", "failed"]),
						id: str(),
						reason: str(),
						error: str(),
					},
					["email", "status"],
				),
			),
		},
		["sent", "suppressed", "failed", "results"],
	),
	SuppressedRecipient: obj({ address: email(), reason: str(), scope: str() }, ["address", "reason", "scope"]),
	SendingDomainHealth: obj(
		{
			domain: str(),
			level: strEnum(["ok", "warning", "critical", "insufficient_volume"]),
			spam_rate: nullable(num({ description: "complaints / delivered over 7 days" })),
			complaints: int(),
			delivered: int(),
			source: nullable(strEnum(["local", "cloudflare", "local+cloudflare"])),
			provider_status: nullable(str({ description: "Cloudflare account reputation status" })),
			evaluated_at: nullable(int({ description: "Epoch ms" })),
			bulk_paused: bool(),
			paused_at: nullable(int()),
			paused_reason: nullable(str()),
			resumed_at: nullable(int()),
			resumed_by: nullable(str()),
			notified_level: nullable(str()),
		},
		["domain", "level", "bulk_paused"],
	),
	UsageBudget: obj(
		{
			ai_usd: nullable(num({ description: "Monthly Workers AI threshold in USD; null for none." })),
			email_usd: nullable(num({ description: "Monthly Email Service threshold in USD; null for none." })),
			updated_at: nullable(int()),
			updated_by: nullable(str()),
		},
		["ai_usd", "email_usd"],
	),
	Usage: loose(
		{
			window: loose({ month: str(), start: str(), end: str(), days_in_month: int(), elapsed_fraction: num() }),
			email: loose({
				source: strEnum(["cloudflare", "local"]),
				unit: strEnum(["recipients", "messages"]),
				included: int(),
				sent_mtd: int(),
				projected: int(),
				cost_mtd: num(),
				projected_cost: num(),
			}),
			ai: loose({
				by_feature: arr(obj({ feature: str(), label: str(), calls_mtd: int(), calls_today: int() })),
				by_provider: arr(
					obj({
						provider_id: str(),
						label: str(),
						calls_mtd: int(),
						calls_today: int(),
						input_tokens_mtd: nullable(int()),
						output_tokens_mtd: nullable(int()),
						cost_mtd_usd: nullable(num()),
					}),
				),
				by_role: arr(
					obj({
						role: str(),
						label: str(),
						provider_id: str(),
						calls_mtd: int(),
						calls_today: int(),
						input_tokens_mtd: nullable(int()),
						output_tokens_mtd: nullable(int()),
					}),
				),
				calls_mtd: int(),
				neurons: nullable(
					loose({
						neurons_mtd: num(),
						neurons_projected: num(),
						today: num(),
						cost_mtd: num(),
						projected_cost: num(),
						by_model: arr(obj({ model: str(), neurons: num(), requests: int() })),
					}),
				),
			}),
			r2: nullable(obj({ bucket: str(), bytes: int(), objects: int() })),
			durable_objects: nullable(obj({ requests_mtd: int(), projected: int(), included: int() })),
			quota: nullable(obj({ limit: int(), used: int(), unit: str(), resets_at: nullable(str()) })),
			mailboxes: arr(
				obj({
					email: email(),
					triage: obj({ enabled: bool(), daily_ai_cap: int(), calls_today: int() }),
					send_caps: nullable(obj({ hourly: int(), daily: int(), sent_last_hour: int(), sent_last_day: int(), default: bool() })),
				}),
			),
			budget: loose({
				ai_usd: nullable(num()),
				email_usd: nullable(num()),
				exceeded: bool(),
				alerts: arr(obj({ kind: strEnum(["ai", "email"]), projected_usd: num(), threshold_usd: num(), exceeded: bool() })),
			}),
			pricing: loose(),
			provider: loose({ configured: bool(), cached_at: str(), error: str(), sampled: bool() }),
		},
		"Month-to-date usage. Cloudflare-only parts (neurons, r2, durable_objects, quota) are null without CF_ANALYTICS_TOKEN.",
	),
	SendLimits: obj(
		{
			caps: obj({ hourly: int(), daily: int() }, ["hourly", "daily"]),
			default: bool({ description: "True when the caps are the defaults (20/hour, 100/day)." }),
			sent_last_hour: int(),
			sent_last_day: int(),
			maxima: obj({ hourly: int(), daily: int() }),
			editable: bool(),
			account_quota: nullable(
				obj({ limit: int(), used: int(), unit: str(), resets_at: nullable(str()) }, undefined, {
					description: "Cloudflare account sending quota (administrators only).",
				}),
			),
		},
		["caps", "sent_last_hour", "sent_last_day"],
	),
	Suppression: obj(
		{
			id: str(),
			address: email(),
			scope: str({ description: '"global" or a sending domain.' }),
			reason: strEnum(["unsubscribed", "hard_bounce", "complaint", "manual"]),
			source: str({ description: "What added it, e.g. unsubscribe-link:<mailbox>, dsn:<mailbox>, api:<user>." }),
			created_at: int({ description: "Epoch milliseconds." }),
		},
		["id", "address", "scope", "reason", "source", "created_at"],
	),
	Mailbox: obj(
		{
			id: str(),
			email: email(),
			name: str(),
			domain: str(),
			settings: ref("MailboxSettings"),
		},
		["id", "email", "name"],
	),
	MailboxSettings: loose(
		{
			fromName: str(),
			forwarding: loose(),
			signature: loose(),
			autoReply: loose(),
			autoDraft: loose(),
			agentSystemPrompt: str(),
		},
		"Resolved mailbox settings.",
	),
	MailboxSettingsPatch,
	Folder: obj({ id: str(), name: str(), unreadCount: int() }, ["id", "name"]),
	Label: obj(
		{
			id: str(),
			name: str(),
			color: str(),
			parent_id: nullable(str()),
			sort_order: int(),
			email_count: int(),
			unread_count: int(),
			prompt: nullable(str({ description: "Auto-label description. A label with a prompt is applied by AI triage." })),
			auto_archive: bool({ description: "Matches skip the Inbox." }),
			show_tab: bool({ description: "Shown as an inbox tab." }),
		},
		["id", "name", "color"],
	),
	EmailLabel: obj(
		{
			id: str(),
			name: str(),
			color: str(),
			source: nullable(strEnum(["user", "rule", "heuristic", "ai"], { description: "Who applied it; null means a person." })),
		},
		["id", "name", "color"],
	),
	LabelPrompt: obj(
		{
			id: str(),
			name: str(),
			color: str(),
			prompt: nullable(str()),
			preset_key: nullable(str()),
			auto_archive: bool(),
			show_tab: bool(),
		},
		["id", "name", "prompt", "auto_archive", "show_tab"],
	),
	TriagePreset: obj(
		{
			key: strEnum(TRIAGE_PRESET_KEYS),
			name: str(),
			prompt: str(),
			enabled: bool(),
			label_id: nullable(str()),
			auto_archive: bool(),
			show_tab: bool(),
		},
		["key", "name", "enabled"],
	),
	InboxTab: obj(
		{
			id: str({ description: "`primary` or a label id." }),
			name: str(),
			color: str(),
			query: str({ description: "Saved search; run it with GET /search?query=." }),
		},
		["id", "name", "query"],
	),
	ScreenerSender: obj(
		{
			sender: email(),
			sender_name: nullable(str()),
			count: int(),
			unread: int(),
			latest_date: str({ format: "date-time" }),
			latest_subject: nullable(str()),
			latest_id: str(),
			sender_kind: nullable(strEnum(SENDER_KINDS)),
			sender_confidence: nullable(strEnum(["high", "medium", "low"])),
			verdict: nullable(str({ description: 'AI pre-verdict, e.g. "Looks like cold sales (high)".' })),
		},
		["sender", "count", "latest_id"],
	),
	Signature: obj(
		{ id: str(), name: str(), body_html: str(), is_default: bool() },
		["id", "name", "body_html", "is_default"],
	),
	ScheduledSend: obj(
		{
			email_id: str(),
			send_at: str(),
			status: strEnum(["pending", "sent", "failed"]),
			attempts: int(),
			last_error: nullable(str()),
			subject: nullable(str()),
			sender: str(),
			recipient: str(),
			cc: nullable(str()),
			bcc: nullable(str()),
			snippet: nullable(str()),
		},
		["email_id", "send_at", "status"],
	),
	SenderRule: obj(
		{
			id: str(),
			pattern: str({ description: 'Full address ("spam@example.com") or domain suffix ("@example.com").' }),
			reason: nullable(str()),
			created_at: str(),
		},
		["id", "pattern"],
	),
	RuleCondition,
	RuleAction,
	Rule: obj(
		{
			id: str(),
			name: str(),
			enabled: bool(),
			sort_order: int(),
			match_type: strEnum(["all", "any"]),
			conditions: arr(ref("RuleCondition")),
			actions: arr(ref("RuleAction")),
			stop_processing: bool(),
		},
		["id", "name", "enabled", "conditions", "actions"],
	),
	Template: obj(
		{
			id: str(),
			slug: str(),
			name: str(),
			subject: str(),
			bodyHtml: str(),
			createdAt: int(),
			updatedAt: int(),
		},
		["id", "slug", "name", "subject", "bodyHtml"],
	),
	SequenceStep,
	Sequence: obj(
		{ id: str(), name: str(), steps: arr(ref("SequenceStep")), createdAt: int(), updatedAt: int() },
		["id", "name", "steps"],
	),
	SequenceEnrollment: loose(
		{
			id: str(),
			sequenceId: str(),
			personId: str(),
			personEmail: str(),
			personName: nullable(str()),
			fromAddress: str(),
			status: strEnum(["active", "completed", "cancelled"]),
			variables: { type: "object", additionalProperties: str() },
			enrolledAt: int(),
			cancelledAt: nullable(int()),
		},
	),
	AuditEntry: loose(
		{
			id: str(),
			at: int({ description: "Unix seconds." }),
			action: str(),
			actor: nullable(str()),
			actorRole: strEnum(["owner", "delegate", "admin", "system"]),
			mailboxId: nullable(str()),
			target: str(),
			detail: { type: "object", additionalProperties: true },
		},
	),
	PendingApproval: obj(
		{
			status: str({ const: "pending_approval" }),
			approval_id: str(),
			approval_url: str({ format: "uri" }),
			expires_at: str({ format: "date-time" }),
			reason: strEnum(["approval_required", "injection_suspected"]),
			message: str(),
		},
		["status", "approval_id", "approval_url"],
		{ description: "The send was held for a person to approve; nothing was sent. Do not retry." },
	),
	SendApproval: loose(
		{
			id: str(),
			kind: strEnum([
				"send_email",
				"send_reply",
				"forward_email",
				"send_template",
				"schedule_send",
				"rest_send",
				"rest_reply",
				"rest_forward",
				"rest_schedule",
				"rest_template",
				"sequence_enroll",
			]),
			status: strEnum(["pending", "sending", "sent", "sent_unconfirmed", "rejected", "failed"], {
				description:
					"sent_unconfirmed: the provider may have accepted it (a timeout or ambiguous error, or a send interrupted mid-flight). Final; never retried.",
			}),
			reason: str({ description: "approval_required or injection_suspected" }),
			recipients: arr(email()),
			subject: str(),
			messages: arr(
				loose({
					to: arr(email()),
					cc: arr(email()),
					bcc: arr(email()),
					from: { oneOf: [str(), loose({ email: email(), name: str() })] },
					subject: str(),
					html: nullable(str()),
					text: nullable(str()),
					attachments: arr(loose({ filename: str(), type: str() })),
					send_at: nullable(str({ format: "date-time" })),
					bulk: bool(),
				}),
				{ description: "Exactly what approve sends, as stored at hold time (templates rendered, the draft verified)." },
			),
			note: nullable(str()),
			enrollment: nullable(
				loose({
					sequence_id: str(),
					sequence_name: str(),
					person: email(),
					from: email(),
					steps: arr(loose({ order: int(), delayHours: num(), subject: str(), bodyHtml: str() })),
				}),
			),
			tracking_added_at_send: bool({ description: "Open and click tracking is added when it is sent, per the mailbox settings." }),
			editable: bool({ description: "A pending single message can be edited with PATCH, or revised by its requester with POST …/revise." }),
			revision: int({ description: "1 when stored, +1 per edit or revision. Pass it to approve so a newer version is never sent unseen." }),
			revised_at: nullable(str({ format: "date-time" })),
			revised_by: nullable(strEnum(["requester", "reviewer"], { description: "requester: the agent revised its own send; reviewer: a person edited it." })),
			requested_by: loose({ user: nullable(str()), via: strEnum(["mcp", "agent", "api"]), method: nullable(str()) }),
			result: nullable(loose()),
			error: nullable(str()),
			decided_by: nullable(str()),
			created_at: str({ format: "date-time" }),
			decided_at: nullable(str({ format: "date-time" })),
			expires_at: str({ format: "date-time" }),
		},
		"An agent or MCP send waiting for a person.",
	),
	Branding: obj(
		{
			appName: str(),
			tagline: nullable(str()),
			accentColor: str(),
			logoMimeType: nullable(str()),
			logoFilename: nullable(str()),
			logoUpdatedAt: nullable(int()),
			updatedAt: int(),
		},
		["appName", "accentColor"],
	),
	ThreadSummary: obj(
		{
			thread_id: str(),
			line: nullable(str({ maxLength: 120 })),
			bullets: nullable(arr(str(), { maxItems: 3, description: "Up to 3 bullets covering the conversation so far; fewer when there is less to say." })),
			message_count: int({ description: "Messages the summary was generated from." }),
			status: strEnum(["ok", "blocked", "skipped"]),
			generated_at: str({ format: "date-time" }),
			stale: bool({ description: "The conversation changed since; a regeneration is queued or can be requested." }),
		},
		["thread_id", "message_count", "status", "stale"],
	),
	AiSettings: obj(
		{
			summaries: bool(),
			bulkSummaries: bool({ description: "Summarise newsletters and notifications too (one-liner and bullets)." }),
			dailyCapPerMailbox: int({ minimum: 0, maximum: 5000 }),
			semantic: bool({ description: "Semantic search and Ask: embed new mail. Off falls back to full-text." }),
			embedDailyCapPerMailbox: int({ minimum: 0, maximum: 20000, description: "Embedding calls per mailbox per UTC day." }),
		},
		["summaries", "bulkSummaries", "dailyCapPerMailbox", "semantic", "embedDailyCapPerMailbox"],
	),
	AiCap: obj(
		{
			value: nullable(bool()),
			source: strEnum(["provider", "hint", "probe", "admin"], {
				description: "provider: the gateway said so; hint: inferred from the model family; probe: passed or failed Test; admin: set by an administrator.",
			}),
		},
		["value", "source"],
	),
	AiCatalogModel: obj(
		{
			id: str({ description: "Exact string sent as `model`." }),
			label: str(),
			kind: strEnum(["chat", "embedding", "other"]),
			contextTokens: nullable(int()),
			maxOutputTokens: nullable(int()),
			caps: obj(
				{ tools: ref("AiCap"), json: ref("AiCap"), vision: ref("AiCap"), reasoning: ref("AiCap"), embed: ref("AiCap") },
				["tools", "json", "vision", "reasoning", "embed"],
			),
			embeddingDims: nullable(int()),
			lifecycle: strEnum(["active", "deprecated", "retired"]),
			pricing: nullable(obj({ inputPerMTok: num(), outputPerMTok: num() }, ["inputPerMTok", "outputPerMTok"])),
			tier: nullable(strEnum(["small", "mid", "strong"])),
			custom: bool(),
			testedAt: nullable(str({ format: "date-time" })),
		},
		["id", "label", "kind", "caps"],
	),
	AiProviderAuth: obj(
		{
			scheme: strEnum(["bearer", "x-api-key", "api-key", "custom", "none"]),
			header: str({ description: "Header name, for `custom` only." }),
		},
		["scheme"],
	),
	AiProviderOptions: obj({
		structuredOutputs: strEnum(["auto", "on", "off"]),
		includeUsage: bool(),
		timeoutScale: num({ minimum: 0.5, maximum: 4 }),
		allowCustomPorts: bool(),
		litellmInfo: bool(),
	}),
	AiProvider: obj(
		{
			id: str(),
			label: str(),
			wire: strEnum(["openai", "anthropic"]),
			baseUrl: str(),
			exactBaseUrl: bool(),
			apiBase: str({ description: "Where API paths go: the base URL with `/v1` (or the gateway's own prefix)." }),
			auth: ref("AiProviderAuth"),
			tokenSet: bool({ description: "The token is never returned." }),
			tokenHint: nullable(str({ description: "Last four characters, e.g. …a1b2." })),
			headers: arr(
				obj(
					{ name: str(), secret: bool(), value: str({ description: "Plain headers only." }), set: bool() },
					["name", "secret", "set"],
				),
			),
			options: ref("AiProviderOptions"),
			enabled: bool(),
			catalogue: obj(
				{
					fetchedAt: nullable(str({ format: "date-time" })),
					status: strEnum(["never", "ok", "no-discovery", "auth-failed", "error"]),
					detail: nullable(str()),
					count: int(),
				},
				["fetchedAt", "status", "count"],
			),
			models: arr(ref("AiCatalogModel")),
			needsCustomIds: bool({ description: "Azure and Cloudflare AI Gateway: enter model or deployment ids yourself." }),
			breaker: obj({ state: strEnum(["closed", "open", "half-open"]), openUntil: nullable(int()) }, ["state"]),
			createdAt: str({ format: "date-time" }),
			updatedAt: str({ format: "date-time" }),
		},
		["id", "label", "wire", "baseUrl", "auth", "tokenSet", "headers", "options", "enabled", "catalogue", "models"],
	),
	AiRouting: obj(
		{
			gatewayProviderId: nullable(str({ description: "The active gateway; null means Workers AI for everything." })),
			models: loose({}, "Role → `{ modelId }`."),
			default: obj({ modelId: str() }, ["modelId"]),
			fallbackToWorkersAi: bool(),
			workersAiExceptions: arr(str()),
			disabledRoles: arr(str()),
			embeddingsMode: strEnum(["gateway", "workers-ai", "off"]),
		},
		["gatewayProviderId", "models", "fallbackToWorkersAi", "workersAiExceptions", "disabledRoles", "embeddingsMode"],
	),
	AiRoleProblem: obj({ role: strEnum(AI_ROLES), reason: str() }, ["role", "reason"]),
	WorkersAiCap: obj({ value: nullable(bool()), source: strEnum(["provider", "hint", "probe"]) }, ["value", "source"]),
	WorkersAiModel: obj(
		{
			id: str(),
			task: strEnum(["Text Generation", "Text Embeddings"]),
			description: str(),
			contextTokens: nullable(int()),
			tools: ref("WorkersAiCap"),
			json: ref("WorkersAiCap"),
			reasoning: bool(),
			vision: bool(),
			dims: nullable(int({ description: "Embedding vector size, when known." })),
			price: nullable(obj({ input: nullable(num()), output: nullable(num()) }, ["input", "output"], { description: "USD per million tokens." })),
			beta: bool(),
			lora: bool(),
			paid: bool({ description: "Needs the Workers Paid plan." }),
			deprecated: bool(),
		},
		["id", "task", "contextTokens", "tools", "json", "reasoning", "vision", "dims", "price", "beta", "lora", "paid", "deprecated"],
	),
	WorkersAiProvider: obj(
		{
			id: strEnum(["workers-ai"]),
			label: str(),
			builtIn: bool(),
			roles: arr(
				obj(
					{
						role: strEnum(AI_ROLES),
						modelId: str(),
						defaultModelId: str(),
						source: strEnum(["admin", "env", "default"], { description: "admin: picked in settings; env: SUMMARY_MODEL; default: built in." }),
						locked: bool({ description: "The prompt-injection scanner: never changeable." }),
					},
					["role", "modelId", "defaultModelId", "source", "locked"],
				),
			),
			tested: loose({}, "Model id → what Test found."),
		},
		["id", "label", "builtIn", "roles", "tested"],
	),
	AiStatus: obj(
		{
			mode: strEnum(["workers-ai", "gateway"]),
			activeProviderId: str(),
			activeLabel: str(),
			line: str({ description: "e.g. All AI runs on Cloudflare Workers AI." }),
			exceptions: arr(obj({ role: nullable(strEnum(AI_ROLES)), text: str() }, ["role", "text"])),
		},
		["mode", "activeProviderId", "activeLabel", "line", "exceptions"],
	),
	AssistantPrefs: obj(
		{
			listSummaries: bool(),
			brief: obj(
				{
					enabled: bool(),
					time: str({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
					timeZone: str({ description: "IANA zone, e.g. Europe/Berlin" }),
					email: bool(),
				},
				["enabled", "time", "timeZone", "email"],
			),
		},
		["listSummaries", "brief"],
	),
	PushPrefs: obj(
		{
			newMail: bool(),
			approvals: bool({ description: "Notify when a send waits in Pending approval." }),
			followups: bool({ description: "Notify when a follow-up reminder comes due." }),
			mode: strEnum(["all", "important", "products"], {
				description: "all: every Inbox message. important: needs-reply (you are in the thread), high priority or a VIP sender. products: only mail to the listed products.",
			}),
			products: arr(str(), { description: "Product ids for mode=products." }),
			mailboxes: loose({}, "Per-mailbox override, keyed by address: all, important or off. PUT `inherit` to remove one."),
			vipSenders: arr(str(), { description: "Addresses or @domains that always count as important." }),
			hideContent: bool({ description: "Show only \"New mail in <mailbox>\": no sender or subject." }),
			quietHours: obj(
				{
					enabled: bool(),
					start: str({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
					end: str({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
					timeZone: nullable(str({ description: "IANA zone; null uses the zone from AI assistant settings." })),
				},
				["enabled", "start", "end", "timeZone"],
			),
		},
		["newMail", "approvals", "followups", "mode", "products", "mailboxes", "vipSenders", "hideContent", "quietHours"],
	),
	PushDevice: obj(
		{
			id: str(),
			label: str({ description: "e.g. Chrome on Android" }),
			user_agent: nullable(str()),
			push_service: str({ description: "Host of the push service endpoint" }),
			created_at: str({ format: "date-time" }),
			last_success_at: nullable(str({ format: "date-time" })),
			failures: int(),
		},
		["id", "label", "push_service", "created_at", "last_success_at", "failures"],
	),
	BriefItem: obj(
		{
			id: str(),
			thread_id: nullable(str()),
			subject: str(),
			who: nullable(str()),
			who_name: nullable(str()),
			date: str({ format: "date-time" }),
			summary_line: nullable(str()),
			unread: bool(),
		},
		["id", "subject", "date"],
	),
	DailyBrief: obj(
		{
			id: str(),
			v: int(),
			generatedAt: str({ format: "date-time" }),
			timeZone: str(),
			since: str({ format: "date-time" }),
			until: str({ format: "date-time" }),
			dateLabel: str(),
			totals: obj({ new: int(), needsReply: int(), waitingOn: int() }),
			mailboxes: arr(
				obj({
					mailbox: str(),
					newCount: int(),
					newTruncated: bool(),
					newByImportance: obj({
						important: arr(ref("BriefItem")),
						people: arr(ref("BriefItem")),
						updates: arr(ref("BriefItem")),
					}),
					needsReply: arr(ref("BriefItem")),
					needsReplyCount: int(),
					waitingOn: arr(ref("BriefItem")),
					waitingOnCount: int(),
					waitingSource: strEnum(["followups", "derived", "mixed"]),
					topSenders: arr(obj({ address: str(), name: nullable(str()), count: int() })),
				}),
			),
		},
		["id", "since", "until", "mailboxes", "totals"],
	),
	BriefState: obj(
		{
			brief: nullable(ref("DailyBrief")),
			dismissed: bool(),
			nextRunAt: nullable(str({ format: "date-time" })),
		},
		["brief", "dismissed"],
	),
	Preferences: obj({
		notifications: obj({ desktop: bool(), onlyImportant: bool(), playSound: bool() }),
		display: obj({
			density: strEnum(["comfortable", "cozy", "compact"]),
			hideSignaturesInChat: bool(),
			previewText: bool(),
			readingPanePosition: strEnum(["right", "bottom", "off"]),
		}),
		sending: obj({ undoWindowEnabled: bool(), undoWindowSeconds: int({ minimum: 5, maximum: 120 }) }),
		updatedAt: int(),
	}),
	AnalyticsProvider: obj(
		{
			configured: bool(),
			window_capped: bool(),
			cached_at: str({ format: "date-time" }),
			error: str(),
			sampled: bool({ description: "Some Cloudflare rows were sampled; counts are estimates." }),
		},
		["configured", "window_capped"],
	),
	AnalyticsWindow: obj(
		{ days: int({ enum: [1, 7, 30, 90] }), start: str({ format: "date-time" }), end: str({ format: "date-time" }) },
		["days", "start", "end"],
	),
	AnalyticsOverview: loose(
		{
			window: ref("AnalyticsWindow"),
			scope: strEnum(["app", "zone"]),
			provider: ref("AnalyticsProvider"),
			sending: loose({ unit: strEnum(["messages", "recipients"]), rates: loose() }),
			reputation: nullable(loose({ status: str(), metrics: arr(loose()) })),
			quota: nullable(loose({ used: int(), limit: int() })),
			timeseries: arr(loose({ date: str() })),
			domains: arr(loose({ domain: str() })),
			senders: arr(loose({ from: str(), app: bool() })),
			errors: arr(loose({ cause: str() })),
			mailboxes: arr(loose({ mailbox: str() })),
			suppressions: loose(),
		},
		"See shared/analytics-types.ts (Overview). Rates are fractions 0..1, or null when the denominator is 0.",
	),
	AnalyticsEngagement: loose(
		{
			window: ref("AnalyticsWindow"),
			provider: ref("AnalyticsProvider"),
			totals: loose(),
			messages: arr(loose({ email_id: str(), mailbox: str() })),
			links: arr(loose({ url: str() })),
			note: str(),
		},
		"See shared/analytics-types.ts (Engagement).",
	),
	AnalyticsInbound: loose(
		{
			window: ref("AnalyticsWindow"),
			provider: ref("AnalyticsProvider"),
			received: int(),
			stored: int(),
			spam_filed: int(),
			auth: loose(),
			actions: arr(loose({ label: str() })),
			rules: arr(loose({ id: str() })),
			by_address: arr(loose({ address: str() })),
			routing_errors: arr(loose()),
			timeseries: arr(loose({ date: str() })),
		},
		"See shared/analytics-types.ts (Inbound).",
	),
	AnalyticsDmarc: loose(
		{
			window: ref("AnalyticsWindow"),
			provider: ref("AnalyticsProvider"),
			totals: loose(),
			sources: arr(loose({ org: str() })),
			reporters: arr(loose({ org: str() })),
			failures: arr(loose({ source_ip: str() })),
			timeseries: arr(loose({ date: str() })),
		},
		"See shared/analytics-types.ts (Dmarc).",
	),
	AccessGrant: loose(
		{
			id: str(),
			kind: strEnum(["user", "service"]),
			role: strEnum(["admin", "member"]),
			mailboxes: arr({}),
			label: str(),
		},
		"A grant record.",
	),
};

// -- Shared responses ---------------------------------------------------

const errorContent = (name = "Error") => ({ "application/json": { schema: ref(name) } });

const responses: Record<string, ResponseObject> = {
	BadRequest: { description: "Invalid request", content: errorContent("ValidationError") },
	Unauthorized: { description: "Not signed in, or the token is invalid", content: errorContent() },
	Forbidden: {
		description: "Authenticated, but the grant or token scope does not allow this",
		content: errorContent(),
	},
	NotFound: { description: "Not found", content: errorContent() },
	Conflict: { description: "Conflicts with existing state", content: errorContent() },
	PayloadTooLarge: { description: "Message or upload too large", content: errorContent() },
	PreconditionFailed: { description: "A required configuration (such as a Cloudflare connection) is missing", content: errorContent() },
	PreconditionRequired: { description: "Explicit confirmation required; resend with the named flag", content: errorContent() },
	Unprocessable: { description: "Rejected by a storage-layer limit", content: errorContent() },
	TooManyRequests: { description: "Rate limited", content: errorContent() },
	Locked: {
		description:
			"`code: bulk_paused`: bulk sending from this domain is paused by the spam-rate circuit breaker until an administrator resumes it.",
		content: errorContent(),
	},
	ServiceUnavailable: { description: "Upstream unavailable; retry later", content: errorContent() },
	BadGateway: { description: "An upstream service answered with an error", content: errorContent() },
	IdempotencyConflict: {
		description:
			"`code: idempotency_key_reused`: the Idempotency-Key was already used with a different request. " +
			"`code: idempotency_request_in_progress`: a request with this key is still running; retry after `Retry-After` seconds. " +
			"On routes that create something, a plain conflict with existing state also answers 409.",
		headers: {
			"Retry-After": { description: "Seconds to wait; sent with idempotency_request_in_progress.", schema: int() },
		},
		content: errorContent(),
	},
};

const ERROR_RESPONSE: Record<number, string> = {
	400: "BadRequest",
	401: "Unauthorized",
	403: "Forbidden",
	404: "NotFound",
	409: "Conflict",
	412: "PreconditionFailed",
	413: "PayloadTooLarge",
	422: "Unprocessable",
	423: "Locked",
	428: "PreconditionRequired",
	429: "TooManyRequests",
	502: "BadGateway",
	503: "ServiceUnavailable",
};

const json = (schema: SchemaObject, description = "OK"): ResponseObject => ({
	description,
	content: { "application/json": { schema } },
});
const binary = (mediaType: string, description: string): ResponseObject => ({
	description,
	content: { [mediaType]: { schema: str({ contentMediaType: mediaType }) } },
});
const noContent = (description = "No content"): ResponseObject => ({ description });

// -- Parameters ---------------------------------------------------------

const PATH_PARAM_DESCRIPTIONS: Record<string, string> = {
	mailboxId: "Mailbox address, e.g. support@example.com (URL-encoded).",
	id: "Resource id.",
	emailId: "Message id.",
	threadId: "Thread id.",
	labelId: "Label id.",
	attachmentId: "Attachment id.",
	signatureId: "Signature id.",
	ruleId: "Rule id.",
	blockId: "Blocked-sender entry id.",
	allowId: "Allowed-sender entry id.",
	kind: 'Principal kind: "user" or "service".',
	person: "Correspondent address (URL-encoded).",
	slug: "Template slug.",
	personId: "Person id.",
	enrollmentId: "Enrollment id.",
	deliveryId: "Webhook delivery id (whd_…).",
	briefId: "Brief id, from GET /api/v1/me/brief.",
	domain: "Sending domain, e.g. example.com.",
};

const q = (name: string, schema: SchemaObject, description?: string): ParameterObject => ({
	name,
	in: "query",
	required: false,
	...(description ? { description } : {}),
	schema,
});

const PAGE = q("page", int({ minimum: 1 }), "1-based page number.");
const LIMIT = q("limit", int({ minimum: 1 }), "Page size.");
const FOLDER = q("folder", str(), "Folder id, e.g. inbox, sent, drafts, trash.");
const SORT_COLUMN = q("sortColumn", str(), "Column to sort by, e.g. date.");
const SORT_DIRECTION = q("sortDirection", strEnum(["asc", "desc", "ASC", "DESC"]));
const FLAG_FILTERS = [
	q("unread", bool(), "Only unread (true/1)."),
	q("starred", bool(), "Only starred (true/1)."),
	q("has_attachment", bool(), "Only messages with attachments (true/1)."),
];
const MIGRATION_TOKEN: ParameterObject = {
	name: "X-Migration-Token",
	in: "header",
	required: true,
	description: "The deployment's MIGRATION_TOKEN secret.",
	schema: str(),
};
/** Added to every route in `IDEMPOTENT_PATHS` by `buildOperation`. */
const IDEMPOTENCY_KEY_PARAM: ParameterObject = {
	name: "Idempotency-Key",
	in: "header",
	required: false,
	description:
		"Makes a retry safe. The first request with a key runs and its response is kept for 24 hours, per caller " +
		"(user and API token) and route. A repeat with the same body returns that response with " +
		"`Idempotent-Replayed: true` and does nothing; the same key with a different body is 409 " +
		"`idempotency_key_reused`; a repeat while the first is still running is 409 " +
		"`idempotency_request_in_progress` with `Retry-After: 1`. 5xx responses are not kept, so a retry can succeed. " +
		"1-256 printable ASCII characters; a UUID per logical operation works well.",
	schema: str({ minLength: 1, maxLength: 256, pattern: "^[\\x20-\\x7E]+$" }),
};
const IDEMPOTENT_REPLAYED = {
	description: "`true` when this response is a replay of an earlier request with the same Idempotency-Key.",
	schema: strEnum(["true"]),
};
const AUDIT_LIMIT = q("limit", int({ minimum: 1 }), "Entries to return (default 50, capped).");
const AUDIT_FILTERS = [
	q("category", strEnum(["mail", "settings", "access", "security", "agent"]), "Only one family of actions."),
	q("action", str(), "Only this action, e.g. agent.send_held."),
	q("actor", str(), "Substring of the actor, target, API token or OAuth client."),
];
const ANALYTICS_DAYS_PARAM = q(
	"days",
	int({ enum: [1, 7, 30, 90] }),
	"Window in days (default 7). Cloudflare data covers at most 31 days.",
);
const ANALYTICS_REFRESH_PARAM = q(
	"refresh",
	strEnum(["1"]),
	"Reload Cloudflare data instead of the 5-minute cache, at most once per 30 s per query. Ignored for non-administrators, whose data is local.",
);

// -- Operation table ------------------------------------------------------

/**
 * Maps a mailbox capability to the token scope `authz.ts` intersects it with.
 * Mirrors the enforcement in `workers/lib/authz.ts`.
 */
const CAPABILITY_SCOPE: Record<MailboxCapability, TokenScope> = {
	read: "mail:read",
	sendAs: "mail:send",
	sendOnBehalf: "mail:send",
	draft: "mail:draft",
	organise: "mail:organize",
	delete: "mail:organize",
	deletePermanently: "mail:organize",
	manageRules: "mailboxes:manage",
	manageSettings: "mailboxes:manage",
	manageDelegates: "mailboxes:manage",
};

interface RouteDef {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** Hono-style path, `:param` segments. */
	path: string;
	operationId: string;
	tag: string;
	summary: string;
	description?: string;
	/** Mailbox capability the path gate checks (any one suffices). */
	capability?: MailboxCapability[];
	query?: ParameterObject[];
	headers?: ParameterObject[];
	body?: SchemaObject;
	bodyOptional?: boolean;
	/** Request body media type; JSON unless set (e.g. raw upload bytes). */
	bodyMediaType?: string;
	responses: Record<string, ResponseObject>;
	/** Extra error statuses beyond the automatic 400/401/403/404. */
	errors?: number[];
	/** No authentication required. */
	public?: boolean;
}

const PERSON_ONLY =
	" Changes need a signed-in person: an API token or connected app gets 403 `person_required`.";

const FRESH_SESSION =
	" Needs a browser session that re-confirmed its password or passkey in the last 15 minutes (POST /api/auth/passkeys/reauth): 403 `session_required` or `reauth_required` otherwise.";

/** Settings → Cloudflare connection. See workers/routes/cloudflare.ts. */
function cloudflareRouteDefs(): RouteDef[] {
	const P = "/api/v1/cloudflare/connection";
	const out = json(ref("CloudflareConnection"));
	return [
		{
			method: "GET",
			path: P,
			operationId: "getCloudflareConnection",
			tag: "Domains",
			summary: "The Cloudflare token this app uses: source, account, last 4 characters and capabilities (admin)",
			description: "CF_API_TOKEN in env wins over a stored connection. The token is never returned.",
			responses: { 200: out },
		},
		{
			method: "PUT",
			path: P,
			operationId: "putCloudflareConnection",
			tag: "Domains",
			summary: "Verify a Cloudflare API token, probe what it can do and store it encrypted (admin)",
			description:
				"400 `invalid_token` when Cloudflare does not report it active. 409 `multiple_accounts` (with `accounts`) when the token reaches several accounts and no `accountId` was given. 409 `env_token_active` while CF_API_TOKEN is set." +
				FRESH_SESSION,
			body: obj(
				{
					token: str({ minLength: 20, maxLength: 512, description: "Write-only: never returned or logged." }),
					accountId: str({ pattern: "^[a-fA-F0-9]{32}$" }),
				},
				["token"],
				{ additionalProperties: false },
			),
			responses: { 200: out },
			errors: [409],
		},
		{
			method: "POST",
			path: `${P}/verify`,
			operationId: "verifyCloudflareConnection",
			tag: "Domains",
			summary: "Re-check the stored token and its capabilities (admin)",
			description: "400 `invalid_token` when the token is no longer active (the view is returned with every capability missing)." + FRESH_SESSION,
			bodyOptional: true,
			responses: { 200: out },
			errors: [409],
		},
		{
			method: "DELETE",
			path: P,
			operationId: "deleteCloudflareConnection",
			tag: "Domains",
			summary: "Forget the stored Cloudflare token (admin)",
			description: "Takes effect on every isolate within 30 s. CF_API_TOKEN in env, if set, is unaffected." + FRESH_SESSION,
			responses: { 200: out },
		},
	];
}

/** The app licence. See workers/routes/licence.ts. */
function licenceRouteDefs(): RouteDef[] {
	const P = "/api/v1/licence";
	const out = json(ref("Licence"));
	const key = obj(
		{ licenceKey: str({ minLength: 8, maxLength: 256, description: "Write-only: sent to the licence server once, never stored." }) },
		["licenceKey"],
		{ additionalProperties: false },
	);
	const SESSION = " Needs a browser session: an API token gets 403 `session_required`.";
	return [
		{
			method: "GET",
			path: P,
			operationId: "getLicence",
			tag: "Licence",
			summary: "Licence status. Members see only status and locked; admins see plan, expiry and refresh state",
			description: "Reachable while the app is locked. Every other /api, /mcp and /agents call answers 402 `licence_required` then.",
			responses: { 200: out },
		},
		{
			method: "POST",
			path: `${P}/activate`,
			operationId: "activateLicence",
			tag: "Licence",
			summary: "Activate this deployment with a licence key (admin)",
			description:
				"Exchanges the key at the licence server for a signed token bound to this deployment and host, and stores only the token. 422 `activation_limit_reached` when the licence is active on its maximum number of deployments; 400 `invalid_licence_key`; 502 when the licence server fails." +
				SESSION,
			body: key,
			responses: { 200: out },
			errors: [422, 502],
		},
		{
			method: "POST",
			path: `${P}/refresh`,
			operationId: "refreshLicence",
			tag: "Licence",
			summary: "Refresh the licence token now (admin)",
			description: "On failure the current token is kept. `outcome` is refreshed, failed, terminal, skipped or no_token.",
			bodyOptional: true,
			responses: { 200: json(obj({ outcome: strEnum(["refreshed", "failed", "terminal", "skipped", "no_token"]) }, ["outcome"])) },
		},
		{
			method: "POST",
			path: `${P}/deactivate`,
			operationId: "deactivateLicence",
			tag: "Licence",
			summary: "Free this deployment's licence slot and remove the token (admin)",
			description: "Needs the licence key again; it is not stored. The app locks afterwards." + SESSION,
			body: key,
			responses: { 200: out },
			errors: [502],
		},
	];
}

/** Cloudflare onboarding: discover, plan, apply, change log. See workers/routes/cloudflare-setup.ts. */
function cloudflareSetupRouteDefs(): RouteDef[] {
	const P = "/api/v1/cloudflare";
	const zoneIds = arr(str({ pattern: "^[a-fA-F0-9]{32}$" }), { minItems: 1, maxItems: 5, description: "Chosen zone ids (at most 5)." });
	const notConnected = " 412 `not_connected` / `reconnect_required` without a usable token.";
	return [
		{
			method: "GET",
			path: `${P}/discover`,
			operationId: "discoverCloudflare",
			tag: "Domains",
			summary: "Read-only: every zone the token sees, with apex mail DNS and routing, plus Worker and Vectorize state (admin)",
			description:
				"Pages zones (cap 200, active first); a summary is read for the first 12 active zones, the rest are listed by name. Cached 60 s per isolate; `?refresh=1` skips the cache." +
				notConnected,
			query: [q("refresh", strEnum(["1"]), "Skip the 60 s cache.")],
			responses: { 200: json(ref("CloudflareDiscovery")) },
			errors: [412],
		},
		{
			method: "POST",
			path: `${P}/plan`,
			operationId: "planCloudflareSetup",
			tag: "Domains",
			summary: "Read-only: the setup plan for the chosen zones, each item tiered auto / confirm / manual / done (admin)",
			description: "400 `zone_not_visible` (with `zones`) for a zone the token can't see." + notConnected,
			body: obj({ zones: zoneIds }, ["zones"], { additionalProperties: false }),
			responses: { 200: json(ref("CloudflarePlan")) },
			errors: [412],
		},
		{
			method: "POST",
			path: `${P}/apply`,
			operationId: "applyCloudflareSetup",
			tag: "Domains",
			summary: "Apply chosen plan items: auto items, and confirm items sent with confirm: true (admin)",
			description:
				"Recomputes the plan from fresh discovery. 409 `plan_stale` (with the new `items` and `planHash`) when the hash differs. 400 `zone_not_selected`, `zone_not_visible`, `unknown_item`, `not_applicable` (manual/done) or `confirm_required`. Items run in dependency order; failures are per-item results, and dependents are skipped. Every DNS write and catch-all overwrite is logged for revert." +
				notConnected +
				FRESH_SESSION,
			body: obj(
				{
					zones: zoneIds,
					planHash: str(),
					items: arr(obj({ id: str(), confirm: { const: true } }, ["id"], { additionalProperties: false }), { minItems: 1, maxItems: 200 }),
				},
				["zones", "planHash", "items"],
				{ additionalProperties: false },
			),
			responses: { 200: json(ref("CloudflareApplyResult")) },
			errors: [409, 412],
		},
		{
			method: "GET",
			path: `${P}/changes`,
			operationId: "listCloudflareChanges",
			tag: "Domains",
			summary: "Recent Cloudflare changes made by apply, newest first (admin)",
			query: [q("limit", int({ minimum: 1, maximum: 500 }), "Default 100."), q("zoneId", str({ pattern: "^[a-fA-F0-9]{32}$" }))],
			responses: { 200: json(obj({ changes: arr(ref("CloudflareDnsChange")) }, ["changes"])) },
		},
		{
			method: "POST",
			path: `${P}/changes/:id/revert`,
			operationId: "revertCloudflareChange",
			tag: "Domains",
			summary: "Put back what a logged change replaced (admin)",
			description:
				"Deletes a created record, restores a deleted one, or restores the previous content or catch-all rule. 409 `already_reverted`, or `revert_conflict` when the record was edited since (left alone). 502 when Cloudflare refuses." +
				notConnected +
				FRESH_SESSION,
			bodyOptional: true,
			responses: {
				200: json(obj({ change: ref("CloudflareDnsChange"), detail: str() }, ["change", "detail"])),
				502: { description: "Cloudflare refused the revert", content: { "application/json": { schema: ref("Error") } } },
			},
			errors: [409, 412],
		},
	];
}

/** Settings → AI providers. See workers/routes/ai-providers.ts. */
function aiProviderRouteDefs(): RouteDef[] {
	const P = "/api/v1/ai/providers";
	const providerOut = json(obj({ provider: ref("AiProvider") }, ["provider"]));
	const headerIn = arr(obj({ name: str(), value: str(), secret: bool() }, ["name"]), { maxItems: 8 });
	const providerFields = {
		label: str({ minLength: 1, maxLength: 60 }),
		wire: strEnum(["openai", "anthropic"]),
		baseUrl: str({ description: "https only; private hosts, this app's own host and workers.dev are refused." }),
		exactBaseUrl: bool({ description: "Use the base URL as entered, without adding /v1." }),
		auth: ref("AiProviderAuth"),
		headers: headerIn,
		options: ref("AiProviderOptions"),
	};
	const routingOut = json(obj({ routing: ref("AiRouting"), problems: arr(ref("AiRoleProblem")) }, ["routing", "problems"]));
	return [
		{
			method: "GET",
			path: P,
			operationId: "listAiProviders",
			tag: "AI",
			summary: "AI providers (the built-in Workers AI and any gateways), routing, status and this month's usage (admin)",
			responses: {
				200: json(
					obj(
						{
							providers: arr(ref("AiProvider")),
							routing: ref("AiRouting"),
							problems: arr(ref("AiRoleProblem")),
							roles: arr(obj({ role: strEnum(AI_ROLES), label: str(), needs: strEnum(["text", "json", "tools", "embed"]), pinned: bool() })),
							authSecretSet: bool({ description: "False: tokens are encrypted with a key stored in the app. Set AUTH_SECRET." }),
							workersAi: ref("WorkersAiProvider"),
							status: ref("AiStatus"),
							usage: obj(
								{
									month: str({ description: "YYYY-MM, UTC." }),
									byProvider: arr(
										obj(
											{
												providerId: str({ description: "A gateway id, or workers-ai." }),
												calls: int(),
												inputTokens: nullable(int()),
												outputTokens: nullable(int()),
												costUsd: nullable(num()),
											},
											["providerId", "calls"],
										),
									),
								},
								["month", "byProvider"],
							),
						},
						["providers", "routing", "problems", "roles", "authSecretSet", "workersAi", "status", "usage"],
					),
				),
			},
		},
		{
			method: "POST",
			path: P,
			operationId: "createAiProvider",
			tag: "AI",
			summary: "Add an Anthropic- or OpenAI-compatible gateway (admin, signed-in person)",
			description: "The token is encrypted at rest and never returned; responses carry `tokenSet` and `tokenHint`." + PERSON_ONLY,
			body: obj(
				{ ...providerFields, token: str({ description: "Write-only: never returned." }), id: str({ pattern: "^[a-z0-9-]{1,32}$" }) },
				["label", "wire", "baseUrl", "auth"],
			),
			responses: { 201: { ...providerOut, description: "Created" } },
			errors: [409],
		},
		{
			method: "PATCH",
			path: `${P}/:id`,
			operationId: "updateAiProvider",
			tag: "AI",
			summary: "Change a gateway (admin, signed-in person)",
			description:
				"`token`: a string replaces it, null clears it, absent keeps it. `headers` replaces the list; a secret header sent without a value keeps its stored value." +
				PERSON_ONLY,
			body: obj({ ...providerFields, token: nullable(str({ description: "Write-only." })), enabled: bool() }),
			responses: { 200: providerOut },
			errors: [409],
		},
		{
			method: "DELETE",
			path: `${P}/:id`,
			operationId: "deleteAiProvider",
			tag: "AI",
			summary: "Remove a gateway (admin, signed-in person; not while active)",
			responses: { 204: noContent("Removed") },
			errors: [409],
		},
		{
			method: "POST",
			path: `${P}/:id/discover`,
			operationId: "discoverAiProviderModels",
			tag: "AI",
			summary: "Fetch the gateway's model list and cache it (admin)",
			description: "`catalogue.status` says why a list is empty: no-discovery (404/405), auth-failed (401/403) or error. The gateway's response body is never echoed.",
			responses: { 200: providerOut },
		},
		{
			method: "PATCH",
			path: `${P}/:id/models`,
			operationId: "updateAiProviderModels",
			tag: "AI",
			summary: "Add or remove custom model ids, override capabilities (admin, signed-in person)",
			description: "Azure deployment names and Cloudflare AI Gateway ids go in `add`. In `caps`, null clears an override." + PERSON_ONLY,
			body: obj({
				add: arr(obj({ id: str(), label: str(), kind: strEnum(["chat", "embedding"]) }, ["id"]), { maxItems: 50 }),
				remove: arr(str(), { maxItems: 50 }),
				caps: arr(
					obj({ id: str(), tools: nullable(bool()), json: nullable(bool()), vision: nullable(bool()), embed: nullable(bool()) }, ["id"]),
					{ maxItems: 100 },
				),
			}),
			responses: { 200: providerOut },
		},
		{
			method: "POST",
			path: `${P}/:id/test`,
			operationId: "testAiProviderModel",
			tag: "AI",
			summary: "Probe one model: text, JSON, tool call, embeddings (admin)",
			description: "Results are stored as tested capabilities. Errors are redacted.",
			body: obj(
				{ modelId: str(), checks: arr(strEnum(["text", "json", "tools", "embed"]), { minItems: 1, maxItems: 4 }) },
				["modelId"],
			),
			responses: {
				200: json(
					obj(
						{
							results: arr(
								obj(
									{ check: strEnum(["text", "json", "tools", "embed"]), ok: bool(), ms: int(), error: str(), dims: int() },
									["check", "ok", "ms"],
								),
							),
							provider: ref("AiProvider"),
						},
						["results", "provider"],
					),
				),
			},
		},
		{
			method: "GET",
			path: "/api/v1/ai/routing",
			operationId: "getAiRouting",
			tag: "AI",
			summary: "Which model each AI role uses (admin)",
			responses: { 200: routingOut },
		},
		{
			method: "PATCH",
			path: "/api/v1/ai/routing",
			operationId: "updateAiRouting",
			tag: "AI",
			summary: "Pick models per role, activate a gateway, fallback and embeddings (admin, signed-in person)",
			description:
				"With a gateway active every role runs on it, except the prompt-injection scanner (always Workers AI) and embeddings when set to `workers-ai`. " +
				"A pick that fails its role's check (tools for agent chat and auto-draft, JSON for triage) is refused with 422 `capability_check_failed` and `problems`, as is activating while any role has one." +
				PERSON_ONLY,
			body: obj({
				gatewayProviderId: nullable(str()),
				models: loose({}, "Role → model id, or null to clear."),
				default: nullable(str()),
				fallbackToWorkersAi: bool(),
				embeddings: strEnum(["gateway", "workers-ai", "off"]),
			}),
			responses: { 200: routingOut },
			errors: [409, 422],
		},
		{
			method: "GET",
			path: `${P}/workers-ai/models`,
			operationId: "listWorkersAiModels",
			tag: "AI",
			summary: "The Workers AI model catalogue, and each role's model on it (admin)",
			description:
				"Text generation and embedding models from Cloudflare's model search, cached for an hour. Needs `CF_ANALYTICS_TOKEN` with Workers AI Read; " +
				"without it `source` is `fallback` and `models` is a short built-in list. `roles[].unlisted` is set when a role's model is no longer in the live catalogue, with a suggested `successor` (never applied automatically).",
			query: [
				q("task", strEnum(["Text Generation", "Text Embeddings"]), "Only models for this task."),
				q("search", str({ maxLength: 100 }), "Substring of the id or description."),
				q("refresh", strEnum(["1", "true"]), "Read through the cache (at most once every 30 seconds)."),
			],
			responses: {
				200: json(
					obj(
						{
							source: strEnum(["live", "fallback"]),
							fetchedAt: str({ format: "date-time" }),
							detail: nullable(str()),
							count: int(),
							models: arr(ref("WorkersAiModel")),
							roles: arr(
								obj(
									{
										role: strEnum(AI_ROLES),
										modelId: str(),
										unlisted: nullable(obj({ successor: nullable(str()) }, ["successor"])),
									},
									["role", "modelId", "unlisted"],
								),
							),
						},
						["source", "fetchedAt", "count", "models", "roles"],
					),
				),
			},
		},
		{
			method: "PATCH",
			path: `${P}/workers-ai/routing`,
			operationId: "updateWorkersAiRouting",
			tag: "AI",
			summary: "Pick the Workers AI model per role (admin, signed-in person)",
			description:
				"`models` maps a role to a `@cf/…` or `@hf/…` id, or null for the default. Used whenever a role runs on Workers AI: no active gateway, an exception, or fallback. " +
				"Checked like gateway picks: agent chat and auto-draft need verified function calling, triage verified JSON mode (run Test first when the catalogue doesn't say), embeddings a 1024-dimension embedding model. " +
				"The prompt-injection scanner can't be changed. Changing the embeddings model re-indexes every mailbox, so it needs `confirmReindex: true` (else 422 `reindex_confirm_required`). " +
				"`SUMMARY_MODEL` applies only while summaries have no pick here." +
				PERSON_ONLY,
			body: obj({ models: loose({}, "Role → model id, or null for the default."), confirmReindex: bool() }, ["models"]),
			responses: {
				200: json(
					obj({ workersAi: ref("WorkersAiProvider"), status: ref("AiStatus"), reindex: bool() }, ["workersAi", "status", "reindex"]),
				),
			},
			errors: [422],
		},
		{
			method: "POST",
			path: `${P}/workers-ai/test`,
			operationId: "testWorkersAiModel",
			tag: "AI",
			summary: "Probe one Workers AI model: text, JSON mode, a tool call, embeddings (admin)",
			description: "Results are stored per model and count as verified capabilities when picking it for a role.",
			body: obj(
				{ modelId: str({ pattern: "^@(cf|hf)/" }), checks: arr(strEnum(["text", "json", "tools", "embed"]), { minItems: 1, maxItems: 4 }) },
				["modelId"],
			),
			responses: {
				200: json(
					obj(
						{
							results: arr(
								obj(
									{ check: strEnum(["text", "json", "tools", "embed"]), ok: bool(), ms: int(), error: str(), dims: int() },
									["check", "ok", "ms"],
								),
							),
							tested: nullable(loose({}, "What Test has found on this model so far.")),
						},
						["results", "tested"],
					),
				),
			},
			errors: [409],
		},
	];
}

const SEND: MailboxCapability[] = ["sendAs", "sendOnBehalf"];
const ORGANISE: MailboxCapability[] = ["organise"];
const RULES: MailboxCapability[] = ["manageRules"];
const SETTINGS: MailboxCapability[] = ["manageSettings"];
const MB = "/api/v1/mailboxes/:mailboxId";

const routes: RouteDef[] = [
	// ---- Meta
	{
		method: "GET",
		path: "/api/v1/openapi.json",
		operationId: "getOpenApiDocument",
		tag: "Meta",
		summary: "This OpenAPI document",
		public: true,
		responses: { 200: json({ type: "object", additionalProperties: true }, "OpenAPI 3.1 document") },
	},

	// ---- Me / config
	{
		method: "GET",
		path: "/api/v1/me",
		operationId: "getMe",
		tag: "Me/Config",
		summary: "The current caller, their role and per-mailbox capabilities",
		responses: {
			200: json(
				loose({
					email: nullable(str()),
					name: str(),
					authenticated: bool(),
					role: str(),
					mailboxes: nullable(arr(str())),
					capabilities: nullable(
						arr(
							obj({
								mailboxId: str(),
								role: str(),
								capabilities: arr(strEnum(MAILBOX_CAPABILITY_VALUES)),
							}),
						),
					),
					enforced: bool(),
					kind: nullable(strEnum(["user", "service"])),
					authMode: str(),
					authMethod: nullable(str()),
					userId: nullable(str()),
					isOwner: bool(),
					totpEnabled: bool(),
				}),
			),
		},
	},
	{
		method: "GET",
		path: "/api/v1/config",
		operationId: "getConfig",
		tag: "Me/Config",
		summary: "Served zones and configured mailbox addresses",
		responses: {
			200: json(
				obj({
					domains: arr(str()),
					emailAddresses: arr(str()),
					zones: arr(loose({ id: str(), domain: str(), name: str() })),
				}),
			),
		},
	},

	// ---- Branding
	{
		method: "GET",
		path: "/api/v1/branding",
		operationId: "getBranding",
		tag: "Branding",
		summary: "Instance name, tagline, accent colour and logo metadata",
		description: "Public: the sign-in page renders it.",
		public: true,
		responses: { 200: json(ref("Branding")) },
	},
	{
		method: "PUT",
		path: "/api/v1/branding",
		operationId: "updateBranding",
		tag: "Branding",
		summary: "Update branding (admin)",
		body: obj(
			{
				appName: str({ minLength: 1, maxLength: 40 }),
				tagline: nullable(str({ maxLength: 120 })),
				accentColor: str({ pattern: HEX_COLOR_PATTERN }),
			},
			undefined,
			{ additionalProperties: false },
		),
		responses: { 200: json(ref("Branding")) },
	},
	{
		method: "DELETE",
		path: "/api/v1/branding",
		operationId: "resetBranding",
		tag: "Branding",
		summary: "Reset branding to defaults (admin)",
		responses: { 200: json(ref("Branding")) },
	},
	{
		method: "GET",
		path: "/api/v1/branding/logo",
		operationId: "getBrandingLogo",
		tag: "Branding",
		summary: "The uploaded logo image",
		public: true,
		query: [q("v", str(), "Cache-busting version (logoUpdatedAt); a match makes the response immutable.")],
		responses: { 200: binary("image/*", "Logo image") },
		errors: [404],
	},
	{
		method: "PUT",
		path: "/api/v1/branding/logo",
		operationId: "uploadBrandingLogo",
		tag: "Branding",
		summary: "Upload a logo (admin)",
		body: obj(
			{
				content: str({ minLength: 1, contentEncoding: "base64", description: "Base64, no data-URL prefix. Max 512 KiB decoded." }),
				filename: str({ minLength: 1, maxLength: 255 }),
				type: str({ minLength: 1, maxLength: 120 }),
			},
			["content", "filename", "type"],
			{ additionalProperties: false },
		),
		responses: { 200: json(ref("Branding")) },
	},
	{
		method: "DELETE",
		path: "/api/v1/branding/logo",
		operationId: "deleteBrandingLogo",
		tag: "Branding",
		summary: "Remove the logo (admin)",
		responses: { 200: json(ref("Branding")) },
	},

	// ---- Preferences
	{
		method: "GET",
		path: "/api/v1/preferences",
		operationId: "getPreferences",
		tag: "Preferences",
		summary: "Instance-wide display, notification and sending preferences",
		responses: { 200: json(ref("Preferences")) },
	},
	{
		method: "PUT",
		path: "/api/v1/preferences",
		operationId: "updatePreferences",
		tag: "Preferences",
		summary: "Patch preferences (admin)",
		body: obj(
			{
				notifications: obj({ desktop: bool(), onlyImportant: bool(), playSound: bool() }, undefined, {
					additionalProperties: false,
				}),
				display: obj(
					{
						density: strEnum(["comfortable", "cozy", "compact"]),
						hideSignaturesInChat: bool(),
						previewText: bool(),
						readingPanePosition: strEnum(["right", "bottom", "off"]),
					},
					undefined,
					{ additionalProperties: false },
				),
				sending: obj(
					{ undoWindowEnabled: bool(), undoWindowSeconds: int({ minimum: 5, maximum: 120 }) },
					undefined,
					{ additionalProperties: false },
				),
			},
			undefined,
			{ additionalProperties: false },
		),
		responses: { 200: json(ref("Preferences")) },
	},

	// ---- AI summaries and the daily brief
	{
		method: "GET",
		path: "/api/v1/ai/settings",
		operationId: "getAiSettings",
		tag: "AI",
		summary: "Instance AI summary settings",
		responses: { 200: json(ref("AiSettings")) },
	},
	{
		method: "PUT",
		path: "/api/v1/ai/settings",
		operationId: "updateAiSettings",
		tag: "AI",
		summary: "Patch instance AI summary settings (admin)",
		body: obj(
			{
				summaries: bool(),
				bulkSummaries: bool(),
				bulkOneLiners: bool({ description: "Deprecated: the old name for bulkSummaries, still accepted." }),
				dailyCapPerMailbox: int({ minimum: 0, maximum: 5000 }),
				semantic: bool(),
				embedDailyCapPerMailbox: int({ minimum: 0, maximum: 20000 }),
			},
			undefined,
			{ additionalProperties: false },
		),
		responses: { 200: json(ref("AiSettings")) },
	},

	// ---- Bring-your-own AI gateway (admin)
	...aiProviderRouteDefs(),
	...cloudflareRouteDefs(),
	...licenceRouteDefs(),
	...cloudflareSetupRouteDefs(),
	{
		method: "GET",
		path: "/api/v1/me/assistant",
		operationId: "getAssistantPrefs",
		tag: "AI",
		summary: "My AI preferences: list one-liners and daily brief schedule",
		responses: { 200: json(ref("AssistantPrefs")) },
		errors: [409],
	},
	{
		method: "PUT",
		path: "/api/v1/me/assistant",
		operationId: "updateAssistantPrefs",
		tag: "AI",
		summary: "Patch my AI preferences (re-arms the brief alarm)",
		body: obj(
			{
				listSummaries: bool(),
				brief: obj(
					{
						enabled: bool(),
						time: str({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
						timeZone: str(),
						email: bool(),
					},
					undefined,
					{ additionalProperties: false },
				),
			},
			undefined,
			{ additionalProperties: false },
		),
		responses: { 200: json(ref("AssistantPrefs")) },
		errors: [409],
	},
	{
		method: "GET",
		path: "/api/v1/me/brief",
		operationId: "getDailyBrief",
		tag: "AI",
		summary: "My latest daily brief, narrowed to mailboxes this caller may read",
		responses: { 200: json(ref("BriefState")) },
	},
	{
		method: "POST",
		path: "/api/v1/me/brief/generate",
		operationId: "generateDailyBrief",
		tag: "AI",
		summary: "Build my brief now (does not send the email)",
		responses: { 201: json(obj({ brief: nullable(ref("DailyBrief")), dismissed: bool() }), "Built") },
		errors: [409],
	},
	{
		method: "POST",
		path: "/api/v1/me/brief/:briefId/dismiss",
		operationId: "dismissDailyBrief",
		tag: "AI",
		summary: "Hide the Today card until the next brief",
		responses: { 200: json(ref("Status")) },
		errors: [409],
	},

	// ---- Web Push
	{
		method: "GET",
		path: "/api/v1/push/vapid-key",
		operationId: "getPushVapidKey",
		tag: "Notifications",
		summary: "The VAPID application server key to subscribe with (applicationServerKey)",
		responses: { 200: json(obj({ public_key: str() }, ["public_key"])) },
		errors: [503],
	},
	{
		method: "GET",
		path: "/api/v1/push/subscriptions",
		operationId: "listPushSubscriptions",
		tag: "Notifications",
		summary: "My devices registered for Web Push",
		responses: { 200: json(obj({ subscriptions: arr(ref("PushDevice")) }, ["subscriptions"])) },
		errors: [409],
	},
	{
		method: "POST",
		path: "/api/v1/push/subscriptions",
		operationId: "createPushSubscription",
		tag: "Notifications",
		summary: "Register this browser's PushSubscription (idempotent per endpoint)",
		body: obj(
			{
				endpoint: str({ format: "uri", description: "PushSubscription.endpoint; must be a known push service" }),
				keys: obj({ p256dh: str(), auth: str() }, ["p256dh", "auth"]),
				expirationTime: nullable(num()),
			},
			["endpoint", "keys"],
		),
		responses: { 201: json(ref("PushDevice"), "Registered") },
		errors: [409],
	},
	{
		method: "DELETE",
		path: "/api/v1/push/subscriptions",
		operationId: "deletePushSubscription",
		tag: "Notifications",
		summary: "Revoke one of my devices, by id or endpoint",
		body: obj({ id: str(), endpoint: str() }, undefined, { description: "Exactly one of id or endpoint." }),
		responses: { 200: json(ref("Status")) },
		errors: [404, 409],
	},
	{
		method: "GET",
		path: "/api/v1/push/preferences",
		operationId: "getPushPreferences",
		tag: "Notifications",
		summary: "My notification preferences",
		responses: { 200: json(ref("PushPrefs")) },
		errors: [409],
	},
	{
		method: "PUT",
		path: "/api/v1/push/preferences",
		operationId: "updatePushPreferences",
		tag: "Notifications",
		summary: "Patch my notification preferences",
		body: loose({}, "Any subset of PushPrefs; quietHours merges field by field, mailboxes per key."),
		responses: { 200: json(ref("PushPrefs")) },
		errors: [409],
	},
	{
		method: "POST",
		path: "/api/v1/push/test",
		operationId: "sendTestPush",
		tag: "Notifications",
		summary: "Send a test notification to every one of my devices",
		responses: {
			200: json(obj({ devices: int(), sent: int(), removed: int(), failed: int(), limited: bool() })),
		},
		errors: [404, 409, 429],
	},

	// ---- Access (admin)
	{
		method: "GET",
		path: "/api/v1/access",
		operationId: "listAccessGrants",
		tag: "Access",
		summary: "All grants, configured admins and the role vocabulary (admin)",
		responses: {
			200: json(
				loose({
					users: arr(ref("AccessGrant")),
					services: arr(ref("AccessGrant")),
					configuredAdmins: arr(str()),
					roles: arr(obj({ role: str(), capabilities: arr(str()) })),
					capabilities: arr(str()),
					fullAccessRole: str(),
					enforced: bool(),
				}),
			),
		},
	},
	{
		method: "PUT",
		path: "/api/v1/access",
		operationId: "putAccessGrant",
		tag: "Access",
		summary: "Create or replace a grant (admin)",
		body: obj(
			{
				id: str({ minLength: 1, description: "Email address, or a service token Client ID." }),
				kind: strEnum(["user", "service"]),
				role: strEnum(["admin", "member"]),
				mailboxes: arr(
					{
						oneOf: [
							email({ description: "Bare address: full access to that mailbox." }),
							obj(
								{
									id: email(),
									role: strEnum(MAILBOX_ROLE_VALUES),
									extra: arr(strEnum(MAILBOX_CAPABILITY_VALUES)),
									revoked: arr(strEnum(MAILBOX_CAPABILITY_VALUES)),
								},
								["id", "role"],
							),
						],
					},
					{ default: [] },
				),
				label: str({ maxLength: 80 }),
			},
			["id", "kind", "role"],
		),
		responses: { 200: json(ref("AccessGrant")) },
	},
	{
		method: "DELETE",
		path: "/api/v1/access/:kind/:id",
		operationId: "deleteAccessGrant",
		tag: "Access",
		summary: "Remove a grant (admin)",
		responses: { 204: noContent("Removed") },
	},
	{
		method: "GET",
		path: "/api/v1/access/audit",
		operationId: "listInstanceAudit",
		tag: "Access",
		summary: "Deployment-wide audit log, newest first (admin)",
		query: [AUDIT_LIMIT, ...AUDIT_FILTERS],
		responses: { 200: json(arr(ref("AuditEntry"))) },
	},

	// ---- Mailboxes
	{
		method: "GET",
		path: "/api/v1/mailboxes",
		operationId: "listMailboxes",
		tag: "Mailboxes",
		summary: "Mailboxes the caller can reach",
		query: [
			q("domain", str(), "Only mailboxes on this domain."),
			q("include", strEnum(["settings"]), "Include each mailbox's settings."),
		],
		responses: { 200: json(arr(ref("Mailbox"))) },
	},
	{
		method: "POST",
		path: "/api/v1/mailboxes",
		operationId: "createMailbox",
		tag: "Mailboxes",
		summary: "Create a mailbox (admin)",
		body: obj(
			{ email: email(), name: str({ minLength: 1 }), settings: ref("MailboxSettingsPatch") },
			["email", "name"],
		),
		responses: { 201: json(ref("Mailbox"), "Created") },
		errors: [409],
	},
	{
		method: "GET",
		path: MB,
		operationId: "getMailbox",
		tag: "Mailboxes",
		summary: "One mailbox with its settings",
		responses: { 200: json(ref("Mailbox")) },
	},
	{
		method: "PUT",
		path: MB,
		operationId: "updateMailbox",
		tag: "Mailboxes",
		summary: "Update mailbox settings",
		capability: SETTINGS,
		body: obj({ settings: ref("MailboxSettingsPatch") }, ["settings"]),
		responses: { 200: json(ref("Mailbox")) },
	},
	{
		method: "DELETE",
		path: MB,
		operationId: "deleteMailbox",
		tag: "Mailboxes",
		summary: "Delete a mailbox and its mail (admin)",
		responses: { 204: noContent("Deleted") },
	},
	{
		method: "GET",
		path: `${MB}/state`,
		operationId: "getMailboxState",
		tag: "Mailboxes",
		summary: "Change counters for polling (uncacheable)",
		responses: { 200: json(loose()) },
	},

	// ---- Delegates
	{
		method: "GET",
		path: `${MB}/delegates`,
		operationId: "listMailboxDelegates",
		tag: "Delegates",
		summary: "Everyone who can reach this mailbox, and how far",
		capability: ["manageDelegates"],
		responses: {
			200: json(
				loose({
					delegates: arr(loose()),
					roles: arr(obj({ role: str(), capabilities: arr(str()) })),
					fullAccessRole: str(),
				}),
			),
		},
	},
	{
		method: "PUT",
		path: `${MB}/delegates`,
		operationId: "putMailboxDelegate",
		tag: "Delegates",
		summary: "Grant or change one delegate's access to this mailbox",
		capability: ["manageDelegates"],
		body: obj(
			{
				id: str({ minLength: 1 }),
				kind: strEnum(["user", "service"], { default: "user" }),
				role: strEnum(MAILBOX_ROLE_VALUES),
				extra: arr(strEnum(MAILBOX_CAPABILITY_VALUES)),
				revoked: arr(strEnum(MAILBOX_CAPABILITY_VALUES)),
				label: str({ maxLength: 80 }),
			},
			["id", "role"],
		),
		responses: { 200: json(loose({ id: str(), kind: str(), role: str() })) },
	},
	{
		method: "DELETE",
		path: `${MB}/delegates/:kind/:id`,
		operationId: "deleteMailboxDelegate",
		tag: "Delegates",
		summary: "Remove a delegate from this mailbox",
		capability: ["manageDelegates"],
		responses: { 204: noContent("Removed") },
	},

	// ---- Emails
	{
		method: "GET",
		path: `${MB}/emails`,
		operationId: "listEmails",
		tag: "Emails",
		summary: "List messages",
		description:
			"With `folder`, returns `{emails, totalCount}`; without, a bare array. `threaded=true` (with a folder) groups by conversation.",
		capability: ["read"],
		query: [
			FOLDER,
			q("thread_id", str()),
			q("threaded", bool()),
			PAGE,
			LIMIT,
			SORT_COLUMN,
			SORT_DIRECTION,
			...FLAG_FILTERS,
		],
		responses: { 200: json({ oneOf: [ref("EmailPage"), arr(ref("Email"))] }) },
	},
	{
		method: "POST",
		path: `${MB}/emails`,
		operationId: "sendEmail",
		tag: "Emails",
		summary: "Send a message now",
		description:
			"Every send passes the pre-send gate: Cloudflare's per-message limits, the mailbox's send caps (429), and suppressions. Transactional (the default): recipients that hard-bounced or complained are dropped and listed in `suppressed`; unsubscribed ones are sent to and listed in `suppression_warnings`. `transactional:false`/`list:true`: every suppressed recipient is dropped, the message gets List-Unsubscribe (one-click) and List-Id, and the send is refused with 423 `bulk_paused` while the domain's spam-rate breaker is tripped. No deliverable To recipient left: 422 `all_suppressed`. Held for approval: an API token or OAuth app without `mail:send:auto`, on a mailbox whose `agentSend.mode` is `approve` (the default), gets 202 `{status:\"pending_approval\", approval_id, approval_url}` and nothing is sent until a person approves it. `draft_only` refuses with 403. Browser sessions are never held.",
		capability: SEND,
		body: ref("SendEmailRequest"),
		responses: { 202: json({ oneOf: [ref("SendAccepted"), ref("PendingApproval")] }, "Accepted for delivery, or held for approval") },
		errors: [413, 422, 423, 429],
	},
	{
		method: "POST",
		path: `${MB}/emails/bulk`,
		operationId: "bulkEmailAction",
		tag: "Emails",
		summary: "Apply one action to many messages",
		description:
			"The capability checked follows `action`: read/unread/star/unstar/move/label/unlabel need organise, delete/restore need delete, delete_permanently needs deletePermanently.",
		capability: ORGANISE,
		body: obj(
			{
				action: strEnum(BULK_ACTIONS),
				ids: arr(str({ minLength: 1 }), { minItems: 1, maxItems: 500 }),
				folder_id: str({ description: "Required for `move`." }),
				label_id: str({ description: "Required for `label` and `unlabel`." }),
			},
			["action", "ids"],
		),
		responses: {
			200: json(obj({ affected: int(), trashed: int(), deleted: int() }, ["affected"])),
		},
	},
	{
		method: "GET",
		path: `${MB}/emails/:id`,
		operationId: "getEmail",
		tag: "Emails",
		summary: "One message with body and attachments",
		capability: ["read"],
		responses: { 200: json(ref("Email")) },
	},
	{
		method: "PUT",
		path: `${MB}/emails/:id`,
		operationId: "updateEmail",
		tag: "Emails",
		summary: "Set read / starred",
		capability: ORGANISE,
		body: obj({ read: bool(), starred: bool() }),
		responses: { 200: json(ref("Email")) },
	},
	{
		method: "DELETE",
		path: `${MB}/emails/:id`,
		operationId: "deleteEmail",
		tag: "Emails",
		summary: "Move to Trash, or destroy if already in Trash/Spam",
		description: "`?permanent=1` destroys outright and also needs deletePermanently.",
		capability: ["delete"],
		query: [q("permanent", strEnum(["1"]), "Skip Trash and destroy.")],
		responses: { 200: json(ref("Status"), "Trashed"), 204: noContent("Destroyed") },
	},
	{
		method: "POST",
		path: `${MB}/emails/:id/restore`,
		operationId: "restoreEmail",
		tag: "Emails",
		summary: "Restore a message from Trash",
		capability: ["delete"],
		responses: { 200: json(ref("Status")) },
	},
	{
		method: "POST",
		path: `${MB}/emails/:id/move`,
		operationId: "moveEmail",
		tag: "Emails",
		summary: "Move a message to a folder",
		capability: ORGANISE,
		body: obj({ folderId: str() }, ["folderId"]),
		responses: { 200: json(ref("Status")) },
	},
	{
		method: "POST",
		path: `${MB}/emails/:id/reply`,
		operationId: "replyToEmail",
		tag: "Emails",
		summary: "Reply to a message (threading derived server-side)",
		description: "Held for approval: an API token or OAuth app without `mail:send:auto`, on a mailbox whose `agentSend.mode` is `approve` (the default), gets 202 `{status:\"pending_approval\", approval_id, approval_url}` and nothing is sent until a person approves it. `draft_only` refuses with 403. Browser sessions are never held.",
		capability: SEND,
		body: ref("SendEmailRequest"),
		responses: { 202: json({ oneOf: [ref("SendAccepted"), ref("PendingApproval")] }, "Accepted for delivery, or held for approval") },
		errors: [413, 429],
	},
	{
		method: "POST",
		path: `${MB}/emails/:id/forward`,
		operationId: "forwardEmail",
		tag: "Emails",
		summary: "Forward a message",
		description: "Held for approval: an API token or OAuth app without `mail:send:auto`, on a mailbox whose `agentSend.mode` is `approve` (the default), gets 202 `{status:\"pending_approval\", approval_id, approval_url}` and nothing is sent until a person approves it. `draft_only` refuses with 403. Browser sessions are never held.",
		capability: SEND,
		body: ref("SendEmailRequest"),
		responses: { 202: json({ oneOf: [ref("SendAccepted"), ref("PendingApproval")] }, "Accepted for delivery, or held for approval") },
		errors: [413, 429],
	},
	{
		method: "PUT",
		path: `${MB}/emails/:id/priority`,
		operationId: "setEmailPriority",
		tag: "Emails",
		summary: "Set or clear priority",
		capability: ORGANISE,
		body: obj({ priority: nullable(strEnum(["high", "low"])) }, ["priority"]),
		responses: { 200: json(ref("Email")) },
	},
	{
		method: "POST",
		path: `${MB}/emails/:id/not-spam`,
		operationId: "markNotSpam",
		tag: "Emails",
		summary: "Move out of Spam and allow the sender",
		capability: ORGANISE,
		responses: { 200: json(loose()) },
	},
	{
		method: "GET",
		path: `${MB}/emails/:id/delivery-events`,
		operationId: "listDeliveryEvents",
		tag: "Emails",
		summary: "Delivery timeline for a sent message",
		capability: ["read"],
		responses: { 200: json(obj({ events: arr(ref("DeliveryEvent")) }, ["events"])) },
	},
	{
		method: "GET",
		path: `${MB}/emails/:emailId/attachments/:attachmentId`,
		operationId: "getAttachment",
		tag: "Emails",
		summary: "Download an attachment",
		capability: ["read"],
		query: [q("disposition", strEnum(["inline", "attachment"]), "Ask for inline display (honoured for safe types only).")],
		responses: { 200: binary("application/octet-stream", "Attachment bytes") },
	},
	{
		method: "POST",
		path: `${MB}/trash/empty`,
		operationId: "emptyTrash",
		tag: "Emails",
		summary: "Destroy everything in Trash",
		capability: ["deletePermanently"],
		responses: { 200: json(obj({ deleted: int() }, ["deleted"])) },
	},
	{
		method: "POST",
		path: `${MB}/mark-all-read`,
		operationId: "markAllRead",
		tag: "Emails",
		summary: "Mark everything (or one folder/label) read",
		capability: ORGANISE,
		body: obj({ folder: str({ minLength: 1 }), label_id: str({ minLength: 1 }) }),
		bodyOptional: true,
		responses: { 200: json(ref("Affected")) },
	},

	// ---- Drafts
	{
		method: "POST",
		path: `${MB}/drafts`,
		operationId: "saveDraft",
		tag: "Drafts",
		summary: "Create or update a draft",
		description: "Pass `draft_id` to update; 200 on update, 201 on create.",
		capability: ["draft"],
		body: obj(
			{
				to: str(),
				cc: str(),
				bcc: str(),
				subject: str(),
				body: str(),
				in_reply_to: str(),
				thread_id: str(),
				draft_id: str(),
				attachments: arr(ref("AttachmentPayload")),
				replace_attachments: bool({ description: "Whether `attachments` replaces the stored set." }),
			},
			["body"],
		),
		responses: {
			200: json(loose({ id: str(), status: str({ const: "draft" }) }), "Updated"),
			201: json(
				obj({ id: str(), status: str({ const: "draft" }), subject: str(), recipient: str(), date: str() }),
				"Created",
			),
		},
		errors: [413],
	},

	// ---- Threads
	{
		method: "GET",
		path: `${MB}/threads/:threadId`,
		operationId: "getThread",
		tag: "Threads",
		summary: "Messages in a conversation",
		capability: ["read"],
		query: [FOLDER],
		responses: { 200: json(arr(ref("Email"))) },
	},
	{
		method: "GET",
		path: `${MB}/threads/:threadId/summary`,
		operationId: "getThreadSummary",
		tag: "AI",
		summary: "AI summary of a conversation (one line plus up to 3 bullets)",
		description:
			"Generated in the background after mail is stored, and only regenerated when the message count changes. Null for Spam/Trash, bulk mail with bulk summaries off, messages with almost no text, or before generation. Plain display text from a model: untrusted.",
		capability: ["read"],
		responses: { 200: json(obj({ summary: nullable(ref("ThreadSummary")) }, ["summary"])) },
	},
	{
		method: "POST",
		path: `${MB}/threads/:threadId/summary/refresh`,
		operationId: "refreshThreadSummary",
		tag: "AI",
		summary: "Queue a summary regeneration (no-op if the count is unchanged)",
		capability: ["read"],
		responses: { 202: json(obj({ queued: bool() }, ["queued"]), "Queued") },
	},
	{
		method: "POST",
		path: `${MB}/threads/:threadId/summary/generate`,
		operationId: "generateThreadSummary",
		tag: "AI",
		summary: "Generate a conversation's summary now (the reader's Summarize button)",
		description:
			"One model call, counted against the mailbox's daily cap; returns the stored summary without a call when it is already current. `summary` is null when the conversation has too little text. 429 `summary_cap` once the cap is spent, 404 when nothing countable remains (Spam/Trash), 503 `summaries_off` when summaries are off or `summary_failed` when the model failed (left queued for the background retry).",
		capability: ["read"],
		errors: [429, 503],
		responses: { 200: json(obj({ summary: nullable(ref("ThreadSummary")) }, ["summary"])) },
	},
	{
		method: "POST",
		path: `${MB}/threads/:threadId/read`,
		operationId: "markThreadRead",
		tag: "Threads",
		summary: "Mark a conversation read",
		capability: ORGANISE,
		responses: { 200: json(ref("Status")) },
	},
	{
		method: "POST",
		path: `${MB}/threads/:threadId/mute`,
		operationId: "muteThread",
		tag: "Threads",
		summary: "Mute a conversation",
		capability: ORGANISE,
		responses: { 200: json(obj({ muted: bool() })) },
	},
	{
		method: "DELETE",
		path: `${MB}/threads/:threadId/mute`,
		operationId: "unmuteThread",
		tag: "Threads",
		summary: "Unmute a conversation",
		capability: ORGANISE,
		responses: { 200: json(obj({ muted: bool() })) },
	},
	{
		method: "GET",
		path: `${MB}/muted-threads`,
		operationId: "listMutedThreads",
		tag: "Threads",
		summary: "Muted conversations",
		capability: ["read"],
		responses: { 200: json(arr(loose())) },
	},

	// ---- Folders
	{
		method: "GET",
		path: `${MB}/folders`,
		operationId: "listFolders",
		tag: "Folders",
		summary: "Folders with unread counts",
		responses: { 200: json(arr(ref("Folder"))) },
	},
	{
		method: "POST",
		path: `${MB}/folders`,
		operationId: "createFolder",
		tag: "Folders",
		summary: "Create a folder",
		capability: ORGANISE,
		body: obj({ name: str() }, ["name"]),
		responses: { 201: json(ref("Folder"), "Created") },
		errors: [409],
	},
	{
		method: "PUT",
		path: `${MB}/folders/:id`,
		operationId: "renameFolder",
		tag: "Folders",
		summary: "Rename a folder",
		capability: ORGANISE,
		body: obj({ name: str() }, ["name"]),
		responses: { 200: json(ref("Folder")) },
	},
	{
		method: "DELETE",
		path: `${MB}/folders/:id`,
		operationId: "deleteFolder",
		tag: "Folders",
		summary: "Delete a custom folder (contents move to the inbox)",
		capability: ORGANISE,
		responses: {
			200: json(obj({ status: str({ const: "deleted" }), relocated: int(), movedTo: str() })),
		},
	},

	// ---- Search
	{
		method: "GET",
		path: `${MB}/search`,
		operationId: "searchEmails",
		tag: "Search",
		summary: "Search with the advanced query syntax",
		capability: ["read"],
		query: [
			q("query", str(), "Search query; supports operators such as from:, in:, has:attachment, OR, -negation."),
			q("folder", str(), "Scope when the query names no folder."),
			q(
				"mode",
				strEnum(["fts", "hybrid"]),
				"`hybrid` merges full-text and semantic (vector) results by reciprocal rank fusion; the response then carries `semantic` (false when it fell back to full-text) and is not paged.",
			),
			PAGE,
			LIMIT,
		],
		responses: { 200: json(ref("EmailPage")) },
	},
	{
		method: "GET",
		path: `${MB}/semantic`,
		operationId: "getSemanticStatus",
		tag: "Search",
		summary: "Semantic index status for this mailbox: messages indexed, queued, and today's usage",
		capability: ["read"],
		responses: {
			200: json(
				obj({
					indexed: int(),
					queued: int(),
					pendingDeletes: int(),
					today: obj({ embeddings: int(), queries: int() }),
				}),
			),
		},
	},
	{
		method: "GET",
		path: "/api/v1/search",
		operationId: "searchAllMailboxes",
		tag: "Search",
		summary: "Hybrid search across every readable mailbox (up to 20)",
		description:
			"Full-text and semantic results merged by reciprocal rank fusion. Only mailboxes the caller may read are searched; " +
			"`semantic` is false (with `fallback`) when the vector index is unavailable, disabled or failed, and results are then full-text only.",
		query: [
			q("q", str(), "Query text."),
			q("mode", strEnum(["fts", "hybrid"]), "Default hybrid."),
			q("mailbox", str(), "One readable mailbox, or `*` (default) for all."),
			q("product", str(), "Product ids or slugs, comma-separated or repeated."),
			q("folder", str(), "Scope the full-text side; `anywhere` includes Trash and Spam."),
			q("limit", int({ minimum: 1, maximum: 50 }), "Default 25."),
		],
		responses: {
			200: json(
				obj({
					results: arr(loose({ mailboxId: str(), id: str(), matched: arr(strEnum(["fts", "vector"])), score: num() })),
					semantic: bool(),
					fallback: strEnum(["unavailable", "disabled", "error"]),
					mode: strEnum(["fts", "hybrid"]),
					mailboxes: arr(str()),
					truncated: arr(str()),
				}),
			),
		},
	},
	{
		method: "POST",
		path: "/api/v1/ask",
		operationId: "askInbox",
		tag: "Search",
		summary: "Ask a question; get an answer cited from your mail",
		description:
			"Retrieves the most relevant passages with hybrid search and answers with the agent model. Citations `[n]` in `answer` map to " +
			"`citations[]`, each with an `href` deep link (`?m=`). When the mail does not answer the question, `insufficient` is true. " +
			"Passages are third-party content, fenced in the prompt; treat the answer as untrusted model output.",
		body: obj(
			{
				question: str({ minLength: 1, maxLength: 500 }),
				mailbox: str({ description: "One readable mailbox, or `*` (default) for all." }),
				product: { oneOf: [str(), arr(str())] },
			},
			["question"],
			{ additionalProperties: false },
		),
		responses: {
			200: json(
				obj({
					question: str(),
					answer: str(),
					insufficient: bool(),
					semantic: bool(),
					citations: arr(
						loose({
							n: int(),
							mailbox: str(),
							email_id: str(),
							thread_id: nullable(str()),
							subject: str(),
							href: str(),
						}),
					),
					sources: arr(loose({ n: int(), mailboxId: str(), email_id: str() })),
					mailboxes: arr(str()),
				}),
			),
		},
		errors: [503],
	},
	{
		method: "GET",
		path: "/api/v1/ai/semantic",
		operationId: "getSemanticAvailability",
		tag: "AI",
		summary: "Whether semantic search is available (index bound, AI bound, enabled)",
		responses: { 200: json(obj({ available: bool(), bound: bool(), enabled: bool() })) },
	},

	// ---- Labels
	{
		method: "GET",
		path: `${MB}/labels`,
		operationId: "listLabels",
		tag: "Labels",
		summary: "Labels with counts",
		responses: { 200: json(arr(ref("Label"))) },
	},
	{
		method: "POST",
		path: `${MB}/labels`,
		operationId: "createLabel",
		tag: "Labels",
		summary: "Create a label",
		capability: ORGANISE,
		body: obj(
			{
				name: str({ minLength: 1, maxLength: 100 }),
				color: str({ pattern: HEX_COLOR_PATTERN }),
				parent_id: nullable(str()),
				sort_order: int(),
			},
			["name"],
		),
		responses: { 201: json(ref("Label"), "Created") },
		errors: [409],
	},
	{
		method: "PUT",
		path: `${MB}/labels/:labelId`,
		operationId: "updateLabel",
		tag: "Labels",
		summary: "Update a label",
		capability: ORGANISE,
		body: obj(
			{
				name: str({ minLength: 1, maxLength: 100 }),
				color: str({ pattern: HEX_COLOR_PATTERN }),
				parent_id: nullable(str()),
				sort_order: int(),
			},
			undefined,
			{ minProperties: 1 },
		),
		responses: { 200: json(ref("Label")) },
	},
	{
		method: "DELETE",
		path: `${MB}/labels/:labelId`,
		operationId: "deleteLabel",
		tag: "Labels",
		summary: "Delete a label",
		capability: ORGANISE,
		responses: { 204: noContent("Deleted") },
	},
	{
		method: "GET",
		path: `${MB}/labels/:labelId/emails`,
		operationId: "listLabelEmails",
		tag: "Labels",
		summary: "Messages carrying a label",
		capability: ["read"],
		query: [...FLAG_FILTERS, PAGE, LIMIT, SORT_COLUMN, SORT_DIRECTION],
		responses: { 200: json(ref("EmailPage")) },
	},
	{
		method: "GET",
		path: `${MB}/emails/:id/labels`,
		operationId: "listEmailLabels",
		tag: "Labels",
		summary: "Labels on one message",
		capability: ["read"],
		responses: { 200: json(arr(ref("EmailLabel"))) },
	},
	{
		method: "PUT",
		path: `${MB}/emails/:id/labels`,
		operationId: "setEmailLabels",
		tag: "Labels",
		summary: "Replace the labels on a message",
		capability: ORGANISE,
		body: obj({ label_ids: arr(str({ minLength: 1 }), { maxItems: 50 }) }, ["label_ids"]),
		responses: { 200: json(arr(ref("EmailLabel"))) },
	},
	{
		method: "POST",
		path: `${MB}/emails/:id/labels`,
		operationId: "addEmailLabel",
		tag: "Labels",
		summary: "Add a label to a message",
		capability: ORGANISE,
		body: obj({ label_id: str({ minLength: 1 }) }, ["label_id"]),
		responses: { 200: json(ref("Status")) },
	},
	{
		method: "DELETE",
		path: `${MB}/emails/:id/labels/:labelId`,
		operationId: "removeEmailLabel",
		tag: "Labels",
		summary: "Remove a label from a message",
		capability: ORGANISE,
		responses: { 204: noContent("Removed") },
	},

	// ---- Signatures
	{
		method: "GET",
		path: `${MB}/signatures`,
		operationId: "listSignatures",
		tag: "Signatures",
		summary: "Signatures",
		capability: ["read"],
		responses: { 200: json(arr(ref("Signature"))) },
	},
	{
		method: "GET",
		path: `${MB}/signatures/default`,
		operationId: "getDefaultSignature",
		tag: "Signatures",
		summary: "The default signature, if any",
		capability: ["read"],
		responses: { 200: json(obj({ signature: nullable(ref("Signature")) }, ["signature"])) },
	},
	{
		method: "POST",
		path: `${MB}/signatures`,
		operationId: "createSignature",
		tag: "Signatures",
		summary: "Create a signature",
		capability: SETTINGS,
		body: obj(
			{
				name: str({ minLength: 1, maxLength: 100 }),
				body_html: str({ maxLength: 50_000 }),
				is_default: bool(),
			},
			["name", "body_html"],
		),
		responses: { 201: json(ref("Signature"), "Created") },
	},
	{
		method: "PUT",
		path: `${MB}/signatures/:signatureId`,
		operationId: "updateSignature",
		tag: "Signatures",
		summary: "Update a signature",
		capability: SETTINGS,
		body: obj(
			{
				name: str({ minLength: 1, maxLength: 100 }),
				body_html: str({ maxLength: 50_000 }),
				is_default: bool(),
			},
			undefined,
			{ minProperties: 1 },
		),
		responses: { 200: json(ref("Signature")) },
	},
	{
		method: "DELETE",
		path: `${MB}/signatures/:signatureId`,
		operationId: "deleteSignature",
		tag: "Signatures",
		summary: "Delete a signature",
		capability: SETTINGS,
		responses: { 204: noContent("Deleted") },
	},

	// ---- Snooze
	{
		method: "GET",
		path: `${MB}/snoozed`,
		operationId: "listSnoozed",
		tag: "Snooze",
		summary: "Snoozed messages",
		capability: ["read"],
		responses: { 200: json(arr(ref("Email"))) },
	},
	{
		method: "POST",
		path: `${MB}/emails/:id/snooze`,
		operationId: "snoozeEmail",
		tag: "Snooze",
		summary: "Snooze a message",
		description: "Provide exactly one of `until` (ISO timestamp in the future) or `delay_seconds`.",
		capability: ORGANISE,
		body: obj({
			until: str({ format: "date-time" }),
			delay_seconds: int({ minimum: 1, maximum: 365 * 24 * 60 * 60 }),
		}),
		responses: { 200: json(ref("Email")) },
	},
	{
		method: "DELETE",
		path: `${MB}/emails/:id/snooze`,
		operationId: "unsnoozeEmail",
		tag: "Snooze",
		summary: "Wake a snoozed message",
		capability: ORGANISE,
		responses: { 200: json(ref("Email")) },
	},

	// ---- Follow-up reminders
	{
		method: "GET",
		path: `${MB}/followups`,
		operationId: "listFollowups",
		tag: "Follow-ups",
		summary: "Awaiting reply",
		description:
			"Reminders on sent mail: fired ones (back in the Inbox) first, then pending ones by due date. " +
			"`status=pending|fired|active` (default active).",
		capability: ["read"],
		query: [
			{ name: "status", in: "query", schema: strEnum(["pending", "fired", "active"]) },
			{ name: "limit", in: "query", schema: int({ minimum: 1, maximum: 500 }) },
		],
		responses: { 200: json(obj({ followups: arr(ref("Followup")) }, ["followups"])) },
	},
	{
		method: "GET",
		path: `${MB}/emails/:id/followup`,
		operationId: "getFollowup",
		tag: "Follow-ups",
		summary: "The reminder on a message or its thread",
		capability: ["read"],
		responses: { 200: json(ref("Followup")) },
	},
	{
		method: "POST",
		path: `${MB}/emails/:id/followup`,
		operationId: "setFollowup",
		tag: "Follow-ups",
		summary: "Remind me if no reply",
		description:
			"Set or replace the reminder on a sent (or queued) message. Provide exactly one of `at` or " +
			"`delay_seconds`, within 90 days. A thread has one reminder: this replaces any other in it. An " +
			"inbound reply cancels it; replying again yourself restarts the clock.",
		capability: ORGANISE,
		body: obj({
			at: str({ format: "date-time" }),
			delay_seconds: int({ minimum: 1, maximum: 90 * 24 * 60 * 60 }),
		}),
		responses: { 200: json(ref("Followup")) },
	},
	{
		method: "POST",
		path: `${MB}/emails/:id/followup/cancel`,
		operationId: "cancelFollowup",
		tag: "Follow-ups",
		summary: "Cancel a reminder",
		description:
			"Cancel the active reminder on this message or its thread. A fired one is dismissed: the message " +
			"goes back to the folder it came from and loses the Follow up label.",
		capability: ORGANISE,
		bodyOptional: true,
		responses: { 200: json(ref("Followup")) },
	},
	{
		method: "DELETE",
		path: `${MB}/emails/:id/followup`,
		operationId: "deleteFollowup",
		tag: "Follow-ups",
		summary: "Cancel a reminder (REST form)",
		capability: ORGANISE,
		responses: { 200: json(ref("Followup")) },
	},

	// ---- AI triage
	{
		method: "GET",
		path: `${MB}/label-prompts`,
		operationId: "listLabelPrompts",
		tag: "Triage",
		summary: "Label prompts, presets and today's AI usage",
		capability: ["read"],
		responses: {
			200: json(
				obj(
					{
						enabled: bool(),
						screener: strEnum(["off", "unknown_only"]),
						daily_ai_cap: int(),
						ai_calls_today: int(),
						corrections: int(),
						backfill_remaining: int(),
						labels: arr(ref("LabelPrompt")),
						presets: arr(ref("TriagePreset")),
					},
					["enabled", "labels", "presets"],
				),
			),
		},
	},
	{
		method: "PUT",
		path: `${MB}/labels/:labelId/prompt`,
		operationId: "setLabelPrompt",
		tag: "Triage",
		summary: "Set a label's prompt, tab and auto-archive",
		description:
			"A label with a prompt becomes an auto-label: new mail is classified against every prompt in one " +
			"Workers AI call. `prompt: null` stops auto-labelling. Rules always win over AI labels.",
		capability: RULES,
		body: obj({
			prompt: nullable(str({ maxLength: 300 })),
			auto_archive: bool(),
			show_tab: bool(),
		}),
		responses: { 200: json(ref("LabelPrompt")) },
	},
	{
		method: "PUT",
		path: `${MB}/triage/presets/:key`,
		operationId: "setTriagePreset",
		tag: "Triage",
		summary: "Turn a preset label on or off",
		description: `Presets: ${TRIAGE_PRESET_KEYS.join(", ")}. Turning one on creates (or adopts) the label.`,
		capability: RULES,
		body: obj({ enabled: bool(), auto_archive: bool(), show_tab: bool() }, ["enabled"]),
		responses: { 200: json(obj({ key: str(), enabled: bool(), label: nullable(ref("LabelPrompt")) })) },
	},
	{
		method: "POST",
		path: `${MB}/triage/backfill`,
		operationId: "backfillTriage",
		tag: "Triage",
		summary: "Classify recent mail, one bounded step",
		description:
			"Looks at the newest 300 messages of the last 14 days that triage has not seen, up to `limit` " +
			"(max 25) per call, within the daily AI cap. Call again while `remaining` > 0.",
		capability: ORGANISE,
		bodyOptional: true,
		body: obj({ limit: int({ minimum: 1, maximum: 25 }) }),
		responses: {
			200: json(obj({ processed: int(), classified: int(), remaining: int(), capped: bool() })),
		},
		errors: [409],
	},
	{
		method: "GET",
		path: `${MB}/inbox-tabs`,
		operationId: "listInboxTabs",
		tag: "Triage",
		summary: "Split-inbox tabs as saved searches",
		description: "Primary is the Inbox minus every tab label. Empty when no label is a tab.",
		capability: ["read"],
		responses: { 200: json(obj({ tabs: arr(ref("InboxTab")) }, ["tabs"])) },
	},

	// ---- Screener
	{
		method: "GET",
		path: `${MB}/screener`,
		operationId: "listScreener",
		tag: "Screener",
		summary: "First-time senders waiting for a decision",
		capability: ["read"],
		query: [{ name: "limit", in: "query", schema: int({ minimum: 1, maximum: 500 }) }],
		responses: { 200: json(obj({ senders: arr(ref("ScreenerSender")) }, ["senders"])) },
	},
	{
		method: "POST",
		path: `${MB}/screener/:sender`,
		operationId: "screenSender",
		tag: "Screener",
		summary: "Yes or No for a screened sender",
		description:
			"`allow` adds the sender to the allowlist and moves their Screener backlog to the Inbox. `block` " +
			"adds them to the blocklist and moves it to Spam (default) or Trash.",
		capability: RULES,
		body: obj({ decision: strEnum(["allow", "block"]), target: strEnum(["spam", "trash"]) }, ["decision"]),
		responses: {
			200: json(obj({ sender: email(), decision: str(), folder: str(), moved: int(), listed: bool() })),
		},
	},

	// ---- Scheduled sends
	{
		method: "GET",
		path: `${MB}/scheduled-sends`,
		operationId: "listScheduledSends",
		tag: "Scheduled sends",
		summary: "Queued outbound messages",
		capability: ["read"],
		responses: { 200: json(arr(ref("ScheduledSend"))) },
	},
	{
		method: "POST",
		path: `${MB}/scheduled-sends`,
		operationId: "scheduleSend",
		tag: "Scheduled sends",
		summary: "Queue a message (also how Undo Send works)",
		description:
			"Same body as sending, plus exactly one of `send_at` or `delay_seconds`. `reply_to_email_id` derives threading server-side. Held for approval: an API token or OAuth app without `mail:send:auto`, on a mailbox whose `agentSend.mode` is `approve` (the default), gets 202 `{status:\"pending_approval\", approval_id, approval_url}` and nothing is sent until a person approves it. `draft_only` refuses with 403. Browser sessions are never held. A held message keeps its send time and is queued on approval.",
		capability: SEND,
		body: {
			allOf: [
				ref("SendEmailRequest"),
				obj({
					send_at: str({ format: "date-time" }),
					delay_seconds: int({ minimum: 1, maximum: 90 * 24 * 60 * 60 }),
					reply_to_email_id: str(),
					threaded_mode: strEnum(["reply", "forward"]),
					supersedes_draft_id: str({ description: "Draft destroyed once the message is queued." }),
				}),
			],
		},
		responses: {
			201: json(
				obj({
					id: str(),
					status: str({ const: "scheduled" }),
					send_at: str(),
					superseded_draft: { type: ["boolean", "string", "null"] },
				}),
				"Queued",
			),
			202: json(ref("PendingApproval"), "Held for approval"),
		},
		errors: [413, 429],
	},
	{
		method: "DELETE",
		path: `${MB}/scheduled-sends/:emailId`,
		operationId: "cancelScheduledSend",
		tag: "Scheduled sends",
		summary: "Cancel a queued send (Undo)",
		capability: SEND,
		responses: { 200: json(ref("Status")) },
		errors: [409],
	},
	{
		method: "POST",
		path: `${MB}/scheduled-sends/:emailId/send-now`,
		operationId: "sendScheduledNow",
		tag: "Scheduled sends",
		summary: "Send a queued message immediately",
		capability: SEND,
		responses: { 200: json(ref("Status")) },
		errors: [409, 503],
	},

	// ---- Senders
	{
		method: "GET",
		path: `${MB}/blocked-senders`,
		operationId: "listBlockedSenders",
		tag: "Senders",
		summary: "Blocked senders",
		responses: { 200: json(arr(ref("SenderRule"))) },
	},
	{
		method: "POST",
		path: `${MB}/blocked-senders`,
		operationId: "blockSender",
		tag: "Senders",
		summary: "Block an address or domain",
		capability: RULES,
		body: obj(
			{ pattern: str({ minLength: 3, maxLength: 320 }), reason: nullable(str({ maxLength: 500 })) },
			["pattern"],
		),
		responses: { 201: json(ref("SenderRule"), "Created") },
		errors: [409],
	},
	{
		method: "DELETE",
		path: `${MB}/blocked-senders/:blockId`,
		operationId: "unblockSender",
		tag: "Senders",
		summary: "Remove a block",
		capability: RULES,
		responses: { 204: noContent("Removed") },
	},
	{
		method: "GET",
		path: `${MB}/allowed-senders`,
		operationId: "listAllowedSenders",
		tag: "Senders",
		summary: "Allowed senders (never marked spam)",
		responses: { 200: json(arr(ref("SenderRule"))) },
	},
	{
		method: "POST",
		path: `${MB}/allowed-senders`,
		operationId: "allowSender",
		tag: "Senders",
		summary: "Allow an address or domain",
		capability: RULES,
		body: obj(
			{ pattern: str({ minLength: 3, maxLength: 320 }), reason: nullable(str({ maxLength: 500 })) },
			["pattern"],
		),
		responses: { 201: json(ref("SenderRule"), "Created") },
		errors: [409],
	},
	{
		method: "DELETE",
		path: `${MB}/allowed-senders/:allowId`,
		operationId: "removeAllowedSender",
		tag: "Senders",
		summary: "Remove an allow entry",
		capability: RULES,
		responses: { 204: noContent("Removed") },
	},

	// ---- Rules
	{
		method: "GET",
		path: `${MB}/rules`,
		operationId: "listRules",
		tag: "Rules",
		summary: "Filter rules in evaluation order",
		responses: { 200: json(arr(ref("Rule"))) },
	},
	{
		method: "POST",
		path: `${MB}/rules`,
		operationId: "createRule",
		tag: "Rules",
		summary: "Create a filter rule",
		capability: RULES,
		body: obj(
			{
				name: str({ minLength: 1, maxLength: 120 }),
				enabled: bool(),
				match_type: strEnum(["all", "any"]),
				conditions: arr(ref("RuleCondition"), { minItems: 1, maxItems: 20 }),
				actions: arr(ref("RuleAction"), { minItems: 1, maxItems: 20 }),
				stop_processing: bool(),
			},
			["name", "conditions", "actions"],
		),
		responses: { 201: json(ref("Rule"), "Created") },
		errors: [422],
	},
	{
		method: "PUT",
		path: `${MB}/rules/:ruleId`,
		operationId: "updateRule",
		tag: "Rules",
		summary: "Update a filter rule",
		capability: RULES,
		body: obj({
			name: str({ minLength: 1, maxLength: 120 }),
			enabled: bool(),
			match_type: strEnum(["all", "any"]),
			conditions: arr(ref("RuleCondition"), { minItems: 1, maxItems: 20 }),
			actions: arr(ref("RuleAction"), { minItems: 1, maxItems: 20 }),
			stop_processing: bool(),
		}),
		responses: { 200: json(ref("Rule")) },
		errors: [422],
	},
	{
		method: "DELETE",
		path: `${MB}/rules/:ruleId`,
		operationId: "deleteRule",
		tag: "Rules",
		summary: "Delete a filter rule",
		capability: RULES,
		responses: { 204: noContent("Deleted") },
	},
	{
		method: "POST",
		path: `${MB}/rules/reorder`,
		operationId: "reorderRules",
		tag: "Rules",
		summary: "Set rule evaluation order",
		capability: RULES,
		body: obj({ ids: arr(str({ minLength: 1 }), { maxItems: 100 }) }, ["ids"]),
		responses: { 200: json(obj({ updated: int() })) },
	},

	// ---- Export / audit
	{
		method: "GET",
		path: `${MB}/export`,
		operationId: "exportMailbox",
		tag: "Export",
		summary: "Download every message as mbox (streamed)",
		capability: ["read"],
		responses: { 200: binary("application/mbox", "mbox file") },
	},
	// ---- Import
	{
		method: "GET",
		path: `${MB}/imports`,
		operationId: "listImports",
		tag: "Import",
		summary: "Recent mail imports, newest first",
		capability: ["read"],
		responses: { 200: json(obj({ imports: arr(ref("ImportJob")) }, ["imports"])) },
	},
	{
		method: "POST",
		path: `${MB}/imports`,
		operationId: "createImport",
		tag: "Import",
		summary: "Start a mail import (file upload or IMAP)",
		description:
			"File sources (`mbox`, `zip` of .eml, single `eml`) create an upload: PUT each part to `/imports/{id}/parts/{n}` " +
			"(`upload.part_size` bytes each, the last part the remainder), then POST `/complete`. `imap` starts at once: " +
			"the app password is encrypted at rest with AUTH_SECRET-derived keys and deleted when the job ends; the host " +
			"must be public, and the connection is TLS on port 993. Imported mail keeps its Date and Message-ID, threads by " +
			"Message-ID, maps Gmail labels (X-Gmail-Labels) and IMAP folders onto folders and labels, and is deduplicated. " +
			"It never triggers forwarding, auto-replies, webhooks, notifications, triage or follow-ups. At most three " +
			"unfinished imports per mailbox.",
		capability: SETTINGS,
		body: {
			oneOf: [
				obj(
					{
						source: strEnum(["mbox", "zip", "eml"]),
						filename: str({ maxLength: 255 }),
						size_bytes: int({ minimum: 1, maximum: 50 * 1024 * 1024 * 1024 }),
						part_size: int({ minimum: 5 * 1024 * 1024, maximum: 50 * 1024 * 1024, description: "Default 10 MiB." }),
						folder: strEnum(["inbox", "archive"], { description: "Where mail without Gmail labels lands. Default archive." }),
					},
					["source", "filename", "size_bytes"],
				),
				obj(
					{
						source: strEnum(["imap"]),
						host: str({ description: "Hostname only, e.g. imap.example.com." }),
						username: str(),
						password: str({ description: "An app password. Stored encrypted until the import ends." }),
						folders: arr(str(), { description: "Only these mailboxes; default every selectable one." }),
					},
					["source", "host", "username", "password"],
				),
			],
		},
		responses: { 201: json(ref("ImportJob")) },
		errors: [409],
	},
	{
		method: "GET",
		path: `${MB}/imports/:id`,
		operationId: "getImport",
		tag: "Import",
		summary: "One import, with progress",
		capability: ["read"],
		responses: { 200: json(ref("ImportJob")) },
	},
	{
		method: "PUT",
		path: `${MB}/imports/:id/parts/:part`,
		operationId: "uploadImportPart",
		tag: "Import",
		summary: "Upload one part of the file",
		description:
			"Raw bytes. Part numbers start at 1; every part but the last is exactly `upload.part_size` bytes. Re-sending a part " +
			"replaces it, so a broken upload resumes by sending the parts not yet counted in `upload.parts_uploaded`.",
		capability: SETTINGS,
		body: str({ contentMediaType: "application/octet-stream" }),
		bodyMediaType: "application/octet-stream",
		responses: { 200: json(ref("ImportJob")) },
		errors: [409],
	},
	...(["complete", "pause", "resume", "cancel"] as const).map(
		(action): RouteDef => ({
			method: "POST",
			path: `${MB}/imports/:id/${action}`,
			operationId: `${action}Import`,
			tag: "Import",
			summary: {
				complete: "Finish the upload and queue the import",
				pause: "Pause a running import",
				resume: "Resume a paused import",
				cancel: "Cancel an import (mail already imported stays)",
			}[action],
			capability: SETTINGS,
			responses: { 200: json(ref("ImportJob")) },
			errors: [409],
		}),
	),
	// ---- Approvals (agent and MCP sends waiting for a person)
	{
		method: "GET",
		path: `${MB}/approvals`,
		operationId: "listSendApprovals",
		tag: "Approvals",
		summary: "Agent and MCP sends waiting for approval, newest first",
		description:
			"Sends by API tokens and OAuth apps (REST or MCP) are held here when the mailbox's `agentSend.mode` is `approve` (the default), unless the credential holds `mail:send:auto` with mode `auto`, or every recipient is on the allowlist.",
		capability: ["read"],
		query: [q("status", strEnum(["pending", "sending", "sent", "sent_unconfirmed", "rejected", "failed", "all"]), "Default pending."), LIMIT],
		responses: { 200: json(obj({ approvals: arr(ref("SendApproval")) }, ["approvals"])) },
	},
	{
		method: "GET",
		path: `${MB}/approvals/count`,
		operationId: "countSendApprovals",
		tag: "Approvals",
		summary: "How many sends are waiting",
		capability: ["read"],
		responses: { 200: json(obj({ pending: int() }, ["pending"])) },
	},
	{
		method: "GET",
		path: `${MB}/approvals/:id`,
		operationId: "getSendApproval",
		tag: "Approvals",
		summary: "One held send, with its full payload",
		capability: ["read"],
		responses: { 200: json(obj({ approval: ref("SendApproval") }, ["approval"])) },
	},
	{
		method: "POST",
		path: `${MB}/approvals/:id/approve`,
		operationId: "approveSendApproval",
		tag: "Approvals",
		summary: "Approve and send a held message exactly as stored, at most once",
		bodyOptional: true,
		body: obj({ revision: int({ minimum: 1, description: "The revision you reviewed. If it has been revised since, 409 and nothing is sent." }) }),
		description:
			"Sends the stored message (what GET shows); edit first with PATCH. Pass `revision` (from GET) so an approve after the requester revised it is refused with 409 instead of sending text you did not see. A second approve returns 409 and sends nothing. Deciding needs a signed-in browser session, or an API token with `approvals:manage` that is not the requester or in its lineage (403 `self_approval`); OAuth apps can never decide (403 `person_required`). A provider refusal before acceptance is `failed` (retryable); an ambiguous error is `sent_unconfirmed` (502, final).",
		capability: SEND,
		responses: { 200: json(obj({ approval: ref("SendApproval"), result: loose() }, ["approval"])) },
		errors: [409],
	},
	{
		method: "PATCH",
		path: `${MB}/approvals/:id`,
		operationId: "editSendApproval",
		tag: "Approvals",
		summary: "Edit a pending held message; the result replaces what will be sent",
		description:
			"Single-message approvals only. A new body passes the same verifier an agent's does, and the verified result is stored and returned, so the preview stays exactly what approve sends. Same deciding rules as approve.",
		capability: SEND,
		body: obj({
			to: { oneOf: [email(), arr(email())] },
			cc: { oneOf: [email(), arr(email())] },
			subject: str({ maxLength: 998 }),
			html: str(),
		}),
		responses: { 200: json(obj({ approval: ref("SendApproval") }, ["approval"])) },
		errors: [409, 422],
	},
	{
		method: "POST",
		path: `${MB}/approvals/:id/revise`,
		operationId: "reviseSendApproval",
		tag: "Approvals",
		summary: "Revise your own pending send in place",
		description:
			"For the credential that asked for the send (the same API token or OAuth app that got `pending_approval`): replace its recipients, subject or body. The same item is updated and its `revision` goes up; it stays pending and a person still approves it. Not a decision, so `approvals:manage` is not needed, and a different credential gets 403. The body passes the same verifier as a fresh send, and agent-inbox recipient limits apply. Single-message approvals only.",
		capability: SEND,
		body: obj({
			to: { oneOf: [email(), arr(email())] },
			cc: { oneOf: [email(), arr(email())] },
			subject: str({ maxLength: 998 }),
			html: str(),
		}),
		responses: { 200: json(obj({ approval: ref("SendApproval") }, ["approval"])) },
		errors: [403, 409, 422],
	},
	{
		method: "POST",
		path: `${MB}/approvals/:id/reject`,
		operationId: "rejectSendApproval",
		tag: "Approvals",
		summary: "Reject a held send; nothing is sent",
		capability: SEND,
		bodyOptional: true,
		body: obj({ note: str({ maxLength: 500 }) }),
		responses: { 200: json(obj({ approval: ref("SendApproval") }, ["approval"])) },
		errors: [409],
	},
	{
		method: "POST",
		path: `${MB}/approvals/:id/retry`,
		operationId: "retrySendApproval",
		tag: "Approvals",
		summary: "Put a failed approved send back in the queue",
		description: "Only `failed` (refused before the provider accepted it). `sent_unconfirmed` returns 409: it may have been delivered.",
		capability: SEND,
		responses: { 200: json(obj({ approval: ref("SendApproval") }, ["approval"])) },
		errors: [409],
	},
	{
		method: "GET",
		path: `${MB}/audit`,
		operationId: "listMailboxAudit",
		tag: "Audit",
		summary: "Who has done what in this mailbox, newest first",
		capability: SETTINGS,
		query: [AUDIT_LIMIT, ...AUDIT_FILTERS],
		responses: { 200: json(arr(ref("AuditEntry"))) },
	},

	// ---- Products
	{
		method: "GET",
		path: "/api/v1/products",
		operationId: "listProducts",
		tag: "Products",
		summary: "Every product, with a default created for any domain that lacks one",
		description: "Agent prompt and knowledge are returned to administrators only.",
		responses: { 200: json(obj({ products: arr(ref("Product")) }, ["products"])) },
	},
	{
		method: "GET",
		path: "/api/v1/products/resolve",
		operationId: "resolveProduct",
		tag: "Products",
		summary: "The product a From address resolves to (alias first, then domain)",
		query: [q("from", str(), "An address or `Name <address>`.")],
		responses: { 200: json(obj({ product: nullable(ref("Product")) })) },
	},
	{
		method: "GET",
		path: "/api/v1/products/:id",
		operationId: "getProduct",
		tag: "Products",
		summary: "One product, by id or slug",
		responses: { 200: json(obj({ product: ref("Product") })) },
	},
	{
		method: "POST",
		path: "/api/v1/products",
		operationId: "createProduct",
		tag: "Products",
		summary: "Create a product (admin)",
		body: obj({
			name: str({ maxLength: 60 }),
			slug: str({ maxLength: 40, pattern: "^[a-z0-9-]+$" }),
			domains: arr(str(), { maxItems: 20 }),
			aliases: arr(email(), { maxItems: 50 }),
			displayName: nullable(str({ maxLength: 60 })),
			accentColor: nullable(str({ pattern: "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$" })),
			signatureHtml: nullable(str({ maxLength: 20000 })),
			agentPrompt: nullable(str({ maxLength: 2000 })),
			knowledgeText: nullable(str({ maxLength: 8000 })),
			knowledgeUrl: nullable(str({ format: "uri" })),
			defaultTemplates: arr(str(), { maxItems: 10 }),
		}),
		responses: { 201: json(obj({ product: ref("Product") }), "Created") },
		errors: [409],
	},
	{
		method: "PATCH",
		path: "/api/v1/products/:id",
		operationId: "updateProduct",
		tag: "Products",
		summary: "Update a product (admin); omitted fields are unchanged",
		body: obj({
			name: str({ maxLength: 60 }),
			slug: str({ maxLength: 40, pattern: "^[a-z0-9-]+$" }),
			domains: arr(str(), { maxItems: 20 }),
			aliases: arr(email(), { maxItems: 50 }),
			displayName: nullable(str({ maxLength: 60 })),
			accentColor: nullable(str({ pattern: "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$" })),
			signatureHtml: nullable(str({ maxLength: 20000 })),
			agentPrompt: nullable(str({ maxLength: 2000 })),
			knowledgeText: nullable(str({ maxLength: 8000 })),
			knowledgeUrl: nullable(str({ format: "uri" })),
			defaultTemplates: arr(str(), { maxItems: 10 }),
		}),
		responses: { 200: json(obj({ product: ref("Product") })) },
		errors: [409],
	},
	{
		method: "DELETE",
		path: "/api/v1/products/:id",
		operationId: "deleteProduct",
		tag: "Products",
		summary: "Delete a product (admin); its domains do not get a new default",
		responses: { 200: json(obj({ ok: bool() })) },
	},
	{
		method: "PUT",
		path: "/api/v1/products/:id/logo",
		operationId: "putProductLogo",
		tag: "Products",
		summary: "Upload a raster logo, base64 (admin)",
		body: obj({ content: str(), filename: str(), type: str() }, ["content", "filename", "type"]),
		responses: { 200: json(obj({ product: ref("Product") })) },
	},
	{
		method: "DELETE",
		path: "/api/v1/products/:id/logo",
		operationId: "deleteProductLogo",
		tag: "Products",
		summary: "Remove a product's logo (admin)",
		responses: { 200: json(obj({ product: ref("Product") })) },
	},
	{
		method: "POST",
		path: "/api/v1/products/:id/knowledge/refresh",
		operationId: "refreshProductKnowledge",
		tag: "Products",
		summary: "Fetch the knowledge URL into storage for the agent (admin)",
		description: "Public https only; no redirects; text or HTML up to 256 KiB, stored as text up to 8,000 characters.",
		responses: { 200: json(obj({ chars: int(), product: nullable(ref("Product")) })) },
		errors: [422],
	},
	{
		method: "GET",
		path: "/api/v1/inbox",
		operationId: "listUnifiedInbox",
		tag: "Products",
		summary: "Unified inbox: conversations across every readable mailbox (up to 20), newest first",
		description:
			"Each row carries `mailboxId` (act on it through that mailbox's routes) and `product`. " +
			"Cursor-paged by per-mailbox high-water marks: pass `nextCursor` back as `cursor`.",
		query: [
			FOLDER,
			q("limit", int({ minimum: 1, maximum: 100 }), "Default 25."),
			q("cursor", str()),
			q("product", str(), "Product ids or slugs, comma-separated or repeated."),
			q("mailboxes", str(), "Narrow to these readable mailboxes, comma-separated."),
			q("unread", bool()),
			q("starred", bool()),
			q("has_attachment", bool()),
		],
		responses: {
			200: json(
				obj({
					emails: arr(loose({ mailboxId: str(), product: nullable(loose()) })),
					nextCursor: nullable(str()),
					unread: int(),
					unreadByMailbox: loose(),
					mailboxes: arr(str()),
					truncated: arr(str(), { description: "Readable mailboxes left out by the cap." }),
					degraded: arr(str(), { description: "Mailboxes that failed to respond." }),
				}),
			),
		},
	},

	// ---- People
	{
		method: "GET",
		path: "/api/v1/people",
		operationId: "listPeople",
		tag: "People",
		summary: "Correspondents across every reachable mailbox",
		query: [
			FOLDER,
			PAGE,
			q("pageSize", int({ minimum: 1 })),
			q("search", str()),
			q("unread", bool()),
			q("hasAttachment", bool()),
			q("recipient", str(), "Only people who wrote to this mailbox address."),
			q("sortKey", strEnum(["recency", "unread", "inbox", "attachments"])),
			q("sortDirection", strEnum(["asc", "desc"])),
		],
		responses: {
			200: json(
				obj({
					people: arr(loose()),
					total: int(),
					page: int(),
					pageSize: int(),
					degraded: arr(str(), { description: "Mailboxes that failed to respond." }),
				}),
			),
		},
	},
	{
		method: "GET",
		path: "/api/v1/people/:person/emails",
		operationId: "listPersonEmails",
		tag: "People",
		summary: "One person's correspondence across mailboxes, newest first",
		query: [q("limit", int({ minimum: 1 }), "Default 100.")],
		responses: {
			200: json(obj({ emails: arr(loose({ mailboxId: str() })), total: int() })),
		},
	},

	// ---- Analytics
	{
		method: "GET",
		path: "/api/v1/analytics",
		operationId: "getAnalytics",
		tag: "Analytics",
		summary: "Message volume across reachable mailboxes",
		query: [q("days", int({ minimum: 1 }), "Window in days (default 30).")],
		responses: {
			200: json(loose({ totals: loose(), byDate: arr(loose({ date: str() })), mailboxes: arr(loose()) })),
		},
	},
	{
		method: "GET",
		path: "/api/v1/analytics/sent",
		operationId: "getSentAnalytics",
		tag: "Analytics",
		summary: "Sent / delivered / failed / opened counts",
		query: [q("days", int({ minimum: 1, maximum: 90 }), "Window in days (default 30).")],
		responses: {
			200: json(
				obj({
					window: obj({ days: int(), start: str(), end: str() }),
					total: loose(),
					mailboxes: arr(loose({ mailboxId: str() })),
				}),
			),
		},
	},
	{
		method: "GET",
		path: "/api/v1/analytics/overview",
		operationId: "getAnalyticsOverview",
		tag: "Analytics",
		summary: "Sending health, reputation, quota, domains, senders, errors and suppressions",
		description:
			"`scope=app` (default) uses the local ledger over the caller's mailboxes, in messages. " +
			"`scope=zone` uses Cloudflare data for the whole zone, in recipients, and needs an administrator. " +
			"Reputation, quota, domains and provider suppressions are returned to administrators only. " +
			"Cloudflare data is cached for 5 minutes; `days=90` returns local data only (`provider.window_capped`).",
		query: [
			ANALYTICS_DAYS_PARAM,
			q("scope", strEnum(["app", "zone"]), "Default app. zone needs an administrator."),
			q("domain", str(), "Restrict to one sending domain."),
			q("product", str(), "Restrict to a product's domains (id or slug; comma-separated or repeated). Unions with domain."),
			ANALYTICS_REFRESH_PARAM,
		],
		responses: { 200: json(ref("AnalyticsOverview")) },
	},
	{
		method: "GET",
		path: "/api/v1/analytics/engagement",
		operationId: "getAnalyticsEngagement",
		tag: "Analytics",
		summary: "Opens and clicks per message and per link",
		query: [ANALYTICS_DAYS_PARAM, q("mailbox", email(), "Restrict to one visible mailbox."), ANALYTICS_REFRESH_PARAM],
		responses: { 200: json(ref("AnalyticsEngagement")) },
	},
	{
		method: "GET",
		path: "/api/v1/analytics/inbound",
		operationId: "getAnalyticsInbound",
		tag: "Analytics",
		summary: "Received mail, auth pass rates, routing actions and rules",
		description: "Cloudflare routing data is returned to administrators; members get local counts for their mailboxes.",
		query: [ANALYTICS_DAYS_PARAM, ANALYTICS_REFRESH_PARAM],
		responses: { 200: json(ref("AnalyticsInbound")) },
	},
	{
		method: "GET",
		path: "/api/v1/analytics/dmarc",
		operationId: "getAnalyticsDmarc",
		tag: "Analytics",
		summary: "DMARC aggregate reports: sources, reporters and failures (administrators)",
		query: [ANALYTICS_DAYS_PARAM, ANALYTICS_REFRESH_PARAM],
		responses: { 200: json(ref("AnalyticsDmarc")) },
	},

	// ---- Templates
	{
		method: "GET",
		path: "/api/v1/templates",
		operationId: "listTemplates",
		tag: "Templates",
		summary: "Email templates",
		responses: { 200: json(arr(ref("Template"))) },
	},
	{
		method: "POST",
		path: "/api/v1/templates",
		operationId: "createTemplate",
		tag: "Templates",
		summary: "Create a template",
		body: obj(
			{
				slug: str({ minLength: 1, maxLength: 100, pattern: SLUG_PATTERN }),
				name: str({ minLength: 1, maxLength: 200 }),
				subject: str({ maxLength: 1000 }),
				bodyHtml: str(),
			},
			["slug", "name", "subject", "bodyHtml"],
		),
		responses: { 201: json(ref("Template"), "Created") },
		errors: [409],
	},
	{
		method: "GET",
		path: "/api/v1/templates/:slug",
		operationId: "getTemplate",
		tag: "Templates",
		summary: "One template",
		responses: { 200: json(ref("Template")) },
	},
	{
		method: "PUT",
		path: "/api/v1/templates/:slug",
		operationId: "updateTemplate",
		tag: "Templates",
		summary: "Update a template",
		body: obj({
			name: str({ minLength: 1, maxLength: 200 }),
			subject: str({ maxLength: 1000 }),
			bodyHtml: str(),
		}),
		responses: { 200: json(ref("Template")) },
	},
	{
		method: "DELETE",
		path: "/api/v1/templates/:slug",
		operationId: "deleteTemplate",
		tag: "Templates",
		summary: "Delete a template",
		responses: { 200: json(ref("Success")) },
	},

	// ---- Sequences
	{
		method: "GET",
		path: "/api/v1/sequences",
		operationId: "listSequences",
		tag: "Sequences",
		summary: "Sequences",
		responses: { 200: json(arr(ref("Sequence"))) },
	},
	{
		method: "POST",
		path: "/api/v1/sequences",
		operationId: "createSequence",
		tag: "Sequences",
		summary: "Create a sequence",
		body: obj(
			{
				name: str({ minLength: 1, maxLength: 200 }),
				steps: arr(ref("SequenceStep"), { minItems: 1, maxItems: 50 }),
			},
			["name", "steps"],
		),
		responses: { 201: json(ref("Sequence"), "Created") },
	},
	{
		method: "GET",
		path: "/api/v1/sequences/:id",
		operationId: "getSequence",
		tag: "Sequences",
		summary: "One sequence",
		responses: { 200: json(ref("Sequence")) },
	},
	{
		method: "PUT",
		path: "/api/v1/sequences/:id",
		operationId: "updateSequence",
		tag: "Sequences",
		summary: "Update a sequence",
		body: obj({
			name: str({ minLength: 1, maxLength: 200 }),
			steps: arr(ref("SequenceStep"), { minItems: 1, maxItems: 50 }),
		}),
		responses: { 200: json(ref("Sequence")) },
	},
	{
		method: "DELETE",
		path: "/api/v1/sequences/:id",
		operationId: "deleteSequence",
		tag: "Sequences",
		summary: "Delete a sequence",
		responses: { 200: json(ref("Success")) },
	},
	{
		method: "GET",
		path: "/api/v1/sequences/:id/enrollments",
		operationId: "listSequenceEnrollments",
		tag: "Sequences",
		summary: "Enrollments in a sequence",
		responses: { 200: json(arr(ref("SequenceEnrollment"))) },
	},
	{
		method: "POST",
		path: "/api/v1/sequences/:id/enroll",
		operationId: "enrollInSequence",
		tag: "Sequences",
		summary: "Enroll a person (schedules every step)",
		body: obj(
			{
				personId: str({ minLength: 1 }),
				personEmail: email(),
				personName: nullable(str()),
				fromAddress: email({ description: "Mailbox the steps are sent from; needs send access to it." }),
				variables: { type: "object", additionalProperties: str() },
				skipSteps: arr(int()),
				delayOverrides: { type: "object", additionalProperties: num({ minimum: 0 }) },
			},
			["personId", "personEmail", "fromAddress"],
		),
		description: "Held for approval: an API token or OAuth app without `mail:send:auto`, on a mailbox whose `agentSend.mode` is `approve` (the default), gets 202 `{status:\"pending_approval\", approval_id, approval_url}` and nothing is sent until a person approves it. `draft_only` refuses with 403. Browser sessions are never held. The approval previews the sequence name and each step rendered for this person.",
		responses: { 201: json(loose(), "Enrolled"), 202: json(ref("PendingApproval"), "Held for approval") },
		errors: [409],
	},
	{
		method: "GET",
		path: "/api/v1/sequences/people/:personId/enrollment",
		operationId: "getPersonEnrollment",
		tag: "Sequences",
		summary: "A person's active enrollment and its scheduled emails",
		responses: {
			200: json(
				obj({
					enrollment: nullable(ref("SequenceEnrollment")),
					scheduledEmails: arr(loose()),
					sequenceName: nullable(str()),
				}),
			),
		},
	},
	{
		method: "DELETE",
		path: "/api/v1/sequences/enrollments/:enrollmentId",
		operationId: "cancelEnrollment",
		tag: "Sequences",
		summary: "Cancel an enrollment and its pending emails",
		responses: { 200: json(ref("Success")) },
	},

	// ---- Migration (admin + X-Migration-Token)
	{
		method: "GET",
		path: "/api/v1/_migrate/mailboxes/:mailboxId/status",
		operationId: "getMigrationStatus",
		tag: "Migration",
		summary: "Compare row counts between legacy and current namespace (admin)",
		description: "404 unless MIGRATION_TOKEN is configured; 409 without a LEGACY_MAILBOX binding.",
		headers: [MIGRATION_TOKEN],
		responses: {
			200: json(
				loose({ mailboxId: str(), legacy: loose(), current: loose(), emailsOutstanding: int() }),
			),
		},
		errors: [409],
	},
	// ---- Suppressions (reads: any member, mail:read; writes: admin, mailboxes:manage or admin)
	{
		method: "GET",
		path: "/api/v1/suppressions",
		operationId: "listSuppressions",
		tag: "Suppressions",
		summary: "List suppressed addresses, newest first",
		description:
			"Addresses that sequences, template sends and non-transactional sends skip. Unsubscribes come from the public `/u/{token}` page (GET confirms, POST is RFC 8058 one-click; outside /api/v1, so not listed here) and from mailto replies; hard bounces from DSNs, the delivery reconciler and E_RECIPIENT_SUPPRESSED.",
		query: [
			q("q", str(), "Substring of the address."),
			q("scope", str(), '"global" or a sending domain.'),
			q("reason", strEnum(["unsubscribed", "hard_bounce", "complaint", "manual"])),
			q("limit", int({ minimum: 1, maximum: 500 }), "Page size (default 50)."),
			q("offset", int({ minimum: 0 }), "Entries to skip."),
		],
		responses: {
			200: json(obj({ items: arr(ref("Suppression")), total: int(), limit: int(), offset: int() }, ["items", "total"])),
		},
	},
	{
		method: "POST",
		path: "/api/v1/suppressions",
		operationId: "addSuppressions",
		tag: "Suppressions",
		summary: "Suppress one address or a batch (admin)",
		body: {
			oneOf: [
				ref("SuppressionInput"),
				obj({ entries: arr(ref("SuppressionInput"), { minItems: 1, maxItems: 1000 }) }, ["entries"]),
			],
		},
		responses: {
			200: json(ref("SuppressionAddResult"), "Nothing new (already listed)"),
			201: json(ref("SuppressionAddResult"), "Added"),
		},
	},
	{
		method: "POST",
		path: "/api/v1/suppressions/import",
		operationId: "importSuppressions",
		tag: "Suppressions",
		summary: "Bulk import from CSV (admin)",
		description:
			"JSON `{csv, scope?, reason?}`, or a raw CSV body with `?scope=&reason=`. One address per line, or columns address,scope,reason (an `email` column works too). Up to 10,000 rows and 5 MB; bad rows are skipped and reported by line.",
		body: obj(
			{
				csv: str(),
				scope: str({ description: "For rows without one; default global." }),
				reason: strEnum(["unsubscribed", "hard_bounce", "complaint", "manual"]),
			},
			["csv"],
		),
		responses: {
			200: json(
				obj({
					added: int(),
					existing: int(),
					rows: int(),
					maxRows: int(),
					errorCount: int(),
					errors: arr(obj({ line: int(), error: str() })),
				}),
			),
		},
		errors: [413],
	},
	{
		method: "POST",
		path: "/api/v1/suppressions/check",
		operationId: "checkSuppressions",
		tag: "Suppressions",
		summary: "Which of these addresses are suppressed",
		description: "Read-only; a POST only to carry the list. With `from` (a mailbox or domain) only entries that apply to it are returned.",
		body: obj(
			{ addresses: arr(str(), { minItems: 1, maxItems: 200 }), from: str() },
			["addresses"],
		),
		responses: { 200: json(obj({ items: arr(ref("Suppression")) }, ["items"])) },
	},
	{
		method: "DELETE",
		path: "/api/v1/suppressions/:id",
		operationId: "deleteSuppression",
		tag: "Suppressions",
		summary: "Remove an entry (admin)",
		responses: { 200: json(ref("Success")) },
	},
	{
		method: "POST",
		path: `${MB}/template-sends`,
		operationId: "sendTemplate",
		tag: "Suppressions",
		summary: "Render a template and send one message per recipient (bulk)",
		description:
			"Non-transactional: suppressed recipients are skipped, and each message carries its own signed List-Unsubscribe link (RFC 8058 one-click), `List-Id: <template-slug.domain>`, and a footer unless the template places {{unsubscribe_url}}. Refused with 423 while the domain's bulk sending is paused. Needs sendAs: template mail has no Sender attribution.",
		capability: ["sendAs"],
		body: obj(
			{
				template: str({ minLength: 1, maxLength: 100 }),
				from: email({ description: "Must be the mailbox address in the path." }),
				recipients: arr(
					obj({ email: email(), variables: obj({}, undefined, { additionalProperties: str() }) }, ["email"]),
					{ minItems: 1, maxItems: 50 },
				),
				variables: obj({}, undefined, { additionalProperties: str(), description: "Shared; per-recipient values win." }),
				track: bool({
				description:
						"false sends this message without open/click tracking. Omit to follow the mailbox setting; true cannot override a mailbox that has tracking off or a recipient who opted out.",
				}),
			},
			["template", "recipients"],
		),
		responses: {
			200: json(ref("TemplateSendResult"), "Nothing sent"),
			202: json({ oneOf: [ref("TemplateSendResult"), ref("PendingApproval")] }, "At least one message sent, or the batch was held for approval (every rendered message is stored)"),
		},
		errors: [423, 429],
	},
	// ---- Sending health (spam-rate circuit breaker) and per-mailbox send caps
	{
		method: "GET",
		path: "/api/v1/sending-health",
		operationId: "listSendingHealth",
		tag: "Sending health",
		summary: "Spam complaint rate and bulk-pause state per sending domain",
		description:
			"Rolling 7-day complaints / delivered per sending domain, from the local delivery ledger and, when CF_ANALYTICS_TOKEN is set, Cloudflare's complaint and sending datasets (the worse of the two wins). Above 0.1% the level is `warning` and a `deliverability.warning` webhook fires; above 0.3% (the Gmail/Yahoo limit) bulk sends (sequences, template sends, `transactional:false`) are paused until an administrator resumes them. Below 100 delivered the level is `insufficient_volume`. Members see the domains of mailboxes they can access.",
		responses: {
			200: json(
				obj({
					domains: arr(ref("SendingDomainHealth")),
					thresholds: obj({ warning: num(), pause: num(), window_days: int(), minimum_delivered: int() }),
				}),
			),
		},
	},
	{
		method: "POST",
		path: "/api/v1/sending-health/evaluate",
		operationId: "evaluateSendingHealth",
		tag: "Sending health",
		summary: "Re-evaluate every sending domain now (admin)",
		description: "The cron does this hourly. May pause a domain and send webhooks, exactly like the scheduled run.",
		responses: {
			200: json(
				loose({
					evaluated: int(),
					notified: int(),
					paused: arr(str()),
					domains: arr(ref("SendingDomainHealth")),
					provider: strEnum(["used", "unavailable", "error"]),
				}),
			),
		},
	},
	{
		method: "POST",
		path: "/api/v1/sending-health/:domain/resume",
		operationId: "resumeBulkSending",
		tag: "Sending health",
		summary: "Resume paused bulk sending for a domain (admin, audited)",
		description:
			"Writes a `sending.resume` audit entry. The breaker will not re-pause the domain for 24 hours, since the 7-day window still holds the complaints that tripped it.",
		responses: { 200: json(obj({ domain: ref("SendingDomainHealth") })) },
		errors: [503],
	},
	{
		method: "POST",
		path: "/api/v1/sending-health/:domain/pause",
		operationId: "pauseBulkSending",
		tag: "Sending health",
		summary: "Pause bulk sending for a domain by hand (admin, audited)",
		body: obj({ reason: str({ maxLength: 300 }) }, undefined, { additionalProperties: false }),
		bodyOptional: true,
		responses: { 200: json(obj({ domain: ref("SendingDomainHealth") })) },
		errors: [503],
	},
	{
		method: "GET",
		path: `${MB}/send-limits`,
		operationId: "getSendLimits",
		tag: "Sending health",
		summary: "The mailbox's send caps and usage, plus the account quota (admins)",
		responses: { 200: json(ref("SendLimits")) },
	},
	{
		method: "PUT",
		path: `${MB}/send-limits`,
		operationId: "updateSendLimits",
		tag: "Sending health",
		summary: "Change the mailbox's send caps (admin, audited)",
		description: "Hourly 1-1,000 and daily 1-10,000; the hourly cap may not exceed the daily one. Writes a `mailbox.send_limits` audit entry.",
		body: obj(
			{ hourly: int({ minimum: 1, maximum: 1000 }), daily: int({ minimum: 1, maximum: 10000 }) },
			undefined,
			{ additionalProperties: false },
		),
		responses: { 200: json(ref("SendLimits")) },
	},
	// ---- Usage (admin)
	{
		method: "GET",
		path: "/api/v1/usage",
		operationId: "getUsage",
		tag: "Usage",
		summary: "This month's usage and projected cost: Email Service, Workers AI, R2, Durable Objects, caps and budget (admin)",
		description:
			"Month to date (UTC) with a linear month-end projection. Email: Cloudflare's account-wide send count (envelope recipients) against the 3,000 included on Workers Paid, then $0.35 per 1,000; without CF_ANALYTICS_TOKEN, this app's own ledger in messages. " +
			"AI: this app's calls per feature, counted locally, plus Cloudflare's neurons (account-wide; 10,000 a day free, then $0.011 per 1,000). " +
			"Cloudflare data is cached 5 minutes; `refresh=1` skips the cache.",
		query: [q("refresh", strEnum(["1"]), "Skip the 5-minute cache.")],
		responses: { 200: json(ref("Usage")) },
	},
	{
		method: "PUT",
		path: "/api/v1/usage/budget",
		operationId: "updateUsageBudget",
		tag: "Usage",
		summary: "Set or clear the monthly budget thresholds (admin, audited)",
		description:
			"When projected AI or email cost for the month passes its threshold, the Usage tab shows a banner and a `usage.budget_exceeded` webhook fires once per month per kind. Omit a key to keep it; null clears it.",
		body: obj(
			{ ai_usd: nullable(num({ minimum: 0, maximum: 1_000_000 })), email_usd: nullable(num({ minimum: 0, maximum: 1_000_000 })) },
			undefined,
			{ additionalProperties: false },
		),
		responses: { 200: json(obj({ budget: ref("UsageBudget") }, ["budget"])) },
		errors: [503],
	},
	// ---- Domains (admin; scoped tokens need domains:manage or admin)
	{
		method: "GET",
		path: "/api/v1/domains",
		operationId: "listDomains",
		tag: "Domains",
		summary: "List served domains with routing, sending and catch-all status (admin)",
		responses: { 200: json(obj({ domains: arr(ref("Domain")), cloudflare: ref("CloudflareInfo") })) },
	},
	{
		method: "POST",
		path: "/api/v1/domains",
		operationId: "createDomain",
		tag: "Domains",
		summary: "Add a domain (admin)",
		body: obj(
			{
				hostname: str({ maxLength: 253 }),
				displayName: str({ maxLength: 100 }),
				zoneId: str({ pattern: "^[a-fA-F0-9]{32}$" }),
				catchAllMailbox: email({ description: "Existing mailbox on the same domain." }),
			},
			["hostname"],
		),
		responses: { 201: json(obj({ domain: ref("Domain") }), "Created") },
		errors: [409],
	},
	{
		method: "GET",
		path: "/api/v1/domains/:id",
		operationId: "getDomain",
		tag: "Domains",
		summary: "One domain with expected DNS records, manual steps and the last audit and provisioning run (admin)",
		responses: {
			200: json(
				obj({
					domain: ref("Domain"),
					records: arr(ref("DnsRecordSpec")),
					manualSteps: arr(str()),
					audit: nullable(loose()),
					provision: nullable(loose()),
					cloudflare: ref("CloudflareInfo"),
				}),
			),
		},
	},
	{
		method: "PATCH",
		path: "/api/v1/domains/:id",
		operationId: "updateDomain",
		tag: "Domains",
		summary: "Rename a domain or set or clear its catch-all mailbox (admin)",
		body: obj({ displayName: str({ maxLength: 100 }), catchAllMailbox: nullable(email()) }),
		responses: { 200: json(obj({ domain: ref("Domain") })) },
	},
	{
		method: "DELETE",
		path: "/api/v1/domains/:id",
		operationId: "deleteDomain",
		tag: "Domains",
		summary: "Remove a runtime domain with no mailboxes (admin)",
		responses: { 200: json(obj({ ok: bool() })) },
		errors: [409],
	},
	{
		method: "POST",
		path: "/api/v1/domains/:id/verify",
		operationId: "verifyDomain",
		tag: "Domains",
		summary: "Re-run the DNS audit for a domain (admin)",
		responses: { 200: json(obj({ domain: ref("Domain"), audit: loose() })) },
	},
	{
		method: "POST",
		path: "/api/v1/domains/:id/provision",
		operationId: "provisionDomain",
		tag: "Domains",
		summary: "Configure routing, sending and catch-all through the Cloudflare API (admin; needs a Cloudflare connection or CF_API_TOKEN)",
		body: obj({
			overwriteCatchAll: bool(),
			confirmEnvDomain: bool({ description: "Required for a domain from DOMAINS/ZONES." }),
		}),
		bodyOptional: true,
		responses: { 200: json(obj({ domain: ref("Domain"), provision: loose() })) },
		errors: [412, 428],
	},
	{
		method: "GET",
		path: `${MB}/aliases`,
		operationId: "listMailboxAliases",
		tag: "Domains",
		summary: "Addresses this mailbox can send as and receive at, besides its own",
		responses: { 200: json(obj({ aliases: arr(email()) })) },
	},
	{
		method: "PUT",
		path: `${MB}/aliases`,
		operationId: "setMailboxAliases",
		tag: "Domains",
		summary: "Replace a mailbox's aliases (admin)",
		body: obj({ aliases: arr(email()) }, ["aliases"]),
		responses: { 200: json(loose({ aliases: arr(email()) })) },
		errors: [409],
	},

	// ---- Webhooks (scoped tokens need webhooks:manage; admins manage all,
	// mailbox owners manage hooks limited to mailboxes they own)
	{
		method: "GET",
		path: "/api/v1/webhooks/events",
		operationId: "listWebhookEvents",
		tag: "Webhooks",
		summary: "The event types and the retry policy",
		responses: {
			200: json(
				obj({
					events: arr(obj({ type: strEnum(WEBHOOK_EVENT_TYPES), label: str(), hint: str() })),
					retry: obj({ maxAttempts: int(), delaysMs: arr(int()) }),
				}),
			),
		},
	},
	{
		method: "GET",
		path: "/api/v1/webhooks",
		operationId: "listWebhooks",
		tag: "Webhooks",
		summary: "List the webhook endpoints you can manage",
		responses: { 200: json(obj({ webhooks: arr(ref("Webhook")) })) },
		errors: [503],
	},
	{
		method: "POST",
		path: "/api/v1/webhooks",
		operationId: "createWebhook",
		tag: "Webhooks",
		summary: "Create an endpoint; the signing secret is returned once",
		body: obj(
			{
				name: str({ minLength: 1, maxLength: 100 }),
				url: str({ format: "uri", description: "https only; private and internal hosts are refused." }),
				events: WebhookEvents,
				mailboxes: nullable(arr(email(), { maxItems: 100, description: "Omit or null for every mailbox (administrators only)." })),
				enabled: bool(),
			},
			["name", "url", "events"],
		),
		responses: { 201: json(obj({ webhook: ref("Webhook"), secret: str({ description: "whsec_…, shown once." }) }), "Created") },
		errors: [503],
	},
	{
		method: "GET",
		path: "/api/v1/webhooks/:id",
		operationId: "getWebhook",
		tag: "Webhooks",
		summary: "One webhook endpoint",
		responses: { 200: json(obj({ webhook: ref("Webhook") })) },
	},
	...(["PATCH", "PUT"] as const).map(
		(method): RouteDef => ({
			method,
			path: "/api/v1/webhooks/:id",
			operationId: method === "PATCH" ? "updateWebhook" : "replaceWebhookFields",
			tag: "Webhooks",
			summary:
				method === "PATCH"
					? "Change an endpoint's name, URL, events, mailboxes or enabled flag; re-enabling resets the failure count"
					: "Same as PATCH, for clients that use PUT for partial updates",
			body: obj({
				name: str({ minLength: 1, maxLength: 100 }),
				url: str({ format: "uri" }),
				events: WebhookEvents,
				mailboxes: nullable(arr(email(), { maxItems: 100 })),
				enabled: bool(),
			}),
			responses: { 200: json(obj({ webhook: ref("Webhook") })) },
		}),
	),
	{
		method: "DELETE",
		path: "/api/v1/webhooks/:id",
		operationId: "deleteWebhook",
		tag: "Webhooks",
		summary: "Delete an endpoint and its delivery log",
		responses: { 200: json(obj({ status: str(), id: str() })) },
	},
	{
		method: "POST",
		path: "/api/v1/webhooks/:id/rotate-secret",
		operationId: "rotateWebhookSecret",
		tag: "Webhooks",
		summary: "Replace the signing secret; the old one stops working at once",
		responses: { 200: json(obj({ webhook: ref("Webhook"), secret: str() })) },
	},
	{
		method: "POST",
		path: "/api/v1/webhooks/:id/test",
		operationId: "testWebhook",
		tag: "Webhooks",
		summary: 'Send a sample event (marked "test": true) now and return the result; not retried',
		responses: { 200: json(obj({ delivery: nullable(ref("WebhookDelivery")) })) },
	},
	{
		method: "GET",
		path: "/api/v1/webhooks/:id/deliveries",
		operationId: "listWebhookDeliveries",
		tag: "Webhooks",
		summary: "Recent deliveries, newest first, with every attempt (the last 100 are kept)",
		query: [q("limit", int({ minimum: 1, maximum: 100 }), "How many to return (default 50).")],
		responses: { 200: json(obj({ deliveries: arr(ref("WebhookDelivery")) })) },
	},
	{
		method: "POST",
		path: "/api/v1/webhooks/deliveries/:deliveryId/retry",
		operationId: "retryWebhookDelivery",
		tag: "Webhooks",
		summary: "Re-send one delivery now",
		responses: { 200: json(obj({ delivery: nullable(ref("WebhookDelivery")) })) },
	},

	// ---- Privacy
	{
		method: "GET",
		path: `${MB}/settings/tracking`,
		operationId: "getTrackingSettings",
		tag: "Privacy",
		summary: "The mailbox's open, click and attachment tracking toggles",
		responses: { 200: json(ref("TrackingSettings")) },
	},
	{
		method: "PATCH",
		path: `${MB}/settings/tracking`,
		operationId: "updateTrackingSettings",
		tag: "Privacy",
		summary: "Change tracking toggles and the disclosure line",
		capability: SETTINGS,
		body: obj(
			{
				openTracking: bool(),
				clickTracking: bool(),
				attachmentTracking: bool(),
				disclosureEnabled: bool(),
				disclosureText: nullable(str({ maxLength: 300 })),
			},
			undefined,
			{ additionalProperties: false },
		),
		responses: { 200: json(ref("TrackingSettings")) },
	},
	{
		method: "GET",
		path: "/api/v1/privacy",
		operationId: "getPrivacySettings",
		tag: "Privacy",
		summary: "The operator's privacy notice settings and retention periods",
		description: "Rendered publicly at /privacy (outside /api/v1).",
		responses: { 200: json(ref("PrivacySettings")) },
	},
	{
		method: "PUT",
		path: "/api/v1/privacy",
		operationId: "updatePrivacySettings",
		tag: "Privacy",
		summary: "Edit the privacy notice and retention periods (admin)",
		body: loose({}, "Any subset of PrivacySettings except updatedAt; retention fields are clamped to their bounds."),
		responses: { 200: json(ref("PrivacySettings")) },
	},
	{
		method: "GET",
		path: "/api/v1/account/deletion",
		operationId: "getAccountDeletion",
		tag: "Privacy",
		summary: "Whether your account is scheduled for deletion",
		responses: { 200: json(loose({ pending: bool(), requestedAt: int(), purgeAfter: int() })) },
	},
	{
		method: "DELETE",
		path: "/api/v1/account",
		operationId: "deleteAccount",
		tag: "Privacy",
		summary: "Delete your own account after a 7-day grace period",
		description:
			"Needs a browser session that re-confirmed its password or passkey in the last 15 minutes (POST /api/auth/passkeys/reauth). Revokes every session, API token and connected app at once. Mailboxes you alone own are purged when the grace period ends; shared ones are kept. The owner cannot delete themselves (409 sole_owner).",
		responses: {
			202: json(loose({ status: str(), requestedAt: int(), purgeAfter: int(), mailboxes: arr(str()) }), "Scheduled"),
		},
		errors: [409],
	},
	{
		method: "POST",
		path: "/api/v1/account/deletion/cancel",
		operationId: "cancelAccountDeletion",
		tag: "Privacy",
		summary: "Cancel a pending deletion (sessions and tokens stay revoked)",
		bodyOptional: true,
		responses: { 200: json(loose({ status: str() })) },
	},
	{
		method: "GET",
		path: "/api/v1/account/exports",
		operationId: "listAccountExports",
		tag: "Privacy",
		summary: "Your account exports",
		responses: { 200: json(obj({ exports: arr(ref("AccountExport")) }, ["exports"])) },
	},
	{
		method: "POST",
		path: "/api/v1/account/exports",
		operationId: "createAccountExport",
		tag: "Privacy",
		summary: "Start an export of your account and the mailboxes you own",
		description:
			"Built in the background into a ZIP (account.json plus one mbox per mailbox). Poll the list; a ready export carries a signed download link valid for 24 hours. Needs a recently re-confirmed browser session.",
		bodyOptional: true,
		responses: { 200: json(ref("AccountExport"), "An export is already running"), 202: json(ref("AccountExport"), "Started") },
	},
	{
		method: "GET",
		path: "/api/v1/account/exports/:id/download",
		operationId: "downloadAccountExport",
		tag: "Privacy",
		summary: "Download a finished export (signed link)",
		query: [q("token", str(), "The signed token from downloadUrl.")],
		responses: { 200: binary("application/zip", "The archive") },
	},
	// ---- Agent inboxes
	{
		method: "POST",
		path: "/api/v1/agent-inboxes",
		operationId: "createAgentInbox",
		tag: "Agent inboxes",
		summary: "Create a mailbox for an agent, with a scoped token and optional webhook (admin)",
		description:
			"Creates a real mailbox and returns a `ttk_` token restricted to it, with scopes from `send_mode` " +
			"(draft_only: mail:read, mail:draft, mail:organize; approve: also mail:send; auto: also mail:send and mail:send:auto). The token secret and " +
			"the webhook secret are returned once; an idempotent replay returns them as null with `secret_redacted`. " +
			"Cloudflare routing is never changed: `warnings` says when a routing rule is still needed. " +
			"`send_mode` is also the new mailbox's `agentSend.mode`: `approve` holds the agent's sends in Pending approval " +
			"(202 `pending_approval`), `auto` sends them. A recipient outside `allowed_recipients` is refused (422) in every mode, never held.",
		body: obj(
			{
				domain: str({ description: "A domain this deployment serves." }),
				local_part: str({ maxLength: 64, description: "Omit for agent-<6 random characters>." }),
				purpose: str({ minLength: 1, maxLength: 500 }),
				ttl_hours: { type: "number", minimum: 0, maximum: 2160, description: "Hours until it is archived and deleted; must be above 0. Omit for no expiry." },
				allowed_recipients: arr(str(), { maxItems: 200, description: "Addresses or @domain patterns. Omit for no restriction." }),
				send_mode: strEnum(AGENT_SEND_MODES),
				webhook_url: str({ format: "uri", description: "Public https URL; gets every event for this mailbox." }),
				display_name: str({ maxLength: 100 }),
			},
			["domain", "purpose", "send_mode"],
		),
		responses: {
			201: json(
				obj({
					agent_inbox: AgentInbox,
					address: email(),
					token: obj({ id: str(), secret: nullable(str({ description: "ttk_…, shown once." })), scopes: arr(strEnum(TOKEN_SCOPES)), mailboxes: arr(email()), expires_at: nullable(int()) }),
					policy: obj({ send_mode: strEnum(AGENT_SEND_MODES), allowed_recipients: nullable(arr(str())), ttl_hours: nullable({ type: "number" }), expires_at: nullable(int()) }),
					webhook: nullable(obj({ id: str(), url: str(), events: WebhookEvents, secret: nullable(str({ description: "whsec_…, shown once." })) })),
					routing: obj({ routed: bool(), source: strEnum(["catch_all_rule", "provision_record", "unknown"]), warning: nullable(str()) }),
					warnings: arr(str()),
				}),
				"Created",
			),
		},
		errors: [409, 503],
	},
	{
		method: "GET",
		path: "/api/v1/agent-inboxes",
		operationId: "listAgentInboxes",
		tag: "Agent inboxes",
		summary: "List agent inboxes with their expiry (admin)",
		responses: { 200: json(obj({ agent_inboxes: arr(AgentInbox) })) },
	},
	{
		method: "GET",
		path: "/api/v1/agent-inboxes/:address",
		operationId: "getAgentInbox",
		tag: "Agent inboxes",
		summary: "One agent inbox (admin)",
		responses: { 200: json(obj({ agent_inbox: AgentInbox })) },
	},
	{
		method: "PATCH",
		path: "/api/v1/agent-inboxes/:address",
		operationId: "updateAgentInbox",
		tag: "Agent inboxes",
		summary: "Change or clear an agent inbox's recipient restriction",
		description:
			"`allowed_recipients: null` removes the restriction, so the inbox may send to anyone; that is the default. An array of addresses or `@domain`s restricts it to those, and anyone else is refused (never held). Administrators only; a token needs `mailboxes:manage`.",
		body: obj({ allowed_recipients: nullable(arr(str({ description: "An address, or @domain for a whole domain." }))) }, ["allowed_recipients"]),
		responses: { 200: json(obj({ agent_inbox: AgentInbox })) },
		errors: [400],
	},
	{
		method: "DELETE",
		path: "/api/v1/agent-inboxes/:address",
		operationId: "deleteAgentInbox",
		tag: "Agent inboxes",
		summary: "End an agent inbox now: revoke, archive to R2 as mbox, delete (admin)",
		responses: {
			200: json(
				obj({
					ended: obj({
						address: email(),
						token_revoked: bool(),
						webhook_disabled: bool(),
						archive: nullable(obj({ key: str(), messages: int(), truncated: bool() })),
						mailbox_deleted: bool(),
					}),
				}),
			),
		},
	},

	// ---- Realtime events
	{
		method: "GET",
		path: "/api/v1/events/stream",
		operationId: "streamEvents",
		tag: "Events",
		summary: "Realtime events over WebSocket (upgrade required)",
		description:
			"A WebSocket; OpenAPI cannot describe the message exchange, so see docs/realtime.md. Connect with " +
			"`Upgrade: websocket` and a bearer token or session, then send " +
			'`{"type":"subscribe","mailboxes":[...],"events":[...]}`. Each event arrives as ' +
			'`{"type":"event","id":<n>,"event":<webhook payload>}`. Only mailboxes you can read are delivered. ' +
			"`since` replays retained events (24 hours) after that id. Without an upgrade this answers 426.",
		query: [q("since", int({ minimum: 0 }), "Replay events after this id.")],
		responses: {
			101: { description: "Switching Protocols" },
			426: json(obj({ error: str(), events: WebhookEvents }), "Not a WebSocket upgrade"),
		},
		errors: [429, 503],
	},
	{
		method: "GET",
		path: "/api/v1/events/sse",
		operationId: "streamEventsSse",
		tag: "Events",
		summary: "Realtime events as Server-Sent Events",
		description:
			"`text/event-stream` fallback for the WebSocket. Each event is `id: <n>`, `event: <type>`, " +
			"`data: <webhook payload>`. Reconnect with `Last-Event-ID` or `since` to resume.",
		query: [
			q("since", int({ minimum: 0 }), "Replay events after this id."),
			q("mailbox", email(), "Repeatable. Only these mailboxes (must be readable)."),
			q("event", strEnum(WEBHOOK_EVENT_TYPES), "Repeatable. Only these event types."),
		],
		responses: { 200: { description: "An event stream", content: { "text/event-stream": { schema: str() } } } },
		errors: [429, 503],
	},

	{
		method: "POST",
		path: "/api/v1/_migrate/mailboxes/:mailboxId",
		operationId: "migrateMailbox",
		tag: "Migration",
		summary: "Copy a mailbox from the legacy namespace (admin, idempotent)",
		headers: [MIGRATION_TOKEN],
		query: [q("dryRun", strEnum(["1", "true"]), "Report what would be copied without writing.")],
		responses: {
			200: json(loose({ mailboxId: str(), dryRun: bool(), inserted: loose(), legacy: loose(), current: loose() })),
		},
		errors: [409],
	},
];

// -- Build ------------------------------------------------------------------

const PARAM_RE = /:([A-Za-z0-9_]+)/g;

/** `:name` → `{name}`. */
function toOpenApiPath(honoPath: string): string {
	return honoPath.replace(PARAM_RE, "{$1}");
}

/** `{name}` → `:name`. */
function toHonoPath(openApiPath: string): string {
	return openApiPath.replace(/\{([^}]+)\}/g, ":$1");
}

/** The scope a token needs for a route: the guard's, or the capability's. */
function tokenScopeFor(def: RouteDef): ApiTokenScope {
	const concrete = def.path.replace(PARAM_RE, "x");
	const guard = requiredTokenScope(def.method, concrete);
	if (guard !== "mailbox") return guard;
	const cap = def.capability?.[0];
	// Unreachable for a correctly described route (the test asserts it); fail
	// towards the narrowest description rather than claiming less is needed.
	return cap ? CAPABILITY_SCOPE[cap] : "admin";
}

function buildOperation(def: RouteDef): OperationObject {
	const pathParams: ParameterObject[] = [...def.path.matchAll(PARAM_RE)].map((m) => ({
		name: m[1],
		in: "path",
		required: true,
		description: PATH_PARAM_DESCRIPTIONS[m[1]] ?? m[1],
		schema: str(),
	}));
	const keyed = def.method === "POST" && IDEMPOTENT_PATHS.has(def.path);
	const parameters = [
		...pathParams,
		...(def.query ?? []),
		...(def.headers ?? []),
		...(keyed ? [IDEMPOTENCY_KEY_PARAM] : []),
	];

	const out: Record<string, ResponseObject | ReferenceObject> = { ...def.responses };
	if (keyed) {
		// Replays carry `Idempotent-Replayed: true` on whatever status was stored.
		for (const [code, res] of Object.entries(out)) {
			if (Number(code) < 300 && !("$ref" in res)) {
				out[code] = { ...res, headers: { ...(res.headers ?? {}), "Idempotent-Replayed": IDEMPOTENT_REPLAYED } };
			}
		}
		out[409] = { $ref: "#/components/responses/IdempotencyConflict" };
	}
	const codes = new Set<number>(def.errors ?? []);
	if (def.body) codes.add(400);
	if (!def.public) {
		codes.add(401);
		codes.add(403);
	}
	if (pathParams.length) codes.add(404);
	for (const code of [...codes].sort((a, b) => a - b)) {
		if (!out[code]) out[code] = { $ref: `#/components/responses/${ERROR_RESPONSE[code]}` };
	}

	const op: OperationObject = {
		operationId: def.operationId,
		tags: [def.tag],
		summary: def.summary,
		...(def.description ? { description: def.description } : {}),
		...(parameters.length ? { parameters } : {}),
		...(def.body
			? {
					requestBody: {
						required: !def.bodyOptional,
						content: { [def.bodyMediaType ?? "application/json"]: { schema: def.body } },
					},
				}
			: {}),
		responses: out,
		...(def.public ? { security: [] } : {}),
		"x-token-scope": tokenScopeFor(def),
		...(def.capability ? { "x-mailbox-capability": def.capability } : {}),
	};
	return op;
}

function buildPaths(defs: RouteDef[]): Record<string, PathItemObject> {
	const paths: Record<string, PathItemObject> = {};
	for (const def of defs) {
		const key = toOpenApiPath(def.path);
		const item = (paths[key] ??= {});
		item[def.method.toLowerCase() as HttpMethod] = buildOperation(def);
	}
	return paths;
}

const TAGS = [
	"Me/Config",
	"Branding",
	"Preferences",
	"Access",
	"Mailboxes",
	"Delegates",
	"Emails",
	"Drafts",
	"Threads",
	"Folders",
	"Labels",
	"Search",
	"Signatures",
	"Snooze",
	"Follow-ups",
	"Triage",
	"Screener",
	"Scheduled sends",
	"Rules",
	"Senders",
	"Export",
	"Approvals",
	"Audit",
	"People",
	"Products",
	"Analytics",
	"Templates",
	"Sequences",
	"Domains",
	"Licence",
	"Suppressions",
	"Sending health",
	"Usage",
	"Webhooks",
	"Agent inboxes",
	"Events",
	"AI",
	"Notifications",
	"Privacy",
	"Import",
	"Migration",
	"Meta",
];

export const openApiDocument: OpenApiDocument = {
	openapi: "3.1.0",
	info: {
		title: "cloudmail API",
		version: "1.0.0",
		description:
			"HTTP API for mailboxes, messages and instance administration. Authenticate with an API token " +
			"(`Authorization: Bearer ttk_<id>_<secret>`) or a browser session cookie. Each operation's " +
			"`x-token-scope` names the token scope it needs; `any` means every authenticated caller. " +
			"Mailbox routes additionally require a grant on that mailbox, and `x-mailbox-capability` names " +
			"the capability the grant must include.",
	},
	servers: [{ url: "/" }],
	security: [{ bearerAuth: [] }, { sessionCookie: [] }],
	tags: TAGS.map((name) => ({ name })),
	paths: buildPaths(routes),
	components: {
		schemas,
		responses,
		securitySchemes: {
			bearerAuth: {
				type: "http",
				scheme: "bearer",
				bearerFormat: "ttk_<id>_<secret>",
				description:
					"API token. A token may carry scopes: mail:read, mail:send, mail:draft, mail:organize, " +
					"mailboxes:manage, domains:manage, webhooks:manage, admin. Scopes only narrow; the effective " +
					"permission is the intersection of the user's grant and the token's scopes. A token without " +
					"scopes acts with the user's full access.",
			},
			sessionCookie: {
				type: "apiKey",
				in: "cookie",
				name: "__Host-tt_session",
				description:
					"Browser session cookie set at sign-in. Named `tt_session` on plain-http development servers. " +
					"Cross-site writes are refused by CSRF protection.",
			},
		},
	},
};

/** Every operation in the document, as uppercase method and Hono-style path. */
export function openApiOperations(): Array<{ method: string; path: string }> {
	const out: Array<{ method: string; path: string }> = [];
	for (const [path, item] of Object.entries(openApiDocument.paths)) {
		for (const method of Object.keys(item)) {
			out.push({ method: method.toUpperCase(), path: toHonoPath(path) });
		}
	}
	return out;
}
