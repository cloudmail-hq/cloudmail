#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Launch screenshots of a local demo instance (see scripts/demo/README.md).
 *
 *   node scripts/demo/capture.mjs --out ./shots [--only inbox-light,thread] [--phase pre|main]
 *
 * `--phase pre` shoots the first-run /setup screen and must run before the
 * seed creates the owner. `--phase main` (the default) signs in as the demo
 * owner and shoots everything else. Each PNG is written as soon as it is ready.
 *
 * Needs `playwright` or `playwright-core` resolvable from the repo
 * (`npm i --no-save playwright-core`) and a Chromium: set CHROMIUM_PATH, or
 * run `npx playwright install chromium`.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { DEMO_BASE_URL, DEMO_OWNER } from "./demo-constants.mjs";

const require = createRequire(import.meta.url);
function loadPlaywright() {
	for (const name of ["playwright", "playwright-core"]) {
		try {
			return require(name);
		} catch {}
	}
	throw new Error("Install playwright-core: npm i --no-save playwright-core");
}

const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};
const OUT = resolve(arg("out", "shots"));
const ONLY = arg("only", "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const PHASE = arg("phase", "main");
const BASE = arg("base", DEMO_BASE_URL);
const EXPLORE = arg("explore", ""); // comma-separated paths: dump PNG + text, for development

mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** CSS that keeps captures clean: no scrollbars, caret, or animation mid-frame. */
const CLEAN_CSS = `
	*::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
	* { scrollbar-width: none !important; caret-color: transparent !important; }
	*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; }
	[data-sonner-toaster], [data-sonner-toast] { display: none !important; }
	vite-error-overlay { display: none !important; }
`;

/** The fixed-offset zone the seed wrote its times in (see seed-demo.mjs). */
function demoTimeZone() {
	try {
		return JSON.parse(readFileSync(new URL("./.generated/seed-manifest.json", import.meta.url), "utf8")).timeZone ?? "America/New_York";
	} catch {
		return "America/New_York";
	}
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM_PATH || undefined,
	args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
});

async function newContext({ viewport = DESKTOP, dark = false, mobile = false, storageState } = {}) {
	const ctx = await browser.newContext({
		viewport,
		deviceScaleFactor: 2,
		colorScheme: dark ? "dark" : "light",
		reducedMotion: "reduce",
		isMobile: mobile,
		hasTouch: mobile,
		locale: "en-US",
		timezoneId: demoTimeZone(),
		storageState,
		userAgent: mobile
			? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
			: undefined,
	});
	await ctx.addInitScript(
		({ css, theme }) => {
			try {
				localStorage.setItem("theme-storage", JSON.stringify({ state: { theme }, version: 0 }));
			} catch {}
			const add = () => {
				const s = document.createElement("style");
				s.setAttribute("data-demo-capture", "");
				s.textContent = css;
				(document.head || document.documentElement).appendChild(s);
			};
			if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
			else add();
		},
		{ css: CLEAN_CSS, theme: dark ? "dark" : "light" },
	);
	return ctx;
}

/** Waits until the client has hydrated and the network is quiet. */
async function settle(page, extra = 600) {
	await page.waitForLoadState("domcontentloaded");
	await page
		.waitForFunction(() => Boolean(window.__reactRouterRouteModules), null, { timeout: 30000 })
		.catch(() => {});
	await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
	await page.evaluate(() => document.fonts?.ready).catch(() => {});
	await page.waitForTimeout(extra);
}

async function goto(page, path, extra) {
	await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 90000 });
	await settle(page, extra);
	// A first dev-server load can re-optimise deps and reload into an error
	// page; retry a few times.
	for (let i = 0; i < 3; i++) {
		const ok = await page
			.evaluate(() => Boolean(window.__reactRouterRouteModules) && !document.body.innerText.includes("Application Error"))
			.catch(() => false);
		if (ok) break;
		await page.waitForTimeout(2000);
		await page.reload({ waitUntil: "domcontentloaded" });
		await settle(page, extra);
	}
}

async function shoot(page, name, { fullPage = false } = {}) {
	const file = join(OUT, `${name}.png`);
	// No hover or focus ring left on whatever was clicked last.
	await page.mouse.move(720, 2).catch(() => {});
	await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur()).catch(() => {});
	await page.waitForTimeout(250);
	await page.screenshot({ path: file, animations: "disabled", caret: "hide", fullPage });
	console.log(`wrote ${file}`);
}

/** Signs in once (sign-in is rate limited) and reuses the session cookies. */
let sessionCookies = null;
async function signIn(ctx) {
	if (sessionCookies) {
		await ctx.addCookies(sessionCookies);
		return;
	}
	const res = await ctx.request.post(`${BASE}/api/auth/login`, {
		data: { email: DEMO_OWNER.email, password: DEMO_OWNER.password },
	});
	if (!res.ok()) throw new Error(`login failed: ${res.status()} ${await res.text()}`);
	sessionCookies = (await ctx.storageState()).cookies;
}

const wanted = (name) => ONLY.length === 0 || ONLY.includes(name);

// ---------------------------------------------------------------- explore
if (EXPLORE) {
	const ctx = await newContext({ dark: args.includes("--dark"), viewport: args.includes("--phone") ? PHONE : DESKTOP, mobile: args.includes("--phone") });
	if (!args.includes("--anon")) await signIn(ctx);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.log("pageerror:", e.message));
	for (const p of EXPLORE.split(",")) {
		await goto(page, p, 1500);
		const name = "explore-" + p.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "");
		await shoot(page, name);
		const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
		console.log(`--- ${p} (${page.url()})\n${text}\n`);
	}
	await browser.close();
	process.exit(0);
}

// ---------------------------------------------------------------- phase: pre
if (PHASE === "pre") {
	if (wanted("setup")) {
		const ctx = await newContext();
		const page = await ctx.newPage();
		await goto(page, "/setup", 1000);
		const field = (n) => page.locator(`input[name="${n}"]`);
		await field("setupToken").fill("••••••••••••••••••••••••••••••••••••••••");
		await field("name").fill(DEMO_OWNER.name);
		await field("email").fill(DEMO_OWNER.email);
		await field("password").fill("Harbor-lantern 7 mosaic, quartz tide!");
		await field("confirm").fill("Harbor-lantern 7 mosaic, quartz tide!");
		await page.locator("body").click({ position: { x: 5, y: 5 } });
		await page.waitForTimeout(300);
		await shoot(page, "setup", { fullPage: true });
		await ctx.close();
	}
	await browser.close();
	process.exit(0);
}

// ---------------------------------------------------------------- phase: main
const SHOTS = await import("./capture-shots.mjs");
await SHOTS.run({ browser, newContext, signIn, goto, settle, shoot, wanted, BASE, DESKTOP, PHONE });
await browser.close();
