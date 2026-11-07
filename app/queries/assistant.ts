// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** AI thread summaries, per-user assistant preferences and the daily brief. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { ApiError, type AssistantPrefs, type AssistantPrefsPatch, type BriefState } from "~/services/api";
import { DEFAULT_ASSISTANT_PREFS } from "../../shared/ai-settings";

export const assistantKeys = {
	prefs: ["assistant", "prefs"] as const,
	brief: ["assistant", "brief"] as const,
	aiSettings: ["assistant", "ai-settings"] as const,
	/** Under "emails" so the mailbox-change poller invalidates it with the thread. */
	threadSummary: (mailboxId: string, threadId: string) =>
		["emails", mailboxId, "thread-summary", threadId] as const,
};

/** The reader's summary. Absent until generated; polls briefly while stale. */
export function useThreadSummary(mailboxId: string, threadId: string | null | undefined, enabled = true) {
	return useQuery({
		queryKey: assistantKeys.threadSummary(mailboxId, threadId ?? ""),
		queryFn: ({ signal }) => api.getThreadSummary(mailboxId, threadId!, { signal }).then((r) => r.summary),
		enabled: enabled && !!threadId,
		staleTime: 30_000,
	});
}

export function useRefreshThreadSummary() {
	return useMutation({
		mutationFn: (v: { mailboxId: string; threadId: string }) => api.refreshThreadSummary(v.mailboxId, v.threadId),
	});
}

/** The reader's "Summarize" button: generate now, within the daily cap. */
export function useGenerateThreadSummary() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (v: { mailboxId: string; threadId: string }) => api.generateThreadSummary(v.mailboxId, v.threadId),
		onSuccess: (res, v) => qc.setQueryData(assistantKeys.threadSummary(v.mailboxId, v.threadId), res.summary),
	});
}

/**
 * My assistant preferences. A 409 (no signed-in identity, e.g. local dev with
 * the auth bypass) reads as defaults, so the UI still renders.
 */
export function useAssistantPrefs() {
	return useQuery<AssistantPrefs | null>({
		queryKey: assistantKeys.prefs,
		queryFn: async ({ signal }) => {
			try {
				return await api.getAssistantPrefs({ signal });
			} catch (e) {
				if (e instanceof ApiError && e.status === 409) return null;
				throw e;
			}
		},
		staleTime: Infinity,
		placeholderData: DEFAULT_ASSISTANT_PREFS,
	});
}

export function useAssistantPrefValues(): AssistantPrefs {
	return useAssistantPrefs().data ?? DEFAULT_ASSISTANT_PREFS;
}

export function useUpdateAssistantPrefs() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (patch: AssistantPrefsPatch) => api.updateAssistantPrefs(patch),
		onSuccess: (next) => {
			qc.setQueryData(assistantKeys.prefs, next);
			qc.invalidateQueries({ queryKey: assistantKeys.brief });
		},
	});
}

export function useBrief(enabled = true) {
	return useQuery<BriefState>({
		queryKey: assistantKeys.brief,
		queryFn: ({ signal }) => api.getBrief({ signal }),
		enabled,
		staleTime: 5 * 60_000,
	});
}

export function useGenerateBrief() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.generateBrief(),
		onSuccess: (res) => {
			qc.setQueryData<BriefState>(assistantKeys.brief, (prev) => ({
				nextRunAt: prev?.nextRunAt ?? null,
				brief: res.brief,
				dismissed: false,
			}));
		},
	});
}

export function useDismissBrief() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.dismissBrief(id),
		onMutate: () => {
			qc.setQueryData<BriefState>(assistantKeys.brief, (prev) => (prev ? { ...prev, dismissed: true } : prev));
		},
		onError: () => qc.invalidateQueries({ queryKey: assistantKeys.brief }),
	});
}

export function useAiSettings() {
	return useQuery({
		queryKey: assistantKeys.aiSettings,
		queryFn: ({ signal }) => api.getAiSettings({ signal }),
		staleTime: 60_000,
	});
}

export function useUpdateAiSettings() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.updateAiSettings,
		onSuccess: (next) => qc.setQueryData(assistantKeys.aiSettings, next),
	});
}
