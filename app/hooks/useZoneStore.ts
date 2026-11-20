// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface Zone {
	id: string;
	domain: string;
	name: string;
	zoneId?: string;
}

interface ZoneStore {
	/** The domain currently being filtered to. `null` means every domain. */
	selectedZone: Zone | null;
	/**
	 * Whether the user has made a choice, as opposed to never having touched the
	 * selector.
	 *
	 * This exists because `selectedZone: null` is ambiguous on its own: it is both
	 * the initial state and the "All domains" selection. The selector used to
	 * auto-select the first zone whenever `selectedZone` was falsey, which meant
	 * picking "All domains" was immediately undone on the next render and the
	 * option could never be used. Recording the choice separately lets the default
	 * still be "first zone" while leaving an explicit `null` alone.
	 */
	hasChosenZone: boolean;
	/** All available zones */
	zones: Zone[];
	/** Record an explicit choice. `null` selects every domain. */
	setSelectedZone: (zone: Zone | null) => void;
	/** Set all available zones */
	setZones: (zones: Zone[]) => void;
}

export const useZoneStore = create<ZoneStore>()(
	persist(
		(set) => ({
			selectedZone: null,
			hasChosenZone: false,
			zones: [],
			setSelectedZone: (zone) =>
				set({ selectedZone: zone, hasChosenZone: true }),
			setZones: (zones) => set({ zones }),
		}),
		{
			name: "zone-storage",
			// `hasChosenZone` persists alongside the zone so a reload doesn't reset an
			// explicit "All domains" back to the first zone.
			partialize: (state) => ({
				selectedZone: state.selectedZone,
				hasChosenZone: state.hasChosenZone,
			}),
		}
	)
);
