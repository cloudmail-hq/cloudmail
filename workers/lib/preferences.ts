// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Instance-wide notification and display preferences.
 *
 * ## Why this is one shared record rather than per-user or per-mailbox
 *
 * These are *user* preferences — how loudly the app interrupts you and how
 * densely it draws a list — not mail data. There is no user store in this
 * deployment: Cloudflare Access authenticates a teammate and `GET /api/v1/me`
 * reports every authenticated caller as `admin`, and mailboxes are shared by
 * design (see `workers/app.ts`). So "per-user preferences" has nowhere to hang,
 * and "per-mailbox preferences" would be wrong anyway: reading-pane position is
 * a property of the person reading, not of the mailbox being read. This is one
 * record for the whole deployment, exactly as branding is.
 *
 * ## Why R2 and not a migration
 *
 * SQLite in this app lives inside the per-mailbox Durable Object, so a table
 * would give each mailbox its own copy of a setting that is not about mailboxes.
 * Every other shared resource (`branding/`, `api-keys/`, `templates/`,
 * `sequences/`) is a JSON object in the bucket, and this follows that. See
 * `workers/lib/branding.ts`, which this module mirrors.
 *
 * ## Why theme is deliberately absent
 *
 * Theme stays in `localStorage` (`app/hooks/useThemeStore.ts`). It is per device
 * — a laptop in a bright office and a phone in bed want different answers — and,
 * more importantly, it has to be applied by a blocking script before first paint.
 * A server round trip cannot beat first paint, so moving it here would trade a
 * working preference for a flash of the wrong theme on every load.
 */

// R2Bucket is an ambient global from the generated worker-configuration.d.ts.
// Do not import it from @cloudflare/workers-types - the two declarations are
// structurally incompatible and every call site fails to typecheck.

import { z } from "zod";

