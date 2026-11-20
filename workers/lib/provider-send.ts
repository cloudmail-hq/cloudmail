// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Pieces the bring-your-own transports (./ses-transport.ts,
 * ./resend-transport.ts) share: the error they throw, the bounded retry
 * loop, and address formatting with header-injection checks.
 *
 * ## Two kinds of failure
 *
 * A {@link ProviderSendError} is either a definite rejection (the provider
 * said no before accepting, so nothing was sent; `E_SES_*` / `E_RESEND_*`) or
 * unconfirmed (`E_SES_UNCONFIRMED` / `E_RESEND_UNCONFIRMED`: a 5xx, a timeout,
 * a dropped connection or an unreadable success, after which the message may
 * have gone out). An unconfirmed send is never retried by the app; the
 * provider's events settle it through the `cm_send` tag the error carries.
 */

import { SendValidationError } from "../../shared/send-validation";
import type { SendingProvider } from "../../shared/ses-sending";

export const UNCONFIRMED_CODES = ["E_SES_UNCONFIRMED", "E_RESEND_UNCONFIRMED"] as const;

/** A send the provider refused, or whose outcome is unknown. Never carries a credential. */
export class ProviderSendError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly provider: Exclude<SendingProvider, "cloudflare">,
		/** The `cm_send` tag the request carried; events for it settle an unconfirmed send. */
		readonly sendTag: string,
		/** HTTP status of the last attempt, when there was one. */
		readonly status: number | null = null,
	) {
		super(message);
		this.name = "ProviderSendError";
	}

	get unconfirmed(): boolean {
		return (UNCONFIRMED_CODES as readonly string[]).includes(this.code);
	}
}

/** True for an error after which the message may have been sent by a provider. */
export function isUnconfirmedProviderError(error: unknown): error is ProviderSendError {
	return error instanceof ProviderSendError
		? error.unconfirmed
		: !!error &&
				typeof error === "object" &&
				(UNCONFIRMED_CODES as readonly string[]).includes(String((error as { code?: unknown }).code));
}

/** The `cm_send` tag on a thrown provider error, if any. */
export function sendTagOf(error: unknown): string | null {
	const tag = error && typeof error === "object" ? (error as { sendTag?: unknown }).sendTag : null;
	return typeof tag === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(tag) ? tag : null;
}

/** Overridable in tests. */
export const providerSendDeps = {
	sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	random: () => Math.random(),
	/** Per-attempt timeout. */
	timeoutMs: 15_000,
	/** At most this many retries after the first attempt. */
	maxRetries: 2,
};

/** Full-jitter backoff: `random() * min(cap, base * 2^n)` (AWS retry guidance). */
export function backoffMs(retry: number, baseMs = 1000, capMs = 20_000): number {
	return Math.floor(providerSendDeps.random() * Math.min(capMs, baseMs * 2 ** retry));
}

/** `fetch` with an abort after `providerSendDeps.timeoutMs`. Rejects with an AbortError on timeout. */
export async function fetchWithTimeout(
	fetchImpl: typeof fetch,
	input: Request | string,
	init: RequestInit = {},
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), providerSendDeps.timeoutMs);
	try {
		return await fetchImpl(input, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

// -- addresses ---------------------------------------------------------------------

const ASCII_PRINTABLE = /^[ -~]*$/;

function invalidAddress(detail: string): SendValidationError {
	return new SendValidationError("E_HEADER_VALUE_INVALID", `Invalid address: ${detail}`);
}

/** RFC 2047 encoded-word for a display name (UTF-8, base64), split at 75 characters. */
export function encodeDisplayName(name: string): string {
	if (ASCII_PRINTABLE.test(name)) {
		// A quoted-string; escape `\` and `"`.
		return `"${name.replace(/(["\\])/g, "\\$1")}"`;
	}
	const bytes = new TextEncoder().encode(name);
	const words: string[] = [];
	let i = 0;
	while (i < bytes.length) {
		let end = Math.min(i + 45, bytes.length);
		while (end < bytes.length && end > i && (bytes[end]! & 0xc0) === 0x80) end--;
		let bin = "";
		for (const b of bytes.subarray(i, end)) bin += String.fromCharCode(b);
		words.push(`=?UTF-8?B?${btoa(bin)}?=`);
		i = end;
	}
	return words.join(" ");
}

/** Punycode the domain of an address. The local part must already be 7-bit (SES rule). */
export function asciiAddress(address: string): string {
	const addr = address.trim();
	if (/[\r\n\0]/.test(addr)) throw invalidAddress("line break in an address");
	const at = addr.lastIndexOf("@");
	if (at <= 0 || at === addr.length - 1) throw invalidAddress(`'${addr.slice(0, 80)}'`);
	const local = addr.slice(0, at);
	const domain = addr.slice(at + 1);
	if (!/^[!-~]+$/.test(local) || /[<>\s,]/.test(local)) {
		throw invalidAddress(`the part before @ must be plain ASCII ('${addr.slice(0, 80)}')`);
	}
	let host = domain.toLowerCase();
	if (!/^[a-z0-9.-]+$/.test(host)) {
		try {
			host = new URL(`http://${domain}`).hostname;
		} catch {
			throw invalidAddress(`'${addr.slice(0, 80)}'`);
		}
		if (!/^[a-z0-9.-]+$/.test(host)) throw invalidAddress(`'${addr.slice(0, 80)}'`);
	}
	return `${local}@${host}`;
}

/** `Name <addr>` or `addr`, parsed; refuses line breaks anywhere. */
export function parseAddress(raw: string): { name: string | null; email: string } {
	if (/[\r\n\0]/.test(raw)) throw invalidAddress("line break in an address");
	const m = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(raw);
	if (m) {
		const name = m[1]!.replace(/^"(.*)"$/, "$1").trim();
		return { name: name || null, email: m[2]!.trim() };
	}
	return { name: null, email: raw.trim() };
}

/** One address for a provider: ASCII address, encoded display name when there is one. */
export function formatAddress(value: string | { email: string; name?: string | null }): string {
	const { name, email } = typeof value === "string" ? parseAddress(value) : { name: value.name ?? null, email: value.email };
	if (name && /[\r\n\0]/.test(name)) throw invalidAddress("line break in a display name");
	const addr = asciiAddress(email);
	return name ? `${encodeDisplayName(name)} <${addr}>` : addr;
}

/** An address field (string, comma list or array) as a list of formatted addresses. */
export function formatAddressList(value: string | string[] | undefined | null): string[] {
	if (!value) return [];
	const list = Array.isArray(value) ? value : splitAddressList(value);
	return list.map((a) => a.trim()).filter(Boolean).map((a) => formatAddress(a));
}

/** Split a comma list, keeping commas inside quoted display names. */
function splitAddressList(value: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quoted = false;
	for (const ch of value) {
		if (ch === '"') quoted = !quoted;
		if (ch === "," && !quoted) {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	out.push(cur);
	return out;
}

/** A subject line safe for a provider: line breaks folded to spaces. */
export function oneLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ");
}

/** A tag value: `[A-Za-z0-9_-]`, at most 256 characters (SES and Resend rule). */
export function tagValue(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) || "_";
}

/** A fresh `cm_send` tag. */
export function newSendTag(): string {
	return crypto.randomUUID();
}
