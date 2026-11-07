/**
 * The ergonomic layer over the generated types.
 *
 *   const tapetide = new Tapetide({ baseUrl, token });
 *   const result = await tapetide.mail.send("support@example.com", { to, subject, text });
 *   if (isPendingApproval(result)) console.log("held:", result.approval_url);
 */

import { ApprovalChangedError, ConflictError } from "./errors.js";
import { EventsResource } from "./events.js";
import { HttpClient, type ClientOptions, type QueryValue } from "./http.js";
import {
	AccessResource,
	AiResource,
	AnalyticsResource,
	AssistantResource,
	AuditResource,
	BrandingResource,
	CloudflareResource,
	DelegatesResource,
	DomainsResource,
	FollowupsResource,
	FoldersResource,
	ImportsResource,
	LabelsResource,
	LicenceResource,
	MetaResource,
	MigrationResource,
	NotificationsResource,
	PeopleResource,
	PreferencesResource,
	PrivacyResource,
	ProductsResource,
	Resource,
	RulesResource,
	ScheduledSendsResource,
	ScreenerResource,
	SendersResource,
	SendingHealthResource,
	SequencesResource,
	SignaturesResource,
	SnoozeResource,
	SuppressionsResource,
	TemplatesResource,
	ThreadsResource,
	TriageResource,
	UsageResource,
	type CallOptions,
} from "./resources.js";
import type {
	AgentInbox,
	CreateAgentInboxRequest,
	CreateAgentInboxResult,
	CreateWebhookRequest,
	CreateWebhookResult,
	Email,
	EmailPage,
	Mailbox,
	MailboxSettingsPatch,
	QueryParams,
	RequestBody,
	ResponseBody,
	SendApproval,
	SendEmailRequest,
	SendResult,
	UpdateWebhookRequest,
	Webhook,
	WebhookDelivery,
} from "./types.js";

export type { CallOptions };

/** A send body; `from` defaults to the mailbox address. */
export type SendInput = Omit<SendEmailRequest, "from"> & { from?: SendEmailRequest["from"] };

export interface ListEmailsOptions {
	folder?: string;
	page?: number;
	limit?: number;
	threaded?: boolean;
	threadId?: string;
	unread?: boolean;
	starred?: boolean;
	hasAttachment?: boolean;
	sortColumn?: string;
	sortDirection?: "asc" | "desc";
}

export interface SearchOptions {
	folder?: string;
	page?: number;
	limit?: number;
	/** `semantic` or `hybrid` where the deployment has semantic search. */
	mode?: NonNullable<QueryParams<"searchEmails">["mode"]>;
}

const MB = "/api/v1/mailboxes/{mailboxId}";

class MailResource extends Resource {
	private async post(path: string, mailbox: string, id: string | undefined, input: SendInput, opts: CallOptions): Promise<SendResult> {
		const res = await this.http.request<SendResult>({
			method: "POST",
			path,
			params: { mailboxId: mailbox, ...(id ? { id } : {}) },
			body: { ...input, from: input.from ?? mailbox },
			...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
			...(opts.signal ? { signal: opts.signal } : {}),
		});
		return res.data;
	}

	/**
	 * Send now. Returns `SendAccepted`, or `PendingApproval` when the mailbox
	 * holds agent sends for a person (check with `isPendingApproval`). A held
	 * send is not an error and must not be retried. A 5xx is not retried
	 * either: the message may have gone out.
	 */
	send(mailbox: string, input: SendInput, opts: CallOptions = {}): Promise<SendResult> {
		return this.post(`${MB}/emails`, mailbox, undefined, input, opts);
	}

	/** Reply to a message; threading headers are derived server-side. */
	reply(mailbox: string, emailId: string, input: SendInput, opts: CallOptions = {}): Promise<SendResult> {
		return this.post(`${MB}/emails/{id}/reply`, mailbox, emailId, input, opts);
	}

	forward(mailbox: string, emailId: string, input: SendInput, opts: CallOptions = {}): Promise<SendResult> {
		return this.post(`${MB}/emails/{id}/forward`, mailbox, emailId, input, opts);
	}

