// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Keep the open mailbox current, and say so when new mail arrives.
 *
 * The workspace used to refetch every visible list every 30 seconds. That is
 * both slow to notice new mail and wasteful, because most of those refetches
 * return exactly what the client already had. Instead this polls one cheap
 * endpoint — a version counter plus the inbox unread count — and only
 * invalidates the real queries when the number actually moves.
 *
 * Polling rather than a socket is deliberate: the mailbox lives in a Durable
 * Object reached over RPC, and a single-row read every few seconds costs less
 * than holding a connection per open tab.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	devicePreference,
	notifyUserKey,
	useDesktopNotifyStore,
} from "~/lib/desktop-notify";
import { playNewMailChime } from "~/lib/notification-sound";
import { useCurrentUser } from "~/queries/people";
import { queryKeys } from "~/queries/keys";
import { usePreferenceValues } from "~/queries/preferences";
import api from "~/services/api";

/** How often to ask, while the tab is in the foreground. */
const ACTIVE_INTERVAL_MS = 6_000;
/**
 * How often to ask when the tab is hidden.
 *
 * Slower, but not stopped: a background tab is exactly where a new-mail
 * notification is useful.
 */
const HIDDEN_INTERVAL_MS = 30_000;

export interface LiveUpdatesOptions {
	/**
	 * Display name used in the notification body.
	 *
	 * Whether to notify at all is no longer passed in: it is the saved
	 * `notifications` preference, which this hook reads itself so that a change on
	 * the settings page reaches every open workspace tab without each caller
	 * having to plumb it through.
	 */
	mailboxLabel?: string;
}

export interface LiveUpdatesState {
	/** Server version we last saw, or null before the first successful poll. */
	version: number | null;
	inboxUnread: number;
	/** Whether the last poll failed; the UI can show a quiet "reconnecting". */
	stalled: boolean;
	/** Force a poll now, e.g. from a Refresh button. */
	checkNow: () => void;
}

function canNotify(): boolean {
	return (
		typeof window !== "undefined" &&
		"Notification" in window &&
		Notification.permission === "granted"
	);
}

