/**
 * Resource groups for the rest of the API. Each method calls one OpenAPI
 * operation by its `operationId` (method and path come from the generated
 * `OPERATIONS` table), and its input and output types come from the
 * generated schema, so they track the server.
 *
 * Writes that the server keys (see `IDEMPOTENT_POST_PATHS`) take
 * `CallOptions` with an optional `idempotencyKey`; other writes are never
 * retried and take no key.
 */

import { OPERATIONS, type OperationId } from "./generated/operations.js";
import type { HttpClient, QueryValue } from "./http.js";
import type { operations } from "./generated/schema.js";
import type { QueryParams, RequestBody, SuccessBody } from "./types.js";

/** Options every keyed write accepts. */
export interface CallOptions {
	/** Your own key, e.g. derived from a job id. Default: a fresh UUID per call. */
	idempotencyKey?: string;
	signal?: AbortSignal;
}

export type Op = OperationId & keyof operations;

/** An operation's success body; `void` when it answers 204 with no body. */
export type Out<O extends Op> = [SuccessBody<O>] extends [never] ? void : SuccessBody<O>;

/** The path parameters an operation needs, checked at compile time. */
export type PathParams<O extends Op> = operations[O]["parameters"] extends { path: infer P } ? { [K in keyof P]: string } : never;

interface CallArgs<O extends Op> {
	params?: PathParams<O>;
	query?: QueryParams<O> | Record<string, QueryValue>;
	body?: unknown;
	rawBody?: Uint8Array | ArrayBuffer | Blob;
	contentType?: string;
	headers?: Record<string, string>;
	opts?: CallOptions;
}

export abstract class Resource {
	constructor(protected readonly http: HttpClient) {}

	/** Call one operation and return its JSON body. */
	protected async call<O extends Op>(op: O, args: CallArgs<O> = {}): Promise<Out<O>> {
		const { method, path } = OPERATIONS[op];
		const res = await this.http.request<Out<O>>({
			method,
			path,
			...(args.params ? { params: args.params as Record<string, string> } : {}),
			...(args.query ? { query: args.query as Record<string, QueryValue> } : {}),
			...(args.body !== undefined ? { body: args.body } : {}),
			...(args.rawBody !== undefined ? { rawBody: args.rawBody } : {}),
			...(args.contentType ? { contentType: args.contentType } : {}),
			...(args.headers ? { headers: args.headers } : {}),
			...(args.opts?.idempotencyKey ? { idempotencyKey: args.opts.idempotencyKey } : {}),
			...(args.opts?.signal ? { signal: args.opts.signal } : {}),
		});
		return res.data;
	}

	/** Call a download operation and return the unread `Response`. */
	protected async download<O extends Op>(op: O, args: CallArgs<O> = {}): Promise<Response> {
		const { method, path } = OPERATIONS[op];
		const res = await this.http.request<Response>({
			method,
			path,
			raw: true,
			...(args.params ? { params: args.params as Record<string, string> } : {}),
			...(args.query ? { query: args.query as Record<string, QueryValue> } : {}),
			...(args.opts?.signal ? { signal: args.opts.signal } : {}),
		});
		return res.data;
	}
}

const mb = <E extends Record<string, string> = {}>(mailbox: string, extra?: E) => ({ mailboxId: mailbox, ...extra }) as { mailboxId: string } & E;

// ── Account and deployment ──────────────────────────────────────────

export class MetaResource extends Resource {
	/** The OpenAPI document this deployment serves. */
	openApi() {
		return this.call("getOpenApiDocument");
	}
	/** Who the token belongs to, its role, mailboxes and capabilities. */
	me() {
		return this.call("getMe");
	}
	/** Domains, addresses and zones this deployment serves. */
	config() {
		return this.call("getConfig");
	}
}

export class BrandingResource extends Resource {
	get() {
		return this.call("getBranding");
	}
	update(input: RequestBody<"updateBranding">) {
		return this.call("updateBranding", { body: input });
	}
	reset() {
		return this.call("resetBranding");
	}
	/** The logo image (unread `Response`). */
	logo(query: QueryParams<"getBrandingLogo"> = {}) {
		return this.download("getBrandingLogo", { query });
	}
	/** `content` is base64 without a data-URL prefix. */
	uploadLogo(input: RequestBody<"uploadBrandingLogo">) {
		return this.call("uploadBrandingLogo", { body: input });
	}
	deleteLogo() {
		return this.call("deleteBrandingLogo");
	}
}

