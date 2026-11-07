// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { DeliveryEvent, Email, EmailPriority } from "~/types";
import { awaitingTerminalEvent } from "~/lib/delivery-timeline";
import { queryKeys } from "./keys";

/**
 * How often the reading pane re-asks for a message's delivery events while its
 * outcome is still unknown.
 *
 * Cloudflare's reconciler runs on a 5-minute cron, so this is deliberately much
 * shorter than the thing it is watching: the verdict can land at any point inside
 * that window, and 30s bounds how long a reader stares at a stale "Sent".
 */
const DELIVERY_POLL_MS = 30_000;

// ---------- Types ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

// ---------- Queries ----------

/**
 * The query for one page of a folder listing, keyed exactly as `useEmails`
 * keys it, so the phone's accumulating list (`usePagedList`) and the desktop
 * pager read and write the same cache entries.
 */
export function emailListQuery(mailboxId: string, params: Record<string, string>) {
	const queryParams = params.folder
		? { ...params, threaded: "true" }
		: params;
	return {
		queryKey: queryKeys.emails.list(mailboxId, queryParams),
		queryFn: async (): Promise<EmailListResponse> => {
			const data = await api.listEmails(mailboxId, queryParams) as
				| EmailListResponse
				| Email[];
			if (data && typeof data === "object" && "emails" in data) {
				return {
					emails: (data as EmailListResponse).emails ?? [],
					totalCount: (data as EmailListResponse).totalCount ?? 0,
				};
			}
			const arr = Array.isArray(data) ? data : [];
			return { emails: arr, totalCount: arr.length };
		},
	};
}

export function useEmails(
	mailboxId: string | undefined,
	params: Record<string, string>,
	options?: { enabled?: boolean; refetchInterval?: number },
) {
	const queryParams = params.folder
		? { ...params, threaded: "true" }
		: params;

	return useQuery<EmailListResponse>({
		queryKey: mailboxId
			? queryKeys.emails.list(mailboxId, queryParams)
			: ["emails", "_disabled"],
		queryFn: async () => {
			const data = await api.listEmails(mailboxId!, queryParams) as
				| EmailListResponse
				| Email[];
			if (data && typeof data === "object" && "emails" in data) {
				return {
					emails: (data as EmailListResponse).emails ?? [],
					totalCount: (data as EmailListResponse).totalCount ?? 0,
				};
			}
			const arr = Array.isArray(data) ? data : [];
			return { emails: arr, totalCount: arr.length };
		},
		enabled: !!mailboxId && (options?.enabled ?? true),
		refetchInterval: options?.refetchInterval,
	});
}

export function useEmail(
	mailboxId: string | undefined,
	emailId: string | undefined,
) {
	return useQuery<Email>({
		queryKey: mailboxId && emailId
			? queryKeys.emails.detail(mailboxId, emailId)
			: ["emails", "_disabled_detail"],
		queryFn: () => api.getEmail(mailboxId!, emailId!) as Promise<Email>,
		enabled: !!mailboxId && !!emailId,
	});
}

/**
 * Account-level Sent analytics across every accessible mailbox.
 *
 * `days` is part of the key so switching the window refetches. A five-minute
 * stale time keeps the panel snappy without hammering the fan-out (one DO round
 * trip per visible mailbox) on every focus.
 */
export function useSentAnalytics(days: number) {
	return useQuery({
		queryKey: ["analytics", "sent", days],
		queryFn: () => api.getSentAnalytics(days),
		staleTime: 5 * 60 * 1000,
	});
}

/**
 * The delivery timeline for a sent message.
 *
 * Loaded lazily — `enabled` is the caller's responsibility, so the reading pane
 * fetches it only when the "delivery details" section is expanded, not for every
 * message opened. Inbound mail has no timeline, so the caller gates on the
 * message being one this mailbox sent.
 */
export function useDeliveryEvents(
	mailboxId: string | undefined,
	emailId: string | undefined,
	options?: { enabled?: boolean },
) {
	return useQuery<DeliveryEvent[]>({
		queryKey:
			mailboxId && emailId
				? queryKeys.emails.deliveryEvents(mailboxId, emailId)
				: ["emails", "_disabled_delivery_events"],
		queryFn: async () => {
			const data = await api.getDeliveryEvents(mailboxId!, emailId!);
			return data.events ?? [];
		},
		enabled: !!mailboxId && !!emailId && (options?.enabled ?? true),
		/*
		 * Poll only while the outcome is still unknown.
		 *
		 * Delivery truth comes from Cloudflare's analytics dataset via a 5-minute
		 * cron, so a fresh send genuinely has no verdict for a few minutes. With the
		 * app-wide defaults (`staleTime: 30s`, `refetchOnWindowFocus: false`) and no
		 * interval, a reader sitting on the message they just sent never saw it
		 * advance past "Sent" — the reconciler wrote `delivered` and the pane simply
		 * never asked again.
		 *
		 * The interval is a function of the data rather than a constant so it turns
		 * itself off: once a delivered/bounced event exists the answer cannot change,
		 * and polling a settled message forever would be a request per open tab per
		 * half-minute for no new information. `false` is react-query's "stop".
		 */
		refetchInterval: (query) =>
			awaitingTerminalEvent(query.state.data ?? []) ? DELIVERY_POLL_MS : false,
	});
}

