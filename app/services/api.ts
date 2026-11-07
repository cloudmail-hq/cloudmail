// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { UsageBudget, UsageBudgetPatch, UsageResponse } from "../../shared/usage";
import type {
	BlockedSender,
	DeliveryEvent,
	Email,
	EmailLabel,
	EmailPriority,
	Folder,
	Label,
	Mailbox,
	ScheduledSend,
	SentAnalyticsResponse,
	Signature,
} from "~/types";
import type { GroupedPerson } from "../../shared/people";
import type { Rule } from "../../shared/rules";
import type { FollowupView } from "../../shared/followups";
import type { InboxTab, TriagePresetKey } from "../../shared/ai-triage";
import type { LabelPromptsView, ScreenerSender, ScreenResult } from "~/types";
import type { MailboxSettingsPatch } from "../../shared/mailbox-settings";
import type { Suppression, SuppressionReason } from "../../shared/suppressions";
import type { SendingDomainHealth } from "../../shared/sending-health";
import type { SendUsage } from "../../shared/send-caps";
import type { AskCitation } from "../../shared/semantic";

export interface AskInboxResponse {
	question: string;
	answer: string;
	insufficient: boolean;
	semantic: boolean;
	citations: AskCitation[];
	sources: { n: number; mailboxId: string; email_id: string; subject: string; from: string | null; date: string | null }[];
	mailboxes: string[];
}

/** One hit from `GET /api/v1/search`, tagged with the mailbox it is in. */
export interface CrossMailboxHit {
	mailboxId: string;
	id: string;
	thread_id: string | null;
	folder_id: string;
	subject: string | null;
	sender: string | null;
	sender_name: string | null;
	recipient: string | null;
	date: string | null;
	read: boolean;
	starred: boolean;
	snippet: string | null;
	matched: ("fts" | "vector")[];
	score: number;
}

export interface CrossMailboxSearchResponse {
	results: CrossMailboxHit[];
	semantic: boolean;
	fallback?: "unavailable" | "disabled" | "error";
	mailboxes: string[];
	truncated: string[];
	mode: "hybrid" | "fts";
}