export class PreferencesResource extends Resource {
	get() {
		return this.call("getPreferences");
	}
	update(input: RequestBody<"updatePreferences">) {
		return this.call("updatePreferences", { body: input });
	}
}

/**
 * AI settings and providers. Provider and routing changes need a person in
 * the app, so only the reads and the model checks are here.
 */
export class AiResource extends Resource {
	settings() {
		return this.call("getAiSettings");
	}
	updateSettings(input: RequestBody<"updateAiSettings">) {
		return this.call("updateAiSettings", { body: input });
	}
	providers() {
		return this.call("listAiProviders");
	}
	/** Ask a gateway provider which models it offers. */
	discoverModels(providerId: string) {
		return this.call("discoverAiProviderModels", { params: { id: providerId } });
	}
	testModel(providerId: string, input: RequestBody<"testAiProviderModel">) {
		return this.call("testAiProviderModel", { params: { id: providerId }, body: input });
	}
	routing() {
		return this.call("getAiRouting");
	}
	workersAiModels(query: QueryParams<"listWorkersAiModels"> = {}) {
		return this.call("listWorkersAiModels", { query });
	}
	testWorkersAiModel(input: RequestBody<"testWorkersAiModel">) {
		return this.call("testWorkersAiModel", { body: input });
	}
	/** Whether semantic search is bound and enabled on this deployment. */
	semanticAvailability() {
		return this.call("getSemanticAvailability");
	}
	/** One mailbox's semantic index: indexed, queued, today's use. */
	semanticStatus(mailbox: string) {
		return this.call("getSemanticStatus", { params: mb(mailbox) });
	}
}

/** Cloudflare discovery and planning. Connecting, applying and reverting need a browser session. */
export class CloudflareResource extends Resource {
	connection() {
		return this.call("getCloudflareConnection");
	}
	discover(query: QueryParams<"discoverCloudflare"> = {}) {
		return this.call("discoverCloudflare", { query });
	}
	plan(input: RequestBody<"planCloudflareSetup">) {
		return this.call("planCloudflareSetup", { body: input });
	}
	changes(query: QueryParams<"listCloudflareChanges"> = {}) {
		return this.call("listCloudflareChanges", { query });
	}
}

/** The CloudMail licence. Activating and deactivating need a browser session. */
export class LicenceResource extends Resource {
	/** Status, lock state and (for admins) plan and customer details. */
	get() {
		return this.call("getLicence");
	}
	/** Admin. Refresh the signed token from the licence server now. */
	refresh() {
		return this.call("refreshLicence");
	}
}

/** The caller's own assistant: list summaries and the daily brief. */
export class AssistantResource extends Resource {
	prefs() {
		return this.call("getAssistantPrefs");
	}
	updatePrefs(input: RequestBody<"updateAssistantPrefs">) {
		return this.call("updateAssistantPrefs", { body: input });
	}
	brief() {
		return this.call("getDailyBrief");
	}
	generateBrief() {
		return this.call("generateDailyBrief");
	}
	dismissBrief(briefId: string) {
		return this.call("dismissDailyBrief", { params: { briefId } });
	}
}

/** Web Push. Devices and push preferences belong to a browser, so only the public key is here. */
export class NotificationsResource extends Resource {
	vapidKey() {
		return this.call("getPushVapidKey");
	}
}

/** Admin. Instance-wide access grants for people and services. */
export class AccessResource extends Resource {
	list() {
		return this.call("listAccessGrants");
	}
	put(input: RequestBody<"putAccessGrant">) {
		return this.call("putAccessGrant", { body: input });
	}
	delete(kind: string, id: string) {
		return this.call("deleteAccessGrant", { params: { kind, id } });
	}
}

