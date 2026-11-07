// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The public unsubscribe endpoint, `/u/:token`.
 *
 * - `GET` renders a confirmation page with one button. It never unsubscribes:
 *   link scanners and mail-provider previews fetch every URL in a message, and
 *   a GET that acted would unsubscribe people who never clicked.
 * - `POST` unsubscribes. It serves both the button on that page and RFC 8058
 *   one-click, where the mailbox provider POSTs `List-Unsubscribe=One-Click`
 *   straight to the URL from the `List-Unsubscribe` header with no cookies.
 *
 * Mounted in `workers/app.ts` before authentication, like `/t/`. The token is
 * the only credential (HMAC over address + sending domain), and the endpoint
 * reads no cookie, so the CSRF guard exempts it (`workers/lib/csrf.ts`).
 *
 * Responses are deliberately uniform: an invalid token gets the same neutral
 * page whatever the reason, so the endpoint does not reveal which tokens or
 * addresses are real.
 */

import { verifyUnsubscribeToken } from "../../shared/unsubscribe-token";
import { escapeHtml } from "./email-helpers";
import {
	cancelEnrollmentsFor,
	getUnsubscribeSecret,
	suppressionStore,
} from "./suppressions";
import type { Env } from "../types";
import { brandingForAddress } from "./products";
import { contrastRatio } from "../../shared/color-contrast";
import { privacyStore } from "./tracking-opt-outs";

/** What the page is dressed in: the sending product's, else neutral. */
export interface PageBrand {
	name: string;
	accentColor: string;
	logoUrl: string | null;
}

const DEFAULT_BRAND: PageBrand = { name: "", accentColor: "#4f46e5", logoUrl: null };

/** White or near-black, whichever reads on the accent. */
function textOn(accent: string): string {
	return (contrastRatio(accent, "#FFFFFF") ?? 0) >= 4.5 ? "#ffffff" : "#111113";
}

/**
 * The sending product's branding, by the mailbox the token names. Only a
 * product overrides: the deployment's own name means nothing to a recipient.
 * Never throws; the page must render whatever the lookup does.
 */
export async function brandFor(env: Env, mailbox: string, requestUrl?: string): Promise<PageBrand> {
	try {
		const origin = requestUrl ? new URL(requestUrl).origin : "";
		const b = await brandingForAddress(env, mailbox, origin);
		if (!b.product) return DEFAULT_BRAND;
		return {
			name: b.name,
			accentColor: /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(b.accentColor) ? b.accentColor : DEFAULT_BRAND.accentColor,
			logoUrl: b.logoUrl,
		};
	} catch {
		return DEFAULT_BRAND;
	}
}

