// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Worker-side product helpers: the AuthDO stub, a short per-isolate cache of
 * the product list, resolution for a From address, branding for the public
 * pages and templates, and the knowledge snippet the agent reads.
 *
 * Every lookup degrades to "no product" rather than failing: a missing
 * product must never block a send, a draft or an unsubscribe.
 */

import type { Env } from "../types";
import type { ProductInput, ProductWriteResult } from "./product-store";
import { getBranding } from "./branding";
import { deploymentOrigin } from "./deployment-origin";
import {
	KNOWLEDGE_MAX,
	brandingVariables,
	resolveProduct,
	type Product,
	type ProductBranding,
} from "../../shared/products";
import { htmlToTextLines } from "../../shared/html-text";

export interface ProductRpc {
	listProducts(): Promise<Product[]>;
	ensureAndListProducts(now: number): Promise<Product[]>;
	getProduct(idOrSlug: string): Promise<Product | null>;
	createProduct(input: ProductInput & { name: string }, now: number): Promise<ProductWriteResult>;
	updateProduct(idOrSlug: string, input: ProductInput, now: number): Promise<ProductWriteResult>;
	deleteProduct(idOrSlug: string): Promise<Product | null>;
	setProductLogo(idOrSlug: string, mimeType: string | null, now: number): Promise<Product | null>;
}

/** Same pattern as `domainRpc`: no `cloudflare:workers` import, so tests can load it. */
export function productRpc(env: Env): ProductRpc | null {
	const ns = (env as unknown as { AUTH_STORE?: DurableObjectNamespace }).AUTH_STORE;
	if (!ns) return null;
	return ns.get(ns.idFromName("global")) as unknown as ProductRpc;
}

export const PRODUCT_CACHE_TTL_MS = 30_000;
const cache = new WeakMap<object, { at: number; products: Product[] }>();

/** Drop this isolate's cached list; called by every product write. */
export function invalidateProducts(env: Env): void {
	const key = (env as { AUTH_STORE?: object }).AUTH_STORE;
	if (key) cache.delete(key);
}

/**
 * Every product, with defaults created for any domain that lacks one.
 * Cached per isolate for 30 s; never throws.
 */
export async function listProducts(env: Env, now = Date.now()): Promise<Product[]> {
	const rpc = productRpc(env);
	const key = (env as { AUTH_STORE?: object }).AUTH_STORE;
	if (!rpc || !key) return [];
	const hit = cache.get(key);
	if (hit && now - hit.at < PRODUCT_CACHE_TTL_MS) return hit.products;
	try {
		const products = await rpc.ensureAndListProducts(now);
		cache.set(key, { at: now, products });
		return products;
	} catch (e) {
		console.error("Product lookup failed:", (e as Error).message);
		return hit?.products ?? [];
	}
}

/** The product a From address (or alias) belongs to, or null. */
export async function productForAddress(env: Env, from: string | null | undefined): Promise<Product | null> {
	if (!from) return null;
	return resolveProduct(await listProducts(env), from);
}

export function productLogoKey(productId: string): string {
	return `products/${productId}/logo`;
}

export function productKnowledgeKey(productId: string): string {
	return `products/${productId}/knowledge.txt`;
}

/** Public, versioned logo URL. Relative unless an origin is given. */
export function productLogoUrl(product: Product, origin = ""): string | null {
	if (!product.logoMimeType) return null;
	return `${origin}/p/${encodeURIComponent(product.id)}/logo?v=${product.logoUpdatedAt ?? product.updatedAt}`;
}

/**
 * Branding for a sending address: the product's where it sets a field, the
 * deployment's (`workers/lib/branding.ts`) otherwise.
 */
export async function brandingForAddress(
	env: Env,
	from: string | null | undefined,
	origin = "",
): Promise<ProductBranding & { product: Product | null }> {
	const [product, base] = await Promise.all([
		productForAddress(env, from).catch(() => null),
		getBranding(env.BUCKET).catch(() => null),
	]);
	return {
		product,
		name: product?.displayName || product?.name || base?.appName || "cloudmail",
		accentColor: product?.accentColor || base?.accentColor || "#4F46E5",
		logoUrl: product ? productLogoUrl(product, origin) : null,
	};
}

/**
 * The knowledge the agent reads for a product: the pasted text, then the
 * fetched copy of the URL (stored in R2 by `refreshKnowledge`). Bounded.
 */