export function useMailboxLiveUpdates(
	mailboxId: string | undefined,
	options: LiveUpdatesOptions = {},
): LiveUpdatesState {
	const queryClient = useQueryClient();
	const [version, setVersion] = useState<number | null>(null);
	const [inboxUnread, setInboxUnread] = useState(0);
	const [stalled, setStalled] = useState(false);

	// Held in refs so the polling loop can compare against the previous sample
	// without re-subscribing every time one arrives.
	const versionRef = useRef<number | null>(null);
	const unreadRef = useRef<number | null>(null);
	const highPriorityRef = useRef<number | null>(null);
	const labelRef = useRef(options.mailboxLabel);
	labelRef.current = options.mailboxLabel;

	// The saved preference, read through the query cache so a change on the
	// settings page takes effect in an already-open workspace tab. Held in a ref
	// as well so flipping a toggle does not rebuild the polling loop and reset its
	// baseline — which would swallow the next arrival.
	const { notifications: sharedNotifications } = usePreferenceValues();
	// The on/off switch is per user per browser (`~/lib/desktop-notify`); the
	// refinements (only important, sound) still come from the shared record.
	const { data: currentUser } = useCurrentUser();
	const byUser = useDesktopNotifyStore((s) => s.byUser);
	const notifications = {
		...sharedNotifications,
		desktop: devicePreference(
			byUser,
			notifyUserKey(currentUser),
			sharedNotifications.desktop,
		),
	};
	const notificationsRef = useRef(notifications);
	notificationsRef.current = notifications;

	const poll = useCallback(async () => {
		if (!mailboxId) return;

		try {
			const state = await api.getMailboxState(mailboxId);
			setStalled(false);

			const previousVersion = versionRef.current;
			const previousUnread = unreadRef.current;
			const previousHighPriority = highPriorityRef.current;
			versionRef.current = state.version;
			unreadRef.current = state.inboxUnread;
			highPriorityRef.current = state.inboxUnreadHighPriority;
			setVersion(state.version);
			setInboxUnread(state.inboxUnread);

			// First sample only establishes a baseline: acting on it would refetch
			// everything immediately after the page already loaded it.
			if (previousVersion === null) return;
			if (state.version === previousVersion) return;

			// Something changed. Invalidate the lists rather than patching them:
			// the change could be anything from a new message to a bulk move, and
			// the server's answer is the only reliable one.
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
			queryClient.invalidateQueries({ queryKey: ["labels", mailboxId] });

			const preferences = notificationsRef.current;
			const arrivedTotal =
				previousUnread !== null ? state.inboxUnread - previousUnread : 0;
			const arrivedImportant =
				previousHighPriority !== null
					? state.inboxUnreadHighPriority - previousHighPriority
					: 0;

			// "Only important" counts the high-priority arrivals instead of all of
			// them, so a batch of five in which one is flagged announces the one.
			// Filtering the message text afterwards would still have interrupted
			// for the other four.
			const arrived = preferences.onlyImportant
				? arrivedImportant
				: arrivedTotal;

			if (
				arrived > 0 &&
				preferences.desktop &&
				canNotify() &&
				typeof document !== "undefined" &&
				document.visibilityState === "hidden"
			) {
				// Tagged per mailbox so a burst of arrivals replaces the previous
				// notification instead of stacking one per message.
				const noun = preferences.onlyImportant ? "important email" : "email";
				new Notification(
					arrived === 1 ? `New ${noun}` : `${arrived} new ${noun}s`,
					{
						body: labelRef.current
							? `in ${labelRef.current}`
							: "in your inbox",
						tag: `agentic-inbox:${mailboxId}`,
					},
				);

				// After the notification, never instead of it: the tone is an
				// enhancement, and `playNewMailChime` swallows its own failures so a
				// refused audio device cannot cost the reader the alert.
				if (preferences.playSound) void playNewMailChime();
			}
		} catch {
			// A failed poll is not worth a toast: it is usually a tab waking up
			// from sleep. Surface it as `stalled` and try again on the next tick.
			setStalled(true);
		}
	}, [mailboxId, queryClient]);

	// Reset the baseline when the mailbox changes, so switching mailboxes does
	// not read as "everything changed".
	useEffect(() => {
		versionRef.current = null;
		unreadRef.current = null;
		setVersion(null);
		setInboxUnread(0);
	}, [mailboxId]);

	useEffect(() => {
		if (!mailboxId) return;

		let timer: ReturnType<typeof setTimeout> | undefined;
		let cancelled = false;

		const schedule = () => {
			if (cancelled) return;
			const hidden =
				typeof document !== "undefined" && document.visibilityState === "hidden";
			timer = setTimeout(
				run,
				hidden ? HIDDEN_INTERVAL_MS : ACTIVE_INTERVAL_MS,
			);
		};

		const run = async () => {
			await poll();
			schedule();
		};

		// Poll immediately on mount and whenever the tab comes back, so returning
		// to a stale tab does not wait out a full interval.
		void run();

		const onVisibility = () => {
			if (document.visibilityState === "visible") {
				if (timer) clearTimeout(timer);
				void run();
			}
		};
		document.addEventListener("visibilitychange", onVisibility);

		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [mailboxId, poll]);

	return {
		version,
		inboxUnread,
		stalled,
		checkNow: () => {
			void poll();
		},
	};
}

/**
 * Ask for notification permission.
 *
 * Must be called from a user gesture — browsers reject it otherwise, and a
 * permission prompt nobody asked for is a dark pattern anyway.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
	if (typeof window === "undefined" || !("Notification" in window)) {
		return "denied";
	}
	if (Notification.permission !== "default") return Notification.permission;
	return Notification.requestPermission();
}
