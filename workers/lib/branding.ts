// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Instance-wide branding: the product name shown in the wordmark, the document
 * title, and the logo.
 *
 * ## Why this is global rather than per-user
 *
 * There is no user store in this deployment. Cloudflare Access authenticates a
 * teammate and `GET /api/v1/me` reports every authenticated caller as `admin`;
 * mailboxes are shared by design (see `workers/app.ts`). So "per-user branding"
 * has nowhere to hang. Branding is one record for the whole instance.
 *
 * If per-domain wordmarks are ever wanted, `ZONES`/`DOMAINS` is the only real
 * tenancy axis here and this record would become keyed by zone domain.
 *
 * ## Why R2 and not a migration
 *
 * SQLite in this app lives inside the per-mailbox Durable Object, so a table
 * would give each mailbox its own copy of a global setting. Every other shared
 * resource (`api-keys/`, `templates/`, `sequences/`) is a JSON object in the
 * bucket, and this follows that.
 */

// R2Bucket is an ambient global from the generated worker-configuration.d.ts.
// Do not import it from @cloudflare/workers-types - the two declarations are
// structurally incompatible and every call site fails to typecheck.

/** The branding record. */
export interface Branding {
	/** Wordmark and document title. */
	appName: string;
	/** Optional one-line descriptor, shown under the name in settings previews. */
	tagline: string | null;
	/** Hex colour used for the wordmark glyph when there is no logo. */
	accentColor: string;
	/** MIME type of the stored logo, or null when none has been uploaded. */
	logoMimeType: string | null;
	/** Original filename of the uploaded logo, kept only for display. */
	logoFilename: string | null;
	/**
	 * Epoch seconds of the last logo write.
	 *
	 * Doubles as a cache-busting version: the logo lives at one fixed R2 key that
	 * is overwritten in place, so without a changing URL the browser would keep
	 * showing the previous image (and the favicon would never update at all).
	 */
	logoUpdatedAt: number | null;
	/** Epoch seconds of the last change to any field. */
	updatedAt: number;
}

/** What a client may set. Everything else is derived or server-owned. */
export type BrandingInput = Partial<
	Pick<Branding, "appName" | "tagline" | "accentColor">
>;

export const BRANDING_KEY = "branding/settings.json";

/**
 * Single fixed key, overwritten in place on every upload.
 *
 * A per-upload key (as attachments use) would leave every superseded logo in the
 * bucket forever: the bucket is shared and cannot be swept by prefix cheaply, and
 * nothing else would ever reference the old object. Overwriting keeps exactly one
 * blob, and `logoUpdatedAt` handles cache invalidation instead of the key.
 */
export const BRANDING_LOGO_KEY = "branding/logo";

export const DEFAULT_APP_NAME = "cloudmail";
/**
 * The app's indigo accent. It was lime (#BFFF00), which made the logo glyph and
 * the installed app's `theme_color` lime beside an indigo UI.
 */
export const DEFAULT_ACCENT_COLOR = "#4F46E5";
export const LEGACY_DEFAULT_ACCENT_COLOR = "#BFFF00";

export const APP_NAME_MAX_LENGTH = 40;
export const TAGLINE_MAX_LENGTH = 120;

/** 512 KiB. A wordmark needs far less, and the bytes are read on every page. */
export const MAX_LOGO_BYTES = 512 * 1024;

/**
 * Image types accepted for a logo.
 *
 * SVG is deliberately excluded. The logo is served from this app's own origin,
 * and an SVG document navigated to directly executes any script it contains —
 * a stored-XSS path with a session that can read every mailbox. The same
 * reasoning already governs inline attachment disposition in `workers/index.ts`.
 * Raster formats cannot carry script, and every place the logo is used
 * (`<img>`, favicon) handles them.
 */
export const ALLOWED_LOGO_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
] as const;

