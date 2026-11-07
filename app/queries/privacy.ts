// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Privacy and data controls: per-mailbox tracking toggles, the operator's
 * privacy notice, and self-service account export and deletion. Server side in
 * `workers/routes/privacy.ts`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PrivacySettings, PrivacySettingsInput } from "shared/privacy";
import { request } from "~/services/api";

export interface TrackingSettings {
	openTracking: boolean;
	clickTracking: boolean;
	attachmentTracking: boolean;
	disclosureEnabled: boolean;
	disclosureText: string | null;
}

export interface AccountExport {
	id: string;
	status: "pending" | "running" | "ready" | "failed";
	size: number | null;
	error: string | null;
	createdAt: number;
	completedAt: number | null;
	expiresAt: number;
	downloadUrl: string | null;
}

export interface AccountDeletionState {
	pending: boolean;
	requestedAt?: number;
	purgeAfter?: number;
}

const json = (method: string, body?: unknown): RequestInit => ({
	method,
	body: body === undefined ? undefined : JSON.stringify(body),
});

export const privacyKeys = {
	tracking: (mailboxId: string) => ["privacy", "tracking", mailboxId] as const,
	settings: ["privacy", "settings"] as const,
	exports: ["privacy", "exports"] as const,
	deletion: ["privacy", "deletion"] as const,
};

const mb = (id: string) => `/api/v1/mailboxes/${encodeURIComponent(id)}`;

export function useTrackingSettings(mailboxId: string | undefined) {
	return useQuery({
		queryKey: privacyKeys.tracking(mailboxId ?? ""),
		queryFn: ({ signal }) =>
			request<TrackingSettings>(`${mb(mailboxId!)}/settings/tracking`, { signal }),
		enabled: !!mailboxId,
	});
}

export function useUpdateTrackingSettings(mailboxId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (patch: Partial<TrackingSettings>) =>
			request<TrackingSettings>(`${mb(mailboxId)}/settings/tracking`, json("PATCH", patch)),
		onSuccess: (data) => qc.setQueryData(privacyKeys.tracking(mailboxId), data),
	});
}

export function usePrivacySettings(enabled = true) {
	return useQuery({
		queryKey: privacyKeys.settings,
		queryFn: ({ signal }) => request<PrivacySettings>("/api/v1/privacy", { signal }),
		enabled,
	});
}

export function useUpdatePrivacySettings() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (patch: PrivacySettingsInput) =>
			request<PrivacySettings>("/api/v1/privacy", json("PUT", patch)),
		onSuccess: (data) => qc.setQueryData(privacyKeys.settings, data),
	});
}

export function useAccountExports(enabled = true) {
	return useQuery({
		queryKey: privacyKeys.exports,
		queryFn: ({ signal }) =>
			request<{ exports: AccountExport[] }>("/api/v1/account/exports", { signal }).then((r) => r.exports),
		enabled,
		// Poll while something is being built.
		refetchInterval: (query) =>
			(query.state.data ?? []).some((e) => e.status === "pending" || e.status === "running") ? 5000 : false,
	});
}

export function useStartAccountExport() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => request<AccountExport>("/api/v1/account/exports", json("POST", {})),
		onSuccess: () => qc.invalidateQueries({ queryKey: privacyKeys.exports }),
	});
}

export function useAccountDeletion(enabled = true) {
	return useQuery({
		queryKey: privacyKeys.deletion,
		queryFn: ({ signal }) => request<AccountDeletionState>("/api/v1/account/deletion", { signal }),
		enabled,
	});
}

export function useDeleteAccount() {
	return useMutation({
		mutationFn: () =>
			request<{ status: string; purgeAfter: number; mailboxes: string[] }>("/api/v1/account", json("DELETE")),
	});
}

export function useCancelAccountDeletion() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => request<{ status: string }>("/api/v1/account/deletion/cancel", json("POST", {})),
		onSuccess: () => qc.invalidateQueries({ queryKey: privacyKeys.deletion }),
	});
}
