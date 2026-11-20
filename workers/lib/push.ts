// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Web Push dispatch: VAPID keys, who gets told about what, the send itself,
 * and the signed action tokens a notification's buttons carry.
 *
 * Callers:
 *   - `receiveEmail` (workers/index.ts) via `waitUntil`, after the message is
 *     stored, or the mailbox alarm once triage has run when the mailbox has
 *     auto-archiving labels (`notifyNewMail`).
 *   - MailboxDO when a send is held for approval (`notifyApproval`) and when
 *     follow-up reminders come due (`notifyFollowups`).
 *   - `/api/v1/push/test` (`sendTestPush`).
 *
 * Never throws: a push is a courtesy on top of mail that is already stored.
 * No `cloudflare:workers` import, so tests can drive it with fake bindings.
 */

import type { Env } from "../types";
import { getUnsubscribeSecret } from "./suppressions";
import { canDo, resolvePrincipalFor, type Principal } from "./authz";
import { resolveAuthMode } from "../auth/config";
import { deploymentOrigin } from "./deployment-origin";
import { getDomains } from "./zones";
import { listProducts } from "./products";
import { assistantStub } from "./daily-brief";
import { resolveProduct } from "../../shared/products";
import { signLink, verifyLink } from "../../shared/signed-link";
import {
	encryptPushPayload,
	generateP256KeyPair,
	isP256PrivateKey,
	isP256PublicKey,
	vapidAuthorization,
	type P256KeyPair,
} from "../../shared/web-push";
import {
	approvalPayload,
	decideMailPush,
	followupPayload,
	inQuietHours,
	mailPayload,
	testPayload,
	type PushActionId,
	type PushMailFacts,
	type PushPayload,
	type PushPrefs,
	type PushPrefsPatch,
	type PushSkipReason,
	type ThrottleDecision,
} from "../../shared/push-policy";
import type { PushSubscriptionRecord, PushTarget } from "./push-store";
import type { MailboxCapability } from "./capabilities";

// ── The AuthDO surface ─────────────────────────────────────────────

export interface PushRpc {
	getOrInitMeta(key: string, fallback: string): Promise<string>;
	pushUpsertSubscription(input: {
		userKey: string;
		endpoint: string;
		p256dh: string;
		auth: string;
		userAgent: string | null;
		now: number;
	}): Promise<PushSubscriptionRecord>;
	pushListSubscriptions(userKey: string): Promise<PushSubscriptionRecord[]>;
	pushDeleteSubscription(userKey: string, ref: { id?: string; endpoint?: string }): Promise<boolean>;
	pushReplaceSubscription(input: {
		oldEndpoint: string;
		oldAuth: string;
		endpoint: string;
		p256dh: string;
		auth: string;
		userAgent: string | null;
		now: number;
	}): Promise<PushSubscriptionRecord | null>;
	pushRecordDelivery(
		id: string,
		outcome: { ok: true } | { ok: false; status: number; error: string },
		now: number,
	): Promise<"ok" | "removed" | "failed">;
	pushListTargets(): Promise<PushTarget[]>;
	pushGetPrefs(userKey: string): Promise<PushPrefs>;
	pushUpdatePrefs(userKey: string, patch: PushPrefsPatch, now: number): Promise<PushPrefs>;
	pushClaimSlot(userKey: string, threadKey: string | null, now: number): Promise<ThrottleDecision>;
	pushSpendToken(jti: string, expiresAt: number, now: number): Promise<boolean>;
	pushAccountFlags(userKey: string): Promise<{ isOwner: boolean; disabled: boolean }>;
}

export function pushRpc(env: Env): PushRpc | null {
	const ns = (env as unknown as { AUTH_STORE?: DurableObjectNamespace }).AUTH_STORE;
	if (!ns) return null;
	return ns.get(ns.idFromName("global")) as unknown as PushRpc;
}

// ── VAPID keys ─────────────────────────────────────────────────────

const VAPID_META_KEY = "vapid_keys";

