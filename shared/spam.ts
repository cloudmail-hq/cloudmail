// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Heuristic spam scoring for inbound mail.
 *
 * Until this existed, the only thing that could put a message in Spam was an
 * explicit block rule, so the Spam folder stayed empty and every piece of
 * junk landed in the inbox. Meanwhile SPF/DKIM/DMARC verdicts were already
 * being parsed and shown to the reader (`shared/auth-results.ts`) without ever
 * influencing where the message went — the strongest available signal, unused.
 *
 * Design constraints, in priority order:
 *
 *   1. A false positive costs far more than a false negative. Mail filed to
 *      Spam is mail the user may never look for. The threshold is therefore set
 *      so that no single soft signal can reach it: junk has to look wrong in
 *      several independent ways at once.
 *   2. Verdicts must be explainable. Every point carries a reason string, which
 *      is stored on the row and shown in the UI. "Filed as spam" with no stated
 *      cause is indistinguishable from a bug.
 *   3. No network calls and no model inference. This runs inline on the inbound
 *      path, where latency is delivery latency, and it must behave identically
 *      in tests.
 *
 * Deliberately NOT scored here: content-only signals that legitimate business
 * mail trips constantly — the word "invoice", currency amounts, urgency, an
 * unsubscribe link, or a bulk-mail header. Marketing a user opted into is not
 * spam, and scoring it as such is how a filter loses the user's trust.
 */

import type { AuthenticationResults } from "./auth-results";

/** A single reason a message gained points, for display and debugging. */
export interface SpamSignal {
	/** Stable identifier, so the UI can special-case a signal if it needs to. */
	id: string;
	/** Points contributed. Always positive; ham signals are applied as caps. */
	weight: number;
	/** One-line explanation written for the mailbox owner, not the operator. */
	label: string;
}

export interface SpamVerdict {
	score: number;
	/** True when `score` reaches `SPAM_SCORE_THRESHOLD`. */
	isSpam: boolean;
	signals: SpamSignal[];
}

/**
 * Points at which a message is filed to Spam.
 *
 * Calibrated so that authentication failure alone is enough (a domain's own
 * DMARC policy saying "this is forged" is as strong as a signal gets), but no
 * combination of soft content signals is. See the weights below.
 */
export const SPAM_SCORE_THRESHOLD = 5;

export interface SpamInput {
	/** Envelope/header From address, lowercased. */
	from: string;
	/** The From header's display name, if any. */
	fromName?: string | null;
	/** Reply-To address, if the message carries one. */
	replyTo?: string | null;
	subject?: string | null;
	/** Plain-text body if available, otherwise HTML. */
	body?: string | null;
	/** Parsed authentication verdicts, or null when none were recorded. */
	auth?: AuthenticationResults | null;
	/** Filenames of non-inline attachments. */
	attachmentNames?: string[];
	/**
	 * Whether this message threads onto a conversation the mailbox already has.
	 *
	 * A strong ham signal: the user has been corresponding here. Spammers do not
	 * generally know our internal thread ids.
	 */
	inKnownThread?: boolean;
	/** Whether the mailbox has previously sent mail to this address. */
	isKnownCorrespondent?: boolean;
}

/** Domain part of an address, lowercased. Empty string when there isn't one. */
function domainOf(address: string): string {
	const at = address.lastIndexOf("@");
	return at === -1 ? "" : address.slice(at + 1).trim().toLowerCase();
}

/**
 * Registrable-ish suffix: the last two labels of a domain.
 *
 * Not a public-suffix-list lookup, which would mean shipping and updating the
 * list for a comparison that only needs to answer "are these plausibly the same
 * organisation". It over-groups under multi-label suffixes (`a.co.uk` and
 * `b.co.uk` look related), and that error is in the safe direction: it suppresses
 * points rather than inventing them.
 */
function baseDomain(domain: string): string {
	const labels = domain.split(".").filter(Boolean);
	return labels.length <= 2 ? domain : labels.slice(-2).join(".");
}

function relatedDomains(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	return baseDomain(a) === baseDomain(b);
}

/** Extensions that execute, or that can carry a macro payload. */
const DANGEROUS_EXTENSIONS = new Set([
	"ade", "adp", "apk", "app", "appx", "bat", "cab", "chm", "cmd", "com", "cpl",
	"dll", "dmg", "docm", "exe", "hta", "iso", "img", "jar", "js", "jse", "lnk",
	"msc", "msi", "msix", "msp", "mst", "pif", "pptm", "ps1", "reg", "scr",
	"sct", "shb", "sys", "vb", "vbe", "vbs", "vhd", "vxd", "wsc", "wsf", "wsh",
	"xlam", "xlsm", "xltm",
]);

/**
 * Whether the filename's effective extension is executable.
 *
 * Only the final extension is checked, because that is what decides how the
 * file opens — which also covers the `invoice.pdf.exe` disguise, where the
 * benign-looking extension is not the last one.
 */
function isDangerousAttachment(filename: string): boolean {
	const parts = filename.trim().toLowerCase().split(".");
	if (parts.length < 2) return false;
	return DANGEROUS_EXTENSIONS.has(parts[parts.length - 1]);
}

/**
 * An email address embedded in a display name, as in
 * `"billing@yourbank.com" <attacker@evil.test>`.
 *
 * This is the classic display-name spoof: mail clients show the name, so the
 * reader sees a plausible address that has nothing to do with who sent it.
 */
const ADDRESS_IN_NAME = /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/;