	/** One page of a folder (default `inbox`). */
	async list(mailbox: string, opts: ListEmailsOptions = {}): Promise<EmailPage> {
		const query: Record<string, QueryValue> = {
			folder: opts.folder ?? "inbox",
			page: opts.page,
			limit: opts.limit,
			threaded: opts.threaded,
			thread_id: opts.threadId,
			unread: opts.unread,
			starred: opts.starred,
			has_attachment: opts.hasAttachment,
			sortColumn: opts.sortColumn,
			sortDirection: opts.sortDirection,
		};
		const res = await this.http.request<EmailPage | Email[]>({ method: "GET", path: `${MB}/emails`, params: { mailboxId: mailbox }, query });
		// Without a folder the server answers a bare array; normalise.
		return Array.isArray(res.data) ? { emails: res.data, totalCount: res.data.length } : res.data;
	}

	async get(mailbox: string, emailId: string): Promise<Email> {
		return (await this.http.request<Email>({ method: "GET", path: `${MB}/emails/{id}`, params: { mailboxId: mailbox, id: emailId } })).data;
	}

	/** Advanced query syntax: `from:`, `in:`, `has:attachment`, `OR`, `-term`. */
	async search(mailbox: string, query: string, opts: SearchOptions = {}): Promise<EmailPage> {
		return (
			await this.http.request<EmailPage>({
				method: "GET",
				path: `${MB}/search`,
				params: { mailboxId: mailbox },
				query: { query, folder: opts.folder, page: opts.page, limit: opts.limit, mode: opts.mode },
			})
		).data;
	}

	/** Mark read or unread, star or unstar. */
	update(mailbox: string, emailId: string, patch: RequestBody<"updateEmail">) {
		return this.call("updateEmail", { params: { mailboxId: mailbox, id: emailId }, body: patch });
	}

	/** Move to trash, or delete for good with `{ permanent: true }`. */
	async delete(mailbox: string, emailId: string, opts: { permanent?: boolean } = {}): Promise<void> {
		await this.call("deleteEmail", {
			params: { mailboxId: mailbox, id: emailId },
			query: { permanent: opts.permanent ? "true" : undefined },
		});
	}

	/** Take a message back out of trash. */
	restore(mailbox: string, emailId: string) {
		return this.call("restoreEmail", { params: { mailboxId: mailbox, id: emailId } });
	}

	move(mailbox: string, emailId: string, folderId: string) {
		return this.call("moveEmail", { params: { mailboxId: mailbox, id: emailId }, body: { folderId } });
	}

	setPriority(mailbox: string, emailId: string, priority: RequestBody<"setEmailPriority">["priority"]) {
		return this.call("setEmailPriority", { params: { mailboxId: mailbox, id: emailId }, body: { priority } });
	}

	notSpam(mailbox: string, emailId: string) {
		return this.call("markNotSpam", { params: { mailboxId: mailbox, id: emailId } });
	}

	/** Delivery, bounce, open and click events for a sent message. */
	deliveryEvents(mailbox: string, emailId: string) {
		return this.call("listDeliveryEvents", { params: { mailboxId: mailbox, id: emailId } });
	}

	/** Download an attachment: an unread `Response` (use `.arrayBuffer()` or stream `.body`). */
	attachment(mailbox: string, emailId: string, attachmentId: string, opts: { disposition?: "inline" | "attachment" } = {}) {
		return this.download("getAttachment", {
			params: { mailboxId: mailbox, emailId, attachmentId },
			query: { disposition: opts.disposition },
		});
	}

	/** One action on many messages (read, unread, star, move, label, trash, delete, ...). */
	bulk(mailbox: string, input: RequestBody<"bulkEmailAction">) {
		return this.call("bulkEmailAction", { params: { mailboxId: mailbox }, body: input });
	}

	emptyTrash(mailbox: string) {
		return this.call("emptyTrash", { params: { mailboxId: mailbox } });
	}

	markAllRead(mailbox: string, input: NonNullable<RequestBody<"markAllRead">> = {}) {
		return this.call("markAllRead", { params: { mailboxId: mailbox }, body: input });
	}

	/** Create a draft, or update one with `draft_id`. */
	saveDraft(mailbox: string, input: RequestBody<"saveDraft">, opts: CallOptions = {}) {
		return this.call("saveDraft", { params: { mailboxId: mailbox }, body: input, opts });
	}

