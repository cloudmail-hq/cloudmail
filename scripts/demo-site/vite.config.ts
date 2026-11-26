/**
 * Build config for the public demo: the app as a static site.
 *
 *   npm run build:demo     # writes build-demo/client
 *
 * No Cloudflare plugin, so there is no Worker, no Durable Object and no
 * binding in the output. The app's API calls are answered in the page by
 * app/demo (see scripts/demo-site/README.md).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

if (process.env.CLOUDMAIL_DEMO !== "1") {
	throw new Error("scripts/demo-site/vite.config.ts builds the demo only. Run `npm run build:demo`.");
}

export default defineConfig({
	root,
	cacheDir: resolve(root, "node_modules/.vite-demo-site"),
	plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
});
