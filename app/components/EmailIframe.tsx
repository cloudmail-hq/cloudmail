// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import DOMPurify from "dompurify";
import { useCallback, useEffect, useRef, useState } from "react";
import { useThemeStore } from "~/hooks/useThemeStore";
import { buildEmailDocument } from "~/lib/email-document";

/*
 * The document itself — its CSS, its CSP, the fit-and-measure script — moved to
 * `~/lib/email-document`, and the typography rules it depends on to
 * `~/lib/reading-typography`. Both were template literals inside this effect,
 * where the only way to check any of it was to open a browser and look. What is
 * left here is the part that genuinely needs the component: a DOM to sanitise
 * against, and the height that arrives asynchronously by `postMessage`.
 */

interface EmailIframeProps {
	body: string;
	/** When true, iframe auto-sizes to content height instead of filling parent */
	autoSize?: boolean;
	/**
	 * Whether remote images may load.
	 *
	 * Defaults to false so a tracking pixel cannot report the open before the
	 * reader trusts the sender. `prepareEmailHtml` strips the URLs; this only
	 * controls the CSP, which is the backstop for anything it missed.
	 */
	allowRemoteImages?: boolean;
	/**
	 * CSS padding for the document body.
	 *
	 * Sender HTML almost never carries its own outer gutter, so the frame has to
	 * supply one or the text sits against the card border. Overridable because a
	 * quote chain reads better tighter than a top-level message.
	 */
	padding?: string;
}

/**
 * Renders email HTML inside a sandboxed iframe.
 *
 * Security model:
 * - DOMPurify sanitises the HTML before injection.
 * - The iframe sandbox does NOT include `allow-same-origin`, so even if
 *   DOMPurify has a bypass the attacker's code runs in an opaque origin
 *   with no access to the parent page's cookies, DOM, or API.
 * - Because the iframe is cross-origin we cannot read `contentDocument`
 *   for auto-sizing. Instead, the injected HTML includes a tiny inline
 *   script that posts its content height to the parent via `postMessage`.
 *   The `allow-scripts` flag is required for this, but scripts inside
 *   the opaque-origin sandbox cannot access anything useful.
 * - A strict CSP meta tag blocks external resource loads inside the
 *   iframe as a defense-in-depth layer.
 *
 * Navigation model: every link opens in a new browser tab.
 * - `<base target="_blank">` sets the default for the document.
 * - `target` is stripped from the sender's markup, because an explicit target on
 *   the element beats `<base>` and plenty of senders set one. Stripping it is
 *   what makes the base tag authoritative.
 * - The sandbox withholds top-level navigation, so a link cannot replace the
 *   app even if something slips past the two rules above.
 * - Fragment links are the exception and stay in the frame; see the anchor
 *   script in `~/lib/email-document`.
 *
 * Width model: the frame is as wide as the column it sits in, and the document
 * fits itself to that width rather than overflowing it. See the fit script in
 * `~/lib/email-document` for why a fixed-width newsletter cannot simply be left
 * to overflow.
 */
export default function EmailIframe({
	body,
	autoSize,
	allowRemoteImages = false,
	padding,
}: EmailIframeProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(autoSize ? 100 : 0);
	// The frame is a separate document, so it inherits nothing from the host page
	// and has to be told which theme to render.
	const resolvedTheme = useThemeStore((state) => state.resolvedTheme);

	// Listen for height reports from the sandboxed iframe
	const handleMessage = useCallback(
		(event: MessageEvent) => {
			if (!autoSize) return;
			// Only accept messages from our own iframe
			if (event.source !== iframeRef.current?.contentWindow) return;
			if (
				event.data &&
				typeof event.data === "object" &&
				event.data.__emailIframeHeight &&
				typeof event.data.height === "number" &&
				event.data.height > 0
			) {
				setHeight(event.data.height);
			}
		},
		[autoSize],
	);

	useEffect(() => {
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [handleMessage]);

	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe || !body) return;

		const cleanBody = DOMPurify.sanitize(body, {
			USE_PROFILES: { html: true },
			FORBID_TAGS: ["style"],
			// Drop any target the sender chose so the document's `<base>` decides
			// where links open. `formtarget` is the same trick spelled differently.
			FORBID_ATTR: ["target", "formtarget"],
			FORCE_BODY: true,
		});

		// Use srcdoc so the iframe is truly sandboxed (no same-origin access).
		// We can't use doc.write() because that requires allow-same-origin.
		iframe.srcdoc = buildEmailDocument({
			cleanBody,
			autoSize,
			allowRemoteImages,
			padding,
			theme: resolvedTheme === "dark" ? "dark" : "light",
		});
		// `resolvedTheme` is a dependency: the document is a string baked at effect
		// time, so switching theme has to rebuild and reassign `srcdoc`.
	}, [body, autoSize, allowRemoteImages, padding, resolvedTheme]);



	return (
		<iframe
			ref={iframeRef}
			className="block w-full border-0"
			style={autoSize ? { height: `${height}px` } : { height: "100%" }}
			/*
			 * `allow-popups-to-escape-sandbox` matters as much as `allow-popups`:
			 * without it the new tab inherits this opaque origin, so the destination
			 * loads with no cookies or storage and the reader lands on a broken
			 * logged-out page.
			 *
			 * Top-level navigation is deliberately absent. With it, a `target="_top"`
			 * link replaces the whole mailbox app with whatever the sender chose.
			 */
			sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
			title="Email content"
		/>
	);
}
