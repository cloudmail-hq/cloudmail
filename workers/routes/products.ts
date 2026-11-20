// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Products and the unified inbox.
 *
 *   GET    /api/v1/products                 every product (any signed-in caller)
 *   GET    /api/v1/products/resolve?from=   the product an address resolves to
 *   GET    /api/v1/products/:id             one product
 *   POST   /api/v1/products                 create (admin)
 *   PATCH  /api/v1/products/:id             update (admin)
 *   DELETE /api/v1/products/:id             delete (admin)
 *   PUT    /api/v1/products/:id/logo        upload a logo (admin)
 *   DELETE /api/v1/products/:id/logo        remove it (admin)
 *   POST   /api/v1/products/:id/knowledge/refresh   fetch the knowledge URL (admin)
 *   GET    /api/v1/inbox                    unified list across readable mailboxes
 *   GET    /p/:id/logo                      PUBLIC logo bytes, for the unsubscribe
 *                                           page and outgoing templates
 *
 * Reads are open to every signed-in caller because the composer needs the
 * signature and the list needs the badge; nothing in a product is secret
 * except the agent prompt and knowledge, which are only returned to admins.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { auditActorRole, recordAuditDeferred } from "../lib/audit";
import { canDo, isAdmin, visibleMailboxes, type Principal } from "../lib/authz";
import { decodeLogo, LogoValidationError, MAX_LOGO_BYTES } from "../lib/branding";
import { listMailboxes } from "../lib/email-helpers";
import { requireAdminScope, type MailboxContext } from "../lib/mailbox";
import {
	invalidateProducts,
	listProducts,
	productLogoKey,
	productLogoUrl,
	productRpc,
	refreshKnowledge,
} from "../lib/products";
import type { ProductWriteResult } from "../lib/product-store";
import { InvalidCursorError, listUnified, mailboxesForProducts } from "../lib/unified-inbox";
import { domainOfAddress, isDomainAllowed } from "../lib/zones";
import { Folders } from "../../shared/folders";
import {
	AGENT_PROMPT_MAX,
	KNOWLEDGE_MAX,
	PRODUCT_NAME_MAX,
	SIGNATURE_MAX,
	resolveProduct,
	type Product,
} from "../../shared/products";

/** Product writes are instance-wide, so admin; a scoped token needs `mailboxes:manage`. */
const requireProductAdmin = requireAdminScope("mailboxes:manage");

const nullableText = (max: number) => z.string().max(max).nullable().optional();

const ProductBody = z
	.object({
		name: z.string().trim().min(1).max(PRODUCT_NAME_MAX),
		slug: z.string().trim().min(1).max(40),
		domains: z.array(z.string().max(253)).max(20),
		aliases: z.array(z.string().max(254)).max(50),
		displayName: nullableText(PRODUCT_NAME_MAX),
		accentColor: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).nullable(),
		signatureHtml: nullableText(SIGNATURE_MAX),
		agentPrompt: nullableText(AGENT_PROMPT_MAX),
		knowledgeText: nullableText(KNOWLEDGE_MAX),
		knowledgeUrl: z.string().url().max(2000).nullable(),
		defaultTemplates: z.array(z.string().max(120)).max(10),
	})
	.partial()
	.strict();

const LogoBody = z
	.object({
		content: z.string().min(1),
		filename: z.string().min(1).max(255),
		type: z.string().min(1).max(120),
	})
	.strict();

/** Admins see everything; others see what the composer and list need. */
function publicProduct(p: Product, admin: boolean) {
	const base = {
		id: p.id,
		name: p.name,
		slug: p.slug,
		domains: p.domains,
		aliases: p.aliases,
		displayName: p.displayName,
		accentColor: p.accentColor,
		signatureHtml: p.signatureHtml,
		defaultTemplates: p.defaultTemplates,
		logoUrl: productLogoUrl(p),
		logoMimeType: p.logoMimeType,
		createdAt: p.createdAt,
		updatedAt: p.updatedAt,
	};
	if (!admin) return base;
	return {
		...base,
		agentPrompt: p.agentPrompt,
		knowledgeText: p.knowledgeText,
		knowledgeUrl: p.knowledgeUrl,
		knowledgeFetchedAt: p.knowledgeFetchedAt,
	};
}