export class AuditResource extends Resource {
	/** A mailbox's audit log, newest first. */
	list(mailbox: string, query: QueryParams<"listMailboxAudit"> = {}) {
		return this.call("listMailboxAudit", { params: mb(mailbox), query });
	}
	/** Admin. The instance audit log (access, domains, licence, ...). */
	instance(query: QueryParams<"listInstanceAudit"> = {}) {
		return this.call("listInstanceAudit", { query });
	}
}

export class PrivacyResource extends Resource {
	tracking(mailbox: string) {
		return this.call("getTrackingSettings", { params: mb(mailbox) });
	}
	updateTracking(mailbox: string, input: RequestBody<"updateTrackingSettings">) {
		return this.call("updateTrackingSettings", { params: mb(mailbox), body: input });
	}
	/** The deployment's privacy notice settings (public). */
	settings() {
		return this.call("getPrivacySettings");
	}
	updateSettings(input: RequestBody<"updatePrivacySettings">) {
		return this.call("updatePrivacySettings", { body: input });
	}
	accountDeletion() {
		return this.call("getAccountDeletion");
	}
	cancelAccountDeletion() {
		return this.call("cancelAccountDeletion");
	}
	exports() {
		return this.call("listAccountExports");
	}
	/**
	 * Download a ready export (ZIP, unread `Response`). `token` is the signed
	 * value from the export's `downloadUrl`.
	 */
	downloadExport(id: string, token: string) {
		return this.download("downloadAccountExport", { params: { id }, query: { token } });
	}
}

/** Operator-only data moves between Durable Object namespaces. Needs the deployment's `MIGRATION_TOKEN`. */
export class MigrationResource extends Resource {
	status(mailbox: string, opts: { migrationToken: string }) {
		return this.call("getMigrationStatus", { params: mb(mailbox), headers: { "X-Migration-Token": opts.migrationToken } });
	}
	run(mailbox: string, opts: { migrationToken: string; dryRun?: boolean }) {
		return this.call("migrateMailbox", {
			params: mb(mailbox),
			query: { dryRun: opts.dryRun === undefined ? undefined : String(opts.dryRun) },
			headers: { "X-Migration-Token": opts.migrationToken },
		});
	}
}

// ── Mailbox contents ────────────────────────────────────────────────

export class DelegatesResource extends Resource {
	list(mailbox: string) {
		return this.call("listMailboxDelegates", { params: mb(mailbox) });
	}
	put(mailbox: string, input: RequestBody<"putMailboxDelegate">) {
		return this.call("putMailboxDelegate", { params: mb(mailbox), body: input });
	}
	delete(mailbox: string, kind: string, id: string) {
		return this.call("deleteMailboxDelegate", { params: mb(mailbox, { kind, id }) });
	}
}

export class ThreadsResource extends Resource {
	/** Every message in a thread, oldest first. */
	get(mailbox: string, threadId: string, query: QueryParams<"getThread"> = {}) {
		return this.call("getThread", { params: mb(mailbox, { threadId }), query });
	}
	summary(mailbox: string, threadId: string) {
		return this.call("getThreadSummary", { params: mb(mailbox, { threadId }) });
	}
	/** Queue a fresh summary (202). */
	refreshSummary(mailbox: string, threadId: string) {
		return this.call("refreshThreadSummary", { params: mb(mailbox, { threadId }) });
	}
	/** Generate a summary now and return it. */
	generateSummary(mailbox: string, threadId: string) {
		return this.call("generateThreadSummary", { params: mb(mailbox, { threadId }) });
	}
	markRead(mailbox: string, threadId: string) {
		return this.call("markThreadRead", { params: mb(mailbox, { threadId }) });
	}
	mute(mailbox: string, threadId: string) {
		return this.call("muteThread", { params: mb(mailbox, { threadId }) });
	}
	unmute(mailbox: string, threadId: string) {
		return this.call("unmuteThread", { params: mb(mailbox, { threadId }) });
	}
	muted(mailbox: string) {
		return this.call("listMutedThreads", { params: mb(mailbox) });
	}
}

