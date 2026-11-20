/*
  Browser paste harness for the composer.

  Pastes every fixture in test/fixtures/paste/ into the real composer through
  the native paste shortcut (ego-browser `keyboard.paste({ text, html })`), in
  light and dark mode, and records for each:

    - editor.getHTML(), the HTML that is saved and sent
    - computed text and background colour for every element carrying text
    - text below 3:1 contrast against its effective background
    - font families that differ from the editor's own
    - a screenshot of the composer

  It then saves one paste as a draft and reads it back through the API.

  Run it with the app on http://localhost:5197 (see the PR description for the
  offline local-dev recipe) and a mailbox created:

    ego-browser nodejs < test/fixtures/paste/harness/paste-baseline.ego.mjs

  ego-browser scripts do not inherit the shell's cwd or env, so set ROOT to
  the absolute path of your checkout first.
*/

const ROOT = "/Users/codder/Documents/hobby/mail-box/tapetide-agentic-inbox/.claude/worktrees/agent-ae79c6a0f7f82ed83";
const BASE = "http://localhost:5197";
const MAILBOX = "paste-baseline@tapetide.com";
const SPACE = "cloudmail paste baseline";

const fs = await import("node:fs/promises");
const path = await import("node:path");
const FIX = path.join(ROOT, "test/fixtures/paste");
// "baseline" was the run before the paste fix (PR #164); "after" is the run
// with it. Each writes results.json and screenshots to its own directory.
const RUN = "after";
const OUT = path.join(FIX, RUN);
await fs.mkdir(OUT, { recursive: true });

const names = [...new Set((await fs.readdir(FIX)).filter((f) => /\.(html|txt)$/.test(f)).map((f) => f.replace(/\.(html|txt)$/, "")))].sort();
const fixtures = [];
for (const name of names) {
	const read = (ext) => fs.readFile(path.join(FIX, `${name}.${ext}`), "utf8").catch(() => null);
	fixtures.push({ name, html: await read("html"), text: (await read("txt")) ?? "" });
}

const task = await taskSpace(SPACE);
const page = task.page("p1");

async function openComposer(mode) {
	await page.goto(`${BASE}/mail/${encodeURIComponent(MAILBOX)}/inbox`, { timeout: 60000 });
	await page.evaluate((m) => {
		localStorage.setItem("theme-storage", JSON.stringify({ state: { theme: m }, version: 0 }));
	}, mode);
	await page.reload({ timeout: 60000 });
	await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Compose"), null, { timeout: 30000 });
	await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Compose").click());
	await page.waitForSelector(".ProseMirror", { timeout: 30000 });
	const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
	if (dark !== (mode === "dark")) throw new Error(`theme did not switch to ${mode}`);
}

/** Runs in the page: inspects the editor after a paste. */
function inspect() {
	const pm = document.querySelector(".ProseMirror");
	const editor = pm.editor;
	const parse = (c) => {
		const m = c.match(/rgba?\(([^)]+)\)/);
		if (!m) return null;
		const [r, g, b, a = "1"] = m[1].split(/[ ,/]+/).filter(Boolean);
		return { r: +r, g: +g, b: +b, a: +a };
	};
	const over = (top, under) => ({
		r: top.r * top.a + under.r * (1 - top.a),
		g: top.g * top.a + under.g * (1 - top.a),
		b: top.b * top.a + under.b * (1 - top.a),
		a: 1,
	});
	// Effective background: composite every ancestor's background, page down.
	const effectiveBg = (el) => {
		const layers = [];
		for (let n = el; n; n = n.parentElement) {
			const c = parse(getComputedStyle(n).backgroundColor);
			if (c && c.a > 0) layers.push(c);
			if (c && c.a === 1) break;
		}
		let bg = { r: 255, g: 255, b: 255, a: 1 };
		for (const l of layers.reverse()) bg = over(l, bg);
		return bg;
	};
	const lum = ({ r, g, b }) => {
		const f = (v) => {
			v /= 255;
			return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
	};
	const ratio = (a, b) => {
		const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
		return (x + 0.05) / (y + 0.05);
	};
	const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
	const editorFont = getComputedStyle(pm).fontFamily;
	const editorBg = effectiveBg(pm);

	const samples = [];
	const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
	const seen = new Set();
	for (let t = walker.nextNode(); t; t = walker.nextNode()) {
		if (!t.textContent.trim()) continue;
		const el = t.parentElement;
		if (seen.has(el)) continue;
		seen.add(el);
		const cs = getComputedStyle(el);
		const fg = parse(cs.color);
		const bg = effectiveBg(el);
		const fgFlat = over(fg, bg);
		samples.push({
			text: t.textContent.trim().slice(0, 40),
			tag: el.tagName.toLowerCase(),
			color: hex(fgFlat),
			background: hex(bg),
			contrast: Math.round(ratio(fgFlat, bg) * 100) / 100,
			fontFamily: cs.fontFamily,
			fontSize: cs.fontSize,
			lineHeight: cs.lineHeight,
			inlineStyle: el.getAttribute("style"),
		});
	}
	const r = pm.closest('[role="dialog"]').getBoundingClientRect();
	return {
		html: editor.getHTML(),
		editorFont,
		editorBackground: hex(editorBg),
		editorColor: getComputedStyle(pm).color,
		samples,
		lowContrast: samples.filter((s) => s.contrast < 3),
		foreignFonts: [...new Set(samples.map((s) => s.fontFamily).filter((f) => f !== editorFont))],
		counts: Object.fromEntries(["h1", "h2", "h3", "ul", "ol", "li", "strong", "em", "a", "pre", "code", "table", "th", "td", "img", "br", "p"].map((t) => [t, pm.querySelectorAll(t).length])),
		dialog: { x: r.x, y: r.y, width: r.width, height: r.height },
	};
}

