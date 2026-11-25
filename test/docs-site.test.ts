/**
 * The API docs site (`/docs`): every page renders, every internal link
 * resolves, every operation has a page, the Markdown twin matches the HTML's
 * source, and the examples carry the origin of the deployment serving them.
 */

import { describe, expect, it } from "vitest";
import { openApiDocument } from "../workers/lib/openapi";
import { exampleValue, listOperations, operationSlug, tagSlug } from "../workers/lib/docs/api-pages";
import { isSafeHref, renderInline, renderMarkdown, splitTableRow } from "../workers/lib/docs/markdown";
import {
	BASE_URL_TOKEN,
	GUIDE_SECTIONS,
	NEW_TOKEN_PATH,
	allDocPages,
	docPath,
	getDocPage,
	markdownPath,
	parseGuide,
	renderDocHtml,
	renderDocMarkdown,
	renderDocNotFound,
	renderLlmsTxt,
} from "../workers/lib/docs/site";
import { docsRoutes } from "../workers/routes/docs";

const ORIGIN = "https://mail.acme.test";
const CONTEXT = { origin: ORIGIN, appName: "Acme Mail", logoUrl: null };

/** App pages the docs may link to besides other docs pages. */
const APP_LINKS = new Set([NEW_TOKEN_PATH, "/api/v1/openapi.json", "/llms.txt"]);