export class FoldersResource extends Resource {
	list(mailbox: string) {
		return this.call("listFolders", { params: mb(mailbox) });
	}
	create(mailbox: string, name: string) {
		return this.call("createFolder", { params: mb(mailbox), body: { name } });
	}
	rename(mailbox: string, folderId: string, name: string) {
		return this.call("renameFolder", { params: mb(mailbox, { id: folderId }), body: { name } });
	}
	/** Mail in the folder is moved out (see `movedTo`). */
	delete(mailbox: string, folderId: string) {
		return this.call("deleteFolder", { params: mb(mailbox, { id: folderId }) });
	}
}

export class LabelsResource extends Resource {
	list(mailbox: string) {
		return this.call("listLabels", { params: mb(mailbox) });
	}
	create(mailbox: string, input: RequestBody<"createLabel">) {
		return this.call("createLabel", { params: mb(mailbox), body: input });
	}
	update(mailbox: string, labelId: string, input: RequestBody<"updateLabel">) {
		return this.call("updateLabel", { params: mb(mailbox, { labelId }), body: input });
	}
	delete(mailbox: string, labelId: string) {
		return this.call("deleteLabel", { params: mb(mailbox, { labelId }) });
	}
	/** One page of mail with this label. */
	emails(mailbox: string, labelId: string, query: QueryParams<"listLabelEmails"> = {}) {
		return this.call("listLabelEmails", { params: mb(mailbox, { labelId }), query });
	}
	forEmail(mailbox: string, emailId: string) {
		return this.call("listEmailLabels", { params: mb(mailbox, { id: emailId }) });
	}
	/** Replace a message's labels. */
	setForEmail(mailbox: string, emailId: string, labelIds: string[]) {
		return this.call("setEmailLabels", { params: mb(mailbox, { id: emailId }), body: { label_ids: labelIds } });
	}
	addToEmail(mailbox: string, emailId: string, labelId: string) {
		return this.call("addEmailLabel", { params: mb(mailbox, { id: emailId }), body: { label_id: labelId } });
	}
	removeFromEmail(mailbox: string, emailId: string, labelId: string) {
		return this.call("removeEmailLabel", { params: mb(mailbox, { id: emailId, labelId }) });
	}
}

export class SignaturesResource extends Resource {
	list(mailbox: string) {
		return this.call("listSignatures", { params: mb(mailbox) });
	}
	create(mailbox: string, input: RequestBody<"createSignature">) {
		return this.call("createSignature", { params: mb(mailbox), body: input });
	}
	getDefault(mailbox: string) {
		return this.call("getDefaultSignature", { params: mb(mailbox) });
	}
	update(mailbox: string, signatureId: string, input: RequestBody<"updateSignature">) {
		return this.call("updateSignature", { params: mb(mailbox, { signatureId }), body: input });
	}
	delete(mailbox: string, signatureId: string) {
		return this.call("deleteSignature", { params: mb(mailbox, { signatureId }) });
	}
}

export class SnoozeResource extends Resource {
	list(mailbox: string) {
		return this.call("listSnoozed", { params: mb(mailbox) });
	}
	/** Hide a message until `until` (ISO time) or for `delay_seconds`. */
	snooze(mailbox: string, emailId: string, input: RequestBody<"snoozeEmail">) {
		return this.call("snoozeEmail", { params: mb(mailbox, { id: emailId }), body: input });
	}
	unsnooze(mailbox: string, emailId: string) {
		return this.call("unsnoozeEmail", { params: mb(mailbox, { id: emailId }) });
	}
}

export class FollowupsResource extends Resource {
	list(mailbox: string, query: QueryParams<"listFollowups"> = {}) {
		return this.call("listFollowups", { params: mb(mailbox), query });
	}
	get(mailbox: string, emailId: string) {
		return this.call("getFollowup", { params: mb(mailbox, { id: emailId }) });
	}
	/** Remind me if nobody replies by `at` (or after `delay_seconds`). */
	set(mailbox: string, emailId: string, input: RequestBody<"setFollowup">, opts: CallOptions = {}) {
		return this.call("setFollowup", { params: mb(mailbox, { id: emailId }), body: input, opts });
	}
	delete(mailbox: string, emailId: string) {
		return this.call("deleteFollowup", { params: mb(mailbox, { id: emailId }) });
	}
	cancel(mailbox: string, emailId: string, opts: CallOptions = {}) {
		return this.call("cancelFollowup", { params: mb(mailbox, { id: emailId }), opts });
	}
}