export async function productKnowledge(env: Env, product: Product): Promise<string | null> {
	const parts: string[] = [];
	if (product.knowledgeText) parts.push(product.knowledgeText);
	if (product.knowledgeUrl) {
		try {
			const obj = await env.BUCKET.get(productKnowledgeKey(product.id));
			if (obj) parts.push(await obj.text());
		} catch (e) {
			console.error(`Knowledge for ${product.id} unreadable:`, (e as Error).message);
		}
	}
	const text = parts.join("\n\n").trim();
	return text ? text.slice(0, KNOWLEDGE_MAX) : null;
}

/** 256 KiB is plenty for a FAQ page and keeps a hostile URL from costing much. */
const MAX_KNOWLEDGE_FETCH_BYTES = 256 * 1024;

/** True for hosts a server-side fetch must never reach. */
export function isPrivateHost(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
	if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h)) {
		const [a, b] = h.split(".").map(Number) as [number, number];
		return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
	}
	return h.includes(":"); // any IPv6 literal
}

/**
 * Fetch a product's knowledge URL, strip it to text and store it in R2.
 *
 * https only, no private hosts, no redirects followed, bounded size, text or
 * HTML only. Returns the stored character count or an error message.
 */
export async function refreshKnowledge(
	env: Env,
	product: Product,
	fetcher: typeof fetch = fetch,
): Promise<{ ok: true; chars: number } | { ok: false; error: string }> {
	if (!product.knowledgeUrl) return { ok: false, error: "This product has no knowledge URL." };
	let url: URL;
	try {
		url = new URL(product.knowledgeUrl);
	} catch {
		return { ok: false, error: "The knowledge URL is not valid." };
	}
	if (url.protocol !== "https:" || isPrivateHost(url.hostname) || (url.port !== "" && url.port !== "443")) {
		return { ok: false, error: "The knowledge URL must be a public https address on the default port." };
	}
	// Never this deployment itself: a subrequest to our own host could read
	// authenticated pages into a prompt.
	const own = [await deploymentOrigin(env)].flatMap((u) => {
		try {
			return u ? [new URL(u).hostname.toLowerCase()] : [];
		} catch {
			return [];
		}
	});
	if (own.includes(url.hostname.toLowerCase())) {
		return { ok: false, error: "The knowledge URL can't point at this mail app." };
	}
	let res: Response;
	try {
		res = await fetcher(url.toString(), {
			redirect: "manual",
			headers: { Accept: "text/html,text/plain;q=0.9", "User-Agent": "TapetideMail-Knowledge/1.0" },
			signal: AbortSignal.timeout(10_000),
		});
	} catch (e) {
		return { ok: false, error: `Could not fetch the URL: ${(e as Error).message}` };
	}
	if (res.status >= 300 && res.status < 400) return { ok: false, error: "The URL redirects; use the final address." };
	if (!res.ok) return { ok: false, error: `The URL answered ${res.status}.` };
	const type = (res.headers.get("content-type") ?? "").toLowerCase();
	if (!/text\/(html|plain|markdown)/.test(type)) return { ok: false, error: `Unsupported content type "${type || "unknown"}".` };

	const reader = res.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (reader) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_KNOWLEDGE_FETCH_BYTES) {
				await reader.cancel();
				break;
			}
			chunks.push(value);
		}
	}
	const raw = new TextDecoder().decode(
		chunks.length === 1 ? chunks[0] : new Uint8Array(chunks.flatMap((c) => [...c])),
	);
	const text = (type.includes("html") ? htmlToTextLines(raw) : raw)
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, KNOWLEDGE_MAX);
	await env.BUCKET.put(productKnowledgeKey(product.id), text, {
		httpMetadata: { contentType: "text/plain; charset=utf-8" },
	});
	return { ok: true, chars: text.length };
}

/**
 * `{{product_name}}`, `{{product_accent}}` and `{{product_logo_url}}` for a
 * template sent from `from`. Logo URLs are absolute (the reader opens them
 * from their mail client). Falls back to the deployment's name and accent with
 * no logo when no product resolves, so a template using them still renders.
 * Never throws.
 */
export async function productTemplateVariables(
	env: Env,
	from: string,
	origin?: string,
): Promise<Record<string, string>> {
	try {
		const base = origin ?? (await deploymentOrigin(env));
		const branding = await brandingForAddress(env, from, base ?? "");
		// A relative logo URL is useless in a mail client; leave it out.
		return brandingVariables(base ? branding : { ...branding, logoUrl: null });
	} catch {
		return { product_name: "", product_accent: "", product_logo_url: "" };
	}
}
