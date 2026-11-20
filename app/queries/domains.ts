// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, {
	type DomainDetailResponse,
	type DomainInput,
	type DomainListResponse,
	type DomainPatch,
	type DomainSendingInput,
	type DomainSendingTestInput,
	type DomainSendingView,
} from "~/services/api";
import { queryKeys } from "./keys";

/** Every domain, plus whether the Cloudflare API is configured. Admin-only. */
export function useDomains(options?: { enabled?: boolean }) {
	return useQuery<DomainListResponse>({
		queryKey: queryKeys.domains.all,
		queryFn: ({ signal }) => api.listDomains({ signal }),
		enabled: options?.enabled ?? true,
	});
}

/** One domain with its DNS records, last audit and last provision run. */
export function useDomain(id: string | null | undefined) {
	return useQuery<DomainDetailResponse>({
		queryKey: id ? queryKeys.domains.detail(id) : ["domains", "_disabled"],
		queryFn: ({ signal }) => api.getDomain(id!, { signal }),
		enabled: !!id,
	});
}

/**
 * Domains feed `/config` (the mailbox create form's domain list) and the
 * mailbox list's counts, so every write refreshes all three.
 */
function useInvalidateDomains() {
	const qc = useQueryClient();
	return (id?: string) => {
		qc.invalidateQueries({ queryKey: queryKeys.domains.all });
		if (id) qc.invalidateQueries({ queryKey: queryKeys.domains.detail(id) });
		qc.invalidateQueries({ queryKey: queryKeys.config });
	};
}

export function useCreateDomain() {
	const invalidate = useInvalidateDomains();
	return useMutation({
		mutationFn: (input: DomainInput) => api.createDomain(input),
		onSuccess: () => invalidate(),
	});
}

export function useUpdateDomain() {
	const invalidate = useInvalidateDomains();
	return useMutation({
		mutationFn: ({ id, patch }: { id: string; patch: DomainPatch }) =>
			api.updateDomain(id, patch),
		onSuccess: (_data, { id }) => invalidate(id),
	});
}

export function useDeleteDomain() {
	const invalidate = useInvalidateDomains();
	return useMutation({
		mutationFn: (id: string) => api.deleteDomain(id),
		onSuccess: () => invalidate(),
	});
}

export function useVerifyDomain() {
	const invalidate = useInvalidateDomains();
	return useMutation({
		mutationFn: (id: string) => api.verifyDomain(id),
		onSuccess: (_data, id) => invalidate(id),
	});
}

export function useProvisionDomain() {
	const invalidate = useInvalidateDomains();
	return useMutation({
		mutationFn: ({
			id,
			overwriteCatchAll,
			confirmEnvDomain,
		}: {
			id: string;
			overwriteCatchAll?: boolean;
			confirmEnvDomain?: boolean;
		}) => api.provisionDomain(id, { overwriteCatchAll, confirmEnvDomain }),
		onSuccess: (_data, { id }) => invalidate(id),
	});
}

/** The domain's sending provider (Cloudflare or Amazon SES). Never carries the secret. */
export function useDomainSending(id: string | null | undefined) {
	return useQuery<DomainSendingView>({
		queryKey: id ? [...queryKeys.domains.detail(id), "sending"] : ["domains", "_disabled", "sending"],
		queryFn: ({ signal }) => api.getDomainSending(id!, { signal }),
		enabled: !!id,
	});
}

function useSetSendingCache() {
	const qc = useQueryClient();
	return (id: string, view: DomainSendingView) =>
		qc.setQueryData([...queryKeys.domains.detail(id), "sending"], view);
}

export function useSetDomainSending() {
	const setCache = useSetSendingCache();
	return useMutation({
		mutationFn: ({ id, input }: { id: string; input: DomainSendingInput }) => api.setDomainSending(id, input),
		onSuccess: (view, { id }) => setCache(id, view),
	});
}

export function useResetDomainSending() {
	const setCache = useSetSendingCache();
	return useMutation({
		mutationFn: (id: string) => api.resetDomainSending(id),
		onSuccess: (view, id) => setCache(id, view),
	});
}

export function useTestDomainSending() {
	const setCache = useSetSendingCache();
	return useMutation({
		mutationFn: ({
			id,
			input,
		}: {
			id: string;
			input?: DomainSendingTestInput;
		}) => api.testDomainSending(id, input),
		onSuccess: ({ sending }, { id }) => setCache(id, sending),
	});
}

/** A mailbox's aliases. Readable by anyone who can open the mailbox. */
export function useMailboxAliases(mailboxId: string | undefined) {
	return useQuery<string[]>({
		queryKey: mailboxId
			? queryKeys.mailboxes.aliases(mailboxId)
			: ["mailboxes", "_disabled", "aliases"],
		queryFn: async ({ signal }) =>
			(await api.getMailboxAliases(mailboxId!, { signal })).aliases ?? [],
		enabled: !!mailboxId,
		// Rarely changes; the composer reads it every time it opens.
		staleTime: 60_000,
		// A Worker without the aliases route answers 404. Treat that as "no
		// aliases" rather than retrying, so the composer never waits on it.
		retry: false,
	});
}

export function useSetMailboxAliases() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, aliases }: { mailboxId: string; aliases: string[] }) =>
			api.setMailboxAliases(mailboxId, aliases),
		onSuccess: (data, { mailboxId }) => {
			qc.setQueryData(queryKeys.mailboxes.aliases(mailboxId), data.aliases);
		},
	});
}
