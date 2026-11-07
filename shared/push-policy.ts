// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * What a Web Push notification may say, and when one may be sent at all.
 *
 * Pure, so the Worker, the settings screen and the tests share one rule set.
 * The transport (encryption, VAPID) is `shared/web-push.ts`; storage is
 * `workers/lib/push-store.ts`; dispatch is `workers/lib/push.ts`.
 *
 * Order of the gates for new mail, cheapest and most definite first:
 *   1. Where the message landed. Only the Inbox notifies, which rules out spam,
 *      the Screener, a muted thread (filed to Archive), a rule that filed it
 *      away, and triage auto-archive (the dispatcher waits for triage when it
 *      could still move the message).
 *   2. The user's switches: new mail on, this mailbox not off, then the mode
 *      (every message, only needs-reply or VIP, or only some products).
 *   3. Quiet hours, in the user's time zone.
 *   4. Coalescing and the per-user rate limit (`decideThrottle`), which need
 *      shared state and so run inside the AuthDO.
 */

import { z } from "zod";
import { Folders } from "./folders";
import { wallTimeIn } from "./daily-brief";
import { isValidTimeZone } from "./ai-settings";

// ── Preferences ────────────────────────────────────────────────────

/** What "new mail" means for a user, or for one mailbox overriding it. */
export const PUSH_MAIL_MODES = ["all", "important", "products"] as const;
export type PushMailMode = (typeof PUSH_MAIL_MODES)[number];

/** A mailbox either follows the user's mode, sets its own, or is silent. */
export const PUSH_MAILBOX_MODES = ["inherit", "all", "important", "off"] as const;
export type PushMailboxMode = (typeof PUSH_MAILBOX_MODES)[number];

export const MAX_VIP_SENDERS = 100;
export const MAX_PUSH_PRODUCTS = 50;
export const MAX_PUSH_MAILBOX_OVERRIDES = 200;

const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24-hour");
const TimeZone = z.string().min(1).max(64).refine(isValidTimeZone, "Unknown time zone");
/** `ada@example.com` or a whole domain, `@example.com`. */
const VipEntry = z
	.string()
	.trim()
	.toLowerCase()
	.max(254)
	.regex(/^([^\s@]+@[^\s@]+\.[^\s@]+|@[^\s@]+\.[^\s@]+)$/, "Use an address or @domain");

export const PushPrefsSchema = z
	.object({
		/** Notify for new mail at all. */
		newMail: z.boolean().default(true),
		/** Notify when an agent or API send waits in Pending approval. */
		approvals: z.boolean().default(true),
		/** Notify when a follow-up reminder comes due. */
		followups: z.boolean().default(true),
		mode: z.enum(PUSH_MAIL_MODES).default("all"),
		/** Product ids for `mode: "products"`. */
		products: z.array(z.string().min(1).max(64)).max(MAX_PUSH_PRODUCTS).default([]),
		/** Per-mailbox overrides, keyed by lowercase address. */
		mailboxes: z
			.record(z.string().min(3).max(254), z.enum(PUSH_MAILBOX_MODES))
			.refine((r) => Object.keys(r).length <= MAX_PUSH_MAILBOX_OVERRIDES, "Too many mailboxes")
			.default({}),
		/** Senders that always count as important. */
		vipSenders: z.array(VipEntry).max(MAX_VIP_SENDERS).default([]),
		/** Say only "New mail in support@": no sender, no subject. */
		hideContent: z.boolean().default(false),
		quietHours: z
			.object({
				enabled: z.boolean().default(false),
				start: LocalTime.default("22:00"),
				end: LocalTime.default("07:00"),
				/** Null: the zone from the user's assistant settings (AssistantDO). */
				timeZone: TimeZone.nullable().default(null),
			})
			.strict()
			.default({}),
	})
	.strict();

export type PushPrefs = z.infer<typeof PushPrefsSchema>;

export const PushPrefsPatchSchema = z
	.object({
		newMail: z.boolean(),
		approvals: z.boolean(),
		followups: z.boolean(),
		mode: z.enum(PUSH_MAIL_MODES),
		products: PushPrefsSchema.shape.products.removeDefault(),
		mailboxes: z.record(z.string().min(3).max(254), z.enum(PUSH_MAILBOX_MODES)),
		vipSenders: PushPrefsSchema.shape.vipSenders.removeDefault(),
		hideContent: z.boolean(),
		quietHours: z
			.object({
				enabled: z.boolean(),
				start: LocalTime,
				end: LocalTime,
				timeZone: TimeZone.nullable(),
			})
			.strict()
			.partial(),
	})
	.strict()
	.partial();

