#!/usr/bin/env node
/**
 * Make sure the Vectorize index has the `mailbox` metadata index.
 *
 *   node scripts/ensure-vectorize-metadata.mjs [--config wrangler.jsonc]
 *
 * Runs after `wrangler deploy` (see the `deploy` script in package.json), so a
 * Deploy to Cloudflare button deploy gets it too: the button creates the
 * Vectorize index but not its metadata indexes. Semantic search filters every
 * query on `metadata.mailbox`, and Vectorize only filters vectors inserted
 * after the metadata index exists, so it has to be there before the first
 * message is embedded.
 *
 * Never fails the deploy. If the deploy token cannot manage Vectorize, it
 * prints what to do instead (the onboarding wizard creates the index once a
 * Cloudflare token with Vectorize Write is connected, or run the command by
 * hand) and exits 0.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROPERTY = "mailbox";

/** Drop // and /* *\/ comments and trailing commas, string-aware. Enough for wrangler.jsonc. */
export function stripJsonc(text) {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 1;
		} else {
			out += c;
		}
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

/** The index the SEMANTIC_INDEX binding names, or null when there is none. */
export function semanticIndexName(config) {
	const entry = (config.vectorize ?? []).find((v) => v.binding === "SEMANTIC_INDEX") ?? config.vectorize?.[0];
	return entry?.index_name ?? null;
}

/** The project's own wrangler (what `npm run deploy` just used), else the one on PATH. */
function wranglerBin() {
	const local = resolve("node_modules/.bin/wrangler");
	return existsSync(local) ? local : "wrangler";
}

function wrangler(args) {
	return execFileSync(wranglerBin(), args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
	});
}

function errText(e) {
	return `${e?.stdout ?? ""}${e?.stderr ?? ""}${e?.message ?? e}`;
}

function main() {
	const argv = process.argv.slice(2);
	const configPath = resolve(argv[argv.indexOf("--config") + 1] && argv.includes("--config") ? argv[argv.indexOf("--config") + 1] : "wrangler.jsonc");
	if (!existsSync(configPath)) {
		console.log(`[vectorize] ${configPath} not found; skipping the metadata index check.`);
		return;
	}
	const index = semanticIndexName(JSON.parse(stripJsonc(readFileSync(configPath, "utf8"))));
	if (!index) {
		console.log("[vectorize] No Vectorize binding; semantic search is off. Nothing to do.");
		return;
	}
	const manual = `npx wrangler vectorize create-metadata-index ${index} --property-name=${PROPERTY} --type=string`;
	try {
		const listed = wrangler(["vectorize", "list-metadata-index", index, "--json"]);
		const start = listed.search(/[[{]/);
		const parsed = start === -1 ? null : JSON.parse(listed.slice(start));
		const list = Array.isArray(parsed) ? parsed : (parsed?.metadataIndexes ?? []);
		if (list.some((m) => m.propertyName === PROPERTY)) {
			console.log(`[vectorize] ${index} already has the "${PROPERTY}" metadata index.`);
			return;
		}
	} catch (e) {
		// Fall through to create: list can fail on older wranglers and the
		// create below reports the real problem.
		console.log(`[vectorize] Could not list metadata indexes of ${index}: ${errText(e).split("\n").find((l) => l.trim()) ?? "unknown error"}`);
	}
	try {
		wrangler(["vectorize", "create-metadata-index", index, `--property-name=${PROPERTY}`, "--type=string"]);
		console.log(`[vectorize] Created the "${PROPERTY}" metadata index on ${index}.`);
	} catch (e) {
		const text = errText(e);
		if (/already exists/i.test(text)) {
			console.log(`[vectorize] ${index} already has the "${PROPERTY}" metadata index.`);
			return;
		}
		console.warn(
			[
				`[vectorize] WARNING: could not create the "${PROPERTY}" metadata index on ${index}.`,
				`  ${text.split("\n").find((l) => /error|✘|denied|auth/i.test(l)) ?? text.split("\n")[0]}`,
				"  The app still works, but semantic search stays off until it exists. Either connect a",
				"  Cloudflare token with Vectorize Write in the app's guided setup (it creates it for you),",
				`  or run: ${manual}`,
			].join("\n"),
		);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