	/** Search every mailbox you can read (`q`, optional `mode: "semantic"`). */
	searchAll(query: QueryParams<"searchAllMailboxes">) {
		return this.call("searchAllMailboxes", { query });
	}

	/** Ask a question about your mail; the answer cites messages. */
	ask(input: RequestBody<"askInbox">) {
		return this.call("askInbox", { body: input });
	}

	/** One page across mailboxes. Cursor-paginated: pass `nextCursor` back as `cursor`. */
	unified(query: QueryParams<"listUnifiedInbox"> = {}) {
		return this.call("listUnifiedInbox", { query });
	}
}

class MailboxesResource extends Resource {
	async list(opts: { domain?: string; includeSettings?: boolean } = {}): Promise<Mailbox[]> {
		return (
			await this.http.request<Mailbox[]>({
				method: "GET",
				path: "/api/v1/mailboxes",
				query: { domain: opts.domain, include: opts.includeSettings ? "settings" : undefined },
			})
		).data;
	}

	async get(mailbox: string): Promise<Mailbox> {
		return (await this.http.request<Mailbox>({ method: "GET", path: MB, params: { mailboxId: mailbox } })).data;
	}

	/** Admin. Idempotent: retried with the same key. */
	async create(input: { email: string; name: string; settings?: MailboxSettingsPatch }, opts: CallOptions = {}): Promise<Mailbox> {
		return (
			await this.http.request<Mailbox>({
				method: "POST",
				path: "/api/v1/mailboxes",
				body: input,
				...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
			})
		).data;
	}

	async update(mailbox: string, settings: MailboxSettingsPatch): Promise<Mailbox> {
		return (await this.http.request<Mailbox>({ method: "PUT", path: MB, params: { mailboxId: mailbox }, body: { settings } })).data;
	}

	/** Admin. Deletes the mailbox and all its mail. */
	async delete(mailbox: string): Promise<void> {
		await this.http.request<void>({ method: "DELETE", path: MB, params: { mailboxId: mailbox } });
	}

	/** Folder counts and other live state. */
	state(mailbox: string) {
		return this.call("getMailboxState", { params: { mailboxId: mailbox } });
	}

	aliases(mailbox: string) {
		return this.call("listMailboxAliases", { params: { mailboxId: mailbox } });
	}

	setAliases(mailbox: string, aliases: RequestBody<"setMailboxAliases">["aliases"]) {
		return this.call("setMailboxAliases", { params: { mailboxId: mailbox }, body: { aliases } });
	}

	/** Every message as mbox: an unread, streamed `Response`. */
	export(mailbox: string) {
		return this.download("exportMailbox", { params: { mailboxId: mailbox } });
	}
}

class AgentInboxesResource extends Resource {
	/**
	 * Admin. Creates a mailbox for an agent with a scoped token (returned once in
	 * `token.secret`) and an optional webhook. Retried with the same idempotency
	 * key; a replay returns the secrets as null.
	 */
	async create(input: CreateAgentInboxRequest, opts: CallOptions = {}): Promise<CreateAgentInboxResult> {
		return (
			await this.http.request<CreateAgentInboxResult>({
				method: "POST",
				path: "/api/v1/agent-inboxes",
				body: input,
				...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
			})
		).data;
	}

	async list(): Promise<AgentInbox[]> {
		return (await this.http.request<ResponseBody<"listAgentInboxes", 200>>({ method: "GET", path: "/api/v1/agent-inboxes" })).data.agent_inboxes ?? [];
	}

	async get(address: string): Promise<AgentInbox> {
		const res = await this.http.request<ResponseBody<"getAgentInbox", 200>>({
			method: "GET",
			path: "/api/v1/agent-inboxes/{address}",
			params: { address },
		});
		return res.data.agent_inbox as AgentInbox;
	}

	/**
	 * Change or clear the optional recipient restriction. `null` (the default
	 * state) lets the inbox send to anyone; an array restricts it to those
	 * addresses and `@domain`s, and anyone else is refused.
	 */
	async update(address: string, input: { allowed_recipients: string[] | null }): Promise<AgentInbox> {
		const res = await this.http.request<ResponseBody<"updateAgentInbox", 200>>({
			method: "PATCH",
			path: "/api/v1/agent-inboxes/{address}",
			params: { address },
			body: input,
		});
		return res.data.agent_inbox as AgentInbox;
	}

