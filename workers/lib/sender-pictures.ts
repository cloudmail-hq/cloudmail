/**
 * `GET /api/v1/sender-picture?a=<address>&m=<mask>[&v=1]`: the picture shown
 * next to a sender.
 *
 * The order, and why real pictures need an authenticated message, is in
 * `shared/sender-pictures.ts`. This file does the lookups.
 *
 * What leaves the deployment, and to whom:
 *
 * - Brand logos: two DNS questions (`default._bimi.<domain>`, `_dmarc.<domain>`)
 *   to Cloudflare's resolver, then one fetch of the logo from wherever the
 *   brand hosts it.
 * - Website icons: the sender's domain, to Google's favicon service.
 * - Gravatar: a SHA-256 hash of the sender's address, to gravatar.com.
 * - Generated faces: nothing. They are drawn here.
 *
 * Every request is made by the Worker, never by the reader's browser, so a
 * third party sees a Cloudflare address and no cookie. Results are kept in the
 * edge cache (a week when found, a day when not) and in the browser for a day,
 * so a sender is looked up about once a week per data centre, not per message.
 *
 * The logo URL in a BIMI record is chosen by whoever controls that DNS zone,
 * so it goes through the same SSRF guard as images in mail
 * (`fetchRemoteImage`): https only, public addresses only, redirects
 * re-validated, a size cap and a timeout.
 *
 * The mark certificate is not validated here: a Worker has no X.509 chain
 * verifier. A record that names one is preferred and labelled, and what
 * actually gates the logo is the message's own authentication plus the
 * domain's enforcing DMARC policy.
 */

import { createAvatar } from "@dicebear/core";
import * as lorelei from "@dicebear/lorelei";
import { registrableDomain } from "../../shared/domain-safety";
import {
	dmarcEnforces,
	domainOf,
	isFreeMailDomain,
	isSafeSvgLogo,
	normalizeAddress,
	parseBimiRecord,
	parseSenderPictureMask,
	SVG_LOGO_MAX_BYTES,
	type BimiRecord,
	type SenderPictureSettings,
	type SenderPictureSource,
} from "../../shared/sender-pictures";
import { queryDns } from "./dns-audit";
import { ALLOWED_IMAGE_TYPES, fetchRemoteImage, type ProxyFetch } from "./image-proxy";

export interface SenderPicture {
	body: Uint8Array;
	contentType: string;
	source: SenderPictureSource;
}

/** Edge and browser lifetimes, in seconds. */
export const PICTURE_FOUND_SECONDS = 7 * 24 * 60 * 60;
export const PICTURE_MISSING_SECONDS = 24 * 60 * 60;
export const PICTURE_BROWSER_SECONDS = 24 * 60 * 60;
/**
 * How long an answer is kept when a lookup above it timed out or errored. A
 * slow logo host must not pin the website icon, or a drawn face, for a week.
 */
export const PICTURE_RETRY_SECONDS = 10 * 60;

const RASTER_MAX_BYTES = 512 * 1024;
const LOOKUP_TIMEOUT_MS = 2_500;
const SVG_TYPES: ReadonlySet<string> = new Set(["image/svg+xml"]);

/** Soft backgrounds for generated faces, the same family the product art uses. */
const FACE_BACKGROUNDS = ["b6e3f4", "c0aede", "d1d4f9", "ffd5dc", "ffdfbf", "bbf7d0", "fde68a", "a5f3fc"];

export interface PictureDeps {
	fetcher?: ProxyFetch;
	/** TXT lookup. Throws or returns [] when there is no answer. */
	txt?: (name: string) => Promise<string[]>;
	/**
	 * Set to `{ transient: false }` to learn whether any lookup failed in a way
	 * that may pass next time (a timeout, a network or server error), as opposed
	 * to answering that there is no picture.
	 */
	trace?: { transient: boolean };
}

/** A timeout, a network failure or a server error, but not "not found". */
function noteFailure(result: { status: number; error?: string }, deps: PictureDeps): void {
	if (!deps.trace || result.status === 200) return;
	if (result.status === 504) deps.trace.transient = true;
	else if (result.status === 502 && !/^Upstream returned 4\d\d/.test(result.error ?? "")) deps.trace.transient = true;
}

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function lookupTxt(name: string, deps: PictureDeps): Promise<string[]> {
	try {
		return deps.txt ? await deps.txt(name) : await queryDns(name, "TXT");
	} catch {
		if (deps.trace) deps.trace.transient = true;
		return [];
	}
}

