// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
	DEFAULT_UNDO_SEND_SECONDS,
	MAX_UNDO_SEND_SECONDS,
	MIN_UNDO_SEND_SECONDS,
	PREFERENCES_KEY,
	PreferencesPatchSchema,
	PreferencesSchema,
	defaultPreferences,
	getPreferences,
	mergePreferences,
	normalizePreferences,
	updatePreferences,
	type Preferences,
} from "../workers/lib/preferences";

/**
 * The two bucket calls these functions make, over an in-memory object.
 *
 * `put` stores the serialised string rather than the object, so a field that
 * cannot survive `JSON.stringify` is caught here rather than in production.
 */
function fakeBucket(initial?: unknown) {
	const store = new Map<string, string>();
	if (initial !== undefined) {
		store.set(PREFERENCES_KEY, JSON.stringify(initial));
	}

	const bucket = {
		get: async (key: string) => {
			const raw = store.get(key);
			if (raw === undefined) return null;
			return { json: async () => JSON.parse(raw) as unknown };
		},
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
	};

	return { bucket: bucket as unknown as R2Bucket, store };
}

describe("defaultPreferences", () => {
	it("is fully populated, so no caller sees undefined", () => {
		expect(defaultPreferences()).toEqual({
			notifications: {
				desktop: false,
				onlyImportant: false,
				playSound: false,
			},
			display: {
				density: "cozy",
				hideSignaturesInChat: false,
				previewText: true,
				readingPanePosition: "right",
				cleanTrackingLinks: true,
			},
			sending: {
				// On by default: this is the behaviour that shipped, and turning the
				// safety net off should be a deliberate choice rather than the default.
				undoWindowEnabled: true,
				undoWindowSeconds: DEFAULT_UNDO_SEND_SECONDS,
			},
			updatedAt: 0,
		});
	});

	it("defaults notifications off", () => {
		// Notifications interrupt. An opt-out default would mean a fresh
		// deployment starts by asking for permission nobody requested.
		const { notifications } = defaultPreferences();
		expect(notifications.desktop).toBe(false);
		expect(notifications.playSound).toBe(false);
	});

	it("defaults the reading pane to the right, matching the layout that shipped", () => {
		expect(defaultPreferences().display.readingPanePosition).toBe("right");
	});
});

describe("PreferencesSchema", () => {
	it("fills in every group from an empty object", () => {
		expect(PreferencesSchema.parse({})).toEqual(defaultPreferences());
	});

	it("fills in absent fields within a partially supplied group", () => {
		const parsed = PreferencesSchema.parse({ display: { density: "compact" } });
		expect(parsed.display).toEqual({
			density: "compact",
			hideSignaturesInChat: false,
			previewText: true,
			readingPanePosition: "right",
			cleanTrackingLinks: true,
		});
	});

	it("accepts every declared density", () => {
		for (const density of ["comfortable", "cozy", "compact"]) {
			expect(PreferencesSchema.parse({ display: { density } }).display.density).toBe(
				density,
			);
		}
	});

	it("accepts every declared reading-pane position", () => {
		for (const position of ["right", "bottom", "off"]) {
			expect(
				PreferencesSchema.parse({ display: { readingPanePosition: position } })
					.display.readingPanePosition,
			).toBe(position);
		}
	});

	it("rejects an out-of-range density", () => {
		// The UI switches on this value to pick class names, so an unknown one
		// would render an unstyled list rather than degrade.
		expect(() =>
			PreferencesSchema.parse({ display: { density: "tiny" } }),
		).toThrow();
	});

	it("rejects an out-of-range reading-pane position", () => {
		expect(() =>
			PreferencesSchema.parse({ display: { readingPanePosition: "left" } }),
		).toThrow();
	});

	it("rejects a non-boolean toggle rather than coercing it", () => {
		expect(() =>
			PreferencesSchema.parse({ notifications: { desktop: "yes" } }),
		).toThrow();
	});

	it("rejects unknown keys at every level", () => {
		// A key this version does not know is either a bug or a newer client
		// talking to an older Worker. Dropping it silently would look like a save
		// that did nothing.
		expect(() => PreferencesSchema.parse({ theme: "dark" })).toThrow();
		expect(() =>
			PreferencesSchema.parse({ notifications: { sms: true } }),
		).toThrow();
		expect(() =>
			PreferencesSchema.parse({ display: { fontSize: 14 } }),
		).toThrow();
	});

	it("rejects a negative updatedAt", () => {
		expect(() => PreferencesSchema.parse({ updatedAt: -1 })).toThrow();
	});
});

