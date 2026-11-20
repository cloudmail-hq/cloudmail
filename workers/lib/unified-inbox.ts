// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The unified inbox: one list across every mailbox the caller may read.
 *
 * Fans out one keyset query per mailbox in parallel (capped at
 * `UNIFIED_MAILBOX_CAP`), merges by date, and returns a cursor of per-mailbox
 * high-water marks (see `shared/products.ts`). Read-only: actions on a row go
 * to the owning mailbox's routes, which is why every row carries `mailboxId`.
 *
 * The caller narrows `mailboxes` to what the principal may read before this
 * runs, as `/api/v1/people` does, so nothing here can widen access.
 */

import type { Env } from "../types";
import {
	UNIFIED_MAILBOX_CAP,
	decodeUnifiedCursor,
	mergeUnifiedPages,
	resolveProduct,
	type Product,
	type UnifiedCursor,
} from "../../shared/products";

export interface UnifiedQuery {
	folder: string;
	limit: number;
	cursor?: string | null;
	unread?: boolean;
	starred?: boolean;
	has_attachment?: boolean;
}

type UnifiedStub = {
	getUnifiedPage(o: {
		folder: string;
		limit: number;
		after?: { date: string; id: string } | null;
		unread?: boolean;
		starred?: boolean;
		has_attachment?: boolean;
	}): Promise<{ rows: Record<string, unknown>[]; unread: number }>;
};

export interface UnifiedProductTag {
	id: string;
	name: string;
	slug: string;
	accentColor: string | null;
}

export interface UnifiedResult {
	emails: (Record<string, unknown> & { mailboxId: string; product: UnifiedProductTag | null })[];
	nextCursor: string | null;
	/**
	 * Unread in the folder, summed over the mailboxes queried. Complete on the
	 * first page; later pages skip mailboxes already exhausted.
	 */
	unread: number;
	unreadByMailbox: Record<string, number>;
	mailboxes: string[];
	/** Readable mailboxes left out by the cap. */
	truncated: string[];
	/** Mailboxes that failed to answer; their rows are missing from this page. */
	degraded: string[];
}

export class InvalidCursorError extends Error {}

/** Products a mailbox's own address resolves to, so a filter can pick mailboxes. */
export function mailboxesForProducts(
	mailboxes: readonly string[],
	products: readonly Product[],
	wanted: readonly string[],
): string[] {
	if (wanted.length === 0) return [...mailboxes];
	const ids = new Set(wanted);
	return mailboxes.filter((m) => {
		const p = resolveProduct(products, m);
		return !!p && (ids.has(p.id) || ids.has(p.slug));
	});
}

export function productTag(product: Product | null): UnifiedProductTag | null {
	return product
		? { id: product.id, name: product.displayName || product.name, slug: product.slug, accentColor: product.accentColor }
		: null;
}

export async function listUnified(
	env: Env,
	readable: readonly string[],
	products: readonly Product[],
	query: UnifiedQuery,
): Promise<UnifiedResult> {
	const sorted = [...new Set(readable.map((m) => m.toLowerCase()))].sort();
	const mailboxes = sorted.slice(0, UNIFIED_MAILBOX_CAP);
	const truncated = sorted.slice(UNIFIED_MAILBOX_CAP);

	let previous: UnifiedCursor | null = null;
	if (query.cursor) {
		previous = decodeUnifiedCursor(query.cursor);
		if (!previous) throw new InvalidCursorError("Invalid cursor");
	}

	// An exhausted mailbox (mark === null) is not asked again.
	const active = mailboxes.filter((m) => !previous || previous[m] !== null);
	const limit = Math.min(Math.max(query.limit, 1), 100);
	const settled = await Promise.allSettled(
		active.map(async (mailbox) => {
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox)) as unknown as UnifiedStub;
			const page = await stub.getUnifiedPage({
				folder: query.folder,
				limit,
				after: previous?.[mailbox] ?? null,
				unread: query.unread,
				starred: query.starred,
				has_attachment: query.has_attachment,
			});
			return { mailbox, ...page };
		}),
	);

	const pages: { mailboxId: string; rows: (Record<string, unknown> & { id: string; date: string; mailboxId: string })[] }[] = [];
	const unreadByMailbox: Record<string, number> = {};
	const degraded: string[] = [];
	settled.forEach((result, i) => {
		const mailbox = active[i]!;
		if (result.status === "rejected") {
			degraded.push(mailbox);
			console.error(`Unified inbox: ${mailbox} failed:`, (result.reason as Error)?.message);
			return;
		}
		unreadByMailbox[mailbox] = result.value.unread;
		pages.push({
			mailboxId: mailbox,
			rows: result.value.rows.map((row) => ({
				...row,
				id: String(row.id),
				date: String(row.date ?? ""),
				mailboxId: mailbox,
			})),
		});
	});

	const merged = mergeUnifiedPages(pages, previous, limit);
	// A degraded mailbox keeps its previous mark, so if there is a next page it
	// is retried there. It does not by itself keep paging alive: a mailbox that
	// always fails would otherwise make the cursor endless.
	const nextCursor = merged.nextCursor;

	const byMailbox = new Map(mailboxes.map((m) => [m, resolveProduct(products, m)]));
	return {
		emails: merged.rows.map((row) => {
			// The row's own recipient decides the product where it is one of ours
			// (mail to an alias of another product), else the mailbox address.
			const viaRecipient = resolveProduct(products, String(row.recipient ?? "").split(",")[0]);
			return { ...row, product: productTag(viaRecipient ?? byMailbox.get(row.mailboxId) ?? null) };
		}),
		nextCursor,
		unread: Object.values(unreadByMailbox).reduce((a, b) => a + b, 0),
		unreadByMailbox,
		mailboxes,
		truncated,
		degraded,
	};
}
