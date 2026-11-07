// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Vacation auto-responder.
 *
 * The settings shape has existed since the project started but nothing ever
 * read it, so the switch in the UI did nothing. The hard part of an auto-
 * responder is not sending the mail — it is knowing when *not* to, because a
 * responder that answers indiscriminately answers mailing lists, bounces, and
 * other people's responders, and two of those produce a mail loop.
 *
 * That decision is pure and lives here so every rule below is testable without
 * a mailbox or an outbound binding. The one stateful part, "have we already
 * replied to this person recently", stays in the Durable Object.
 */

export interface AutoReplySettings {
	enabled?: boolean;
	subject?: string;
	message?: string;
	/** ISO date; before this the responder stays quiet. */
	startsAt?: string | null;
	/** ISO date; after this the responder stays quiet. */
	endsAt?: string | null;
	/** When true, only correspondents who have written before get a reply. */
	knownSendersOnly?: boolean;
}

export interface AutoReplyContext {
	settings: AutoReplySettings | undefined;
	/** The mailbox that received the message. */
	mailboxId: string;
	/** Envelope sender of the inbound message. */
	sender: string;
	/** Header keys present on the inbound message, in any case. */
	headerKeys: string[];
	/** Header lookup for the few values we inspect, case-insensitive. */
	header: (key: string) => string | undefined;
	/** Every address this deployment serves, to avoid answering ourselves. */
	localMailboxes: string[];
	now?: Date;
}

export type AutoReplySkipReason =
	| "disabled"
	| "no_message"
	| "outside_window"
	| "no_sender"
	| "self"
	| "local_mailbox"
	| "automated"
	| "bulk"
	| "mailing_list"
	| "no_reply_address";

export interface AutoReplyDecision {
	/** Address to answer, when a reply should go out. */
	target?: string;
	skip?: AutoReplySkipReason;
	/** Subject for the outgoing notice, derived from the inbound subject. */
	subject?: string;
}

/**
 * Headers that mark a message as machine-generated.
 *
 * `Auto-Submitted` (RFC 3834) is the standard signal; the `X-Auto*` family and
 * `Precedence` cover the large amount of real mail that predates it.
 */
/**
 * Headers whose mere presence marks a message as machine-generated.
 *
 * `Auto-Submitted` is deliberately absent: it is checked by value above,
 * because `auto-submitted: no` is the standard way to say "a person sent this"
 * and treating the key as a flag would reject exactly the mail it certifies.
 */
const AUTOMATED_HEADERS = [
	"x-auto-response-suppress",
	"x-autoreply",
	"x-autorespond",
	"x-autoresponder",
];

const LIST_HEADERS = [
	"list-id",
	"list-unsubscribe",
	"list-post",
	"list-help",
	"mailing-list",
];

const BULK_PRECEDENCE = new Set(["bulk", "list", "junk", "auto_reply"]);

/**
 * Why a message looks machine-generated, from its headers alone, or null.
 *
 * Shared by the vacation responder and the agent's auto-draft gate, so "this is
 * a robot" means the same thing to both.
 *
 * - `Auto-Submitted` other than `no` (RFC 3834) or an `X-Auto*` flag: automated.
 * - `Precedence: bulk | list | junk | auto_reply`: bulk.
 * - `List-Id`, `List-Unsubscribe` and friends: mailing list.
 */
export function automatedMailReason(
	headerKeys: string[],
	header: (key: string) => string | undefined,
	options: { ignoreSuppressHeader?: boolean } = {},
): "automated" | "bulk" | "mailing_list" | null {
	const keys = new Set(headerKeys.map((key) => key.toLowerCase()));

	const autoSubmitted = header("auto-submitted");
	if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== "no") {
		return "automated";
	}
	// `X-Auto-Response-Suppress` is also set by Outlook on ordinary human mail
	// (it only asks responders to stay quiet), so the auto-draft gate ignores it.
	const automatedHeaders = options.ignoreSuppressHeader
		? AUTOMATED_HEADERS.filter((key) => key !== "x-auto-response-suppress")
		: AUTOMATED_HEADERS;
	if (automatedHeaders.some((key) => keys.has(key))) return "automated";

	const precedence = header("precedence");
	if (precedence && BULK_PRECEDENCE.has(precedence.trim().toLowerCase())) {
		return "bulk";
	}

	if (LIST_HEADERS.some((key) => keys.has(key))) return "mailing_list";
	return null;
}

function normalise(address: string): string {
	return address.trim().toLowerCase();
}

/** Extract a bare address from `Name <addr>` or a raw address. */
function addressOf(value: string): string {
	const angled = value.match(/<([^>]+)>/);
	return normalise(angled ? angled[1] : value);
}

function withinWindow(settings: AutoReplySettings, now: Date): boolean {
	if (settings.startsAt) {
		const start = Date.parse(settings.startsAt);
		if (Number.isFinite(start) && now.getTime() < start) return false;
	}
	if (settings.endsAt) {
		const end = Date.parse(settings.endsAt);
		if (Number.isFinite(end) && now.getTime() > end) return false;
	}
	return true;
}

/**
 * Prefix the inbound subject the way mail clients expect, without stacking
 * prefixes on a thread that has already been round-tripped.
 */
export function autoReplySubject(
	configured: string | undefined,
	inboundSubject: string | undefined,
): string {
	const trimmed = (configured ?? "").trim();
	if (trimmed) return trimmed;

	const subject = (inboundSubject ?? "").trim();
	if (!subject) return "Automatic reply";
	return /^(re|auto(matic)? reply)\s*:/i.test(subject)
		? subject
		: `Automatic reply: ${subject}`;
}

/**
 * Decide whether to auto-reply, and to whom.
 *
 * Returns a `skip` reason rather than a bare false so the Worker can log why a
 * message went unanswered — "the responder is on but nobody got a reply" is
 * otherwise impossible to debug.
 */
export function decideAutoReply(ctx: AutoReplyContext): AutoReplyDecision {
	const settings = ctx.settings;
	if (!settings?.enabled) return { skip: "disabled" };
	if (!(settings.message ?? "").trim()) return { skip: "no_message" };

	const now = ctx.now ?? new Date();
	if (!withinWindow(settings, now)) return { skip: "outside_window" };

	const sender = normalise(ctx.sender);
	if (!sender) return { skip: "no_sender" };

	const mailbox = normalise(ctx.mailboxId);
	if (sender === mailbox) return { skip: "self" };

	// Never answer another mailbox on this deployment: both sides would be
	// running a responder and the two would talk to each other forever.
	if (ctx.localMailboxes.some((address) => normalise(address) === sender)) {
		return { skip: "local_mailbox" };
	}

	// RFC 3834 `Auto-Submitted`, `Precedence: bulk`, list headers.
	const automated = automatedMailReason(ctx.headerKeys, ctx.header);
	if (automated) return { skip: automated };

	// A null return-path is a bounce. Answering it goes nowhere useful and can
	// pile up at the receiving MTA.
	const returnPath = ctx.header("return-path");
	if (returnPath && returnPath.trim() === "<>") {
		return { skip: "no_reply_address" };
	}

	// `Reply-To` wins when present: it is the address the sender nominated.
	const replyTo = ctx.header("reply-to");
	const target = replyTo ? addressOf(replyTo) : sender;
	if (!target || target === mailbox) return { skip: "no_reply_address" };

	return {
		target,
		subject: autoReplySubject(settings.subject, ctx.header("subject")),
	};
}
