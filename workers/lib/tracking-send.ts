// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Apply a mailbox's tracking settings to an outgoing HTML body.
 *
 * The bridge between the pure rewrite (`shared/tracking-inject.ts`) and a real
 * send: it reads the mailbox's toggles and signing secret over RPC, builds the
 * open/click signers closed over that secret, and returns the instrumented HTML
 * for the OUTGOING copy only. The caller stores the original untouched.
 *
 * Returns the input unchanged (and does no RPC beyond the settings read) when
 * both toggles are off or there is no HTML part, so a plain-text send or a
 * mailbox with tracking disabled pays nothing.
 *
 * Never throws: tracking is an enhancement, and a failure to instrument must
 * never stop a message being sent. On any error it logs and returns the
 * original HTML, so the mail goes out untracked rather than not at all.
 */

import {
	injectTracking,
	looksLikeHtml,
	type TrackingInjectOptions,
} from "../../shared/tracking-inject";
import { signTrackingToken } from "../../shared/tracking-token";
import { isMessageWithinLimit } from "../../shared/limits";
import { sendingDomainOf } from "../../shared/suppressions";
import { DEFAULT_TRACKING_DISCLOSURE } from "../../shared/privacy";
import { deploymentOrigin, warnNoDeploymentOrigin } from "./deployment-origin";
import type { Env } from "../types";

/** The slice of the mailbox stub this needs. */
export interface TrackingStub {
	getTrackingSettings(): Promise<{
		openTracking: boolean;
		clickTracking: boolean;
		attachmentTracking: boolean;
		/** Append a "this message may track opens and clicks" line (off by default). */
		disclosureEnabled?: boolean;
		disclosureText?: string | null;
	}>;
	getOrCreateTrackingSecret(): Promise<string>;
}

/**
 * Recipients who asked not to be tracked (the `/u/:token` page). Global, in the
 * AuthDO beside the suppression list. See `workers/lib/tracking-opt-outs.ts`.
 */
export interface TrackingOptOutLookup {
	findTrackingOptOuts(addresses: string[], domain?: string | null): Promise<{ address: string }[]>;
}

export interface ApplyTrackingArgs {
	stub: TrackingStub;
	mailboxId: string;
	emailId: string;
	/** The primary recipient the tokens are attributed to. */
	recipient: string | null;
	html: string | undefined;
	/** Absolute origin for tracking URLs, e.g. `https://mailer.tapetide.com`. */
	baseUrl: string;
}

/**
 * Instrument the outgoing HTML for this mailbox, or return it unchanged.
 *
 * The tokens carry the LOCAL email id (not the provider id, which does not exist
 * yet at send time), so an engagement event resolves straight to the stored row.
 */
export async function applyTrackingToOutgoingHtml(
	args: ApplyTrackingArgs,
): Promise<string | undefined> {
	// Plain-text mail cannot carry a pixel or wrapped links. Several paths store
	// `html || text` and hand it back as html, so test the content, not the field.
	if (!args.html || !looksLikeHtml(args.html)) return args.html;

	try {
		const settings = await args.stub.getTrackingSettings();
		if (!settings.openTracking && !settings.clickTracking) return args.html;
		const disclosure = settings.disclosureEnabled
			? settings.disclosureText?.trim() || DEFAULT_TRACKING_DISCLOSURE
			: null;

		const secret = await args.stub.getOrCreateTrackingSecret();

		const options: TrackingInjectOptions = {
			baseUrl: args.baseUrl,
			openTracking: settings.openTracking,
			clickTracking: settings.clickTracking,
			signOpen: () =>
				signTrackingToken(
					{
						mailboxId: args.mailboxId,
						emailId: args.emailId,
						recipient: args.recipient,
						kind: "opened",
					},
					secret,
				),
			signClick: (url) =>
				signTrackingToken(
					{
						mailboxId: args.mailboxId,
						emailId: args.emailId,
						recipient: args.recipient,
						kind: "clicked",
						url,
					},
					secret,
				),
		};

		const tracked = await injectTracking(args.html, options);
		return disclosure ? appendDisclosure(tracked, disclosure) : tracked;
	} catch (e) {
		console.error(
			"Tracking injection failed; sending untracked:",
			(e as Error)?.message,
		);
		return args.html;
	}
}

