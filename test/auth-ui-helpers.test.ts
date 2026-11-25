import { describe, expect, it } from "vitest";
import {
	describeAuthError,
	describeUserAgent,
	formatRetryAfter,
	isPublicAuthPath,
	loginUrlFor,
	normalizeMfaInput,
	passwordStrength,
	safeNextPath,
} from "~/lib/auth-helpers";

describe("safeNextPath", () => {
	it("keeps same-origin relative paths with query and hash", () => {
		expect(safeNextPath("/mail/abc/inbox?q=1#x")).toBe("/mail/abc/inbox?q=1#x");
		expect(safeNextPath("/settings")).toBe("/settings");
	});

	it.each([
		null,
		undefined,
		"",
		"mail",
		"https://evil.example/",
		"//evil.example",
		"/\\evil.example",
		"/\t/evil.example",
		"/\n/evil.example",
		"javascript:alert(1)",
		" /settings",
	])("rejects %j", (value) => {
		expect(safeNextPath(value as string | null | undefined)).toBe("/");
	});

	it("does not send a signed-in user back into the auth pages", () => {
		expect(safeNextPath("/login?next=/x")).toBe("/");
		expect(safeNextPath("/invite/abc")).toBe("/");
	});

	it.each(["/.//evil.com", "/a/..//evil.com", "/%2e//evil.com", "/./\u002f/evil.com", "/x/../..//evil.com/path"])(
		"rejects %s, which resolves to a protocol-relative path",
		(value) => {
			const result = safeNextPath(value);
			expect(result).toBe("/");
			expect(new URL(result, "https://app.example").origin).toBe("https://app.example");
		},
	);

	it("honours a custom fallback", () => {
		expect(safeNextPath("//x", "/home")).toBe("/home");
	});
});

describe("isPublicAuthPath / loginUrlFor", () => {
	it("recognises the public pages", () => {
		for (const p of ["/login", "/setup", "/recover", "/forgot", "/login/", "/invite/t", "/reset/t"]) {
			expect(isPublicAuthPath(p)).toBe(true);
		}
		for (const p of ["/", "/settings", "/mail/x", "/loginx", "/invite"]) {
			expect(isPublicAuthPath(p)).toBe(false);
		}
	});

	it("builds a login URL carrying next", () => {
		expect(loginUrlFor("/mail/a", "?q=b c")).toBe(`/login?next=${encodeURIComponent("/mail/a?q=b c")}`);
		expect(loginUrlFor("/")).toBe("/login");
		expect(loginUrlFor("/login", "?next=/x")).toBe("/login");
	});
});

describe("passwordStrength", () => {
	it("rejects anything under the minimum", () => {
		const s = passwordStrength("short");
		expect(s.acceptable).toBe(false);
		expect(s.score).toBe(0);
		expect(s.hints[0]).toMatch(/5 more characters/);
	});

	it("scores long mixed passphrases highly", () => {
		expect(passwordStrength("Correct-Horse-Battery-9").score).toBe(4);
	});

	it("penalises repetition, sequences and personal info", () => {
		expect(passwordStrength("aaaaaaaaaaaa").score).toBe(1);
		expect(passwordStrength("password12345").hints.join(" ")).toMatch(/common words/);
		expect(
			passwordStrength("Jordan-likes-mail-7", ["jordan@example.com"]).hints.join(" "),
		).toMatch(/name or email/);
	});
});

describe("formatRetryAfter", () => {
	it("reads seconds", () => {
		expect(formatRetryAfter(1)).toBe("in 1 second");
		expect(formatRetryAfter(90)).toBe("in 2 minutes");
		expect(formatRetryAfter(7200)).toBe("in 2 hours");
	});
	it("accepts an epoch-ms deadline", () => {
		expect(formatRetryAfter(1_700_000_030_000, 1_700_000_000_000)).toBe("in 30 seconds");
	});
	it("falls back for junk", () => {
		expect(formatRetryAfter(undefined)).toBe("in a moment");
		expect(formatRetryAfter(-3)).toBe("in a moment");
	});
});

describe("describeAuthError", () => {
	it("maps contract codes to actionable copy", () => {
		expect(describeAuthError(401, { code: "invalid_credentials" }, "x")).toMatch(/don't match/);
		expect(describeAuthError(423, { code: "locked", retryAfter: 120 }, "x")).toMatch(/paused.*in 2 minutes/);
		expect(describeAuthError(429, { code: "rate_limited", retryAfter: 5 }, "x")).toMatch(/in 5 seconds/);
		expect(describeAuthError(403, { code: "bad_setup_token" }, "x")).toMatch(/setup token/);
	});
	it("prefers the server message for unknown codes", () => {
		expect(describeAuthError(400, { error: "Nope" }, "fallback")).toBe("Nope");
		expect(describeAuthError(400, {}, "fallback")).toBe("fallback");
		expect(describeAuthError(503, {}, "fallback")).toMatch(/couldn't be reached/);
	});
});

describe("misc", () => {
	it("normalises MFA input", () => {
		expect(normalizeMfaInput(" 12 34-56 7", "totp")).toBe("123456");
		expect(normalizeMfaInput(" ABCDE-12345 ", "recovery")).toBe("abcde-12345");
	});
	it("describes user agents", () => {
		expect(
			describeUserAgent(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
			),
		).toBe("Chrome on macOS");
		expect(describeUserAgent("curl/8.4.0")).toBe("curl");
		expect(describeUserAgent("cloudmail/v1.2.0 (+https://github.com/tapetide/cloudmail)")).toBe("cloudmail CLI");
		expect(describeUserAgent("tapemail/v1.1.0 (+https://github.com/tapetide/tapemail)")).toBe("cloudmail CLI");
		expect(describeUserAgent(null)).toBe("Unknown device");
	});
});