/**
 * The messages of a conversation, scoped to the folder being viewed.
 *
 * `folder` is part of the cache key as well as the request: Trash shows only the
 * conversation's trashed messages while Inbox shows everything else, so the two
 * views hold genuinely different answers for the same thread and must not share
 * an entry. Sharing one is what would make a trashed draft reappear as a whole
 * conversation after visiting Trash.
 */
export function useThreadReplies(
	mailboxId: string | undefined,
	threadId: string | undefined | null,
	folder?: string,
) {
	const qc = useQueryClient();

	return useQuery<Email[]>({
		queryKey: mailboxId && threadId
			? queryKeys.emails.thread(mailboxId, threadId, folder)
			: ["emails", "_disabled_thread"],
		queryFn: async ({ signal }) => {
			// Single request returns all thread emails with full bodies +
			// attachments. Eliminates the previous N+1 pattern that fired
			// a separate getEmail call per thread message.
			const emails = await api.getThread(mailboxId!, threadId!, {
				signal,
				...(folder ? { folder } : {}),
			}) as Email[];

			// Populate individual email detail caches so clicking a thread
			// message in the panel doesn't re-fetch.
			for (const email of emails) {
				qc.setQueryData(
					queryKeys.emails.detail(mailboxId!, email.id),
					email,
				);
			}

			return emails;
		},
		enabled: !!mailboxId && !!threadId,
	});
}

// ---------- Mutations ----------

/** Invalidate both the email list and folder counts after any email mutation. */
function useInvalidateEmailData() {
	const qc = useQueryClient();
	return (mailboxId: string) => {
		qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		qc.invalidateQueries({
			queryKey: queryKeys.folders.list(mailboxId),
		});
	};
}

export function useUpdateEmail() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			data,
		}: { mailboxId: string; id: string; data: unknown }) =>
			api.updateEmail(mailboxId, id, data),
		onMutate: async ({ mailboxId, id, data }) => {
			// Only target list queries (3rd key element is an object = params),
			// NOT detail queries (string = emailId) or thread queries.
			const isListQuery = (query: { queryKey: readonly unknown[] }) =>
				query.queryKey[0] === "emails" &&
				query.queryKey[1] === mailboxId &&
				typeof query.queryKey[2] === "object" &&
				query.queryKey[2] !== null;

			// Cancel in-flight list queries so they don't overwrite our optimistic update
			await qc.cancelQueries({
				queryKey: ["emails", mailboxId],
				predicate: isListQuery,
			});

			// Snapshot current email list caches for rollback
			const listQueries = qc.getQueriesData<{ emails: Email[]; totalCount: number }>({
				queryKey: ["emails", mailboxId],
				predicate: isListQuery,
			});

			// Optimistically patch every cached email list that contains this email
			for (const [key, cached] of listQueries) {
				if (!cached?.emails) continue;
				qc.setQueryData(key, {
					...cached,
					emails: cached.emails.map((e) =>
						e.id === id ? { ...e, ...(data as Partial<Email>) } : e,
					),
				});
			}

			// Also patch the detail cache
			const detailKey = queryKeys.emails.detail(mailboxId, id);
			const prevDetail = qc.getQueryData<Email>(detailKey);
			if (prevDetail) {
				qc.setQueryData(detailKey, { ...prevDetail, ...(data as Partial<Email>) });
			}

			return { listQueries, prevDetail, detailKey };
		},
		onError: (_err, _vars, context) => {
			// Roll back optimistic updates on failure
			if (context?.listQueries) {
				for (const [key, cached] of context.listQueries) {
					qc.setQueryData(key, cached);
				}
			}
			if (context?.prevDetail) {
				qc.setQueryData(context.detailKey, context.prevDetail);
			}
		},
		onSettled: (_data, _err, { mailboxId }) => {
			// Always refetch to ensure server truth
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			qc.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		},
	});
}

