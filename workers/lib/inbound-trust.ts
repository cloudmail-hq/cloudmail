// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * What `receiveEmail` knows about whether to believe a message's sender.
 *
 * Gathered once per delivery and shared by the spam score, the stored reader
 * warnings, and the three things the app does on a sender's say-so:
 *
 * - Unsubscribe-by-email (`inbound-compliance.ts`) needs the From domain to be
 *   *authenticated*: DMARC pass, or an SPF/DKIM pass aligned with From. Without
 *   that, anyone could send "unsubscribe" as a third party and suppress them.
 * - Auto-reply needs the same. Replying to a forged From is backscatter: it
 *   mails an innocent third party on a spammer's behalf.
 * - Forwarding refuses mail whose authentication *failed* (DMARC fail, or SPF
 *   and DKIM both failing). Mail with no verdict is still forwarded, since
 *   Email Routing has already rejected the outright failures upstream.
 *
 * About the Routing verdict: Cloudflare Email Routing rejects mail that fails
 * both SPF and DKIM, and enforces a sender's DMARC `p=reject`, before the Worker
 * runs. The `email()` event exposes no verdict field (only `from`, `to`, `raw`,
 * `headers`, `rawSize`), so the Authentication-Results header Routing stamps,
 * read through the authserv-id allowlist, is the only verdict available.
 */

import {
	didAuthenticationFail,
	extractAuthenticationResults,
	isSenderAuthenticated,
	type AuthenticationResults,
} from "../../shared/auth-results";
import { sameOrganization } from "../../shared/domain-safety";
import {
	assessSenderWarnings,
	normalizeDisplayName,
	type SenderWarning,
} from "../../shared/sender-warnings";

export interface InboundTrust {
	/** Trusted verdicts from our own MX, or null. */
	auth: AuthenticationResults | null;
	/** The visible From domain is authenticated (DMARC or aligned SPF/DKIM). */
	authenticated: boolean;
	/** Authentication positively failed. */
	failed: boolean;
}

export function assessInboundTrust(
	headers: readonly { key?: string; value?: string }[] | undefined,
	fromAddress: string,
): InboundTrust {
	const auth = extractAuthenticationResults(JSON.stringify(headers ?? []));
	return {
		auth,
		authenticated: isSenderAuthenticated(auth, fromAddress, sameOrganization),
		failed: didAuthenticationFail(auth),
	};
}

export interface WarningContextSources {
	mailboxId: string;
	/** Display name this mailbox sends under. */
	mailboxName?: string | null;
	/** Every mailbox address on the deployment. */
	localMailboxes: readonly string[];
	/** Every domain the deployment serves. */
	ownDomains: readonly string[];
	frequent: readonly { address: string; name: string | null }[];
}

/** Known display names → the addresses entitled to them. */
export function buildKnownNames(src: WarningContextSources): Map<string, string[]> {
	const names = new Map<string, string[]>();
	const add = (name: string | null | undefined, address: string) => {
		const key = normalizeDisplayName(name ?? "");
		if (key.length < 3) return;
		const list = names.get(key) ?? [];
		if (!list.includes(address.toLowerCase())) list.push(address.toLowerCase());
		names.set(key, list);
	};
	if (src.mailboxName) add(src.mailboxName, src.mailboxId);
	for (const c of src.frequent) add(c.name, c.address);
	return names;
}

export function computeSenderWarnings(input: {
	from: string;
	fromName: string | null | undefined;
	html: string | null | undefined;
	hasHistory: boolean;
	inKnownThread: boolean;
	sources: WarningContextSources;
}): SenderWarning[] {
	const { sources } = input;
	const frequentDomains = [
		...new Set(
			sources.frequent
				.map((c) => c.address.slice(c.address.lastIndexOf("@") + 1).toLowerCase())
				.filter(Boolean),
		),
	];
	return assessSenderWarnings({
		from: input.from,
		fromName: input.fromName,
		html: input.html,
		ownDomains: sources.ownDomains,
		ownMailboxes: sources.localMailboxes,
		knownNames: buildKnownNames(sources),
		frequentDomains,
		hasHistory: input.hasHistory,
		inKnownThread: input.inKnownThread,
	});
}