/**
 * The application server key pair.
 *
 * `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` when both are set and well
 * formed. Otherwise a pair is generated once and kept in the AuthDO `meta`
 * table, the same way the unsubscribe secret is: `INSERT OR IGNORE`, so two
 * isolates racing on a fresh deployment agree on whichever landed first.
 * Rotating it (by setting the secrets) invalidates every existing
 * subscription; browsers then resubscribe the next time the app is opened.
 */
export async function getVapidKeys(env: Env, rpc: Pick<PushRpc, "getOrInitMeta"> | null = pushRpc(env)): Promise<P256KeyPair | null> {
	const pub = (env as { VAPID_PUBLIC_KEY?: string }).VAPID_PUBLIC_KEY?.trim();
	const priv = (env as { VAPID_PRIVATE_KEY?: string }).VAPID_PRIVATE_KEY?.trim();
	if (pub && priv) {
		if (isP256PublicKey(pub) && isP256PrivateKey(priv)) return { publicKey: pub, privateKey: priv };
		console.error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not a base64url P-256 key pair; using the generated pair.");
	}
	if (!rpc) return null;
	const fallback = JSON.stringify(await generateP256KeyPair());
	try {
		const stored = JSON.parse(await rpc.getOrInitMeta(VAPID_META_KEY, fallback)) as P256KeyPair;
		return isP256PublicKey(stored.publicKey) && isP256PrivateKey(stored.privateKey) ? stored : null;
	} catch (e) {
		console.error("VAPID keys unreadable:", (e as Error).message);
		return null;
	}
}

/**
 * Contact for push service operators: `VAPID_SUBJECT`, else the deployment's
 * https origin, else `mailto:postmaster@` the first mail domain. Never another
 * deployment's host. The last fallback is a syntactically valid placeholder:
 * subscribing needs a signed-in visit, which records the origin, so it only
 * shows on a deployment that has never been opened over https.
 */
export async function vapidSubject(env: Env): Promise<string> {
	const configured = (env as { VAPID_SUBJECT?: string }).VAPID_SUBJECT?.trim();
	if (configured && /^(mailto:|https:\/\/)/.test(configured)) return configured;
	const origin = await deploymentOrigin(env);
	if (origin?.startsWith("https://")) return origin;
	const domain = getDomains(env)[0];
	return `mailto:postmaster@${domain || "localhost"}`;
}

// ── Sending ────────────────────────────────────────────────────────

/** How long a push service keeps an undelivered message (seconds). */
const MAIL_TTL_SECONDS = 24 * 3600;

