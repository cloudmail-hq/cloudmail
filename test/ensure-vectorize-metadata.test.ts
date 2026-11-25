import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { semanticIndexName, stripJsonc } from "../scripts/ensure-vectorize-metadata.mjs";

describe("scripts/ensure-vectorize-metadata.mjs", () => {
	it("reads the SEMANTIC_INDEX binding's index from this repo's wrangler.jsonc", () => {
		const cfg = JSON.parse(stripJsonc(readFileSync(join(__dirname, "..", "wrangler.jsonc"), "utf8")));
		expect(semanticIndexName(cfg)).toBe(cfg.vectorize[0].index_name);
	});

	it("strips comments and trailing commas but keeps // inside strings", () => {
		const text = `{
			// comment
			"url": "https://x//y", /* block */
			"vectorize": [{ "binding": "SEMANTIC_INDEX", "index_name": "idx", },],
		}`;
		const cfg = JSON.parse(stripJsonc(text));
		expect(cfg.url).toBe("https://x//y");
		expect(semanticIndexName(cfg)).toBe("idx");
	});

	it("is null without a Vectorize binding", () => {
		expect(semanticIndexName({})).toBeNull();
	});
});
