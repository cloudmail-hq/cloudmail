// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The generated web app manifest.
 *
 * Driven through a real Hono route with a stub bucket, because the interesting
 * property is that the manifest reflects the *stored* branding record: a static
 * file would name whatever the upstream project was called, and an operator who
 * rebranded would install an app called something else.
 *
 * The route mirrors `workers/index.ts`. Importing the real app needs Worker
 * bindings, and what is asserted here is the document the browser reads, not the
 * routing.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { getBranding } from "../workers/lib/branding";

/** A bucket holding the branding record, or nothing. */
function bucket(record?: Record<string, unknown>) {
	return {
		async get(key: string) {
			if (key !== "branding/settings.json" || !record) return null;
			return { json: async () => record };
		},
	} as unknown as R2Bucket;
}

function manifestApp(record?: Record<string, unknown>) {
	const app = new Hono<{ Bindings: { BUCKET: R2Bucket } }>();

	app.get("/manifest.webmanifest", async (c) => {
		const branding = await getBranding(c.env.BUCKET);

		const manifest: Record<string, unknown> = {
			name: branding.appName,
			short_name: branding.appName,
			...(branding.tagline ? { description: branding.tagline } : {}),
			start_url: "/",
			scope: "/",
			display: "standalone",
			theme_color: branding.accentColor,
			background_color: "#ffffff",
			icons: [
				{ src: "/icon-192.png", type: "image/png", sizes: "192x192", purpose: "any" },
				{ src: "/icon-512.png", type: "image/png", sizes: "512x512", purpose: "any" },
				{
					src: "/icon-512-maskable.png",
					type: "image/png",
					sizes: "512x512",
					purpose: "maskable",
				},
				...(branding.logoMimeType
					? [
							{
								src:
									branding.logoUpdatedAt !== null
										? `/api/v1/branding/logo?v=${branding.logoUpdatedAt}`
										: "/api/v1/branding/logo",
								type: branding.logoMimeType,
								sizes: "any",
								purpose: "any",
							},
						]
					: []),
			],
		};

		return new Response(JSON.stringify(manifest), {
			headers: {
				"Content-Type": "application/manifest+json",
				"Cache-Control": "public, max-age=300",
				"X-Content-Type-Options": "nosniff",
			},
		});
	});

	return async () => {
		const res = await app.fetch(
			new Request("https://mailer.tapetide.com/manifest.webmanifest"),
			{ BUCKET: bucket(record) },
		);
		return { res, body: (await res.json()) as Record<string, unknown> };
	};
}

