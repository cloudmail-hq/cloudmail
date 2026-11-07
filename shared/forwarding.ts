// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox forwarding: re-send every inbound message to another address.
 *
 * Why not a Cloudflare Email Routing forwarding rule instead? Because Email
 * Routing relays forwarded mail from a shared IP pool that Outlook, Hotmail and
 * Live blocklist, so a forward to a Microsoft-hosted mailbox comes back as
 * `550 5.7.1 ... part of their network is on our block list (S3150)`. That IP
 * belongs to Cloudflare, not to the operator, so there is no delisting path.
 * Sending the copy ourselves goes out over the configured provider's IPs and is
 * DKIM-signed for our own domain, so it authenticates cleanly.
 *
 * The copy deliberately does *not* preserve the original `From`. Sending as
 * `jane@example.com` from our infrastructure would fail that domain's SPF and
 * DMARC and be filtered harder than the block we are avoiding. Instead the copy
 * is from the mailbox address with the original sender named in the display
 * name, `Reply-To` points at the original sender, and the original envelope
 * details are restated in a header block at the top of the body.
 *
 * Everything here is pure so the loop rules and the size arithmetic can be
 * tested without a Worker; the dispatch lives in workers/lib/forwarding.ts.
 */

import type { AuthenticationResults } from "./auth-results";
import { ATTACHMENT_BUDGET_BYTES, base64EncodedSize, formatBytesShort, utf8Size } from "./limits";

/**
 * Marks a message this deployment has already forwarded.
 *
 * Present on the copy we send, and checked on inbound: if two mailboxes are
 * configured to forward to each other, the second hop sees this and stops.
 */
export const FORWARDED_HEADER = "X-Tapetide-Forwarded-For";

export interface ForwardingSettings {
	enabled?: boolean;
	email?: string;
}

/**
 * The reason a forward was not attempted. `null` means go ahead.
 *
 * A string rather than a boolean because every one of these is worth logging:
 * silent non-delivery is the hardest kind of mail bug to diagnose.
 */
export type ForwardSkipReason =
	| "disabled"
	| "no-target"
	| "invalid-target"
	| "loop-self"
	| "loop-local-mailbox"
	| "loop-already-forwarded";

/**
 * Deliberately permissive: a target address is operator-entered configuration,
 * not untrusted input, and rejecting an unusual but valid address would break
 * forwarding with no way for the operator to tell why.
 */
const ADDRESS_SHAPE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export function normalizeAddress(value: string | undefined | null): string {
	return (value ?? "").trim().toLowerCase();
}

export interface ForwardDecision {
	/** Normalised destination, present only when `skip` is null. */
	target?: string;
	skip: ForwardSkipReason | null;
}

/**
 * Decide whether to forward, and to where.
 *
 * Loops are prevented three ways, matching the three ways they happen in
 * practice: a mailbox pointed at itself, two mailboxes on this deployment
 * pointed at each other, and a message we have already forwarded once coming
 * back around. The third is the only one that catches loops through an external
 * hop, which is why the header travels with the copy.
 */
export function decideForward(options: {
	settings: ForwardingSettings | undefined;
	/** Address of the mailbox that received the message. */
	mailboxId: string;
	/** Every mailbox address on this deployment. */
	localMailboxes: readonly string[];
	/** Header keys present on the inbound message, in any case. */
	inboundHeaderKeys: readonly string[];
}): ForwardDecision {
	const { settings, mailboxId, localMailboxes, inboundHeaderKeys } = options;

	if (!settings?.enabled) return { skip: "disabled" };

	const target = normalizeAddress(settings.email);
	if (!target) return { skip: "no-target" };
	if (!ADDRESS_SHAPE.test(target)) return { skip: "invalid-target" };

	const alreadyForwarded = inboundHeaderKeys.some(
		(key) => key.toLowerCase() === FORWARDED_HEADER.toLowerCase(),
	);
	if (alreadyForwarded) return { skip: "loop-already-forwarded" };

	if (target === normalizeAddress(mailboxId)) return { skip: "loop-self" };

	const isLocal = localMailboxes.some((address) => normalizeAddress(address) === target);
	if (isLocal) return { skip: "loop-local-mailbox" };

	return { target, skip: null };
}

// ── Presentation ───────────────────────────────────────────────────

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Strip characters that would let a display name break out of the header.
 *
 * The name is attacker-controlled — anyone can put anything in `From` — and it
 * is interpolated into an address field. Quotes, angle brackets, commas and
 * newlines all change how the header parses.
 */
