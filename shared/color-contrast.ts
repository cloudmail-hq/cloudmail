// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** WCAG contrast for hex colours, used by the branding accent warning. */

/** The app's indigo accent (`--color-accent`, hsl(243 75% 59%)). */
export const INDIGO_ACCENT = "#4F46E5";

/** Non-text UI (icons, the logo glyph, focus marks) needs 3:1 under WCAG 1.4.11. */
export const MIN_UI_CONTRAST = 3;

export function parseHex(hex: string): [number, number, number] | null {
	const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return null;
	const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
	const n = Number.parseInt(h, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
	const lin = (c: number) => {
		const v = c / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contrast ratio between two hex colours, or null if either doesn't parse. */
export function contrastRatio(a: string, b: string): number | null {
	const ca = parseHex(a);
	const cb = parseHex(b);
	if (!ca || !cb) return null;
	const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}
