/**
 * The docs site served at `/docs`: a registry of pages, and the HTML and
 * Markdown each one is served as.
 *
 * Two kinds of page, both Markdown:
 * - hand-written guides in `./pages/*.md` (`# Title`, a `> description` line,
 *   then the body);
 * - the API reference, generated from the OpenAPI document by `./api-pages.ts`.
 *
 * Every page is served twice: as HTML at `/docs/<slug>` and as Markdown at
 * `/docs/<slug>.md`. Both come from the same source, so "Copy as Markdown" can
 * never disagree with what the page shows.
 *
 * The docs describe THIS deployment. Pages write `{{BASE_URL}}` where the
 * origin goes, and it is replaced with the origin of the request, so every
 * example can be pasted as it stands. Nothing here reads mail or needs a
 * session; the page is server-rendered with one small inline script (copy
 * buttons, the sidebar filter, and swapping the example mailbox for one of
 * the signed-in reader's own).
 */

import { openApiDocument } from "../openapi";
import {
	EXAMPLE_MAILBOX,
	apiIndexPage,
	listOperations,
	listTags,
	operationPage,
	tagPage,
	tagSlug,
	type ApiOperation,
} from "./api-pages";
import { escapeHtml, renderMarkdown, type Heading } from "./markdown";

const RAW_PAGES = import.meta.glob("./pages/**/*.md", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

export const BASE_URL_TOKEN = "{{BASE_URL}}";

/** Where the "create a token" links go: the form, opened. */
export const NEW_TOKEN_PATH = "/settings/account?new-token=1";

export interface DocPage {
	/** Path below `/docs/`; empty for the index. */
	slug: string;
	title: string;
	description: string;
	/** Markdown body, without the title and description lines. */
	body: string;
	/** Sidebar group. */
	section: string;
	/** For operation pages. */
	operation?: ApiOperation;
}

/** Hand-written pages, in sidebar order. Slugs match files under `./pages`. */
export const GUIDE_SECTIONS: { title: string; pages: string[] }[] = [
	{
		title: "Start here",
		pages: ["", "quickstart", "authentication", "concepts", "errors", "rate-limits"],
	},
	{
		title: "Guides",
		pages: [
			"guides/reading-mail",
			"guides/sending-mail",
			"guides/approvals",
			"guides/idempotency",
			"guides/webhooks",
			"guides/realtime-events",
		],
	},
	{
		title: "SDKs and tools",
		pages: ["sdks/typescript", "sdks/python", "sdks/cli", "mcp"],
	},
];

const API_SECTION = "API reference";

/** Split a guide file into title, description and body. */
export function parseGuide(source: string): { title: string; description: string; body: string } {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	let i = 0;
	while (i < lines.length && lines[i].trim() === "") i++;
	const title = /^#\s+(.+)$/.exec(lines[i] ?? "")?.[1]?.trim();
	if (!title) throw new Error("docs page: the first line must be `# Title`");
	i++;
	while (i < lines.length && lines[i].trim() === "") i++;
	const description: string[] = [];
	while (i < lines.length && /^>\s?/.test(lines[i])) description.push(lines[i++].replace(/^>\s?/, "").trim());
	if (description.length === 0) throw new Error(`docs page "${title}": a \`> description\` line must follow the title`);
	return { title, description: description.join(" "), body: lines.slice(i).join("\n").trim() };
}

function fileSlug(path: string): string {
	const slug = path.replace(/^\.\/pages\//, "").replace(/\.md$/, "");
	return slug === "index" ? "" : slug;
}

interface Site {
	pages: Map<string, DocPage>;
	/** Reading order, for previous and next links. */
	order: string[];
	operations: ApiOperation[];
	tags: string[];
	sidebar: string;
}

function buildSite(): Site {
	const pages = new Map<string, DocPage>();
	const order: string[] = [];

	const guides = new Map<string, { title: string; description: string; body: string }>();
	for (const [path, source] of Object.entries(RAW_PAGES)) guides.set(fileSlug(path), parseGuide(source));

	for (const section of GUIDE_SECTIONS) {
		for (const slug of section.pages) {
			const guide = guides.get(slug);
			if (!guide) throw new Error(`docs: no page file for "${slug || "index"}"`);
			pages.set(slug, { slug, ...guide, section: section.title });
			order.push(slug);
		}
	}
	for (const slug of guides.keys()) {
		if (!pages.has(slug)) throw new Error(`docs: page "${slug}" is not listed in GUIDE_SECTIONS`);
	}

	const operations = listOperations(openApiDocument);
	const tags = listTags(openApiDocument, operations);
	pages.set("api", { slug: "api", ...apiIndexPage(openApiDocument, tags, operations), section: API_SECTION });
	order.push("api");
	for (const tag of tags) {
		const inTag = operations.filter((o) => o.tag === tag);
		const slug = `api/${tagSlug(tag)}`;
		pages.set(slug, { slug, ...tagPage(tag, inTag), section: API_SECTION });
		order.push(slug);
		for (const operation of inTag) {
			if (pages.has(operation.page)) throw new Error(`docs: two pages at "${operation.page}"`);
			pages.set(operation.page, {
				slug: operation.page,
				...operationPage(operation, openApiDocument),
				section: API_SECTION,
				operation,
			});
			order.push(operation.page);
		}
	}

	return { pages, order, operations, tags, sidebar: buildSidebar(pages, tags, operations) };
}

let site: Site | null = null;

/** Built once per isolate: the OpenAPI document and the page files are constants. */
function getSite(): Site {
	site ??= buildSite();
	return site;
}

export function docPath(slug: string): string {
	return slug ? `/docs/${slug}` : "/docs";
}

export function markdownPath(slug: string): string {
	return slug ? `/docs/${slug}.md` : "/docs.md";
}

export function getDocPage(slug: string): DocPage | undefined {
	return getSite().pages.get(slug);
}

export function allDocPages(): DocPage[] {
	const s = getSite();
	return s.order.map((slug) => s.pages.get(slug)!);
}

// -- Markdown twin ----------------------------------------------------

function withBaseUrl(text: string, origin: string): string {
	return text.split(BASE_URL_TOKEN).join(origin);
}

/** The page as one Markdown document, with this deployment's origin filled in. */
export function renderDocMarkdown(page: DocPage, origin: string): string {
	const head = [`# ${page.title}`, "", `> ${page.description}`, "", `Source: ${origin}${docPath(page.slug)}`, ""].join("\n");
	return `${head}\n${withBaseUrl(page.body, origin).trim()}\n`;
}

/** `/llms.txt`: every page with its Markdown twin, for coding agents. */
export function renderLlmsTxt(origin: string, appName: string): string {
	const s = getSite();
	const lines: string[] = [
		`# ${appName} API`,
		"",
		`> HTTP API for the mailboxes on this deployment. Base URL ${origin}. Authenticate with an API token: \`Authorization: Bearer ttk_<id>_<secret>\`. Every docs page is also served as Markdown at the same URL with a .md suffix.`,
		"",
		`- OpenAPI ${openApiDocument.openapi} description: ${origin}/api/v1/openapi.json`,
		`- Create an API token: ${origin}${NEW_TOKEN_PATH}`,
		"",
	];
	const line = (page: DocPage) =>
		`- [${page.title}](${origin}${markdownPath(page.slug)}): ${page.description}`;
	for (const section of GUIDE_SECTIONS) {
		lines.push(`## ${section.title}`, "");
		for (const slug of section.pages) lines.push(line(s.pages.get(slug)!));
		lines.push("");
	}
	lines.push(`## ${API_SECTION}`, "");
	lines.push(line(s.pages.get("api")!));
	for (const tag of s.tags) lines.push(line(s.pages.get(`api/${tagSlug(tag)}`)!));
	lines.push("");
	return lines.join("\n");
}

// -- HTML -------------------------------------------------------------

function methodBadge(method: string): string {
	return `<span class="m m-${method.toLowerCase()}">${method === "DELETE" ? "DEL" : method}</span>`;
}

function navLink(slug: string, label: string, extra = ""): string {
	return `<a href="${docPath(slug)}" data-s="${escapeHtml(slug)}">${extra}<span>${escapeHtml(label)}</span></a>`;
}

/**
 * The sidebar, built once. The current page is marked per request by
 * `markCurrent`, which is a string replace, not a rebuild.
 */
function buildSidebar(pages: Map<string, DocPage>, tags: string[], operations: ApiOperation[]): string {
	const out: string[] = [];
	for (const section of GUIDE_SECTIONS) {
		out.push(`<div class="group"><h2>${escapeHtml(section.title)}</h2><ul>`);
		for (const slug of section.pages) {
			const page = pages.get(slug)!;
			out.push(`<li data-k="${escapeHtml(page.title.toLowerCase())}">${navLink(slug, slug === "" ? "Overview" : page.title)}</li>`);
		}
		out.push("</ul></div>");
	}
	out.push(`<div class="group"><h2>${API_SECTION}</h2><ul>`);
	out.push(`<li data-k="api reference all endpoints">${navLink("api", "All endpoints")}</li>`);
	out.push("</ul>");
	for (const tag of tags) {
		const slug = `api/${tagSlug(tag)}`;
		out.push(`<details data-t="${escapeHtml(tagSlug(tag))}"><summary>${escapeHtml(tag)}</summary><ul>`);
		out.push(`<li data-k="${escapeHtml(tag.toLowerCase())} overview">${navLink(slug, "Overview")}</li>`);
		for (const operation of operations.filter((o) => o.tag === tag)) {
			const page = pages.get(operation.page)!;
			const key = `${page.title} ${operation.method} ${operation.path} ${tag}`.toLowerCase();
			out.push(`<li data-k="${escapeHtml(key)}">${navLink(operation.page, page.title, methodBadge(operation.method))}</li>`);
		}
		out.push("</ul></details>");
	}
	out.push("</div>");
	return out.join("");
}

function markCurrent(sidebar: string, page: DocPage): string {
	let html = sidebar.replace(
		`data-s="${escapeHtml(page.slug)}"`,
		`data-s="${escapeHtml(page.slug)}" aria-current="page"`,
	);
	const tag = /^api\/([^/]+)/.exec(page.slug)?.[1];
	if (tag) html = html.replace(`<details data-t="${escapeHtml(tag)}">`, `<details data-t="${escapeHtml(tag)}" open>`);
	return html;
}

const rendered = new Map<string, { html: string; headings: Heading[] }>();

function renderedBody(page: DocPage): { html: string; headings: Heading[] } {
	let hit = rendered.get(page.slug);
	if (!hit) {
		hit = renderMarkdown(page.body);
		// Operation pages are many and each is read rarely; keep the guides.
		if (!page.operation) rendered.set(page.slug, hit);
	}
	return hit;
}

function breadcrumbs(page: DocPage): string {
	const crumbs: [string, string][] = [["Docs", "/docs"]];
	if (page.slug.startsWith("api/")) {
		crumbs.push([API_SECTION, "/docs/api"]);
		if (page.operation) crumbs.push([page.operation.tag, `/docs/api/${page.operation.tagSlug}`]);
	} else if (page.slug !== "" && page.slug !== "api") {
		crumbs.push([page.section, ""]);
	}
	if (crumbs.length < 2) return "";
	return `<nav class="crumbs" aria-label="Breadcrumb">${crumbs
		.map(([label, href]) => (href ? `<a href="${href}">${escapeHtml(label)}</a>` : `<span>${escapeHtml(label)}</span>`))
		.join('<span aria-hidden="true">/</span>')}</nav>`;
}

function pager(page: DocPage): string {
	const s = getSite();
	const at = s.order.indexOf(page.slug);
	const link = (slug: string | undefined, rel: "prev" | "next") => {
		const target = slug === undefined ? undefined : s.pages.get(slug);
		if (!target) return "<span></span>";
		const title = target.slug === "" ? "Overview" : target.title;
		return `<a class="${rel}" rel="${rel}" href="${docPath(target.slug)}"><small>${rel === "prev" ? "Previous" : "Next"}</small><span>${escapeHtml(title)}</span></a>`;
	};
	return `<nav class="pager" aria-label="Previous and next page">${link(s.order[at - 1], "prev")}${link(s.order[at + 1], "next")}</nav>`;
}

function toc(headings: Heading[]): string {
	const items = headings.filter((h) => h.level === 2);
	if (items.length < 2) return "";
	return `<nav class="toc" aria-label="On this page"><h2>On this page</h2><ul>${items
		.map((h) => `<li><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`)
		.join("")}</ul></nav>`;
}

export interface DocsRenderContext {
	/** Origin of the request: `https://mail.example.com`. */
	origin: string;
	appName: string;
	/** `/api/v1/branding/logo?v=…` when the operator uploaded a logo. */
	logoUrl: string | null;
}

/** The cloudmail mark, shown when the operator has not uploaded a logo. */
const BRAND_MARK =
	'<svg viewBox="0 0 64 64" class="mark" aria-hidden="true" focusable="false"><defs><linearGradient id="cm-tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2D61DA"/><stop offset="1" stop-color="#12309E"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#cm-tile)"/><g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round" transform="translate(8.77 8.97) scale(0.74)"><path d="M40 32a8.5 8.5 0 1 1-17 0a8.5 8.5 0 1 1 17 0" stroke-width="5.5"/><path d="M40 24.5V32.5a8 8 0 0 0 16 0V23a8 8 0 0 0-8-8H16a8 8 0 0 0-8 8V41a8 8 0 0 0 8 8H31.5" stroke-width="6.25"/></g></svg>';

const ICON_COPY =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_FILE =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>';
const ICON_KEY =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M16 7l3 3"/></svg>';
const ICON_MENU =
	'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';

/**
 * The same theme the app uses: its stored choice, or the system setting.
 * Ahead of the stylesheet so the first paint is already the right one.
 */
const THEME_SCRIPT = `(function(){try{var p="system",raw=localStorage.getItem("theme-storage");if(raw){try{var s=JSON.parse(raw);if(s&&s.state&&s.state.theme)p=s.state.theme}catch(e){}}var d=p==="dark"||(p==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light"}catch(e){}})();`;

const STYLE = `
:root{--bg:hsl(0 0% 99%);--panel:hsl(220 14% 96%);--card:#fff;--fg:hsl(222 47% 11%);--muted:hsl(215 19% 35%);--faint:hsl(215 16% 41%);--border:hsl(220 13% 91%);--accent:hsl(243 75% 59%);--accent-hover:hsl(244 62% 51%);--accent-soft:hsl(226 100% 97%);--accent-soft-fg:hsl(244 55% 41%);--code-bg:hsl(222 30% 12%);--code-fg:hsl(210 25% 92%);--inline-code:hsl(220 14% 94%);--get:#1d4ed8;--post:#047857;--put:#b45309;--del:#b91c1c;--head:56px}
.dark{--bg:hsl(222 22% 7%);--panel:hsl(222 18% 11%);--card:hsl(222 20% 10%);--fg:hsl(210 20% 96%);--muted:hsl(215 16% 68%);--faint:hsl(215 14% 62%);--border:hsl(222 14% 22%);--accent:hsl(234 89% 74%);--accent-hover:hsl(234 89% 80%);--accent-soft:hsl(240 30% 17%);--accent-soft-fg:hsl(230 94% 82%);--code-bg:hsl(222 24% 5%);--code-fg:hsl(210 25% 90%);--inline-code:hsl(222 16% 16%);--get:#93c5fd;--post:#6ee7b7;--put:#fcd34d;--del:#fca5a5}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{scroll-padding-top:calc(var(--head) + 16px);-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
code,pre,.m{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
.skip{position:absolute;left:-999px}
.skip:focus{left:12px;top:12px;z-index:50;background:var(--card);padding:8px 12px;border-radius:6px;box-shadow:0 0 0 1px var(--border)}
header.top{position:sticky;top:0;z-index:30;height:var(--head);display:flex;align-items:center;gap:12px;padding:0 16px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:8px;color:var(--fg);font-weight:600;min-width:0;flex:0 1 auto}
.brand:hover{text-decoration:none}
.brand .mark,.brand img{width:26px;height:26px;border-radius:6px;flex:none;object-fit:contain}
.brand b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brand i{font-style:normal;color:var(--faint);font-weight:500;white-space:nowrap}
.top .grow{flex:1}
.chip{display:inline-flex;align-items:center;gap:6px;max-width:34vw;height:32px;padding:0 10px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--muted);font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;cursor:pointer}
.chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip:hover{color:var(--fg)}
.mbx{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--faint)}
.mbx select{height:32px;max-width:220px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--fg);font:inherit;padding:0 6px}
.btn{flex:none;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:6px;background:var(--accent);color:#fff;font-size:13px;font-weight:500;white-space:nowrap}
.dark .btn{color:hsl(222 47% 9%)}
.btn:hover{background:var(--accent-hover);text-decoration:none}
.menu{display:none;align-items:center;justify-content:center;width:36px;height:36px;border:0;border-radius:6px;background:none;color:var(--fg);cursor:pointer}
.shell{display:grid;grid-template-columns:288px minmax(0,1fr) 232px;max-width:1440px;margin:0 auto}
aside.nav{position:sticky;top:var(--head);height:calc(100vh - var(--head));overflow-y:auto;padding:16px 12px 48px;border-right:1px solid var(--border);font-size:13.5px}
.nav input{width:100%;height:34px;padding:0 10px;margin-bottom:12px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--fg);font:inherit}
.nav h2{margin:16px 8px 6px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.nav ul{list-style:none;margin:0;padding:0}
.nav a{display:flex;align-items:baseline;gap:8px;padding:5px 8px;border-radius:6px;color:var(--muted);line-height:1.4}
.nav a:hover{background:var(--panel);color:var(--fg);text-decoration:none}
.nav a[aria-current]{background:var(--accent-soft);color:var(--accent-soft-fg);font-weight:500}
.nav details>summary{list-style:none;cursor:pointer;padding:5px 8px;border-radius:6px;color:var(--fg);display:flex;align-items:center;gap:6px}
.nav details>summary::-webkit-details-marker{display:none}
.nav details>summary::before{content:"";width:6px;height:6px;border-right:1.5px solid var(--faint);border-bottom:1.5px solid var(--faint);transform:rotate(-45deg);transition:transform .12s;flex:none;margin:0 2px}
.nav details[open]>summary::before{transform:rotate(45deg)}
.nav details>summary:hover{background:var(--panel)}
.nav details ul{margin:2px 0 6px 13px;padding-left:8px;border-left:1px solid var(--border)}
.nav .none{display:none;padding:8px;color:var(--faint)}
.m{flex:none;min-width:34px;font-size:10px;font-weight:700;letter-spacing:.02em}
.m-get{color:var(--get)}.m-post{color:var(--post)}.m-put,.m-patch{color:var(--put)}.m-delete{color:var(--del)}
main{min-width:0;padding:32px 40px 80px}
article{max-width:760px;margin:0 auto}
.crumbs{display:flex;flex-wrap:wrap;gap:6px;font-size:13px;color:var(--faint);margin-bottom:10px}
.crumbs a{color:var(--faint)}
h1{margin:0 0 8px;font-size:30px;line-height:1.2;letter-spacing:-.02em;font-weight:650}
.lede{margin:0 0 18px;color:var(--muted);font-size:16.5px}
h1,.lede,.prose p,.prose li,.crumbs{overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:2px 4px;margin:0 0 28px;padding-bottom:12px;border-bottom:1px solid var(--border);font-size:13px}
.actions a,.actions button{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 8px;border:0;border-radius:6px;background:none;color:var(--muted);font:inherit;cursor:pointer}
.actions a:hover,.actions button:hover{background:var(--panel);color:var(--fg);text-decoration:none}
.actions .sep{width:1px;height:16px;background:var(--border)}
.prose h2{margin:40px 0 12px;font-size:21px;line-height:1.3;letter-spacing:-.01em;font-weight:620}
.prose h3{margin:28px 0 8px;font-size:16.5px;font-weight:620}
.prose h4{margin:20px 0 6px;font-size:15px;font-weight:620}
.prose .anchor{color:inherit}
.prose .anchor:hover{text-decoration:none}
.prose .anchor:hover::after{content:" #";color:var(--faint)}
.prose p{margin:0 0 14px}
.prose ul,.prose ol{margin:0 0 14px;padding-left:22px}
.prose li{margin:4px 0}
.prose li>ul,.prose li>ol{margin:4px 0}
.prose hr{border:0;border-top:1px solid var(--border);margin:28px 0}
.prose blockquote{margin:0 0 14px;padding:2px 14px;border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 6px 6px 0}
.prose blockquote p{margin:8px 0}
.prose code{font-size:.86em;background:var(--inline-code);padding:.12em .36em;border-radius:4px;overflow-wrap:anywhere}
.prose a code{color:inherit}
.code{position:relative;margin:0 0 16px;border-radius:8px;background:var(--code-bg);border:1px solid var(--border)}
.code pre{margin:0;padding:14px 16px;overflow-x:auto;color:var(--code-fg);font-size:13px;line-height:1.6}
.code pre code{background:none;padding:0;font-size:inherit;overflow-wrap:normal;white-space:pre}
.code .cp{position:absolute;top:8px;right:8px;display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 8px;border:1px solid hsl(222 14% 30%);border-radius:5px;background:hsl(222 24% 16%);color:hsl(215 16% 76%);font:11px Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer;opacity:0;transition:opacity .12s}
.code:hover .cp,.code .cp:focus-visible{opacity:1}
.code .cp:hover{color:#fff}
.table{margin:0 0 16px;overflow-x:auto;border:1px solid var(--border);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;vertical-align:top;padding:8px 12px;border-bottom:1px solid var(--border)}
tr:last-child td{border-bottom:0}
th{background:var(--panel);color:var(--muted);font-weight:600;font-size:12.5px;white-space:nowrap}
td code{white-space:nowrap;overflow-wrap:normal}
td:last-child code{white-space:normal;overflow-wrap:anywhere}
.pager{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:48px;padding-top:20px;border-top:1px solid var(--border)}
.pager a{display:flex;flex-direction:column;gap:2px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;color:var(--fg)}
.pager a:hover{border-color:var(--accent);text-decoration:none}
.pager small{color:var(--faint);font-size:12px}
.pager .next{text-align:right}
aside.side{position:sticky;top:var(--head);height:calc(100vh - var(--head));overflow-y:auto;padding:36px 16px 48px 0;font-size:13px}
.toc h2{margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.toc ul{list-style:none;margin:0;padding:0;border-left:1px solid var(--border)}
.toc a{display:block;padding:4px 12px;color:var(--muted);line-height:1.4}
.toc a:hover{color:var(--fg);text-decoration:none}
@media (max-width:1180px){.shell{grid-template-columns:272px minmax(0,1fr)}aside.side{display:none}}
@media (max-width:860px){
.shell{grid-template-columns:minmax(0,1fr)}
.menu{display:inline-flex}
.chip,.mbx,.brand i{display:none}
aside.nav{position:fixed;top:var(--head);left:0;bottom:0;z-index:25;width:min(320px,88vw);height:auto;background:var(--bg);transform:translateX(-100%);transition:transform .16s;font-size:15px}
body.nav-open aside.nav{transform:none;box-shadow:0 0 0 100vmax rgb(0 0 0/.45)}
.nav a,.nav details>summary{padding:9px 8px}
main{padding:24px 16px 64px}
h1{font-size:26px}
.actions{gap:4px 8px}
.actions a,.actions button{height:44px;padding:0 10px;border:1px solid var(--border)}
.actions .sep{display:none}
.top{gap:8px}
.btn .wide{display:none}
.pager{grid-template-columns:1fr}
}
@media (max-width:400px){.btn svg{display:none}.btn{padding:0 10px}header.top{padding:0 12px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

/**
 * Behaviour for the page. `EX` is the example mailbox the pages use.
 *
 * Personalising examples only reads `/api/auth/state` and, when the reader is
 * signed in, `/api/v1/mailboxes`; both are same-origin. The mailbox list is
 * asked for on every page and never stored, so it cannot outlive a sign-out.
 * Only the reader's choice of mailbox is kept (`sessionStorage`), and it is
 * used only when the fresh list still contains it. Text nodes are replaced,
 * never HTML.
 */
const PAGE_SCRIPT = `(function(){
var EX=${JSON.stringify(EXAMPLE_MAILBOX)},EXE=encodeURIComponent(EX),current=EX;
function swap(t){return current===EX?t:t.split(EX).join(current).split(EXE).join(encodeURIComponent(current))}
function write(text){if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(text);return new Promise(function(ok,no){var ta=document.createElement("textarea");ta.value=text;ta.setAttribute("readonly","");ta.style.position="fixed";ta.style.opacity="0";document.body.appendChild(ta);ta.select();var done=false;try{done=document.execCommand("copy")}catch(e){}ta.remove();done?ok():no()})}
function flash(el,label,text){var span=el.querySelector("[data-label]")||el;var old=span.textContent;span.textContent=text;setTimeout(function(){span.textContent=old},1600)}
var md=document.querySelector("[data-copy-md]"),mdCache=null;
function loadMd(){if(!mdCache){mdCache=fetch(md.getAttribute("data-copy-md")).then(function(r){if(!r.ok)throw new Error(r.status);return r.text()});mdCache.catch(function(){mdCache=null})}return mdCache}
if(md){md.addEventListener("pointerenter",function(){loadMd().catch(function(){})});md.addEventListener("focus",function(){loadMd().catch(function(){})});md.addEventListener("click",function(){loadMd().then(function(t){return write(swap(t))}).then(function(){flash(md,0,"Copied")},function(){flash(md,0,"Copy failed")})})}
var chip=document.querySelector("[data-copy-text]");
if(chip)chip.addEventListener("click",function(){write(chip.getAttribute("data-copy-text")).then(function(){flash(chip,0,"Copied")},function(){})});
[].forEach.call(document.querySelectorAll(".code"),function(box){var b=document.createElement("button");b.type="button";b.className="cp";b.innerHTML='<span data-label>Copy</span>';b.setAttribute("aria-label","Copy code");b.addEventListener("click",function(){write(box.querySelector("code").textContent).then(function(){flash(b,0,"Copied")},function(){flash(b,0,"Failed")})});box.appendChild(b)});
var menu=document.querySelector(".menu");
if(menu)menu.addEventListener("click",function(){var open=document.body.classList.toggle("nav-open");menu.setAttribute("aria-expanded",open?"true":"false")});
document.addEventListener("keydown",function(e){if(e.key==="Escape"&&document.body.classList.contains("nav-open")){document.body.classList.remove("nav-open");menu.setAttribute("aria-expanded","false");menu.focus()}});
var nav=document.querySelector("aside.nav"),cur=nav&&nav.querySelector("[aria-current]");
if(cur&&cur.offsetTop>nav.clientHeight-80)nav.scrollTop=cur.offsetTop-nav.clientHeight/2;
var filter=nav&&nav.querySelector("input");
if(filter){var items=[].slice.call(nav.querySelectorAll("li[data-k]")),groups=[].slice.call(nav.querySelectorAll("details")),opened=groups.map(function(d){return d.open}),none=nav.querySelector(".none");
filter.addEventListener("input",function(){var q=filter.value.trim().toLowerCase(),words=q.split(/\\s+/).filter(Boolean),shown=0;
items.forEach(function(li){var k=li.getAttribute("data-k"),hit=words.every(function(w){return k.indexOf(w)>=0});li.hidden=!hit;if(hit)shown++});
groups.forEach(function(d,i){var any=d.querySelector("li:not([hidden])");d.hidden=!any;d.open=q?!!any:opened[i]});
none.style.display=shown?"none":"block"})}
var nodes=[];
(function collect(){var w=document.createTreeWalker(document.querySelector("article"),NodeFilter.SHOW_TEXT),n;while((n=w.nextNode())){if(n.nodeValue.indexOf(EX)>=0||n.nodeValue.indexOf(EXE)>=0)nodes.push([n,n.nodeValue])}})();
function apply(){nodes.forEach(function(p){p[0].nodeValue=swap(p[1])})}
function offer(list){if(!list.length)return;var saved=null;try{saved=sessionStorage.getItem("docs-mailbox")}catch(e){}current=list.indexOf(saved)>=0?saved:list[0];apply();
var box=document.querySelector(".mbx"),sel=box&&box.querySelector("select");if(!sel)return;
list.forEach(function(a){var o=document.createElement("option");o.value=a;o.textContent=a;sel.appendChild(o)});sel.value=current;box.hidden=false;
sel.addEventListener("change",function(){current=sel.value;try{sessionStorage.setItem("docs-mailbox",current)}catch(e){}apply()})}
fetch("/api/auth/state",{credentials:"same-origin"}).then(function(r){return r.ok?r.json():null}).then(function(s){if(!s||!s.authenticated)return null;return fetch("/api/v1/mailboxes",{credentials:"same-origin"}).then(function(r){return r.ok?r.json():null})}).then(function(list){if(!Array.isArray(list))return;var a=list.map(function(m){return m&&m.email}).filter(function(e){return typeof e==="string"&&/^[^\\s@]+@[^\\s@]+$/.test(e)}).slice(0,50);offer(a)}).catch(function(){});
})();`;

function shell(options: {
	title: string;
	description: string;
	context: DocsRenderContext;
	sidebar: string;
	main: string;
	side: string;
	markdownUrl?: string;
}): string {
	const { context } = options;
	const origin = escapeHtml(context.origin);
	const brand = context.logoUrl
		? `<img src="${escapeHtml(context.logoUrl)}" alt="" width="26" height="26">`
		: BRAND_MARK;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} · ${escapeHtml(context.appName)} API docs</title>
<meta name="description" content="${escapeHtml(options.description)}">
<meta name="robots" content="noindex">
${options.markdownUrl ? `<link rel="alternate" type="text/markdown" href="${escapeHtml(options.markdownUrl)}">` : ""}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300..700&display=swap">
<script>${THEME_SCRIPT}</script>
<style>${STYLE}</style>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="top">
<button class="menu" type="button" aria-label="Menu" aria-expanded="false">${ICON_MENU}</button>
<a class="brand" href="/docs">${brand}<b>${escapeHtml(context.appName)}</b><i>API docs</i></a>
<span class="grow"></span>
<label class="mbx" hidden>Examples use <select aria-label="Mailbox used in examples"></select></label>
<button class="chip" type="button" data-copy-text="${origin}" title="Base URL. Click to copy.">${ICON_COPY}<span data-label>${origin}</span></button>
<a class="btn" href="${NEW_TOKEN_PATH}" aria-label="Create API token">${ICON_KEY}<span>Create<span class="wide"> API</span> token</span></a>
</header>
<div class="shell">
<aside class="nav" aria-label="Docs pages"><input type="search" placeholder="Filter pages and endpoints" aria-label="Filter pages and endpoints">${options.sidebar}<p class="none">Nothing matches.</p></aside>
<main id="content"><article>${options.main}</article></main>
<aside class="side">${options.side}</aside>
</div>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}

/** The page as HTML, for this deployment. */
export function renderDocHtml(page: DocPage, context: DocsRenderContext): string {
	const s = getSite();
	const body = renderedBody(page);
	const mdUrl = markdownPath(page.slug);
	const main = [
		breadcrumbs(page),
		`<h1>${escapeHtml(page.title)}</h1>`,
		`<p class="lede">${escapeHtml(page.description)}</p>`,
		`<div class="actions"><button type="button" data-copy-md="${mdUrl}">${ICON_COPY}<span data-label>Copy as Markdown</span></button><span class="sep" aria-hidden="true"></span><a href="${mdUrl}" target="_blank" rel="noopener" aria-label="View this page as Markdown">${ICON_FILE}View as Markdown</a><span class="sep" aria-hidden="true"></span><a href="${NEW_TOKEN_PATH}">${ICON_KEY}Create API token</a></div>`,
		`<div class="prose">${body.html}</div>`,
		pager(page),
	].join("\n");
	const html = shell({
		title: page.slug === "" ? "Overview" : page.title,
		description: page.description,
		context,
		sidebar: markCurrent(s.sidebar, page),
		main,
		side: toc(body.headings),
		markdownUrl: mdUrl,
	});
	return withBaseUrl(html, escapeHtml(context.origin));
}

/** A 404 inside the docs: same chrome, so the reader can find the page they wanted. */
export function renderDocNotFound(context: DocsRenderContext): string {
	const main = [
		"<h1>Page not found</h1>",
		'<p class="lede">There is no docs page at this address.</p>',
		'<div class="prose"><p>Start from the <a href="/docs">overview</a>, or look the endpoint up in the <a href="/docs/api">API reference</a>.</p></div>',
	].join("\n");
	return shell({
		title: "Page not found",
		description: "There is no docs page at this address.",
		context,
		sidebar: getSite().sidebar,
		main,
		side: "",
	});
}