	/** End it now: revoke the token, archive the mail to R2, delete the mailbox. */
	async delete(address: string): Promise<ResponseBody<"deleteAgentInbox", 200>> {
		return (await this.http.request<ResponseBody<"deleteAgentInbox", 200>>({ method: "DELETE", path: "/api/v1/agent-inboxes/{address}", params: { address } })).data;
	}
}

class WebhooksResource extends Resource {
	async list(): Promise<Webhook[]> {
		return (await this.http.request<{ webhooks?: Webhook[] }>({ method: "GET", path: "/api/v1/webhooks" })).data.webhooks ?? [];
	}

	/** The signing `secret` is returned once; store it for `verifyWebhook`. */
	async create(input: CreateWebhookRequest, opts: CallOptions = {}): Promise<CreateWebhookResult> {
		return (
			await this.http.request<CreateWebhookResult>({
				method: "POST",
				path: "/api/v1/webhooks",
				body: input,
				...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
			})
		).data;
	}

	async get(id: string): Promise<Webhook> {
		return (await this.http.request<{ webhook: Webhook }>({ method: "GET", path: "/api/v1/webhooks/{id}", params: { id } })).data.webhook;
	}

	async update(id: string, patch: UpdateWebhookRequest): Promise<Webhook> {
		return (await this.http.request<{ webhook: Webhook }>({ method: "PATCH", path: "/api/v1/webhooks/{id}", params: { id }, body: patch })).data.webhook;
	}

	/** PUT: set the given fields (the same body as `update`). */
	async replace(id: string, input: UpdateWebhookRequest): Promise<Webhook> {
		return (await this.http.request<{ webhook: Webhook }>({ method: "PUT", path: "/api/v1/webhooks/{id}", params: { id }, body: input })).data.webhook;
	}

	async delete(id: string): Promise<void> {
		await this.http.request<void>({ method: "DELETE", path: "/api/v1/webhooks/{id}", params: { id } });
	}

	/** New secret, returned once; the old one stops working at once. */
	async rotateSecret(id: string): Promise<{ webhook: Webhook; secret: string }> {
		return (await this.http.request<{ webhook: Webhook; secret: string }>({ method: "POST", path: "/api/v1/webhooks/{id}/rotate-secret", params: { id } })).data;
	}

	async test(id: string): Promise<WebhookDelivery | null> {
		return (await this.http.request<{ delivery: WebhookDelivery | null }>({ method: "POST", path: "/api/v1/webhooks/{id}/test", params: { id } })).data.delivery;
	}

	async deliveries(id: string, opts: { limit?: number } = {}): Promise<WebhookDelivery[]> {
		return (
			await this.http.request<{ deliveries?: WebhookDelivery[] }>({
				method: "GET",
				path: "/api/v1/webhooks/{id}/deliveries",
				params: { id },
				query: { limit: opts.limit },
			})
		).data.deliveries ?? [];
	}

	/** Event types a webhook can subscribe to, and the retry schedule. */
	eventTypes() {
		return this.call("listWebhookEvents");
	}

	/** Deliver a past delivery's event again. */
	retryDelivery(deliveryId: string) {
		return this.call("retryWebhookDelivery", { params: { deliveryId } });
	}
}

export type ApprovalStatus = "pending" | "sending" | "sent" | "sent_unconfirmed" | "rejected" | "failed" | "all";

/** Fields a reviewer can edit (`edit`) or the requester can change (`revise`). */
export type ApprovalEdit = RequestBody<"reviseSendApproval">;

export interface ApproveOptions extends CallOptions {
	/**
	 * The `revision` you reviewed (from `get`). If the send changed since, the
	 * server sends nothing and `approve` throws `ApprovalChangedError`.
	 */
	revision?: number;
}

export interface WaitForDecisionOptions {
	/** Poll interval in ms (default 5 000). */
	intervalMs?: number;
	/** Give up after this long and return the still-pending approval (default 10 minutes). */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Injectable sleep, for tests. */
	sleep?: (ms: number) => Promise<void>;
}

