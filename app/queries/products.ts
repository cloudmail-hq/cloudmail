// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { productsApi, type ProductPatch, type ProductView } from "~/services/products-api";
import { resolveProduct } from "shared/products";

export const productKeys = {
	all: ["products"] as const,
	unified: (params: Record<string, string>) => ["unified-inbox", params] as const,
	unifiedAll: ["unified-inbox"] as const,
	/** Under `unifiedAll` for the same reason: the Mail badge. */
	inboxUnread: ["unified-inbox", "unread"] as const,
};

/**
 * Unread Inbox mail per readable mailbox, for the Mail badge in the top bar and tab bar.
 *
 * One request that asks each mailbox for a single row and its unread count.
 * Polled, and refreshed whenever the unified list is invalidated.
 */
export function useInboxUnread(enabled = true) {
	return useQuery({
		queryKey: productKeys.inboxUnread,
		queryFn: async ({ signal }) =>
			(await productsApi.unifiedInbox({ folder: "inbox", limit: "1" }, { signal })).unreadByMailbox,
		enabled,
		staleTime: 20_000,
		refetchInterval: 60_000,
	});
}

/** Every product. Changes only from settings, which invalidate it. */
export function useProducts() {
	return useQuery({
		queryKey: productKeys.all,
		queryFn: async ({ signal }) => (await productsApi.list({ signal })).products,
		staleTime: 60_000,
	});
}

/** The product a From address resolves to, from the cached list. */
export function useProductFor(from: string | null | undefined): ProductView | null {
	const { data: products = [] } = useProducts();
	return from ? resolveProduct(products, from) : null;
}

function useInvalidateProducts() {
	const qc = useQueryClient();
	return () => {
		void qc.invalidateQueries({ queryKey: productKeys.all });
		void qc.invalidateQueries({ queryKey: productKeys.unifiedAll });
	};
}

export function useCreateProduct() {
	const invalidate = useInvalidateProducts();
	return useMutation({
		mutationFn: (input: ProductPatch & { name: string }) => productsApi.create(input),
		onSuccess: invalidate,
	});
}

export function useUpdateProduct() {
	const invalidate = useInvalidateProducts();
	return useMutation({
		mutationFn: ({ id, patch }: { id: string; patch: ProductPatch }) => productsApi.update(id, patch),
		onSuccess: invalidate,
	});
}

export function useDeleteProduct() {
	const invalidate = useInvalidateProducts();
	return useMutation({ mutationFn: (id: string) => productsApi.remove(id), onSuccess: invalidate });
}

export function useUploadProductLogo() {
	const invalidate = useInvalidateProducts();
	return useMutation({
		mutationFn: ({ id, logo }: { id: string; logo: { content: string; filename: string; type: string } }) =>
			productsApi.uploadLogo(id, logo),
		onSuccess: invalidate,
	});
}

export function useDeleteProductLogo() {
	const invalidate = useInvalidateProducts();
	return useMutation({ mutationFn: (id: string) => productsApi.deleteLogo(id), onSuccess: invalidate });
}

export function useRefreshProductKnowledge() {
	const invalidate = useInvalidateProducts();
	return useMutation({ mutationFn: (id: string) => productsApi.refreshKnowledge(id), onSuccess: invalidate });
}

/** The unified inbox, cursor-paged. */
export function useUnifiedInbox(params: Record<string, string>) {
	return useInfiniteQuery({
		queryKey: productKeys.unified(params),
		initialPageParam: null as string | null,
		queryFn: ({ pageParam, signal }) =>
			productsApi.unifiedInbox(pageParam ? { ...params, cursor: pageParam } : params, { signal }),
		getNextPageParam: (last) => last.nextCursor,
		refetchInterval: 30_000,
	});
}