/** The brand's BIMI logo for a domain, when its DMARC policy enforces. */
export async function fetchBrandLogo(domain: string, deps: PictureDeps = {}): Promise<SenderPicture | null> {
	const org = registrableDomain(domain);
	// The exact domain first, then the organisation's, as BIMI resolves it.
	const names = [...new Set([domain, org].filter(Boolean))];
	let record: BimiRecord | null = null;
	for (const name of names) {
		for (const txt of await lookupTxt(`default._bimi.${name}`, deps)) {
			record = parseBimiRecord(txt);
			if (record) break;
		}
		if (record) break;
	}
	if (!record) return null;

	const policies = await lookupTxt(`_dmarc.${org || domain}`, deps);
	if (!policies.some(dmarcEnforces)) return null;

	const logo = await fetchRemoteImage(record.logoUrl, deps.fetcher, {
		timeoutMs: LOOKUP_TIMEOUT_MS,
		maxBytes: SVG_LOGO_MAX_BYTES,
		allowedTypes: SVG_TYPES,
		accept: "image/svg+xml",
	});
	noteFailure(logo, deps);
	if (logo.status !== 200 || !logo.body || logo.body.byteLength === 0) return null;
	const svg = new TextDecoder().decode(logo.body);
	if (!isSafeSvgLogo(svg)) return null;
	return {
		body: logo.body,
		contentType: "image/svg+xml",
		source: record.certificateUrl ? "bimi-certified" : "bimi",
	};
}

/** The website icon of a domain, through Google's favicon service. */
export async function fetchWebsiteIcon(domain: string, deps: PictureDeps = {}): Promise<SenderPicture | null> {
	const site = registrableDomain(domain) || domain;
	const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(site)}&sz=128`;
	// The service answers 404 (with a placeholder globe) when it has no icon,
	// which `fetchRemoteImage` reports as a failure. That is the wanted result.
	const icon = await fetchRemoteImage(url, deps.fetcher, {
		timeoutMs: LOOKUP_TIMEOUT_MS,
		maxBytes: RASTER_MAX_BYTES,
		allowedTypes: ALLOWED_IMAGE_TYPES,
	});
	noteFailure(icon, deps);
	if (icon.status !== 200 || !icon.body || icon.body.byteLength === 0) return null;
	return { body: icon.body, contentType: icon.contentType ?? "image/png", source: "favicon" };
}

/** The sender's own public picture. Only the hash of the address is sent. */
export async function fetchGravatar(address: string, deps: PictureDeps = {}): Promise<SenderPicture | null> {
	const hash = await sha256Hex(address);
	// `d=404`: no picture is an error, not a placeholder. `r=g`: general audiences only.
	const url = `https://gravatar.com/avatar/${hash}?s=160&d=404&r=g`;
	const face = await fetchRemoteImage(url, deps.fetcher, {
		timeoutMs: LOOKUP_TIMEOUT_MS,
		maxBytes: RASTER_MAX_BYTES,
		allowedTypes: ALLOWED_IMAGE_TYPES,
	});
	noteFailure(face, deps);
	if (face.status !== 200 || !face.body || face.body.byteLength === 0) return null;
	return { body: face.body, contentType: face.contentType ?? "image/jpeg", source: "gravatar" };
}

/** A drawn face, the same every time for the same address. Made locally. */
export async function generateFace(address: string): Promise<SenderPicture> {
	// The hash, not the address, is the seed, so the address is not embedded in
	// the SVG the library returns.
	const seed = await sha256Hex(`sender-picture:${address}`);
	const svg = createAvatar(lorelei, {
		seed,
		size: 96,
		backgroundColor: [FACE_BACKGROUNDS[parseInt(seed.slice(0, 2), 16) % FACE_BACKGROUNDS.length]!],
	})
		.toString()
		.replace(/<metadata[\s\S]*?<\/metadata>/, "");
	return { body: encoder.encode(svg), contentType: "image/svg+xml", source: "generated" };
}

function failed(deps: PictureDeps): null {
	if (deps.trace) deps.trace.transient = true;
	return null;
}

/**
 * Walk the order for one sender. `verified` is the stored verdict of the
 * message; without it only the generated face applies.
 */
export async function resolveSenderPicture(
	address: string,
	verified: boolean,
	settings: Omit<SenderPictureSettings, "enabled">,
	deps: PictureDeps = {},
): Promise<SenderPicture | null> {
	const domain = domainOf(address);
	if (verified) {
		const company = !isFreeMailDomain(domain);
		if (company && settings.brandLogos) {
			const logo = await fetchBrandLogo(domain, deps).catch(() => failed(deps));
			if (logo) return logo;
		}
		if (company && settings.websiteIcons) {
			const icon = await fetchWebsiteIcon(domain, deps).catch(() => failed(deps));
			if (icon) return icon;
		}
		if (settings.gravatar) {
			const face = await fetchGravatar(address, deps).catch(() => failed(deps));
			if (face) return face;
		}
	}
	return settings.generated ? generateFace(address) : null;
}