class ApprovalsResource extends Resource {
	async list(mailbox: string, opts: { status?: ApprovalStatus; limit?: number } = {}): Promise<SendApproval[]> {
		return (
			await this.http.request<{ approvals: SendApproval[] }>({
				method: "GET",
				path: `${MB}/approvals`,
				params: { mailboxId: mailbox },
				query: { status: opts.status, limit: opts.limit },
			})
		).data.approvals;
	}

	async count(mailbox: string): Promise<number> {
		return (await this.http.request<{ pending: number }>({ method: "GET", path: `${MB}/approvals/count`, params: { mailboxId: mailbox } })).data.pending;
	}

	async get(mailbox: string, id: string): Promise<SendApproval> {
		return (await this.http.request<{ approval: SendApproval }>({ method: "GET", path: `${MB}/approvals/{id}`, params: { mailboxId: mailbox, id } })).data.approval;
	}

	/**
	 * Send a held message exactly as stored, at most once. Needs a token with
	 * `approvals:manage` that did not request the send. Transport errors are
	 * retried with the same idempotency key; a 5xx is not, because a 502 here
	 * means "may have been sent" (`sent_unconfirmed`).
	 *
	 * Pass `revision` (from `get`) so a send that changed after you read it is
	 * refused. That 409 is thrown as `ApprovalChangedError`; its `approval` is
	 * the new version, and nothing was sent.
	 */
	async approve(mailbox: string, id: string, opts: ApproveOptions = {}): Promise<{ approval: SendApproval; result?: Record<string, unknown> }> {
		try {
			return (
				await this.http.request<{ approval: SendApproval; result?: Record<string, unknown> }>({
					method: "POST",
					path: `${MB}/approvals/{id}/approve`,
					params: { mailboxId: mailbox, id },
					retryServerErrors: false,
					...(opts.revision !== undefined ? { body: { revision: opts.revision } } : {}),
					...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
					...(opts.signal ? { signal: opts.signal } : {}),
				})
			).data;
		} catch (err) {
			throw asApprovalChanged(err);
		}
	}

	/**
	 * A reviewer edits a pending single message before approving it (PATCH).
	 * Needs a decider, as `approve` does. Raises `revision`.
	 */
	async edit(mailbox: string, id: string, input: ApprovalEdit): Promise<SendApproval> {
		return (
			await this.http.request<{ approval: SendApproval }>({
				method: "PATCH",
				path: `${MB}/approvals/{id}`,
				params: { mailboxId: mailbox, id },
				body: input,
			})
		).data.approval;
	}

	/**
	 * The requester revises its own pending send: only the token or app that
	 * got `pending_approval` may (others get 403). It stays pending, `revision`
	 * goes up and `revised_by` is `requester`; a person still approves it. A
	 * decided approval answers 409.
	 */
	async revise(mailbox: string, id: string, input: ApprovalEdit): Promise<SendApproval> {
		return (
			await this.http.request<{ approval: SendApproval }>({
				method: "POST",
				path: `${MB}/approvals/{id}/revise`,
				params: { mailboxId: mailbox, id },
				body: input,
			})
		).data.approval;
	}

	/**
	 * Poll `get` until the approval leaves `pending`, or until `timeoutMs`
	 * passes (then it returns the still-pending approval). Read-only.
	 */
	async waitForDecision(mailbox: string, id: string, opts: WaitForDecisionOptions = {}): Promise<SendApproval> {
		const interval = opts.intervalMs ?? 5000;
		const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
		const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
		for (;;) {
			const approval = await this.get(mailbox, id);
			if (approval.status !== "pending" || Date.now() >= deadline || opts.signal?.aborted) return approval;
			await sleep(interval);
		}
	}

	async reject(mailbox: string, id: string, opts: { note?: string } = {}): Promise<SendApproval> {
		return (
			await this.http.request<{ approval: SendApproval }>({
				method: "POST",
				path: `${MB}/approvals/{id}/reject`,
				params: { mailboxId: mailbox, id },
				body: opts.note ? { note: opts.note } : {},
			})
		).data.approval;
	}

	/** Re-queue a `failed` approved send. */
	async retry(mailbox: string, id: string): Promise<SendApproval> {
		return (await this.http.request<{ approval: SendApproval }>({ method: "POST", path: `${MB}/approvals/{id}/retry`, params: { mailboxId: mailbox, id } })).data.approval;
	}
}

