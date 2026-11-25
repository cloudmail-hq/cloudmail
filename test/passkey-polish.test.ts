/** Passkey provider names by AAGUID, and when to suggest adding a passkey. */

import { describe, expect, it } from "vitest";
import { defaultPasskeyName, passkeyProviderName } from "../shared/passkey-providers";
import {
	PASSKEY_PROMPT_SNOOZE_MS,
	passkeyPromptKey,
	passkeyPromptSnoozed,
	shouldOfferPasskey,
} from "~/lib/passkey-prompt";

describe("passkeyProviderName", () => {
	it("names common providers, in any case", () => {
		expect(passkeyProviderName("ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4")).toBe("Google Password Manager");
		expect(passkeyProviderName("FBFC3007-154E-4ECC-8C0B-6E020557D7BD")).toBe("Apple Passwords");
		expect(passkeyProviderName("bada5566-a7aa-401f-bd96-45619a55120d")).toBe("1Password");
		expect(passkeyProviderName("08987058-cadc-4b81-b6e1-30de50dcbe96")).toBe("Windows Hello");
	});

	it("gives one family name to a security key's many models", () => {
		expect(passkeyProviderName("cb69481e-8ff7-4039-93ec-0a2729a154a8")).toBe("YubiKey 5");
		expect(passkeyProviderName("ee882879-721c-4913-9775-3dfcce97072a")).toBe("YubiKey 5");
	});

	it("knows nothing about all zeros, unknown or missing ids", () => {
		expect(passkeyProviderName("00000000-0000-0000-0000-000000000000")).toBeNull();
		expect(passkeyProviderName("11111111-2222-3333-4444-555555555555")).toBeNull();
		expect(passkeyProviderName("")).toBeNull();
		expect(passkeyProviderName(null)).toBeNull();
	});
});

describe("defaultPasskeyName", () => {
	const gpm = "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4";
	it("uses the provider, numbered when taken", () => {
		expect(defaultPasskeyName(gpm, [])).toBe("Google Password Manager");
		expect(defaultPasskeyName(gpm, ["google password manager"])).toBe("Google Password Manager 2");
		expect(defaultPasskeyName(gpm, ["Google Password Manager", "Google Password Manager 2"])).toBe(
			"Google Password Manager 3",
		);
	});

	it("falls back to Passkey N, skipping names in use", () => {
		expect(defaultPasskeyName(null, [])).toBe("Passkey 1");
		expect(defaultPasskeyName(null, ["Laptop"])).toBe("Passkey 2");
		expect(defaultPasskeyName(null, ["Laptop", "Passkey 2"])).toBe("Passkey 3");
	});
});

describe("add-a-passkey prompt", () => {
	const base = {
		passwordSession: true,
		hasPasskey: false,
		mfaEnrollmentRequired: false,
		platformPasskey: true,
		snoozed: false,
		onAccountSettings: false,
	};

	it("shows for a password user with no passkey on a device that can make one", () => {
		expect(shouldOfferPasskey(base)).toBe(true);
	});

	it.each([
		["a token or Access session", { passwordSession: false }],
		["an account that has a passkey", { hasPasskey: true }],
		["the require-two-factor enrolment screen", { mfaEnrollmentRequired: true }],
		["a device with no fingerprint, face or PIN", { platformPasskey: false }],
		["Not now in the last 30 days", { snoozed: true }],
		["the Account & security page itself", { onAccountSettings: true }],
	])("stays hidden for %s", (_label, change) => {
		expect(shouldOfferPasskey({ ...base, ...change })).toBe(false);
	});

	it("snoozes for 30 days per account", () => {
		const now = Date.UTC(2026, 10, 24);
		expect(passkeyPromptSnoozed(String(now + PASSKEY_PROMPT_SNOOZE_MS), now)).toBe(true);
		expect(passkeyPromptSnoozed(String(now + PASSKEY_PROMPT_SNOOZE_MS), now + PASSKEY_PROMPT_SNOOZE_MS)).toBe(false);
		expect(passkeyPromptSnoozed(null, now)).toBe(false);
		expect(passkeyPromptSnoozed("not-a-number", now)).toBe(false);
		expect(passkeyPromptKey("usr_a")).not.toBe(passkeyPromptKey("usr_b"));
	});
});
