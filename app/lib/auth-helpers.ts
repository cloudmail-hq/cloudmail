// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Pure helpers for the sign-in screens and the account settings.
 *
 * Kept free of React and browser globals so they can be unit tested in Node
 * (`test/auth-ui-helpers.test.ts`).
 */

/** Mirrors `PASSWORD_MIN_LENGTH` in `workers/auth/crypto.ts`. */
export const PASSWORD_MIN_LENGTH = 10;
/** Mirrors `PASSWORD_MAX_LENGTH` in `workers/auth/crypto.ts`. */
export const PASSWORD_MAX_LENGTH = 256;

/**
 * Pages that render without a session. A 401 seen while on one of these must
 * not bounce the browser to `/login`, or the sign-in page would loop on itself
 * (the branding request in `root.tsx` runs on every page).
 */
const PUBLIC_EXACT = new Set(["/login", "/setup", "/recover", "/forgot"]);
const PUBLIC_PREFIXES = ["/invite/", "/reset/"];

export function isPublicAuthPath(pathname: string): boolean {
	const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	if (PUBLIC_EXACT.has(path)) return true;
	return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Validate a post-login `next` target.
 *
 * Only same-origin relative paths: must start with a single `/`, and must not be
 * `//host` or `/\host` (browsers normalise the backslash to a slash, making it
 * protocol-relative). Anything else — absolute URLs, `javascript:`, control
 * characters, a path back into the sign-in pages — falls back to `/`.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/"): string {
	if (typeof next !== "string" || next.length === 0 || next.length > 2048) return fallback;
	if (!next.startsWith("/")) return fallback;
	if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
	// Tabs and newlines are stripped by the URL parser, so `/\t/evil.com` would
	// otherwise survive the checks above and resolve to another host.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
	if (/[\u0000-\u001f\u007f\\]/.test(next)) return fallback;

	const base = "https://tapetide.invalid";
	let url: URL;
	try {
		url = new URL(next, base);
	} catch {
		return fallback;
	}
	if (url.origin !== base) return fallback;
	// Re-check after parsing. Dot segments collapse during resolution, so
	// `/.//evil.com` and `/a/..//evil.com` pass the raw-string checks above but
	// resolve to the pathname `//evil.com` — which, handed back to the browser as
	// a relative URL, is protocol-relative and leaves this origin.
	if (url.pathname.startsWith("//")) return fallback;
	if (isPublicAuthPath(url.pathname)) return fallback;
	return `${url.pathname}${url.search}${url.hash}`;
}

