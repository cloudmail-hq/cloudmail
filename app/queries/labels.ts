// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { Email, EmailLabel, Label } from "~/types";
import { queryKeys } from "./keys";

/**
 * Labels are orthogonal to folders: a message sits in exactly one folder but
 * can carry any number of labels, so these hooks are separate from
 * ./folders.ts rather than folded into it.
 */

export function useLabels(mailboxId: string | undefined) {
	return useQuery<Label[]>({
		queryKey: mailboxId
			? queryKeys.labels.list(mailboxId)
			: ["labels", "_disabled"],
		queryFn: ({ signal }) => api.listLabels(mailboxId!, { signal }),
		enabled: !!mailboxId,
	});
}

/** Labels attached to a single message, for the label picker. */
export function useEmailLabels(
	mailboxId: string | undefined,
	emailId: string | undefined,
) {
	return useQuery<EmailLabel[]>({
		queryKey: mailboxId && emailId
			? queryKeys.labels.forEmail(mailboxId, emailId)
			: ["labels", "_disabled_email"],
		queryFn: ({ signal }) => api.listEmailLabels(mailboxId!, emailId!, { signal }),
		enabled: !!mailboxId && !!emailId,
	});
}

export function useLabelEmails(
	mailboxId: string | undefined,
	labelId: string | undefined,
	params: Record<string, string> = {},
) {
	return useQuery<{ emails: Email[]; totalCount: number }>({
		queryKey: mailboxId && labelId
			? queryKeys.labels.emails(mailboxId, labelId, params)
			: ["labels", "_disabled_emails"],
		queryFn: ({ signal }) =>
			api.listLabelEmails(mailboxId!, labelId!, params, { signal }),
		enabled: !!mailboxId && !!labelId,
	});
}

// ---------- Mutations ----------

/**
 * Label counts are derived from the emails they cover, so any label write has
 * to refresh the email lists too — otherwise a freshly applied label shows a
 * stale count until the next poll.
 */
function useInvalidateLabelData() {
	const qc = useQueryClient();
	return (mailboxId: string) => {
		qc.invalidateQueries({ queryKey: queryKeys.labels.list(mailboxId) });
		qc.invalidateQueries({ queryKey: ["labels", mailboxId] });
		qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
	};
}

export function useCreateLabel() {
	const invalidate = useInvalidateLabelData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			...data
		}: {
			mailboxId: string;
			name: string;
			color?: string;
			parent_id?: string | null;
			sort_order?: number;
		}) => api.createLabel(mailboxId, data),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useUpdateLabel() {
	const invalidate = useInvalidateLabelData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			labelId,
			patch,
		}: {
			mailboxId: string;
			labelId: string;
			patch: {
				name?: string;
				color?: string;
				parent_id?: string | null;
				sort_order?: number;
			};
		}) => api.updateLabel(mailboxId, labelId, patch),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useDeleteLabel() {
	const invalidate = useInvalidateLabelData();
	return useMutation({
		mutationFn: ({ mailboxId, labelId }: { mailboxId: string; labelId: string }) =>
			api.deleteLabel(mailboxId, labelId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

/**
 * Replace a message's whole label set.
 *
 * The picker submits the full selection rather than a diff, which keeps it
 * idempotent: a double-click can't leave a half-applied set behind.
 */
export function useSetEmailLabels() {
	const qc = useQueryClient();
	const invalidate = useInvalidateLabelData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
			labelIds,
		}: { mailboxId: string; emailId: string; labelIds: string[] }) =>
			api.setEmailLabels(mailboxId, emailId, labelIds),
		onSuccess: (labels, { mailboxId, emailId }) => {
			// Seed the per-email cache from the response so the picker settles
			// immediately instead of flickering through a refetch.
			qc.setQueryData(queryKeys.labels.forEmail(mailboxId, emailId), labels);
			invalidate(mailboxId);
		},
	});
}

/*
 * There are no single add/remove hooks: every caller applies labels through the
 * picker, and submitting the whole set is what makes repeated clicks safe. The
 * POST and DELETE endpoints remain for API consumers.
 */
