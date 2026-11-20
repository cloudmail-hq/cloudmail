// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useCallback, useEffect, useState } from "react";
import {
	currentNotifyPermission,
	devicePreference,
	type NotifyPermission,
	notifyUserKey,
	resolveNotifyState,
	useDesktopNotifyStore,
} from "~/lib/desktop-notify";
import { showToast } from "~/lib/toast";
import { useCurrentUser } from "~/queries/people";
import { usePreferenceValues } from "~/queries/preferences";
import { requestNotificationPermission } from "./useMailboxLiveUpdates";

/**
 * The new-mail notification switch for this user in this browser.
 *
 * `state` reflects the real `Notification.permission`, so the bell never says
 * "on" in a browser that cannot notify. `enable` asks for permission from the
 * click that calls it, as browsers require.
 */
export function useDesktopNotify() {
	const { data: user } = useCurrentUser();
	const { notifications } = usePreferenceValues();
	const byUser = useDesktopNotifyStore((s) => s.byUser);
	const save = useDesktopNotifyStore((s) => s.set);
	const userKey = notifyUserKey(user);

	// Read after mount: the server render has no `Notification`.
	const [permission, setPermission] = useState<NotifyPermission>("default");
	useEffect(() => {
		setPermission(currentNotifyPermission());
		// Permission can change in browser settings while the tab is open.
		const sync = () => setPermission(currentNotifyPermission());
		window.addEventListener("focus", sync);
		return () => window.removeEventListener("focus", sync);
	}, []);

	const preference = devicePreference(byUser, userKey, notifications.desktop);
	const state = resolveNotifyState(preference, permission);

	const enable = useCallback(async () => {
		const result = await requestNotificationPermission();
		setPermission(currentNotifyPermission());
		if (result !== "granted") {
			showToast({
				kind: "warning",
				message: "Notifications are blocked for this site.",
				description:
					"Allow them in your browser settings to be told about new mail.",
			});
			return false;
		}
		save(userKey, true);
		return true;
	}, [save, userKey]);

	const disable = useCallback(() => save(userKey, false), [save, userKey]);

	return { state, preference, permission, enable, disable };
}
