// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The compliance step for a non-transactional API send.
 *
 * `POST /api/v1/mailboxes/:id/emails` is transactional by default, because
 * that is what every existing caller (the agent, the CLI, scripts sending
 * receipts) means by it. A caller that sets `transactional: false` or
 * `list: true` is sending bulk mail, and gets:
 *
 *   - suppressed recipients removed (all of them suppressed is a 422);
 *   - for a single-recipient send, the signed unsubscribe link in
 *     `List-Unsubscribe` / `List-Unsubscribe-Post` and, unless disabled, the
 *     footer.
 *
 * Multi-recipient bulk sends get no unsubscribe header: the token names one
 * address, and every recipient would receive a link that unsubscribes the
 * first. Send one message per recipient (or use template sends) for that.
 *
 * Every bulk send also gets `List-Id` (RFC 2919), `<list-slug>.<domain>`, which
 * Gmail uses to group feedback-loop data per stream. {@link bulkCompliance} is
 * the one-recipient form used by template sends (REST and MCP) and sequences.
 */

import {
	UNSUBSCRIBE_PLACEHOLDER,
	applyUnsubscribeToHtml,
	applyUnsubscribeToText,
} from "../../shared/list-unsubscribe";
import { normalizeSuppressionAddress, sendingDomainOf } from "../../shared/suppressions";
import type { SuppressionRecord, SuppressionStoreApi } from "../auth/types";
import {
	buildUnsubscribeLink,
	findBlockingSuppressions,
	suppressionStore,
	unsubscribeFooterEnabled,
} from "./suppressions";
import type { Env } from "../types";

type Field = string | string[] | undefined;

function asList(value: Field): string[] {
	if (!value) return [];
	return (Array.isArray(value) ? value : value.split(",")).map((v) => v.trim()).filter(Boolean);
}

/**
 * `List-Id` for a bulk stream: `Name <slug.domain>` per RFC 2919. The slug is
 * reduced to `[a-z0-9-]`, so a sequence name or template slug is always a valid
 * list-label; the header stays well under the 2,048-byte value limit.
 */
export function buildListId(slug: string, fromAddress: string, name?: string | null): string | null {
	const domain = sendingDomainOf(fromAddress);
	if (!domain) return null;
	const label =
		slug
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "list";
	const id = `<${label}.${domain}>`;
	const phrase = (name ?? "").replace(/[\r\n"<>\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
	return phrase ? `"${phrase}" ${id}` : id;
}

/**
 * The bulk headers and body for ONE recipient: the signed unsubscribe link in
 * `List-Unsubscribe` / `List-Unsubscribe-Post` and the body (footer unless the
 * template places `{{unsubscribe_url}}`), plus `List-Id`. Used by every bulk
 * path so none can drift: REST and MCP template sends, sequences, and
 * single-recipient `transactional:false` API sends.
 *
 * A link that cannot be built (secret lookup failed) leaves the headers off
 * and the placeholder blanked, rather than not sending.
 */
export async function bulkCompliance(
	env: Env,
	input: {
		recipient: string;
		fromAddress: string;
		listSlug: string;
		listName?: string | null;
		html?: string;
		text?: string;
		requestUrl?: string;
	},
	deps: { linkBuilder?: typeof buildUnsubscribeLink } = {},
): Promise<{ html?: string; text?: string; headers: Record<string, string>; unsubscribeUrl: string | null }> {
	const linkBuilder = deps.linkBuilder ?? buildUnsubscribeLink;
	const link = await linkBuilder(env, {
		recipient: input.recipient,
		fromAddress: input.fromAddress,
		requestUrl: input.requestUrl,
	});
	const footer = unsubscribeFooterEnabled(env);
	const headers: Record<string, string> = {};
	let html = input.html;
	let text = input.text;
	if (link) {
		Object.assign(headers, link.headers);
		if (html !== undefined) html = applyUnsubscribeToHtml(html, link.url, { footer });
		if (text !== undefined) text = applyUnsubscribeToText(text, link.url, { footer });
	} else {
		if (html !== undefined) html = html.split(UNSUBSCRIBE_PLACEHOLDER).join("");
		if (text !== undefined) text = text.split(UNSUBSCRIBE_PLACEHOLDER).join("");
	}
	const listId = buildListId(input.listSlug, input.fromAddress, input.listName);
	if (listId) headers["List-Id"] = listId;
	return { html, text, headers, unsubscribeUrl: link?.url ?? null };
}

export interface ComplianceInput {
	to: Field;
	cc?: Field;
	bcc?: Field;
	fromEmail: string;
	html?: string;
	text?: string;
	requestUrl?: string;
	/** `List-Id` label; defaults to `api`, the stream for ad-hoc bulk API sends. */
	listSlug?: string;
}

export type ComplianceResult =
	| {
			ok: true;
			to: string[];
			cc: string[];
			bcc: string[];
			html?: string;
			text?: string;
			headers: Record<string, string>;
			/** Addresses removed because they are suppressed. */
			suppressed: { address: string; reason: string; scope: string }[];
	  }
	| { ok: false; suppressed: { address: string; reason: string; scope: string }[] };

/**
 * Filter suppressed recipients and attach the unsubscribe link.
 *
 * `store` and `linkBuilder` are injectable for tests; production passes the
 * defaults.
 */
export async function applySendCompliance(
	env: Env,
	input: ComplianceInput,
	deps: {
		store?: Pick<SuppressionStoreApi, "findSuppressions">;
		linkBuilder?: typeof buildUnsubscribeLink;
	} = {},
): Promise<ComplianceResult> {
	const store = deps.store ?? suppressionStore(env);
	const linkBuilder = deps.linkBuilder ?? buildUnsubscribeLink;
	const fields = { to: asList(input.to), cc: asList(input.cc), bcc: asList(input.bcc) };
	const all = [...fields.to, ...fields.cc, ...fields.bcc]
		.map((a) => normalizeSuppressionAddress(a) ?? a.toLowerCase());

	const blocked = await findBlockingSuppressions(store, all, input.fromEmail);
	const isBlocked = (address: string) =>
		blocked.has(normalizeSuppressionAddress(address) ?? address.toLowerCase());
	const suppressed = [...blocked.values()].map((r: SuppressionRecord) => ({
		address: r.address,
		reason: r.reason,
		scope: r.scope,
	}));

	const to = fields.to.filter((a) => !isBlocked(a));
	const cc = fields.cc.filter((a) => !isBlocked(a));
	const bcc = fields.bcc.filter((a) => !isBlocked(a));
	const remaining = [...to, ...cc, ...bcc];
	// No To left means there is nobody to address the message to, even if a Cc
	// survived: the provider requires `to`.
	if (remaining.length === 0 || to.length === 0) return { ok: false, suppressed };

	let html = input.html;
	let text = input.text;
	let headers: Record<string, string> = {};
	if (remaining.length === 1) {
		const bulk = await bulkCompliance(
			env,
			{
				recipient: remaining[0],
				fromAddress: input.fromEmail,
				listSlug: input.listSlug ?? "api",
				html: html || undefined,
				text: text || undefined,
				requestUrl: input.requestUrl,
			},
			{ linkBuilder },
		);
		headers = bulk.headers;
		html = bulk.html ?? html;
		text = bulk.text ?? text;
	} else {
		const listId = buildListId(input.listSlug ?? "api", input.fromEmail);
		if (listId) headers["List-Id"] = listId;
	}

	return { ok: true, to, cc, bcc, html, text, headers, suppressed };
}
