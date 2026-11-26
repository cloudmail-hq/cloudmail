#!/usr/bin/env node
/**
 * Serves build-demo/client on http://127.0.0.1:4173 the way the static host
 * does: files as they are, index.html for every other path, and the headers
 * from _headers. For looking at the demo locally; not a production server.
 */

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const client = join(dirname(fileURLToPath(import.meta.url)), "../../build-demo/client");
if (!existsSync(join(client, "index.html"))) {
	console.error("build-demo/client is missing. Run `npm run build:demo` first.");
	process.exit(1);
}
const port = Number(process.env.PORT) || 4173;
const host = process.env.HOST || "127.0.0.1";

const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".woff2": "font/woff2",
	".webmanifest": "application/manifest+json",
};

/** The `/*` block of _headers, without HSTS (this server is plain http). */
const headers = {};
let block = "";
for (const line of readFileSync(join(client, "_headers"), "utf8").split("\n")) {
	if (!line.trim() || line.startsWith("#")) continue;
	if (!/^\s/.test(line)) block = line.trim();
	else if (block === "/*") {
		const at = line.indexOf(":");
		const name = line.slice(0, at).trim();
		// Cache-Control is set per path below.
		if (name !== "Strict-Transport-Security" && name !== "Cache-Control") headers[name] = line.slice(at + 1).trim();
	}
}

createServer((req, res) => {
	const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
	let file = join(client, path);
	if (!file.startsWith(client) || !existsSync(file) || statSync(file).isDirectory() || path === "/_headers") {
		file = join(client, "index.html");
	}
	res.writeHead(200, {
		...headers,
		"Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
		"Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
	});
	createReadStream(file).pipe(res);
}).listen(port, host, () => console.log(`cloudmail demo: http://${host}:${port}`));
