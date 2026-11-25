import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useCurrentUser } from "~/queries/people";

/**
 * Whether this person sees the sending tools (Templates, Sequences,
 * Analytics) in the main navigation.
 *
 * A teammate who reads and answers mail does not need marketing and
 * developer tools in every view, so members start without them and
 * administrators start with them. Either can flip it in Appearance &
 * display. Per device, like the theme: it is how much chrome you want, and
 * the pages stay reachable by URL and from the command palette either way.
 */
interface PowerToolsState {
	/** null: never chosen on this device, so the role default applies. */
	choice: boolean | null;
	setChoice: (on: boolean) => void;
}

export const usePowerToolsStore = create<PowerToolsState>()(
	persist(
		(set) => ({
			choice: null,
			setChoice: (on) => set({ choice: on }),
		}),
		{ name: "power-tools" },
	),
);

export function useShowPowerTools(): boolean {
	const { data: me } = useCurrentUser();
	const choice = usePowerToolsStore((s) => s.choice);
	return choice ?? me?.role === "admin";
}
