// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Inbound filter rules and muted conversations.
 *
 * Both live in the mailbox Durable Object and both change how future mail is
 * filed, so a change here invalidates the message lists as well as its own
 * cache — a new rule does not retroactively move mail, but muting a thread does
 * change what the current list should show.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Rule, RuleAction, RuleCondition } from "shared/rules";
import api from "~/services/api";
import { queryKeys } from "./keys";

export interface RuleInput {
	name: string;
	enabled?: boolean;
	match_type?: "all" | "any";
	conditions: RuleCondition[];
	actions: RuleAction[];
	stop_processing?: boolean;
}

export function useRules(mailboxId: string | undefined) {
	return useQuery<Rule[]>({
		queryKey: mailboxId
			? queryKeys.rules.list(mailboxId)
			: ["rules", "_disabled"],
		queryFn: () => api.listRules(mailboxId!),
		enabled: !!mailboxId,
	});
}

function useInvalidateRules() {
	const qc = useQueryClient();
	return (mailboxId: string) =>
		qc.invalidateQueries({ queryKey: queryKeys.rules.list(mailboxId) });
}

export function useCreateRule() {
	const invalidate = useInvalidateRules();
	return useMutation({
		mutationFn: ({
			mailboxId,
			rule,
		}: { mailboxId: string; rule: RuleInput }) => api.createRule(mailboxId, rule),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useUpdateRule() {
	const invalidate = useInvalidateRules();
	return useMutation({
		mutationFn: ({
			mailboxId,
			ruleId,
			patch,
		}: {
			mailboxId: string;
			ruleId: string;
			patch: Partial<RuleInput>;
		}) => api.updateRule(mailboxId, ruleId, patch),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useDeleteRule() {
	const invalidate = useInvalidateRules();
	return useMutation({
		mutationFn: ({ mailboxId, ruleId }: { mailboxId: string; ruleId: string }) =>
			api.deleteRule(mailboxId, ruleId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

/** Takes the whole id sequence, so reordering is one request. */
export function useReorderRules() {
	const invalidate = useInvalidateRules();
	return useMutation({
		mutationFn: ({ mailboxId, ids }: { mailboxId: string; ids: string[] }) =>
			api.reorderRules(mailboxId, ids),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

// ── Muted conversations ────────────────────────────────────────────

export function useMutedThreads(mailboxId: string | undefined) {
	return useQuery<string[]>({
		queryKey: mailboxId
			? queryKeys.mutedThreads.list(mailboxId)
			: ["muted-threads", "_disabled"],
		queryFn: () => api.listMutedThreads(mailboxId!),
		enabled: !!mailboxId,
	});
}

/**
 * Mute or unmute a conversation.
 *
 * Also invalidates the message lists: muting archives the replies that arrive
 * later, and the folder counts shift with it.
 */
export function useSetThreadMuted() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			threadId,
			muted,
		}: { mailboxId: string; threadId: string; muted: boolean }) =>
			muted
				? api.muteThread(mailboxId, threadId)
				: api.unmuteThread(mailboxId, threadId),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.mutedThreads.list(mailboxId) });
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
		},
	});
}