export function classifySpam(input: SpamInput): SpamVerdict {
	const signals: SpamSignal[] = [];
	const add = (id: string, weight: number, label: string) =>
		signals.push({ id, weight, label });

	const from = (input.from || "").trim().toLowerCase();
	const fromDomain = domainOf(from);
	const auth = input.auth ?? null;

	// ── Authentication ────────────────────────────────────────────────
	// The only signals strong enough to file a message on their own. A domain
	// publishing DMARC is asserting that unauthenticated mail claiming to be
	// from it is forged; taking it at its word is the whole point of the policy.
	if (auth?.dmarc === "fail") {
		add(
			"dmarc-fail",
			SPAM_SCORE_THRESHOLD,
			"The sending domain's DMARC policy says this message is not authentic.",
		);
	} else if (auth?.spf === "fail" && auth?.dkim === "fail") {
		add(
			"spf-dkim-fail",
			SPAM_SCORE_THRESHOLD,
			"Both SPF and DKIM failed, so the sender could not be authenticated.",
		);
	} else if (auth?.spf === "fail") {
		// On its own this is unreliable: it is what a plain forwarded message
		// looks like, and forwarding is common and legitimate.
		add("spf-fail", 1.5, "SPF failed for the sending server.");
	} else if (auth?.spf === "softfail") {
		add("spf-softfail", 1, "The sending domain lists this server as unauthorised.");
	}

	// ── Identity mismatches ───────────────────────────────────────────
	const nameMatch = input.fromName
		? ADDRESS_IN_NAME.exec(input.fromName)
		: null;
	if (nameMatch && !relatedDomains(nameMatch[1].toLowerCase(), fromDomain)) {
		add(
			"display-name-spoof",
			3,
			`The sender's name shows ${nameMatch[0]} but the message was sent from ${from || "an unrelated address"}.`,
		);
	}

	const replyToDomain = input.replyTo ? domainOf(input.replyTo) : "";
	if (replyToDomain && !relatedDomains(replyToDomain, fromDomain)) {
		// Legitimate on its own — mailing lists and helpdesks do it constantly —
		// so it is priced to matter only alongside something else.
		add(
			"reply-to-mismatch",
			1.5,
			`Replies would go to ${replyToDomain} rather than ${fromDomain}.`,
		);
	}

	// ── Attachments ───────────────────────────────────────────────────
	const dangerous = (input.attachmentNames ?? []).filter(isDangerousAttachment);
	if (dangerous.length > 0) {
		add(
			"dangerous-attachment",
			3,
			`Carries an executable attachment (${dangerous.join(", ")}).`,
		);
	}

	// ── Shape of the message ──────────────────────────────────────────
	const subject = (input.subject ?? "").trim();
	const letters = subject.replace(/[^a-z]/gi, "");
	if (
		letters.length >= 12 &&
		letters === letters.toUpperCase() &&
		// An all-caps subject is a weak signal on its own, and short ones are
		// often legitimate acronyms or ticket ids.
		subject.length >= 15
	) {
		add("shouting-subject", 1, "The subject is written entirely in capitals.");
	}

	const body = input.body ?? "";
	if (body.length > 0) {
		const links = body.match(/https?:\/\//gi)?.length ?? 0;
		const words = body.replace(/<[^>]*>/g, " ").trim().split(/\s+/).length;
		// Many links and almost no prose. Real mail that is mostly links is
		// usually a newsletter, which is why this needs the link count to be
		// high *and* the text to be nearly absent.
		if (links >= 5 && words < links * 3) {
			add("link-heavy", 1.5, "Almost the entire message is links.");
		}
	}

	let score = signals.reduce((sum, s) => sum + s.weight, 0);

	// ── Ham overrides ─────────────────────────────────────────────────
	// Applied as caps rather than negative points, so they can hold a message
	// out of Spam without being able to drag a clearly-forged one below zero
	// and lose the reasons along with it.
	//
	// Both are about established relationships, and the risk they carry is
	// bounded: an attacker would already need to be in the user's thread or
	// address book, at which point heuristic filtering is not what saves them.
	// Authentication failure is exempt — that is precisely the case where a
	// familiar-looking sender is the danger.
	const authFailed =
		auth?.dmarc === "fail" || (auth?.spf === "fail" && auth?.dkim === "fail");
	if (!authFailed && (input.inKnownThread || input.isKnownCorrespondent)) {
		score = Math.min(score, SPAM_SCORE_THRESHOLD - 1);
		add(
			input.inKnownThread ? "known-thread" : "known-correspondent",
			0,
			input.inKnownThread
				? "Part of a conversation already in this mailbox."
				: "You have written to this sender before.",
		);
	}

	return { score, isSpam: score >= SPAM_SCORE_THRESHOLD, signals };
}

/** Compact form for storing on the row: the signal ids and labels that fired. */
export function serializeSpamSignals(signals: SpamSignal[]): string | null {
	const scored = signals.filter((s) => s.weight > 0);
	if (scored.length === 0) return null;
	return JSON.stringify(scored.map(({ id, label }) => ({ id, label })));
}

/** Read back what `serializeSpamSignals` wrote. Tolerates anything else. */
export function parseSpamSignals(
	stored: string | null | undefined,
): { id: string; label: string }[] {
	if (!stored) return [];
	try {
		const parsed = JSON.parse(stored);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(s): s is { id: string; label: string } =>
				!!s && typeof s.id === "string" && typeof s.label === "string",
		);
	} catch {
		return [];
	}
}
