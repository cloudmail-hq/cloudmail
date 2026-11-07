// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Guards for wrangler.jsonc settings that change how the Worker behaves at
 * runtime and are easy to drop in an unrelated edit.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** wrangler.jsonc with `//` line comments removed (none sit inside strings). */
function readWranglerConfig(): { compatibility_flags?: string[] } {
	const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
	const json = raw
		.split("\n")
		.map((line) => line.replace(/^\s*\/\/.*$/, ""))
		.join("\n")
		.replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(json);
}

describe("wrangler.jsonc", () => {
	it("routes outbound fetch() through the public internet (global_fetch_strictly_public)", () => {
		// Without it, fetching a URL on this Worker's own zone skips that zone's
		// Worker routes and hits the origin: a same-zone AI gateway 404s.
		expect(readWranglerConfig().compatibility_flags).toContain("global_fetch_strictly_public");
	});

	it("keeps nodejs_compat", () => {
		expect(readWranglerConfig().compatibility_flags).toContain("nodejs_compat");
	});
});
