#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Generate the auth secrets a deployment needs.
 *
 *   npm run secrets                 print fresh SETUP_TOKEN and AUTH_SECRET
 *   npm run secrets -- --dev        write them into .dev.vars (creates it from
 *                                   .dev.vars.example if missing)
 *   npm run secrets -- --deploy     upload them with `wrangler secret bulk`
 *
 * Values are 32 random bytes, base64url: long enough that `/recover` accepts
 * SETUP_TOKEN (it needs 16+ characters) and free of characters that need
 * quoting in a shell or a dotenv file.
 *
 * Existing values are never replaced. AUTH_SECRET encrypts every enrolled
 * authenticator, so silently rotating it would lock 2FA users out; `--force`
 * exists for a deployment nobody has used yet.
 */

import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const NAMES = ["SETUP_TOKEN", "AUTH_SECRET"];
const args = new Set(process.argv.slice(2));
const force = args.has("--force");

const fresh = () => randomBytes(32).toString("base64url");

/** The value of `NAME=` in dotenv text, or "" when absent or empty. */
function dotenvValue(text, name) {
	const match = text.match(new RegExp(`^${name}=(.*)$`, "m"));
	return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
}

function writeDevVars() {
	const path = ".dev.vars";
	let text = existsSync(path)
		? readFileSync(path, "utf8")
		: existsSync(".dev.vars.example")
			? readFileSync(".dev.vars.example", "utf8")
			: "";

	for (const name of NAMES) {
		if (dotenvValue(text, name) && !force) {
			console.log(`${name}: kept the existing value in ${path}`);
			continue;
		}
		const line = `${name}=${fresh()}`;
		text = new RegExp(`^${name}=.*$`, "m").test(text)
			? text.replace(new RegExp(`^${name}=.*$`, "m"), line)
			: `${line}\n${text}`;
		console.log(`${name}: generated`);
	}
	writeFileSync(path, text, { mode: 0o600 });
	console.log(`\nWrote ${path}. Start the app with \`npm run dev\` and open /setup.`);
	console.log(`Your setup token: ${dotenvValue(text, "SETUP_TOKEN")}`);
}

/** Names of secrets already set on the deployed Worker. */
function deployedSecretNames() {
	try {
		const out = execFileSync("npx", ["wrangler", "secret", "list", "--format", "json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		});
		return new Set(JSON.parse(out).map((secret) => secret.name));
	} catch {
		// First deploy: the Worker does not exist yet, so nothing is set.
		return new Set();
	}
}

function deploy() {
	const existing = deployedSecretNames();
	const upload = {};
	for (const name of NAMES) {
		if (existing.has(name) && !force) {
			console.log(`${name}: already set on the Worker, left unchanged`);
			continue;
		}
		upload[name] = fresh();
	}
	if (Object.keys(upload).length === 0) {
		console.log("\nNothing to upload.");
		return;
	}

	// Through stdin, so the values never appear in a process listing.
	const result = spawnSync("npx", ["wrangler", "secret", "bulk"], {
		input: JSON.stringify(upload),
		stdio: ["pipe", "inherit", "inherit"],
	});
	if (result.status !== 0) process.exit(result.status ?? 1);

	if (upload.SETUP_TOKEN) {
		console.log(`\nYour setup token (save it in a password manager: it is also the`);
		console.log(`break-glass key for /recover):\n\n  ${upload.SETUP_TOKEN}\n`);
	}
	console.log("Open https://<your-worker>/setup to create the owner account.");
}

if (args.has("--dev")) writeDevVars();
else if (args.has("--deploy")) deploy();
else {
	for (const name of NAMES) console.log(`${name}=${fresh()}`);
	console.error(
		"\nPaste these into the Deploy to Cloudflare form, or run with --deploy to " +
			"upload them, or --dev to write .dev.vars.",
	);
}
