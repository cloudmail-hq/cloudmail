// Copyright (c) 2026 Cloudflare, Inc. Licensed under the Apache License 2.0 (LICENSES/Apache-2.0.txt).
// Modified by Tapetide. This file as a whole is licensed under the Fair Core License (LICENSE).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { Folder } from "~/types";
import { queryKeys } from "./keys";

export function useFolders(mailboxId: string | undefined) {
	return useQuery<Folder[]>({
		queryKey: mailboxId
			? queryKeys.folders.list(mailboxId)
			: ["folders", "_disabled"],
		queryFn: () => api.listFolders(mailboxId!) as Promise<Folder[]>,
		enabled: !!mailboxId,
	});
}

export function useCreateFolder() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			name,
		}: { mailboxId: string; name: string }) =>
			api.createFolder(mailboxId, name),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
		},
	});
}

export function useUpdateFolder() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			name,
		}: { mailboxId: string; id: string; name: string }) =>
			api.updateFolder(mailboxId, id, name),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
		},
	});
}

/**
 * Delete a custom folder.
 *
 * Deleting a folder relocates its contents to the inbox, so the email lists are
 * invalidated too — messages have changed folder, not just disappeared.
 */
export function useDeleteFolder() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
		}: { mailboxId: string; id: string }) =>
			api.deleteFolder(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		},
	});
}