export class TriageResource extends Resource {
	labelPrompts(mailbox: string) {
		return this.call("listLabelPrompts", { params: mb(mailbox) });
	}
	setLabelPrompt(mailbox: string, labelId: string, input: RequestBody<"setLabelPrompt">) {
		return this.call("setLabelPrompt", { params: mb(mailbox, { labelId }), body: input });
	}
	setPreset(mailbox: string, key: string, input: RequestBody<"setTriagePreset">) {
		return this.call("setTriagePreset", { params: mb(mailbox, { key }), body: input });
	}
	/** Classify recent unlabelled mail. */
	backfill(mailbox: string, input: RequestBody<"backfillTriage"> = {}) {
		return this.call("backfillTriage", { params: mb(mailbox), body: input });
	}
	inboxTabs(mailbox: string) {
		return this.call("listInboxTabs", { params: mb(mailbox) });
	}
}

export class ScreenerResource extends Resource {
	list(mailbox: string, query: QueryParams<"listScreener"> = {}) {
		return this.call("listScreener", { params: mb(mailbox), query });
	}
	/** Let a first-time sender in, or screen them out. */
	screen(mailbox: string, sender: string, input: RequestBody<"screenSender">, opts: CallOptions = {}) {
		return this.call("screenSender", { params: mb(mailbox, { sender }), body: input, opts });
	}
}

/** A scheduled send body; `from` defaults to the mailbox address. */
export type ScheduleInput = Omit<RequestBody<"scheduleSend">, "from"> & { from?: RequestBody<"scheduleSend">["from"] };

export class ScheduledSendsResource extends Resource {
	list(mailbox: string) {
		return this.call("listScheduledSends", { params: mb(mailbox) });
	}
	/**
	 * Queue a send for `send_at` or after `delay_seconds`. May come back as
	 * `PendingApproval` (check with `isPendingApproval`). Not retried on 5xx.
	 */
	schedule(mailbox: string, input: ScheduleInput, opts: CallOptions = {}) {
		return this.call("scheduleSend", { params: mb(mailbox), body: { ...input, from: input.from ?? mailbox }, opts });
	}
	cancel(mailbox: string, emailId: string) {
		return this.call("cancelScheduledSend", { params: mb(mailbox, { emailId }) });
	}
	/** Send a queued message now. Not retried on 5xx. */
	sendNow(mailbox: string, emailId: string, opts: CallOptions = {}) {
		return this.call("sendScheduledNow", { params: mb(mailbox, { emailId }), opts });
	}
}

export class SendersResource extends Resource {
	blocked(mailbox: string) {
		return this.call("listBlockedSenders", { params: mb(mailbox) });
	}
	block(mailbox: string, input: RequestBody<"blockSender">) {
		return this.call("blockSender", { params: mb(mailbox), body: input });
	}
	unblock(mailbox: string, blockId: string) {
		return this.call("unblockSender", { params: mb(mailbox, { blockId }) });
	}
	allowed(mailbox: string) {
		return this.call("listAllowedSenders", { params: mb(mailbox) });
	}
	allow(mailbox: string, input: RequestBody<"allowSender">) {
		return this.call("allowSender", { params: mb(mailbox), body: input });
	}
	removeAllowed(mailbox: string, allowId: string) {
		return this.call("removeAllowedSender", { params: mb(mailbox, { allowId }) });
	}
}

export class RulesResource extends Resource {
	list(mailbox: string) {
		return this.call("listRules", { params: mb(mailbox) });
	}
	create(mailbox: string, input: RequestBody<"createRule">) {
		return this.call("createRule", { params: mb(mailbox), body: input });
	}
	update(mailbox: string, ruleId: string, input: RequestBody<"updateRule">) {
		return this.call("updateRule", { params: mb(mailbox, { ruleId }), body: input });
	}
	delete(mailbox: string, ruleId: string) {
		return this.call("deleteRule", { params: mb(mailbox, { ruleId }) });
	}
	/** Set the evaluation order: every rule id, first to last. */
	reorder(mailbox: string, ids: string[]) {
		return this.call("reorderRules", { params: mb(mailbox), body: { ids } });
	}
}

