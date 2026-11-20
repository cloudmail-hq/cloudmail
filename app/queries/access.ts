// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Access grants: who may open which mailbox.
 *
 * Covers people and machines, where a machine is a Cloudflare Access service
 * token identified by the Client ID that Access puts in the token's `common_name`
 * claim. Both are granted through the same model.
 *
 * Administrator-only, so these hooks are only mounted behind the admin gate in
 * Settings. A member calling them gets a 403 from the Worker regardless — the gate
 * is a courtesy to the UI, not the boundary.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, {
	type AccessGrant,
	type AccessGrantInput,
	type AccessResponse,
	type AuditEntry,
	type AuditFilter,
	type MailboxDelegate,
	type MailboxDelegateInput,
	type MailboxDelegatesResponse,
	type PrincipalKind,
} from "~/services/api";
import { queryKeys } from "./keys";

export function useAccess(options?: { enabled?: boolean }) {
	return useQuery<AccessResponse>({
		queryKey: queryKeys.accessGrants,
		queryFn: ({ signal }) => api.listAccess({ signal }),
		// Stays idle until the caller is known to be an admin, so a member never
		// fires a request that can only 403.
		enabled: options?.enabled ?? true,
	});
}

/** Invalidate the grant list, and the identity whose role it may have changed. */
function useGrantInvalidation() {
	const qc = useQueryClient();
	return () => {
		qc.invalidateQueries({ queryKey: queryKeys.accessGrants });
		// An edit can change the signed-in user's own role, which decides what the
		// chrome renders.
		qc.invalidateQueries({ queryKey: queryKeys.currentUser });
		// It can also change which mailboxes they may see.
		qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		// And it writes an audit entry, so a log left on screen would be stale.
		qc.invalidateQueries({ queryKey: queryKeys.accessAudit });
	};
}

/**
 * The deployment-wide access log: grants, and mailbox creation and deletion.
 *
 * Administrator-only, so it stays idle until the caller is known to be one — a
 * member firing this could only ever get a 403.
 *
 * No `staleTime`: an operator opening this is asking what has happened, and a
 * cached answer is the wrong one.
 */
export function useAccessAudit(options?: { enabled?: boolean; limit?: number; filter?: AuditFilter }) {
	return useQuery<AuditEntry[]>({
		queryKey: [...queryKeys.accessAudit, options?.filter ?? {}],
		queryFn: ({ signal }) => api.listAccessAudit(options?.limit, { signal, filter: options?.filter }),
		enabled: options?.enabled ?? true,
	});
}

/** One mailbox's log. Available to whoever manages its settings. */
export function useMailboxAudit(
	mailboxId: string | undefined,
	options?: { enabled?: boolean; limit?: number; filter?: AuditFilter },
) {
	return useQuery<AuditEntry[]>({
		queryKey: [...queryKeys.mailboxAudit(mailboxId ?? ""), options?.filter ?? {}],
		queryFn: ({ signal }) => api.listMailboxAudit(mailboxId!, options?.limit, { signal, filter: options?.filter }),
		enabled: Boolean(mailboxId) && (options?.enabled ?? true),
	});
}

/**
 * Create or replace a grant.
 *
 * `PUT` with the identifier in the body rather than `POST`: a grant is identified
 * by its principal, so writing one twice must be the same as writing it once.
 */
export function useSaveAccessGrant() {
	const invalidate = useGrantInvalidation();
	return useMutation<AccessGrant, Error, AccessGrantInput>({
		mutationFn: (grant) => api.saveAccessGrant(grant),
		onSuccess: invalidate,
	});
}

export function useDeleteAccessGrant() {
	const invalidate = useGrantInvalidation();
	return useMutation<void, Error, { kind: PrincipalKind; id: string }>({
		mutationFn: ({ kind, id }) => api.deleteAccessGrant(kind, id),
		onSuccess: invalidate,
	});
}

/**
 * Who else can use one mailbox, as its owner sees it.
 *
 * Distinct from {@link useAccess}, which is the instance-wide grant list and
 * administrator-only. This is available to whoever holds `manageDelegates` on the
 * mailbox — in practice its owner — and returns only this mailbox's entry for each
 * delegate, because the other mailboxes in someone's grant are not the owner's to
 * see.
 *
 * A caller without that capability gets a 403 the Worker decides; the global query
 * config does not retry 4xx, so the refusal settles once rather than looping.
 */
export function useMailboxDelegates(
	mailboxId: string | undefined,
	options?: { enabled?: boolean },
) {
	return useQuery<MailboxDelegatesResponse>({
		queryKey: queryKeys.mailboxDelegates(mailboxId ?? ""),
		queryFn: ({ signal }) => api.listMailboxDelegates(mailboxId!, { signal }),
		enabled: Boolean(mailboxId) && (options?.enabled ?? true),
	});
}

/**
 * Invalidate everything a delegation change can move.
 *
 * The mailbox's own delegate list and audit log obviously, but also the signed-in
 * user's identity and the mailbox list: an owner can grant *themselves* nothing,
 * yet the grantee may be looking at the same deployment in another tab, and the
 * instance-wide list an administrator may have open is now stale too.
 */
function useDelegateInvalidation(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return () => {
		if (mailboxId) {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxDelegates(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxAudit(mailboxId) });
		}
		qc.invalidateQueries({ queryKey: queryKeys.accessGrants });
		qc.invalidateQueries({ queryKey: queryKeys.accessAudit });
		qc.invalidateQueries({ queryKey: queryKeys.currentUser });
		qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
	};
}

export function useSaveMailboxDelegate(mailboxId: string | undefined) {
	const invalidate = useDelegateInvalidation(mailboxId);
	return useMutation<MailboxDelegate, Error, MailboxDelegateInput>({
		mutationFn: (delegate) => api.saveMailboxDelegate(mailboxId!, delegate),
		onSuccess: invalidate,
	});
}

export function useDeleteMailboxDelegate(mailboxId: string | undefined) {
	const invalidate = useDelegateInvalidation(mailboxId);
	return useMutation<void, Error, { kind: PrincipalKind; id: string }>({
		mutationFn: ({ kind, id }) => api.deleteMailboxDelegate(mailboxId!, kind, id),
		onSuccess: invalidate,
	});
}
