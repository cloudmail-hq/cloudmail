// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect } from "react";
import { brandingLogoUrl, useBranding } from "~/queries/branding";

/** The one `<link>` this component owns, reused rather than recreated. */
const DYNAMIC_FAVICON_ID = "branding-favicon";

/**
 * `rel` given to the bundled favicon links while a logo overrides them.
 *
 * Not a real link relation, which is the point: the browser ignores it, and it is
 * a marker this component can find again to restore them.
 */
const PARKED_REL = "branding-parked-icon";

/**
 * Keeps the document title and favicon in step with the configured branding.
 *
 * ## Why an effect rather than `meta()`
 *
 * The app name is stored server-side and read through the branding query, so it
 * is not known at the time `Layout` renders `<head>`. React Router's `meta()` is
 * per-route and static here; using it would mean every route re-declaring the
 * title and a hardcoded fallback winning over the configured value on each
 * navigation. One effect at the root owns both instead.
 *
 * The `<title>` in `root.tsx` remains as the pre-hydration default, so the tab
 * is never blank and the server-rendered HTML stays stable.
 *
 * Renders nothing.
 */
export default function BrandingHead() {
	const { data: branding } = useBranding();
	const appName = branding?.appName;
	const logoUrl = brandingLogoUrl(branding);
	const logoMimeType = branding?.logoMimeType;

	useEffect(() => {
		if (!appName) return;
		document.title = appName;
	}, [appName]);

	useEffect(() => {
		if (!logoUrl || !logoMimeType) return;

		/*
		 * Point the favicon at the uploaded logo.
		 *
		 * The shipped `favicon.svg`/`favicon.ico` links have to stop applying, since
		 * a browser chooses freely among every `rel="icon"` link and would otherwise
		 * keep showing the bundled icon. They are parked by rewriting `rel` rather
		 * than by removing the nodes, and the dynamic link is a single node reused
		 * across runs.
		 *
		 * That combination is what makes this safe to run more than once. An earlier
		 * version removed the original nodes and re-inserted them on cleanup using
		 * saved `nextSibling` references; with two overlapping effect runs (which
		 * React does in development) the second run captured an already-empty list,
		 * and the tab could be left with no icon at all. Reading the DOM afresh on
		 * cleanup and restoring by attribute makes the order of runs irrelevant.
		 */
		const parked = Array.from(
			document.querySelectorAll<HTMLLinkElement>(
				`link[rel~="icon"]:not(#${DYNAMIC_FAVICON_ID})`,
			),
		);
		for (const link of parked) link.rel = PARKED_REL;

		let icon = document.getElementById(
			DYNAMIC_FAVICON_ID,
		) as HTMLLinkElement | null;
		if (!icon) {
			icon = document.createElement("link");
			icon.id = DYNAMIC_FAVICON_ID;
			document.head.appendChild(icon);
		}
		icon.rel = "icon";
		icon.type = logoMimeType;
		icon.href = logoUrl;

		return () => {
			document.getElementById(DYNAMIC_FAVICON_ID)?.remove();
			for (const link of document.querySelectorAll<HTMLLinkElement>(
				`link[rel~="${PARKED_REL}"]`,
			)) {
				link.rel = "icon";
			}
		};
	}, [logoUrl, logoMimeType]);

	return null;
}