describe("manifest headers", () => {
	it("serves the registered manifest media type", async () => {
		const { res } = await manifestApp()();
		// Not application/json: some installers key off this type.
		expect(res.headers.get("Content-Type")).toBe("application/manifest+json");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("caches only briefly, because branding can change", async () => {
		// An installed app re-reading a year-stale manifest would keep the old name.
		const { res } = await manifestApp()();
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
	});
});

describe("manifest contents", () => {
	it("is installable with no branding record at all", async () => {
		// A fresh deployment has no record; the manifest still has to be valid.
		const { body } = await manifestApp()();

		expect(body.name).toBe("cloudmail");
		expect(body.short_name).toBe("cloudmail");
		expect(body.start_url).toBe("/");
		expect(body.scope).toBe("/");
		// The three fields an installer actually requires.
		expect(body.display).toBe("standalone");
		expect(typeof body.theme_color).toBe("string");
	});

	it("reflects the stored branding rather than a hard-coded name", async () => {
		// The whole reason this is generated. A static file would name the upstream
		// project, and a rebranded deployment would install as that.
		const { body } = await manifestApp({
			appName: "Acme Mail",
			tagline: "Mail for Acme",
			accentColor: "#ff0055",
			updatedAt: 1,
		})();

		expect(body.name).toBe("Acme Mail");
		expect(body.short_name).toBe("Acme Mail");
		expect(body.description).toBe("Mail for Acme");
		expect(body.theme_color).toBe("#ff0055");
	});

	it("omits the description when there is no tagline", async () => {
		// An empty description is worse than none: installers surface it verbatim.
		const { body } = await manifestApp({
			appName: "Acme Mail",
			tagline: null,
			updatedAt: 1,
		})();

		expect("description" in body).toBe(false);
	});

	it("declares the 192px and 512px icons Chromium requires, with no logo set", async () => {
		// The regression this replaces: with no branding logo the manifest omitted
		// `icons` entirely, and Chromium's installability criteria require both sizes
		// — so a fresh deployment shipped an app that could not be installed at all.
		const { body } = await manifestApp({ appName: "Acme Mail", updatedAt: 1 })();
		const icons = body.icons as { sizes: string; purpose: string }[];

		const any = icons.filter((icon) => icon.purpose === "any").map((i) => i.sizes);
		expect(any).toContain("192x192");
		expect(any).toContain("512x512");
	});

	it("offers a distinct maskable icon", async () => {
		// A platform applying a circular mask crops the corners. Reusing the `any`
		// art is what produces the clipped-logo look on Android, so the maskable
		// entry is its own image with the glyph inset further.
		const { body } = await manifestApp()();
		const icons = body.icons as { src: string; purpose: string }[];
		const maskable = icons.filter((icon) => icon.purpose === "maskable");

		expect(maskable).toHaveLength(1);
		expect(maskable[0]!.src).not.toBe(
			icons.find((i) => i.purpose === "any" && i.src.includes("512"))!.src,
		);
	});

	it("points at the versioned logo when one exists", async () => {
		const { body } = await manifestApp({
			appName: "Acme Mail",
			logoMimeType: "image/png",
			logoUpdatedAt: 1756000000,
			updatedAt: 1756000000,
		})();

		const icons = body.icons as { src: string; type: string; sizes: string }[];
		const logo = icons.find((icon) => icon.src.startsWith("/api/v1/branding/logo"))!;

		// Versioned, because the logo lives at one fixed key overwritten in place —
		// without a changing URL an installed app keeps the previous image forever.
		expect(logo.src).toBe("/api/v1/branding/logo?v=1756000000");
		expect(logo.type).toBe("image/png");
		// `any` rather than an invented pixel size: the dimensions are unknown here.
		expect(logo.sizes).toBe("any");
		// Added alongside the bundled pair, not instead of them, so a deployment with
		// an odd-sized logo stays installable.
		expect(icons.some((icon) => icon.sizes === "192x192")).toBe(true);
		expect(icons.some((icon) => icon.sizes === "512x512")).toBe(true);
	});

	it("falls back to the unversioned logo URL when there is no timestamp", async () => {
		const { body } = await manifestApp({
			appName: "Acme Mail",
			logoMimeType: "image/png",
			logoUpdatedAt: null,
			updatedAt: 1,
		})();

		const icons = body.icons as { src: string }[];
		expect(icons.some((icon) => icon.src === "/api/v1/branding/logo")).toBe(true);
	});

	it("survives a malformed branding record", async () => {
		// `getBranding` degrades per field rather than failing; the manifest must not
		// be the thing that turns a cosmetic drift into a non-installable app.
		const { res, body } = await manifestApp({
			appName: 42,
			accentColor: "not a colour",
			logoMimeType: "text/html",
			updatedAt: "nope",
		})();

		expect(res.status).toBe(200);
		expect(typeof body.name).toBe("string");
		expect((body.name as string).length).toBeGreaterThan(0);
	});

	it("declares no shortcuts, since composing has no URL", async () => {
		// A Compose shortcut would land on the inbox and look broken: the composer is
		// store state inside the workspace, not a route.
		const { body } = await manifestApp()();
		expect("shortcuts" in body).toBe(false);
	});
});

/**
 * The route above is a transcription of the real one, and a transcription can
 * drift. These read the actual source so a change to the manifest that is not
 * reflected here fails the suite instead of being quietly untested.
 *
 * Source text rather than the module, because importing `workers/index.ts`
 * requires Worker bindings.
 */
describe("the real route", () => {
	const source = readFileSync(
		new URL("../workers/index.ts", import.meta.url),
		"utf8",
	);
	const route =
		source.slice(
			source.indexOf('app.get("/manifest.webmanifest"'),
			source.indexOf('app.get("/api/v1/branding/logo"'),
		) || "";

	it("exists and is served at the path the document links to", () => {
		expect(route).not.toBe("");

		const root = readFileSync(new URL("../app/root.tsx", import.meta.url), "utf8");
		expect(root).toContain('rel="manifest"');
		expect(root).toContain('href="/manifest.webmanifest"');
	});

	it("is linked with use-credentials, or Access makes it non-installable", () => {
		// The failure this guards is silent: a default anonymous manifest fetch is
		// bounced at the edge by Access and the browser just reports the app as
		// non-installable, with nothing in the console tying it to Access.
		const root = readFileSync(new URL("../app/root.tsx", import.meta.url), "utf8");
		expect(root).toContain('crossOrigin="use-credentials"');
	});

	it("builds its fields from the branding record, not from literals", () => {
		for (const field of ["branding.appName", "branding.accentColor", "branding.tagline"]) {
			expect(route).toContain(field);
		}
		// The point of generating it: no hard-coded product name.
		expect(route).not.toContain('name: "Tapetide');
	});

	it("declares the fields an installer requires", () => {
		for (const field of ["start_url", "scope", "display", "theme_color"]) {
			expect(route).toContain(field);
		}
		expect(route).toContain('"application/manifest+json"');
	});
});


/**
 * The declared icons exist, at the sizes claimed.
 *
 * A manifest naming a missing or wrongly-sized icon is not installable either —
 * Chromium reports "no supplied icon is at least Npx square" and declines. The
 * manifest and the files have to agree, and nothing else in the build checks that.
 *
 * PNG dimensions are read from the IHDR chunk directly: bytes 16-23 of the file,
 * big-endian width then height. No image library needed for a header read.
 */
describe("bundled icon files", () => {
	function pngSize(relative: string): { width: number; height: number } {
		const bytes = readFileSync(new URL(`../public/${relative}`, import.meta.url));
		// 8-byte signature, then a 4-byte length and "IHDR", then width and height.
		expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
		return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	}

	it("ships a real 192x192 and 512x512 icon", () => {
		expect(pngSize("icon-192.png")).toEqual({ width: 192, height: 192 });
		expect(pngSize("icon-512.png")).toEqual({ width: 512, height: 512 });
	});

	it("ships a 512x512 maskable icon", () => {
		expect(pngSize("icon-512-maskable.png")).toEqual({ width: 512, height: 512 });
	});

	it("declares only icons that exist", async () => {
		const { body } = await manifestApp()();
		const icons = body.icons as { src: string }[];

		for (const icon of icons) {
			// Branding logos are served from the API, not from public/.
			if (icon.src.startsWith("/api/")) continue;
			expect(() => pngSize(icon.src.replace(/^\//, ""))).not.toThrow();
		}
	});
});
