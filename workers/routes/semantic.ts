// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Semantic search and "Ask my inbox" over HTTP.
 *
 *   POST /api/v1/ask            {question, mailbox?: <address>|"*", product?: [ids|slugs]}
 *   GET  /api/v1/search         ?q=&mode=hybrid|fts&mailbox=&product=&limit=  across readable mailboxes
 *   GET  /api/v1/ai/semantic    whether semantic search is available, and usage
 *
 * The per-mailbox `GET /api/v1/mailboxes/:id/search?mode=hybrid` lives beside
 * the full-text route in `workers/index.ts` and calls `hybridSearch` too.
 *
 * Authz: every route narrows to `readableMailboxAddresses` (grants, the token's
 * mailbox allowlist and `mail:read`), then `workers/lib/semantic.ts` filters
 * what Vectorize returns again and hydrates through each mailbox's own DO.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { MailboxContext } from "../lib/mailbox";
import { listProducts } from "../lib/products";
import { mailboxesForProducts } from "../lib/unified-inbox";
import { readableMailboxAddresses } from "./products";
import { askInbox, hybridSearch, semanticAvailable, semanticDeps, semanticIndex } from "../lib/semantic";
import { MAX_QUESTION_CHARS } from "../../shared/semantic";
import { canDo, normalizeAddress, type Principal } from "../lib/authz";
import type { Env } from "../types";

export const semanticRoutes = new Hono<MailboxContext>();

const AskBody = z
	.object({
		question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
		mailbox: z.string().trim().min(1).max(320).optional(),
		product: z.union([z.string().max(80), z.array(z.string().max(80)).max(20)]).optional(),
	})
	.strict();

/**
 * The mailboxes a request may search: every readable one, narrowed by
 * `mailbox` (one address, or `*`) and `product`. A named mailbox the caller
 * cannot read yields an empty list, never an error that confirms it exists.
 */
export async function scopeMailboxes(
	env: Env,
	principal: Principal,
	options: { mailbox?: string | null; product?: string[] },
): Promise<string[]> {
	const [readable, products] = await Promise.all([
		readableMailboxAddresses(env, principal),
		options.product?.length ? listProducts(env) : Promise.resolve([]),
	]);
	let mailboxes = options.product?.length ? mailboxesForProducts(readable, products, options.product) : readable;
	const one = options.mailbox?.trim();
	if (one && one !== "*") {
		const wanted = normalizeAddress(one);
		mailboxes = mailboxes.filter((m) => m === wanted);
	}
	// Belt and braces: `readableMailboxAddresses` already applied this.
	return mailboxes.filter((m) => canDo(principal, m, "read"));
}

function listParam(values: string[] | undefined): string[] {
	return (values ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
}

semanticRoutes.post("/api/v1/ask", async (c) => {
	const parsed = AskBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
	const { question, mailbox, product } = parsed.data;
	const mailboxes = await scopeMailboxes(c.env, c.var.principal, {
		mailbox,
		product: Array.isArray(product) ? product : product ? listParam([product]) : [],
	});
	if (mailboxes.length === 0) return c.json({ error: "No readable mailbox matches" }, 404);
	const deps = await semanticDeps(c.env);
	if (!deps.ai) return c.json({ error: "Workers AI is not bound on this deployment", code: "ai_unavailable" }, 503);
	return c.json(await askInbox(deps, mailboxes, question));
});

semanticRoutes.get("/api/v1/search", async (c) => {
	const q = (c.req.query("q") ?? c.req.query("query") ?? "").trim();
	if (!q) return c.json({ error: "q is required" }, 400);
	const mode = c.req.query("mode") === "fts" ? "fts" : "hybrid";
	const mailboxes = await scopeMailboxes(c.env, c.var.principal, {
		mailbox: c.req.query("mailbox"),
		product: listParam(c.req.queries("product")),
	});
	const deps = await semanticDeps(c.env);
	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 25, 1), 50);
	const result = await hybridSearch(
		mode === "fts" ? { ...deps, config: { semantic: false } } : deps,
		mailboxes,
		q,
		{ limit, folder: c.req.query("folder") || undefined },
	);
	return c.json({ ...result, mode });
});

/** This mailbox's index: messages indexed, queued, and today's embedding and query counts. */
semanticRoutes.get("/api/v1/mailboxes/:mailboxId/semantic", async (c) => {
	const stub = c.var.mailboxStub as unknown as { semanticStatus(): Promise<unknown> };
	return c.json(await stub.semanticStatus());
});

semanticRoutes.get("/api/v1/ai/semantic", async (c) => {
	const deps = await semanticDeps(c.env);
	return c.json({
		available: semanticAvailable(deps),
		bound: !!semanticIndex(c.env),
		enabled: deps.config.semantic,
	});
});
