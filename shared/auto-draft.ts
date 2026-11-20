// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { automatedMailReason } from "./auto-reply";
import { isDaemonAddress, isDeliveryStatusNotification } from "./dsn";
import { Folders } from "./folders";

/**
 * Whether the agent should draft a reply to mail arriving in a mailbox.
 *
 * Auto-draft is opt-*out*, per mailbox. Only an explicit `false` disables it,
 * so mailboxes created before the setting existed — and any whose settings
 * object is missing or unreadable — keep drafting as they always did.
 *
 * This rule is applied in two places that must not drift: the inbound email
 * handler decides whether to trigger the agent, and the settings UI decides
 * which position to show the switch in. A mismatch would show a switch that
 * disagrees with what the mailbox actually does.
 */
export function isAutoDraftEnabled(
	settings: { autoDraft?: { enabled?: boolean } } | null | undefined,
): boolean {
	return settings?.autoDraft?.enabled !== false;
}

/**
 * Apply an auto-draft toggle to a settings object held in memory.
 *
 * This exists for the optimistic cache update in `useSetAutoDraft`, which has to
 * produce a whole settings object for the row to re-render from. It is no longer
 * what gets sent: `PUT /api/v1/mailboxes/:id` merges a partial patch server-side,
 * so the toggle sends `autoDraft` alone. Building the full object client-side and
 * sending that is what let two concurrent saves each revert the other's field.
 *
 * Unrecognised keys are still carried through untouched, so an optimistic update
 * cannot drop a field the running client does not know about before the refetch
 * replaces it.
 */
export function buildAutoDraftSettings<
	T extends { autoDraft?: { enabled?: boolean } },
>(settings: T | null | undefined, enabled: boolean): T & { autoDraft: { enabled: boolean } } {
	return {
		...((settings ?? {}) as T),
		autoDraft: { ...settings?.autoDraft, enabled },
	};
}


export type AutoDraftSkipReason =
	| "spam"
	| "dsn"
	| "automated"
	| "bulk"
	| "mailing_list"
	| "no_reply_sender";

export interface AutoDraftMailInput {
	/** Header values keyed by lowercased header name. */
	headers: Record<string, string | undefined>;
	/** Bare, lowercased `From` address. */
	sender: string;
	/** SMTP envelope sender, when known. */
	envelopeSender?: string | null;
	/** MIME types of non-body parts, for `message/delivery-status`. */
	contentTypes?: string[];
	/** Folder the message was filed to. */
	folder?: string;
}

/** Local parts beyond the DSN daemons that say "nobody reads replies here". */
const NO_REPLY_LOCAL = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|mailer[-_.]?daemon|postmaster)(?:[-+_.].*)?$/i;

/**
 * Why the agent should not draft a reply to this inbound message, or null when
 * it should.
 *
 * Reuses the vacation responder's header checks and the bounce detector, so the
 * agent and the responder agree on what a robot is. A drafted reply to an alert
 * or a newsletter is a model call spent on a draft nobody sends.
 */
export function autoDraftSkipReason(
	input: AutoDraftMailInput,
): AutoDraftSkipReason | null {
	if (input.folder === Folders.SPAM) return "spam";

	if (
		isDeliveryStatusNotification({
			headers: input.headers,
			sender: input.sender,
			envelopeSender: input.envelopeSender,
			contentTypes: input.contentTypes,
		})
	) {
		return "dsn";
	}

	const keys = Object.keys(input.headers);
	const lookup = (key: string) => {
		const wanted = key.toLowerCase();
		for (const k of keys) if (k.toLowerCase() === wanted) return input.headers[k];
		return undefined;
	};
	const automated = automatedMailReason(keys, lookup, { ignoreSuppressHeader: true });
	if (automated) return automated;

	const sender = input.sender.trim().toLowerCase();
	const local = sender.split("@")[0] ?? "";
	if (isDaemonAddress(sender) || NO_REPLY_LOCAL.test(local)) {
		return "no_reply_sender";
	}
	return null;
}
