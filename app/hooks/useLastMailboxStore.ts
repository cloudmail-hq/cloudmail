import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The mailbox opened last on this device.
 *
 * Where the Mail section link goes from another module, and the mailbox the
 * agent panel talks to on pages that are not inside one. Per device, like the
 * theme: it is a navigation memory, not a setting.
 */
interface LastMailboxState {
	lastMailboxId: string | null;
	setLastMailbox: (id: string) => void;
}

export const useLastMailboxStore = create<LastMailboxState>()(
	persist(
		(set, get) => ({
			lastMailboxId: null,
			setLastMailbox: (id) => {
				if (get().lastMailboxId !== id) set({ lastMailboxId: id });
			},
		}),
		{ name: "last-mailbox" },
	),
);
