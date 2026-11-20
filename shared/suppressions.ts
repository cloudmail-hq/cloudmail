// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The suppression list's vocabulary, and the pure decisions around it.
 *
 * A suppression says "do not send non-transactional mail to this address". It
 * is scoped either globally or to one sending domain: an indie hacker runs
 * several products from one deployment, and someone unsubscribing from one
 * product's onboarding drip has not asked to stop hearing from the others. A
 * hard bounce, by contrast, means the address is dead for everyone, so bounce
 * suppressions are global.
 *
 * What is enforced, and where, lives in `workers/lib/suppressions.ts`. This file
 * is the part with no I/O: normalisation, CSV import parsing, and the rules for
 * which bounces count as "this address does not exist". Kept dependency-free so
 * it is shared by the Worker, the UI and the tests.
 */

import { sendErrorCode } from "./send-errors";

export const SUPPRESSION_REASONS = [
	"unsubscribed",
	"hard_bounce",
	"complaint",
	"manual",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** The scope value meaning "every sending domain". */
export const GLOBAL_SCOPE = "global";

export interface Suppression {
	id: string;
	address: string;
	/** `"global"` or a sending domain such as `example.com`. */
	scope: string;
	reason: SuppressionReason;
	/** Where it came from: `api`, `ui`, `csv`, `unsubscribe-link`, `dsn`, ... */
	source: string;
	/** Epoch milliseconds. */
	created_at: number;
}

export interface SuppressionInput {
	address: string;
	scope?: string;
	reason: SuppressionReason;
	source: string;
}

const ADDRESS_SHAPE = /^[^\s@,;<>"]+@[^\s@,;<>".]+(?:\.[^\s@,;<>".]+)+$/;
const DOMAIN_SHAPE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Lowercased, trimmed, `Name <addr>` unwrapped. Null when not an address. */
export function normalizeSuppressionAddress(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const angled = value.match(/<([^>]+)>/);
	const bare = (angled ? angled[1] : value).trim().toLowerCase();
	if (bare.length > 320 || !ADDRESS_SHAPE.test(bare)) return null;
	return bare;
}

/** `"global"`, a lowercase domain, or null when neither. Empty means global. */
export function normalizeSuppressionScope(value: unknown): string | null {
	if (value === undefined || value === null) return GLOBAL_SCOPE;
	if (typeof value !== "string") return null;
	const scope = value.trim().toLowerCase().replace(/^@/, "");
	if (scope === "" || scope === GLOBAL_SCOPE || scope === "*") return GLOBAL_SCOPE;
	return DOMAIN_SHAPE.test(scope) ? scope : null;
}

export function isSuppressionReason(value: unknown): value is SuppressionReason {
	return (
		typeof value === "string" &&
		(SUPPRESSION_REASONS as readonly string[]).includes(value)
	);
}

/** The sending domain of a From address, the scope a per-domain entry uses. */
export function sendingDomainOf(fromAddress: string): string {
	const bare = normalizeSuppressionAddress(fromAddress) ?? fromAddress.trim().toLowerCase();
	const at = bare.lastIndexOf("@");
	return at === -1 ? "" : bare.slice(at + 1);
}

/** Whether `entry` blocks mail from `domain`. */
export function suppressionApplies(entry: Pick<Suppression, "scope">, domain: string): boolean {
	return entry.scope === GLOBAL_SCOPE || entry.scope === domain.toLowerCase();
}

/** Human label for a reason, for the UI and the composer chip. */
export function describeSuppressionReason(reason: SuppressionReason): string {
	switch (reason) {
		case "unsubscribed":
			return "Unsubscribed";
		case "hard_bounce":
			return "Hard bounce";
		case "complaint":
			return "Spam complaint";
		case "manual":
			return "Added manually";
	}
}

// ── CSV import ─────────────────────────────────────────────────────

/** Upper bound on one import, so a single request stays within a DO call. */
export const MAX_IMPORT_ROWS = 10_000;

export interface CsvImportResult {
	entries: (SuppressionInput & { scope: string })[];
	/** 1-based line numbers with why each was skipped. */
	errors: { line: number; error: string }[];
}

/** Split one CSV line, honouring double quotes. Good enough for address lists. */
function splitCsvLine(line: string): string[] {
	const out: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"' && line[i + 1] === '"') {
				field += '"';
				i += 1;
			} else if (ch === '"') {
				quoted = false;
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			quoted = true;
		} else if (ch === "," || ch === ";" || ch === "\t") {
			out.push(field.trim());
			field = "";
		} else {
			field += ch;
		}
	}
	out.push(field.trim());
	return out;
}

/**
 * Parse an import file.
 *
 * Accepts a bare list of addresses (one per line), or columns
 * `address[,scope[,reason]]`, with or without a header row. Exports from
 * other providers usually name the column `email`, so that is accepted too.
 * Blank scope means global; blank reason means `defaultReason`.
 *
 * Bad rows are reported, not fatal: a 5,000-line export with three typos should
 * import 4,997 addresses and say which three it skipped.
 */
export function parseSuppressionCsv(
	text: string,
	options: { defaultReason?: SuppressionReason; defaultScope?: string; source?: string } = {},
): CsvImportResult {
	const defaultReason = options.defaultReason ?? "manual";
	const defaultScope = options.defaultScope ?? GLOBAL_SCOPE;
	const source = options.source ?? "csv";
	const entries: CsvImportResult["entries"] = [];
	const errors: CsvImportResult["errors"] = [];
	const seen = new Set<string>();

	const lines = text.replace(/^﻿/, "").split(/\r?\n/);
	let columns = { address: 0, scope: 1, reason: 2 };
	let first = true;

	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index];
		if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
		const cells = splitCsvLine(raw);

		if (first) {
			first = false;
			const lower = cells.map((c) => c.toLowerCase());
			const addressCol = lower.findIndex((c) => c === "address" || c === "email" || c === "email_address");
			if (addressCol !== -1) {
				columns = {
					address: addressCol,
					scope: lower.findIndex((c) => c === "scope" || c === "domain"),
					reason: lower.findIndex((c) => c === "reason"),
				};
				continue;
			}
		}

		if (entries.length >= MAX_IMPORT_ROWS) {
			errors.push({ line: index + 1, error: `import is limited to ${MAX_IMPORT_ROWS} rows` });
			break;
		}

		const address = normalizeSuppressionAddress(cells[columns.address]);
		if (!address) {
			errors.push({ line: index + 1, error: "not an email address" });
			continue;
		}

		const scopeCell = columns.scope >= 0 ? cells[columns.scope] : undefined;
		const scope = normalizeSuppressionScope(scopeCell ? scopeCell : defaultScope);
		if (!scope) {
			errors.push({ line: index + 1, error: `invalid scope "${scopeCell}"` });
			continue;
		}

		const reasonCell = columns.reason >= 0 ? (cells[columns.reason] ?? "").toLowerCase() : "";
		const reason = reasonCell === "" ? defaultReason : reasonCell;
		if (!isSuppressionReason(reason)) {
			errors.push({ line: index + 1, error: `invalid reason "${reasonCell}"` });
			continue;
		}

		const key = `${address}|${scope}`;
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({ address, scope, reason, source });
	}

	return { entries, errors };
}