describe("PreferencesPatchSchema", () => {
	it("accepts an empty patch", () => {
		expect(PreferencesPatchSchema.parse({})).toEqual({});
	});

	it("accepts a single toggle without requiring its siblings", () => {
		expect(
			PreferencesPatchSchema.parse({ notifications: { desktop: true } }),
		).toEqual({ notifications: { desktop: true } });
	});

	it("leaves absent groups absent rather than defaulting them", () => {
		// Defaulting here is what would clobber: `mergePreferences` distinguishes
		// "not sent" from "sent as default", and a patch that materialised an
		// empty `display` group would still be harmless, but one that materialised
		// a *populated* default group would reset the reader's layout.
		const parsed = PreferencesPatchSchema.parse({ display: { previewText: false } });
		expect(parsed.notifications).toBeUndefined();
		expect(parsed.display).toEqual({ previewText: false });
	});

	it("rejects unknown keys", () => {
		expect(() => PreferencesPatchSchema.parse({ updatedAt: 1 })).toThrow();
		expect(() =>
			PreferencesPatchSchema.parse({ display: { density: "cozy", extra: 1 } }),
		).toThrow();
	});

	it("rejects an invalid enum even inside a partial group", () => {
		expect(() =>
			PreferencesPatchSchema.parse({ display: { density: "COMPACT" } }),
		).toThrow();
	});
});

describe("mergePreferences", () => {
	const stored: Preferences = {
		notifications: { desktop: true, onlyImportant: true, playSound: false },
		display: {
			density: "compact",
			hideSignaturesInChat: true,
			previewText: false,
			readingPanePosition: "bottom",
		},
		sending: { undoWindowEnabled: false, undoWindowSeconds: 10 },
		updatedAt: 1700000000,
	};

	it("merges a single field without clobbering its siblings", () => {
		// The settings page saves one toggle at a time. A top-level spread would
		// blank every other field in whichever group the toggle lives in.
		const next = mergePreferences(stored, { notifications: { playSound: true } });
		expect(next.notifications).toEqual({
			desktop: true,
			onlyImportant: true,
			playSound: true,
		});
	});

	it("leaves untouched groups exactly as they were", () => {
		const next = mergePreferences(stored, { notifications: { desktop: false } });
		expect(next.display).toEqual(stored.display);
	});

	it("merges both groups in one patch", () => {
		const next = mergePreferences(stored, {
			notifications: { onlyImportant: false },
			display: { density: "comfortable" },
		});
		expect(next.notifications.onlyImportant).toBe(false);
		expect(next.notifications.desktop).toBe(true);
		expect(next.display.density).toBe("comfortable");
		expect(next.display.readingPanePosition).toBe("bottom");
	});

	it("is a no-op for an empty patch", () => {
		expect(mergePreferences(stored, {})).toEqual(stored);
	});

	it("does not mutate the record it was given", () => {
		mergePreferences(stored, { display: { density: "cozy" } });
		expect(stored.display.density).toBe("compact");
	});

	it("carries updatedAt through untouched, leaving the stamp to the writer", () => {
		expect(mergePreferences(stored, {}).updatedAt).toBe(1700000000);
	});
});

