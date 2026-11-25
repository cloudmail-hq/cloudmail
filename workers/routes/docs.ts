/**
 * The API documentation site.
 *
 * - `GET /docs` and `GET /docs/<page>`: a docs page as HTML.
 * - `GET /docs.md` and `GET /docs/<page>.md`: the same page as Markdown.
 * - `GET /llms.txt`: every page with its Markdown address.
 *
 * Public in password mode: the pages describe the API, never any data, and a
 * developer reads them before they hold a token. `workers/app.ts` mounts them
 * after authentication and before the auth gate, so in Access mode the
 * Worker's own check of the Access JWT still runs first.
 *
 * The pages are written for THIS deployment: the base URL in every example is
 * the origin the request arrived on. See `workers/lib/docs/site.ts`.
 */

import { Hono } from "hono";
import { DEFAULT_APP_NAME, getBranding } from "../lib/branding";
import {
	docPath,
	getDocPage,
	renderDocHtml,
	renderDocMarkdown,
	renderDocNotFound,
	renderLlmsTxt,
	type DocsRenderContext,
} from "../lib/docs/site";
import type { MailboxContext } from "../lib/mailbox";

export const docsRoutes = new Hono<MailboxContext>();

/**
 * `private`: the reader's browser may keep a page for five minutes, a shared
 * cache may not. In Access mode a page is only served after the Access check,
 * and a proxy that stored it would hand it to people who never passed one.
 */
const CACHE = "private, max-age=300";
const SLUG = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;

async function renderContext(env: MailboxContext["Bindings"], url: string): Promise<DocsRenderContext> {
	const origin = new URL(url).origin;
	try {
		const branding = await getBranding(env.BUCKET);
		return {
			origin,
			appName: branding.appName || DEFAULT_APP_NAME,
			logoUrl: branding.logoMimeType ? `/api/v1/branding/logo?v=${branding.logoUpdatedAt ?? 0}` : null,
		};
	} catch {
		// Docs must render even when storage is unreachable.
		return { origin, appName: DEFAULT_APP_NAME, logoUrl: null };
	}
}

function markdownResponse(body: string, canonical: string): Response {
	return new Response(body, {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Cache-Control": CACHE,
			"X-Robots-Tag": "noindex",
			Link: `<${canonical}>; rel="canonical"`,
		},
	});
}

docsRoutes.get("/llms.txt", async (c) => {
	const context = await renderContext(c.env, c.req.url);
	return new Response(renderLlmsTxt(context.origin, context.appName), {
		headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": CACHE },
	});
});

docsRoutes.get("/docs.md", (c) => {
	const origin = new URL(c.req.url).origin;
	return markdownResponse(renderDocMarkdown(getDocPage("")!, origin), `${origin}/docs`);
});

docsRoutes.get("/docs", async (c) => {
	c.header("Cache-Control", CACHE);
	return c.html(renderDocHtml(getDocPage("")!, await renderContext(c.env, c.req.url)));
});

docsRoutes.get("/docs/*", async (c) => {
	const url = new URL(c.req.url);
	let rest = url.pathname.slice("/docs/".length);
	if (rest === "" || rest.endsWith("/")) return c.redirect(`/docs${rest ? `/${rest.replace(/\/+$/, "")}` : ""}`, 301);

	const wantsMarkdown = rest.endsWith(".md");
	if (wantsMarkdown) rest = rest.slice(0, -".md".length);
	const page = SLUG.test(rest) ? getDocPage(rest) : undefined;

	if (!page) {
		if (wantsMarkdown) return c.text("Not found", 404);
		return c.html(renderDocNotFound(await renderContext(c.env, c.req.url)), 404);
	}
	if (wantsMarkdown) {
		return markdownResponse(renderDocMarkdown(page, url.origin), `${url.origin}${docPath(page.slug)}`);
	}
	c.header("Cache-Control", CACHE);
	return c.html(renderDocHtml(page, await renderContext(c.env, c.req.url)));
});
