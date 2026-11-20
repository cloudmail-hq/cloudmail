// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { dismissToast, errorMessage, showToast } from "~/lib/toast";
import { usePreferenceValues } from "~/queries/preferences";
import {
	useCancelScheduledSend,
	useScheduleEmail,
	useSendEmail,
	useSendScheduledNow,
} from "~/queries/scheduled-sends";

/**
 * The window used when preferences have not been read yet.
 *
 * Long enough to notice a mistake, short enough that mail doesn't feel stuck. The
 * live value comes from `preferences.sending.undoWindowSeconds`; this remains the
 * default that record is created with, and the fallback on the first paint before
 * the request lands.
 */
export const UNDO_SEND_WINDOW_SECONDS = 30;

/**
 * The floor on a configured window, mirrored from `workers/lib/preferences.ts`.
 *
 * Below this a toast cannot realistically be read and clicked, so a shorter value
 * would advertise a safety net that does not exist. Zero is expressed by turning
 * the feature off, not by shrinking the window to nothing.
 */
export const MIN_UNDO_WINDOW_SECONDS = 5;

interface SendWithUndoArgs {
	mailboxId: string;
	/** Same shape as a normal send body: to/cc/bcc/from/subject/html/text/… */
	email: Record<string, unknown>;
	/**
	 * The message being answered or forwarded, if any. Passed to the server so it
	 * can rebuild the `References` chain from the original's ancestry — which the
	 * client doesn't have.
	 */
	replyToEmailId?: string;
	/** Only a reply marks the thread read; a forward does not. */
	threadedMode?: "reply" | "forward";
	/**
	 * The draft this send was composed from, if any.
	 *
	 * Handed to the server so the row goes as part of accepting the send, rather
	 * than in a follow-up `DELETE …?permanent=1` from here. That follow-up made
	 * sending a draft require `deletePermanently` — which the `agent` preset does
	 * not hold — so the send was accepted and then reported as failed, and the
	 * obvious response was to press Send again and queue a second copy.
	 */
	supersedesDraftId?: string;
}

/**
 * Send a message, with an undo window when the user wants one.
 *
 * With the delay on, the message is queued and a toast offers to pull it back.
 * The wait happens server-side — the message sits in the Scheduled folder until a
 * Durable Object alarm delivers it — so the window survives closing the tab, and
 * cancelling drops the message into Drafts instead of discarding what the user
 * wrote.
 *
 * With the delay off (`preferences.sending.undoWindowEnabled === false`) the
 * message is handed straight to `POST …/emails` and delivered immediately. The
 * delay used to be unconditional, so someone who found the wait more annoying
 * than useful had no way out of it.
 *
 * Shared by the compose form and the "send draft" action in the email panel so
 * the two can't drift into offering undo in only one place.
 */
export function useSendWithUndo() {
	const scheduleEmail = useScheduleEmail();
	const cancelScheduled = useCancelScheduledSend();
	const sendNow = useSendScheduledNow();
	const sendImmediately = useSendEmail();
	const { sending } = usePreferenceValues();

	/**
	 * The toast is the only way to reach Undo, so it has to outlive the default
	 * dismiss delay — otherwise the button vanishes while the send is still
	 * cancellable.
	 *
	 * It carries Send now beside Undo because the wait applies to messages the
	 * user is certain about too. Without a way out of the front of the window the
	 * only remedy for "go, now" is to watch the countdown, and the message looks
	 * stuck.
	 *
	 * `windowSeconds` is passed in rather than read here so the countdown the user
	 * reads and the delay the server was actually given come from one value. Two
	 * independent reads could disagree — the toast promising 30s over a 10s
	 * schedule would offer an Undo that is already too late.
	 */
	const offerUndo = (
		mailboxId: string,
		emailId: string,
		windowSeconds: number,
	) => {
		showToast({
			// Scoped to the queued message so two sends in a row each get their
			// own undo rather than one replacing the other.
			id: `undo-send:${emailId}`,
			message: `Sending in ${windowSeconds}s`,
			durationMs: windowSeconds * 1000,
			action: {
				label: "Undo",
				onClick: (dismiss) =>
					cancelScheduled.mutate(
						{ mailboxId, emailId },
						{
							onSuccess: () => {
								dismiss();
								showToast({
									kind: "success",
									message: "Send undone. Saved to Drafts.",
								});
							},
							// A 409 means delivery already started. Say so rather than
							// letting the user believe they stopped it.
							onError: (err) => {
								dismissToast(`undo-send:${emailId}`);
								showToast({
									kind: "error",
									message: errorMessage(
										err,
										"Too late to undo — the message has gone out.",
									),
								});
							},
						},
					),
			},
			actions: [
				{
					label: "Send now",
					onClick: (dismiss) => {
						/**
						 * Dismissed before the request rather than after it.
						 *
						 * The card's whole purpose is to offer a choice that is still
						 * open, and it stops being open the moment this is clicked. Leaving
						 * Undo on screen during the round trip invites a second click that
						 * can only ever lose the race and report failure.
						 */
						dismiss();
						sendNow.mutate(
							{ mailboxId, emailId },
							{
								onSuccess: () =>
									showToast({ kind: "success", message: "Message sent." }),
								/**
								 * 409 means the alarm delivered it while the click was in
								 * flight — the user got what they asked for, so this is not
								 * worth an error. Anything else is reported: a failed send now
								 * sits in Drafts or is waiting on a retry, and the user needs
								 * to know which.
								 */
								onError: (err) =>
									showToast({
										kind: /already/i.test(errorMessage(err, ""))
											? "success"
											: "error",
										message: /already/i.test(errorMessage(err, ""))
											? "Message sent."
											: errorMessage(err, "Could not send the message."),
									}),
							},
						);
					},
				},
			],
		});
	};

	return async function sendWithUndo({
		mailboxId,
		email,
		replyToEmailId,
		threadedMode,
		supersedesDraftId,
	}: SendWithUndoArgs): Promise<{ id: string }> {
		/**
		 * The threading and draft-supersede fields are identical on both paths, so
		 * they are built once. Only the delivery call differs.
		 */
		const body = {
			...email,
			...(replyToEmailId
				? {
						reply_to_email_id: replyToEmailId,
						threaded_mode: threadedMode ?? "reply",
					}
				: {}),
			...(supersedesDraftId ? { supersedes_draft_id: supersedesDraftId } : {}),
		};

		/**
		 * Delay off: deliver now, and show no undo card.
		 *
		 * Offering one would be a lie — there is no queued row to cancel — and the
		 * user turned the window off precisely to stop seeing it. The success toast
		 * is left to the caller, which already reports a completed send.
		 */
		if (!sending.undoWindowEnabled) {
			return await sendImmediately.mutateAsync({ mailboxId, email: body });
		}

		/**
		 * Read once, then used for both the schedule and the countdown.
		 *
		 * Clamped defensively: the API and the stored schema both bound this, but a
		 * cached record from a build with a different range would otherwise put a
		 * value on the wire that the server rejects — turning a stale preference
		 * into a failed send rather than a slightly wrong countdown.
		 */
		const windowSeconds = Math.max(
			MIN_UNDO_WINDOW_SECONDS,
			sending.undoWindowSeconds || UNDO_SEND_WINDOW_SECONDS,
		);

		const result = await scheduleEmail.mutateAsync({
			mailboxId,
			email: { ...body, delay_seconds: windowSeconds },
		});

		offerUndo(mailboxId, result.id, windowSeconds);
		return result;
	};
}