function linksIn(markdown: string): string[] {
	// Links inside fenced code are examples, not links.
	const prose = markdown.replace(/```[\s\S]*?```/g, "");
	return [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
}

describe("markdown renderer", () => {
	it("escapes raw HTML in text, code and tables", () => {
		const { html } = renderMarkdown("Hello <script>alert(1)</script>\n\n```html\n<b>x</b>\n```\n\n| a |\n| --- |\n| <i>y</i> |");
		expect(html).not.toMatch(/<script|<b>|<i>/);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
	});

	it("renders inline code, bold, italic and links", () => {
		expect(renderInline("a `b<c` **d** *e* [f](/docs/x)")).toBe(
			'a <code>b&lt;c</code> <strong>d</strong> <em>e</em> <a href="/docs/x">f</a>',
		);
	});

	it("drops links that are not same-origin paths, https or mailto", () => {
		for (const href of ["javascript:alert", "//evil.example", "http://plain.example", "data:text/html,x"]) {
			expect(isSafeHref(href), href).toBe(false);
			expect(renderInline(`[x](${href})`)).toBe("x");
		}
		for (const href of ["/docs", "#top", "https://example.org/a", "mailto:a@example.org"]) {
			expect(isSafeHref(href), href).toBe(true);
		}
	});

	it("keeps a pipe inside a table cell when it is escaped", () => {
		expect(splitTableRow("| `a \\| b` | c |")).toEqual(["`a | b`", "c"]);
	});

	it("collects level 2 and 3 headings with unique ids", () => {
		const { headings, html } = renderMarkdown("## Send\n\ntext\n\n### Send\n\n## Other `code`");
		expect(headings).toEqual([
			{ level: 2, id: "send", text: "Send" },
			{ level: 3, id: "send-2", text: "Send" },
			{ level: 2, id: "other-code", text: "Other code" },
		]);
		expect(html).toContain('<h2 id="send">');
	});

	it("renders ordered, unordered and nested lists", () => {
		const { html } = renderMarkdown("1. one\n2. two\n\n- a\n  - b\n- c");
		expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
		expect(html).toContain("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
	});
});

describe("docs pages", () => {
	const pages = allDocPages();

	it("has every guide listed in the sidebar, and an index", () => {
		for (const section of GUIDE_SECTIONS) {
			for (const slug of section.pages) expect(getDocPage(slug), slug || "index").toBeDefined();
		}
		expect(getDocPage("")?.title).toBe("API documentation");
		expect(getDocPage("api")?.title).toBe("API reference");
	});

	it("has one page per operation and one per tag", () => {
		const operations = listOperations(openApiDocument);
		expect(operations.length).toBeGreaterThan(200);
		const slugs = new Set<string>();
		for (const operation of operations) {
			expect(slugs.has(operation.page), operation.page).toBe(false);
			slugs.add(operation.page);
			const page = getDocPage(operation.page);
			expect(page, operation.page).toBeDefined();
			expect(page!.body).toContain(`\`${operation.method} ${operation.path}\``);
			expect(getDocPage(`api/${operation.tagSlug}`), operation.tag).toBeDefined();
		}
	});

	it("derives stable slugs", () => {
		expect(tagSlug("Scheduled sends")).toBe("scheduled-sends");
		expect(tagSlug("Me/Config")).toBe("me-config");
		expect(operationSlug("listEmails")).toBe("list-emails");
		expect(operationSlug("getOpenApiDocument")).toBe("get-open-api-document");
	});

	it("gives every page a title and a one-line description", () => {
		for (const page of pages) {
			expect(page.title.length, page.slug).toBeGreaterThan(0);
			expect(page.description.length, page.slug).toBeGreaterThan(0);
			expect(page.description, page.slug).not.toMatch(/\n/);
		}
	});

	it("resolves every internal link", () => {
		const broken: string[] = [];
		for (const page of pages) {
			for (const href of linksIn(page.body)) {
				if (/^https:|^mailto:|^#/.test(href)) continue;
				const [path] = href.split("#");
				if (APP_LINKS.has(path)) continue;
				const m = /^\/docs(?:\/(.+?))?(\.md)?$/.exec(path);
				if (m && getDocPage(m[1] ?? "")) continue;
				broken.push(`${page.slug || "index"} -> ${href}`);
			}
		}
		expect(broken).toEqual([]);
	});

	it("never names a fixed host: examples use the base URL placeholder", () => {
		for (const page of pages) {
			expect(page.body, page.slug).not.toMatch(/mail\.example\.com|your-worker|tapetide\.com|sightradar|trycloudmail/i);
		}
		expect(getDocPage("quickstart")!.body).toContain(BASE_URL_TOKEN);
	});

	it("renders every page to HTML with the deployment's origin and no placeholder left", () => {
		for (const page of pages) {
			const html = renderDocHtml(page, CONTEXT);
			expect(html.startsWith("<!doctype html>"), page.slug).toBe(true);
			expect(html, page.slug).not.toContain(BASE_URL_TOKEN);
			expect(html, page.slug).toContain(`data-copy-md="${markdownPath(page.slug)}"`);
			expect(html, page.slug).toContain(`href="${markdownPath(page.slug)}"`);
			expect(html, page.slug).toContain(`href="${NEW_TOKEN_PATH}"`);
			// Exactly two scripts: the theme and the page behaviour, both inline.
			expect(html.match(/<script/g)?.length, page.slug).toBe(2);
			expect(html, page.slug).not.toMatch(/<script[^>]+src=/);
		}
	});

	it("puts the reader's origin in the examples", () => {
		const html = renderDocHtml(getDocPage("quickstart")!, CONTEXT);
		expect(html).toContain(`${ORIGIN}/api/v1/me`);
		expect(html).toContain("Acme Mail");
		const other = renderDocHtml(getDocPage("quickstart")!, { ...CONTEXT, origin: "https://inbox.other.test" });
		expect(other).toContain("https://inbox.other.test/api/v1/me");
		expect(other).not.toContain(ORIGIN);
	});

	it("escapes the origin and the app name", () => {
		const html = renderDocHtml(getDocPage("")!, { origin: 'https://x.test"><b>', appName: "<i>Mail</i>", logoUrl: null });
		expect(html).not.toContain("<i>Mail</i>");
		expect(html).not.toContain('"><b>');
	});

	it("marks the current page and opens its group in the sidebar", () => {
		const html = renderDocHtml(getDocPage("api/emails/send-email")!, CONTEXT);
		expect(html).toContain('data-s="api/emails/send-email" aria-current="page"');
		expect(html).toContain('<details data-t="emails" open>');
		expect(html.match(/aria-current="page"/g)?.length).toBe(1);
	});

	it("serves a Markdown twin with the title, description, source and origin", () => {
		const md = renderDocMarkdown(getDocPage("guides/sending-mail")!, ORIGIN);
		expect(md.startsWith("# Sending mail\n\n> ")).toBe(true);
		expect(md).toContain(`Source: ${ORIGIN}/docs/guides/sending-mail`);
		expect(md).toContain(`${ORIGIN}/api/v1/mailboxes/support@example.com/emails`);
		expect(md).not.toContain(BASE_URL_TOKEN);
	});

	it("lists every guide and every API section in llms.txt", () => {
		const txt = renderLlmsTxt(ORIGIN, "Acme Mail");
		expect(txt.startsWith("# Acme Mail API")).toBe(true);
		for (const section of GUIDE_SECTIONS) {
			for (const slug of section.pages) expect(txt, slug).toContain(`${ORIGIN}${markdownPath(slug)}`);
		}
		expect(txt).toContain(`${ORIGIN}/docs/api/emails.md`);
		expect(txt).toContain(`${ORIGIN}/api/v1/openapi.json`);
	});

	it("renders a not-found page with the sidebar", () => {
		const html = renderDocNotFound(CONTEXT);
		expect(html).toContain("Page not found");
		expect(html).toContain('href="/docs/quickstart"');
	});

	it("rejects a guide file without a title or description", () => {
		expect(() => parseGuide("no title")).toThrow();
		expect(() => parseGuide("# Title\n\nbody")).toThrow();
		expect(parseGuide("# T\n\n> d\n\nbody")).toEqual({ title: "T", description: "d", body: "body" });
	});
});

describe("endpoint pages", () => {
	it("shows the scope, a pasteable request and the status codes", () => {
		const page = getDocPage("api/emails/send-email")!;
		expect(page.body).toContain("`POST /api/v1/mailboxes/{mailboxId}/emails`");
		expect(page.body).toContain("`mail:send` scope");
		expect(page.body).toContain(`curl -X POST "${BASE_URL_TOKEN}/api/v1/mailboxes/support@example.com/emails"`);
		expect(page.body).toContain('-H "Authorization: Bearer $CLOUDMAIL_TOKEN"');
		expect(page.body).toContain('-H "Idempotency-Key: $(uuidgen)"');
		expect(page.body).toContain("## Request body");
		expect(page.body).toContain("| `to` **required** |");
		expect(page.body).toContain("## Status codes");
		expect(page.body).toContain("| `202` |");
	});

	it("names every endpoint that answers without a token, from the OpenAPI document", () => {
		const open = listOperations(openApiDocument).filter((o) => o.op.security?.length === 0);
		expect(open.map((o) => o.op.operationId).sort()).toEqual(["getBranding", "getBrandingLogo", "getHealth", "getOpenApiDocument"]);
		const index = getDocPage("api")!.body;
		const auth = getDocPage("authentication")!.body;
		for (const o of open) {
			expect(index, o.page).toContain(`(/docs/${o.page})`);
			expect(auth, o.page).toContain(`(/docs/${o.page})`);
			expect(getDocPage(o.page)!.body, o.page).toContain("No authentication needed.");
		}
	});

	it("omits the token header on public endpoints", () => {
		const page = getDocPage("api/meta/get-health")!;
		expect(page.body).toContain("No authentication needed.");
		expect(page.body).not.toContain("Authorization: Bearer");
	});

	it("puts every header an operation requires into its request", () => {
		let checked = 0;
		for (const operation of listOperations(openApiDocument)) {
			const body = getDocPage(operation.page)!.body;
			for (const p of operation.op.parameters ?? []) {
				if (p.in !== "header" || !p.required) continue;
				expect(body, `${operation.page}: ${p.name}`).toContain(`-H "${p.name}: $`);
				checked++;
			}
		}
		// The migration endpoints need X-Migration-Token. If none is left, this test checks nothing.
		expect(checked).toBeGreaterThan(0);
		const migration = listOperations(openApiDocument).find((o) =>
			(o.op.parameters ?? []).some((p) => p.name === "X-Migration-Token"),
		)!;
		expect(getDocPage(migration.page)!.body).toContain('-H "X-Migration-Token: $MIGRATION_TOKEN"');
	});

	it("builds a request body that satisfies the schema's required fields", () => {
		const schema = openApiDocument.paths["/api/v1/mailboxes/{mailboxId}/emails"].post!.requestBody!.content["application/json"].schema;
		const body = exampleValue(schema, openApiDocument) as Record<string, unknown>;
		expect(body).toMatchObject({ to: "customer@example.org", from: "support@example.com", subject: "Hello" });
		expect(body.text).toBe("Hello");
	});

	it("emits valid JSON in every example body", () => {
		for (const operation of listOperations(openApiDocument)) {
			const body = getDocPage(operation.page)!.body;
			const m = /-d '([\s\S]*?)'\n```/.exec(body);
			if (!m) continue;
			expect(() => JSON.parse(m[1].replace(/'\\''/g, "'")), operation.page).not.toThrow();
		}
	});
});

describe("docs routes", () => {
	const env = { BUCKET: { get: async () => null } } as never;
	const get = (path: string) => docsRoutes.request(`${ORIGIN}${path}`, {}, env);

	it("serves the index, a guide and an endpoint page as HTML", async () => {
		for (const path of ["/docs", "/docs/quickstart", "/docs/api", "/docs/api/emails", "/docs/api/emails/list-emails"]) {
			const res = await get(path);
			expect(res.status, path).toBe(200);
			expect(res.headers.get("content-type"), path).toMatch(/text\/html/);
			expect(await res.text(), path).toContain(`${ORIGIN}`);
		}
	});

	it("serves each page as Markdown at the same address with .md", async () => {
		for (const [path, canonical] of [
			["/docs.md", "/docs"],
			["/docs/authentication.md", "/docs/authentication"],
			["/docs/api/emails/send-email.md", "/docs/api/emails/send-email"],
		]) {
			const res = await get(path);
			expect(res.status, path).toBe(200);
			expect(res.headers.get("content-type"), path).toBe("text/markdown; charset=utf-8");
			expect(res.headers.get("link"), path).toBe(`<${ORIGIN}${canonical}>; rel="canonical"`);
			expect((await res.text()).startsWith("# "), path).toBe(true);
		}
	});

	it("serves llms.txt as plain text", async () => {
		const res = await get("/llms.txt");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/text\/plain/);
	});

	it("never lets a shared cache store a page", async () => {
		// In Access mode a page is served only after the Access check. A proxy
		// that kept a `public` response would serve it to people who never passed.
		for (const path of ["/docs", "/docs/quickstart", "/docs/api/emails/list-emails", "/docs.md", "/docs/quickstart.md", "/llms.txt"]) {
			const cache = (await get(path)).headers.get("cache-control") ?? "";
			expect(cache, path).toContain("private");
			expect(cache, path).not.toContain("public");
		}
	});

	it("answers 404 for unknown pages and odd paths", async () => {
		for (const path of ["/docs/nope", "/docs/api/emails/nope", "/docs/..%2Fsecret", "/docs/A/B"]) {
			expect((await get(path)).status, path).toBe(404);
		}
		expect((await get("/docs/nope.md")).status).toBe(404);
	});

	it("redirects a trailing slash", async () => {
		const res = await get("/docs/quickstart/");
		expect(res.status).toBe(301);
		expect(res.headers.get("location")).toBe("/docs/quickstart");
		expect((await get("/docs/")).headers.get("location")).toBe("/docs");
	});

	it("uses the operator's app name and logo when set", async () => {
		const branded = {
			BUCKET: {
				get: async () => ({
					json: async () => ({ appName: "Acme Mail", logoMimeType: "image/png", logoUpdatedAt: 42 }),
				}),
			},
		} as never;
		const html = await (await docsRoutes.request(`${ORIGIN}/docs`, {}, branded)).text();
		expect(html).toContain("Acme Mail");
		expect(html).toContain('src="/api/v1/branding/logo?v=42"');
	});

	it("links each page to where it lives", () => {
		expect(docPath("")).toBe("/docs");
		expect(markdownPath("")).toBe("/docs.md");
		expect(markdownPath("api/emails")).toBe("/docs/api/emails.md");
	});
});

describe("where the docs are mounted", () => {
	it("is after authentication and before the auth gate in workers/app.ts", async () => {
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(new URL("../workers/app.ts", import.meta.url), "utf8");
		const authenticate = source.indexOf("createAuthenticate(authDeps)");
		const docs = source.indexOf('app.route("/", docsRoutes)');
		const gate = source.indexOf("createAuthGate(authDeps)");
		expect(authenticate).toBeGreaterThan(0);
		// After authentication: in Access mode that is the Worker's own JWT check.
		expect(docs).toBeGreaterThan(authenticate);
		// Before the gate: in password mode the docs need no sign-in.
		expect(gate).toBeGreaterThan(docs);
	});
});

describe("markdown renderer on hostile input", () => {
	// Every shape must cost time in proportion to its length. The sizes are
	// far beyond any page; the limit is generous so a busy CI runner passes,
	// while a quadratic pattern (seconds at this size) still fails.
	const n = 60_000;
	const shapes: Record<string, string> = {
		stars: "*".repeat(n),
		"open brackets": "[".repeat(n),
		backticks: "`".repeat(n),
		"bold opens": "**a".repeat(n / 3),
		"long link text": `[${"a".repeat(n)}](`,
		"table divider": `| ${"--- | ".repeat(n / 6)}`,
		backslashes: "\\".repeat(n),
		"long link target": `[x](${"/a".repeat(n / 2)}`,
		"bold and star": "**a*".repeat(n / 4),
		"bold then stars": `**${"a*".repeat(n / 2)}`,
		"italic opens": "*a ".repeat(n / 3),
		"italic then spaces": `*${"a ".repeat(n / 2)}`,
		"unclosed links": "[a](".repeat(n / 4),
		"unclosed links with target": "[a](b".repeat(n / 5),
		"closed links": "[a](b) ".repeat(n / 7),
		brackets: "[a]".repeat(n / 3),
		"code opens": "`a".repeat(n / 2),
		"escaped brackets": "\\[".repeat(n / 2),
		dashes: "- ".repeat(n / 2),
		"star items": "* ".repeat(n / 2),
		hashes: `${"#".repeat(n)} x`,
		"heading of hashes": `## ${"#".repeat(n)}`,
		indent: `${" ".repeat(n)}- x`,
		"many list lines": "- a\n".repeat(n / 4),
		"many table rows": `| a |\n| --- |\n${"| b |\n".repeat(n / 6)}`,
	};

	for (const [name, input] of Object.entries(shapes)) {
		it(`stays linear on ${name}`, () => {
			const started = performance.now();
			renderMarkdown(input);
			renderMarkdown(`| a |\n| --- |\n| ${input.replace(/\n/g, " ")} |`);
			expect(performance.now() - started).toBeLessThan(1500);
		});
	}

	it("does not overflow the stack on deeply nested blockquotes or lists", () => {
		const quotes = renderMarkdown(`${"> ".repeat(50_000)}deep`).html;
		expect(quotes).toContain("deep");
		expect(quotes.match(/<blockquote>/g)?.length).toBe(12);
		const lists = renderMarkdown(Array.from({ length: 400 }, (_, i) => `${"  ".repeat(i)}- item ${i}`).join("\n")).html;
		expect(lists).toContain("item 399");
		expect(lists.match(/<ul>/g)!.length).toBeLessThanOrEqual(12);
	});
});
