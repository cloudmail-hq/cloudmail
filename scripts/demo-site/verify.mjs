#!/usr/bin/env node
/**
 * Drives the built demo in a real browser and checks what it promises.
 *
 *   npm run build:demo && npm run serve:demo &
 *   npm i --no-save playwright-core
 *   node scripts/demo-site/verify.mjs [out-dir]
 *
 * It needs a Chromium (CHROMIUM_PATH, default /usr/bin/chromium). Every
 * request the page makes is recorded; the run fails if any goes anywhere but
 * this site's static files and the font host, or carries a body.
 */

import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.DEMO_URL || "http://127.0.0.1:4173";
const OUT = process.argv[2] || "demo-verify";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
const results = [];
const requests = [];
const errors = [];
let failed = false;

function check(name, ok, detail = "") {
	results.push({ name, ok: !!ok, detail });
	if (!ok) failed = true;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function open(options = {}) {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
	const page = await context.newPage();
	page.on("request", (r) => requests.push({ method: r.method(), url: r.url(), body: r.postData(), referer: r.headers().referer ?? "" }));
	page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text().slice(0, 300));
	});
	return { context, page };
}

const shot = async (page, name) => {
	// Let lazy images and transitions settle, so a screenshot shows the resting state.
	await page.waitForTimeout(600);
	await page.screenshot({ path: `${OUT}/${name}.png` });
};
const rows = (page) => page.locator('[role="option"]');
const PDF = "Northwind-SOC2-Type-II.pdf";
const conversationCount = async (page) => (await page.getByText(/^\d+ conversations?$/).first().textContent())?.trim();
const folderCount = async (page, name) => {
	const link = page.locator("nav a, aside a").filter({ hasText: new RegExp(`^${name}`) }).first();
	return ((await link.textContent()) ?? "").replace(name, "").trim();
};

// ── 1. no sign-in, straight into the inbox ──────────────────────────
const { context, page } = await open();
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await rows(page).first().waitFor();
check("opens in the owner's inbox without signing in", /\/mail\/maya%40northwind\.example\/inbox$/.test(page.url()), page.url());
check("no sign-in form on the page", (await page.locator('input[type="password"]').count()) === 0);
const banner = page.getByRole("note", { name: "About this demo" });
check("demo notice is shown", /This is a demo\.\s*Nothing is saved\./.test((await banner.textContent()) ?? ""));
check("notice links to the site and pricing", (await banner.locator('a[href="https://trycloudmail.com"]').count()) === 1 && (await banner.locator('a[href="https://trycloudmail.com/pricing"]').count()) === 1);
const initialCount = await conversationCount(page);
const initialDrafts = await folderCount(page, "Drafts");
check("inbox lists seeded conversations", /^1\d conversations$/.test(initialCount ?? ""), initialCount);
// Today's brief: one line until it is opened, and a refresh closes it again.
const today = page.getByRole("button", { name: "Today", exact: true });
check("today's brief is on the inbox, collapsed", (await today.getAttribute("aria-expanded")) === "false" && (await page.locator("#today-card-body").isHidden()));
await page.getByRole("button", { name: /^\d+ to reply$/ }).click();
check("a count opens the brief on its list", (await today.getAttribute("aria-expanded")) === "true" && (await page.locator("#today-card-body li").first().isVisible()));
await shot(page, "01b-today-open");
await today.click();
check("the brief closes again", (await today.getAttribute("aria-expanded")) === "false" && (await page.locator("#today-card-body").isHidden()));
check("list rows carry AI summaries", (await page.locator('[aria-label="AI summary"]').count()) > 5);
await shot(page, "01-inbox");

// ── 2. open a thread: AI summary, attachments, drawn faces ──────────
await rows(page).filter({ hasText: "SOC 2 Type II report" }).first().click();
await page.getByText("AI-generated, can be wrong").waitFor();
check("thread shows the AI summary", (await page.getByText("Fjord Assurance issued Northwind's SOC 2").count()) > 0);
check("attachment is listed", (await page.getByText(PDF).count()) > 0);
const download = await page.locator(`a[aria-label="Download ${PDF}"]`).getAttribute("href");
check("attachment is a file made in the page", download?.startsWith("blob:"), download?.slice(0, 20));
await shot(page, "02-thread-summary");
await page.getByRole("button", { name: PDF }).click();
const frame = page.getByRole("dialog", { name: PDF }).locator("iframe, embed, object").first();
await frame.waitFor({ timeout: 8000 });
const previewSrc = (await frame.getAttribute("src")) ?? (await frame.getAttribute("data")) ?? "";
check("attachment preview opens from the page's own file", previewSrc.startsWith("blob:"), previewSrc.slice(0, 12));
await shot(page, "02b-attachment-preview");
await page.getByRole("dialog", { name: PDF }).getByRole("button", { name: "Close" }).click();

