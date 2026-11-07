// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Dispatch due sequence emails.
 *
 * This is what was missing for the sequences feature to do anything at all.
 * Enrolling a contact wrote a row per step with `status: "pending"` and a
 * `scheduledAt`, and nothing ever read them back: `getPendingEmails` and
 * `markEmailSent` had no callers, `renderTemplate` was never invoked
 * server-side, and there was no cron trigger or `scheduled()` handler. Every
 * enrollment sat pending forever, so a user could build a sequence, enrol
 * someone, watch the UI report it as active, and no mail would ever go out.
 *
 * Called from the `scheduled()` handler in `workers/app.ts`.
 */

import { trackOutgoingHtml, trackingBaseUrl, type TrackingStub } from "./tracking-send";
import { trackingOptOutStore } from "./tracking-opt-outs";
import { Folders } from "../../shared/folders";
import { sendEmail } from "../email-sender";
import {
	generateMessageId,
	recordDelivery,
	type DeliveryRecorder,
} from "./email-helpers";
import * as sequences from "./sequences";
import * as templates from "./templates";
import { productTemplateVariables } from "./products";
import { findBlockingSuppressions, handleHardBounce, suppressionStore } from "./suppressions";
import { bulkCompliance } from "./send-compliance";
import { PreSendRefusedError, preSend } from "./pre-send";
import { backgroundLocked } from "./licence";
import { isRecipientSuppressedError } from "../../shared/suppressions";
import type { Env } from "../types";

/**
 * Cap on how many sequence emails one tick will send.
 *
 * A cron invocation has a wall-clock budget, and each send is a subrequest plus
 * several R2 round trips. Draining an unbounded backlog in one tick risks the
 * whole batch being cut off partway with no record of how far it got; a cap
 * means the tail is simply picked up by the next tick, still in `scheduledAt`
 * order. Overdue mail goes out a minute late rather than not at all.
 */
export const SEQUENCE_BATCH_LIMIT = 25;

export interface DispatchResult {
	/** Messages handed to the mail service. */
	sent: number;
	/** Messages skipped because their enrollment or template no longer resolves. */
	skipped: number;
	/**
	 * Messages not sent because the recipient is suppressed. The enrollment is
	 * cancelled, so the rest of the sequence stops too.
	 */
	suppressed: number;
	/** Messages whose send threw. They stay pending and are retried next tick. */
	failed: number;
}

/**
 * Substitution values available to every sequence template.
 *
 * The enrollment's own `variables` win over these, so a sequence can override
 * `name` with something more specific than the contact record holds. `email` is
 * not overridable in practice because it is also the recipient, but it is merged
 * the same way for consistency.
 */
function buildVariables(
	enrollment: sequences.SequenceEnrollment,
): Record<string, string> {
	return {
		name: enrollment.personName || enrollment.personEmail.split("@")[0] || "",
		email: enrollment.personEmail,
		...enrollment.variables,
	};
}

/**
 * Send every sequence email that is due.
 *
 * Each message is handled independently and failures are counted rather than
 * thrown: one contact with a bad template must not stop the rest of the batch,
 * and the cron handler has nowhere useful to surface an exception to.
 *
 * A send that throws leaves the row `pending`, so the next tick retries it.
 * That makes the delivery guarantee at-least-once: a message that is delivered
 * but fails before being marked sent will go out twice. The alternative —
 * marking sent first — drops mail silently on failure, which is worse for a
 * drip campaign where the recipient is expecting a sequence.
 */
