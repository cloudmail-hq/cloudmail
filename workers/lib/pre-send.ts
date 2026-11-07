// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The one pre-send gate every outbound message passes.
 *
 * Before this existed, suppression checks lived in three bulk paths and every
 * other path (REST transactional sends, the agent and MCP tools, auto-reply,
 * forwarding, scheduled delivery) went straight to the provider. Now every
 * caller of `sendEmail` must first obtain a {@link SendClearance} from
 * {@link preSend}, and `sendEmail` refuses to run without one. The clearance
 * is a branded type with a module-private brand, so a new send path that skips
 * the gate does not typecheck; `test/pre-send-paths.test.ts` also walks the
 * source for every `sendEmail(` call site.
 *
 * ## Contract
 *
 * `preSend(env, input, deps?) → PreSendResult`
 *
 * **Input** (`PreSendInput`):
 * - `kind`: what the mail is (`bulk` | `transactional` | `automated` | `system`),
 *   which decides how suppressions and the breaker apply (below).
 * - `from`, `mailboxId`, the recipients, body, attachments and FINAL headers
 *   (the provider limits are checked on exactly what will be sent).
 * - `actor` (optional): who is asking. `principal` is the request's `Principal`
 *   (null for cron/inbound/system sends, which have none); `credential` says how
 *   it authenticated (`session`, `token` with its id, `oauth` with the client
 *   id, `access`, `dev`), and `via` names the surface (`rest`, `mcp`, `agent`,
 *   `cron`, `inbound`, `system`). The built-in checks ignore it; rules use it.
 * - `hold` (optional): the replayable request (`action` plus the exact
 *   arguments) a rule needs in order to store the send for later approval.
 *   A path that can never be held (cron, inbound, system) omits it, and a rule
 *   must not return `hold_for_approval` without it.
 *
 * **Outcome** (`result.outcome`), one of:
 * - `allow`: send now with `result.clearance` and the filtered recipients.
 * - `warn`: send now, but `result.warnings` lists suppressed recipients the
 *   message still goes to (transactional mail to an `unsubscribed` address).
 * - `block`: do not send; `code`, `status` and `error` say why
 *   (`invalid_message` 400/413, `rate_limited` 429, `all_suppressed` 422,
 *   `bulk_paused` 423, or a rule's own code).
 * - `hold_for_approval`: do not send now; a rule stored the request for a
 *   person to approve. `approvalId` (and optionally `approvalUrl` and a
 *   `response` body) are for the caller to return, typically as 202
 *   `{status:"pending_approval"}`. The approved send later replays through its
 *   normal path, so it passes this gate again at that point.
 *
 * `result.ok` is true exactly for `allow` and `warn`.
 *
 * ## What it checks, in order
 *
 * 1. **Cloudflare's per-message limits** (`shared/send-validation.ts`): 50
 *    recipients, 32 attachments, 5 MiB, the header allowlist. Refused with the
 *    provider's own `E_*` code.
 * 2. **Per-mailbox send caps** (`shared/send-caps.ts`), counted by the
 *    mailbox's Durable Object. Skipped for `system` mail (password resets),
 *    which belongs to no mailbox, and when the caller has already checked the
 *    quota at enqueue time and passes `quotaChecked`.
 * 3. **The spam-rate circuit breaker** (`sending-health.ts`): `bulk` mail from
 *    a paused domain is refused. Transactional and one-to-one mail continues.
 * 4. **Suppressions**, with transactional semantics:
 *    - `bulk` (sequences, template sends, `transactional:false` API sends):
 *      every suppressed recipient is removed; none left is a refusal.
 *    - `automated` (auto-reply, forwarding): any suppression blocks. Nobody
 *      asked for this mail, so an unsubscribe is honoured too.
 *    - `transactional` (composer, replies, agent/MCP one-to-one sends,
 *      scheduled sends): a `hard_bounce`, `complaint` or `manual` entry blocks
 *      (the address is dead, the person reported us, or an operator said
 *      stop); an `unsubscribed` entry only warns. Someone who left a drip
 *      campaign still gets an answer when they write to support.
 *    - `system`: never filtered. A password reset goes to the account holder.
 * 5. **Rules** ({@link PRE_SEND_RULES}, plus `deps.rules`), in order, after the
 *    built-ins so nobody is asked to approve a message that could not be sent.
 *    Each sees the input, the actor and the filtered recipients and returns
 *    `null` (no opinion), `{outcome:"block", ...}` or
 *    `{outcome:"hold_for_approval", ...}`. The first non-null verdict wins. This
 *    is where the per-credential agent/MCP approval policy plugs in: one more
 *    entry in `PRE_SEND_RULES`.
 *
 * Fails open on a suppression or breaker lookup error (logged), like the
 * existing bulk paths: a broken AuthDO call must not stop every send, and the
 * provider's own suppression list still backs it up. A rule that throws fails
 * CLOSED (the send is blocked): a broken approval check must not wave mail
 * through.
 */

import { normalizeSuppressionAddress, sendingDomainOf } from "../../shared/suppressions";
import {
	SendValidationError,
	validateOutgoingMessage,
	type SendableMessage,
} from "../../shared/send-validation";
import { UnsendableHeaderError } from "../../shared/email-headers";
import type { SuppressionRecord, SuppressionStoreApi } from "../auth/types";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../types";
import type { Principal } from "./authz";
import { findBlockingSuppressions, suppressionStore } from "./suppressions";
import { bulkPauseStore, type BulkPauseApi } from "./sending-health";
import { agentInboxSendRule } from "./agent-send-rule";
import { LicenceUnavailableError, isLicenceLocked, type LicenceDeps } from "./licence";
import { LICENCE_REQUIRED_CODE, LICENCE_REQUIRED_MESSAGE } from "../../shared/licence";

/** What kind of mail this is, which decides how suppressions apply. */
export type SendKind = "bulk" | "transactional" | "automated" | "system";

/** Suppression reasons that block even transactional mail. */
export const TRANSACTIONAL_BLOCKING_REASONS: ReadonlySet<string> = new Set(["hard_bounce", "complaint", "manual"]);

/** How the request authenticated. Structural, so any principal shape fits. */
export interface SendCredential {
	method: "session" | "token" | "oauth" | "access" | "dev" | "system" | string;
	tokenId?: string | null;
	tokenName?: string | null;
	oauthClientId?: string | null;
	oauthClientName?: string | null;
}

/** Who is asking for the send. Absent for cron, inbound and system sends. */
export interface SendActor {
	principal?: Principal | null;
	credential?: SendCredential | null;
	via: "rest" | "mcp" | "agent" | "cron" | "inbound" | "system";
	/**
	 * A held send a person just approved (`workers/lib/held-send.ts`). The
	 * approval rule passes it; every other check still runs.
	 */
	released?: boolean;
	/** The agent session read mail the injection detector flagged; the approval rule holds the send. */
	injectionSuspected?: boolean;
}

/** The replayable request a rule stores to hold a send for approval. */
export interface SendHoldRequest {
	/** Which send this is, e.g. `send_email`, `send_reply`, `send_template`. */
	action: string;
	/** Exact arguments to replay on approval. */
	payload: Record<string, unknown>;
	subject: string;
}

export type PreSendOutcome = "allow" | "warn" | "block" | "hold_for_approval";

declare const clearanceBrand: unique symbol;

/**
 * Proof that a message passed the gate. Only {@link preSend} creates one;
 * `sendEmail` requires it.
 */
export interface SendClearance {
	readonly [clearanceBrand]: true;
	readonly kind: SendKind;
	readonly mailboxId: string | null;
}

export interface SuppressedRecipient {
	address: string;
	reason: string;
	scope: string;
}

export interface PreSendInput extends SendableMessage {
	kind: SendKind;
	/** Sending address (`From`), whose domain scopes suppressions and the breaker. */
	from: string;
	/** Mailbox whose caps apply. Null for system mail. */
	mailboxId: string | null;
	/** The caller already consulted the caps (scheduled delivery at enqueue). */
	quotaChecked?: boolean;
	/** Who is asking; for rules. See the module contract. */
	actor?: SendActor;
	/** What to store if a rule holds the send; omit where holding is impossible. */
	hold?: SendHoldRequest;
	/**
	 * Skip the licence check. Only the password-reset email sets it, so an
	 * admin can sign in to activate. Every other send is refused while locked.
	 */
	licenceExempt?: boolean;
}

/** What a rule sees: the input plus the recipients left after filtering. */
export interface PreSendRuleContext {
	env: Env;
	input: PreSendInput;
	to: string[];
	cc: string[];
	bcc: string[];
	warnings: SuppressedRecipient[];
}

export type PreSendRuleVerdict =
	| { outcome: "block"; code: string; status: number; error: string }
	| {
			outcome: "hold_for_approval";
			approvalId: string;
			approvalUrl?: string | null;
			/** Body for the caller to return as-is (e.g. `{status:"pending_approval"}`). */
			response?: Record<string, unknown>;
	  };

/** A policy check that runs after the built-ins. `null` means no opinion. */
export interface PreSendRule {
	name: string;
	check(ctx: PreSendRuleContext): Promise<PreSendRuleVerdict | null>;
}

/**
 * Rules every send runs, in order. The agent/MCP approval policy appends
 * itself (one line); tests pass `deps.rules` instead.
 *
 * - `agent-inbox-policy`: an agent inbox's `allowed_recipients`, and its send
 *   mode for its own token. See ./agent-send-rule.ts.
 */
export const PRE_SEND_RULES: PreSendRule[] = [agentInboxSendRule];

export type PreSendRefusal =
	| { outcome: "block"; code: "licence_required"; status: 402; error: string }
	| { outcome: "block"; code: "licence_unavailable"; status: 503; error: string }
	| { outcome: "block"; code: "invalid_message"; status: 400 | 413; error: string; providerCode: string }
	| { outcome: "block"; code: "rate_limited"; status: 429; error: string }
	| { outcome: "block"; code: "bulk_paused"; status: 423; error: string; domain: string }
	| { outcome: "block"; code: "all_suppressed"; status: 422; error: string; suppressed: SuppressedRecipient[] }
	| { outcome: "block"; code: "rule"; rule: string; ruleCode: string; status: number; error: string }
	| {
			outcome: "hold_for_approval";
			code: "held_for_approval";
			status: 202;
			error: string;
			rule: string;
			approvalId: string;
			approvalUrl: string | null;
			response: Record<string, unknown> | null;
	  };

export type PreSendResult =
	| {
			ok: true;
			/** `warn` when `warnings` is non-empty, else `allow`. */
			outcome: "allow" | "warn";
			clearance: SendClearance;
			/** Recipients that survived filtering, in the caller's shape. */
			to: string[];
			cc: string[];
			bcc: string[];
			/** Removed (bulk/automated) recipients. */
			suppressed: SuppressedRecipient[];
			/** Transactional recipients that are suppressed but were not blocked. */
			warnings: SuppressedRecipient[];
	  }
	| ({ ok: false } & PreSendRefusal);

/** The mailbox DO surface the gate uses. */
export interface QuotaStub {
	checkSendRateLimit(): Promise<string | null>;
}

export interface PreSendDeps {
	suppressions?: Pick<SuppressionStoreApi, "findSuppressions">;
	breaker?: BulkPauseApi;
	quota?: (mailboxId: string) => QuotaStub;
	/** Replaces {@link PRE_SEND_RULES} (tests). */
	rules?: PreSendRule[];
	/** Licence lookups (tests). */
	licence?: LicenceDeps;
}

type AddressField = string | string[] | null | undefined;

function asList(value: AddressField): string[] {
	if (!value) return [];
	return (Array.isArray(value) ? value : value.split(","))
		.map((v) => v.trim())
		.filter(Boolean);
}

function keyOf(address: string): string {
	return normalizeSuppressionAddress(address) ?? address.trim().toLowerCase();
}

function issue(kind: SendKind, mailboxId: string | null): SendClearance {
	return { kind, mailboxId } as SendClearance;
}

/**
 * Clearance for a send whose checks a caller has provably already run through
 * {@link preSend} in the same request (template sends gate each recipient
 * individually, then reuse the result). Exported for tests only.
 */
export function clearanceForTest(kind: SendKind = "transactional"): SendClearance {
	return issue(kind, null);
}

/** Whether `value` is a clearance minted by this module. */
export function isSendClearance(value: unknown): value is SendClearance {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { kind?: unknown }).kind === "string" &&
		["bulk", "transactional", "automated", "system"].includes((value as { kind: string }).kind)
	);
}

