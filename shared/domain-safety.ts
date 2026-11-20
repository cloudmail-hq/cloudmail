// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Domain comparisons for spotting impersonation.
 *
 * Three questions, each answered by a pure function:
 *
 * - Do two hostnames belong to the same organisation? Answered with the Public
 *   Suffix List (`tldts`), because "the last two labels" is wrong for
 *   `example.co.uk` and for every `*.github.io` site.
 * - Is a hostname written with characters chosen to look like another script?
 *   IDN labels arrive as punycode (`xn--…`); they are decoded, checked for
 *   mixed scripts (UTS #39 §5.1) and reduced to a skeleton of their Latin
 *   lookalikes (a small subset of the UTS #39 §4 confusables table).
 * - Is a hostname one or two edits away from a domain the reader trusts?
 *
 * Worker-only in practice: `tldts` carries the suffix list, so the client
 * bundle reads stored verdicts instead of importing this.
 */

import { getDomain, parse } from "tldts";

/** Lowercase, strip a trailing dot and surrounding brackets/whitespace. */
export function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** Registrable domain (`a.b.example.co.uk` → `example.co.uk`), else the host. */
export function registrableDomain(host: string): string {
	const h = normalizeHost(host);
	if (!h) return "";
	return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

/** Whether two hostnames share a registrable domain. */
export function sameOrganization(a: string, b: string): boolean {
	const ra = registrableDomain(a);
	const rb = registrableDomain(b);
	return !!ra && ra === rb;
}

/** Whether `text` is a hostname with a real (ICANN) public suffix. */
export function isRealHostname(text: string): boolean {
	const h = normalizeHost(text);
	if (!/^[a-z0-9¡-￿-]+(\.[a-z0-9¡-￿-]+)+$/i.test(h)) return false;
	const info = parse(h);
	return !!info.domain && info.isIcann === true && !info.isIp;
}

// ── Punycode (RFC 3492), decode only ─────────────────────────────────

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;

function adapt(delta: number, numPoints: number, first: boolean): number {
	let d = first ? Math.floor(delta / DAMP) : delta >> 1;
	d += Math.floor(d / numPoints);
	let k = 0;
	while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
		d = Math.floor(d / (BASE - T_MIN));
		k += BASE;
	}
	return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

function digitOf(code: number): number {
	if (code >= 48 && code <= 57) return code - 22; // 0-9 → 26-35
	if (code >= 65 && code <= 90) return code - 65; // A-Z
	if (code >= 97 && code <= 122) return code - 97; // a-z
	return BASE;
}

/** Decode one punycode label body (without `xn--`). Null when malformed. */
export function decodePunycode(input: string): string | null {
	const output: number[] = [];
	const basicEnd = Math.max(input.lastIndexOf("-"), 0);
	for (let j = 0; j < basicEnd; j++) {
		const c = input.charCodeAt(j);
		if (c >= 0x80) return null;
		output.push(c);
	}
	let n = 128;
	let i = 0;
	let bias = 72;
	for (let idx = basicEnd > 0 ? basicEnd + 1 : 0; idx < input.length; ) {
		const oldI = i;
		let w = 1;
		for (let k = BASE; ; k += BASE) {
			if (idx >= input.length) return null;
			const digit = digitOf(input.charCodeAt(idx++));
			if (digit >= BASE) return null;
			i += digit * w;
			if (i > 0x7fffffff) return null;
			const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
			if (digit < t) break;
			w *= BASE - t;
			if (w > 0x7fffffff) return null;
		}
		const len = output.length + 1;
		bias = adapt(i - oldI, len, oldI === 0);
		n += Math.floor(i / len);
		if (n > 0x10ffff) return null;
		i %= len;
		output.splice(i, 0, n);
		i++;
	}
	try {
		return String.fromCodePoint(...output);
	} catch {
		return null;
	}
}

/** Hostname with each `xn--` label decoded. Malformed labels are left as is. */
export function toUnicodeHost(host: string): string {
	return normalizeHost(host)
		.split(".")
		.map((label) =>
			label.startsWith("xn--") ? (decodePunycode(label.slice(4)) ?? label) : label,
		)
		.join(".");
}

export function hasPunycode(host: string): boolean {
	return normalizeHost(host).split(".").some((l) => l.startsWith("xn--"));
}

// ── Scripts and confusables ──────────────────────────────────────────

const SCRIPT_TESTS: [string, RegExp][] = [
	["latin", /\p{Script=Latin}/u],
	["cyrillic", /\p{Script=Cyrillic}/u],
	["greek", /\p{Script=Greek}/u],
	["armenian", /\p{Script=Armenian}/u],
	["cjk", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u],
	["arabic", /\p{Script=Arabic}/u],
	["hebrew", /\p{Script=Hebrew}/u],
	["thai", /\p{Script=Thai}/u],
	["devanagari", /\p{Script=Devanagari}/u],
	["georgian", /\p{Script=Georgian}/u],
	["cherokee", /\p{Script=Cherokee}/u],
];

/** Distinct scripts in a label, ignoring Common/Inherited (digits, hyphen). */
export function scriptsOf(label: string): Set<string> {
	const found = new Set<string>();
	for (const ch of label) {
		for (const [name, re] of SCRIPT_TESTS) {
			if (re.test(ch)) {
				found.add(name);
				break;
			}
		}
	}
	return found;
}

/** Whether any label mixes scripts, the classic `pаypal` (Cyrillic а) trick. */
export function isMixedScript(host: string): boolean {
	return toUnicodeHost(host)
		.split(".")
		.some((label) => scriptsOf(label).size > 1);
}

/**
 * Characters that render like a Latin letter, mapped to that letter.
 *
 * A subset of the UTS #39 confusables table: the Cyrillic, Greek and Armenian
 * letters that are pixel-identical to Latin in common UI fonts, plus the ASCII
 * digit and letter swaps typosquatters use.
 */
const CONFUSABLES: Record<string, string> = {
	// Cyrillic
	"а": "a", "в": "b", "с": "c", "ԁ": "d", "е": "e", "һ": "h", "і": "i", "ј": "j",
	"к": "k", "ӏ": "l", "м": "m", "п": "n", "о": "o", "р": "p", "ԛ": "q", "г": "r",
	"ѕ": "s", "т": "t", "ц": "u", "ѵ": "v", "ԝ": "w", "х": "x", "у": "y", "ь": "b",
	"ё": "e", "ї": "i", "ӧ": "o", "ӱ": "y",
	// Greek
	"α": "a", "β": "b", "ϲ": "c", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v",
	"ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "γ": "y", "ω": "w",
	// Armenian
	"օ": "o", "ս": "u", "հ": "h", "ո": "n", "ց": "g", "զ": "q",
	// Latin lookalikes
	"ɡ": "g", "ı": "i", "ɩ": "i", "ł": "l",
};

/**
 * ASCII characters typosquatters swap for one another, folded to one form after
 * the table above, so `stripe`, `str1pe` and `strіpe` (Cyrillic і) agree.
 */
function foldAscii(text: string): string {
	return text
		.replace(/[il1|]/g, "l")
		.replace(/0/g, "o")
		.replace(/rn/g, "m")
		.replace(/vv/g, "w");
}

/**
 * A comparison form: decoded, NFKC-folded, every lookalike mapped to the Latin
 * letter it imitates, and `rn`/`vv` folded to `m`/`w`. Two hosts with equal
 * skeletons look the same to a reader.
 */
export function skeleton(host: string): string {
	const unicode = toUnicodeHost(host).normalize("NFKC").toLowerCase();
	let out = "";
	for (const ch of unicode) out += CONFUSABLES[ch] ?? ch;
	return foldAscii(out);
}

/** Whether every non-ASCII letter in the host maps to a Latin lookalike. */
function isWholeScriptConfusable(host: string): boolean {
	const unicode = toUnicodeHost(host);
	let sawNonAscii = false;
	for (const ch of unicode) {
		if (ch.charCodeAt(0) < 0x80) continue;
		sawNonAscii = true;
		if (!CONFUSABLES[ch]) return false;
	}
	return sawNonAscii;
}

/**
 * Optimal string alignment distance (Levenshtein plus adjacent transposition),
 * stopping early once it exceeds `max`.
 */
export function editDistance(a: string, b: string, max = 3): number {
	if (a === b) return 0;
	if (Math.abs(a.length - b.length) > max) return max + 1;
	const rows: number[][] = [];
	for (let i = 0; i <= a.length; i++) {
		rows.push(new Array(b.length + 1).fill(0));
		rows[i]![0] = i;
	}
	for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
	for (let i = 1; i <= a.length; i++) {
		let rowMin = Infinity;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let v = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				v = Math.min(v, rows[i - 2]![j - 2]! + 1);
			}
			rows[i]![j] = v;
			rowMin = Math.min(rowMin, v);
		}
		if (rowMin > max) return max + 1;
	}
	return rows[a.length]![b.length]!;
}

/** The registrable domain without its public suffix (`example.co.uk` → `example`). */
function nameOf(host: string): string {
	const info = parse(normalizeHost(host), { allowPrivateDomains: true });
	return info.domainWithoutSuffix ?? normalizeHost(host).split(".")[0] ?? "";
}

export type LookalikeReason =
	| "homograph" // decodes to characters that imitate another domain
	| "mixed_script" // an IDN label mixing scripts, whatever it imitates
	| "typo" // one or two edits from a trusted domain
	| "suffix_swap" // same name, different ending (`acme.co` vs `acme.com`)
	| "embedded"; // a trusted domain used as a subdomain (`paypal.com.evil.xyz`)

export interface LookalikeMatch {
	reason: LookalikeReason;
	/** The trusted domain being imitated, when there is one. */
	imitates?: string;
	/** The host as a reader would see it, decoded. */
	display: string;
}

/**
 * Whether `host` imitates one of `trusted`, or is an IDN built to deceive.
 *
 * `trusted` is the reader's own domains and their frequent correspondents. A
 * host in the same organisation as a trusted domain never matches: mail from
 * `news.example.com` is not a lookalike of `example.com`.
 */
export function findLookalike(host: string, trusted: readonly string[]): LookalikeMatch | null {
	const h = normalizeHost(host);
	if (!h || !h.includes(".")) return null;
	const display = toUnicodeHost(h);
	const reg = registrableDomain(h);
	const trustedRegs = [...new Set(trusted.map(registrableDomain).filter(Boolean))];
	if (trustedRegs.includes(reg)) return null;

	const regSkeleton = skeleton(reg);
	const regName = nameOf(reg);
	const idn = hasPunycode(h) || /[^\x00-\x7f]/.test(h);

	for (const t of trustedRegs) {
		if (regSkeleton === skeleton(t)) {
			return { reason: idn ? "homograph" : "typo", imitates: t, display };
		}
	}
	for (const t of trustedRegs) {
		const tName = nameOf(t);
		if (tName.length >= 4 && regName === tName) {
			return { reason: "suffix_swap", imitates: t, display };
		}
		// Length gates on the name, not the whole domain: `ab.com`/`ac.com` are
		// one edit apart and unrelated. Short names have too many neighbours.
		const d = editDistance(reg, t, 2);
		if ((d === 1 && tName.length >= 5) || (d === 2 && tName.length >= 8)) {
			return { reason: "typo", imitates: t, display };
		}
		// `paypal.com.secure-login.xyz`: the trusted domain appears as labels
		// in front of an unrelated registrable domain.
		const prefix = h.slice(0, Math.max(0, h.length - reg.length - 1));
		if (tName.length >= 4 && (`.${prefix}.`.includes(`.${t}.`) || prefix.split(/[.-]/).includes(tName))) {
			return { reason: "embedded", imitates: t, display };
		}
	}
	if (idn && isMixedScript(h)) return { reason: "mixed_script", display };
	if (idn && isWholeScriptConfusable(h)) return { reason: "homograph", display };
	return null;
}
