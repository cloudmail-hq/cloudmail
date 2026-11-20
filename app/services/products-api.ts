// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Client for `/api/v1/products` and `/api/v1/inbox`. See workers/routes/products.ts. */

import type { Email } from "~/types";
import { request } from "./api";

export interface ProductView {
	id: string;
	name: string;
	slug: string;
	domains: string[];
	aliases: string[];
	displayName: string | null;
	accentColor: string | null;
	signatureHtml: string | null;
	defaultTemplates: string[];
	logoUrl: string | null;
	logoMimeType: string | null;
	createdAt: number;
	updatedAt: number;
	/** Administrators only. */
	agentPrompt?: string | null;
	knowledgeText?: string | null;
	knowledgeUrl?: string | null;
	knowledgeFetchedAt?: number | null;
}

export type ProductPatch = Partial<
	Pick<
		ProductView,
		| "name"
		| "slug"
		| "domains"
		| "aliases"
		| "displayName"
		| "accentColor"
		| "signatureHtml"
		| "agentPrompt"
		| "knowledgeText"
		| "knowledgeUrl"
		| "defaultTemplates"
	>
>;

export interface UnifiedEmail extends Email {
	mailboxId: string;
	product: { id: string; name: string; slug: string; accentColor: string | null } | null;
}

export interface UnifiedInboxResponse {
	emails: UnifiedEmail[];
	nextCursor: string | null;
	unread: number;
	unreadByMailbox: Record<string, number>;
	mailboxes: string[];
	truncated: string[];
	degraded: string[];
}

const json = (method: string, body?: unknown) => ({
	method,
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const enc = encodeURIComponent;

export const productsApi = {
	list: (opts?: { signal?: AbortSignal }) =>
		request<{ products: ProductView[] }>("/api/v1/products", { signal: opts?.signal }),
	create: (input: ProductPatch & { name: string }) =>
		request<{ product: ProductView }>("/api/v1/products", json("POST", input)),
	update: (id: string, patch: ProductPatch) =>
		request<{ product: ProductView }>(`/api/v1/products/${enc(id)}`, json("PATCH", patch)),
	remove: (id: string) => request<{ ok: boolean }>(`/api/v1/products/${enc(id)}`, json("DELETE")),
	uploadLogo: (id: string, logo: { content: string; filename: string; type: string }) =>
		request<{ product: ProductView }>(`/api/v1/products/${enc(id)}/logo`, json("PUT", logo)),
	deleteLogo: (id: string) =>
		request<{ product: ProductView }>(`/api/v1/products/${enc(id)}/logo`, json("DELETE")),
	refreshKnowledge: (id: string) =>
		request<{ chars: number; product: ProductView | null }>(
			`/api/v1/products/${enc(id)}/knowledge/refresh`,
			json("POST", {}),
		),
	unifiedInbox: (params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		request<UnifiedInboxResponse>(`/api/v1/inbox?${new URLSearchParams(params)}`, { signal: opts?.signal }),
};
