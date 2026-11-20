// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
	devicePreference,
	notifyUserKey,
	resolveNotifyState,
} from "../app/lib/desktop-notify";

describe("resolveNotifyState", () => {
	it("is on only when the switch is on and permission is granted", () => {
		expect(resolveNotifyState(true, "granted")).toBe("on");
		expect(resolveNotifyState(true, "default")).toBe("needs-permission");
		expect(resolveNotifyState(true, "denied")).toBe("blocked");
		expect(resolveNotifyState(false, "granted")).toBe("off");
		expect(resolveNotifyState(false, "default")).toBe("off");
		expect(resolveNotifyState(true, "unsupported")).toBe("unsupported");
	});
});

describe("devicePreference", () => {
	it("prefers this device's saved value per user", () => {
		const saved = { usr_a: false, usr_b: true };
		expect(devicePreference(saved, "usr_a", true)).toBe(false);
		expect(devicePreference(saved, "usr_b", false)).toBe(true);
	});

	it("falls back to the deployment default for an unseen user", () => {
		expect(devicePreference({}, "usr_c", true)).toBe(true);
		expect(devicePreference({}, "usr_c", false)).toBe(false);
	});
});

describe("notifyUserKey", () => {
	it("keys by user id, then email", () => {
		expect(notifyUserKey({ userId: "usr_1", email: "a@x.example" })).toBe("usr_1");
		expect(notifyUserKey({ userId: null, email: "A@x.example" })).toBe("a@x.example");
		expect(notifyUserKey(null)).toBe("anonymous");
	});
});
