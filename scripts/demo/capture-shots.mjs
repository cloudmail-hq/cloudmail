// The signed-in launch screenshots. Driven by scripts/demo/capture.mjs, which
// passes in the browser helpers. Every shot is independent: one failing logs
// and the rest still run.

import { AGENT_CONVERSATION } from "./agent-conversation.mjs";

const MAYA = "maya@northwind.example";
const SALES = "sales@northwind.example";
const enc = encodeURIComponent;

export async function run(h) {
	const { newContext, signIn, goto, shoot, wanted, PHONE } = h;

	async function withPage(opts, fn) {
		const ctx = await newContext(opts);
		await signIn(ctx);
		const page = await ctx.newPage();
		page.on("pageerror", (e) => console.log(`  pageerror: ${e.message.split("\n")[0]}`));
		try {
			await fn(page, ctx);
		} finally {
			await ctx.close();
		}
	}

	async function shot(name, opts, fn) {
		if (!wanted(name)) return;
		const t0 = Date.now();
		try {
			await withPage(opts, async (page, ctx) => {
				await fn(page, ctx);
				await shoot(page, name);
			});
			console.log(`  ${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
		} catch (e) {
			console.log(`FAILED ${name}: ${e.message.split("\n")[0]}`);
		}
	}

	/**
	 * Opens a conversation in the list by (part of) its subject. Clicking a row
	 * also makes it the keyboard cursor (a ring and hover actions), so the
	 * reader's deep link (`?m=`) is then loaded fresh, which opens it without.
	 */
	async function openThread(page, subject) {
		const row = page.getByText(subject, { exact: false }).first();
		await row.waitFor({ timeout: 20000 });
		await row.click();
		await page.waitForFunction(() => new URL(location.href).searchParams.has("m"), null, { timeout: 15000 }).catch(() => {});
		const url = page.url();
		await page.goto(url, { waitUntil: "domcontentloaded" });
		await h.settle(page, 1500);
	}

	/** Serves the demo agent conversation as the panel's stored history. */
	async function stubAgentHistory(ctx) {
		await ctx.route("**/agents/email-agent/*/get-messages", (route) =>
			route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(AGENT_CONVERSATION) }),
		);
	}

	// ── Inbox, light and dark
	for (const dark of [false, true]) {
		await shot(dark ? "inbox-dark" : "inbox-light", { dark }, async (page) => {
			await goto(page, `/mail/${enc(MAYA)}/inbox`, 1200);
			await openThread(page, "Q4 wholesale order");
		});
	}

	// ── A conversation, reading pane focused
	await shot("thread", {}, async (page) => {
		await goto(page, `/mail/${enc(MAYA)}/inbox`, 800);
		await openThread(page, "Booth layout for HostEx");
	});

	// ── Composer
	await shot("compose", {}, async (page) => {
		await goto(page, `/mail/${enc(MAYA)}/inbox`, 800);
		await page.getByRole("button", { name: "Compose" }).first().click();
		await page.waitForTimeout(1200);
		const to = page.locator('input[aria-label="To"]').first();
		await to.click();
		await to.fill("ruth.abara@meridianhotels.example");
		await page.keyboard.press("Enter");
		await page.locator("#compose-subject").fill("Breakfast service proposal for Meridian Hotels");
		await page.evaluate(() => document.querySelectorAll("[contenteditable], input, textarea").forEach((el) => (el.spellcheck = false)));
		const editor = page.locator('[contenteditable="true"]').first();
		await editor.click();
		// Type above the signature the composer inserts.
		await page.keyboard.press("Control+Home");
		await page.keyboard.type(
			"Hi Ruth,\n\nThanks again for Tuesday's call. As promised, here is a short proposal for breakfast service across your 22 properties: two S2 machines per hotel, on-site barista training, and next-day technician cover.\n\nHappy to walk your team through it next week.",
			{ delay: 0 },
		);
		// Let autosave run, so the footer reads as saved.
		await page.waitForTimeout(5000);
	});

	// ── Search
	await shot("search", {}, async (page) => {
		await goto(page, `/mail/all/search?q=${enc("Meridian")}`, 1500);
	});

	// ── AI agent panel
	await shot("agent", {}, async (page, ctx) => {
		await stubAgentHistory(ctx);
		await goto(page, `/mail/${enc(MAYA)}/inbox`, 800);
		await openThread(page, "Q4 wholesale order");
		await page.getByRole("button", { name: "AI agent" }).first().click();
		await page.getByRole("log", { name: "Agent conversation" }).waitFor({ timeout: 20000 });
		await page.waitForTimeout(1500);
	});

	// ── Sends waiting for approval
	await shot("approvals", {}, async (page) => {
		await goto(page, `/mail/${enc(SALES)}/approvals`, 1500);
		await page.getByText("Your Care plan renews on December 1").first().click();
		await page.waitForTimeout(1500);
	});

	// ── Sequences: the detail of the onboarding sequence
	await shot("sequences", {}, async (page) => {
		await goto(page, "/sequences", 800);
		await page.getByText("New café onboarding").first().click();
		await page.waitForTimeout(1500);
		await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
	});

	// ── Analytics
	await shot("analytics", {}, async (page) => {
		await goto(page, "/analytics/engagement", 2000);
	});

	// ── Settings → Domains
	await shot("settings-domains", {}, async (page, ctx) => {
		// Offline there is no Cloudflare account to connect, which the page would
		// show as a "Cloudflare isn't connected" notice. Report it as connected;
		// everything else on the page is the seeded state.
		await ctx.route("**/api/v1/domains", async (route) => {
			const res = await route.fetch();
			const body = await res.json();
			if (body?.cloudflare) body.cloudflare.configured = true;
			await route.fulfill({ response: res, json: body });
		});
		await goto(page, "/settings/domains", 1500);
	});

	// ── Guided setup (onboarding)
	await shot("onboarding", {}, async (page) => {
		await goto(page, "/onboarding", 1500);
		// A pasted token, masked (nothing is submitted).
		const token = page.getByLabel(/API token/i).first();
		if (await token.count()) {
			await token.fill("•".repeat(40));
			await page.locator("body").click({ position: { x: 5, y: 860 } });
		}
	});

	// ── Phone
	await shot("mobile-inbox", { viewport: PHONE, mobile: true }, async (page) => {
		await goto(page, `/mail/${enc(MAYA)}/inbox`, 1500);
	});
	await shot("mobile-thread", { viewport: PHONE, mobile: true }, async (page) => {
		await goto(page, `/mail/${enc(MAYA)}/inbox`, 1000);
		await openThread(page, "Q4 wholesale order");
	});
}
