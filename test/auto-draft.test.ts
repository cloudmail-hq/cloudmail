// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { buildAutoDraftSettings, isAutoDraftEnabled } from "../shared/auto-draft";

describe("isAutoDraftEnabled", () => {
	it("is on when explicitly enabled", () => {
		expect(isAutoDraftEnabled({ autoDraft: { enabled: true } })).toBe(true);
	});

	it("is off only when explicitly disabled", () => {
		expect(isAutoDraftEnabled({ autoDraft: { enabled: false } })).toBe(false);
	});

	it("defaults to on for mailboxes predating the setting", () => {
		// These three shapes all exist in the bucket: settings written before
		// `autoDraft` was introduced, and mailboxes with no settings at all.
		expect(isAutoDraftEnabled({})).toBe(true);
		expect(isAutoDraftEnabled({ autoDraft: {} })).toBe(true);
		expect(isAutoDraftEnabled({ autoDraft: { enabled: undefined } })).toBe(true);
	});

	it("defaults to on when settings are missing entirely", () => {
		expect(isAutoDraftEnabled(null)).toBe(true);
		expect(isAutoDraftEnabled(undefined)).toBe(true);
	});

	it("treats unrelated settings as irrelevant", () => {
		const settings = {
			fromName: "Support",
			signature: { enabled: true, text: "—" },
		} as { autoDraft?: { enabled?: boolean } };
		expect(isAutoDraftEnabled(settings)).toBe(true);
	});

	it("only accepts a real boolean false as opt-out", () => {
		// Guards against a truthiness rewrite: falsy-but-not-false values are a
		// corrupt settings object, and silently disabling drafting on them would
		// be a surprising behaviour change.
		const falsy = [0, "", null, "false"] as unknown[];
		for (const value of falsy) {
			expect(
				isAutoDraftEnabled({ autoDraft: { enabled: value as boolean } }),
			).toBe(true);
		}
	});
});

describe("buildAutoDraftSettings", () => {
	const full = {
		fromName: "Support",
		forwarding: { enabled: true, email: "ops@example.com" },
		signature: { enabled: true, text: "— Support", html: "<p>— Support</p>" },
		autoReply: { enabled: true, subject: "Away", message: "Back Monday" },
		autoDraft: { enabled: true },
		agentSystemPrompt: "Be terse.",
	};

	it("sets the flag", () => {
		expect(buildAutoDraftSettings(full, false).autoDraft.enabled).toBe(false);
		expect(buildAutoDraftSettings(full, true).autoDraft.enabled).toBe(true);
	});

	it("preserves every other setting", () => {
		// The PUT endpoint replaces settings wholesale, so anything dropped here
		// is destroyed in R2. This is the regression guard for that.
		const result = buildAutoDraftSettings(full, false);

		expect(result.fromName).toBe("Support");
		expect(result.forwarding).toEqual(full.forwarding);
		expect(result.signature).toEqual(full.signature);
		expect(result.autoReply).toEqual(full.autoReply);
		expect(result.agentSystemPrompt).toBe("Be terse.");
	});

	it("carries through keys it does not know about", () => {
		const withExtra = { ...full, someFutureSetting: { nested: 1 } };
		const result = buildAutoDraftSettings(withExtra, false);
		expect(result.someFutureSetting).toEqual({ nested: 1 });
	});

	it("does not mutate the input", () => {
		const before = structuredClone(full);
		buildAutoDraftSettings(full, false);
		expect(full).toEqual(before);
	});

	it("preserves sibling keys inside autoDraft", () => {
		const settings = { autoDraft: { enabled: true, tone: "formal" } };
		const result = buildAutoDraftSettings(settings, false);
		expect(result.autoDraft).toEqual({ enabled: false, tone: "formal" });
	});

	it("produces a usable object from missing settings", () => {
		expect(buildAutoDraftSettings(undefined, false)).toEqual({
			autoDraft: { enabled: false },
		});
		expect(buildAutoDraftSettings(null, true)).toEqual({
			autoDraft: { enabled: true },
		});
	});

	it("round-trips through isAutoDraftEnabled", () => {
		for (const enabled of [true, false]) {
			expect(isAutoDraftEnabled(buildAutoDraftSettings(full, enabled))).toBe(
				enabled,
			);
		}
	});
});
