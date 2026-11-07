// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

/**
 * Scheduled send and Undo Send are the same mechanism at different timescales:
 * the message waits in the Scheduled folder until a Durable Object alarm
 * delivers it, and cancelling before then drops it back into Drafts.
 */

/*
 * Queued messages are listed through the Scheduled folder, where they exist as
 * ordinary email rows, so this module carries only the two mutations. The
 * `/scheduled-sends` list endpoint stays available for API consumers that want
 * the delivery metadata.
 *
 * The undo window itself lives with its only consumer, `hooks/useSendWithUndo`.
 */

/**
 * Both the schedule list and the email lists move when a message is queued or
 * cancelled: it enters or leaves the Scheduled folder as a real email row.
 */
function useInvalidateScheduleData() {
	const qc = useQueryClient();
	return (mailboxId: string) => {
		qc.invalidateQueries({ queryKey: queryKeys.scheduledSends.list(mailboxId) });
		qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
	};
}

/**
 * Queue a message for later delivery.
 *
 * `email` takes the same fields as a normal send plus either `send_at` (ISO) or
 * `delay_seconds`. Undo Send is a short `delay_seconds` — see
 * `hooks/useSendWithUndo`.
 */
export function useScheduleEmail() {
	const invalidate = useInvalidateScheduleData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			email,
		}: {
			mailboxId: string;
			email: Record<string, unknown> &
				({ send_at: string } | { delay_seconds: number });
		}) => api.scheduleEmail(mailboxId, email),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

/**
 * Cancel a pending send. The message lands in Drafts rather than being
 * discarded, so nothing the user wrote is lost.
 *
 * Fails with 409 once delivery has started — the caller should surface that
 * rather than treating it as a silent no-op.
 */
export function useCancelScheduledSend() {
	const invalidate = useInvalidateScheduleData();
	return useMutation({
		mutationFn: ({ mailboxId, emailId }: { mailboxId: string; emailId: string }) =>
			api.cancelScheduledSend(mailboxId, emailId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

/**
 * Send a queued message immediately instead of waiting for its alarm.
 *
 * The opposite of `useCancelScheduledSend` and the other action offered during
 * the undo window. Delivery runs on the server through the same path the alarm
 * uses, so this moves the message from Scheduled to Sent exactly once.
 *
 * Fails with 409 if the alarm got there first, 503 while the mailbox is over its
 * send quota — in which case the message stays queued rather than being lost.
 */
export function useSendScheduledNow() {
	const invalidate = useInvalidateScheduleData();
	return useMutation({
		mutationFn: ({ mailboxId, emailId }: { mailboxId: string; emailId: string }) =>
			api.sendScheduledNow(mailboxId, emailId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

/**
 * Deliver a message straight away, with no queue and no undo window.
 *
 * The path taken when the user has turned the send delay off. It lives beside the
 * scheduled mutations rather than in `queries/emails.ts` because it is the third
 * arm of one decision — queue it, queue-then-flush it, or send it — and splitting
 * them across modules is how the invalidation sets drift apart.
 *
 * Invalidated identically to the queued paths: a message that never enters
 * Scheduled still changes Sent and the folder counts, and the schedule list is
 * cheap to refetch and wrong to leave stale.
 */
export function useSendEmail() {
	const invalidate = useInvalidateScheduleData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			email,
		}: {
			mailboxId: string;
			email: Record<string, unknown>;
		}) => api.sendEmail(mailboxId, email),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}
