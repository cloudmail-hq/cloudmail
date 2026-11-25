import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Standalone Vitest config.
 *
 * Deliberately does NOT extend `vite.config.ts`: that config loads the
 * Cloudflare plugin, which boots a workerd runtime and rewrites module
 * resolution. These are fast unit tests over pure logic and hand-mocked
 * bindings, so a plain Node environment is both sufficient and much quicker.
 *
 * Integration tests that need real Durable Object storage should live under
 * `test/integration/` and use `@cloudflare/vitest-pool-workers` instead.
 */
export default defineConfig({
	// `~` is the app alias used by the frontend, so pure client-side modules
	// (message HTML preparation, formatting helpers) can be unit tested too.
	resolve: {
		alias: {
			"~": fileURLToPath(new URL("./app", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		server: {
			deps: {
				// Transformed rather than loaded natively, so a test's
				// `vi.mock("cloudflare:workers")` reaches its import of that module.
				inline: ["@cloudflare/workers-oauth-provider"],
			},
		},
		reporters: ["default"],
	},
});