export function useMarkThreadRead() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			threadId,
		}: { mailboxId: string; threadId: string }) =>
			api.markThreadRead(mailboxId, threadId),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			qc.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		},
	});
}

/**
 * Delete a message.
 *
 * Resolves to `{ status: "trashed" }` when the message was binned rather than
 * destroyed, so callers can offer Undo only when there is something to undo.
 * Pass `permanent` to skip the bin; see api.deleteEmail.
 */
export function useDeleteEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			permanent,
		}: { mailboxId: string; id: string; permanent?: boolean }) =>
			api.deleteEmail(mailboxId, id, { permanent }),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

/** Put a binned message back in the folder it was deleted from. */
export function useRestoreEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({ mailboxId, id }: { mailboxId: string; id: string }) =>
			api.restoreEmail(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

/** Destroy everything in Trash. Not reversible. */
export function useEmptyTrash() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({ mailboxId }: { mailboxId: string }) =>
			api.emptyTrash(mailboxId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useMoveEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			folderId,
		}: { mailboxId: string; id: string; folderId: string }) =>
			api.moveEmail(mailboxId, id, folderId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

/**
 * Rescue a message from Spam.
 *
 * Distinct from `useMoveEmail` because the move is only a third of the job: the
 * server also clears any block rule matching the sender and allowlists them.
 * Marking something not-spam used to be a plain move, which left the sender
 * blocked and still scoring as spam, so their next message went straight back
 * into Spam and the action looked like it had done nothing.
 */
export function useMarkNotSpam() {
	const qc = useQueryClient();
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({ mailboxId, id }: { mailboxId: string; id: string }) =>
			api.markNotSpam(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => {
			invalidate(mailboxId);
			// Both sender lists can have changed.
			qc.invalidateQueries({
				queryKey: queryKeys.blockedSenders.list(mailboxId),
			});
			qc.invalidateQueries({
				queryKey: queryKeys.allowedSenders.list(mailboxId),
			});
		},
	});
}

export function useSaveDraft() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			draft,
		}: {
			mailboxId: string;
			draft: Parameters<typeof api.saveDraft>[1];
		}) => api.saveDraft(mailboxId, draft),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

/*
 * There are deliberately no reply/forward mutation hooks here.
 *
 * Every send from the UI goes through `useSendWithUndo` → the scheduled-send
 * route, so it gets an undo window; threading is handed to the server as
 * `replyToEmailId`. The `POST …/emails/:id/reply` and `…/forward` routes remain
 * for API and MCP callers, which is why they are covered by
 * test/reply-forward.test.ts, but nothing in the app calls them and hooks that
 * bypassed the undo window would be a trap for the next person to wire up a
 * Reply button.
 */

// ---------- Snooze ----------

/**
 * Snoozing moves a message into the Snoozed folder and arms a Durable Object
 * alarm to return it, so these are ordinary email mutations rather than a
 * separate subsystem — they just also touch the snoozed list.
 */
function useInvalidateSnoozeData() {
	const qc = useQueryClient();
	const invalidateEmails = useInvalidateEmailData();
	return (mailboxId: string) => {
		invalidateEmails(mailboxId);
		qc.invalidateQueries({ queryKey: queryKeys.snoozed.list(mailboxId) });
	};
}

/*
 * The Snoozed folder is listed through `useEmails(mailboxId, { folder:
 * "snoozed" })` like any other, so there is no separate list hook here — only
 * the mutations, plus the cache invalidation the snoozed list needs.
 */

/** Pass either an absolute `until` (ISO) or a relative `delay_seconds`. */
export function useSnoozeEmail() {
	const invalidate = useInvalidateSnoozeData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			when,
		}: {
			mailboxId: string;
			id: string;
			when: { until: string } | { delay_seconds: number };
		}) => api.snoozeEmail(mailboxId, id, when),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useUnsnoozeEmail() {
	const invalidate = useInvalidateSnoozeData();
	return useMutation({
		mutationFn: ({ mailboxId, id }: { mailboxId: string; id: string }) =>
			api.unsnoozeEmail(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

// ---------- Priority ----------

/** `null` resets the message to normal priority. */
export function useSetEmailPriority() {
	const qc = useQueryClient();
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			priority,
		}: { mailboxId: string; id: string; priority: EmailPriority }) =>
			api.setEmailPriority(mailboxId, id, priority),
		onSuccess: (email, { mailboxId, id }) => {
			qc.setQueryData(queryKeys.emails.detail(mailboxId, id), email);
			invalidate(mailboxId);
		},
	});
}
