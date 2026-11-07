// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Parse RFC 8601 `Authentication-Results` headers.
 *
 * Cloudflare Email Routing evaluates SPF, DKIM and DMARC on inbound mail and
 * records the outcome in an `Authentication-Results` header (and, for forwarded
 * mail, `ARC-Authentication-Results`):
 * https://developers.cloudflare.com/email-service/reference/postmaster/
 *
 * The inbound handler already persists every header into `emails.raw_headers`,
 * so these verdicts have been sitting in the database unread. Nothing in the
 * app looked at them, which meant a message failing DMARC — the single
 * strongest spoofing signal available — was displayed identically to one that
 * passed.
 *
 * Lives in `shared/` because two consumers need it: the reading pane surfaces
 * the verdict to the user today, and the inbound rules engine will route
 * `dmarc=fail` to Spam.
 */

/** Outcomes defined by RFC 8601 §2.7, plus a catch-all for unknown tokens. */
export type AuthResult =
	| "pass"
	| "fail"
	| "softfail"
	| "neutral"
	| "none"
	| "temperror"
	| "permerror"
	| "policy"
	| "unknown";

const KNOWN_RESULTS = new Set<AuthResult>([
	"pass",
	"fail",
	"softfail",
	"neutral",
	"none",
	"temperror",
	"permerror",
	"policy",
]);

export interface AuthenticationResults {
	/** The `authserv-id` that performed the checks. */
	authservId?: string;
	spf?: AuthResult;
	dkim?: AuthResult;
	dmarc?: AuthResult;
	/** `header.d` from the DKIM method — the domain that signed the message. */
	dkimDomain?: string;
	/** `header.from` from the DMARC method — the domain DMARC was evaluated against. */
	dmarcDomain?: string;
	/** `smtp.mailfrom` from the SPF method — the envelope sender. */
	spfMailfrom?: string;
	/** True when the verdicts came from `ARC-Authentication-Results`. */
	viaArc: boolean;
}

/** A header entry as stored in `emails.raw_headers`. */
interface RawHeader {
	key?: string;
	value?: string;
}

/**
 * Strip RFC 5322 comments, e.g. `spf=pass (mailfrom: ok) smtp.mailfrom=x`.
 *
 * Only handles non-nested parentheses. Nested comments are legal but are not
 * emitted by any mainstream implementation, and a mis-strip degrades to an
 * `unknown` verdict rather than a wrong one.
 */
function stripComments(value: string): string {
	return value.replace(/\([^()]*\)/g, " ");
}

function toResult(token: string | undefined): AuthResult {
	if (!token) return "unknown";
	const normalized = token.toLowerCase();
	return KNOWN_RESULTS.has(normalized as AuthResult)
		? (normalized as AuthResult)
		: "unknown";
}

/**
 * Read a `ptype.property=value` pair out of a method's parameter list.
 *
 * `property` is a literal name, not a pattern. It is escaped on the way into the
 * RegExp so callers pass `"smtp.mailfrom"` without having to know that the dot
 * would otherwise match any character, and so no future caller can hand this
 * function something that compiles into a pathological pattern.
 */
