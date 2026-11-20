// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The published API description.
 *
 * - `GET /api/v1/openapi.json`: the OpenAPI 3.1 document (`workers/lib/openapi.ts`).
 * - `GET /api/docs`: a self-rendered reference page. No external scripts, so
 *   the document CSP in `workers/lib/security-headers.ts` needs no exception.
 *
 * Both are public (see `isPublicApiRead` in `workers/auth/middleware.ts`): they
 * describe the API, never any data, and client generators fetch the spec before
 * they hold a token. In Access mode they sit behind Access like everything else.
 */

import { Hono } from "hono";
import { openApiDocument } from "../lib/openapi";
import { renderApiDocsHtml } from "../lib/openapi-html";
import type { MailboxContext } from "../lib/mailbox";

export const openApiRoutes = new Hono<MailboxContext>();

// Rendered once per isolate; the document is a constant.
let docsHtml: string | null = null;

openApiRoutes.get("/api/v1/openapi.json", (c) => {
	c.header("Cache-Control", "public, max-age=300");
	return c.json(openApiDocument);
});

openApiRoutes.get("/api/docs", (c) => {
	docsHtml ??= renderApiDocsHtml(openApiDocument);
	c.header("Cache-Control", "public, max-age=300");
	return c.html(docsHtml);
});
