// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The authoritative shape of a mailbox's settings blob.
 *
 * One mailbox setting is not like the others: `agentSystemPrompt` is fed to the
 * model as a system prompt. The create route used to accept the whole blob as
 * `z.record(z.any())`, so anything that could reach `POST /api/v1/mailboxes` or
 * `PUT /api/v1/mailboxes/:id` could write arbitrary instructions into the
 * privileged half of a prompt that also carries the mailbox's mail — and the
 * agent holds tools that draft and file messages. Nothing downstream re-checked
 * it, because there was nothing to check against.
 *
 * So the schema is the enumeration of every key the code actually reads:
 * `fromName` (outgoing display name), `forwarding`, `signature`, `autoReply`,
 * `autoDraft`, `agentSystemPrompt`. It is `.strict()` — an unknown key is a
 * caller mistake or an injection attempt, and silently persisting it in R2 is
 * how the blob became untyped in the first place.
 *
 * Deliberately absent, because neither is stored here: remote-image trust
 * (per-device, `localStorage` — see `app/hooks/useRemoteImageStore.ts`) and the
 * signature list (per-mailbox SQLite; the `signature` key below is the older
 * single-signature form that `getSignatureBlock` still falls back to).
 *
 * It lives in `shared/` rather than `workers/lib/schemas.ts` for the same
 * reason `auto-reply.ts` and `forwarding.ts` do: the settings screen builds
 * these objects and the Worker validates them, and a second declaration of the
 * shape is a second thing to forget to update.
 */

import { z } from "zod";
import { FOLLOWUP_DEFAULTS, type FollowupDefault } from "./followups";
import {
	DEFAULT_DAILY_AI_CAP,
	MAX_DAILY_AI_CAP,
	SCREENER_MODES,
	type ScreenerMode,
} from "./ai-triage";
import {
	AGENT_SEND_ALLOWLIST_MAX,
	AGENT_SEND_MODES,
	DEFAULT_AGENT_SEND_MODE,
	isAgentSendMode,
	normalizeAllowlist,
	normalizeAllowlistEntry,
	type AgentSendMode,
} from "./agent-send-policy";

/**
 * Ceiling on a custom agent prompt.
 *
 * The built-in `DEFAULT_SYSTEM_PROMPT` is ~2700 characters, so an operator
 * replacing it wholesale needs comparable room; 4000 leaves roughly 50% headroom
 * on top of that. The cap is not about storage — it keeps the operator-supplied
 * half of the prompt a bounded fraction of the context window, so a very long
 * prompt cannot crowd out the message the agent is supposed to be reading, and
 * cannot quietly multiply the token cost of every inbound message.
 */
export const AGENT_SYSTEM_PROMPT_MAX_LENGTH = 4000;

/** Display names and subjects. Long enough for any real one, short enough to log. */
export const SETTINGS_NAME_MAX_LENGTH = 200;

/** RFC 5321's maximum forward-path length. */
export const FORWARDING_EMAIL_MAX_LENGTH = 320;

/** Free-text bodies: the away notice and the fallback signature. */
export const SETTINGS_BODY_MAX_LENGTH = 20_000;

/**
 * C0 and C1 control characters, keeping `\t` (U+0009), `\n` (U+000A) and `\r`
 * (U+000D) — a prompt and an away notice are both legitimately multi-line.
 *
 * Everything else in those ranges is either invisible or actively harmful: a
 * stray NUL truncates strings in some consumers, and an ESC in a value that
 * reaches a log or a terminal is an escape-sequence injection.
 */
const CONTROL_CHARACTERS =
	/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Invisible formatting characters outside the C0/C1 ranges.
 *
 * Stripped for the same reason as the control characters: "invisible" is the
 * property that matters, not which block the codepoint lives in.
 *
 * - U+2028/U+2029 (line/paragraph separator) are newlines that most editors and
 *   diffs do not render as such, so text after one can hide from an operator
 *   reading the value while still taking effect as a new line in a prompt.
 * - U+202A–U+202E and U+2066–U+2069 (bidi embedding and override) reorder how
 *   the rest of the string *displays* without changing what it says. Someone
 *   reviewing a prompt in the settings screen can be shown one instruction while
 *   the model receives another.
 * - U+200B (zero-width space) and U+FEFF (BOM as zero-width no-break space) are
 *   invisible padding, usable to slip a word past a substring check.
 *
 * Deliberately NOT stripped: U+200C and U+200D (zero-width non-joiner/joiner).
 * They are invisible too, but they are load-bearing in real writing — Devanagari
 * and Tamil conjuncts depend on them, and emoji families are ZWJ sequences.
 * Removing them would corrupt legitimate names and signatures, which is worse
 * than the marginal obfuscation they allow.
 */
