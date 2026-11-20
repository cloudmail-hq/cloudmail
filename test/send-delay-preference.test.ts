// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The send delay is a preference, not a constant.
 *
 * Every send was held for a hardcoded 30 seconds. That is the right default — it
 * is the only thing between a misdirected reply and its recipient — but it was
 * unreachable: someone who found the wait more annoying than useful had no way to
 * switch it off, and no way to shorten it.
 *
 * These tests cover the stored contract for that choice. The two properties worth
 * protecting are that the DEFAULT does not change (a deployment that silently
 * stopped delaying sends would lose the safety net without anyone asking) and that
 * the window cannot be saved as a value the delivery path would then reject.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_UNDO_SEND_SECONDS,
	MAX_UNDO_SEND_SECONDS,
	MIN_UNDO_SEND_SECONDS,
	PreferencesPatchSchema,
	PreferencesSchema,
	defaultPreferences,
	mergePreferences,
	normalizePreferences,
} from "../workers/lib/preferences";

describe("the send-delay default", () => {
	it("is ON, so the safety net is opt-out rather than opt-in", () => {
		// A deployment that quietly stopped delaying sends would remove the only
		// chance to catch a wrong recipient, without anyone having chosen that.
		expect(defaultPreferences().sending.undoWindowEnabled).toBe(true);
	});

	it("is 30 seconds, the window that shipped", () => {
		expect(defaultPreferences().sending.undoWindowSeconds).toBe(30);
		expect(DEFAULT_UNDO_SEND_SECONDS).toBe(30);
	});

	it("sits inside its own bounds", () => {
		// Guards against a future edit moving the default outside the range the API
		// accepts, which would make a fresh deployment unable to save its own value.
		expect(DEFAULT_UNDO_SEND_SECONDS).toBeGreaterThanOrEqual(MIN_UNDO_SEND_SECONDS);
		expect(DEFAULT_UNDO_SEND_SECONDS).toBeLessThanOrEqual(MAX_UNDO_SEND_SECONDS);
	});
});

describe("the stored schema", () => {
	it("fills in the whole group from an empty object", () => {
		const parsed = PreferencesSchema.parse({});
		expect(parsed.sending).toEqual({
			undoWindowEnabled: true,
			undoWindowSeconds: DEFAULT_UNDO_SEND_SECONDS,
		});
	});

	it("accepts the boundary values", () => {
		for (const undoWindowSeconds of [MIN_UNDO_SEND_SECONDS, MAX_UNDO_SEND_SECONDS]) {
			expect(
				PreferencesSchema.parse({ sending: { undoWindowSeconds } }).sending
					.undoWindowSeconds,
			).toBe(undoWindowSeconds);
		}
	});

	it("rejects a window shorter than a toast can be read and clicked", () => {
		expect(() =>
			PreferencesSchema.parse({
				sending: { undoWindowSeconds: MIN_UNDO_SEND_SECONDS - 1 },
			}),
		).toThrow();
	});

	it("rejects a window long enough to look like broken mail", () => {
		expect(() =>
			PreferencesSchema.parse({
				sending: { undoWindowSeconds: MAX_UNDO_SEND_SECONDS + 1 },
			}),
		).toThrow();
	});

	it("rejects zero rather than treating it as off", () => {
		// Off is expressed by `undoWindowEnabled: false`. A zero-second window would
		// leave the toast promising a countdown that has already elapsed.
		expect(() =>
			PreferencesSchema.parse({ sending: { undoWindowSeconds: 0 } }),
		).toThrow();
	});

	it("rejects a fractional window", () => {
		expect(() =>
			PreferencesSchema.parse({ sending: { undoWindowSeconds: 12.5 } }),
		).toThrow();
	});

	it("rejects a non-boolean toggle rather than coercing it", () => {
		expect(() =>
			PreferencesSchema.parse({ sending: { undoWindowEnabled: "yes" } }),
		).toThrow();
	});

	it("rejects an unknown key inside the group", () => {
		expect(() =>
			PreferencesSchema.parse({ sending: { undoWindowMinutes: 1 } }),
		).toThrow();
	});
});

