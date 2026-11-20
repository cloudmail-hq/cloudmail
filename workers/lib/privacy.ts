// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The operator's privacy settings in R2, and the public `/privacy` page.
 *
 * One JSON object for the deployment (`privacy/settings.json`), like branding:
 * a global setting does not belong in a per-mailbox Durable Object. The shape,
 * defaults and notice text live in `shared/privacy.ts`.
 */

import {
	buildPrivacyNotice,
	normalizePrivacySettings,
	type PrivacySettings,
} from "../../shared/privacy";
import { getBranding } from "./branding";
import { getAiProvidersFile } from "./ai-providers-store";
import { escapeHtml } from "./email-helpers";

export const PRIVACY_KEY = "privacy/settings.json";

/** The active AI gateway's host, for the notice: mail goes there when one is set. */
export async function activeGatewayHost(bucket: R2Bucket): Promise<string | null> {
	try {
		const file = await getAiProvidersFile(bucket);
		const id = file?.routing.gatewayProviderId;
		const p = id ? file!.providers.find((x) => x.id === id && x.enabled) : undefined;
		return p ? new URL(p.baseUrl).host : null;
	} catch {
		return null;
	}
}

export async function getPrivacySettings(bucket: R2Bucket): Promise<PrivacySettings> {
	try {
		const obj = await bucket.get(PRIVACY_KEY);
		return normalizePrivacySettings(obj ? await obj.json() : null);
	} catch (e) {
		// A notice that fails to load still has to render; the defaults describe
		// what the software does.
		console.error("Could not read privacy settings:", (e as Error).message);
		return normalizePrivacySettings(null);
	}
}

export async function putPrivacySettings(bucket: R2Bucket, settings: PrivacySettings): Promise<void> {
	await bucket.put(PRIVACY_KEY, JSON.stringify(settings), {
		httpMetadata: { contentType: "application/json" },
	});
}

/**
 * The public `/privacy` page. Server-rendered HTML with no script and no
 * session, so it works for a recipient who followed a link from an email and
 * for a crawler. Everything interpolated is escaped.
 */
export async function renderPrivacyPage(bucket: R2Bucket): Promise<Response> {
	const [settings, branding, aiGatewayHost] = await Promise.all([
		getPrivacySettings(bucket),
		getBranding(bucket).catch(() => ({ appName: "cloudmail" })),
		activeGatewayHost(bucket),
	]);
	const sections = buildPrivacyNotice(settings, { appName: branding.appName, aiGatewayHost });
	const updated = settings.updatedAt
		? new Date(settings.updatedAt).toISOString().slice(0, 10)
		: null;

	const body = sections
		.map((section) => {
			const paragraphs = section.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
			const bullets = section.bullets?.length
				? `<ul>${section.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`
				: "";
			return `<section><h2>${escapeHtml(section.heading)}</h2>${paragraphs}${bullets}</section>`;
		})
		.join("");

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy notice · ${escapeHtml(branding.appName)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; background: #f7f7f8; color: #1f2937; }
  main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
  h1 { font-size: 1.75rem; line-height: 1.25; margin: 0 0 .25rem; }
  .meta { margin: 0 0 2rem; color: #4b5563; font-size: .875rem; }
  section { margin: 0 0 1.75rem; }
  h2 { font-size: 1.125rem; margin: 0 0 .5rem; }
  p, li { color: #374151; }
  p { margin: 0 0 .75rem; }
  ul { margin: 0 0 .75rem; padding-left: 1.25rem; }
  li { margin: 0 0 .375rem; }
  a { color: #4338ca; }
  a:focus-visible { outline: 3px solid #a5b4fc; outline-offset: 2px; }
  footer { margin-top: 2.5rem; font-size: .875rem; color: #4b5563; }
  @media (prefers-color-scheme: dark) {
    body { background: #111113; color: #f3f4f6; }
    p, li { color: #d4d4d8; }
    .meta, footer { color: #a1a1aa; }
    a { color: #a5b4fc; }
  }
</style>
</head>
<body>
<main>
<h1>Privacy notice</h1>
<p class="meta">${escapeHtml(branding.appName)}${updated ? ` · Last updated ${updated}` : ""}</p>
${body}
<footer><a href="/login">Sign in</a></footer>
</main>
</body>
</html>`;

	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			// Short: an edit in Settings should show up quickly.
			"Cache-Control": "public, max-age=300",
		},
	});
}