function toSuppressed(r: SuppressionRecord): SuppressedRecipient {
	return { address: r.address, reason: r.reason, scope: r.scope };
}

/**
 * Run every pre-send check. See the module comment for the order and the
 * semantics of each `kind`.
 */
export async function preSend(env: Env, input: PreSendInput, deps: PreSendDeps = {}): Promise<PreSendResult> {
	const to = asList(input.to);
	const cc = asList(input.cc);
	const bcc = asList(input.bcc);

	// 0. The licence (`./licence.ts`). Every outbound send is refused while the
	//    app is locked, and fails closed when the state can't be read. The one
	//    exception is the password-reset email (`licenceExempt`), so an admin
	//    who forgot their password can still sign in to activate.
	if (!input.licenceExempt) {
		let locked: boolean;
		try {
			locked = await isLicenceLocked(env, deps.licence ?? {});
		} catch (e) {
			if (!(e instanceof LicenceUnavailableError)) throw e;
			return { ok: false, outcome: "block", code: "licence_unavailable", status: 503, error: "Licence status is unavailable. Try again shortly." };
		}
		if (locked) return { ok: false, outcome: "block", code: "licence_required", status: 402, error: LICENCE_REQUIRED_MESSAGE };
	}

	// 1. Cloudflare's per-message limits. Run on the caller's full recipient set:
	//    filtering only ever shrinks it.
	try {
		validateOutgoingMessage({
			to,
			cc,
			bcc,
			html: input.html,
			text: input.text,
			attachments: input.attachments,
			headers: input.headers,
		});
	} catch (e) {
		if (e instanceof SendValidationError || e instanceof UnsendableHeaderError) {
			const code = (e as { code: string }).code;
			return {
				ok: false,
				outcome: "block",
				code: "invalid_message",
				status: code === "E_CONTENT_TOO_LARGE" ? 413 : 400,
				error: e.message,
				providerCode: code,
			};
		}
		throw e;
	}

	// 2. Per-mailbox caps.
	if (input.kind !== "system" && input.mailboxId && !input.quotaChecked) {
		const quota =
			deps.quota?.(input.mailboxId) ??
			(env.MAILBOX?.get(env.MAILBOX.idFromName(input.mailboxId)) as unknown as QuotaStub | undefined);
		if (quota?.checkSendRateLimit) {
			const limited = await quota.checkSendRateLimit();
			if (limited) return { ok: false, outcome: "block", code: "rate_limited", status: 429, error: limited };
		}
	}

	// 3. Spam-rate circuit breaker: bulk only.
	const domain = sendingDomainOf(input.from);
	if (input.kind === "bulk" && domain) {
		const breaker = deps.breaker ?? bulkPauseStore(env);
		try {
			const state = breaker ? await breaker.isBulkPaused(domain) : { paused: false, reason: null };
			if (state.paused) {
				return {
					ok: false,
					outcome: "block",
					code: "bulk_paused",
					status: 423,
					domain,
					error:
						`Bulk sending from ${domain} is paused${state.reason ? `: ${state.reason}` : ""}. ` +
						"An administrator can resume it in Settings → Domains once the cause is fixed. " +
						"One-to-one and transactional mail is not affected.",
				};
			}
		} catch (e) {
			console.error("Bulk-pause lookup failed; not blocking:", (e as Error).message);
		}
	}

	// 4. Suppressions (none for system mail).
	if (input.kind === "system") {
		return finish(env, input, deps, { to, cc, bcc, suppressed: [], warnings: [] });
	}
	const store = deps.suppressions ?? safeSuppressionStore(env);
	const all = [...to, ...cc, ...bcc].map(keyOf);
	const hits = store ? await findBlockingSuppressions(store, all, input.from) : new Map<string, SuppressionRecord>();

	const blocks = (r: SuppressionRecord) =>
		input.kind === "transactional" ? TRANSACTIONAL_BLOCKING_REASONS.has(r.reason) : true;
	const blocked = new Map<string, SuppressionRecord>();
	const warned = new Map<string, SuppressionRecord>();
	for (const [address, record] of hits) {
		(blocks(record) ? blocked : warned).set(address, record);
	}

	const keep = (a: string) => !blocked.has(keyOf(a));
	const result = {
		to: to.filter(keep),
		cc: cc.filter(keep),
		bcc: bcc.filter(keep),
		suppressed: [...blocked.values()].map(toSuppressed),
		warnings: [...warned.values()].map(toSuppressed),
	};

	// The provider requires a To. A surviving Cc with no To has nobody to address.
	if (result.to.length === 0) {
		return {
			ok: false,
			outcome: "block",
			code: "all_suppressed",
			status: 422,
			error:
				input.kind === "transactional"
					? "Every recipient has hard-bounced, reported this sender for spam, or was blocked by an administrator, so the message was not sent."
					: "Every recipient is on the suppression list",
			suppressed: result.suppressed,
		};
	}
	return finish(env, input, deps, result);
}

