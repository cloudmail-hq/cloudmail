// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { Signature } from "~/types";
import { queryKeys } from "./keys";

/**
 * Signatures live in the mailbox Durable Object, one row each, with at most one
 * flagged default. This supersedes the single signature previously kept in the
 * mailbox settings blob (see `getSignatureBlock` in ~/lib/utils), which could
 * only hold one and had no notion of picking between them.
 */

export function useSignatures(mailboxId: string | undefined) {
	return useQuery<Signature[]>({
		queryKey: mailboxId
			? queryKeys.signatures.list(mailboxId)
			: ["signatures", "_disabled"],
		queryFn: ({ signal }) => api.listSignatures(mailboxId!, { signal }),
		enabled: !!mailboxId,
	});
}

/**
 * The signature the composer should prefill with.
 *
 * Derived from the list rather than fetched separately so both stay in sync off
 * one cache entry — the dedicated `/signatures/default` endpoint exists for API
 * consumers that don't want the whole list.
 */
export function useDefaultSignature(mailboxId: string | undefined) {
	const { data, ...rest } = useSignatures(mailboxId);
	return {
		...rest,
		data: data?.find((s) => s.is_default) ?? null,
	};
}

// ---------- Mutations ----------

function useInvalidateSignatures() {
	const qc = useQueryClient();
	return (mailboxId: string) => {
		qc.invalidateQueries({ queryKey: queryKeys.signatures.list(mailboxId) });
	};
}

export function useCreateSignature() {
	const invalidate = useInvalidateSignatures();
	return useMutation({
		mutationFn: ({
			mailboxId,
			...data
		}: {
			mailboxId: string;
			name: string;
			body_html: string;
			is_default?: boolean;
		}) => api.createSignature(mailboxId, data),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useUpdateSignature() {
	const invalidate = useInvalidateSignatures();
	return useMutation({
		mutationFn: ({
			mailboxId,
			signatureId,
			patch,
		}: {
			mailboxId: string;
			signatureId: string;
			patch: { name?: string; body_html?: string; is_default?: boolean };
		}) => api.updateSignature(mailboxId, signatureId, patch),
		// Promoting a new default clears the flag on the old one server-side, so
		// the whole list has to be refetched rather than patched in place.
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useDeleteSignature() {
	const invalidate = useInvalidateSignatures();
	return useMutation({
		mutationFn: ({
			mailboxId,
			signatureId,
		}: { mailboxId: string; signatureId: string }) =>
			api.deleteSignature(mailboxId, signatureId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}