export class ImportsResource extends Resource {
	list(mailbox: string) {
		return this.call("listImports", { params: mb(mailbox) });
	}
	/** Start an upload import (mbox, zip, eml) or an IMAP import. */
	create(mailbox: string, input: RequestBody<"createImport">, opts: CallOptions = {}) {
		return this.call("createImport", { params: mb(mailbox), body: input, opts });
	}
	get(mailbox: string, importId: string) {
		return this.call("getImport", { params: mb(mailbox, { id: importId }) });
	}
	/**
	 * Upload part `part` (from 1). Every part but the last is exactly
	 * `upload.part_size` bytes; re-sending a part replaces it.
	 */
	uploadPart(mailbox: string, importId: string, part: number, bytes: Uint8Array | ArrayBuffer | Blob) {
		return this.call("uploadImportPart", { params: mb(mailbox, { id: importId, part: String(part) }), rawBody: bytes });
	}
	complete(mailbox: string, importId: string) {
		return this.call("completeImport", { params: mb(mailbox, { id: importId }) });
	}
	pause(mailbox: string, importId: string) {
		return this.call("pauseImport", { params: mb(mailbox, { id: importId }) });
	}
	resume(mailbox: string, importId: string) {
		return this.call("resumeImport", { params: mb(mailbox, { id: importId }) });
	}
	cancel(mailbox: string, importId: string) {
		return this.call("cancelImport", { params: mb(mailbox, { id: importId }) });
	}
}

// ── Instance-wide ───────────────────────────────────────────────────

export class ProductsResource extends Resource {
	list() {
		return this.call("listProducts");
	}
	create(input: RequestBody<"createProduct">) {
		return this.call("createProduct", { body: input });
	}
	/** The product a sending address belongs to. */
	resolve(from: string) {
		return this.call("resolveProduct", { query: { from } });
	}
	get(id: string) {
		return this.call("getProduct", { params: { id } });
	}
	update(id: string, input: RequestBody<"updateProduct">) {
		return this.call("updateProduct", { params: { id }, body: input });
	}
	delete(id: string) {
		return this.call("deleteProduct", { params: { id } });
	}
	putLogo(id: string, input: RequestBody<"putProductLogo">) {
		return this.call("putProductLogo", { params: { id }, body: input });
	}
	deleteLogo(id: string) {
		return this.call("deleteProductLogo", { params: { id } });
	}
	refreshKnowledge(id: string) {
		return this.call("refreshProductKnowledge", { params: { id } });
	}
}

export class PeopleResource extends Resource {
	list(query: QueryParams<"listPeople"> = {}) {
		return this.call("listPeople", { query });
	}
	emails(person: string, query: QueryParams<"listPersonEmails"> = {}) {
		return this.call("listPersonEmails", { params: { person }, query });
	}
}

export class AnalyticsResource extends Resource {
	get(query: QueryParams<"getAnalytics"> = {}) {
		return this.call("getAnalytics", { query });
	}
	sent(query: QueryParams<"getSentAnalytics"> = {}) {
		return this.call("getSentAnalytics", { query });
	}
	overview(query: QueryParams<"getAnalyticsOverview"> = {}) {
		return this.call("getAnalyticsOverview", { query });
	}
	engagement(query: QueryParams<"getAnalyticsEngagement"> = {}) {
		return this.call("getAnalyticsEngagement", { query });
	}
	inbound(query: QueryParams<"getAnalyticsInbound"> = {}) {
		return this.call("getAnalyticsInbound", { query });
	}
	dmarc(query: QueryParams<"getAnalyticsDmarc"> = {}) {
		return this.call("getAnalyticsDmarc", { query });
	}
}

export class TemplatesResource extends Resource {
	list() {
		return this.call("listTemplates");
	}
	create(input: RequestBody<"createTemplate">) {
		return this.call("createTemplate", { body: input });
	}
	get(slug: string) {
		return this.call("getTemplate", { params: { slug } });
	}
	update(slug: string, input: RequestBody<"updateTemplate">) {
		return this.call("updateTemplate", { params: { slug }, body: input });
	}
	delete(slug: string) {
		return this.call("deleteTemplate", { params: { slug } });
	}
	/**
	 * Send a template to up to many recipients from `mailbox`. May come back
	 * as `PendingApproval`. Not retried on 5xx.
	 */
	send(mailbox: string, input: RequestBody<"sendTemplate">, opts: CallOptions = {}) {
		return this.call("sendTemplate", { params: mb(mailbox), body: input, opts });
	}
}

