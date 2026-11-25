/**
 * The published API description.
 *
 * - `GET /api/v1/openapi.json`: the OpenAPI 3.1 document (`workers/lib/openapi.ts`).
 * - `GET /api/docs`: where the reference page used to live. It now redirects
 *   to the docs site (`/docs/api`, see `workers/routes/docs.ts`), which is
 *   generated from the same document.
 *
 * Both are public (see `isPublicApiRead` in `workers/auth/middleware.ts`): they
 * describe the API, never any data, and client generators fetch the spec before
 * they hold a token. In Access mode they sit behind Access like everything else.
 */

import { Hono } from "hono";
import { openApiDocument } from "../lib/openapi";
import type { MailboxContext } from "../lib/mailbox";

export const openApiRoutes = new Hono<MailboxContext>();

openApiRoutes.get("/api/v1/openapi.json", (c) => {
	c.header("Cache-Control", "public, max-age=300");
	return c.json(openApiDocument);
});

openApiRoutes.get("/api/docs", (c) => c.redirect("/docs/api", 301));