describe("the patch schema", () => {
	it("accepts the toggle on its own", () => {
		// The settings page saves one control at a time.
		expect(
			PreferencesPatchSchema.parse({ sending: { undoWindowEnabled: false } }),
		).toEqual({ sending: { undoWindowEnabled: false } });
	});

	it("accepts the window on its own", () => {
		expect(
			PreferencesPatchSchema.parse({ sending: { undoWindowSeconds: 60 } }),
		).toEqual({ sending: { undoWindowSeconds: 60 } });
	});

	it("rejects an out-of-range window at the API boundary, not silently later", () => {
		// A 400 here is the point: clamping instead would store something other than
		// what the caller asked for and report success.
		expect(() =>
			PreferencesPatchSchema.parse({ sending: { undoWindowSeconds: 3600 } }),
		).toThrow();
	});

	it("leaves the group absent when it is not being changed", () => {
		expect(
			PreferencesPatchSchema.parse({ display: { previewText: false } }),
		).not.toHaveProperty("sending");
	});
});

describe("merging", () => {
	const stored = {
		...defaultPreferences(),
		sending: { undoWindowEnabled: true, undoWindowSeconds: 60 },
	};

	it("changes the toggle without resetting the window", () => {
		// The bug this prevents: a top-level spread would blank the sibling field,
		// so turning the delay off and on again would silently lose a 60s choice.
		const next = mergePreferences(stored, {
			sending: { undoWindowEnabled: false },
		});
		expect(next.sending).toEqual({
			undoWindowEnabled: false,
			undoWindowSeconds: 60,
		});
	});

	it("changes the window without touching the toggle", () => {
		const next = mergePreferences(stored, { sending: { undoWindowSeconds: 10 } });
		expect(next.sending).toEqual({
			undoWindowEnabled: true,
			undoWindowSeconds: 10,
		});
	});

	it("leaves the group alone when the patch does not mention it", () => {
		expect(
			mergePreferences(stored, { display: { previewText: false } }).sending,
		).toEqual(stored.sending);
	});
});

describe("reading a record written before this preference existed", () => {
	it("supplies the whole group rather than handing out undefined", () => {
		// Every deployment already has a stored record with no `sending` key. The
		// send path reads `sending.undoWindowEnabled` directly, so an absent group
		// would be a runtime error on the first send after deploy.
		const normalized = normalizePreferences({
			notifications: { desktop: true, onlyImportant: false, playSound: false },
			display: {
				density: "cozy",
				hideSignaturesInChat: false,
				previewText: true,
				readingPanePosition: "right",
			},
			updatedAt: 1700000000,
		});
		expect(normalized.sending).toEqual({
			undoWindowEnabled: true,
			undoWindowSeconds: DEFAULT_UNDO_SEND_SECONDS,
		});
	});

	it("recovers a garbage group without discarding the rest of the record", () => {
		const normalized = normalizePreferences({
			sending: "not an object",
			display: { density: "compact" },
		});
		expect(normalized.sending.undoWindowEnabled).toBe(true);
		expect(normalized.sending.undoWindowSeconds).toBe(DEFAULT_UNDO_SEND_SECONDS);
		// The readable part of the record survived.
		expect(normalized.display.density).toBe("compact");
	});

	it("falls back per field, keeping a valid sibling", () => {
		const normalized = normalizePreferences({
			sending: { undoWindowEnabled: false, undoWindowSeconds: 99999 },
		});
		expect(normalized.sending.undoWindowEnabled).toBe(false);
		expect(normalized.sending.undoWindowSeconds).toBe(DEFAULT_UNDO_SEND_SECONDS);
	});

	it("clamps a hand-edited zero to the default rather than delaying nothing", () => {
		expect(
			normalizePreferences({ sending: { undoWindowSeconds: 0 } }).sending
				.undoWindowSeconds,
		).toBe(DEFAULT_UNDO_SEND_SECONDS);
	});
});