await page.goto(`${BASE}/mail/maya%40northwind.example/inbox`, { waitUntil: "networkidle" });
await rows(page).filter({ hasText: "Brightcup" }).first().click();
await page.getByText("AI-generated, can be wrong").waitFor();
const faces = await page.locator('img[src^="data:image/svg+xml"]').count();
check("senders have drawn faces", faces > 0, `${faces} faces`);
await shot(page, "03-thread-conversation");

// ── 3. star, label, archive ─────────────────────────────────────────
await page.getByRole("button", { name: "Star", exact: true }).first().click();
await page.getByRole("button", { name: "Unstar", exact: true }).first().waitFor();
check("star applies", true);
await page.getByRole("button", { name: "Labels", exact: true }).click();
await page.getByRole("menuitem", { name: "Finance" }).click();
await page.waitForTimeout(500);
await page.locator('a[href*="/label/"]').filter({ hasText: "Finance" }).first().click();
await rows(page).filter({ hasText: "Brightcup" }).first().waitFor({ timeout: 8000 });
check("label applies: the conversation is under Finance", true);
await shot(page, "04-starred-labelled");

// Archive a one-message conversation. (The reader archives the open message,
// so a conversation with more inbox mail stays listed, as in the app.)
await page.locator('a[href$="/inbox"]').first().click();
await rows(page).filter({ hasText: "SOC 2 Type II report" }).first().click();
await page.getByText("AI-generated, can be wrong").waitFor();
// The phone action bar has its own (hidden) Archive button; press the visible one.
await page.locator('button[aria-label="Archive"]:visible').first().click();
await page.getByText(`${Number.parseInt(initialCount) - 1} conversations`).first().waitFor({ timeout: 8000 }).catch(() => {});
const afterArchive = await conversationCount(page);
check("archive removes the conversation from the inbox", Number.parseInt(afterArchive) === Number.parseInt(initialCount) - 1, `${initialCount} -> ${afterArchive}`);
await shot(page, "05-after-archive");

// ── 4. write a draft, press Send ────────────────────────────────────
await page.getByRole("button", { name: "Compose" }).first().click();
await page.locator("#compose-to").fill("visitor-typed@example.org");
await page.keyboard.press("Enter");
await page.locator("#compose-subject").fill("Typed by the visitor: SECRET-CANARY-7731");
await page.locator(".ProseMirror").first().click();
await page.keyboard.press("Control+Home");
await page.keyboard.type("This text must never leave the page. SECRET-CANARY-7731");
await page.waitForTimeout(600);
await shot(page, "06-compose");
await page.getByRole("button", { name: /^Send$/ }).click();
await page.getByText("Sending is turned off in the demo.").first().waitFor({ timeout: 8000 });
check("Send shows the disabled message", true);
check("nothing is queued for sending", (await page.getByText(/Sending in \d+s/).count()) === 0);
await shot(page, "07-send-disabled");
await page.getByRole("button", { name: "Save draft" }).click();
await page.waitForTimeout(1000);
// In-app navigation (no reload): the draft is in Drafts, in memory.
await page.locator('a[href$="/draft"]').first().click();
await page.getByText("Typed by the visitor").first().waitFor({ timeout: 8000 });
check("the draft is saved to Drafts for this visit", true, `Drafts ${initialDrafts} -> ${await folderCount(page, "Drafts")}`);
await shot(page, "07b-draft-saved");

