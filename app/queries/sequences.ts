// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Sequences and their enrollments.
 *
 * Sequences live in R2 and are shared across mailboxes, so like templates they
 * are not scoped by mailbox.
 *
 * These hooks exist because the sequence screens previously called `api`
 * directly from `useState`/`useEffect`, which left them outside the query cache:
 * enrolling a contact could not invalidate the enrollment list, so the UI showed
 * stale data until a manual reload.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, {
	type EnrollmentWithDetails,
	type Sequence,
	type SequenceStep,
} from "~/services/api";

const SEQUENCES_KEY = ["sequences"] as const;

const keys = {
	list: () => SEQUENCES_KEY,
	detail: (id: string) => [...SEQUENCES_KEY, id] as const,
	enrollments: (id: string) => [...SEQUENCES_KEY, id, "enrollments"] as const,
};

export function useSequences() {
	return useQuery<Sequence[]>({
		queryKey: keys.list(),
		queryFn: ({ signal }) => api.listSequences({ signal }),
	});
}

export function useSequence(id: string | undefined) {
	return useQuery<Sequence>({
		queryKey: id ? keys.detail(id) : [...SEQUENCES_KEY, "_disabled"],
		queryFn: () => api.getSequence(id!),
		enabled: !!id,
	});
}

export function useSequenceEnrollments(id: string | undefined) {
	return useQuery<EnrollmentWithDetails[]>({
		queryKey: id ? keys.enrollments(id) : [...SEQUENCES_KEY, "_disabled_enr"],
		queryFn: () => api.listSequenceEnrollments(id!),
		enabled: !!id,
	});
}

export function useCreateSequence() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: { name: string; steps: SequenceStep[] }) =>
			api.createSequence(data),
		onSuccess: () => qc.invalidateQueries({ queryKey: keys.list() }),
	});
}

export function useUpdateSequence() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			data,
		}: { id: string; data: { name?: string; steps?: SequenceStep[] } }) =>
			api.updateSequence(id, data),
		// Invalidate the whole subtree: the step list feeds the enrollment
		// progress counts, so a step change makes those stale too.
		onSuccess: (_data, { id }) => {
			qc.invalidateQueries({ queryKey: keys.detail(id) });
			qc.invalidateQueries({ queryKey: keys.list() });
		},
	});
}

export function useDeleteSequence() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteSequence(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: keys.list() }),
	});
}

/**
 * Enrol a contact, scheduling one message per step.
 *
 * The steps are dispatched by the cron tick in `workers/app.ts`; nothing is sent
 * synchronously here.
 */
export function useEnrollInSequence() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			sequenceId,
			...data
		}: {
			sequenceId: string;
			personId: string;
			personEmail: string;
			personName?: string | null;
			fromAddress: string;
			variables?: Record<string, string>;
		}) => api.enrollInSequence(sequenceId, data),
		onSuccess: (_data, { sequenceId }) =>
			qc.invalidateQueries({ queryKey: keys.enrollments(sequenceId) }),
	});
}

export function useCancelEnrollment() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			enrollmentId,
		}: { enrollmentId: string; sequenceId: string }) =>
			api.cancelEnrollment(enrollmentId),
		onSuccess: (_data, { sequenceId }) =>
			qc.invalidateQueries({ queryKey: keys.enrollments(sequenceId) }),
	});
}