/**
 * The server answers both "changed since you read it" and "already decided"
 * with 409 and the current approval. Only a still-pending approval means it
 * changed; that one becomes `ApprovalChangedError`.
 */
function asApprovalChanged(err: unknown): unknown {
	if (!(err instanceof ConflictError)) return err;
	const approval = (err.body as { approval?: { status?: unknown } } | undefined)?.approval;
	if (approval?.status !== "pending") return err;
	return new ApprovalChangedError(err.message, {
		status: err.status,
		...(err.code !== undefined ? { code: err.code } : {}),
		body: err.body,
		...(err.headers ? { headers: err.headers } : {}),
		cause: err,
	});
}

export class Tapetide {
	readonly http: HttpClient;
	readonly mail: MailResource;
	readonly mailboxes: MailboxesResource;
	readonly agentInboxes: AgentInboxesResource;
	readonly webhooks: WebhooksResource;
	readonly approvals: ApprovalsResource;
	readonly events: EventsResource;

	// Inside a mailbox
	readonly threads: ThreadsResource;
	readonly folders: FoldersResource;
	readonly labels: LabelsResource;
	readonly signatures: SignaturesResource;
	readonly snooze: SnoozeResource;
	readonly followups: FollowupsResource;
	readonly triage: TriageResource;
	readonly screener: ScreenerResource;
	readonly scheduledSends: ScheduledSendsResource;
	readonly senders: SendersResource;
	readonly rules: RulesResource;
	readonly imports: ImportsResource;
	readonly delegates: DelegatesResource;
	readonly audit: AuditResource;

	// Instance-wide
	readonly meta: MetaResource;
	readonly products: ProductsResource;
	readonly people: PeopleResource;
	readonly analytics: AnalyticsResource;
	readonly templates: TemplatesResource;
	readonly sequences: SequencesResource;
	readonly suppressions: SuppressionsResource;
	readonly sendingHealth: SendingHealthResource;
	readonly usage: UsageResource;
	readonly domains: DomainsResource;
	readonly cloudflare: CloudflareResource;
	readonly ai: AiResource;
	readonly assistant: AssistantResource;
	readonly notifications: NotificationsResource;
	readonly preferences: PreferencesResource;
	readonly branding: BrandingResource;
	readonly access: AccessResource;
	readonly privacy: PrivacyResource;
	readonly licence: LicenceResource;
	readonly migration: MigrationResource;

	constructor(options: ClientOptions) {
		const http = new HttpClient(options);
		this.http = http;
		this.mail = new MailResource(http);
		this.mailboxes = new MailboxesResource(http);
		this.agentInboxes = new AgentInboxesResource(http);
		this.webhooks = new WebhooksResource(http);
		this.approvals = new ApprovalsResource(http);
		this.events = new EventsResource(http);

		this.threads = new ThreadsResource(http);
		this.folders = new FoldersResource(http);
		this.labels = new LabelsResource(http);
		this.signatures = new SignaturesResource(http);
		this.snooze = new SnoozeResource(http);
		this.followups = new FollowupsResource(http);
		this.triage = new TriageResource(http);
		this.screener = new ScreenerResource(http);
		this.scheduledSends = new ScheduledSendsResource(http);
		this.senders = new SendersResource(http);
		this.rules = new RulesResource(http);
		this.imports = new ImportsResource(http);
		this.delegates = new DelegatesResource(http);
		this.audit = new AuditResource(http);

		this.meta = new MetaResource(http);
		this.products = new ProductsResource(http);
		this.people = new PeopleResource(http);
		this.analytics = new AnalyticsResource(http);
		this.templates = new TemplatesResource(http);
		this.sequences = new SequencesResource(http);
		this.suppressions = new SuppressionsResource(http);
		this.sendingHealth = new SendingHealthResource(http);
		this.usage = new UsageResource(http);
		this.domains = new DomainsResource(http);
		this.cloudflare = new CloudflareResource(http);
		this.ai = new AiResource(http);
		this.assistant = new AssistantResource(http);
		this.notifications = new NotificationsResource(http);
		this.preferences = new PreferencesResource(http);
		this.branding = new BrandingResource(http);
		this.access = new AccessResource(http);
		this.privacy = new PrivacyResource(http);
		this.licence = new LicenceResource(http);
		this.migration = new MigrationResource(http);
	}
}