// ── 5. reload: everything is back ───────────────────────────────────
await page.goto(`${BASE}/mail/maya%40northwind.example/inbox`, { waitUntil: "networkidle" });
await rows(page).first().waitFor();
const reloadedCount = await conversationCount(page);
check("reload restores the inbox", reloadedCount === initialCount, `${afterArchive} -> ${reloadedCount}`);
check("reload restores the archived conversation", (await rows(page).filter({ hasText: "SOC 2 Type II report" }).count()) === 1);
check("reload clears the star", (await page.locator('[role="option"]').filter({ hasText: "Brightcup" }).locator('[aria-label="Unstar"], [aria-label="Starred"]').count()) === 0);
check("reload removes the visitor's draft", (await folderCount(page, "Drafts")) === initialDrafts, `Drafts ${initialDrafts}`);
check("demo notice is back after a reload", (await page.getByRole("note", { name: "About this demo" }).count()) === 1);
const storage = await page.evaluate(async () => ({
	cookies: document.cookie,
	idb: indexedDB.databases ? (await indexedDB.databases()).length : 0,
	sw: (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0,
	caches: (await caches?.keys?.())?.length ?? 0,
}));
const realStorage = await context.storageState();
check("nothing is kept in cookies, storage, IndexedDB, caches or a service worker", storage.cookies === "" && storage.idb === 0 && storage.sw === 0 && storage.caches === 0 && realStorage.cookies.length === 0 && realStorage.origins.every((o) => o.localStorage.length === 0), JSON.stringify({ ...storage, origins: realStorage.origins.length }));
await shot(page, "08-after-reload");

// ── 6. stored AI: Ask and the agent panel ───────────────────────────
await page.goto(`${BASE}/mail/maya%40northwind.example/search?q=${encodeURIComponent("What did Brightcup say about payment terms?")}&ask=1`, { waitUntil: "networkidle" });
await page.getByText(/net-30 with a 2% early-payment discount/).first().waitFor({ timeout: 8000 });
check("Ask answers from the mail with sources", (await page.getByText(/AI answer from your mail/).count()) > 0);
check("the search under the answer lists the related mail", (await rows(page).filter({ hasText: "Brightcup" }).count()) > 0);
await shot(page, "09-ask");

await page.goto(`${BASE}/mail/maya%40northwind.example/inbox`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "AI agent" }).click();
await page.getByText("What needs my attention this week?").waitFor({ timeout: 8000 });
check("agent panel opens with a stored conversation", (await page.getByText(/Saved to/).count()) > 0);
await page.getByPlaceholder(/./).last().fill("Any unread emails?");
await page.getByRole("button", { name: "Send message" }).click();
await page.getByText(/\d unread:/).waitFor({ timeout: 10000 });
check("agent answers from the mailbox", true);
await shot(page, "10-agent");

// ── 6b. every folder has mail; the Screener, Spam and sequences ─────
const M = `${BASE}/mail/maya%40northwind.example`;
for (const folder of ["spam", "trash", "snoozed", "archive"]) {
	await page.goto(`${M}/${folder}`, { waitUntil: "networkidle" });
	await rows(page).first().waitFor({ timeout: 8000 }).catch(() => {});
	check(`${folder} has mail`, (await rows(page).count()) > 1, `${await rows(page).count()} rows`);
	if (folder !== "archive") await shot(page, `17-folder-${folder}`);
}
// The other mailboxes too: a visitor who switches mailbox finds no empty folder.
const emptyFolders = await page.evaluate(async () => {
	const { mailboxes } = await (await fetch("/api/v1/mailboxes")).json().then((r) => (Array.isArray(r) ? { mailboxes: r } : r));
	const empty = [];
	for (const m of mailboxes) {
		const id = m.email ?? m.id;
		const folders = await (await fetch(`/api/v1/mailboxes/${encodeURIComponent(id)}/folders`)).json();
		for (const name of ["archive", "snoozed", "spam", "trash"]) {
			if (!(folders.find((f) => f.id === name)?.totalCount > 0)) empty.push(`${id} ${name}`);
		}
	}
	return { checked: mailboxes.length, empty };
});
check("Archive, Snoozed, Spam and Trash hold mail in every mailbox", emptyFolders.checked > 1 && emptyFolders.empty.length === 0, emptyFolders.empty.join(", ") || `${emptyFolders.checked} mailboxes`);
await page.goto(`${M}/spam`, { waitUntil: "networkidle" });
await rows(page).filter({ hasText: "Wire transfer needed" }).first().click();
await page.getByText(/Replies would go to quickmailbox\.example/).first().waitFor({ timeout: 8000 });
check("spam says why it was filtered", true);
await shot(page, "18-spam-reasons");

await page.goto(`${M}/screener`, { waitUntil: "networkidle" });
await page.getByText(/\d senders waiting/).waitFor({ timeout: 8000 });
check("the Screener lists first-time senders with a verdict", (await page.getByText("Looks like cold sales (high)").count()) > 0);
await shot(page, "19-screener");
await page.getByRole("button", { name: "Yes, allow carla@ridgelinecapital.example" }).click();
await page.getByText(/allowed · 1 moved to Inbox/).waitFor({ timeout: 8000 });
check("Yes moves a sender's mail to the Inbox for this visit", (await page.getByText("4 senders waiting").count()) > 0);

await page.goto(`${BASE}/sequences`, { waitUntil: "networkidle" });
await page.getByText("Cold outreach: engineering leaders").first().waitFor({ timeout: 8000 });
check("sequences cover signup, cold outreach and win-back", (await page.getByText("New signup onboarding").count()) > 0 && (await page.getByText("Trial ended: win-back").count()) > 0);
await shot(page, "20-sequences");
await page.goto(`${BASE}/templates`, { waitUntil: "networkidle" });
await page.getByText("Cold outreach: first email").first().waitFor({ timeout: 8000 });
check("templates are listed", (await page.getByText("Signup: welcome").count()) > 0);
await shot(page, "21-templates");