function escapeText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Put the operator's tracking disclosure at the foot of the message: a small,
 * muted line before `</body>`, or at the end when there is no body tag.
 * Idempotent, so a body instrumented twice still carries one line.
 */
export function appendDisclosure(html: string, text: string): string {
	const cleaned = html.replace(/<p data-tt-disclosure="1"[^>]*>[\s\S]*?<\/p>/g, "");
	const line = `<p data-tt-disclosure="1" style="margin:16px 0 0;font-size:11px;line-height:1.4;color:#6b7280">${escapeText(text)}</p>`;
	const end = cleaned.search(/<\/body\s*>/i);
	return end === -1 ? cleaned + line : cleaned.slice(0, end) + line + cleaned.slice(end);
}

/**
 * The absolute origin to build tracking URLs from, derived from the request.
 *
 * A tracking URL must be absolute and must resolve back to this Worker, so it is
 * taken from the incoming request's own origin rather than configured — the mail
 * is being sent by a request that arrived at exactly the host the recipient
 * should later call back. `null` (send untracked) if the URL cannot be parsed,
 * which cannot normally happen.
 */
export function trackingBaseUrlFromRequest(requestUrl: string): string | null {
	try {
		return new URL(requestUrl).origin;
	} catch {
		return null;
	}
}

/**
 * The origin for tracking URLs on a send with NO request: cron (sequences),
 * the Durable Object alarm (scheduled and undo-window sends) and the agent
 * tool layer.
 *
 * Preference order: the origin captured when the send was queued (`stored`),
 * then `deploymentOrigin(env)`: `APP_URL`, then the origin recorded from
 * signed-in requests. The stored origin wins because it is the host the user
 * was actually on, which is provably this Worker.
 *
 * `null` when nothing is known. The send then goes out untracked (see
 * `trackOutgoingHtml`) rather than pointing recipients at another host.
 */
export async function trackingBaseUrl(env: Env, stored?: string | null): Promise<string | null> {
	const value = stored?.trim();
	if (value) {
		try {
			const url = new URL(value);
			if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
		} catch {
			/* fall through */
		}
	}
	return deploymentOrigin(env);
}

/**
 * Who a tracking token is attributed to.
 *
 * One MIME body goes to every To, Cc and Bcc recipient, so there is one pixel
 * and one set of link tokens for all of them, and an open cannot be told apart
 * by recipient. Naming the first `to` would file a Cc'd reader's open as that
 * person's, which is worse than admitting we cannot tell. So: the address when
 * there is exactly one recipient, otherwise `null` (message-level).
 */
export function trackingRecipientFor(
	...lists: (string | string[] | null | undefined)[]
): string | null {
	const all = lists
		.flatMap((list) => (Array.isArray(list) ? list : (list ?? "").split(",")))
		.map((a) => a.trim().toLowerCase())
		.filter(Boolean);
	return all.length === 1 ? all[0] : null;
}

export interface TrackOutgoingArgs {
	stub: TrackingStub;
	mailboxId: string;
	/** Local id of the row stored in Sent. */
	emailId: string;
	html: string | null | undefined;
	/**
	 * Origin for the tracking URLs. `null` (no deployment origin known, on a
	 * send with no request) sends the message untracked.
	 */
	baseUrl: string | null;
	/** Recipient lists, for attribution; see `trackingRecipientFor`. */
	to?: string | string[] | null;
	cc?: string | string[] | null;
	bcc?: string | string[] | null;
	/** Rest of the message, so the instrumented body can be re-checked for size. */
	text?: string | null;
	attachments?: { content: string }[];
	/**
	 * The per-message switch: `false` sends this message untracked whatever the
	 * mailbox setting ("Don't track this message" in the composer, `track:
	 * false` in REST, MCP and the CLI). Absent means "follow the mailbox".
	 */
	track?: boolean | null;
	/**
	 * Recipient opt-outs. When any recipient has opted out of tracking from this
	 * sender's domain, the whole message goes untracked: one body is shared by
	 * every recipient, so there is no way to track only the others.
	 */
	optOuts?: TrackingOptOutLookup | null;
	/** The From address, for the opt-out's domain scope. Defaults to `mailboxId`. */
	fromAddress?: string | null;
}

