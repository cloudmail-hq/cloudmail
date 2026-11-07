// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * AI triage (label prompts, presets, inbox tabs, backfill) and the Screener.
 *
 * Every write here can move mail between folders or change which tab it is
 * in, so each invalidates the email lists, folder counts and labels too.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { TriagePresetKey } from "shared/ai-triage";
import { queryKeys } from "./keys";

function useInvalidateTriage() {
	const qc = useQueryClient();
	return (mailboxId: string) => {
		qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
		qc.invalidateQueries({ queryKey: queryKeys.labels.list(mailboxId) });
		qc.invalidateQueries({ queryKey: queryKeys.allowedSenders.list(mailboxId) });
		qc.invalidateQueries({ queryKey: queryKeys.blockedSenders.list(mailboxId) });
	};
}

export function useLabelPrompts(mailboxId: string | undefined) {
	return useQuery({
		queryKey: queryKeys.triage.prompts(mailboxId ?? ""),
		queryFn: ({ signal }) => api.listLabelPrompts(mailboxId!, { signal }),
		enabled: !!mailboxId,
	});
}

/** The inbox tab bar. Empty until a label is made a tab. */
export function useInboxTabs(mailboxId: string | undefined) {
	return useQuery({
		queryKey: queryKeys.triage.tabs(mailboxId ?? ""),
		queryFn: ({ signal }) => api.listInboxTabs(mailboxId!, { signal }),
		enabled: !!mailboxId,
		select: (data) => data.tabs,
		staleTime: 60_000,
	});
}

export function useScreener(mailboxId: string | undefined) {
	return useQuery({
		queryKey: queryKeys.triage.screener(mailboxId ?? ""),
		queryFn: ({ signal }) => api.listScreener(mailboxId!, { signal }),
		enabled: !!mailboxId,
		select: (data) => data.senders,
	});
}

export function useSetLabelPrompt() {
	const invalidate = useInvalidateTriage();
	return useMutation({
		mutationFn: ({
			mailboxId,
			labelId,
			patch,
		}: {
			mailboxId: string;
			labelId: string;
			patch: { prompt?: string | null; auto_archive?: boolean; show_tab?: boolean };
		}) => api.setLabelPrompt(mailboxId, labelId, patch),
		onSuccess: (_d, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useSetTriagePreset() {
	const invalidate = useInvalidateTriage();
	return useMutation({
		mutationFn: ({
			mailboxId,
			key,
			body,
		}: {
			mailboxId: string;
			key: TriagePresetKey;
			body: { enabled: boolean; auto_archive?: boolean; show_tab?: boolean };
		}) => api.setTriagePreset(mailboxId, key, body),
		onSuccess: (_d, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useBackfillTriage() {
	const invalidate = useInvalidateTriage();
	return useMutation({
		mutationFn: ({ mailboxId }: { mailboxId: string }) => api.backfillTriage(mailboxId),
		onSuccess: (_d, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useScreenSender() {
	const invalidate = useInvalidateTriage();
	return useMutation({
		mutationFn: ({
			mailboxId,
			sender,
			decision,
			target,
		}: {
			mailboxId: string;
			sender: string;
			decision: "allow" | "block";
			target?: "spam" | "trash";
		}) => api.screenSender(mailboxId, sender, decision, target),
		onSuccess: (_d, { mailboxId }) => invalidate(mailboxId),
	});
}