// ── 7. settings are read-only ───────────────────────────────────────
await page.goto(`${BASE}/settings/licence`, { waitUntil: "networkidle" });
await page.getByText("One-time licence: active").waitFor({ timeout: 8000 });
check("licence page shows no key form", (await page.locator('input[name="key"], input[placeholder*="key" i]').count()) === 0);
await page.getByRole("button", { name: "Deactivate" }).click().catch(() => {});
await shot(page, "11-settings-licence");
await page.goto(`${BASE}/settings/account`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
check("account page has no sign-out and no tapetide links", (await page.getByText("Sign out").count()) === 0 && (await page.locator('a[href*="tapetide"]').count()) === 0);
await shot(page, "12-settings-account");
// Hiding the notice gives its space back, until the next reload.
await page.getByRole("button", { name: "Hide this notice" }).click();
const barTop = await page.locator("[data-app-topbar]").evaluate((el) => `${el.getBoundingClientRect().top}/${getComputedStyle(el).paddingTop}`);
check("the notice can be hidden", (await page.getByRole("note", { name: "About this demo" }).count()) === 0 && barTop === "0/0px", barTop);
await context.close();

// ── 8. phone width and dark mode ────────────────────────────────────
{
	const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
	await phone.page.goto(`${BASE}/`, { waitUntil: "networkidle" });
	await rows(phone.page).first().waitFor();
	const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	check("phone width: no sideways scroll", overflow <= 0, `${overflow}px`);
	await shot(phone.page, "13-phone-inbox");
	await rows(phone.page).filter({ hasText: "SOC 2 Type II report" }).first().click();
	await phone.page.getByText("AI-generated, can be wrong").waitFor();
	await shot(phone.page, "14-phone-thread");
	await phone.context.close();

	const dark = await open({ colorScheme: "dark" });
	await dark.page.goto(`${BASE}/`, { waitUntil: "networkidle" });
	await rows(dark.page).first().waitFor();
	const isDark = await dark.page.evaluate(() => document.documentElement.classList.contains("dark"));
	check("dark mode follows the system", isDark);
	await shot(dark.page, "15-dark-inbox");
	await rows(dark.page).filter({ hasText: "Brightcup" }).first().click();
	await dark.page.getByText("AI-generated, can be wrong").waitFor();
	await shot(dark.page, "16-dark-thread");
	await dark.context.close();
}

// ── 9. the request log ──────────────────────────────────────────────
const origin = new URL(BASE).origin;
const FONTS = new Set(["https://fonts.googleapis.com", "https://fonts.gstatic.com"]);
// Only these schemes reach a network. blob: and data: are files made in the
// page, and chrome: / chrome-extension: are the browser's own PDF viewer.
const NETWORK = new Set(["http:", "https:", "ws:", "wss:"]);
const bad = requests.filter((r) => {
	const u = new URL(r.url);
	if (!NETWORK.has(u.protocol)) return false;
	if (r.method !== "GET" || r.body) return true;
	if (u.origin === origin) return /^\/(api|agents)\//.test(u.pathname) || u.search !== "" && u.pathname.startsWith("/assets/");
	return !FONTS.has(u.origin);
});
const byKind = {};
for (const r of requests) {
	const u = new URL(r.url);
	const kind = !NETWORK.has(u.protocol) ? `${u.protocol} (in the browser)` : u.origin === origin ? (u.pathname.startsWith("/assets/") ? "site /assets/*" : "site pages and icons") : u.origin;
	byKind[kind] = (byKind[kind] ?? 0) + 1;
}
console.log("\nrequests:", JSON.stringify(byKind));
check("every request is a GET for a static file", bad.length === 0, bad.slice(0, 5).map((r) => `${r.method} ${r.url}`).join(", "));
check("nothing the visitor typed is in any request", !requests.some((r) => /CANARY|visitor-typed/i.test(r.url + (r.body ?? "") + r.referer)));
// (The font stylesheet names itself when it loads its font files; that is not a demo page.)
const referers = requests.filter((r) => NETWORK.has(new URL(r.url).protocol) && r.referer.startsWith(origin));
check("no request says which demo page it came from", referers.length === 0, referers.slice(0, 3).map((r) => r.referer).join(", "));
// The app logs a refused mutation; the refused send is the one expected here.
const unexpected = errors.filter((e) => !e.includes("Sending is turned off in the demo."));
check("no page errors", unexpected.length === 0, unexpected.slice(0, 4).join(" | "));

await browser.close();
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed. Screenshots: ${OUT}/`);
process.exit(failed ? 1 : 0);