async function pasteFixture(fx) {
	await page.evaluate(() => {
		const ed = document.querySelector(".ProseMirror").editor;
		ed.commands.clearContent(true);
	});
	// A real click: the composer gives first focus to the To field, and a
	// programmatic focus alone left the paste shortcut landing elsewhere.
	await page.click(".ProseMirror", { label: "focus editor body" });
	await page.evaluate(() => document.querySelector(".ProseMirror").editor.commands.focus("start"));
	await page.keyboard.paste(fx.html ? { text: fx.text, html: fx.html } : { text: fx.text });
	await page.waitForFunction(() => document.querySelector(".ProseMirror").textContent.trim().length > 0, null, { timeout: 10000 });
	await page.waitForTimeout(150);
}

const results = [];
for (const mode of ["light", "dark"]) {
	await openComposer(mode);
	for (const fx of fixtures) {
		await pasteFixture(fx);
		const info = await page.evaluate(inspect);
		const shot = path.join(OUT, `${fx.name}.${mode}.png`);
		const d = info.dialog;
		await page.screenshot({ path: shot, clip: { x: d.x, y: d.y, width: d.width, height: d.height } });
		delete info.dialog;
		results.push({ fixture: fx.name, mode, flavours: fx.html ? ["text/html", "text/plain"] : ["text/plain"], screenshot: path.relative(ROOT, shot), ...info });
		console.log(`${mode} ${fx.name}: ${info.lowContrast.length} low-contrast, fonts=${info.foreignFonts.length}, bg=${/background/.test(info.html)}`);
	}
}

// Draft round trip: paste a fixture whose colours survive (iTerm2), save, read the stored body back.
await pasteFixture(fixtures.find((f) => f.name === "iterm2"));
await page.evaluate(() => {
	const input = document.querySelector("#compose-subject");
	if (input) {
		const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
		set.call(input, "paste-baseline draft");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}
});
await page.click('[aria-label="Save draft"]', { label: "save draft" });
await page.waitForTimeout(1500);
const draft = await page.evaluate(async (mb) => {
	const list = await (await fetch(`/api/v1/mailboxes/${encodeURIComponent(mb)}/emails?folder=draft`)).json();
	const rows = Array.isArray(list) ? list : list.emails;
	const row = rows.find((e) => e.subject === "paste-baseline draft") ?? rows[0];
	if (!row) return null;
	const full = await (await fetch(`/api/v1/mailboxes/${encodeURIComponent(mb)}/emails/${row.id}`)).json();
	return { id: row.id, subject: full.subject, body: full.body };
}, MAILBOX);

await fs.writeFile(path.join(OUT, "results.json"), JSON.stringify({ capturedAt: new Date().toISOString(), base: BASE, results, draft }, null, 2));
console.log({ draftId: draft?.id, draftHasInlineColor: /style="color/.test(draft?.body ?? ""), draftBody: draft?.body?.slice(0, 300) });
