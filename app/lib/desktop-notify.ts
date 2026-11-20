// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Whether this browser shows new-mail notifications, per user per device.
 *
 * The on/off switch used to be the deployment-wide `notifications.desktop`
 * preference, so one admin turning it on showed "on" for every user on every
 * device, including browsers that had never granted permission and so could
 * never notify. Now the switch is stored in this browser's localStorage, keyed
 * by user, and the effective state also requires `Notification.permission` to
 * be `granted`.
 *
 * Until a user flips the switch on a device, the old deployment-wide value is
 * the default, so nobody who had working notifications loses them.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type NotifyPermission = NotificationPermission | "unsupported";

export type NotifyState =
	/** Preference on and permission granted: notifications will show. */
	| "on"
	/** Preference off. */
	| "off"
	/** Preference on, but the browser has not been asked yet. */
	| "needs-permission"
	/** The browser has refused; only browser settings can undo that. */
	| "blocked"
	| "unsupported";

/** Combine the saved switch and the browser's permission into one state. */
export function resolveNotifyState(
	preference: boolean,
	permission: NotifyPermission,
): NotifyState {
	if (permission === "unsupported") return "unsupported";
	if (permission === "denied") return preference ? "blocked" : "off";
	if (!preference) return "off";
	return permission === "granted" ? "on" : "needs-permission";
}

/** Storage key for a user; anonymous sessions share one slot. */
export function notifyUserKey(user: { userId?: string | null; email?: string | null } | null | undefined): string {
	return (user?.userId || user?.email || "anonymous").toLowerCase();
}

/** The current browser permission, or "unsupported" outside a capable browser. */
export function currentNotifyPermission(): NotifyPermission {
	if (typeof window === "undefined" || !("Notification" in window)) {
		return "unsupported";
	}
	return Notification.permission;
}

interface DesktopNotifyStore {
	/** User key → whether that user wants notifications in this browser. */
	byUser: Record<string, boolean>;
	set: (userKey: string, enabled: boolean) => void;
}

export const useDesktopNotifyStore = create<DesktopNotifyStore>()(
	persist(
		(set) => ({
			byUser: {},
			set: (userKey, enabled) =>
				set((state) => ({ byUser: { ...state.byUser, [userKey]: enabled } })),
		}),
		{ name: "desktop-notifications" },
	),
);

/** The saved switch for a user, falling back to the old deployment-wide value. */
export function devicePreference(
	byUser: Record<string, boolean>,
	userKey: string,
	deploymentDefault: boolean,
): boolean {
	return userKey in byUser ? byUser[userKey] : deploymentDefault;
}