// ── HTTP ──────────────────────────────────────────────────────────

interface CacheLike {
	match(key: Request): Promise<Response | undefined>;
	put(key: Request, value: Response): Promise<void>;
}

const SOURCES = new Set<SenderPictureSource>(["bimi-certified", "bimi", "favicon", "gravatar", "generated"]);
const SERVED_TYPES = new Set([...ALLOWED_IMAGE_TYPES, "image/svg+xml"]);

function pictureHeaders(): Headers {
	return new Headers({
		"X-Content-Type-Options": "nosniff",
		// The bytes come from a third party. Opened directly, nothing in them
		// may run or load more; inside an <img> nothing can anyway.
		"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Referrer-Policy": "no-referrer",
	});
}

function noPicture(status: number, maxAge: number): Response {
	const headers = pictureHeaders();
	headers.set("Cache-Control", maxAge > 0 ? `private, max-age=${maxAge}` : "no-store");
	return new Response(null, { status, headers });
}

function served(
	picture: { body: BodyInit | null; contentType: string; source: string },
	maxAge = PICTURE_BROWSER_SECONDS,
): Response {
	const headers = pictureHeaders();
	headers.set("Content-Type", picture.contentType);
	headers.set("Cache-Control", `private, max-age=${maxAge}`);
	headers.set("X-Sender-Picture", picture.source);
	return new Response(picture.body, { status: 200, headers });
}

/**
 * Handle one picture request. The caller has already established a signed-in
 * session and that sender pictures are enabled.
 *
 * `v=1` is the client repeating the stored verdict of a message it was given.
 * A signed-in user can set it by hand, which shows that user a logo they could
 * equally look up themselves; it cannot change what anyone else sees.
 */
export async function handleSenderPicture(
	request: Request,
	waitUntil: (p: Promise<unknown>) => void,
	deps: PictureDeps & { cache?: CacheLike | null } = {},
): Promise<Response> {
	const url = new URL(request.url);
	const address = normalizeAddress(url.searchParams.get("a"));
	const mask = url.searchParams.get("m") ?? "";
	const settings = parseSenderPictureMask(mask);
	if (!address || !settings) return noPicture(400, 0);
	const verified = url.searchParams.get("v") === "1";

	const cache =
		deps.cache !== undefined
			? deps.cache
			: ((globalThis as { caches?: { default?: CacheLike } }).caches?.default ?? null);
	const key = new Request(
		`https://sender-picture.cache.invalid/v1/${verified ? "v" : "u"}/${mask}/${await sha256Hex(address)}`,
	);
	if (cache) {
		const hit = await cache.match(key).catch(() => undefined);
		if (hit) {
			if (hit.headers.get("X-Sender-Picture") === "none") return noPicture(404, PICTURE_MISSING_SECONDS);
			const type = (hit.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
			const source = hit.headers.get("X-Sender-Picture") ?? "";
			if (SERVED_TYPES.has(type) && SOURCES.has(source as SenderPictureSource)) {
				return served({ body: hit.body, contentType: type, source });
			}
		}
	}

	const trace = { transient: false };
	const picture = await resolveSenderPicture(address, verified, settings, { ...deps, trace }).catch(() => failed({ trace }));

	if (cache) {
		// A generated face means every real source came back empty: check again
		// tomorrow, in case the sender has since published a picture.
		// When a lookup failed rather than answered, a better picture may exist:
		// keep this one only briefly.
		const real = picture && picture.source !== "generated";
		const keep = trace.transient ? PICTURE_RETRY_SECONDS : real ? PICTURE_FOUND_SECONDS : PICTURE_MISSING_SECONDS;
		const stored = new Response((picture?.body ?? null) as unknown as BodyInit | null, {
			status: 200,
			headers: {
				"Content-Type": picture?.contentType ?? "text/plain",
				"X-Sender-Picture": picture?.source ?? "none",
				"Cache-Control": `public, max-age=${keep}`,
			},
		});
		waitUntil(cache.put(key, stored).catch(() => {}));
	}

	if (!picture) return noPicture(404, trace.transient ? PICTURE_RETRY_SECONDS : PICTURE_MISSING_SECONDS);
	return served(
		{ body: picture.body as unknown as BodyInit, contentType: picture.contentType, source: picture.source },
		trace.transient ? PICTURE_RETRY_SECONDS : PICTURE_BROWSER_SECONDS,
	);
}