function writeResponse(c: { json: (b: unknown, s?: number) => Response }, result: ProductWriteResult, admin: boolean, status = 200) {
	if (result.ok) return c.json({ product: publicProduct(result.product, admin) }, status as 200);
	if (result.reason === "not_found") return c.json({ error: "Product not found" }, 404);
	return c.json({ error: result.error }, result.reason === "conflict" ? 409 : 400);
}

function audit(c: { env: Env; var: MailboxContext["Variables"] }, target: string, op: string) {
	return recordAuditDeferred(c as never, {
		action: "product.change",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		mailboxId: null,
		target,
		detail: { op },
	});
}

function rpcOr503(env: Env) {
	const rpc = productRpc(env);
	if (!rpc) throw new Error("Products need the AUTH_STORE binding");
	return rpc;
}

/**
 * Mailboxes this caller may read, on served domains. The same narrowing as
 * the People view, plus the per-mailbox `read` capability, so a grant without
 * it (send-only, say) never leaks a list.
 */
export async function readableMailboxAddresses(env: Env, principal: Principal): Promise<string[]> {
	const all = (await listMailboxes(env.BUCKET))
		.map((m) => m.email.toLowerCase())
		.filter((email) => isDomainAllowed(env, domainOfAddress(email)));
	return visibleMailboxes(principal, all, (a) => a).filter((a) => canDo(principal, a, "read"));
}

const boolQuery = (v: string | undefined) => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : undefined);

export const productRoutes = new Hono<MailboxContext>();

productRoutes.get("/api/v1/products", async (c) => {
	const admin = isAdmin(c.var.principal);
	return c.json({ products: (await listProducts(c.env)).map((p) => publicProduct(p, admin)) });
});

productRoutes.get("/api/v1/products/resolve", async (c) => {
	const from = c.req.query("from") ?? "";
	const product = resolveProduct(await listProducts(c.env), from);
	return c.json({ product: product ? publicProduct(product, isAdmin(c.var.principal)) : null });
});

productRoutes.get("/api/v1/products/:id", async (c) => {
	const id = decodeURIComponent(c.req.param("id"));
	const product = (await listProducts(c.env)).find((p) => p.id === id || p.slug === id);
	if (!product) return c.json({ error: "Product not found" }, 404);
	return c.json({ product: publicProduct(product, isAdmin(c.var.principal)) });
});

productRoutes.post("/api/v1/products", requireProductAdmin, async (c) => {
	const body = ProductBody.parse(await c.req.json());
	if (!body.name) return c.json({ error: "name is required" }, 400);
	const result = await rpcOr503(c.env).createProduct({ ...body, name: body.name }, Date.now());
	invalidateProducts(c.env);
	if (result.ok) audit(c, result.product.id, "create");
	return writeResponse(c, result, true, 201);
});

productRoutes.patch("/api/v1/products/:id", requireProductAdmin, async (c) => {
	const body = ProductBody.parse(await c.req.json());
	const result = await rpcOr503(c.env).updateProduct(decodeURIComponent(c.req.param("id")), body, Date.now());
	invalidateProducts(c.env);
	if (result.ok) audit(c, result.product.id, "update");
	return writeResponse(c, result, true);
});

productRoutes.delete("/api/v1/products/:id", requireProductAdmin, async (c) => {
	const removed = await rpcOr503(c.env).deleteProduct(decodeURIComponent(c.req.param("id")));
	invalidateProducts(c.env);
	if (!removed) return c.json({ error: "Product not found" }, 404);
	await Promise.all([
		c.env.BUCKET.delete(productLogoKey(removed.id)),
		c.env.BUCKET.delete(`products/${removed.id}/knowledge.txt`),
	]);
	audit(c, removed.id, "delete");
	return c.json({ ok: true });
});

