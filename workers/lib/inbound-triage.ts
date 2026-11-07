// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The two places `receiveEmail` touches triage, kept here so the inbound
 * handler only gains a few lines.
 *
 *   - `decideInboundScreening`, before the insert: may divert an Inbox-bound
 *     message from an unknown sender into the Screener.
 *   - `schedulePostIngest`, after the insert and rule labels: the one
 *     background AI pass per message (workers/lib/triage.ts).
 */

import { headerLabelHints, screenerDecision, type TriagePresetKey } from "../../shared/ai-triage";
import { isDeliveryStatusNotification } from "../../shared/dsn";
import { Folders } from "../../shared/folders";
import type { ResolvedMailboxSettings } from "../../shared/mailbox-settings";

export interface ScreeningInput {
	settings: ResolvedMailboxSettings;
	folder: string;
	ruleFiled: boolean;
	senderAllowed: boolean;
	inKnownThread: boolean;
	sender: string;
	localMailboxes: readonly string[];
	headers: readonly { key?: string; value?: string }[];
	contentTypes: string[];
	envelopeSender: string | null;
}

/**
 * The folder an inbound message should be stored in, after the Screener.
 *
 * Only reads `hasSentTo` (one indexed lookup) when the cheaper checks have not
 * already decided. Any failure keeps the message where it was going: a
 * screener bug must not hide mail.
 */
export async function decideInboundScreening(
	stub: {
		hasSentTo(address: string): Promise<boolean> | boolean;
		presetLabelId?(key: TriagePresetKey): Promise<string | null> | string | null;
	},
	input: ScreeningInput,
): Promise<string> {
	try {
		const base = {
			mode: input.settings.screener,
			folder: input.folder,
			ruleFiled: input.ruleFiled,
			senderAllowed: input.senderAllowed,
			inKnownThread: input.inKnownThread,
			sender: input.sender,
			localMailboxes: input.localMailboxes,
		};
		// Settle without the lookup when we can.
		if (!screenerDecision({ ...base, hasSentTo: false }).screen) return input.folder;

		const headerMap: Record<string, string | undefined> = {};
		for (const h of input.headers) if (h.key) headerMap[h.key.toLowerCase()] = h.value;
		const isBounce = isDeliveryStatusNotification({
			headers: headerMap,
			sender: input.sender,
			envelopeSender: input.envelopeSender,
			contentTypes: input.contentTypes,
		});
		const hasSentTo = !!(await stub.hasSentTo(input.sender));

		// Automated mail with a tab to go to skips the Screener.
		let routedByHeuristic = false;
		if (!hasSentTo && !isBounce && input.settings.triage.enabled && stub.presetLabelId) {
			const hints = headerLabelHints({
				sender: input.sender,
				header: (name) => headerMap[name.toLowerCase()],
			});
			for (const hint of hints) {
				if (await stub.presetLabelId(hint)) routedByHeuristic = true;
			}
		}
		const decision = screenerDecision({ ...base, hasSentTo, isBounce, routedByHeuristic });
		if (decision.screen) {
			console.log(`Screening first-time sender ${input.sender}.`);
			return Folders.SCREENER;
		}
	} catch (e) {
		console.error("Screener decision failed; delivering normally:", (e as Error).message);
	}
	return input.folder;
}

/**
 * Queue the post-ingest pass. The mailbox alarm runs it in the same job that
 * drains the summary queue (see `MailboxDO.alarm`). Never throws: a failure
 * costs the labels, not the message.
 */
export function schedulePostIngest(
	ctx: Pick<ExecutionContext, "waitUntil">,
	stub: { enqueueTriage(emailId: string, mailboxId: string): Promise<void> },
	mailboxId: string,
	emailId: string,
	folder: string,
	settings: ResolvedMailboxSettings,
): boolean {
	const screenerVerdict = folder === Folders.SCREENER && settings.triage.screenerVerdict;
	if (!settings.triage.enabled && !screenerVerdict) return false;
	if (folder === Folders.SPAM || folder === Folders.TRASH) return false;
	ctx.waitUntil(
		stub
			.enqueueTriage(emailId, mailboxId)
			.catch((e) => console.error("Queueing triage failed:", (e as Error).message)),
	);
	return true;
}