const INVISIBLE_FORMATTING =
	/[\u200B\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Drop characters that are invisible or harmful, keeping tabs and newlines.
 *
 * Applies to every operator-supplied string rather than only the agent prompt: a
 * display name and an away notice both reach outgoing headers and bodies, where
 * the same obfuscation tricks apply.
 */
export function stripControlCharacters(value: string): string {
	return value
		.replace(CONTROL_CHARACTERS, "")
		.replace(INVISIBLE_FORMATTING, "");
}

/**
 * Make a stored prompt safe to concatenate into a system prompt.
 *
 * Truncates rather than rejects, because this also runs at the point of use on
 * blobs written before this schema existed: refusing to load them would take the
 * mailbox's agent down instead of merely trimming its prompt.
 *
 * "Safe" here means the text cannot smuggle in an invisible line break or
 * reorder its own display. It does not mean the content is trustworthy — a
 * prompt is instructions from an operator to their own agent, and nothing here
 * can stop an operator instructing their agent badly.
 */
export function sanitizeAgentSystemPrompt(value: string): string {
	return stripControlCharacters(value).slice(0, AGENT_SYSTEM_PROMPT_MAX_LENGTH);
}

// ── Field schemas ──────────────────────────────────────────────────

/**
 * Any operator-supplied string that ends up in a header, a prompt, or a log.
 * Control characters are stripped before the length check, so the limit applies
 * to what is actually kept.
 */
function sanitizedText(maxLength: number, label: string) {
	return z
		.string()
		.transform(stripControlCharacters)
		.refine((value) => value.length <= maxLength, {
			message: `${label} must be ${maxLength} characters or fewer`,
		});
}

const AgentSystemPromptSchema = sanitizedText(
	AGENT_SYSTEM_PROMPT_MAX_LENGTH,
	"Agent prompt",
);

/**
 * Deliberately not `z.string().email()`.
 *
 * Empty is the disabled state and would fail that check, and `shared/forwarding.ts`
 * documents why the target is matched loosely at decision time: it is
 * operator-entered configuration, and rejecting an unusual but valid address
 * would break forwarding with no way for the operator to tell why. `decideForward`
 * is what refuses to send to a malformed target.
 */
const ForwardingEmailSchema = sanitizedText(
	FORWARDING_EMAIL_MAX_LENGTH,
	"Forwarding address",
);

/**
 * An auto-reply window bound: anything `Date.parse` understands, or null for
 * "no bound". Matched to `withinWindow`, which ignores a value it cannot parse
 * rather than refusing to reply at all.
 */
const WindowBoundSchema = z
	.string()
	.refine((value) => Number.isFinite(Date.parse(value)), {
		message: "must be a date the runtime can parse",
	})
	.nullable();

// ── Resolved shape ─────────────────────────────────────────────────

/**
 * Settings with every key present.
 *
 * Readers get this rather than the stored blob, so nothing downstream has to
 * decide what a missing `autoReply` or an absent `autoDraft.enabled` means.
 */
export interface ResolvedMailboxSettings {
	/** Display name on outgoing mail. */
	fromName: string;
	forwarding: { enabled: boolean; email: string };
	signature: { enabled: boolean; text: string; html: string };
	autoReply: {
		enabled: boolean;
		subject: string;
		message: string;
		startsAt: string | null;
		endsAt: string | null;
		knownSendersOnly: boolean;
	};
	autoDraft: { enabled: boolean };
	/**
	 * Follow-up reminders on sent mail. `default` is what the composer starts
	 * from (and what an API send with no `followup` field gets); `draftNudge`
	 * asks the agent to draft a short nudge when a reminder fires. Never sends.
	 */
	followups: { default: FollowupDefault; draftNudge: boolean };
	/**
	 * AI triage (see shared/ai-triage.ts). `enabled` turns on auto-labelling
	 * with the label prompts; `dailyAiCap` bounds Workers AI calls per UTC day
	 * across triage; `screenerVerdict` asks the model what a screened sender
	 * looks like. Header heuristics run whenever `enabled` is on and cost nothing.
	 */
	triage: { enabled: boolean; dailyAiCap: number; screenerVerdict: boolean };
	/** `unknown_only` files mail from first-time senders into the Screener. */
	screener: ScreenerMode;
	/** Empty means "use the built-in prompt". */
	agentSystemPrompt: string;
	/**
	 * Whether agent and MCP sends need a person's approval. See
	 * `shared/agent-send-policy.ts`. Defaults to `approve`.
	 */
	agentSend: { mode: AgentSendMode; allowlist: string[] };
}

/**
 * Defaults for a mailbox with no stored settings.
 *
 * `autoDraft.enabled` is true because auto-draft is opt-*out*: mailboxes created
 * before the setting existed keep drafting as they always did, and
 * `isAutoDraftEnabled` encodes the same rule.
 */
export function defaultMailboxSettings(fromName = ""): ResolvedMailboxSettings {
	return {
		fromName,
		forwarding: { enabled: false, email: "" },
		signature: { enabled: false, text: "", html: "" },
		autoReply: {
			enabled: false,
			subject: "",
			message: "",
			startsAt: null,
			endsAt: null,
			knownSendersOnly: false,
		},
		autoDraft: { enabled: true },
		followups: { default: "off", draftNudge: false },
		triage: { enabled: false, dailyAiCap: DEFAULT_DAILY_AI_CAP, screenerVerdict: true },
		screener: "off",
		agentSystemPrompt: "",
		agentSend: { mode: DEFAULT_AGENT_SEND_MODE, allowlist: [] },
	};
}

// ── Request schema ─────────────────────────────────────────────────

/**
 * What a caller may send to create or update settings.
 *
 * Every key is optional and every group is partial, because the update route
 * patches: the settings screen saves identity, auto-reply and forwarding
 * together while the inbox list toggles `autoDraft` alone, and neither should
 * have to resend the other's fields to avoid destroying them.
 *
 * `.strict()` at both levels. An unknown key is rejected rather than stored, so
 * the blob cannot grow fields again that nothing reads and nothing validates.
 */
export const MailboxSettingsPatchSchema = z
	.object({
		fromName: sanitizedText(SETTINGS_NAME_MAX_LENGTH, "Display name"),
		forwarding: z
			.object({ enabled: z.boolean(), email: ForwardingEmailSchema })
			.partial()
			.strict(),
		signature: z
			.object({
				enabled: z.boolean(),
				text: sanitizedText(SETTINGS_BODY_MAX_LENGTH, "Signature"),
				html: z.string().max(SETTINGS_BODY_MAX_LENGTH),
			})
			.partial()
			.strict(),
		autoReply: z
			.object({
				enabled: z.boolean(),
				subject: sanitizedText(SETTINGS_NAME_MAX_LENGTH, "Auto-reply subject"),
				message: sanitizedText(SETTINGS_BODY_MAX_LENGTH, "Auto-reply message"),
				startsAt: WindowBoundSchema,
				endsAt: WindowBoundSchema,
				knownSendersOnly: z.boolean(),
			})
			.partial()
			.strict(),
		autoDraft: z.object({ enabled: z.boolean() }).partial().strict(),
		followups: z
			.object({ default: z.enum(FOLLOWUP_DEFAULTS), draftNudge: z.boolean() })
			.partial()
			.strict(),
		triage: z
			.object({
				enabled: z.boolean(),
				dailyAiCap: z.number().int().min(0).max(MAX_DAILY_AI_CAP),
				screenerVerdict: z.boolean(),
			})
			.partial()
			.strict(),
		screener: z.enum(SCREENER_MODES),
		agentSystemPrompt: AgentSystemPromptSchema,
		agentSend: z
			.object({
				mode: z.enum(AGENT_SEND_MODES),
				allowlist: z
					.array(
						z.string().refine((v) => normalizeAllowlistEntry(v) !== null, {
							message: "must be an email address or a domain like example.com",
						}),
					)
					.max(AGENT_SEND_ALLOWLIST_MAX)
					.transform(normalizeAllowlist),
			})
			.partial()
			.strict(),
	})
	.partial()
	.strict();

export type MailboxSettingsPatch = z.infer<typeof MailboxSettingsPatchSchema>;

/**
 * The settings shape the API hands back and the settings screen renders.
 *
 * Structurally `ResolvedMailboxSettings`; kept as a distinct name because the
 * client imports it as its own type rather than reaching into the Worker.
 */
export type MailboxSettings = ResolvedMailboxSettings;

/** The older single-signature form, still read as a fallback by the composer. */
export type SignatureSettings = ResolvedMailboxSettings["signature"];

// ── Stored blob ────────────────────────────────────────────────────

/**
 * The lenient counterpart to the request schema, for blobs already in R2.
 *
 * Every field carries `.catch(...)`, so one bad value degrades to its default
 * instead of discarding the whole object — a mailbox whose `autoReply` was
 * written as a string still keeps its display name and its forwarding target.
 * Unknown keys are stripped rather than rejected: blobs predating this schema
 * may hold anything, and a mailbox that cannot be read cannot be repaired.
 */
const StoredMailboxSettingsSchema = z
	.object({
		fromName: z.string().transform(stripControlCharacters).catch(""),
		forwarding: z
			.object({
				enabled: z.boolean().catch(false),
				email: z.string().transform(stripControlCharacters).catch(""),
			})
			.catch(() => ({ enabled: false, email: "" })),
		signature: z
			.object({
				enabled: z.boolean().catch(false),
				text: z.string().transform(stripControlCharacters).catch(""),
				html: z.string().catch(""),
			})
			.catch(() => ({ enabled: false, text: "", html: "" })),
		autoReply: z
			.object({
				enabled: z.boolean().catch(false),
				subject: z.string().transform(stripControlCharacters).catch(""),
				message: z.string().transform(stripControlCharacters).catch(""),
				startsAt: WindowBoundSchema.catch(null),
				endsAt: WindowBoundSchema.catch(null),
				knownSendersOnly: z.boolean().catch(false),
			})
			.catch(() => ({
				enabled: false,
				subject: "",
				message: "",
				startsAt: null,
				endsAt: null,
				knownSendersOnly: false,
			})),
		autoDraft: z
			.object({ enabled: z.boolean().catch(true) })
			.catch(() => ({ enabled: true })),
		followups: z
			.object({
				default: z.enum(FOLLOWUP_DEFAULTS).catch("off"),
				draftNudge: z.boolean().catch(false),
			})
			.catch(() => ({ default: "off" as const, draftNudge: false })),
		triage: z
			.object({
				enabled: z.boolean().catch(false),
				dailyAiCap: z.number().int().min(0).max(MAX_DAILY_AI_CAP).catch(DEFAULT_DAILY_AI_CAP),
				screenerVerdict: z.boolean().catch(true),
			})
			.catch(() => ({ enabled: false, dailyAiCap: DEFAULT_DAILY_AI_CAP, screenerVerdict: true })),
		screener: z.enum(SCREENER_MODES).catch("off"),
		// Truncated, not rejected: this is the value that reaches the model.
		agentSystemPrompt: z
			.string()
			.transform(sanitizeAgentSystemPrompt)
			.catch(""),
		// Absent on every blob written before the setting existed, which must
		// read as the safe default (`approve`), never as `auto`.
		agentSend: z
			.object({
				mode: z.unknown().transform((v) => (isAgentSendMode(v) ? v : DEFAULT_AGENT_SEND_MODE)),
				allowlist: z.unknown().transform(normalizeAllowlist),
			})
			.catch(() => ({ mode: DEFAULT_AGENT_SEND_MODE, allowlist: [] })),
	})
	.catch(() => defaultMailboxSettings());

/**
 * Read a stored settings blob into a fully-populated object.
 *
 * Never throws and never returns a partial object, because its callers are the
 * inbound email handler and the agent: a malformed blob must cost the mailbox
 * its customisations, not its mail.
 *
 * `onProblem` is called once with a description when the blob does not satisfy
 * the strict schema, so the fallback is visible in logs rather than silent.
 */
export function parseStoredMailboxSettings(
	raw: unknown,
	onProblem?: (description: string) => void,
): ResolvedMailboxSettings {
	if (onProblem) {
		const strict = MailboxSettingsPatchSchema.safeParse(raw);
		if (!strict.success) {
			onProblem(
				strict.error.issues
					.map((issue) => {
						const path = issue.path.join(".");
						return path ? `${path}: ${issue.message}` : issue.message;
					})
					.join("; "),
			);
		}
	}

	const result = StoredMailboxSettingsSchema.safeParse(raw);
	// `.catch()` on the root makes failure unreachable, but a schema edit must
	// not be able to turn this into a 500 on the inbound path.
	return result.success
		? { ...defaultMailboxSettings(), ...result.data }
		: defaultMailboxSettings();
}

/**
 * Apply a patch to resolved settings.
 *
 * Groups merge one level deep, so `{ autoDraft: { enabled: false } }` keeps the
 * away notice and `{ autoReply: { enabled: true } }` keeps the message already
 * written. Merging server-side also closes a lost update the clients used to
 * race on: both of them spread a snapshot of the whole blob because the route
 * replaced it wholesale, so two concurrent saves each reverted the other's field.
 */
export function mergeMailboxSettings(
	base: ResolvedMailboxSettings,
	patch: MailboxSettingsPatch,
): ResolvedMailboxSettings {
	return {
		fromName: patch.fromName ?? base.fromName,
		agentSystemPrompt: patch.agentSystemPrompt ?? base.agentSystemPrompt,
		forwarding: { ...base.forwarding, ...patch.forwarding },
		signature: { ...base.signature, ...patch.signature },
		autoReply: { ...base.autoReply, ...patch.autoReply },
		autoDraft: { ...base.autoDraft, ...patch.autoDraft },
		followups: { ...base.followups, ...patch.followups },
		triage: { ...base.triage, ...patch.triage },
		screener: patch.screener ?? base.screener,
		agentSend: { ...base.agentSend, ...patch.agentSend },
	};
}