/** Step 5: the rules, then the clearance. */
async function finish(
	env: Env,
	input: PreSendInput,
	deps: PreSendDeps,
	result: { to: string[]; cc: string[]; bcc: string[]; suppressed: SuppressedRecipient[]; warnings: SuppressedRecipient[] },
): Promise<PreSendResult> {
	for (const rule of deps.rules ?? PRE_SEND_RULES) {
		let verdict: PreSendRuleVerdict | null;
		try {
			verdict = await rule.check({ env, input, to: result.to, cc: result.cc, bcc: result.bcc, warnings: result.warnings });
		} catch (e) {
			// Fail closed: a broken policy check must not wave mail through.
			console.error(`pre-send rule ${rule.name} failed; blocking:`, (e as Error).message);
			return { ok: false, outcome: "block", code: "rule", rule: rule.name, ruleCode: "rule_error", status: 503, error: "A send policy check failed. Try again shortly." };
		}
		if (!verdict) continue;
		if (verdict.outcome === "block") {
			return { ok: false, outcome: "block", code: "rule", rule: rule.name, ruleCode: verdict.code, status: verdict.status, error: verdict.error };
		}
		if (!input.hold) {
			// A rule may only hold what can be replayed. Blocking is the safe reading.
			console.error(`pre-send rule ${rule.name} tried to hold a send that cannot be held; blocking.`);
			return { ok: false, outcome: "block", code: "rule", rule: rule.name, ruleCode: "hold_unavailable", status: 403, error: "This send needs approval, which is not available on this path." };
		}
		return {
			ok: false,
			outcome: "hold_for_approval",
			code: "held_for_approval",
			status: 202,
			error: "Held for approval",
			rule: rule.name,
			approvalId: verdict.approvalId,
			approvalUrl: verdict.approvalUrl ?? null,
			response: verdict.response ?? null,
		};
	}
	return {
		ok: true,
		outcome: result.warnings.length > 0 ? "warn" : "allow",
		clearance: issue(input.kind, input.mailboxId),
		...result,
	};
}