export class SequencesResource extends Resource {
	list() {
		return this.call("listSequences");
	}
	create(input: RequestBody<"createSequence">) {
		return this.call("createSequence", { body: input });
	}
	get(id: string) {
		return this.call("getSequence", { params: { id } });
	}
	update(id: string, input: RequestBody<"updateSequence">) {
		return this.call("updateSequence", { params: { id }, body: input });
	}
	delete(id: string) {
		return this.call("deleteSequence", { params: { id } });
	}
	enrollments(id: string) {
		return this.call("listSequenceEnrollments", { params: { id } });
	}
	/** Enroll a person. May come back as `PendingApproval`. Not retried on 5xx. */
	enroll(id: string, input: RequestBody<"enrollInSequence">, opts: CallOptions = {}) {
		return this.call("enrollInSequence", { params: { id }, body: input, opts });
	}
	personEnrollment(personId: string) {
		return this.call("getPersonEnrollment", { params: { personId } });
	}
	cancelEnrollment(enrollmentId: string) {
		return this.call("cancelEnrollment", { params: { enrollmentId } });
	}
}

export class SuppressionsResource extends Resource {
	list(query: QueryParams<"listSuppressions"> = {}) {
		return this.call("listSuppressions", { query });
	}
	/** One entry, or `{ entries: [...] }` (up to 1000). */
	add(input: RequestBody<"addSuppressions">, opts: CallOptions = {}) {
		return this.call("addSuppressions", { body: input, opts });
	}
	import(input: RequestBody<"importSuppressions">) {
		return this.call("importSuppressions", { body: input });
	}
	/** Which of these addresses would be dropped from a send. */
	check(input: RequestBody<"checkSuppressions">) {
		return this.call("checkSuppressions", { body: input });
	}
	delete(id: string) {
		return this.call("deleteSuppression", { params: { id } });
	}
}

export class SendingHealthResource extends Resource {
	list() {
		return this.call("listSendingHealth");
	}
	evaluate() {
		return this.call("evaluateSendingHealth");
	}
	/** Admin. Lift the spam-rate breaker for a domain. */
	resume(domain: string) {
		return this.call("resumeBulkSending", { params: { domain } });
	}
	pause(domain: string, input: RequestBody<"pauseBulkSending"> = {}) {
		return this.call("pauseBulkSending", { params: { domain }, body: input });
	}
	limits(mailbox: string) {
		return this.call("getSendLimits", { params: mb(mailbox) });
	}
	updateLimits(mailbox: string, input: RequestBody<"updateSendLimits">) {
		return this.call("updateSendLimits", { params: mb(mailbox), body: input });
	}
}

export class UsageResource extends Resource {
	get(query: QueryParams<"getUsage"> = {}) {
		return this.call("getUsage", { query });
	}
	updateBudget(input: RequestBody<"updateUsageBudget">) {
		return this.call("updateUsageBudget", { body: input });
	}
}

export class DomainsResource extends Resource {
	list() {
		return this.call("listDomains");
	}
	create(input: RequestBody<"createDomain">, opts: CallOptions = {}) {
		return this.call("createDomain", { body: input, opts });
	}
	get(id: string) {
		return this.call("getDomain", { params: { id } });
	}
	update(id: string, input: RequestBody<"updateDomain">) {
		return this.call("updateDomain", { params: { id }, body: input });
	}
	delete(id: string) {
		return this.call("deleteDomain", { params: { id } });
	}
	verify(id: string) {
		return this.call("verifyDomain", { params: { id } });
	}
	/** Create the DNS records and email routing for a domain on Cloudflare. */
	provision(id: string, input: RequestBody<"provisionDomain"> = {}) {
		return this.call("provisionDomain", { params: { id }, body: input });
	}
}