// ── Bounces ────────────────────────────────────────────────────────

/**
 * Whether a permanent DSN status says the ADDRESS is bad, rather than the
 * message.
 *
 * Only these justify a suppression. A 5.7.x is a policy rejection (our SPF, the
 * content, a blocklist); suppressing on that would silently stop mail to a
 * working inbox because of a problem on our side. RFC 3463: 5.1.x is "bad
 * destination address/mailbox/system", 5.2.1 is "mailbox disabled".
 */
export function isAddressLevelBounce(status: string | null | undefined): boolean {
	if (!status) return false;
	const code = status.trim();
	return /^5\.1\.(?:1|2|3|6|10)$/.test(code) || code === "5.2.1";
}

/**
 * The provider `errorCause` buckets (Email Service analytics) that mean the
 * recipient address does not exist. See `classifyErrorCause`.
 */
const ADDRESS_LEVEL_CAUSES = new Set([
	"user_unknown",
	"no_such_user",
	"invalid_recipient",
	"domain_not_found",
]);

export function isAddressLevelProviderCause(cause: string | null | undefined): boolean {
	return !!cause && ADDRESS_LEVEL_CAUSES.has(cause.trim().toLowerCase());
}

/**
 * Whether a send error is Email Service refusing a recipient on its own
 * account-level suppression list.
 *
 * The binding throws an Error with `.code`; the REST API returns the same code
 * in the message, so both are checked.
 */
export function isRecipientSuppressedError(error: unknown): boolean {
	return sendErrorCode(error) === "E_RECIPIENT_SUPPRESSED";
}

/**
 * Whether an inbound message is a reply to a `mailto:` List-Unsubscribe.
 *
 * Our mailto target is the sending mailbox with `?subject=unsubscribe`, so a
 * message with exactly that subject is the request. Matching anything looser
 * ("please unsubscribe me from this thread") would let a human's ordinary reply
 * silently stop their own sequence mail, which is worse than missing the rare
 * hand-written request.
 */
export function isMailtoUnsubscribeRequest(subject: string | null | undefined): boolean {
	return (subject ?? "").trim().toLowerCase() === "unsubscribe";
}