describe("normalizePreferences", () => {
	it("returns defaults for a missing or non-object record", () => {
		for (const raw of [null, undefined, 7, "{}", [], true]) {
			expect(normalizePreferences(raw)).toEqual(defaultPreferences());
		}
	});

	it("fills in a whole group written before it existed", () => {
		// A record stored by an earlier version of this file will not have fields
		// added later. Reading must never fail: this decides how the list is drawn.
		const parsed = normalizePreferences({
			notifications: { desktop: true },
			updatedAt: 5,
		});
		expect(parsed.notifications).toEqual({
			desktop: true,
			onlyImportant: false,
			playSound: false,
		});
		expect(parsed.display).toEqual(defaultPreferences().display);
		expect(parsed.updatedAt).toBe(5);
	});

	it("falls back per field rather than discarding a whole record", () => {
		const parsed = normalizePreferences({
			display: {
				density: "enormous",
				previewText: false,
				readingPanePosition: "bottom",
			},
		});
		expect(parsed.display.density).toBe("cozy");
		// The valid siblings survive: a single bad field must not reset a layout
		// the reader chose deliberately.
		expect(parsed.display.previewText).toBe(false);
		expect(parsed.display.readingPanePosition).toBe("bottom");
	});

	it("drops unknown keys instead of rejecting, unlike the API schema", () => {
		const parsed = normalizePreferences({
			display: { density: "compact" },
			legacyField: "whatever",
		});
		expect(parsed).not.toHaveProperty("legacyField");
		expect(parsed.display.density).toBe("compact");
	});

	it("recovers from a garbage group", () => {
		const parsed = normalizePreferences({
			notifications: "on",
			display: { density: "comfortable" },
		});
		expect(parsed.notifications).toEqual(defaultPreferences().notifications);
		expect(parsed.display.density).toBe("comfortable");
	});
});

describe("getPreferences", () => {
	it("returns defaults when nothing has ever been saved", async () => {
		const { bucket } = fakeBucket();
		expect(await getPreferences(bucket)).toEqual(defaultPreferences());
	});

	it("reads a stored record back", async () => {
		const { bucket } = fakeBucket({
			notifications: { desktop: true, onlyImportant: false, playSound: true },
			display: {
				density: "compact",
				hideSignaturesInChat: true,
				previewText: false,
				readingPanePosition: "off",
			},
			updatedAt: 1700000000,
		});

		const stored = await getPreferences(bucket);
		expect(stored.display.density).toBe("compact");
		expect(stored.display.readingPanePosition).toBe("off");
		expect(stored.notifications.playSound).toBe(true);
		expect(stored.updatedAt).toBe(1700000000);
	});

	it("falls back to defaults rather than throwing on an unreadable record", async () => {
		// Reading preferences decides how the whole list is drawn, so a corrupt
		// object must degrade to defaults instead of failing the request.
		const { bucket, store } = fakeBucket();
		store.set(PREFERENCES_KEY, "not json at all");
		expect(await getPreferences(bucket)).toEqual(defaultPreferences());
	});
});

describe("updatePreferences", () => {
	it("writes a patch over the defaults on first save", async () => {
		const { bucket } = fakeBucket();

		const saved = await updatePreferences(bucket, {
			display: { density: "compact" },
		});

		expect(saved.display.density).toBe("compact");
		// Untouched fields are still the defaults, not undefined.
		expect(saved.display.readingPanePosition).toBe("right");
		expect(saved.notifications).toEqual(defaultPreferences().notifications);
	});

	it("round-trips: what it returns is what a later read finds", async () => {
		const { bucket } = fakeBucket();

		const saved = await updatePreferences(bucket, {
			notifications: { desktop: true },
			display: { readingPanePosition: "bottom" },
		});

		expect(await getPreferences(bucket)).toEqual(saved);
	});

	it("does not clobber earlier saves with a later single-field patch", async () => {
		// The settings page saves one control at a time, so this sequence is the
		// normal case rather than an edge one.
		const { bucket } = fakeBucket();

		await updatePreferences(bucket, { display: { density: "compact" } });
		await updatePreferences(bucket, { notifications: { desktop: true } });
		const final = await updatePreferences(bucket, {
			display: { previewText: false },
		});

		expect(final.display.density).toBe("compact");
		expect(final.display.previewText).toBe(false);
		expect(final.notifications.desktop).toBe(true);
	});

	it("stamps updatedAt on write, ignoring whatever was stored", async () => {
		const { bucket } = fakeBucket({ updatedAt: 42 });
		const before = Math.floor(Date.now() / 1000);

		const saved = await updatePreferences(bucket, {
			notifications: { playSound: true },
		});

		expect(saved.updatedAt).toBeGreaterThanOrEqual(before);
	});

	it("persists a record that survives JSON serialisation intact", async () => {
		const { bucket, store } = fakeBucket();

		await updatePreferences(bucket, { display: { density: "comfortable" } });

		const raw = JSON.parse(store.get(PREFERENCES_KEY) as string);
		expect(raw.display.density).toBe("comfortable");
		expect(Object.keys(raw).sort()).toEqual([
			"display",
			"notifications",
			"sending",
			"updatedAt",
		]);
	});
});
