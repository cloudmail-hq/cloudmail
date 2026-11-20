// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { Mailbox } from "~/types";
import { buildAutoDraftSettings } from "../../shared/auto-draft";
import type { MailboxSettingsPatch } from "../../shared/mailbox-settings";
import { queryKeys } from "./keys";

export function useMailboxes(domain?: string) {
	return useQuery<Mailbox[]>({
		queryKey: domain ? [...queryKeys.mailboxes.all, domain] : queryKeys.mailboxes.all,
		queryFn: () => api.listMailboxes(domain) as Promise<Mailbox[]>,
	});
}

/** Every mailbox with its settings, for screens that configure all of them. */
export function useMailboxesWithSettings() {
	return useQuery<Mailbox[]>({
		queryKey: queryKeys.mailboxes.withSettings,
		queryFn: ({ signal }) => api.listMailboxesWithSettings({ signal }),
	});
}

/**
 * Toggle automatic draft replies for one mailbox.
 *
 * Sends `autoDraft` alone. `PUT /mailboxes/:id` merges the patch into the stored
 * blob server-side, so this no longer has to spread a whole snapshot to avoid
 * wiping the display name, signature, auto-reply and agent prompt — and must
 * not: bulk enable/disable fires one write per mailbox, and resending entire
 * snapshots is how two concurrent saves each reverted the other's field.
 *
 * The cache is updated optimistically and rolled back if the write fails: a
 * switch that flips and then quietly reverts to the wrong state is worse than
 * one that takes a moment, so the row reports the failure instead.
 */
export function useSetAutoDraft() {
	const qc = useQueryClient();

	return useMutation({
		mutationFn: ({ mailbox, enabled }: { mailbox: Mailbox; enabled: boolean }) =>
			api.updateMailbox(mailbox.id, { autoDraft: { enabled } }),

		onMutate: async ({ mailbox, enabled }) => {
			await qc.cancelQueries({ queryKey: queryKeys.mailboxes.withSettings });
			const previous = qc.getQueryData<Mailbox[]>(queryKeys.mailboxes.withSettings);

			qc.setQueryData<Mailbox[]>(queryKeys.mailboxes.withSettings, (current) =>
				current?.map((m) =>
					m.id === mailbox.id
						? {
								...m,
								settings: buildAutoDraftSettings(m.settings, enabled),
							}
						: m,
				),
			);

			return { previous };
		},

		onError: (_err, { mailbox, enabled }, context) => {
			// Revert just this row rather than restoring the whole snapshot. Bulk
			// enable/disable fires one mutation per mailbox, and each snapshot was
			// taken at a different point, so writing a whole one back would undo
			// the other rows' successful toggles.
			const before = context?.previous?.find((m) => m.id === mailbox.id);
			qc.setQueryData<Mailbox[]>(queryKeys.mailboxes.withSettings, (current) =>
				current?.map((m) =>
					m.id === mailbox.id
						? { ...m, settings: before?.settings ?? buildAutoDraftSettings(m.settings, !enabled) }
						: m,
				),
			);
		},

		onSuccess: (_data, { mailbox }) => {
			// The per-mailbox settings page reads the same field.
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailbox.id) });
		},

		onSettled: () => {
			// Re-read from the bucket once the write settles, so the switches end up
			// showing stored state rather than whatever the optimistic updates left
			// behind. Matters most for bulk toggles, where several writes interleave.
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.withSettings });
		},
	});
}

export function useMailbox(mailboxId: string | undefined) {
	return useQuery<Mailbox>({
		queryKey: mailboxId
			? queryKeys.mailboxes.detail(mailboxId)
			: ["mailboxes", "_disabled"],
		queryFn: () => api.getMailbox(mailboxId!) as Promise<Mailbox>,
		enabled: !!mailboxId,
	});
}

export function useCreateMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ email, name }: { email: string; name: string }) =>
			api.createMailbox(email, name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useUpdateMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			settings,
		}: { mailboxId: string; settings: MailboxSettingsPatch }) =>
			api.updateMailbox(mailboxId, settings),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useDeleteMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (mailboxId: string) => api.deleteMailbox(mailboxId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}