function page(title: string, bodyHtml: string, status = 200, brand: PageBrand = DEFAULT_BRAND): Response {
	const accent = brand.accentColor;
	const header = brand.logoUrl
		? `<img class="logo" src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}">`
		: brand.name
			? `<p class="brand">${escapeHtml(brand.name)}</p>`
			: "";
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(brand.name ? `${title} · ${brand.name}` : title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #f7f7f8; color: #1f2937; }
  main { max-width: 28rem; margin: 12vh 1rem 0; padding: 2rem 1.5rem; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; color: #4b5563; }
  button { min-height: 44px; padding: 0 1.25rem; border: 0; border-radius: 8px; background: ${accent}; color: ${textOn(accent)}; font: inherit; font-weight: 600; cursor: pointer; }
  button:focus-visible { outline: 3px solid ${accent}; outline-offset: 2px; }
  main { border-top: 4px solid ${accent}; }
  @media (min-width: 30rem) { main { margin-inline: auto; } }
  .logo { display: block; max-height: 40px; max-width: 160px; margin: 0 0 1rem; }
  .brand { margin: 0 0 1rem; font-weight: 600; }
  label.opt { display: flex; gap: .625rem; align-items: flex-start; margin: 0 0 1.25rem; color: #374151; cursor: pointer; min-height: 44px; }
  label.opt input { width: 1.125rem; height: 1.125rem; margin: .2rem 0 0; accent-color: ${accent}; flex: none; }
  footer { margin-top: 1.5rem; font-size: .8125rem; }
  footer a { color: #4338ca; }
  @media (prefers-color-scheme: dark) {
    body { background: #111113; color: #f3f4f6; }
    main { background: #1c1c1f; border-color: #2e2e33; }
    p { color: #a1a1aa; }
    label.opt { color: #d4d4d8; }
    footer a { color: #a5b4fc; }
  }
</style>
</head>
<body><main>${header}${bodyHtml}<footer><a href="/privacy">Privacy notice</a></footer></main></body>
</html>`;
	return new Response(html, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		},
	});
}

function invalidPage(): Response {
	return page(
		"Link not valid",
		`<h1>This unsubscribe link is not valid</h1>
<p>It may have been copied incompletely. To stop these emails, reply to one of them and ask to be removed.</p>`,
		400,
	);
}

/** `GET /u/:token`: the confirmation page. Records nothing. */
export async function handleUnsubscribePage(token: string, env: Env, requestUrl?: string): Promise<Response> {
	const payload = await verifyUnsubscribeToken(token, await getUnsubscribeSecret(env)).catch(
		() => null,
	);
	if (!payload) return invalidPage();
	const brand = await brandFor(env, payload.mailbox, requestUrl);
	return page(
		"Unsubscribe",
		`<h1>Unsubscribe from ${escapeHtml(brand.name || payload.domain)}?</h1>
<p><strong>${escapeHtml(payload.address)}</strong> will stop receiving marketing and sequence emails from ${escapeHtml(payload.domain)}. Replies to your own messages are not affected.</p>
<form method="post">
  <label class="opt"><input type="checkbox" name="stop_tracking" value="1"> <span>Also stop tracking my opens and clicks from ${escapeHtml(payload.domain)}</span></label>
  <button type="submit">Unsubscribe</button>
</form>`,
		200,
		brand,
	);
}

/** Whether the form asked to stop tracking too. One-click (RFC 8058) never does. */
export async function wantsTrackingOptOut(request: Request | undefined): Promise<boolean> {
	if (!request) return false;
	const type = request.headers.get("content-type") ?? "";
	if (!type.includes("application/x-www-form-urlencoded") && !type.includes("multipart/form-data")) {
		return false;
	}
	try {
		const form = await request.formData();
		return form.get("stop_tracking") === "1";
	} catch {
		return false;
	}
}

/**
 * `POST /u/:token`: unsubscribe. Idempotent, so a provider retrying a
 * one-click POST, or someone pressing the button twice, is harmless.
 */
export async function handleUnsubscribePost(
	token: string,
	env: Env,
	waitUntil: (p: Promise<unknown>) => void,
	requestUrl?: string,
	request?: Request,
): Promise<Response> {
	let payload: Awaited<ReturnType<typeof verifyUnsubscribeToken>> = null;
	try {
		payload = await verifyUnsubscribeToken(token, await getUnsubscribeSecret(env));
	} catch (e) {
		console.error("Unsubscribe verification failed:", (e as Error)?.message);
	}
	if (!payload) return invalidPage();

	// Written directly rather than through `recordSuppression`, which swallows
	// errors: telling someone "you're unsubscribed" when the write failed is the
	// one outcome this page must never produce.
	let recorded = false;
	try {
		const result = await suppressionStore(env).addSuppressions(
			[
				{
					address: payload.address,
					scope: payload.domain || "global",
					reason: "unsubscribed",
					source: `unsubscribe-link:${payload.mailbox}`,
				},
			],
			Date.now(),
		);
		recorded = result.added > 0;
	} catch (e) {
		console.error("Unsubscribe: could not record suppression:", (e as Error).message);
		return page(
			"Try again",
			`<h1>Something went wrong</h1>
<p>We could not record your request. Please try again in a minute.</p>
<form method="post"><button type="submit">Try again</button></form>`,
			503,
		);
	}
	// Stopping in-flight sequences is a convenience on top of the suppression
	// (the dispatcher would refuse the next step anyway), so it does not hold up
	// the response a provider is waiting on.
	waitUntil(
		cancelEnrollmentsFor(env.BUCKET, payload.address, { domain: payload.domain }).catch((e) =>
			console.error("Unsubscribe: could not cancel enrollments:", (e as Error).message),
		),
	);
	if (recorded) {
		console.log(`Unsubscribed ${payload.address} from ${payload.domain}.`);
	}

	// The optional "also stop tracking me" box. Recorded before answering, like
	// the suppression: the page must not claim something it did not store.
	let trackingStopped = false;
	if (await wantsTrackingOptOut(request)) {
		try {
			const store = privacyStore(env);
			if (!store) throw new Error("AUTH_STORE binding is missing");
			await store.addTrackingOptOut({
				address: payload.address,
				scope: payload.domain || "global",
				source: `unsubscribe-link:${payload.mailbox}`,
				now: Date.now(),
			});
			trackingStopped = true;
		} catch (e) {
			console.error("Unsubscribe: could not record tracking opt-out:", (e as Error).message);
			return page(
				"Try again",
				`<h1>You're unsubscribed, but</h1>
<p>We could not record your request to stop tracking. Please try again in a minute.</p>
<form method="post"><input type="hidden" name="stop_tracking" value="1"><button type="submit">Try again</button></form>`,
				503,
			);
		}
	}

	return page(
		"Unsubscribed",
		`<h1>You're unsubscribed</h1>
<p><strong>${escapeHtml(payload.address)}</strong> will no longer receive marketing or sequence emails from ${escapeHtml(payload.domain)}.</p>${
			trackingStopped
				? `\n<p>Opens and clicks of mail from ${escapeHtml(payload.domain)} to this address will no longer be tracked.</p>`
				: ""
		}`,
		200,
		await brandFor(env, payload.mailbox, requestUrl),
	);
}
