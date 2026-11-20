// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, {
	type Preferences,
	type PreferencesPatch,
} from "~/services/api";
import { queryKeys } from "./keys";

/** Kept in step with `defaultPreferences()` in `workers/lib/preferences.ts`. */
export const DEFAULT_PREFERENCES: Preferences = {
	notifications: { desktop: false, onlyImportant: false, playSound: false },
	display: {
		density: "cozy",
		hideSignaturesInChat: false,
		previewText: true,
		readingPanePosition: "right",
		cleanTrackingLinks: true,
	},
	sending: { undoWindowEnabled: true, undoWindowSeconds: 30 },
	updatedAt: 0,
};

/**
 * The current preferences record.
 *
 * `staleTime: Infinity` and defaults as placeholder data, for the same reasons as
 * `useBranding`: this decides how every list row and the whole workspace layout
 * are drawn, so it must render something sensible on the first paint rather than
 * flash a comfortable list into a compact one once the request lands. The
 * mutation below writes the response straight into the cache, so there is nothing
 * for polling to discover.
 */
export function usePreferences() {
	return useQuery<Preferences>({
		queryKey: queryKeys.preferences,
		queryFn: ({ signal }) => api.getPreferences({ signal }),
		staleTime: Infinity,
		placeholderData: DEFAULT_PREFERENCES,
	});
}

/**
 * Read preferences without the query's loading states.
 *
 * Every consumer outside the settings page — the list, the workspace, the live
 * poller — wants one thing: a complete record to render from, now. Falling back
 * to the defaults rather than exposing `undefined` keeps that from becoming a
 * conditional at every call site.
 */
export function usePreferenceValues(): Preferences {
	return usePreferences().data ?? DEFAULT_PREFERENCES;
}

/**
 * Save a patch, applying it locally first.
 *
 * Optimistic because these are toggles and selects: a switch that waits for a
 * round trip before moving reads as broken, and every one of these preferences
 * has an immediately visible effect on the surrounding UI. The previous record is
 * snapshotted and restored on failure, so a rejected save does not leave the
 * screen showing a preference the server does not hold.
 */
export function useUpdatePreferences() {
	const qc = useQueryClient();

	return useMutation({
		mutationFn: (patch: PreferencesPatch) => api.updatePreferences(patch),

		onMutate: async (patch) => {
			// An in-flight refetch would land after this and undo the optimistic
			// write, so it is cancelled before the cache is touched.
			await qc.cancelQueries({ queryKey: queryKeys.preferences });
			const previous =
				qc.getQueryData<Preferences>(queryKeys.preferences) ??
				DEFAULT_PREFERENCES;

			// Merged group by group, matching `mergePreferences` on the Worker: a
			// top-level spread would blank the untouched siblings of whichever
			// toggle was just flipped.
			qc.setQueryData<Preferences>(queryKeys.preferences, {
				...previous,
				notifications: { ...previous.notifications, ...patch.notifications },
				display: { ...previous.display, ...patch.display },
			});

			return { previous };
		},

		onError: (_error, _patch, context) => {
			if (context?.previous) {
				qc.setQueryData(queryKeys.preferences, context.previous);
			}
		},

		// The stored record is the final word, including the `updatedAt` stamp the
		// optimistic write could not know.
		onSuccess: (preferences) => {
			qc.setQueryData(queryKeys.preferences, preferences);
		},
	});
}
