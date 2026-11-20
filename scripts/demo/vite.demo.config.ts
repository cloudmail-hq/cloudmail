// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Offline dev server for the demo seed and the screenshot capture.
 *
 *   npx react-router dev --config scripts/demo/vite.demo.config.ts --host 127.0.0.1 --port 5173
 *
 * It reads the real wrangler.jsonc and writes a local-only copy beside this
 * file with everything that needs a Cloudflare login removed (Workers AI,
 * Vectorize, the remote send_email binding), demo domains in place of the real
 * ones, and the licence gate off. Nothing here changes how the app behaves;
 * see scripts/demo/README.md.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { DEMO_ZONES, DEMO_SETUP_TOKEN, DEMO_AUTH_SECRET } from "./demo-constants.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

/** JSONC to JSON: drop comments outside strings, then trailing commas. */
function parseJsonc(src: string): any {
	let out = "";
	let inStr = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (inStr) {
			out += ch;
			if (ch === "\\") out += src[++i];
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') { inStr = true; out += ch; continue; }
		if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
		if (ch === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
		out += ch;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const config = parseJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
delete config.ai;
delete config.vectorize;
delete config.$schema;
config.send_email = (config.send_email ?? []).map((b: Record<string, unknown>) => ({ name: b.name }));
config.main = join(root, "workers/app.ts");
config.name = "cloudmail";
config.vars = {
	...config.vars,
	DOMAINS: DEMO_ZONES.map((z: { domain: string }) => z.domain).join(","),
	ZONES: JSON.stringify(DEMO_ZONES),
	LICENCE_ENFORCEMENT: "off",
	LOCAL_AI_MOCK: "1",
	SETUP_TOKEN: DEMO_SETUP_TOKEN,
	AUTH_SECRET: DEMO_AUTH_SECRET,
	APP_URL: "http://127.0.0.1:5173",
	WORKER_SCRIPT_NAME: "cloudmail",
};
delete config.vars.SEMANTIC_INDEX_NAME;

const genDir = join(here, ".generated");
mkdirSync(genDir, { recursive: true });
const configPath = join(genDir, "wrangler.json");
writeFileSync(configPath, JSON.stringify(config, null, "\t"));

export default defineConfig({
	root,
	cacheDir: join(root, "node_modules/.vite-demo"),
	server: { fs: { strict: false } },
	plugins: [
		cloudflare({
			configPath,
			viteEnvironment: { name: "ssr" },
			persistState: { path: join(root, ".wrangler/demo-state") },
		}),
		tailwindcss(),
		reactRouter(),
		tsconfigPaths(),
	],
});
