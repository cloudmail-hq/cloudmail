#!/usr/bin/env node
/**
 * Opens an AI-shaped draft in the composer of a running demo instance
 * (scripts/demo) and reports how the editor renders it next to the reader:
 * computed margins, list markers and a screenshot of each.
 *
 *   node scripts/editor-lab/probe.mjs [out-dir]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DEMO_BASE_URL as BASE, DEMO_OWNER } from "../demo/demo-constants.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const OUT = resolve(process.argv[2] ?? "editor-lab-out");
mkdirSync(OUT, { recursive: true });
const MAILBOX = DEMO_OWNER.email;

// Same structure as an agent-written support reply: headings as numbered
// one-item lists that continue with `start`, bullets, <br> address lines, links.
const BODY =
	"<p>Hi Guze,</p><p>Thanks for the detailed questions. Answers below, in your order.</p>" +
	"<p>COMPANY AND CONTRACT</p><ol><li><p>Legal entity</p></li></ol>" +
	"<p>We sell through our Merchant of Record:</p><p>Example Payments Inc<br>8 The Green, Dover<br>EIN: 000000000</p>" +
	'<ol start="2"><li><p>SLA</p></li></ol><p>Our standard plans don\'t include an uptime guarantee.</p>' +
	'<ol start="3"><li><p>If we discontinue the service</p></li></ol><p>You would get at least 80 days\' notice.</p>' +
	"<ul><li><p>Collections</p></li><li><p>Face IDs</p></li><li><p>Embeddings</p></li></ul>" +
	'<p>See <a href="https://example.com/dpa">the DPA</a> for details.</p><p>Regards,<br>Support</p>';

const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
	args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: DEMO_OWNER.email, password: DEMO_OWNER.password } });
if (!login.ok()) throw new Error(`login ${login.status()}`);

const created = await ctx.request.post(`${BASE}/api/v1/mailboxes/${encodeURIComponent(MAILBOX)}/drafts`, {
	data: { to: "guze@example.com", subject: "Editor probe " + Date.now(), body: BODY },
});
if (!created.ok()) throw new Error(`draft ${created.status()} ${await created.text()}`);
const draft = await created.json();
console.log("draft", draft.id);

const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
// The first load after a fresh dep cache can throw a duplicate-React hooks
// error while Vite re-optimises; a reload settles it (as in scripts/demo).
for (let i = 0; i < 4; i++) {
	await page.goto(`${BASE}/mail/${encodeURIComponent(MAILBOX)}/draft?m=${draft.id}`, { waitUntil: "domcontentloaded", timeout: 90000 });
	await page.waitForFunction(() => Boolean(window.__reactRouterRouteModules), null, { timeout: 60000 }).catch(() => {});
	await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
	await page.waitForTimeout(1500);
	const ok = await page.evaluate(() => !document.body.innerText.includes("Application Error"));
	if (ok) break;
}
await page.screenshot({ path: join(OUT, "reader.png") });

await page.getByRole("button", { name: "Edit", exact: true }).first().click();
const pm = page.locator(".ProseMirror").first();
try {
	// The editor is a lazy chunk; a cold dev server can take a while to serve it.
	await pm.waitFor({ timeout: 90000 });
} catch (e) {
	await page.screenshot({ path: join(OUT, "composer-timeout.png") });
	throw e;
}
await page.waitForTimeout(800);
await page.screenshot({ path: join(OUT, "composer.png") });

const report = await pm.evaluate((root) => {
	const pick = (el) => {
		const s = getComputedStyle(el);
		return { tag: el.tagName.toLowerCase(), marginTop: s.marginTop, marginBottom: s.marginBottom, paddingLeft: s.paddingLeft, listStyle: s.listStyleType, fontSize: s.fontSize, lineHeight: s.lineHeight };
	};
	const first = (sel) => root.querySelector(sel);
	return {
		classes: root.className,
		p: first(":scope > p") && pick(first(":scope > p")),
		ol: first("ol") && pick(first("ol")),
		ul: first("ul") && pick(first("ul")),
		li: first("li") && pick(first("li")),
		olStartAttr: [...root.querySelectorAll("ol")].map((o) => o.getAttribute("start")),
		html: root.innerHTML.slice(0, 600),
	};
});
console.log(JSON.stringify(report, null, 2));
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
await browser.close();