export interface SemanticStatus {
	indexed: number;
	queued: number;
	pendingDeletes: number;
	today: { embeddings: number; queries: number };
}
import type {
	AnalyticsScope,
	Days,
	DmarcResponse,
	EngagementResponse,
	InboundResponse,
	OverviewResponse,
} from "../../shared/analytics-types";
import type {
	AiConfig,
	AiConfigPatch,
	AssistantPrefs,
	AssistantPrefsPatch,
} from "../../shared/ai-settings";
import type { DailyBrief } from "../../shared/daily-brief";
import { isPublicAuthPath, loginUrlFor } from "~/lib/auth-helpers";

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super((body.error as string) || `Request failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

/** Set once a sign-in redirect is under way, so parallel 401s navigate once. */
let redirectingToLogin = false;

/**
 * The global "your session ended" handler.
 *
 * Any `/api/v1/*` call answering 401 `unauthenticated` means the session cookie
 * expired or was revoked (another tab signed out, an admin disabled the
 * account). Send the browser to `/login`, carrying the current page as `next`
 * so signing back in lands where the reader was.
 *
 * Browser only, and never from a public page: the branding query in `root.tsx`
 * runs on `/login` too, and bouncing from there would loop.
 */
function handleUnauthenticated(url: string, status: number, body: Record<string, unknown>) {
	if (status !== 401 || body.code !== "unauthenticated") return;
	if (typeof window === "undefined" || redirectingToLogin) return;
	if (!url.startsWith("/api/v1/")) return;
	const { pathname, search } = window.location;
	if (isPublicAuthPath(pathname)) return;
	redirectingToLogin = true;
	window.location.assign(loginUrlFor(pathname, search));
}

export async function request<T>(
	url: string,
	options: RequestInit = {},
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
			handleUnauthenticated(url, res.status, body);
			throw new ApiError(res.status, body);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(url: string, opts?: { params?: Record<string, string>; responseType?: string; signal?: AbortSignal }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function patch<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PATCH",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string, opts?: { params?: Record<string, string> }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, { method: "DELETE" });
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

interface Zone {
	id: string;
	domain: string;
	name: string;
	zoneId?: string;
}

/**
 * Instance-wide branding. Mirrors `Branding` in `workers/lib/branding.ts`.
 *
 * Declared here rather than imported from the Worker so the browser bundle does
 * not pull in a module that references R2 ambient types.
 */
export interface Branding {
	appName: string;
	tagline: string | null;
	accentColor: string;
	logoMimeType: string | null;
	logoFilename: string | null;
	logoUpdatedAt: number | null;
	updatedAt: number;
}

export type BrandingInput = Partial<
	Pick<Branding, "appName" | "tagline" | "accentColor">
>;

/**
 * Instance-wide notification and display preferences. Mirrors `Preferences` in
 * `workers/lib/preferences.ts`.
 *
 * Declared here rather than imported from the Worker for the same reason as
 * `Branding` above: that module references R2 ambient types, and pulling it into
 * the browser bundle would drag zod along with it for types alone.
 */
export interface Preferences {
	notifications: {
		desktop: boolean;
		onlyImportant: boolean;
		playSound: boolean;
	};
	display: {
		density: Density;
		hideSignaturesInChat: boolean;
		previewText: boolean;
		readingPanePosition: ReadingPanePosition;
		/** Strip utm_* / fbclid / gclid and similar from links in received mail. */
		cleanTrackingLinks: boolean;
	};
	sending: {
		/**
		 * Hold each send briefly so it can be pulled back. Off delivers immediately,
		 * with no window and no Undo.
		 */
		undoWindowEnabled: boolean;
		/** Seconds to hold a send when the delay is on. */
		undoWindowSeconds: number;
	};
	updatedAt: number;
}

export type Density = "comfortable" | "cozy" | "compact";
export type ReadingPanePosition = "right" | "bottom" | "off";

/** A patch: any group may be absent, and any field within it may be too. */
export type PreferencesPatch = {
	notifications?: Partial<Preferences["notifications"]>;
	display?: Partial<Preferences["display"]>;
	sending?: Partial<Preferences["sending"]>;
};

// ---------- V2 shared resources (templates / sequences) ----------
// These live in R2 and are shared across mailboxes, so they are not scoped
// under /mailboxes/:id.

export interface EmailTemplate {
	id: string;
	slug: string;
	name: string;
	subject: string;
	bodyHtml: string;
	createdAt: number;
	updatedAt: number;
}

export interface SequenceStep {
	order: number;
	templateSlug: string;
	delayHours: number;
}

export interface Sequence {
	id: string;
	name: string;
	steps: SequenceStep[];
	createdAt: number;
	updatedAt: number;
}

export interface SequenceEnrollment {
	id: string;
	sequenceId: string;
	personId: string;
	personEmail: string;
	personName: string | null;
	fromAddress: string;
	status: "active" | "completed" | "cancelled";
	variables: Record<string, string>;
	enrolledAt: number;
	cancelledAt: number | null;
}

export interface SequenceEmail {
	id: string;
	enrollmentId: string;
	stepOrder: number;
	templateSlug: string;
	scheduledAt: number;
	status: "pending" | "sent" | "cancelled";
	sentAt: number | null;
	sentEmailId: string | null;
}

export interface EnrollmentWithDetails extends SequenceEnrollment {
	totalSteps: number;
	sentSteps: number;
}

/**
 * An attachment as the send, schedule and draft routes accept it.
 *
 * Mirrors `AttachmentPayloadSchema` on the Worker. `content` is base64 with no
 * data-URL prefix.
 */
export interface OutgoingAttachment {
	content: string;
	filename: string;
	type: string;
	disposition: "attachment" | "inline";
	contentId?: string;
}

/**
 * A bulk action request. Mirrors the discriminated union the Worker parses, so
 * "move without a folder" is a type error here rather than a 400 at runtime.
 */
export type BulkActionRequest =
	| {
			action:
				| "read"
				| "unread"
				| "star"
				| "unstar"
				/** Trash-first: bins anything not already in Trash or Spam. */
				| "delete"
				/** Skips the bin. Only offered from the Trash view. */
				| "delete_permanently"
				| "restore";
			ids: string[];
	  }
	| { action: "move"; ids: string[]; folder_id: string }
	| { action: "label" | "unlabel"; ids: string[]; label_id: string };

/**
 * Signed-in teammate: a built-in account in password mode, or the Cloudflare
 * Access token in access mode.
 */
export interface CurrentUser {
	/** How this deployment authenticates. Absent from older Workers. */
	authMode?: "password" | "access";
	/** Built-in account id (`usr_...`). Null in access mode. */
	userId?: string | null;
	/** The account created by first-run setup. */
	isOwner?: boolean;
	/** Whether this account has two-factor sign-in switched on. */
	totpEnabled?: boolean;
	/** How this request was authenticated. */
	authMethod?: "session" | "token" | "oauth" | "access" | "dev";
	email: string | null;
	name: string;
	role: string;
	authenticated: boolean;
	/**
	 * Mailboxes this user may open, or `null` for all of them.
	 *
	 * `null` and `[]` mean different things — every mailbox versus none — so this
	 * must not be defaulted to an empty array anywhere it is read.
	 */
	mailboxes: string[] | null;
	/**
	 * Whether per-mailbox authorization is switched on for this deployment.
	 *
	 * False means `ADMIN_EMAILS` is unset and every authenticated caller is being
	 * treated as an administrator — worth surfacing rather than implying a model
	 * that is not in force. See `workers/lib/authz.ts`.
	 */
	enforced: boolean;
	/**
	 * Whether the caller is a person or an Access service token. Null in local
	 * development, where there is no token to read.
	 */
	kind: "user" | "service" | null;
	/**
	 * What this user may do in each mailbox they can reach, or `null` when they
	 * may do everything everywhere (an administrator, or an unenforced
	 * deployment).
	 *
	 * Capabilities arrive already expanded from the role preset, so the UI never
	 * needs the preset table: it asks whether a list contains `sendAs`. Same
	 * `null` versus `[]` distinction as `mailboxes` — everything, versus nothing.
	 */
	capabilities:
		| { mailboxId: string; role: MailboxRole; capabilities: MailboxCapability[] }[]
		| null;
}

/** Whether a principal is a person or an Access service token. */
export type PrincipalKind = "user" | "service";

/** A role preset naming how far a grant reaches inside one mailbox. */
export type MailboxRole = "viewer" | "agent" | "manager" | "owner";

/**
 * One discrete thing a grant can permit.
 *
 * Left as a string rather than a union: the vocabulary is served by the Worker
 * (`GET /api/v1/access`), so pinning it here would let a client built against a
 * different list disagree with what is actually enforced.
 */
export type MailboxCapability = string;

/**
 * A mailbox in a grant.
 *
 * A bare string means unrestricted access, which is what every grant written
 * before roles existed contains. An object narrows it. Both shapes are accepted
 * on write and returned on read, so an older record needs no migration.
 */
export type AccessMailboxEntry =
	| string
	| {
			id: string;
			role: MailboxRole;
			/** Capabilities added on top of the preset. */
			extra?: MailboxCapability[];
			/** Capabilities withheld from it. Applied last, so it wins. */
			revoked?: MailboxCapability[];
	  };

/** A stored access grant. */
export interface AccessGrant {
	/** Email for a person; the service token's Client ID for a machine. */
	id: string;
	kind: PrincipalKind;
	role: "admin" | "member";
	/** Reachable mailbox addresses, flattened from {@link access}. */
	mailboxes: string[];
	/** The same mailboxes with the authority held over each. */
	access: {
		id: string;
		role: MailboxRole;
		extra?: MailboxCapability[];
		revoked?: MailboxCapability[];
	}[];
	/** Optional note, so an opaque Client ID can be recognised later. */
	label?: string;
	updatedAt: string;
}

export interface AccessResponse {
	users: AccessGrant[];
	services: AccessGrant[];
	/** From `ADMIN_EMAILS`; these cannot be edited or revoked from the UI. */
	configuredAdmins: string[];
	/**
	 * The role vocabulary this deployment enforces, with each preset expanded.
	 *
	 * Served rather than bundled so the screen offers exactly what the Worker
	 * understands; a client built against a different list would otherwise show a
	 * role that fails on save, or hide one that works.
	 */
	roles: { role: MailboxRole; capabilities: MailboxCapability[] }[];
	capabilities: MailboxCapability[];
	/** The role a bare mailbox entry means, for labelling existing grants. */
	fullAccessRole: MailboxRole;
	enforced: boolean;
}

export interface AccessGrantInput {
	id: string;
	kind: PrincipalKind;
	role: "admin" | "member";
	mailboxes: AccessMailboxEntry[];
	label?: string;
}

/**
 * One principal's access to a single mailbox.
 *
 * Deliberately narrower than {@link AccessGrant}: a grant lists every mailbox its
 * holder can reach, and an owner delegating their own mailbox has no business
 * seeing the others. So the per-mailbox routes return only this mailbox's entry.
 */
export interface MailboxDelegate {
	/** Email for a person; the service token's Client ID for a machine. */
	id: string;
	kind: PrincipalKind;
	role: MailboxRole;
	extra?: MailboxCapability[];
	revoked?: MailboxCapability[];
	label?: string;
	/**
	 * True when their reach here comes from being an instance administrator rather
	 * than from an entry the owner can edit.
	 */
	viaAdminRole?: boolean;
}

export interface MailboxDelegatesResponse {
	delegates: MailboxDelegate[];
	/** The role vocabulary this deployment enforces, each preset expanded. */
	roles: { role: MailboxRole; capabilities: MailboxCapability[] }[];
	fullAccessRole: MailboxRole;
	/**
	 * Administrators reach this mailbox without an entry, so a short list would
	 * otherwise imply nobody else can get in.
	 */
	configuredAdmins: string[];
	enforced: boolean;
}

export interface MailboxDelegateInput {
	id: string;
	kind?: PrincipalKind;
	role: MailboxRole;
	extra?: MailboxCapability[];
	revoked?: MailboxCapability[];
	label?: string;
}

/**
 * One line in the access log.
 *
 * `actorRole` is the field worth reading first: it says whether the actor was
 * working in their own mailbox, someone else's, or acting with instance-wide
 * authority. See `workers/lib/audit.ts`.
 */
export interface AuditEntry {
	id: string;
	/** Unix seconds. */
	at: number;
	action: string;
	/** Null for actions with no human behind them, like inbound delivery. */
	actor: string | null;
	actorRole: "owner" | "delegate" | "admin" | "system";
	/** Null for deployment-wide entries: grants, mailbox creation and deletion. */
	mailboxId: string | null;
	/** Who or what was acted upon, when that differs from the actor. */
	target?: string;
	detail?: Record<string, string | number | boolean | null>;
}

/** Narrow the access log. See `workers/lib/audit.ts` (`AUDIT_CATEGORIES`). */
export interface AuditFilter {
	category?: "mail" | "settings" | "access" | "security" | "agent";
	action?: string;
	actor?: string;
}

export type SendApprovalStatus = "pending" | "sending" | "sent" | "sent_unconfirmed" | "rejected" | "failed";

/** One message exactly as approve will send it (tracking is added at send). */
export interface HeldMessage {
	to: string[];
	cc: string[];
	bcc: string[];
	from: string | { email: string; name: string };
	subject: string;
	html: string | null;
	text: string | null;
	attachments: { filename: string; type: string }[];
	send_at: string | null;
	bulk: boolean;
}

/** An API-token, OAuth or agent send waiting for a person. See `workers/routes/approvals.ts`. */
export interface SendApproval {
	id: string;
	kind:
		| "send_email"
		| "send_reply"
		| "forward_email"
		| "send_template"
		| "schedule_send"
		| "rest_send"
		| "rest_reply"
		| "rest_forward"
		| "rest_schedule"
		| "rest_template"
		| "sequence_enroll";
	status: SendApprovalStatus;
	reason: string;
	recipients: string[];
	subject: string;
	messages: HeldMessage[];
	note: string | null;
	enrollment: {
		sequence_id: string;
		sequence_name: string;
		person: string;
		from: string;
		steps: { order: number; delayHours: number; subject: string; bodyHtml: string }[];
	} | null;
	tracking_added_at_send: boolean;
	editable: boolean;
	/** 1 when stored, +1 per edit. Approve sends it so a newer version is never sent unseen. */
	revision: number;
	revised_at: string | null;
	/** `requester`: the agent revised its own send. `reviewer`: a person edited it. */
	revised_by: "requester" | "reviewer" | null;
	requested_by: {
		user: string | null;
		via: "mcp" | "agent" | "api";
		method: string | null;
		tokenId?: string | null;
		tokenName?: string | null;
		oauthClientId?: string | null;
		oauthClientName?: string | null;
	};
	result: Record<string, unknown> | null;
	error: string | null;
	decided_by: string | null;
	created_at: string;
	decided_at: string | null;
	expires_at: string;
}

export interface SendApprovalEdits {
	to?: string[];
	cc?: string[];
	subject?: string;
	html?: string;
}

export interface PeopleResponse {
	people: GroupedPerson[];
	total: number;
	page: number;
	pageSize: number;
	/** Mailboxes that failed to respond; their messages are missing. */
	degraded: string[];
}

/** A message in a person's timeline, tagged with the mailbox it lives in. */
export interface PersonEmail {
	id: string;
	mailboxId: string;
	subject: string | null;
	sender: string;
	recipient: string | null;
	cc: string | null;
	date: string | null;
	read: boolean;
	starred: boolean;
	thread_id: string | null;
	folder_id: string | null;
	in_reply_to: string | null;
	message_id: string | null;
	snippet: string | null;
	attachmentCount: number;
}

export interface PersonEmailsResponse {
	emails: PersonEmail[];
	total: number;
}

export interface PeopleQuery {
	folder?: string;
	page?: number;
	pageSize?: number;
	search?: string;
	unread?: boolean;
	hasAttachment?: boolean;
	recipient?: string;
	sortKey?: string;
	sortDirection?: string;
}

// ---------- Domains (admin) ----------
// Mirrors the domains REST contract served by the Worker.

export type DomainStatus = "pending" | "active" | "error";

export interface Domain {
	id: string;
	hostname: string;
	displayName: string;
	zoneId: string | null;
	status: DomainStatus;
	/** ready | unconfigured | misconfigured | unlocked | manual | null */
	routingStatus: string | null;
	/** enabled | disabled | missing | manual | null */
	sendingStatus: string | null;
	sendingSubdomainId: string | null;
	dkim: { selector: string; name: string; value: string | null } | null;
	catchAllMailbox: string | null;
	/** `env` domains are seeded from configuration and cannot be deleted here. */
	source: "env" | "api";
	lastError: string | null;
	createdAt: number;
	updatedAt: number;
	lastCheckedAt: number | null;
	mailboxCount: number;
}

export interface DnsRecordSpec {
	purpose: "routing" | "sending" | "dmarc";
	type: "MX" | "TXT" | "CNAME";
	name: string;
	value: string;
	priority?: number;
	note?: string;
}

export type CheckStatus = "pass" | "warn" | "fail";

export interface AuditCheck {
	id: string;
	label: string;
	type: string;
	name: string;
	status: CheckStatus;
	expected: string;
	found: string[];
	message: string;
}

export interface DomainAudit {
	checkedAt: number;
	summary: CheckStatus;
	checks: AuditCheck[];
}

export interface ProvisionStep {
	step: "zone" | "routing" | "catch_all" | "sending" | "sending_dns";
	status: "ok" | "skipped" | "warn" | "error";
	detail: string;
}

export interface DomainProvision {
	ok: boolean;
	ranAt: number;
	steps: ProvisionStep[];
}

export interface CloudflareStatus {
	configured: boolean;
	workerScriptName: string;
}

export interface DomainListResponse {
	domains: Domain[];
	cloudflare: CloudflareStatus;
}

export interface DomainDetailResponse {
	domain: Domain;
	records: DnsRecordSpec[];
	manualSteps: string[];
	audit: DomainAudit | null;
	provision: DomainProvision | null;
	cloudflare: CloudflareStatus;
}

export interface DomainInput {
	hostname: string;
	displayName?: string;
	zoneId?: string;
	catchAllMailbox?: string;
}

export interface DomainPatch {
	displayName?: string;
	catchAllMailbox?: string | null;
}

/**
 * Serialise a query object into URL params.
 *
 * Absent, empty and `false` values are dropped rather than sent: the Worker
 * reads these as opt-in flags, and `?unread=false` would otherwise arrive as a
 * truthy string.
 */
function toParams(query: object): Record<string, string> {
	const params: Record<string, string> = {};
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === "" || value === false) {
			continue;
		}
		params[key] = String(value);
	}
	return params;
}

// ---------- API client ----------

const api = {
	// Config
	getConfig: () =>
		get<{ domains: string[]; emailAddresses: string[]; zones: Zone[] }>("/api/v1/config"),

	// Branding (instance-wide app name / logo)
	getBranding: (opts?: { signal?: AbortSignal }) =>
		get<Branding>("/api/v1/branding", { signal: opts?.signal }),
	updateBranding: (patch: BrandingInput) =>
		put<Branding>("/api/v1/branding", patch),
	resetBranding: () => del<Branding>("/api/v1/branding"),
	uploadBrandingLogo: (logo: {
		content: string;
		filename: string;
		type: string;
	}) => put<Branding>("/api/v1/branding/logo", logo),
	deleteBrandingLogo: () => del<Branding>("/api/v1/branding/logo"),

	// Preferences (instance-wide notification / display choices)
	getPreferences: (opts?: { signal?: AbortSignal }) =>
		get<Preferences>("/api/v1/preferences", { signal: opts?.signal }),
	updatePreferences: (patch: PreferencesPatch) =>
		put<Preferences>("/api/v1/preferences", patch),

	// Current user (Cloudflare Access)
	getCurrentUser: (opts?: { signal?: AbortSignal }) =>
		get<CurrentUser>("/api/v1/me", { signal: opts?.signal }),

	// Access grants: who may open which mailbox. Administrator-only.
	listAccess: (opts?: { signal?: AbortSignal }) =>
		get<AccessResponse>("/api/v1/access", { signal: opts?.signal }),
	saveAccessGrant: (grant: AccessGrantInput) =>
		put<AccessGrant>("/api/v1/access", grant),
	deleteAccessGrant: (kind: PrincipalKind, id: string) =>
		del<void>(`/api/v1/access/${kind}/${encodeURIComponent(id)}`),

	/**
	 * Delegation of one mailbox, by whoever owns it.
	 *
	 * Separate from the routes above because those are instance-wide and
	 * admin-only: a grant record lists every mailbox a person can reach, so
	 * writing one wholesale is authority over the deployment. These touch exactly
	 * one entry of one grant, so an owner can hand out their own mailbox without
	 * being an administrator.
	 */
	listMailboxDelegates: (mailboxId: string, opts?: { signal?: AbortSignal }) =>
		get<MailboxDelegatesResponse>(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/delegates`,
			{ signal: opts?.signal },
		),
	saveMailboxDelegate: (mailboxId: string, delegate: MailboxDelegateInput) =>
		put<MailboxDelegate>(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/delegates`,
			delegate,
		),
	deleteMailboxDelegate: (mailboxId: string, kind: PrincipalKind, id: string) =>
		del<void>(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/delegates/${kind}/${encodeURIComponent(id)}`,
		),

	/**
	 * The access log.
	 *
	 * Two scopes, because they answer different questions and are gated
	 * differently: the deployment-wide log covers grants and mailbox lifecycle and
	 * is administrator-only, while a mailbox's own log is available to whoever
	 * manages its settings.
	 */
	listAccessAudit: (limit?: number, opts?: { signal?: AbortSignal; filter?: AuditFilter }) =>
		get<AuditEntry[]>("/api/v1/access/audit", {
			params: toParams({ limit, ...opts?.filter }),
			signal: opts?.signal,
		}),
	listMailboxAudit: (mailboxId: string, limit?: number, opts?: { signal?: AbortSignal; filter?: AuditFilter }) =>
		get<AuditEntry[]>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/audit`, {
			params: toParams({ limit, ...opts?.filter }),
			signal: opts?.signal,
		}),

	// Agent and MCP sends waiting for approval
	listApprovals: (mailboxId: string, status: SendApprovalStatus | "all" = "pending", opts?: { signal?: AbortSignal }) =>
		get<{ approvals: SendApproval[] }>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/approvals`, {
			params: { status },
			signal: opts?.signal,
		}),
	countApprovals: (mailboxId: string, opts?: { signal?: AbortSignal }) =>
		get<{ pending: number }>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/approvals/count`, {
			signal: opts?.signal,
		}),
	editApproval: (mailboxId: string, id: string, edits: SendApprovalEdits) =>
		patch<{ approval: SendApproval }>(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/approvals/${encodeURIComponent(id)}`,
			edits,
		),
	approveApproval: (mailboxId: string, id: string, revision?: number) =>
		post<{ approval: SendApproval; result?: Record<string, unknown> }>(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/approvals/${encodeURIComponent(id)}/approve`,
			revision ? { revision } : {},
		),
	rejectApproval: (mailboxId: string, id: string, note?: string) =>
		post<{ approval: SendApproval }>(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/approvals/${encodeURIComponent(id)}/reject`,
			note ? { note } : {},
		),
	retryApproval: (mailboxId: string, id: string) =>
		post<{ approval: SendApproval }>(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/approvals/${encodeURIComponent(id)}/retry`,
		),

	// People (cross-mailbox, person-centric inbox)
	listPeople: (query: PeopleQuery = {}, opts?: { signal?: AbortSignal }) =>
		get<PeopleResponse>("/api/v1/people", {
			params: toParams(query),
			signal: opts?.signal,
		}),
	listPersonEmails: (
		personEmail: string,
		query: { limit?: number } = {},
		opts?: { signal?: AbortSignal },
	) =>
		get<PersonEmailsResponse>(
			`/api/v1/people/${encodeURIComponent(personEmail)}/emails`,
			{ params: toParams(query), signal: opts?.signal },
		),

	// Mailboxes
	listMailboxes: (domain?: string) => {
		const params = domain ? { domain } : undefined;
		return get<Mailbox[]>("/api/v1/mailboxes", { params });
	},
	/**
	 * Mailboxes with their settings attached.
	 *
	 * Costs the Worker one R2 read per mailbox, so it is opt-in — but it saves
	 * the browser N round trips on screens that need every mailbox's settings.
	 */
	listMailboxesWithSettings: (opts?: { signal?: AbortSignal }) =>
		get<Mailbox[]>("/api/v1/mailboxes", {
			params: { include: "settings" },
			signal: opts?.signal,
		}),
	createMailbox: (
		email: string,
		name: string,
		settings?: MailboxSettingsPatch,
	) => post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	/**
	 * Patch a mailbox's settings.
	 *
	 * A partial patch, not the whole blob: the route merges it into the stored
	 * object and rejects a key the schema does not know, so `unknown` here would
	 * turn a typo into a 400 at runtime instead of an error at the call site.
	 */
	updateMailbox: (mailboxId: string, settings: MailboxSettingsPatch) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}`),

	// Mailbox aliases: extra addresses delivered to (and sendable from) a mailbox.
	getMailboxAliases: (mailboxId: string, opts?: { signal?: AbortSignal }) =>
		get<{ aliases: string[] }>(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/aliases`,
			{ signal: opts?.signal },
		),
	setMailboxAliases: (mailboxId: string, aliases: string[]) =>
		put<{ aliases: string[] }>(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/aliases`,
			{ aliases },
		),

	// Domains. Administrator-only.
	listDomains: (opts?: { signal?: AbortSignal }) =>
		get<DomainListResponse>("/api/v1/domains", { signal: opts?.signal }),
	getDomain: (id: string, opts?: { signal?: AbortSignal }) =>
		get<DomainDetailResponse>(`/api/v1/domains/${encodeURIComponent(id)}`, {
			signal: opts?.signal,
		}),
	createDomain: (input: DomainInput) =>
		post<{ domain: Domain }>("/api/v1/domains", input),
	updateDomain: (id: string, input: DomainPatch) =>
		patch<{ domain: Domain }>(`/api/v1/domains/${encodeURIComponent(id)}`, input),
	deleteDomain: (id: string) =>
		del<{ ok: true }>(`/api/v1/domains/${encodeURIComponent(id)}`),
	verifyDomain: (id: string) =>
		post<{ domain: Domain; audit: DomainAudit }>(
			`/api/v1/domains/${encodeURIComponent(id)}/verify`,
		),
	provisionDomain: (
		id: string,
		opts?: { overwriteCatchAll?: boolean; confirmEnvDomain?: boolean },
	) =>
		post<{ domain: Domain; provision: DomainProvision }>(
			`/api/v1/domains/${encodeURIComponent(id)}/provision`,
			opts ?? {},
		),

	// Emails
	listEmails: (mailboxId: string, params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/emails`, { params, signal: opts?.signal }),
	/**
	 * Deliver a message immediately.
	 *
	 * Returns the stored row's id — the route answers `202 {id, status}`. It was
	 * typed `void`, which was simply wrong about the response and meant a caller
	 * that needs the id (the no-delay send path in `useSendWithUndo`) could not see
	 * it without a cast.
	 */
	sendEmail: (mailboxId: string, email: unknown) =>
		post<{ id: string; status: string }>(
			`/api/v1/mailboxes/${mailboxId}/emails`,
			email,
		),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, { signal: opts?.signal }),
	getDeliveryEvents: (
		mailboxId: string,
		id: string,
		opts?: { signal?: AbortSignal },
	) =>
		get<{ events: DeliveryEvent[] }>(
			`/api/v1/mailboxes/${mailboxId}/emails/${id}/delivery-events`,
			{ signal: opts?.signal },
		),
	// Analytics console. Cloudflare data is cached server-side for 5 minutes;
	// `refresh` asks the Worker to bypass that cache.
	getAnalyticsOverview: (
		params: { days: Days; scope: AnalyticsScope; domain?: string; product?: string; refresh?: boolean },
		opts?: { signal?: AbortSignal },
	) =>
		get<OverviewResponse>("/api/v1/analytics/overview", {
			params: {
				days: String(params.days),
				scope: params.scope,
				...(params.domain ? { domain: params.domain } : {}),
				...(params.product ? { product: params.product } : {}),
				...(params.refresh ? { refresh: "1" } : {}),
			},
			signal: opts?.signal,
		}),
	getAnalyticsEngagement: (
		params: { days: Days; mailbox?: string; refresh?: boolean },
		opts?: { signal?: AbortSignal },
	) =>
		get<EngagementResponse>("/api/v1/analytics/engagement", {
			params: {
				days: String(params.days),
				...(params.mailbox ? { mailbox: params.mailbox } : {}),
				...(params.refresh ? { refresh: "1" } : {}),
			},
			signal: opts?.signal,
		}),
	getAnalyticsInbound: (params: { days: Days; refresh?: boolean }, opts?: { signal?: AbortSignal }) =>
		get<InboundResponse>("/api/v1/analytics/inbound", {
			params: { days: String(params.days), ...(params.refresh ? { refresh: "1" } : {}) },
			signal: opts?.signal,
		}),
	getAnalyticsDmarc: (params: { days: Days; refresh?: boolean }, opts?: { signal?: AbortSignal }) =>
		get<DmarcResponse>("/api/v1/analytics/dmarc", {
			params: { days: String(params.days), ...(params.refresh ? { refresh: "1" } : {}) },
			signal: opts?.signal,
		}),
	getSentAnalytics: (days: number, opts?: { signal?: AbortSignal }) =>
		get<SentAnalyticsResponse>(`/api/v1/analytics/sent`, {
			params: { days: String(days) },
			signal: opts?.signal,
		}),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	/**
	 * Delete a message: to Trash, or destroyed if it is already binned.
	 *
	 * `permanent` skips the bin. Only for rows that are being replaced rather
	 * than discarded — a draft superseded by the copy just queued for sending —
	 * because everything else should be recoverable.
	 */
	deleteEmail: (mailboxId: string, id: string, opts?: { permanent?: boolean }) =>
		del<{ status?: "trashed" } | void>(
			`/api/v1/mailboxes/${mailboxId}/emails/${id}`,
			opts?.permanent ? { params: { permanent: "1" } } : undefined,
		),
	restoreEmail: (mailboxId: string, id: string) =>
		post<{ status: "restored" }>(
			`/api/v1/mailboxes/${mailboxId}/emails/${id}/restore`,
		),
	emptyTrash: (mailboxId: string) =>
		post<{ deleted: number }>(`/api/v1/mailboxes/${mailboxId}/trash/empty`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, { folderId }),
	/**
	 * The messages of a conversation, as the current view should show them.
	 *
	 * `folder` narrows a Trash or Spam view to the messages actually in that
	 * folder. Without it the pane rendered the whole conversation, so a thread with
	 * one deleted message looked entirely deleted.
	 */
	getThread: (
		mailboxId: string,
		threadId: string,
		opts?: { signal?: AbortSignal; folder?: string },
	) =>
		get<Email[]>(
			`/api/v1/mailboxes/${mailboxId}/threads/${threadId}${
				opts?.folder ? `?folder=${encodeURIComponent(opts.folder)}` : ""
			}`,
			{ signal: opts?.signal },
		),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	// Attachment bytes are fetched with a plain `fetch` against
	// `getAttachmentUrl` (see app/lib/attachment-transfer.ts) rather than through
	// this client, whose response handling is JSON-first.
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
			draft_id?: string;
			/** Complete new attachment set; only read when `replace_attachments` is set. */
			attachments?: OutgoingAttachment[];
			/**
			 * Set only when the staged files have changed. Autosave runs on a timer,
			 * and re-encoding unchanged attachments on every save would upload the
			 * same bytes repeatedly.
			 */
			replace_attachments?: boolean;
		},
	) =>
		// Updates the draft in place when `draft_id` is supplied, so the id stays
		// stable across autosaves and the draft's attachments stay attached.
		post<{ id: string; status: string; subject: string; recipient: string; date: string }>(
			`/api/v1/mailboxes/${mailboxId}/drafts`,
			draft,
		),
	// No reply/forward calls: every send from the UI goes through
	// `scheduleEmail` so it gets an undo window, passing `reply_to_email_id` for
	// threading. The dedicated routes remain for API and MCP callers.

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	/**
	 * Delete a custom folder.
	 *
	 * Reports how many messages were relocated, because deleting a folder that
	 * held mail moves its contents to the inbox rather than destroying them.
	 */
	deleteFolder: (mailboxId: string, id: string) =>
		del<{ status: "deleted"; relocated: number; movedTo: string }>(
			`/api/v1/mailboxes/${mailboxId}/folders/${id}`,
		),

	// Search
	searchEmails: (mailboxId: string, params: Record<string, string>) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/search`, { params }),
	/** Every readable mailbox at once (`GET /api/v1/search`, hybrid by default). */
	searchAllMailboxes: (params: { q: string; mode?: "hybrid" | "fts"; limit?: string }, opts?: { signal?: AbortSignal }) =>
		get<CrossMailboxSearchResponse>("/api/v1/search", {
			params: { mailbox: "*", ...params } as Record<string, string>,
			signal: opts?.signal,
		}),

	// Labels
	listLabels: (mailboxId: string, opts?: { signal?: AbortSignal }) =>
		get<Label[]>(`/api/v1/mailboxes/${mailboxId}/labels`, { signal: opts?.signal }),
	createLabel: (
		mailboxId: string,
		data: { name: string; color?: string; parent_id?: string | null; sort_order?: number },
	) => post<Label>(`/api/v1/mailboxes/${mailboxId}/labels`, data),
	updateLabel: (
		mailboxId: string,
		labelId: string,
		patch: { name?: string; color?: string; parent_id?: string | null; sort_order?: number },
	) => put<Label>(`/api/v1/mailboxes/${mailboxId}/labels/${labelId}`, patch),
	deleteLabel: (mailboxId: string, labelId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/labels/${labelId}`),
	listLabelEmails: (
		mailboxId: string,
		labelId: string,
		params?: Record<string, string>,
		opts?: { signal?: AbortSignal },
	) =>
		get<EmailListResponse>(`/api/v1/mailboxes/${mailboxId}/labels/${labelId}/emails`, {
			params,
			signal: opts?.signal,
		}),
	listEmailLabels: (mailboxId: string, emailId: string, opts?: { signal?: AbortSignal }) =>
		get<EmailLabel[]>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/labels`, {
			signal: opts?.signal,
		}),
	/** Replaces the email's entire label set, so a checkbox list can be submitted as-is. */
	setEmailLabels: (mailboxId: string, emailId: string, labelIds: string[]) =>
		put<EmailLabel[]>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/labels`, {
			label_ids: labelIds,
		}),
	// Single-label add/remove is deliberately absent: the label picker submits a
	// checkbox list, so `setEmailLabels` matches the UI and cannot leave a
	// partially-applied set behind if one call in a batch fails. The per-label
	// routes remain for API callers.

	// Signatures
	listSignatures: (mailboxId: string, opts?: { signal?: AbortSignal }) =>
		get<Signature[]>(`/api/v1/mailboxes/${mailboxId}/signatures`, { signal: opts?.signal }),
	// No `getDefaultSignature`: the default is derived client-side from the list
	// this already fetches (see `useDefaultSignature`), so a second round trip
	// would only add a way for the two to disagree. The route still exists for
	// API callers.
	createSignature: (
		mailboxId: string,
		data: { name: string; body_html: string; is_default?: boolean },
	) => post<Signature>(`/api/v1/mailboxes/${mailboxId}/signatures`, data),
	updateSignature: (
		mailboxId: string,
		signatureId: string,
		patch: { name?: string; body_html?: string; is_default?: boolean },
	) => put<Signature>(`/api/v1/mailboxes/${mailboxId}/signatures/${signatureId}`, patch),
	deleteSignature: (mailboxId: string, signatureId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/signatures/${signatureId}`),

	// Snooze. The Snoozed folder is listed through `listEmails` like any other, so
	// there is no separate list call here.
	/** Pass either an absolute `until` (ISO) or a relative `delay_seconds`. */
	snoozeEmail: (
		mailboxId: string,
		emailId: string,
		when: { until: string } | { delay_seconds: number },
	) => post<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/snooze`, when),
	unsnoozeEmail: (mailboxId: string, emailId: string) =>
		del<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/snooze`),

	// Follow-up reminders. Setting one at send time is a `followup` field on the
	// send body; these manage one afterwards.
	listFollowups: (mailboxId: string, opts?: { signal?: AbortSignal }) =>
		get<{ followups: FollowupView[] }>(`/api/v1/mailboxes/${mailboxId}/followups`, {
			signal: opts?.signal,
		}),
	getFollowup: (mailboxId: string, emailId: string, opts?: { signal?: AbortSignal }) =>
		get<FollowupView>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/followup`, {
			signal: opts?.signal,
		}),
	setFollowup: (
		mailboxId: string,
		emailId: string,
		when: { at: string } | { delay_seconds: number },
	) => post<FollowupView>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/followup`, when),
	cancelFollowup: (mailboxId: string, emailId: string) =>
		post<FollowupView>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/followup/cancel`),

	// AI triage: label prompts, presets, inbox tabs and backfill
	listLabelPrompts: (mailboxId: string, opts?: { signal?: AbortSignal }) =>
		get<LabelPromptsView>(`/api/v1/mailboxes/${mailboxId}/label-prompts`, { signal: opts?.signal }),
	setLabelPrompt: (
		mailboxId: string,
		labelId: string,
		patch: { prompt?: string | null; auto_archive?: boolean; show_tab?: boolean },
	) => put<unknown>(`/api/v1/mailboxes/${mailboxId}/labels/${labelId}/prompt`, patch),
	setTriagePreset: (
		mailboxId: string,
		key: TriagePresetKey,
		body: { enabled: boolean; auto_archive?: boolean; show_tab?: boolean },
	) => put<unknown>(`/api/v1/mailboxes/${mailboxId}/triage/presets/${key}`, body),
	backfillTriage: (mailboxId: string, limit?: number) =>
		post<{ processed: number; classified: number; remaining: number; capped: boolean }>(
			`/api/v1/mailboxes/${mailboxId}/triage/backfill`,
			limit ? { limit } : {},
		),
	listInboxTabs: (mailboxId: string, opts?: { signal?: AbortSignal }) =>
		get<{ tabs: InboxTab[] }>(`/api/v1/mailboxes/${mailboxId}/inbox-tabs`, { signal: opts?.signal }),

	// Screener
	listScreener: (mailboxId: string, opts?: { signal?: AbortSignal }) =>
		get<{ senders: ScreenerSender[] }>(`/api/v1/mailboxes/${mailboxId}/screener`, { signal: opts?.signal }),
	screenSender: (
		mailboxId: string,
		sender: string,
		decision: "allow" | "block",
		target?: "spam" | "trash",
	) =>
		post<ScreenResult>(`/api/v1/mailboxes/${mailboxId}/screener/${encodeURIComponent(sender)}`, {
			decision,
			...(target ? { target } : {}),
		}),

	// Priority
	setEmailPriority: (mailboxId: string, emailId: string, priority: EmailPriority) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/priority`, { priority }),

	// Scheduled send / undo send
	listScheduledSends: (mailboxId: string, opts?: { signal?: AbortSignal }) =>
		get<ScheduledSend[]>(`/api/v1/mailboxes/${mailboxId}/scheduled-sends`, {
			signal: opts?.signal,
		}),
	/**
	 * Queue a message for later delivery. Same body as sendEmail plus either
	 * `send_at` (ISO) or `delay_seconds` — a short delay is how Undo Send works.
	 */
	scheduleEmail: (
		mailboxId: string,
		email: Record<string, unknown> & ({ send_at: string } | { delay_seconds: number }),
	) =>
		post<{
			id: string;
			status: string;
			send_at: string;
			/** Whether the draft named by `supersedes_draft_id` was found and removed. */
			superseded_draft?: boolean;
		}>(
			`/api/v1/mailboxes/${mailboxId}/scheduled-sends`,
			email,
		),
	cancelScheduledSend: (mailboxId: string, emailId: string) =>
		del<{ status: string }>(`/api/v1/mailboxes/${mailboxId}/scheduled-sends/${emailId}`),
	/**
	 * Deliver a queued message now rather than waiting out its delay. Rejects
	 * with 409 once the alarm has already taken it.
	 */
	sendScheduledNow: (mailboxId: string, emailId: string) =>
		post<{ status: string }>(
			`/api/v1/mailboxes/${mailboxId}/scheduled-sends/${emailId}/send-now`,
			{},
		),

	// Bulk actions
	/**
	 * Apply one action to many messages.
	 *
	 * `affected` is the number of rows that actually changed, which can be lower
	 * than `ids.length` when a message was removed elsewhere or already held the
	 * target value.
	 *
	 * A delete also reports `trashed` and `deleted` separately, because one
	 * selection can span the inbox and the bin: the first are recoverable, the
	 * second are not, and the toast has to say which.
	 */
	bulkAction: (mailboxId: string, body: BulkActionRequest) =>
		post<{ affected: number; trashed?: number; deleted?: number }>(
			`/api/v1/mailboxes/${mailboxId}/emails/bulk`,
			body,
		),
	/** Omit the scope to clear unread across the whole mailbox. */
	markAllRead: (mailboxId: string, scope?: { folder?: string; label_id?: string }) =>
		post<{ affected: number }>(`/api/v1/mailboxes/${mailboxId}/mark-all-read`, scope ?? {}),

	// Blocked senders
	listBlockedSenders: (mailboxId: string, opts?: { signal?: AbortSignal }) =>
		get<BlockedSender[]>(`/api/v1/mailboxes/${mailboxId}/blocked-senders`, {
			signal: opts?.signal,
		}),
	blockSender: (mailboxId: string, pattern: string, reason?: string | null) =>
		post<BlockedSender>(`/api/v1/mailboxes/${mailboxId}/blocked-senders`, { pattern, reason }),
	unblockSender: (mailboxId: string, blockId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/blocked-senders/${blockId}`),

	// Allowed senders — exempt from heuristic spam scoring.
	listAllowedSenders: (mailboxId: string, opts?: { signal?: AbortSignal }) =>
		get<BlockedSender[]>(`/api/v1/mailboxes/${mailboxId}/allowed-senders`, {
			signal: opts?.signal,
		}),
	allowSender: (mailboxId: string, pattern: string, reason?: string | null) =>
		post<BlockedSender>(`/api/v1/mailboxes/${mailboxId}/allowed-senders`, { pattern, reason }),
	disallowSender: (mailboxId: string, allowId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/allowed-senders/${allowId}`),

	/**
	 * Move a message out of Spam and stop it being filed there again: clears any
	 * block rule matching the sender and allowlists them, in one server-side step
	 * so the three cannot end up disagreeing.
	 */
	markNotSpam: (mailboxId: string, emailId: string) =>
		post<{ folder: string; unblocked: string[]; allowed: string | null }>(
			`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/not-spam`,
			{},
		),

	/**
	 * Cheap change probe: a version counter plus the inbox unread counts.
	 *
	 * Polled every few seconds by `useMailboxLiveUpdates`, so it must stay two
	 * single-row reads on the server side. The high-priority figure is what lets
	 * the "only important mail" notification preference be honoured without
	 * fetching the list itself.
	 */
	getMailboxState: (mailboxId: string) =>
		get<{
			version: number;
			inboxUnread: number;
			inboxUnreadHighPriority: number;
		}>(`/api/v1/mailboxes/${mailboxId}/state`),

	// Filter rules. Applied as mail arrives, so ordering is meaningful and the
	// reorder endpoint takes the whole sequence rather than a move instruction.
	listRules: (mailboxId: string) =>
		get<Rule[]>(`/api/v1/mailboxes/${mailboxId}/rules`),
	createRule: (mailboxId: string, rule: unknown) =>
		post<Rule>(`/api/v1/mailboxes/${mailboxId}/rules`, rule),
	updateRule: (mailboxId: string, ruleId: string, patch: unknown) =>
		put<Rule>(`/api/v1/mailboxes/${mailboxId}/rules/${ruleId}`, patch),
	deleteRule: (mailboxId: string, ruleId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/rules/${ruleId}`),
	reorderRules: (mailboxId: string, ids: string[]) =>
		post<{ updated: number }>(`/api/v1/mailboxes/${mailboxId}/rules/reorder`, {
			ids,
		}),

	// Muted conversations
	listMutedThreads: (mailboxId: string) =>
		get<string[]>(`/api/v1/mailboxes/${mailboxId}/muted-threads`),
	muteThread: (mailboxId: string, threadId: string) =>
		post<{ muted: boolean }>(
			`/api/v1/mailboxes/${mailboxId}/threads/${encodeURIComponent(threadId)}/mute`,
			{},
		),
	unmuteThread: (mailboxId: string, threadId: string) =>
		del<{ muted: boolean }>(
			`/api/v1/mailboxes/${mailboxId}/threads/${encodeURIComponent(threadId)}/mute`,
		),

	// Templates (shared, R2-backed)
	listTemplates: (opts?: { signal?: AbortSignal }) =>
		get<EmailTemplate[]>("/api/v1/templates", { signal: opts?.signal }),
	getTemplate: (slug: string) =>
		get<EmailTemplate>(`/api/v1/templates/${encodeURIComponent(slug)}`),
	createTemplate: (data: { slug: string; name: string; subject: string; bodyHtml: string }) =>
		post<EmailTemplate>("/api/v1/templates", data),
	updateTemplate: (slug: string, data: { name?: string; subject?: string; bodyHtml?: string }) =>
		put<EmailTemplate>(`/api/v1/templates/${encodeURIComponent(slug)}`, data),
	deleteTemplate: (slug: string) =>
		del<{ success: boolean }>(`/api/v1/templates/${encodeURIComponent(slug)}`),

	// Sequences (shared, R2-backed)
	listSequences: (opts?: { signal?: AbortSignal }) =>
		get<Sequence[]>("/api/v1/sequences", { signal: opts?.signal }),
	getSequence: (id: string) => get<Sequence>(`/api/v1/sequences/${encodeURIComponent(id)}`),
	createSequence: (data: { name: string; steps: SequenceStep[] }) =>
		post<Sequence>("/api/v1/sequences", data),
	updateSequence: (id: string, data: { name?: string; steps?: SequenceStep[] }) =>
		put<Sequence>(`/api/v1/sequences/${encodeURIComponent(id)}`, data),
	deleteSequence: (id: string) =>
		del<{ success: boolean }>(`/api/v1/sequences/${encodeURIComponent(id)}`),
	listSequenceEnrollments: (id: string) =>
		get<EnrollmentWithDetails[]>(`/api/v1/sequences/${encodeURIComponent(id)}/enrollments`),
	enrollInSequence: (
		id: string,
		data: {
			personId: string;
			personEmail: string;
			personName?: string | null;
			fromAddress: string;
			variables?: Record<string, string>;
			skipSteps?: number[];
			delayOverrides?: Record<string, number>;
		},
	) =>
		post<{ enrollment: SequenceEnrollment; scheduledEmails: SequenceEmail[] }>(
			`/api/v1/sequences/${encodeURIComponent(id)}/enroll`,
			data,
		),
	cancelEnrollment: (enrollmentId: string) =>
		del<{ success: boolean }>(
			`/api/v1/sequences/enrollments/${encodeURIComponent(enrollmentId)}`,
		),

	// Suppression list (deployment-wide, AuthDO-backed)
	listSuppressions: (
		params: { q?: string; scope?: string; reason?: string; limit?: number; offset?: number } = {},
		opts?: { signal?: AbortSignal },
	) => {
		const query: Record<string, string> = {};
		for (const [k, v] of Object.entries(params)) {
			if (v !== undefined && v !== "") query[k] = String(v);
		}
		return get<SuppressionPage>("/api/v1/suppressions", { params: query, signal: opts?.signal });
	},
	addSuppression: (entry: { address: string; scope?: string; reason?: SuppressionReason }) =>
		post<{ added: number; existing: number; items: Suppression[] }>("/api/v1/suppressions", entry),
	deleteSuppression: (id: string) =>
		del<{ success: boolean }>(`/api/v1/suppressions/${encodeURIComponent(id)}`),
	importSuppressions: (data: { csv: string; reason?: SuppressionReason; scope?: string }) =>
		post<{
			added: number;
			existing: number;
			rows: number;
			errors: { line: number; error: string }[];
			errorCount: number;
		}>("/api/v1/suppressions/import", data),
	checkSuppressions: (addresses: string[], from?: string, opts?: { signal?: AbortSignal }) =>
		post<{ items: Suppression[] }>("/api/v1/suppressions/check", { addresses, from }, opts),

	// AI summaries and the daily brief
	getThreadSummary: (mailboxId: string, threadId: string, opts?: { signal?: AbortSignal }) =>
		get<{ summary: ThreadSummary | null }>(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/threads/${encodeURIComponent(threadId)}/summary`,
			{ signal: opts?.signal },
		),
	refreshThreadSummary: (mailboxId: string, threadId: string) =>
		post<{ queued: boolean }>(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/threads/${encodeURIComponent(threadId)}/summary/refresh`,
		),
	generateThreadSummary: (mailboxId: string, threadId: string) =>
		post<{ summary: ThreadSummary | null }>(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/threads/${encodeURIComponent(threadId)}/summary/generate`,
		),
	askInbox: (body: { question: string; mailbox?: string; product?: string[] }, opts?: { signal?: AbortSignal }) =>
		post<AskInboxResponse>("/api/v1/ask", body, { signal: opts?.signal }),
	getSemanticAvailability: (opts?: { signal?: AbortSignal }) =>
		get<{ available: boolean; bound: boolean; enabled: boolean }>("/api/v1/ai/semantic", { signal: opts?.signal }),
	getSemanticStatus: (mailboxId: string, opts?: { signal?: AbortSignal }) =>
		get<SemanticStatus>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/semantic`, { signal: opts?.signal }),
	getAiSettings: (opts?: { signal?: AbortSignal }) => get<AiConfig>("/api/v1/ai/settings", { signal: opts?.signal }),
	updateAiSettings: (patch: AiConfigPatch) => put<AiConfig>("/api/v1/ai/settings", patch),
	getAssistantPrefs: (opts?: { signal?: AbortSignal }) =>
		get<AssistantPrefs>("/api/v1/me/assistant", { signal: opts?.signal }),
	updateAssistantPrefs: (patch: AssistantPrefsPatch) => put<AssistantPrefs>("/api/v1/me/assistant", patch),
	getBrief: (opts?: { signal?: AbortSignal }) => get<BriefState>("/api/v1/me/brief", { signal: opts?.signal }),
	generateBrief: () => post<{ brief: DailyBrief | null; dismissed: boolean }>("/api/v1/me/brief/generate"),
	dismissBrief: (id: string) => post<{ status: string }>(`/api/v1/me/brief/${encodeURIComponent(id)}/dismiss`),

	// ── Sending health (spam-rate breaker) and send caps ──────────────
	getSendingHealth: (opts?: { signal?: AbortSignal }) =>
		get<SendingHealthResponse>("/api/v1/sending-health", { signal: opts?.signal }),
	resumeBulkSending: (domain: string) =>
		post<{ domain: SendingDomainHealth }>(`/api/v1/sending-health/${encodeURIComponent(domain)}/resume`),
	pauseBulkSending: (domain: string, reason?: string) =>
		post<{ domain: SendingDomainHealth }>(`/api/v1/sending-health/${encodeURIComponent(domain)}/pause`, reason ? { reason } : {}),
	getSendLimits: (mailboxId: string) =>
		get<SendLimitsResponse>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/send-limits`),
	updateSendLimits: (mailboxId: string, caps: { hourly?: number; daily?: number }) =>
		put<SendLimitsResponse>(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/send-limits`, caps),

	// Usage and cost (admin)
	getUsage: (params: { refresh?: boolean } = {}, opts?: { signal?: AbortSignal }) =>
		get<UsageResponse>("/api/v1/usage", { params: params.refresh ? { refresh: "1" } : undefined, signal: opts?.signal }),
	updateUsageBudget: (patch: UsageBudgetPatch) => put<{ budget: UsageBudget }>("/api/v1/usage/budget", patch),
};

export interface ThreadSummary {
	thread_id: string;
	line: string | null;
	bullets: string[] | null;
	message_count: number;
	status: "ok" | "blocked" | "skipped";
	generated_at: string;
	stale: boolean;
}

export interface BriefState {
	brief: DailyBrief | null;
	dismissed: boolean;
	nextRunAt: string | null;
}

export type { AiConfig, AiConfigPatch, AssistantPrefs, AssistantPrefsPatch, DailyBrief };


export type { SendingDomainHealth };

export interface SendingHealthResponse {
	domains: SendingDomainHealth[];
	thresholds: { warning: number; pause: number; window_days: number; minimum_delivered: number };
}

export interface SendLimitsResponse extends SendUsage {
	maxima: { hourly: number; daily: number };
	editable: boolean;
	account_quota?: { limit: number; used: number; unit: string; resets_at: string | null } | null;
}

export type { Suppression, SuppressionReason };

export interface SuppressionPage {
	items: Suppression[];
	total: number;
	limit: number;
	offset: number;
}

export default api;