function safeSuppressionStore(env: Env): Pick<SuppressionStoreApi, "findSuppressions"> | null {
	return (env as { AUTH_STORE?: unknown }).AUTH_STORE ? suppressionStore(env) : null;
}

/**
 * The actor for an HTTP request: its principal, how it authenticated, and
 * `via`. Structural over the Hono context so this module needs no Hono import.
 */
export function requestActor(
	c: {
		var: {
			principal?: Principal;
			authMethod?: string;
			authToken?: { id?: string; name?: string } | null;
		};
	},
	via: SendActor["via"] = "rest",
): SendActor {
	const method = c.var.authMethod ?? "session";
	return {
		principal: c.var.principal ?? null,
		credential: {
			method,
			tokenId: method === "token" ? (c.var.authToken?.id ?? null) : null,
			tokenName: method === "token" ? (c.var.authToken?.name ?? null) : null,
		},
		via,
	};
}

/** A refusal as a thrown error, for paths that report failures by throwing. */
export class PreSendRefusedError extends Error {
	readonly code: string;
	constructor(readonly refusal: PreSendRefusal) {
		super(refusal.error);
		this.name = "PreSendRefusedError";
		this.code =
			refusal.code === "invalid_message"
				? refusal.providerCode
				: refusal.code === "all_suppressed"
					? "E_RECIPIENT_SUPPRESSED_LOCAL"
					: refusal.code === "rate_limited"
						? "E_MAILBOX_RATE_LIMITED"
						: refusal.code === "bulk_paused"
							? "E_BULK_PAUSED"
							: refusal.code === "held_for_approval"
								? "E_HELD_FOR_APPROVAL"
								: "E_SEND_POLICY";
	}
}

