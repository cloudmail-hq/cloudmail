/**
 * Text tokens clear WCAG AA (4.5:1 for body text) on every surface they sit on,
 * in both themes.
 *
 * Read straight from `app/index.css`, so a token change that drops a pairing
 * below AA fails here rather than in someone's eyes. Tertiary text was 4.9:1 on
 * white but 3.95:1 on `bg-muted` (chips, hover rows) before this was checked
 * against the darker surfaces as well.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../app/index.css", import.meta.url), "utf8");

/** The `@theme { … }` block (light) and the `.dark { … }` block. */
function block(start: RegExp): string {
	const m = start.exec(css);
	if (!m) throw new Error(`block not found: ${start}`);
	const from = m.index + m[0].length;
	return css.slice(from, css.indexOf("\n}", from));
}

function tokens(source: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [, name, value] of source.matchAll(/--color-([\w-]+):\s*([^;]+);/g)) {
		out[name] = value.trim();
	}
	return out;
}

type RGB = [number, number, number];

function hslToRgb(h: number, s: number, l: number): RGB {
	s /= 100;
	l /= 100;
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0), f(8), f(4)];
}

function parse(value: string): RGB {
	const hsl = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(value);
	if (hsl) return hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
	const hex = /^#([0-9a-f]{6})$/i.exec(value);
	if (hex) {
		const n = Number.parseInt(hex[1], 16);
		return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
	}
	throw new Error(`unparsed colour: ${value}`);
}

function luminance([r, g, b]: RGB): number {
	const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: RGB, b: RGB): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

const light = tokens(block(/@theme\s*\{/));
// The dark block overrides; anything it does not set falls back to light.
const dark = { ...light, ...tokens(block(/^\.dark\s*\{/m)) };

const TEXT = ["text-primary", "text-secondary", "text-tertiary", "muted-foreground"];
/** Every surface body text is drawn on: page, card, read rows, chips and hover. */
const SURFACES = ["background", "card", "bg-subtle", "bg-muted"];
/** Semantic colours used as text on the page surfaces. */
const SEMANTIC = ["destructive", "success", "accent-subtle-fg"];

describe.each([
	["light", light],
	["dark", dark],
])("%s theme", (_name, t) => {
	it("parses the tokens it checks (positive control)", () => {
		for (const name of [...TEXT, ...SURFACES]) expect(t[name], name).toBeDefined();
		expect(contrast(parse("#000000"), parse("#ffffff"))).toBeCloseTo(21, 0);
	});

	for (const text of TEXT) {
		for (const surface of SURFACES) {
			it(`${text} on ${surface} is at least 4.5:1`, () => {
				expect(contrast(parse(t[text]), parse(t[surface]))).toBeGreaterThanOrEqual(4.5);
			});
		}
	}


	for (const text of SEMANTIC) {
		for (const surface of ["background", "card"]) {
			it(`${text} on ${surface} is at least 4.5:1`, () => {
				expect(contrast(parse(t[text]), parse(t[surface]))).toBeGreaterThanOrEqual(4.5);
			});
		}
	}

	it("accent-subtle-fg on accent-subtle (selected nav, active chips) is at least 4.5:1", () => {
		expect(
			contrast(parse(t["accent-subtle-fg"]), parse(t["accent-subtle"])),
		).toBeGreaterThanOrEqual(4.5);
	});

	it("the AI summary card: icon, bullets and every text tone are at least 4.5:1 on its tint", () => {
		for (const text of ["ai", "text-primary", "text-secondary"]) {
			expect(contrast(parse(t[text]), parse(t["ai-subtle"])), text).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("warning text on its own background is at least 4.5:1", () => {
		expect(contrast(parse(t["warning-text"]), parse(t["warning-bg"]))).toBeGreaterThanOrEqual(4.5);
	});

	it("secondary and tertiary text on the warning background are at least 4.5:1", () => {
		for (const text of ["text-secondary", "text-tertiary"]) {
			expect(contrast(parse(t[text]), parse(t["warning-bg"])), text).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("the off switch track is at least 3:1 on the card (non-text UI)", () => {
		expect(contrast(parse(t["switch-off"]), parse(t.card))).toBeGreaterThanOrEqual(3);
	});

	it("success text on a subtle row (the \"This browser\" badge) is at least 4.5:1", () => {
		expect(contrast(parse(t.success), parse(t["bg-subtle"]))).toBeGreaterThanOrEqual(4.5);
	});

	it("white button labels on the accent fill are at least 4.5:1", () => {
		expect(contrast(parse(t["accent-foreground"]), parse(t.accent))).toBeGreaterThanOrEqual(4.5);
	});
});

describe("dark theme borders", () => {
	it("card borders are visible against the card (at least 1.6:1; 21% L was 1.4:1)", () => {
		expect(contrast(parse(dark.border), parse(dark.card))).toBeGreaterThanOrEqual(1.6);
	});
});