export type PushPrefsPatch = z.infer<typeof PushPrefsPatchSchema>;

export const DEFAULT_PUSH_PREFS: PushPrefs = PushPrefsSchema.parse({});

/** Tolerant read of a stored record: anything unreadable is the default. */
export function normalizePushPrefs(raw: unknown): PushPrefs {
	const parsed = PushPrefsSchema.safeParse(raw ?? {});
	return parsed.success ? parsed.data : structuredClone(DEFAULT_PUSH_PREFS);
}

/**
 * Apply a patch. `mailboxes` merges per key, and `"inherit"` removes the
 * override, so the stored map only ever holds real overrides.
 */
export function mergePushPrefs(current: PushPrefs, patch: PushPrefsPatch): PushPrefs {
	const mailboxes = { ...current.mailboxes };
	for (const [address, mode] of Object.entries(patch.mailboxes ?? {})) {
		const key = address.trim().toLowerCase();
		if (mode === "inherit") delete mailboxes[key];
		else mailboxes[key] = mode;
	}
	return normalizePushPrefs({
		...current,
		...patch,
		vipSenders: patch.vipSenders ? [...new Set(patch.vipSenders)] : current.vipSenders,
		products: patch.products ? [...new Set(patch.products)] : current.products,
		mailboxes,
		quietHours: { ...current.quietHours, ...patch.quietHours },
	});
}

// ── New-mail filtering ─────────────────────────────────────────────

/** The facts about a stored message the decision needs. */
export interface PushMailFacts {
	mailboxId: string;
	folder: string;
	read: boolean;
	muted: boolean;
	sender: string;
	/** `high` when the sender (or a rule) flagged it. */
	priority: string | null;
	/** The thread holds a message this mailbox sent: a reply is probably owed. */
	inConversation: boolean;
	/** The product the message was addressed to, if any. */
	productId: string | null;
}

export type PushSkipReason =
	| "not_inbox"
	| "spam"
	| "screener"
	| "muted"
	| "read"
	| "kind_off"
	| "mailbox_off"
	| "not_important"
	| "other_product"
	| "quiet_hours"
	| "coalesced"
	| "rate_limited";

export type PushDecision = { send: true } | { send: false; reason: PushSkipReason };

function vipMatches(vip: readonly string[], sender: string): boolean {
	const address = sender.trim().toLowerCase();
	const domain = address.includes("@") ? `@${address.split("@").pop()}` : "";
	return vip.some((entry) => entry === address || (entry.startsWith("@") && entry === domain));
}

/** "Needs reply or VIP": the sender is a VIP, flagged it urgent, or you are in the conversation. */
export function isImportantMail(facts: PushMailFacts, prefs: Pick<PushPrefs, "vipSenders">): boolean {
	if (facts.priority === "high") return true;
	if (vipMatches(prefs.vipSenders, facts.sender)) return true;
	return facts.inConversation;
}

/** The mode that applies to a mailbox: its override, else the user's. */
export function effectiveMailMode(prefs: PushPrefs, mailboxId: string): PushMailMode | "off" {
	const override = prefs.mailboxes[mailboxId.trim().toLowerCase()];
	return override && override !== "inherit" ? override : prefs.mode;
}

/** Whether one user should be told about one new message. Quiet hours and throttling are separate. */
export function decideMailPush(prefs: PushPrefs, facts: PushMailFacts): PushDecision {
	// Placement first: it is the record of every decision made at ingest.
	if (facts.folder === Folders.SPAM) return { send: false, reason: "spam" };
	if (facts.folder === Folders.SCREENER) return { send: false, reason: "screener" };
	if (facts.muted) return { send: false, reason: "muted" };
	if (facts.folder !== Folders.INBOX) return { send: false, reason: "not_inbox" };
	// Already read: a rule marked it, or the user read it before triage let it through.
	if (facts.read) return { send: false, reason: "read" };

	if (!prefs.newMail) return { send: false, reason: "kind_off" };
	const mode = effectiveMailMode(prefs, facts.mailboxId);
	if (mode === "off") return { send: false, reason: "mailbox_off" };
	if (mode === "important" && !isImportantMail(facts, prefs)) return { send: false, reason: "not_important" };
	if (mode === "products" && !(facts.productId && prefs.products.includes(facts.productId))) {
		return { send: false, reason: "other_product" };
	}
	return { send: true };
}