productRoutes.put("/api/v1/products/:id/logo", requireProductAdmin, async (c) => {
	const body = LogoBody.parse(await c.req.json());
	const rpc = rpcOr503(c.env);
	const product = await rpc.getProduct(decodeURIComponent(c.req.param("id")));
	if (!product) return c.json({ error: "Product not found" }, 404);
	let decoded: ReturnType<typeof decodeLogo>;
	try {
		decoded = decodeLogo(body);
	} catch (e) {
		if (e instanceof LogoValidationError) return c.json({ error: e.message, maxBytes: MAX_LOGO_BYTES }, 400);
		throw e;
	}
	await c.env.BUCKET.put(productLogoKey(product.id), decoded.bytes, {
		httpMetadata: { contentType: decoded.mimeType },
	});
	const updated = await rpc.setProductLogo(product.id, decoded.mimeType, Date.now());
	invalidateProducts(c.env);
	audit(c, product.id, "logo");
	return c.json({ product: publicProduct(updated!, true) });
});

productRoutes.delete("/api/v1/products/:id/logo", requireProductAdmin, async (c) => {
	const rpc = rpcOr503(c.env);
	const product = await rpc.getProduct(decodeURIComponent(c.req.param("id")));
	if (!product) return c.json({ error: "Product not found" }, 404);
	await c.env.BUCKET.delete(productLogoKey(product.id));
	const updated = await rpc.setProductLogo(product.id, null, Date.now());
	invalidateProducts(c.env);
	audit(c, product.id, "logo-delete");
	return c.json({ product: publicProduct(updated!, true) });
});

productRoutes.post("/api/v1/products/:id/knowledge/refresh", requireProductAdmin, async (c) => {
	const rpc = rpcOr503(c.env);
	const product = await rpc.getProduct(decodeURIComponent(c.req.param("id")));
	if (!product) return c.json({ error: "Product not found" }, 404);
	const result = await refreshKnowledge(c.env, product);
	if (!result.ok) return c.json({ error: result.error }, 422);
	const updated = await rpc.updateProduct(product.id, { knowledgeFetchedAt: Date.now() }, Date.now());
	invalidateProducts(c.env);
	return c.json({ chars: result.chars, product: updated.ok ? publicProduct(updated.product, true) : null });
});

/**
 * The unified inbox. `product=<id|slug>` (repeatable or comma-separated)
 * narrows to mailboxes of those products; `mailboxes=` narrows to named
 * readable mailboxes. Cursor-paged: pass `cursor` from the previous response.
 */
productRoutes.get("/api/v1/inbox", async (c) => {
	const principal = c.var.principal;
	const folder = c.req.query("folder") || Folders.INBOX;
	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 25, 1), 100);
	const productFilter = (c.req.queries("product") ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
	const mailboxFilter = (c.req.queries("mailboxes") ?? [])
		.flatMap((v) => v.split(","))
		.map((v) => v.trim().toLowerCase())
		.filter(Boolean);

	const [readable, products] = await Promise.all([readableMailboxAddresses(c.env, principal), listProducts(c.env)]);
	let mailboxes = mailboxesForProducts(readable, products, productFilter);
	if (mailboxFilter.length) mailboxes = mailboxes.filter((m) => mailboxFilter.includes(m));

	try {
		const result = await listUnified(c.env, mailboxes, products, {
			folder,
			limit,
			cursor: c.req.query("cursor"),
			unread: boolQuery(c.req.query("unread")),
			starred: boolQuery(c.req.query("starred")),
			has_attachment: boolQuery(c.req.query("has_attachment")),
		});
		return c.json(result);
	} catch (e) {
		if (e instanceof InvalidCursorError) return c.json({ error: e.message }, 400);
		throw e;
	}
});

/** Public routes, mounted before authentication in `workers/app.ts`. */
export const publicProductRoutes = new Hono<{ Bindings: Env }>();

publicProductRoutes.get("/p/:id/logo", async (c) => {
	const id = c.req.param("id");
	if (!/^prd_[A-Za-z0-9]{1,64}$/.test(id)) return c.body(null, 404);
	const obj = await c.env.BUCKET.get(productLogoKey(id));
	if (!obj) return c.body(null, 404);
	const type = obj.httpMetadata?.contentType ?? "";
	// Raster only: the upload route enforces it, and this refuses anything else
	// that might have been written to the key by other means.
	if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) return c.body(null, 404);
	const headers = new Headers({
		"Content-Type": type,
		"X-Content-Type-Options": "nosniff",
		"Cross-Origin-Resource-Policy": "cross-origin",
		"Cache-Control": c.req.query("v") ? "public, max-age=31536000, immutable" : "public, max-age=300",
	});
	return new Response(obj.body, { headers });
});