export function defaultBranding(): Branding {
	return {
		appName: DEFAULT_APP_NAME,
		tagline: null,
		accentColor: DEFAULT_ACCENT_COLOR,
		logoMimeType: null,
		logoFilename: null,
		logoUpdatedAt: null,
		updatedAt: 0,
	};
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * Fill in anything a stored record is missing.
 *
 * Records written by an earlier version of this file will not have fields added
 * later, and a hand-edited object may be missing anything. Reading branding must
 * never fail — it decides what the whole UI is called — so unknown or malformed
 * fields fall back to the default rather than propagating `undefined` into the
 * wordmark.
 */
function normalize(raw: unknown): Branding {
	const base = defaultBranding();
	if (!raw || typeof raw !== "object") return base;
	const value = raw as Record<string, unknown>;

	const appName =
		typeof value.appName === "string" && value.appName.trim()
			? value.appName.trim().slice(0, APP_NAME_MAX_LENGTH)
			: base.appName;

	const tagline =
		typeof value.tagline === "string" && value.tagline.trim()
			? value.tagline.trim().slice(0, TAGLINE_MAX_LENGTH)
			: null;

	// The Save form always sends the accent, so a record saved while lime was
	// the default holds it without anyone having picked it. Treat that exact
	// value as "default" so those deployments move to indigo too.
	const accentColor =
		typeof value.accentColor === "string" &&
		isHexColor(value.accentColor) &&
		value.accentColor.toUpperCase() !== LEGACY_DEFAULT_ACCENT_COLOR
			? value.accentColor
			: base.accentColor;

	const logoMimeType =
		typeof value.logoMimeType === "string" &&
		(ALLOWED_LOGO_MIME_TYPES as readonly string[]).includes(value.logoMimeType)
			? value.logoMimeType
			: null;

	return {
		appName,
		tagline,
		accentColor,
		logoMimeType,
		logoFilename:
			logoMimeType && typeof value.logoFilename === "string"
				? value.logoFilename
				: null,
		logoUpdatedAt:
			logoMimeType && typeof value.logoUpdatedAt === "number"
				? value.logoUpdatedAt
				: null,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
	};
}

export function isHexColor(value: string): boolean {
	return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/** Read the branding record, falling back to defaults when unset or unreadable. */
export async function getBranding(bucket: R2Bucket): Promise<Branding> {
	const obj = await bucket.get(BRANDING_KEY);
	if (!obj) return defaultBranding();
	try {
		return normalize(await obj.json());
	} catch (e) {
		console.error(
			`Unreadable branding record at ${BRANDING_KEY}, using defaults:`,
			(e as Error).message,
		);
		return defaultBranding();
	}
}

async function write(bucket: R2Bucket, value: Branding): Promise<Branding> {
	await bucket.put(BRANDING_KEY, JSON.stringify(value));
	return value;
}

/**
 * Merge a partial update into the stored record.
 *
 * Patch semantics rather than replace, unlike `PUT /api/v1/mailboxes/:id` which
 * overwrites the whole settings blob. The logo is written by a separate route, so
 * a name-only save must not be able to drop it.
 */
export async function updateBranding(
	bucket: R2Bucket,
	patch: BrandingInput,
): Promise<Branding> {
	const current = await getBranding(bucket);
	const next: Branding = {
		...current,
		...(patch.appName !== undefined ? { appName: patch.appName.trim() } : {}),
		...(patch.tagline !== undefined
			? { tagline: patch.tagline?.trim() ? patch.tagline.trim() : null }
			: {}),
		...(patch.accentColor !== undefined
			? { accentColor: patch.accentColor }
			: {}),
		updatedAt: nowSeconds(),
	};
	return write(bucket, next);
}

/**
 * Restore defaults, including deleting any uploaded logo.
 *
 * The blob is removed rather than merely dereferenced: leaving it would keep the
 * previous tenant's logo retrievable at a stable URL after a reset.
 */
export async function resetBranding(bucket: R2Bucket): Promise<Branding> {
	await bucket.delete(BRANDING_LOGO_KEY);
	const next = { ...defaultBranding(), updatedAt: nowSeconds() };
	return write(bucket, next);
}

export class LogoValidationError extends Error {}

/**
 * Decode and check a base64 logo: raster type, non-empty, under the size cap.
 * Shared with per-product logos (`workers/routes/products.ts`).
 */
export function decodeLogo(input: { content: string; type: string }): { bytes: Uint8Array; mimeType: string } {
	const mimeType = input.type.split(";")[0]!.trim().toLowerCase();
	if (!(ALLOWED_LOGO_MIME_TYPES as readonly string[]).includes(mimeType)) {
		throw new LogoValidationError(
			`Unsupported image type "${mimeType}". Use PNG, JPEG, WebP or GIF.`,
		);
	}

	let bytes: Uint8Array;
	try {
		const binary = atob(input.content);
		bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
	} catch {
		throw new LogoValidationError("Logo content is not valid base64.");
	}

	if (bytes.byteLength === 0) {
		throw new LogoValidationError("Logo file is empty.");
	}
	if (bytes.byteLength > MAX_LOGO_BYTES) {
		throw new LogoValidationError(
			`Logo is ${bytes.byteLength} bytes, over the ${MAX_LOGO_BYTES} byte limit.`,
		);
	}
	return { bytes, mimeType };
}

/**
 * Store a logo from base64 content and record its type.
 *
 * Base64 in a JSON body mirrors how attachments are sent (see
 * `storeAttachments`), so the browser side reuses `fileToBase64` and the request
 * passes the same CSRF and Access checks as every other API call.
 */
export async function putBrandingLogo(
	bucket: R2Bucket,
	input: { content: string; filename: string; type: string },
): Promise<Branding> {
	const { bytes, mimeType } = decodeLogo(input);

	await bucket.put(BRANDING_LOGO_KEY, bytes, {
		httpMetadata: { contentType: mimeType },
	});

	const current = await getBranding(bucket);
	const stamp = nowSeconds();
	return write(bucket, {
		...current,
		logoMimeType: mimeType,
		// Only for display in settings; never used to build a key or a header.
		logoFilename: input.filename.slice(0, 120) || null,
		logoUpdatedAt: stamp,
		updatedAt: stamp,
	});
}

/** Remove the logo, leaving the name and colour alone. */
export async function deleteBrandingLogo(bucket: R2Bucket): Promise<Branding> {
	await bucket.delete(BRANDING_LOGO_KEY);
	const current = await getBranding(bucket);
	return write(bucket, {
		...current,
		logoMimeType: null,
		logoFilename: null,
		logoUpdatedAt: null,
		updatedAt: nowSeconds(),
	});
}