export async function dispatchDueSequenceEmails(
	env: Env,
	options: { limit?: number } = {},
): Promise<DispatchResult> {
	const limit = options.limit ?? SEQUENCE_BATCH_LIMIT;
	const result: DispatchResult = { sent: 0, skipped: 0, suppressed: 0, failed: 0 };

	// Licence locked: every step stays pending and goes out on the first tick
	// after activation. Checked before reading anything, so a locked
	// deployment's cron does no work here.
	if (await backgroundLocked(env)) return result;

	const due = await sequences.getPendingEmails(env.BUCKET);
	if (due.length === 0) return result;

	// `getPendingEmails` already sorts by scheduledAt ascending, so slicing takes
	// the most overdue first.
	for (const pending of due.slice(0, limit)) {
		try {
			const outcome = await dispatchOne(env, pending);
			if (outcome === "sent") result.sent += 1;
			else if (outcome === "suppressed") result.suppressed += 1;
			else result.skipped += 1;
		} catch (e) {
			result.failed += 1;
			console.error(
				`sequence dispatch: failed to send ${pending.id} (step ${pending.stepOrder})`,
				(e as Error).message,
			);
		}
	}

	return result;
}

async function dispatchOne(
	env: Env,
	pending: sequences.SequenceEmail,
): Promise<"sent" | "skipped" | "suppressed"> {
	const enrollment = await sequences.getEnrollment(
		env.BUCKET,
		pending.enrollmentId,
	);

	// A cancelled enrollment should already have cancelled its pending emails, but
	// re-check rather than trust it: cancellation writes one object per step, and a
	// partial failure there would otherwise keep sending a sequence the user
	// explicitly stopped.
	if (!enrollment || enrollment.status !== "active") {
		await sequences.cancelScheduledEmail(env.BUCKET, pending.id);
		return "skipped";
	}

	const template = await templates.getTemplate(env.BUCKET, pending.templateSlug);
	if (!template) {
		// The template was deleted after enrollment. Cancel this step rather than
		// retrying forever, and leave the rest of the sequence alone — later steps
		// may use templates that still exist.
		console.error(
			`sequence dispatch: template "${pending.templateSlug}" missing for ${pending.id}, cancelling step`,
		);
		await sequences.cancelScheduledEmail(env.BUCKET, pending.id);
		return "skipped";
	}

	const fromAddress = enrollment.fromAddress.toLowerCase();
	const recipient = enrollment.personEmail.toLowerCase();

	/**
	 * Suppression check, before anything is written to Sent.
	 *
	 * A sequence is the archetypal non-transactional send, so a suppressed
	 * recipient stops the whole enrollment rather than just this step: the next
	 * step would hit the same entry, and an unsubscribe means "stop", not "skip
	 * one".
	 */
	const blocked = await findBlockingSuppressions(
		suppressionStore(env),
		[recipient],
		fromAddress,
	);
	if (blocked.has(recipient)) {
		console.log(
			`sequence dispatch: ${recipient} is suppressed (${blocked.get(recipient)!.reason}); cancelling enrollment ${enrollment.id}`,
		);
		await sequences.cancelEnrollment(env.BUCKET, enrollment.id);
		return "suppressed";
	}

	/**
	 * RFC 8058 one-click unsubscribe plus `List-Id` (`<sequence-slug>.<domain>`).
	 * The signed link goes in the headers and, unless turned off, a small footer;
	 * a template can position the link itself with `{{unsubscribe_url}}`. A link
	 * that cannot be built leaves the step going out without it rather than not
	 * at all.
	 */
	// Product branding first, so the enrollment's own values win on a clash.
	const variables = { ...(await productTemplateVariables(env, fromAddress)), ...buildVariables(enrollment) };
	// Never left to `{{...}}` substitution with caller-controlled variables: the
	// link in the body must be the signed one.
	delete variables.unsubscribe_url;
	const rendered = templates.renderTemplate(template, variables);
	const sequence = await sequences.getSequence(env.BUCKET, enrollment.sequenceId).catch(() => null);
	const compliance = await bulkCompliance(env, {
		recipient,
		fromAddress,
		listSlug: sequence?.name || enrollment.sequenceId,
		listName: sequence?.name ?? null,
		html: rendered.bodyHtml,
	});
	const html = compliance.html ?? rendered.bodyHtml;
	const headers = compliance.headers;

	/**
	 * The shared gate: caps, the spam-rate breaker and provider limits (the
	 * suppression check above already cancelled a suppressed enrollment). A
	 * paused domain or a cap leaves the step pending for a later tick: nothing
	 * is wrong with the step, the domain is just not allowed to send bulk now.
	 */
	const gate = await preSend(env, { kind: "bulk", from: fromAddress, mailboxId: fromAddress, to: recipient, html, headers });
	if (!gate.ok) {
		if (gate.code === "bulk_paused" || gate.code === "rate_limited") {
			console.log(`sequence dispatch: deferring ${pending.id}: ${gate.error}`);
			return "skipped";
		}
		if (gate.code === "all_suppressed") {
			await sequences.cancelEnrollment(env.BUCKET, enrollment.id);
			return "suppressed";
		}
		throw new PreSendRefusedError(gate);
	}

	const fromDomain = fromAddress.split("@")[1] ?? "";
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const now = new Date().toISOString();

	// Record the sent copy before handing the message to the mail service, so a
	// delivery the user can see in Sent is never missing from their own mailbox.
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(fromAddress));
	await (stub as any).createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: rendered.subject,
			sender: fromAddress,
			recipient: enrollment.personEmail.toLowerCase(),
			date: now,
			body: html,
			message_id: outgoingMessageId,
			delivery_status: "queued",
			// Each step is its own conversation: sequence steps are independent
			// messages, not replies to one another.
			thread_id: messageId,
			raw_headers: JSON.stringify([
				{ key: "from", value: fromAddress },
				{ key: "to", value: enrollment.personEmail },
				{ key: "subject", value: rendered.subject },
				{ key: "date", value: now },
				// No `message-id`: this row is written BEFORE the send, and
				// `recordDelivery` writes the provider's real id to the `message_id`
				// COLUMN afterwards. An entry here would outrank that column in the
				// `.eml`/mbox exporters and advertise an id that was never sent.
			]),
		},
		[],
	);

	// Cron has no request, so the tracking origin is the deployment origin
	// (none known: sent untracked). The Sent
	// row above keeps the clean `html`.
	const outgoingHtml = await trackOutgoingHtml({
		stub: stub as unknown as TrackingStub,
		mailboxId: fromAddress,
		emailId: messageId,
		html,
		baseUrl: await trackingBaseUrl(env),
		to: recipient,
		optOuts: trackingOptOutStore(env),
		fromAddress,
	});

	let providerMessageId: string;
	try {
		({ messageId: providerMessageId } = await sendEmail(env.EMAIL, {
			to: enrollment.personEmail,
			from: fromAddress,
			subject: rendered.subject,
			html: outgoingHtml ?? html,
			// Each step is its own conversation, so there is no threading ancestor.
			// The only headers are the unsubscribe pair and List-Id, all on Email
			// Service's allowlist. `Message-ID` used to be set here; Email Service
			// refuses it.
			...(Object.keys(headers).length > 0 ? { headers } : {}),
		}, gate.clearance));
	} catch (e) {
		// The Sent row already exists; without this it would sit at `queued`
		// forever. `describeSendError` maps the code to the stored reason.
		await recordDelivery(stub as unknown as DeliveryRecorder, messageId, { thrown: e });
		/**
		 * The platform's own suppression list refused the recipient. Retrying
		 * would fail identically every tick, so record it locally and stop the
		 * sequence instead of leaving the step pending forever.
		 */
		if (isRecipientSuppressedError(e)) {
			await handleHardBounce(env, {
				address: recipient,
				source: "provider:E_RECIPIENT_SUPPRESSED",
			});
			return "suppressed";
		}
		// Rethrown so the dispatcher still counts and logs the failure.
		throw e;
	}

	// This path stores the row BEFORE sending (so a delivery is never missing from
	// Sent), so the provider's id has to be written back afterwards. Without it the
	// row keeps a locally-minted id that exists nowhere outside our database, and a
	// reply citing the real id misses `findThreadByMessageIds`.
	await recordDelivery(stub as unknown as DeliveryRecorder, messageId, {
		providerMessageId,
	});

	// Marking sent also completes the enrollment once every step has gone out.
	await sequences.markEmailSent(env.BUCKET, pending.id, messageId);
	return "sent";
}
