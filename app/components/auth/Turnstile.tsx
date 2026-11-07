// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cloudflare Turnstile, rendered only when the deployment configures it.
 *
 * The script is injected on demand rather than placed in `<head>`, so a
 * deployment without `TURNSTILE_SITE_KEY` never contacts challenges.cloudflare.com.
 *
 * Note: the Content-Security-Policy must allow
 * `https://challenges.cloudflare.com` in `script-src` and `frame-src` for the
 * widget to load. If it is blocked, `onError` fires and the page explains it.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
	render: (
		el: HTMLElement,
		options: {
			sitekey: string;
			callback?: (token: string) => void;
			"expired-callback"?: () => void;
			"error-callback"?: () => void;
			theme?: "auto" | "light" | "dark";
			action?: string;
		},
	) => string;
	reset: (widgetId?: string) => void;
	remove: (widgetId: string) => void;
}

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
	if (window.turnstile) return Promise.resolve(window.turnstile);
	if (scriptPromise) return scriptPromise;
	scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
		const script = document.createElement("script");
		script.src = SCRIPT_SRC;
		script.async = true;
		script.defer = true;
		script.onload = () => {
			if (window.turnstile) resolve(window.turnstile);
			else reject(new Error("Turnstile did not initialise"));
		};
		script.onerror = () => {
			scriptPromise = null;
			reject(new Error("Turnstile script failed to load"));
		};
		document.head.appendChild(script);
	});
	return scriptPromise;
}

export interface TurnstileHandle {
	/** Clear the solved token, e.g. after a failed submit (tokens are single-use). */
	reset: () => void;
}

export const Turnstile = forwardRef<
	TurnstileHandle,
	{
		siteKey: string;
		action?: string;
		onToken: (token: string | null) => void;
		onError?: () => void;
	}
>(function Turnstile({ siteKey, action, onToken, onError }, ref) {
	const container = useRef<HTMLDivElement>(null);
	const widgetId = useRef<string | null>(null);
	// Latest callbacks without re-rendering the widget when they change identity.
	const callbacks = useRef({ onToken, onError });
	callbacks.current = { onToken, onError };

	useImperativeHandle(ref, () => ({
		reset: () => {
			callbacks.current.onToken(null);
			if (widgetId.current) window.turnstile?.reset(widgetId.current);
		},
	}));

	useEffect(() => {
		let cancelled = false;
		loadTurnstile()
			.then((api) => {
				if (cancelled || !container.current) return;
				widgetId.current = api.render(container.current, {
					sitekey: siteKey,
					action,
					theme: "auto",
					callback: (token) => callbacks.current.onToken(token),
					"expired-callback": () => callbacks.current.onToken(null),
					"error-callback": () => {
						callbacks.current.onToken(null);
						callbacks.current.onError?.();
					},
				});
			})
			.catch(() => {
				if (!cancelled) callbacks.current.onError?.();
			});
		return () => {
			cancelled = true;
			if (widgetId.current) {
				window.turnstile?.remove(widgetId.current);
				widgetId.current = null;
			}
		};
	}, [siteKey, action]);

	return <div ref={container} className="flex min-h-[65px] justify-center" />;
});