function readProperty(segment: string, property: string): string | undefined {
	const literal = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`${literal}\\s*=\\s*([^\\s;]+)`, "i").exec(segment);
	if (!match) return undefined;
	// Values may be quoted, and DKIM domains are sometimes bracketed.
	return match[1].replace(/^["'<]|["'>]$/g, "").toLowerCase() || undefined;
}

/**
 * Parse a single `Authentication-Results` header value.
 *
 * Grammar (RFC 8601 §2.2), simplified:
 *   authserv-id [ ";" method [ "/" version ] "=" result *( ptype "." property "=" value ) ]*
 */
export function parseAuthenticationResults(
	headerValue: string,
	options: { viaArc?: boolean } = {},
): AuthenticationResults {
	const result: AuthenticationResults = { viaArc: options.viaArc ?? false };
	if (!headerValue) return result;

	const segments = stripComments(headerValue).split(";");

	// The first segment is the authserv-id. ARC headers prefix an instance
	// number (`i=1`), which is not an authentication method.
	const first = segments[0]?.trim();
	if (first && !/^i\s*=/i.test(first)) {
		result.authservId = first.split(/\s+/)[0] || undefined;
	}

	for (const segment of segments.slice(1)) {
		const trimmed = segment.trim();
		if (!trimmed) continue;

		// `method[/version]=result`, anchored so that trailing
		// `ptype.property=value` pairs are never mistaken for the method.
		const match = /^([a-z][a-z0-9-]*)(?:\/\d+)?\s*=\s*([a-z]+)/i.exec(trimmed);
		if (!match) continue;

		const method = match[1].toLowerCase();
		const verdict = toResult(match[2]);

		switch (method) {
			case "spf":
				result.spf = verdict;
				result.spfMailfrom ??= readProperty(trimmed, "smtp.mailfrom");
				break;
			case "dkim":
				// A message may carry several DKIM signatures. A single passing
				// signature authenticates it, so a pass is never downgraded.
				if (result.dkim !== "pass") result.dkim = verdict;
				if (verdict === "pass" || !result.dkimDomain) {
					result.dkimDomain =
						readProperty(trimmed, "header.d") ?? result.dkimDomain;
				}
				break;
			case "dmarc":
				result.dmarc = verdict;
				result.dmarcDomain ??= readProperty(trimmed, "header.from");
				break;
			default:
				// Other methods (iprev, auth, compauth, arc...) are not surfaced.
				break;
		}
	}

	return result;
}

/**
 * `authserv-id`s whose verdicts this app believes.
 *
 * RFC 8601 §5: an `Authentication-Results` header means something only when a
 * server the reader trusts added it, and that server is named by its
 * authserv-id. Anything else in the message is text the sender wrote. Cloudflare
 * Email Routing, the only inbound MX, stamps `mx.cloudflare.net`.
 */
export const TRUSTED_AUTHSERV_IDS: readonly string[] = ["mx.cloudflare.net"];

/**
 * ARC sealers whose `ARC-Authentication-Results` may be consulted at all.
 *
 * Cloudflare seals forwarded mail as `d=cloudflare.net`. See
 * `extractAuthenticationResults` for why even a matching seal never adds trust.
 */
export const TRUSTED_ARC_SEALERS: readonly string[] = ["cloudflare.net"];

export interface ExtractAuthOptions {
	/** Overrides `TRUSTED_AUTHSERV_IDS`. Compared case-insensitively. */
	trustedAuthservIds?: readonly string[];
	/** Overrides `TRUSTED_ARC_SEALERS`. Compared case-insensitively. */
	trustedArcSealers?: readonly string[];
}

const normalizeId = (value: string | undefined) =>
	(value ?? "").trim().toLowerCase().replace(/\.$/, "");

/** `i=` of an ARC header, or null when absent or malformed. */
function arcInstance(value: string): number | null {
	const match = /^\s*i\s*=\s*(\d{1,3})\s*;/i.exec(value);
	return match ? Number(match[1]) : null;
}

/** `d=` of an ARC-Seal. */
function arcSealDomain(value: string): string {
	return normalizeId(/(?:^|;)\s*d\s*=\s*([^\s;]+)/i.exec(value)?.[1]);
}

/** The authserv-id of an ARC-Authentication-Results value (after `i=N;`). */
function arcAuthservId(value: string): string {
	const afterInstance = stripComments(value).split(";")[1] ?? "";
	return normalizeId(afterInstance.trim().split(/\s+/)[0]);
}

/**
 * Pull authentication verdicts out of a stored `raw_headers` JSON blob.
 *
 * Only verdicts our own MX wrote count. Apart from what the receiving server
 * prepends, every header is the sender's choice, so a phisher could include
 * `Authentication-Results: anything; dmarc=pass`. Before this check the reading
 * pane showed that as verified and the spam score believed it.
 *
 * 1. **The topmost `Authentication-Results`, and only when its authserv-id is
 *    allowlisted.** The receiving MX prepends its header above everything the
 *    message arrived with, so the topmost one is ours when ours exists. Lower
 *    headers are never consulted, even when they name a trusted authserv-id: if
 *    ours is missing, a lower one claiming to be ours is the forgery.
 * 2. **ARC never adds trust.** An ARC set is worth what its cryptographic
 *    verification is worth, this app does none, and a sender can write a whole
 *    fake chain naming `d=cloudflare.net`. So ARC is read only when there is no
 *    trusted `Authentication-Results`, and only the set with the *highest*
 *    instance: each hop adds `i=N+1` (RFC 8617 §4.2.1), so the set nearest us is
 *    the highest and anything a sender pre-forged sits lower. That instance must
 *    have exactly one seal and one results header, the seal must be from an
 *    allowlisted sealer and the results must name an allowlisted authserv-id.
 *    Even then every `pass` is dropped. A failure can only make the sender look
 *    worse; a pass is exactly what a forger would write.
 *
 * Returns `null` when no trusted verdicts exist: mail received before Email
 * Routing authenticated it, anything this app sent, or a message whose results
 * headers are all untrusted. `assessSenderTrust(null)` is `unknown`, never
 * `verified`.
 */
export function extractAuthenticationResults(
	rawHeaders: string | null | undefined,
	options: ExtractAuthOptions = {},
): AuthenticationResults | null {
	if (!rawHeaders) return null;

	let headers: RawHeader[];
	try {
		const parsed = JSON.parse(rawHeaders);
		if (!Array.isArray(parsed)) return null;
		headers = parsed as RawHeader[];
	} catch {
		return null;
	}

	const trustedIds = new Set(
		(options.trustedAuthservIds ?? TRUSTED_AUTHSERV_IDS).map(normalizeId),
	);
	const trustedSealers = new Set(
		(options.trustedArcSealers ?? TRUSTED_ARC_SEALERS).map(normalizeId),
	);

	const all = (name: string) =>
		headers
			.filter(
				(h): h is { key: string; value: string } =>
					typeof h?.key === "string" &&
					typeof h.value === "string" &&
					h.key.toLowerCase() === name,
			)
			.map((h) => h.value);

	// Rule 1. `headers` is in message order, so index 0 is the topmost.
	const direct = all("authentication-results")[0];
	if (direct !== undefined) {
		const parsed = parseAuthenticationResults(direct);
		if (trustedIds.has(normalizeId(parsed.authservId))) return parsed;
		// Our MX did not write the topmost header, so nothing below it is ours
		// either. Fall through to ARC, which can only report failures.
	}

	// Rule 2.
	const seals = all("arc-seal");
	const results = all("arc-authentication-results");
	const instances = [...seals, ...results]
		.map(arcInstance)
		.filter((i): i is number => i !== null);
	if (instances.length === 0) return null;
	const top = Math.max(...instances);
	const sealsAtTop = seals.filter((v) => arcInstance(v) === top);
	const resultsAtTop = results.filter((v) => arcInstance(v) === top);
	if (sealsAtTop.length !== 1 || resultsAtTop.length !== 1) return null;
	if (!trustedSealers.has(arcSealDomain(sealsAtTop[0]!))) return null;
	const arcId = arcAuthservId(resultsAtTop[0]!);
	if (!trustedIds.has(arcId)) return null;

	const arc = parseAuthenticationResults(resultsAtTop[0]!, { viaArc: true });
	arc.authservId = arcId;
	for (const key of ["spf", "dkim", "dmarc"] as const) {
		if (arc[key] === "pass") arc[key] = undefined;
	}
	if (!arc.spf && !arc.dkim && !arc.dmarc) return null;
	return arc;
}

/**
 * Whether the visible `From:` domain was authenticated by our own MX.
 *
 * The gate for anything the app *does* on the sender's say-so: honouring an
 * unsubscribe-by-email, sending an auto-reply, forwarding. DMARC pass is the
 * direct answer. Without a DMARC verdict, an SPF or DKIM pass counts only when
 * its domain aligns (relaxed: same registrable domain) with the From domain,
 * which is what DMARC itself would have checked. ARC-derived results never
 * qualify, since ARC passes are discarded above.
 *
 * `sameOrg` decides relaxed alignment. It is a parameter so this file stays free
 * of the public-suffix list (it is imported by the client bundle); the Worker
 * passes `sameOrganization` from `shared/domain-safety.ts`.
 */
export function isSenderAuthenticated(
	results: AuthenticationResults | null,
	fromAddress: string,
	sameOrg: (a: string, b: string) => boolean,
): boolean {
	if (!results || results.viaArc) return false;
	if (results.dmarc === "fail") return false;
	if (results.dmarc === "pass") return true;
	const at = fromAddress.lastIndexOf("@");
	const fromDomain = at === -1 ? "" : fromAddress.slice(at + 1).trim().toLowerCase();
	if (!fromDomain) return false;
	if (results.dkim === "pass" && results.dkimDomain && sameOrg(results.dkimDomain, fromDomain)) {
		return true;
	}
	if (results.spf === "pass" && results.spfMailfrom) {
		const mailfrom = results.spfMailfrom;
		const spfDomain = mailfrom.includes("@") ? mailfrom.slice(mailfrom.lastIndexOf("@") + 1) : mailfrom;
		if (sameOrg(spfDomain, fromDomain)) return true;
	}
	return false;
}

/**
 * Whether authentication positively failed, as opposed to being absent.
 *
 * Forwarding and auto-reply refuse these. "Unknown" is not "failed": mail with
 * no trusted verdict at all (a Routing outage, a message from before Routing
 * stamped results) is still forwarded, because Email Routing has already
 * rejected SPF+DKIM double failures and DMARC-reject mail before our Worker
 * ever sees it.
 */
export function didAuthenticationFail(results: AuthenticationResults | null): boolean {
	if (!results) return false;
	return results.dmarc === "fail" || (results.spf === "fail" && results.dkim === "fail");
}

/**
 * How much the sender's identity can be trusted.
 *
 * - `failed`    — DMARC failed, or both SPF and DKIM failed. Likely forged.
 * - `verified`  — DMARC passed, so the visible From domain is authenticated.
 * - `partial`   — SPF or DKIM passed but DMARC gave no verdict, so the
 *                 From header is not provably aligned with what was checked.
 * - `unverified`— checks ran and nothing passed, without an outright failure.
 * - `unknown`   — no verdicts available; say nothing rather than imply safety.
 */
export type SenderTrustLevel =
	| "verified"
	| "partial"
	| "unverified"
	| "failed"
	| "unknown";

export interface SenderTrust {
	level: SenderTrustLevel;
	/** Short human-readable explanation, suitable for a tooltip. */
	summary: string;
	results: AuthenticationResults | null;
}

export function assessSenderTrust(
	results: AuthenticationResults | null,
): SenderTrust {
	if (!results) {
		return {
			level: "unknown",
			summary: "No authentication results were recorded for this message.",
			results,
		};
	}

	const { spf, dkim, dmarc } = results;

	if (dmarc === "fail") {
		return {
			level: "failed",
			summary:
				"DMARC failed: the sending domain's own policy says this message is not authentic. Treat links and attachments as untrusted.",
			results,
		};
	}

	if (spf === "fail" && dkim === "fail") {
		return {
			level: "failed",
			summary:
				"Both SPF and DKIM failed: the sender could not be authenticated. Treat links and attachments as untrusted.",
			results,
		};
	}

	if (dmarc === "pass") {
		const signer = results.dkimDomain ?? results.dmarcDomain;
		return {
			level: "verified",
			summary: signer
				? `DMARC passed — authenticated as ${signer}.`
				: "DMARC passed — the sending domain is authenticated.",
			results,
		};
	}

	if (dkim === "pass" || spf === "pass") {
		const which = dkim === "pass" ? "DKIM" : "SPF";
		return {
			level: "partial",
			summary: `${which} passed but DMARC gave no verdict, so the From address is not provably aligned with the domain that was checked.`,
			results,
		};
	}

	if (spf || dkim || dmarc) {
		return {
			level: "unverified",
			summary:
				"Authentication ran but nothing passed, so the sender's identity is unconfirmed.",
			results,
		};
	}

	return {
		level: "unknown",
		summary: "No authentication results were recorded for this message.",
		results,
	};
}

/** Whether the verdict is worth interrupting the reader for. */
export function isSenderTrustAlarming(level: SenderTrustLevel): boolean {
	return level === "failed";
}