function sanitizeDisplayName(value: string): string {
	return value
		.replace(/[\r\n]+/g, " ")
		.replace(/["<>,;:\\]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Longest display name we will emit, to stay well inside header line limits. */
const MAX_DISPLAY_NAME = 120;

/**
 * `"Jane Customer (via Acme Support)"`.
 *
 * Naming the original sender in the display name is what makes a forwarded
 * inbox readable: the `From` column shows who actually wrote, even though the
 * address has to be ours for authentication to pass.
 */
export function buildForwardDisplayName(options: {
	originalName?: string | null;
	originalAddress?: string | null;
	mailboxName?: string | null;
}): string {
	const who = sanitizeDisplayName(
		options.originalName?.trim() || options.originalAddress?.trim() || "Unknown sender",
	);
	const via = sanitizeDisplayName(options.mailboxName?.trim() || "");
	const composed = via ? `${who} (via ${via})` : who;
	return composed.length > MAX_DISPLAY_NAME
		? `${composed.slice(0, MAX_DISPLAY_NAME - 1)}…`
		: composed;
}

export interface ForwardHeaderBlockInput {
	from?: string | null;
	date?: string | null;
	subject?: string | null;
	to?: string | null;
	cc?: string | null;
	auth?: AuthenticationResults | null;
	/** Filenames too large to attach, named so the recipient knows they existed. */
	omittedAttachments?: readonly string[];
}

function authSummary(auth: AuthenticationResults | null | undefined): string | null {
	if (!auth) return null;
	const parts: string[] = [];
	if (auth.spf) parts.push(`SPF ${auth.spf}`);
	if (auth.dkim) parts.push(`DKIM ${auth.dkim}`);
	if (auth.dmarc) parts.push(`DMARC ${auth.dmarc}`);
	if (parts.length === 0) return null;
	return auth.viaArc ? `${parts.join(" · ")} (via ARC)` : parts.join(" · ");
}

/**
 * Restate the original envelope at the top of the forwarded body.
 *
 * The copy's own headers describe our re-send, so without this the recipient
 * cannot see who the message was really from, when it arrived, or whether it
 * authenticated. Rendered as a table so it survives the HTML-only clients that
 * collapse whitespace.
 */
export function buildForwardHeaderBlock(input: ForwardHeaderBlockInput): {
	html: string;
	text: string;
} {
	const rows: [string, string][] = [];
	if (input.from) rows.push(["From", input.from]);
	if (input.date) rows.push(["Date", input.date]);
	if (input.subject) rows.push(["Subject", input.subject]);
	if (input.to) rows.push(["To", input.to]);
	if (input.cc) rows.push(["Cc", input.cc]);

	const auth = authSummary(input.auth);
	if (auth) rows.push(["Authentication", auth]);

	const omitted = input.omittedAttachments ?? [];
	if (omitted.length > 0) {
		rows.push([
			"Attachments omitted",
			`${omitted.join(", ")} — too large to include in the forwarded copy`,
		]);
	}

	const htmlRows = rows
		.map(
			([key, value]) =>
				`<tr><td style="padding:2px 8px 2px 0;color:#666;white-space:nowrap;vertical-align:top;">${escapeHtml(key)}</td>` +
				`<td style="padding:2px 0;color:#222;">${escapeHtml(value)}</td></tr>`,
		)
		.join("");

	const html =
		`<div style="margin:0 0 1em 0;padding:0 0 0.75em 0;border-bottom:1px solid #ddd;font-size:13px;` +
		`font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">` +
		`<table style="border-collapse:collapse;">${htmlRows}</table></div>`;

	const text = `${rows.map(([key, value]) => `${key}: ${value}`).join("\n")}\n${"-".repeat(40)}\n\n`;

	return { html, text };
}

// ── Attachments ────────────────────────────────────────────────────

export interface ForwardCandidateAttachment {
	filename: string;
	/** Raw byte length, before base64 encoding. */
	size: number;
}

export interface AttachmentSelection<T> {
	included: T[];
	/** Filenames left out, for the header block. */
	omitted: string[];
}

/**
 * Fit as many attachments as the provider's ceiling allows.
 *
 * Oversized attachments are named in the header block rather than silently
 * dropped, and one huge attachment does not knock out the smaller ones behind
 * it — the loop keeps going instead of stopping at the first miss, since a
 * recipient is better served by three of four files plus a note than by none.
 */
export function selectForwardAttachments<T extends ForwardCandidateAttachment>(
	attachments: readonly T[],
	bodyBytes: number,
	budgetBytes: number = ATTACHMENT_BUDGET_BYTES,
): AttachmentSelection<T> {
	const included: T[] = [];
	const omitted: string[] = [];
	let used = bodyBytes;

	for (const attachment of attachments) {
		const encoded = base64EncodedSize(attachment.size);
		if (used + encoded <= budgetBytes) {
			included.push(attachment);
			used += encoded;
		} else {
			omitted.push(
				`${attachment.filename} (${formatBytesShort(attachment.size)})`,
			);
		}
	}

	return { included, omitted };
}

/** Byte cost of the body, for the attachment budget above. */
export function forwardBodyBytes(html: string, text: string): number {
	return utf8Size(html) + utf8Size(text);
}
