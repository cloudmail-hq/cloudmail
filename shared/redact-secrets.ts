// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mask likely secrets in a preview line.
 *
 * Snippets are shown to anyone glancing at the list, the People view and MCP
 * clients, none of which need the password a customer pasted into a support
 * thread. The full message still has it; only previews are masked.
 *
 * Pure and regex based so it runs in the Worker, the browser and Node tests.
 * It errs on the side of masking: a hidden word in a preview costs nothing,
 * a leaked credential costs a lot.
 */

export const REDACTED = "•••";

/** "password: hunter2", "pwd=…", "passcode – 1234", "api key: …". */
const LABELLED_SECRET =
	/\b(pass(?:word|wd|code|phrase)|pwd|pin|secret|api[ _-]?key|access[ _-]?key|secret[ _-]?key|token|auth[ _-]?token|private[ _-]?key|client[ _-]?secret)(\s*[:=]\s*|\s+(?:is|-|–|—)\s+)(\S+)/gi;

/** "code: 123456", "verification code is 482913", "OTP 1234". */
const OTP_CODE =
	/\b(code|otp|one[- ]time (?:code|password)|verification code|security code|2fa)(\s*(?:is|:|=|-|–|—)?\s*)([A-Z0-9]{4,10}|\d{3}[ -]\d{3})\b/gi;

/** Prefixed provider tokens: Stripe, OpenAI, our own, GitHub, Slack, AWS, Google. */
const PREFIXED_TOKEN =
	/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\bttk_[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}/g;

/** Long hex (32+) or base64-ish (40+ with a digit) runs: keys, hashes, JWT parts. */
const LONG_HEX = /\b[A-Fa-f0-9]{32,}\b/g;
const LONG_B64 = /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}={0,2}/g;

/** 13–19 digits, optionally grouped by spaces or dashes, passing Luhn. */
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhn(digits: string): boolean {
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits.charCodeAt(i) - 48;
		if (double) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		double = !double;
	}
	return sum % 10 === 0;
}

/** Return `text` with likely secrets replaced by `•••`. */
export function redactSecrets(text: string | null | undefined): string {
	if (!text) return "";
	return text
		.replace(PREFIXED_TOKEN, REDACTED)
		.replace(LABELLED_SECRET, (_m, label, sep) => `${label}${sep}${REDACTED}`)
		.replace(OTP_CODE, (m, label, sep, value: string) =>
			/\d/.test(value) ? `${label}${sep}${REDACTED}` : m,
		)
		.replace(CARD_CANDIDATE, (m) => {
			const digits = m.replace(/[ -]/g, "");
			return digits.length >= 13 && digits.length <= 19 && luhn(digits)
				? REDACTED
				: m;
		})
		.replace(LONG_HEX, REDACTED)
		.replace(LONG_B64, REDACTED);
}

/**
 * The Drafts-folder preview: the first line only, cut short and masked.
 *
 * A draft is unsent work, often half-typed credentials or notes; the list only
 * needs enough to recognise which draft it is.
 */
export function draftPreview(text: string | null | undefined, max = 60): string {
	if (!text) return "";
	const firstLine = text.split(/\r?\n|(?<=[.!?])\s+/)[0]?.trim() ?? "";
	const masked = redactSecrets(firstLine);
	const points = Array.from(masked);
	return points.length <= max ? masked : `${points.slice(0, max).join("").trimEnd()}…`;
}