/** How tightly message rows are drawn in the list. */
export const DENSITIES = ["comfortable", "cozy", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

/**
 * Where the reading pane sits, or `off` for a list-only layout where opening a
 * message hands the whole width to it.
 */
export const READING_PANE_POSITIONS = ["right", "bottom", "off"] as const;
export type ReadingPanePosition = (typeof READING_PANE_POSITIONS)[number];

/**
 * How long a send is held before it goes out, when the delay is enabled.
 *
 * Bounded rather than free: a delay of an hour is indistinguishable from mail
 * being broken, and one of zero should be expressed by turning the feature off so
 * the toast stops claiming a window that does not exist.
 */
export const MIN_UNDO_SEND_SECONDS = 5;
export const MAX_UNDO_SEND_SECONDS = 120;
export const DEFAULT_UNDO_SEND_SECONDS = 30;

export const PREFERENCES_KEY = "preferences/settings.json";

/**
 * The stored record.
 *
 * `strict()` on every level: a client sending a key this version does not know
 * is either a bug or a newer client talking to an older Worker, and silently
 * dropping the field would look like a save that did nothing.
 */
export const PreferencesSchema = z
	.object({
		notifications: z
			.object({
				/** Raise a browser notification when new mail arrives. */
				desktop: z.boolean().default(false),
				/** Only notify for mail the sender flagged high priority. */
				onlyImportant: z.boolean().default(false),
				/** Play a short tone alongside the notification. */
				playSound: z.boolean().default(false),
			})
			.strict()
			.default({}),
		display: z
			.object({
				density: z.enum(DENSITIES).default("cozy"),
				/**
				 * Hide the signature block from message bodies in the reading pane.
				 *
				 * Named for the chat-style reading mode the settings page originally
				 * advertised; this app has no chat mode, so it applies where a reader
				 * actually meets signatures — the `div.email-signature` wrapper that
				 * `renderSignatureBlock` puts around every signature this app sends.
				 */
				hideSignaturesInChat: z.boolean().default(false),
				/** Show the snippet line under each list row. */
				previewText: z.boolean().default(true),
				readingPanePosition: z.enum(READING_PANE_POSITIONS).default("right"),
				/**
				 * Strip `utm_*`, `fbclid`, `gclid`, `mc_eid` and similar from links
				 * in received mail when it is displayed. On by default: they identify
				 * the reader to the destination and do nothing for them. Off shows
				 * links exactly as sent. Never applies to our own outbound tracking.
				 */
				cleanTrackingLinks: z.boolean().default(true),
			})
			.strict()
			.default({}),
		sending: z
			.object({
				/**
				 * Hold each send briefly so it can be pulled back.
				 *
				 * On by default, which is the behaviour that shipped. Off means a send
				 * is delivered immediately with no window and no Undo — the right
				 * choice for someone who finds the wait more annoying than useful, and
				 * previously unreachable because the delay was hardcoded.
				 */
				undoWindowEnabled: z.boolean().default(true),
				/** Seconds to hold a send when the delay is on. */
				undoWindowSeconds: z
					.number()
					.int()
					.min(MIN_UNDO_SEND_SECONDS)
					.max(MAX_UNDO_SEND_SECONDS)
					.default(DEFAULT_UNDO_SEND_SECONDS),
			})
			.strict()
			.default({}),
		/** Epoch seconds of the last change. Server-owned. */
		updatedAt: z.number().int().nonnegative().default(0),
	})
	.strict();

export type Preferences = z.infer<typeof PreferencesSchema>;

/**
 * What a client may send to `PUT /api/v1/preferences`.
 *
 * Both levels are optional so a single toggle is one small request, but the keys
 * within each group are still closed and each value is still validated —
 * `density: "tiny"` is a 400, not a stored value the UI has to defend against.
 */
export const PreferencesPatchSchema = z
	.object({
		notifications: z
			.object({
				desktop: z.boolean(),
				onlyImportant: z.boolean(),
				playSound: z.boolean(),
			})
			.strict()
			.partial(),
		display: z
			.object({
				density: z.enum(DENSITIES),
				hideSignaturesInChat: z.boolean(),
				previewText: z.boolean(),
				readingPanePosition: z.enum(READING_PANE_POSITIONS),
				cleanTrackingLinks: z.boolean(),
			})
			.strict()
			.partial(),
		sending: z
			.object({
				undoWindowEnabled: z.boolean(),
				// Bounded here too, not only in the stored schema: this is the API
				// contract, so an out-of-range value is a 400 rather than something the
				// reader has to clamp later.
				undoWindowSeconds: z
					.number()
					.int()
					.min(MIN_UNDO_SEND_SECONDS)
					.max(MAX_UNDO_SEND_SECONDS),
			})
			.strict()
			.partial(),
	})
	.strict()
	.partial();

export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;

export function defaultPreferences(): Preferences {
	return PreferencesSchema.parse({});
}

/**
 * A tolerant reader for whatever is actually in the bucket.
 *
 * Distinct from {@link PreferencesSchema} on purpose. That one is the API
 * contract and rejects anything odd; this one has to cope with a record written
 * by an earlier version of this file (missing whole groups), a hand-edited
 * object, or a field whose enum has since changed. Reading preferences decides
 * how the entire mail list is drawn, so it must never fail — each field falls
 * back to its default independently, and an unknown key is dropped rather than
 * taking the whole record down with it.
 */
const StoredPreferencesSchema = z.object({
	notifications: z
		.object({
			desktop: z.boolean().catch(false).default(false),
			onlyImportant: z.boolean().catch(false).default(false),
			playSound: z.boolean().catch(false).default(false),
		})
		.default({})
		// The fallback is a fully populated group, not `{}`: a group-level `catch`
		// returns the literal as-is without re-running the field defaults inside
		// it, so `{}` here would hand every consumer `undefined` toggles — the one
		// thing this schema exists to prevent.
		.catch({ desktop: false, onlyImportant: false, playSound: false }),
	display: z
		.object({
			density: z.enum(DENSITIES).catch("cozy").default("cozy"),
			hideSignaturesInChat: z.boolean().catch(false).default(false),
			previewText: z.boolean().catch(true).default(true),
			readingPanePosition: z
				.enum(READING_PANE_POSITIONS)
				.catch("right")
				.default("right"),
			cleanTrackingLinks: z.boolean().catch(true).default(true),
		})
		.default({})
		.catch({
			density: "cozy",
			hideSignaturesInChat: false,
			previewText: true,
			readingPanePosition: "right",
			cleanTrackingLinks: true,
		}),
	sending: z
		.object({
			undoWindowEnabled: z.boolean().catch(true).default(true),
			/**
			 * Clamped rather than rejected on the read path: a record written by a
			 * future version with a wider range, or hand-edited to 0, must still yield
			 * a usable number. `catch` covers a non-number; the min/max reject an
			 * out-of-range one, which `catch` then turns into the default.
			 */
			undoWindowSeconds: z
				.number()
				.int()
				.min(MIN_UNDO_SEND_SECONDS)
				.max(MAX_UNDO_SEND_SECONDS)
				.catch(DEFAULT_UNDO_SEND_SECONDS)
				.default(DEFAULT_UNDO_SEND_SECONDS),
		})
		.default({})
		// A fully populated fallback for the same reason as the groups above: a
		// group-level `catch` returns the literal without re-running field defaults.
		.catch({
			undoWindowEnabled: true,
			undoWindowSeconds: DEFAULT_UNDO_SEND_SECONDS,
		}),
	updatedAt: z.number().int().nonnegative().catch(0).default(0),
});

/** Coerce an arbitrary stored value into a complete, usable record. */
export function normalizePreferences(raw: unknown): Preferences {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return defaultPreferences();
	}
	const parsed = StoredPreferencesSchema.safeParse(raw);
	return parsed.success ? parsed.data : defaultPreferences();
}

/**
 * Apply a patch to a record, group by group.
 *
 * Patch semantics rather than replace: the settings page saves one toggle at a
 * time, and a spread of only the top level would blank every sibling field in
 * whichever group the toggle happened to live in.
 */
export function mergePreferences(
	current: Preferences,
	patch: PreferencesPatch,
): Preferences {
	return {
		notifications: { ...current.notifications, ...patch.notifications },
		display: { ...current.display, ...patch.display },
		sending: { ...current.sending, ...patch.sending },
		updatedAt: current.updatedAt,
	};
}

/** Read the record, falling back to defaults when unset or unreadable. */
export async function getPreferences(bucket: R2Bucket): Promise<Preferences> {
	const obj = await bucket.get(PREFERENCES_KEY);
	if (!obj) return defaultPreferences();
	try {
		return normalizePreferences(await obj.json());
	} catch (e) {
		console.error(
			`Unreadable preferences record at ${PREFERENCES_KEY}, using defaults:`,
			(e as Error).message,
		);
		return defaultPreferences();
	}
}

/** Merge a patch into the stored record and return the result. */
export async function updatePreferences(
	bucket: R2Bucket,
	patch: PreferencesPatch,
): Promise<Preferences> {
	const current = await getPreferences(bucket);
	const next: Preferences = {
		...mergePreferences(current, patch),
		updatedAt: Math.floor(Date.now() / 1000),
	};
	await bucket.put(PREFERENCES_KEY, JSON.stringify(next));
	return next;
}
