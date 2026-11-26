#!/usr/bin/env node
/**
 * Builds the public demo: a static copy of the app that runs against seeded
 * data in the page (app/demo). No Worker, no bindings, no secrets.
 *
 *   npm run build:demo     ->  build-demo/client
 *   npm run serve:demo     ->  http://127.0.0.1:4173
 *
 * After the app build this removes what a static demo must not ship (the
 * service worker) and writes the hosting files: response headers and
 * robots.txt. Serving index.html for every app path is the host's job
 * (wrangler.jsonc sets it; Cloudflare Pages does it by default).
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const out = join(root, "build-demo");
const client = join(out, "client");

rmSync(out, { recursive: true, force: true });
const build = spawnSync(
	process.platform === "win32" ? "npx.cmd" : "npx",
	["react-router", "build", "--mode", "demo", "--config", "scripts/demo-site/vite.config.ts"],
	{ cwd: root, stdio: "inherit", env: { ...process.env, CLOUDMAIL_DEMO: "1", REACT_ROUTER_ROOT: root } },
);
if (build.status !== 0) process.exit(build.status ?? 1);
if (!existsSync(join(client, "index.html"))) throw new Error("the demo build wrote no index.html");

// Nothing in the demo may outlive the page: no offline cache, no install.
for (const file of ["sw.js", "manifest.webmanifest"]) rmSync(join(client, file), { force: true });
// React Router's server build is only used to write index.html.
rmSync(join(out, "server"), { recursive: true, force: true });
for (const file of ["_headers", "robots.txt"]) cpSync(join(here, "static", file), join(client, file));

// The page may only talk to itself: fail the build if demo code is missing
// or the app's service worker registration survived.
const assets = readdirSync(join(client, "assets")).filter((f) => f.endsWith(".js"));
const text = assets.map((f) => readFileSync(join(client, "assets", f), "utf8")).join("\n");
if (!text.includes("Sending is turned off in the demo.")) throw new Error("the demo backend is not in the bundle: was the build run in demo mode?");
if (!readFileSync(join(client, "index.html"), "utf8").includes('name="robots"')) throw new Error("index.html has no robots meta");

const size = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);
writeFileSync(join(out, "README.txt"), "Static files of the cloudmail public demo. Serve the client/ folder; see scripts/demo-site/README.md.\n");
console.log(`\ndemo built: ${client} (${(size(client) / 1024 / 1024).toFixed(1)} MB, ${assets.length} scripts)`);