/** The sign-in URL for a page, carrying it as `next` unless it is itself public. */
export function loginUrlFor(pathname: string, search = ""): string {
	if (isPublicAuthPath(pathname) || pathname === "/") return "/login";
	return `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
}

export type PasswordStrength = {
	/** 0 (unusable) to 4 (strong). */
	score: 0 | 1 | 2 | 3 | 4;
	label: "Too short" | "Weak" | "Fair" | "Good" | "Strong";
	/** Short, actionable suggestions. Empty once the password is strong. */
	hints: string[];
	/** Whether the server will accept it (length only — the server decides). */
	acceptable: boolean;
};

/**
 * A rough strength estimate for the hint under a new-password field.
 *
 * Deliberately simple and advisory: the server's `validatePassword` is the only
 * rule that is enforced, and it checks length. Length dominates the score here
 * too, because it is what actually makes a password expensive to guess.
 */
export function passwordStrength(password: string, context: string[] = []): PasswordStrength {
	const length = [...password].length;
	const hints: string[] = [];

	if (length < PASSWORD_MIN_LENGTH) {
		const missing = PASSWORD_MIN_LENGTH - length;
		return {
			score: 0,
			label: "Too short",
			hints: [`Add ${missing} more character${missing === 1 ? "" : "s"} (minimum ${PASSWORD_MIN_LENGTH}).`],
			acceptable: false,
		};
	}

	const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
		re.test(password),
	).length;

	let score = 1;
	if (length >= 14) score++;
	if (length >= 20) score++;
	if (classes >= 3) score++;
	else if (length < 20) hints.push("Mix in upper case, numbers or symbols, or make it longer.");

	const lower = password.toLowerCase();
	const repetitive = /^(.)\1+$/.test(password) || new Set(lower).size <= 3;
	const sequence = /(0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|password)/.test(lower);
	const personal = context
		.map((value) => value.trim().toLowerCase())
		.flatMap((value) => [value, value.split("@")[0]])
		.filter((value) => value.length >= 3)
		.some((value) => lower.includes(value));

	if (repetitive) {
		score = 1;
		hints.push("Avoid repeating the same few characters.");
	}
	if (sequence) {
		score = Math.max(1, score - 1);
		hints.push("Avoid common words and sequences like 1234 or qwerty.");
	}
	if (personal) {
		score = Math.max(1, score - 1);
		hints.push("Don't include your name or email address.");
	}
	if (score < 3 && length < 14 && hints.length === 0) {
		hints.push("A longer passphrase of a few unrelated words is easy to remember and hard to guess.");
	}

	const clamped = Math.min(4, Math.max(1, score)) as 1 | 2 | 3 | 4;
	const labels = { 1: "Weak", 2: "Fair", 3: "Good", 4: "Strong" } as const;
	return { score: clamped, label: labels[clamped], hints, acceptable: true };
}

/**
 * Turn a `retryAfter` from a `locked` / `rate_limited` response into words.
 *
 * The value is read as seconds (the `Retry-After` convention). A value that can
 * only be an epoch timestamp in milliseconds is accepted too, so the copy stays
 * right whichever the server sends.
 */
export function formatRetryAfter(retryAfter: unknown, nowMs = Date.now()): string {
	let seconds = typeof retryAfter === "number" ? retryAfter : Number(retryAfter);
	if (!Number.isFinite(seconds) || seconds <= 0) return "in a moment";
	if (seconds > 1e12) seconds = (seconds - nowMs) / 1000;
	if (seconds <= 0) return "in a moment";
	if (seconds < 60) {
		const s = Math.ceil(seconds);
		return `in ${s} second${s === 1 ? "" : "s"}`;
	}
	if (seconds < 3600) {
		const m = Math.ceil(seconds / 60);
		return `in ${m} minute${m === 1 ? "" : "s"}`;
	}
	const h = Math.ceil(seconds / 3600);
	return `in ${h} hour${h === 1 ? "" : "s"}`;
}

/** "3 minutes ago", "in 4 days", "just now". Millisecond timestamps. */
export function formatRelativeTime(ms: number | null | undefined, nowMs = Date.now()): string {
	if (ms == null || !Number.isFinite(ms)) return "never";
	const diff = ms - nowMs;
	const abs = Math.abs(diff);
	if (abs < 45_000) return "just now";
	const units: [Intl.RelativeTimeFormatUnit, number][] = [
		["year", 365 * 86_400_000],
		["month", 30 * 86_400_000],
		["day", 86_400_000],
		["hour", 3_600_000],
		["minute", 60_000],
	];
	const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
	for (const [unit, size] of units) {
		if (abs >= size || unit === "minute") {
			return rtf.format(Math.round(diff / size), unit);
		}
	}
	return "just now";
}

/** "Chrome on macOS" from a user-agent string. Best effort; never throws. */
export function describeUserAgent(userAgent: string | null | undefined): string {
	if (!userAgent) return "Unknown device";
	const ua = userAgent;

	let client = "";
	// The CLI sends "cloudmail/<version>"; builds from before the rename send
	// "tapemail/<version>". Both are the same tool.
	if (/\b(?:cloudmail|tapemail)\//i.test(ua)) client = "cloudmail CLI";
	else if (/\bcurl\//i.test(ua)) client = "curl";
	else if (/Edg\//.test(ua)) client = "Edge";
	else if (/OPR\/|Opera/.test(ua)) client = "Opera";
	else if (/Firefox\//.test(ua)) client = "Firefox";
	else if (/Chrome\/|CriOS\//.test(ua)) client = "Chrome";
	else if (/Safari\//.test(ua)) client = "Safari";

	let os = "";
	if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
	else if (/Android/.test(ua)) os = "Android";
	else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
	else if (/Windows/.test(ua)) os = "Windows";
	else if (/CrOS/.test(ua)) os = "ChromeOS";
	else if (/Linux/.test(ua)) os = "Linux";

	if (client && os) return `${client} on ${os}`;
	if (client) return client;
	if (os) return `Browser on ${os}`;
	return ua.length > 48 ? `${ua.slice(0, 45)}...` : ua;
}

/** Normalise what someone typed into the MFA field. */
export function normalizeMfaInput(value: string, mode: "totp" | "recovery"): string {
	if (mode === "totp") return value.replace(/\D/g, "").slice(0, 6);
	return value.trim().toLowerCase().replace(/\s+/g, "");
}

/** Whether an email address looks plausible enough to submit. */
export interface SecondFactorStatus {
	/** Pill text. */
	label: string;
	tone: "success" | "warning" | "muted";
	/** One sentence on what actually protects the account. */
	detail: string;
}

/**
 * How the account's second factor reads in Account & security.
 *
 * A passkey is phishing-resistant and replaces both the password and a code,
 * so with passkeys and no authenticator the status is not "Off". It is not
 * "On" either: a password sign-in still goes straight in, because only an
 * authenticator app adds a step after the password.
 */
export function describeSecondFactor({
	totpEnabled,
	passkeyCount,
}: {
	totpEnabled: boolean;
	passkeyCount: number;
}): SecondFactorStatus {
	const keys = `${passkeyCount} passkey${passkeyCount === 1 ? "" : "s"}`;
	if (totpEnabled && passkeyCount > 0) {
		return {
			label: "On: app + passkeys",
			tone: "success",
			detail: `Password sign-ins ask for a code from your app, or one of your ${keys}.`,
		};
	}
	if (totpEnabled) {
		return { label: "On: authenticator app", tone: "success", detail: "Password sign-ins ask for a code from your app." };
	}
	if (passkeyCount > 0) {
		return {
			label: "Passkeys only",
			tone: "warning",
			detail: `Signing in with one of your ${keys} is two-factor on its own. Password sign-ins have no second step until you add an authenticator app.`,
		};
	}
	return { label: "Off", tone: "muted", detail: "Your password is the only thing protecting this account." };
}

export function looksLikeEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Copy for an auth endpoint failure, from its status and `{ error, code }` body.
 *
 * The server's own message is preferred for codes the UI has nothing to add to;
 * the ones below get wording that tells the reader what to do next.
 */
export function describeAuthError(
	status: number,
	body: Record<string, unknown> | undefined,
	fallback: string,
	nowMs = Date.now(),
): string {
	const code = typeof body?.code === "string" ? body.code : undefined;
	const serverMessage = typeof body?.error === "string" && body.error ? body.error : undefined;
	switch (code) {
		case "invalid_credentials":
			return "That email and password don't match an account.";
		case "locked":
			// Not "this account": the lock is per address and network, and also
			// applies to addresses with no account, so claiming one would leak it.
			return `Too many failed attempts. Sign-in is paused; try again ${formatRetryAfter(body?.retryAfter, nowMs)}.`;
		case "rate_limited":
			return `Too many attempts from here. Try again ${formatRetryAfter(body?.retryAfter, nowMs)}.`;
		case "invalid_code":
			return "That code didn't work. Check your authenticator app and try again.";
		case "bad_setup_token":
			return "That setup token isn't right. Copy it again, without extra spaces.";
		case "already_setup":
			return "This deployment has already been set up. Sign in instead.";
		case "weak_password":
			return serverMessage ?? `Choose a password of at least ${PASSWORD_MIN_LENGTH} characters.`;
		case "wrong_password":
			return "Your current password isn't right.";
		case "email_taken":
			return "An account with this email already exists. Sign in instead.";
		case "totp_unavailable":
			return "Codes from your authenticator can't be checked right now. Use one of your recovery codes instead.";
		case "session_required":
			return "For your security, do this from a signed-in browser rather than with an API token.";
		case "owner_protected":
			return "Only the owner can do this to the owner account.";
		case "self_protected":
			return "You can't do this to your own account. Use Account & security instead.";
		case "passkey_invalid":
			return "That passkey isn't registered to an account here, or couldn't be verified.";
		case "passkey_exists":
			return "That passkey is already registered.";
		case "reauth_required":
			return "Confirm it's you first.";
		case "turnstile_failed":
		case "turnstile_required":
			return "The human check didn't pass. Complete it again and resubmit.";
	}
	if (status === 404) return serverMessage ?? "This link is invalid or has expired.";
	if (status === 429) return `Too many attempts. Try again ${formatRetryAfter(body?.retryAfter, nowMs)}.`;
	if (status === 0 || status >= 500) return "The server couldn't be reached. Try again in a moment.";
	return serverMessage ?? fallback;
}
