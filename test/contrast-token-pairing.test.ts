/**
 * Source-scanning guard for ink/fill pairings that break in dark mode.
 *
 * `--color-text-primary` is near-black in light mode and near-white in dark
 * mode. So `bg-text-primary` is a dark fill that becomes a light fill, and any
 * call site pairing it with a literal `text-white` renders white-on-near-white
 * the moment the reader switches theme — an invisible button, not merely a
 * low-contrast one.
 *
 * `--color-text-primary-foreground` exists precisely for this pairing and
 * inverts with it. This test asserts every call site uses it, because the defect
 * is invisible in light-mode review and no runtime test catches "the label is the
 * same colour as the button".
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = join(import.meta.dirname, "..", "app");

/**
 * Walk the app tree with the stdlib rather than a glob package.
 *
 * `tinyglobby` is present in `node_modules` but only as a transitive dependency,
 * so importing it here would make this guard fail the day the tree resolves
 * differently.
 */
function sourceFiles(dir = APP_DIR): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(full));
		else if (/\.tsx?$/.test(entry.name)) out.push(full);
	}
	return out;
}

/**
 * Utility strings in the source, deduplicated.
 *
 * Two passes are needed because a `className={cn("a", cond && "b")}` call puts
 * its utilities in ordinary quoted strings rather than in one attribute value,
 * so an attribute-only regex misses them. They overlap on plain attributes,
 * hence the Set: without it one call site is reported twice and a count-based
 * assertion reads as a second offender.
 */
function classAttributes(source: string): string[] {
	const out = new Set<string>();
	for (const [, value] of source.matchAll(/className\s*=\s*"([^"]*)"/g)) {
		if (value) out.add(value);
	}
	for (const [, value] of source.matchAll(/"([^"\n]*\b(?:bg|text)-[^"\n]*)"/g)) {
		out.add(value);
	}
	return [...out];
}

describe("dark-mode ink/fill token pairing", () => {
	it("finds source files to scan (positive control)", () => {
		const files = sourceFiles();
		expect(files.length).toBeGreaterThan(50);
	});

	it("detects the bad pairing when it is present (positive control)", () => {
		// Proves the matcher below can actually fail. Without this, a broken regex
		// reports a clean scan and the guard silently protects nothing.
		const poisoned = 'className="rounded bg-text-primary px-3 text-white"';
		const found = classAttributes(poisoned).filter(
			(v) => v.includes("bg-text-primary") && /\btext-white\b/.test(v),
		);
		expect(found).toHaveLength(1);
	});

	it("never pairs bg-text-primary with a literal text-white", () => {
		const offenders: string[] = [];

		for (const file of sourceFiles()) {
			const source = readFileSync(file, "utf8");
			for (const value of classAttributes(source)) {
				if (!value.includes("bg-text-primary")) continue;
				// `bg-text-primary-foreground` is a different token; don't flag it.
				if (/bg-text-primary-foreground/.test(value)) continue;
				if (/\btext-white\b/.test(value)) {
					offenders.push(`${file.replace(APP_DIR, "app")}: ${value.trim()}`);
				}
			}
		}

		expect(
			offenders,
			`Use text-text-primary-foreground, which inverts with the fill:\n${offenders.join("\n")}`,
		).toEqual([]);
	});
});