// ── Quiet hours ────────────────────────────────────────────────────

function minutes(time: string): number {
	const [h, m] = time.split(":").map(Number);
	return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Whether `now` falls in the quiet window, read on the wall clock of
 * `timeZone`. A window may cross midnight (22:00 to 07:00). Wall-clock
 * arithmetic is what keeps it right across DST: "22:00" is 22:00 local on
 * both sides of a change, whatever the UTC offset did. A window whose start
 * equals its end is empty.
 */
export function inQuietHours(
	now: number,
	quiet: { enabled: boolean; start: string; end: string },
	timeZone: string,
): boolean {
	if (!quiet.enabled) return false;
	const start = minutes(quiet.start);
	const end = minutes(quiet.end);
	if (start === end) return false;
	let zone = timeZone;
	if (!isValidTimeZone(zone)) zone = "UTC";
	const wall = wallTimeIn(now, zone);
	const at = wall.hour * 60 + wall.minute;
	return start < end ? at >= start && at < end : at >= start || at < end;
}

// ── Coalescing and rate limiting ───────────────────────────────────

/** One push per thread per this long, per user. */
export const THREAD_COALESCE_MS = 60_000;
/** At most this many pushes per user per window. */
export const USER_PUSH_LIMIT = 20;
export const USER_PUSH_WINDOW_MS = 10 * 60_000;

export interface ThrottleState {
	/** Last push for this thread to this user, epoch ms, or null. */
	threadLastAt: number | null;
	/** Current per-user window. */
	windowStart: number | null;
	windowCount: number;
}

export type ThrottleDecision =
	| { allow: true; windowStart: number; windowCount: number }
	| { allow: false; reason: "coalesced" | "rate_limited" };

/**
 * Pure throttle step. The AuthDO reads the state, calls this and writes the
 * result in one synchronous transaction, so two deliveries cannot both pass.
 * `threadKey` null (approvals, tests) skips coalescing.
 */
export function decideThrottle(
	state: ThrottleState,
	now: number,
	options: { coalesce: boolean; limit?: number; windowMs?: number; coalesceMs?: number } = { coalesce: true },
): ThrottleDecision {
	const limit = options.limit ?? USER_PUSH_LIMIT;
	const windowMs = options.windowMs ?? USER_PUSH_WINDOW_MS;
	const coalesceMs = options.coalesceMs ?? THREAD_COALESCE_MS;
	if (options.coalesce && state.threadLastAt !== null && now - state.threadLastAt < coalesceMs) {
		return { allow: false, reason: "coalesced" };
	}
	const fresh = state.windowStart === null || now - state.windowStart >= windowMs;
	const windowStart = fresh ? now : state.windowStart!;
	const count = fresh ? 0 : state.windowCount;
	if (count >= limit) return { allow: false, reason: "rate_limited" };
	return { allow: true, windowStart, windowCount: count + 1 };
}

// ── Payload ────────────────────────────────────────────────────────

export type PushKind = "mail" | "approval" | "followup" | "test";
export type PushActionId = "archive" | "read";

/** What the service worker receives (inside the encrypted body). */
export interface PushPayload {
	v: 1;
	kind: PushKind;
	title: string;
	body: string;
	/** Notifications with the same tag replace each other on the device. */
	tag: string;
	/** Same-origin path opened on click. */
	url: string;
	/** Present for new mail only. Each carries its own single-use token. */
	actions?: { action: PushActionId; title: string; token: string }[];
}

const TITLE_MAX = 80;
const BODY_MAX = 160;

function clip(value: string, max: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `/mail/<mailbox>/<folder>?m=<id>`: the reader's deep link. */
export function messageDeepLink(mailboxId: string, emailId: string, folder: string = Folders.INBOX): string {
	return `/mail/${encodeURIComponent(mailboxId)}/${encodeURIComponent(folder)}?m=${encodeURIComponent(emailId)}`;
}

/**
 * The new-mail notification. Sender name and subject by default; with
 * `hideContent`, only which mailbox has mail. The tag is per thread, so a
 * second reply replaces the first notification instead of stacking.
 */
export function mailPayload(input: {
	mailboxId: string;
	emailId: string;
	threadId: string;
	senderName: string | null;
	sender: string;
	subject: string;
	hideContent: boolean;
	actions?: { archive: string; read: string } | null;
}): PushPayload {
	const tag = `mail:${input.mailboxId}:${input.threadId}`;
	const url = messageDeepLink(input.mailboxId, input.emailId);
	const actions = input.actions
		? [
				{ action: "archive" as const, title: "Archive", token: input.actions.archive },
				{ action: "read" as const, title: "Mark read", token: input.actions.read },
			]
		: undefined;
	if (input.hideContent) {
		return { v: 1, kind: "mail", title: clip(`New mail in ${input.mailboxId}`, TITLE_MAX), body: "", tag, url, ...(actions ? { actions } : {}) };
	}
	return {
		v: 1,
		kind: "mail",
		title: clip(input.senderName || input.sender || "New mail", TITLE_MAX),
		body: clip(input.subject || "(no subject)", BODY_MAX),
		tag,
		url,
		...(actions ? { actions } : {}),
	};
}

export function approvalPayload(input: {
	mailboxId: string;
	approvalId: string;
	subject: string;
	recipients: number;
	hideContent: boolean;
}): PushPayload {
	const who = input.recipients === 1 ? "1 recipient" : `${input.recipients} recipients`;
	return {
		v: 1,
		kind: "approval",
		title: clip(`Waiting for approval in ${input.mailboxId}`, TITLE_MAX),
		body: input.hideContent ? "An agent send needs your decision." : clip(`${input.subject || "(no subject)"} · ${who}`, BODY_MAX),
		tag: `approval:${input.mailboxId}:${input.approvalId}`,
		url: `/mail/${encodeURIComponent(input.mailboxId)}/approvals?id=${encodeURIComponent(input.approvalId)}`,
	};
}

export function followupPayload(input: {
	mailboxId: string;
	emailId: string;
	threadId: string;
	subject: string | null;
	recipient: string | null;
	hideContent: boolean;
}): PushPayload {
	return {
		v: 1,
		kind: "followup",
		title: clip(input.hideContent ? `Follow-up due in ${input.mailboxId}` : `No reply yet${input.recipient ? ` from ${input.recipient}` : ""}`, TITLE_MAX),
		body: input.hideContent ? "" : clip(input.subject || "(no subject)", BODY_MAX),
		tag: `followup:${input.mailboxId}:${input.threadId}`,
		url: messageDeepLink(input.mailboxId, input.emailId),
	};
}

/**
 * Where a notification click may go: a same-origin path, else `/`. The
 * service worker carries a copy (`public/sw.js`); the SW test checks both.
 */
export function safeNotificationUrl(raw: unknown, origin: string): string {
	if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return "/";
	try {
		const url = new URL(raw, origin);
		return url.origin === origin ? url.pathname + url.search + url.hash : "/";
	} catch {
		return "/";
	}
}

export function testPayload(): PushPayload {
	return {
		v: 1,
		kind: "test",
		title: "Notifications are working",
		body: "This is how new mail will appear on this device.",
		tag: "test",
		url: "/settings/notifications",
	};
}

// ── Subscriptions ──────────────────────────────────────────────────

/**
 * Push services a subscription may point at. The Worker POSTs to the
 * endpoint, so an arbitrary URL would make it a request relay; every browser
 * that ships Web Push uses one of these.
 */
export const PUSH_SERVICE_HOSTS = [
	"fcm.googleapis.com", // Chrome, Edge on Android, Samsung Internet, Opera, Brave
	"updates.push.services.mozilla.com", // Firefox
	"web.push.apple.com", // Safari, and iOS home-screen apps
	"notify.windows.com", // Edge on Windows (wns2-*.notify.windows.com)
	"push.apple.com",
];

/** Whether `endpoint` is an https URL on a known push service. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
	if (endpoint.length > 2048) return false;
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.username || url.password) return false;
	const host = url.hostname.toLowerCase();
	return PUSH_SERVICE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** A short device label from a user agent, for the device list. */
export function deviceLabel(userAgent: string | null | undefined): string {
	const ua = userAgent ?? "";
	const os = /iPhone|iPad|iPod/.test(ua)
		? /iPad/.test(ua) ? "iPad" : "iPhone"
		: /Android/.test(ua)
			? "Android"
			: /Mac OS X|Macintosh/.test(ua)
				? "Mac"
				: /Windows/.test(ua)
					? "Windows"
					: /Linux|CrOS/.test(ua)
						? "Linux"
						: "Device";
	const browser = /Edg\//.test(ua)
		? "Edge"
		: /Firefox\//.test(ua)
			? "Firefox"
			: /Chrome\//.test(ua) || /CriOS\//.test(ua)
				? "Chrome"
				: /Safari\//.test(ua)
					? "Safari"
					: "Browser";
	return `${browser} on ${os}`;
}