/** `preSend`, throwing {@link PreSendRefusedError} on refusal. */
export async function preSendOrThrow(
	env: Env,
	input: PreSendInput,
	deps?: PreSendDeps,
): Promise<Extract<PreSendResult, { ok: true }>> {
	const result = await preSend(env, input, deps);
	if (!result.ok) {
		const { ok: _ok, ...refusal } = result;
		throw new PreSendRefusedError(refusal as PreSendRefusal);
	}
	return result;
}

/**
 * The HTTP response for a refusal or hold: `c.json(...httpRefusal(gate))`.
 * A hold answers 202 with the rule's body (`{status:"pending_approval"}`).
 */
export function httpRefusal(refusal: PreSendRefusal): [Record<string, unknown>, ContentfulStatusCode] {
	return [refusalBody(refusal), refusal.status as ContentfulStatusCode];
}

/** JSON body for an HTTP refusal. */
export function refusalBody(refusal: PreSendRefusal): Record<string, unknown> {
	switch (refusal.code) {
		case "licence_required":
			return { error: refusal.error, code: LICENCE_REQUIRED_CODE };
		case "licence_unavailable":
			return { error: refusal.error, code: "licence_unavailable" };
		case "invalid_message":
			return { error: refusal.error, code: refusal.providerCode };
		case "all_suppressed":
			return { error: refusal.error, code: "all_suppressed", suppressed: refusal.suppressed };
		case "bulk_paused":
			return { error: refusal.error, code: "bulk_paused", domain: refusal.domain };
		case "rate_limited":
			return { error: refusal.error, code: "rate_limited" };
		case "rule":
			return { error: refusal.error, code: refusal.ruleCode, rule: refusal.rule };
		case "held_for_approval":
			return (
				refusal.response ?? {
					status: "pending_approval",
					approval_id: refusal.approvalId,
					...(refusal.approvalUrl ? { approval_url: refusal.approvalUrl } : {}),
				}
			);
	}
}