/** Every recipient address, lowercased and deduplicated. */
export function allRecipientAddresses(
	...lists: (string | string[] | null | undefined)[]
): string[] {
	return [
		...new Set(
			lists
				.flatMap((list) => (Array.isArray(list) ? list : (list ?? "").split(",")))
				.map((a) => {
					const angled = a.match(/<([^>]+)>/);
					return (angled ? angled[1] : a).trim().toLowerCase();
				})
				.filter((a) => a.includes("@")),
		),
	];
}

/**
 * Whether tracking must be skipped for these recipients. Fails CLOSED on a
 * lookup error: a send that cannot confirm the recipient's choice goes
 * untracked rather than tracked against their wishes.
 */
export async function recipientsOptedOut(
	optOuts: TrackingOptOutLookup,
	recipients: string[],
	fromAddress: string,
): Promise<boolean> {
	if (recipients.length === 0) return false;
	try {
		const rows = await optOuts.findTrackingOptOuts(recipients, sendingDomainOf(fromAddress) || null);
		return rows.length > 0;
	} catch (e) {
		console.error("Tracking opt-out lookup failed; sending untracked:", (e as Error)?.message);
		return true;
	}
}

/**
 * The one entry point every send path uses: instrument the OUTGOING html for
 * this mailbox, or return it unchanged.
 *
 * Callers store the original html in Sent and hand only this result to the
 * provider, so the sender's own copy carries no pixel and no rewritten links.
 *
 * Size is re-checked after instrumenting: wrapping links and adding a pixel
 * grows the body, and a message that fitted before could cross the provider's
 * limit. Tracking is the expendable part, so an over-limit result falls back to
 * the original rather than failing the send.
 *
 * Never throws (see `applyTrackingToOutgoingHtml`).
 */
export async function trackOutgoingHtml(
	args: TrackOutgoingArgs,
): Promise<string | undefined> {
	const html = args.html ?? undefined;
	// The sender switched tracking off for this one message.
	if (args.track === false) return html;
	// No origin this deployment is reachable on: tracking URLs would point
	// nowhere (or at someone else's host), so send untracked.
	if (!args.baseUrl) {
		if (html && looksLikeHtml(html)) warnNoDeploymentOrigin("sending");
		return html;
	}
	const baseUrl = args.baseUrl;
	// A recipient opted out. Checked only when there is HTML to instrument, so a
	// plain-text send pays no lookup.
	if (
		args.optOuts &&
		html &&
		looksLikeHtml(html) &&
		(await recipientsOptedOut(
			args.optOuts,
			allRecipientAddresses(args.to, args.cc, args.bcc),
			args.fromAddress || args.mailboxId,
		))
	) {
		return html;
	}
	const tracked = await applyTrackingToOutgoingHtml({
		stub: args.stub,
		mailboxId: args.mailboxId,
		emailId: args.emailId,
		recipient: trackingRecipientFor(args.to, args.cc, args.bcc),
		html,
		baseUrl,
	});
	if (tracked === html) return html;
	const fits = isMessageWithinLimit({
		html: tracked,
		text: args.text,
		encodedAttachmentSizes: args.attachments?.map((a) => a.content.length),
	});
	if (!fits) {
		console.warn(`Tracking pushed ${args.emailId} past the size limit; sending untracked.`);
		return html;
	}
	return tracked;
}