export interface PushSendResult {
	status: number;
	ok: boolean;
	error?: string;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Encrypt and POST one payload to one subscription. */
export async function sendPush(
	subscription: Pick<PushSubscriptionRecord, "endpoint" | "p256dh" | "auth">,
	payload: PushPayload,
	keys: P256KeyPair,
	subject: string,
	options: { fetcher?: Fetcher; ttl?: number; urgency?: "high" | "normal" | "low" } = {},
): Promise<PushSendResult> {
	try {
		const { body } = await encryptPushPayload({
			plaintext: new TextEncoder().encode(JSON.stringify(payload)),
			uaPublic: subscription.p256dh,
			authSecret: subscription.auth,
		});
		const res = await (options.fetcher ?? fetch)(subscription.endpoint, {
			method: "POST",
			headers: {
				Authorization: await vapidAuthorization(subscription.endpoint, keys, subject),
				"Content-Encoding": "aes128gcm",
				"Content-Type": "application/octet-stream",
				TTL: String(options.ttl ?? MAIL_TTL_SECONDS),
				Urgency: options.urgency ?? "normal",
			},
			body,
			redirect: "manual",
		});
		if (res.status >= 200 && res.status < 300) return { status: res.status, ok: true };
		const text = await res.text().catch(() => "");
		return { status: res.status, ok: false, error: `${res.status} ${text.slice(0, 120)}`.trim() };
	} catch (e) {
		return { status: 0, ok: false, error: (e as Error).message };
	}
}

/** Send to every device of one user and record each outcome (410/404 remove the device). */
async function deliverToUser(
	rpc: PushRpc,
	target: Pick<PushTarget, "subscriptions">,
	payload: PushPayload,
	keys: P256KeyPair,
	subject: string,
	options: { fetcher?: Fetcher; now: number; urgency?: "high" | "normal" },
): Promise<{ sent: number; removed: number; failed: number }> {
	const tally = { sent: 0, removed: 0, failed: 0 };
	await Promise.all(
		target.subscriptions.map(async (sub) => {
			const result = await sendPush(sub, payload, keys, subject, options);
			const outcome = result.ok
				? ({ ok: true } as const)
				: ({ ok: false, status: result.status, error: result.error ?? "failed" } as const);
			const recorded = await rpc.pushRecordDelivery(sub.id, outcome, options.now).catch(() => "failed" as const);
			if (recorded === "ok") tally.sent += 1;
			else if (recorded === "removed") tally.removed += 1;
			else tally.failed += 1;
		}),
	);
	return tally;
}

// ── Who may be told ────────────────────────────────────────────────

/** The authority a subscribed user holds right now (grants can change after subscribing). */
async function principalFor(env: Env, target: Pick<PushTarget, "userKey" | "isOwner">): Promise<Principal> {
	const passwordMode = resolveAuthMode(env) === "password";
	return resolvePrincipalFor({
		adminEmailsRaw: env.ADMIN_EMAILS,
		bucket: env.BUCKET,
		identity: { kind: "user", id: target.userKey, subject: null },
		forceEnforced: passwordMode,
		extraAdminEmails: passwordMode && target.isOwner ? [target.userKey] : [],
	});
}

async function eligible(
	env: Env,
	target: PushTarget,
	mailboxId: string,
	capabilities: readonly MailboxCapability[],
): Promise<boolean> {
	if (target.disabled || target.subscriptions.length === 0) return false;
	try {
		const principal = await principalFor(env, target);
		return capabilities.some((cap) => canDo(principal, mailboxId, cap));
	} catch {
		return false;
	}
}

/** The zone quiet hours are read in: the push setting, else the assistant's, else UTC. */
async function quietZone(env: Env, target: PushTarget): Promise<string> {
	if (target.prefs.quietHours.timeZone) return target.prefs.quietHours.timeZone;
	try {
		const stub = assistantStub(env, target.userKey);
		if (!stub) return "UTC";
		return (await stub.getPrefs()).brief?.timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

export interface DispatchDeps {
	rpc?: PushRpc | null;
	fetcher?: Fetcher;
	now?: number;
	keys?: P256KeyPair | null;
}

export interface DispatchReport {
	considered: number;
	sent: number;
	removed: number;
	failed: number;
	skipped: Partial<Record<PushSkipReason | "no_access", number>>;
}

function emptyReport(): DispatchReport {
	return { considered: 0, sent: 0, removed: 0, failed: 0, skipped: {} };
}

function skip(report: DispatchReport, reason: PushSkipReason | "no_access") {
	report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
}

/**
 * The shared loop: for each subscribed user who may see `mailboxId`, ask
 * `decide` whether they want this, apply quiet hours and the throttle, build
 * their payload, and send.
 */
async function dispatch(
	env: Env,
	mailboxId: string,
	capabilities: readonly MailboxCapability[],
	threadKey: string | null,
	decide: (prefs: PushPrefs) => PushSkipReason | null,
	build: (prefs: PushPrefs, target: PushTarget) => Promise<PushPayload>,
	deps: DispatchDeps,
	urgency: "high" | "normal" = "normal",
): Promise<DispatchReport> {
	const report = emptyReport();
	try {
		const rpc = deps.rpc === undefined ? pushRpc(env) : deps.rpc;
		if (!rpc) return report;
		const targets = await rpc.pushListTargets();
		if (targets.length === 0) return report;
		const keys = deps.keys === undefined ? await getVapidKeys(env, rpc) : deps.keys;
		if (!keys) return report;
		const subject = await vapidSubject(env);
		const now = deps.now ?? Date.now();

		for (const target of targets) {
			report.considered += 1;
			if (!(await eligible(env, target, mailboxId, capabilities))) {
				skip(report, "no_access");
				continue;
			}
			const reason = decide(target.prefs);
			if (reason) {
				skip(report, reason);
				continue;
			}
			if (target.prefs.quietHours.enabled && inQuietHours(now, target.prefs.quietHours, await quietZone(env, target))) {
				skip(report, "quiet_hours");
				continue;
			}
			const slot = await rpc.pushClaimSlot(target.userKey, threadKey, now);
			if (!slot.allow) {
				skip(report, slot.reason);
				continue;
			}
			const payload = await build(target.prefs, target);
			const tally = await deliverToUser(rpc, target, payload, keys, subject, { fetcher: deps.fetcher, now, urgency });
			report.sent += tally.sent;
			report.removed += tally.removed;
			report.failed += tally.failed;
		}
	} catch (e) {
		console.error("push dispatch failed:", (e as Error).message);
	}
	return report;
}

// ── New mail ───────────────────────────────────────────────────────

/** What the MailboxDO reports about a stored message (`pushFacts`). */
export interface StoredMailFacts {
	id: string;
	threadId: string;
	folder: string;
	read: boolean;
	muted: boolean;
	sender: string;
	senderName: string | null;
	subject: string;
	priority: string | null;
	inConversation: boolean;
}

export interface NewMailInput {
	mailboxId: string;
	/** The address the mail was sent to (an alias resolves to its product). */
	deliveredTo: string;
	facts: StoredMailFacts;
}

export async function notifyNewMail(env: Env, input: NewMailInput, deps: DispatchDeps = {}): Promise<DispatchReport> {
	const mailboxId = input.mailboxId.toLowerCase();
	let productId: string | null = null;
	try {
		productId = resolveProduct(await listProducts(env), input.deliveredTo || mailboxId)?.id ?? null;
	} catch {
		productId = null;
	}
	const facts: PushMailFacts = {
		mailboxId,
		folder: input.facts.folder,
		read: input.facts.read,
		muted: input.facts.muted,
		sender: input.facts.sender,
		priority: input.facts.priority,
		inConversation: input.facts.inConversation,
		productId,
	};
	const now = deps.now ?? Date.now();
	return dispatch(
		env,
		mailboxId,
		["read"],
		`${mailboxId}:${input.facts.threadId}`,
		(prefs) => {
			const d = decideMailPush(prefs, facts);
			return d.send ? null : d.reason;
		},
		async (prefs, target) => {
			// Actions only for someone who may organise the mailbox, which both need.
			const canOrganise = await eligible(env, target, mailboxId, ["organise"]);
			const actions = canOrganise
				? {
						archive: await mintActionToken(env, { mailboxId, emailId: input.facts.id, action: "archive", userKey: target.userKey }, now),
						read: await mintActionToken(env, { mailboxId, emailId: input.facts.id, action: "read", userKey: target.userKey }, now),
					}
				: null;
			return mailPayload({
				mailboxId,
				emailId: input.facts.id,
				threadId: input.facts.threadId,
				senderName: input.facts.senderName,
				sender: input.facts.sender,
				subject: input.facts.subject,
				hideContent: prefs.hideContent,
				actions,
			});
		},
		deps,
		input.facts.priority === "high" ? "high" : "normal",
	);
}

/**
 * The inbound hook, called from `receiveEmail` after the message (and its
 * triage job) is stored. Only Inbox mail can notify, so anything else costs
 * nothing. The mailbox decides whether triage could still move the message;
 * if so it parks the push for its alarm, otherwise the push goes out now.
 * Background and never throws.
 */
export function schedulePushForNewMail(
	env: Env,
	ctx: Pick<ExecutionContext, "waitUntil">,
	stub: {
		preparePush(emailId: string, mailboxId: string, deliveredTo: string, triageQueued: boolean): Promise<StoredMailFacts | null>;
	},
	input: { mailboxId: string; emailId: string; deliveredTo: string; folder: string; triageQueued: boolean },
): boolean {
	if (input.folder !== "inbox") return false;
	ctx.waitUntil(
		(async () => {
			const facts = await stub.preparePush(input.emailId, input.mailboxId, input.deliveredTo, input.triageQueued);
			if (facts) await notifyNewMail(env, { mailboxId: input.mailboxId, deliveredTo: input.deliveredTo, facts });
		})().catch((e) => console.error("push for new mail failed:", (e as Error).message)),
	);
	return true;
}

// ── Pending approval and follow-ups ────────────────────────────────

export async function notifyApproval(
	env: Env,
	input: { mailboxId: string; approvalId: string; subject: string; recipients: number },
	deps: DispatchDeps = {},
): Promise<DispatchReport> {
	const mailboxId = input.mailboxId.toLowerCase();
	return dispatch(
		env,
		mailboxId,
		// Only people who could approve it: approving is sending.
		["sendAs", "sendOnBehalf"],
		null,
		(prefs) => (prefs.approvals ? null : "kind_off"),
		async (prefs) => approvalPayload({ ...input, mailboxId, hideContent: prefs.hideContent }),
		deps,
		"high",
	);
}

export async function notifyFollowups(
	env: Env,
	mailboxId: string,
	fired: { emailId: string; threadId: string; subject: string | null; recipient: string | null }[],
	deps: DispatchDeps = {},
): Promise<DispatchReport[]> {
	const out: DispatchReport[] = [];
	const mailbox = mailboxId.toLowerCase();
	// A burst of reminders is bounded by the per-user limit like everything else.
	for (const item of fired.slice(0, 20)) {
		out.push(
			await dispatch(
				env,
				mailbox,
				["read"],
				`followup:${mailbox}:${item.threadId}`,
				(prefs) => (prefs.followups ? null : "kind_off"),
				async (prefs) => followupPayload({ ...item, mailboxId: mailbox, hideContent: prefs.hideContent }),
				deps,
			),
		);
	}
	return out;
}

/** "Send test notification": every device of the caller, ignoring quiet hours, rate limited. */
export async function sendTestPush(
	env: Env,
	userKey: string,
	deps: DispatchDeps = {},
): Promise<{ devices: number; sent: number; removed: number; failed: number; limited: boolean }> {
	const rpc = deps.rpc === undefined ? pushRpc(env) : deps.rpc;
	const empty = { devices: 0, sent: 0, removed: 0, failed: 0, limited: false };
	if (!rpc) return empty;
	const subscriptions = await rpc.pushListSubscriptions(userKey);
	if (subscriptions.length === 0) return empty;
	const keys = deps.keys === undefined ? await getVapidKeys(env, rpc) : deps.keys;
	if (!keys) return { ...empty, devices: subscriptions.length };
	const now = deps.now ?? Date.now();
	const slot = await rpc.pushClaimSlot(userKey, null, now);
	if (!slot.allow) return { ...empty, devices: subscriptions.length, limited: true };
	const tally = await deliverToUser(rpc, { subscriptions }, testPayload(), keys, await vapidSubject(env), {
		fetcher: deps.fetcher,
		now,
		urgency: "high",
	});
	return { devices: subscriptions.length, ...tally, limited: false };
}

// ── Action tokens ──────────────────────────────────────────────────

/**
 * Notification buttons act without a session: some browsers send no cookie
 * from a service worker. The token is the credential, so it is as narrow as
 * it can be: one message, one action, one user, single use, short-lived.
 * The user's authority is re-checked when it is spent, so revoking a grant
 * also disarms the buttons already on their lock screen.
 */
export const ACTION_TOKEN_TTL_MS = 12 * 3600_000;

export interface ActionTokenPayload {
	v: 1;
	/** Mailbox. */
	m: string;
	/** Email id. */
	e: string;
	a: PushActionId;
	/** User key the token was minted for. */
	u: string;
	jti: string;
	exp: number;
}

async function actionSecret(env: Env): Promise<string> {
	// Derived from the unsubscribe secret with a fixed label, like export links.
	return `push-action:${await getUnsubscribeSecret(env)}`;
}

export async function mintActionToken(
	env: Env,
	input: { mailboxId: string; emailId: string; action: PushActionId; userKey: string },
	now = Date.now(),
	secret?: string,
): Promise<string> {
	const payload: ActionTokenPayload = {
		v: 1,
		m: input.mailboxId.toLowerCase(),
		e: input.emailId,
		a: input.action,
		u: input.userKey.toLowerCase(),
		jti: crypto.randomUUID(),
		exp: now + ACTION_TOKEN_TTL_MS,
	};
	return signLink(payload, secret ?? (await actionSecret(env)));
}

export type ActionOutcome =
	| { ok: true; action: PushActionId; mailboxId: string; emailId: string }
	| { ok: false; status: 400 | 403 | 404 | 409 | 410; error: string };

/** The mailbox side of an action. */
export interface ActionMailbox {
	updateEmail(id: string, patch: { read?: boolean }): Promise<unknown>;
	moveEmail(id: string, folderId: string): Promise<boolean>;
}

export interface ActionDeps {
	rpc?: PushRpc | null;
	secret?: string;
	now?: number;
	mailbox?: (mailboxId: string) => ActionMailbox;
	/** Authority check; defaults to resolving the user's current grant. */
	mayOrganise?: (userKey: string, mailboxId: string) => Promise<boolean>;
}

/**
 * Verify and spend a token, then perform its one action.
 *
 * The order matters: verify the signature and expiry, then re-check the
 * user's authority, then spend the id (so a refused attempt does not burn a
 * token that would work after a grant is restored), then act.
 */
export async function performAction(env: Env, token: string, deps: ActionDeps = {}): Promise<ActionOutcome> {
	const now = deps.now ?? Date.now();
	const payload = await verifyLink<ActionTokenPayload>(token, deps.secret ?? (await actionSecret(env)), now);
	if (!payload || payload.v !== 1 || (payload.a !== "archive" && payload.a !== "read") || !payload.m || !payload.e || !payload.u || !payload.jti) {
		return { ok: false, status: 400, error: "Invalid or expired action link" };
	}
	const rpc = deps.rpc === undefined ? pushRpc(env) : deps.rpc;
	if (!rpc) return { ok: false, status: 410, error: "Notifications are not available" };

	const mayOrganise =
		deps.mayOrganise ??
		(async (userKey: string, mailboxId: string) => {
			const flags = await rpc.pushAccountFlags(userKey);
			if (flags.disabled) return false;
			return canDo(await principalFor(env, { userKey, isOwner: flags.isOwner }), mailboxId, "organise");
		});
	if (!(await mayOrganise(payload.u, payload.m))) {
		return { ok: false, status: 403, error: "You no longer have access to this mailbox" };
	}
	if (!(await rpc.pushSpendToken(payload.jti, payload.exp, now))) {
		return { ok: false, status: 409, error: "This action was already used" };
	}

	const mailbox =
		deps.mailbox?.(payload.m) ??
		(env.MAILBOX.get(env.MAILBOX.idFromName(payload.m)) as unknown as ActionMailbox);
	// Both actions mark the message read; a missing message answers null here.
	const updated = await mailbox.updateEmail(payload.e, { read: true });
	if (!updated) return { ok: false, status: 404, error: "Message not found" };
	if (payload.a === "archive" && !(await mailbox.moveEmail(payload.e, "archive"))) {
		return { ok: false, status: 404, error: "Message could not be archived" };
	}
	return { ok: true, action: payload.a, mailboxId: payload.m, emailId: payload.e };
}
