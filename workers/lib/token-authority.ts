// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * How `/api/v1/me` describes a caller's effective authority.
 *
 * For a scoped API token the answer has to be the intersection, not the user's
 * grants: a CLI calling `auth can sendAs` with a read-only token must hear "no",
 * or it plans work the token cannot do.
 */

import { accessCapabilities } from "./capabilities";
import { isAdmin, mailboxCapabilities, type Principal } from "./authz";

export interface MailboxCapabilityView {
	mailboxId: string;
	role: string;
	capabilities: string[];
}

export function describeAuthority(principal: Principal): {
	role: "admin" | "member";
	mailboxes: string[] | null;
	capabilities: MailboxCapabilityView[] | null;
	token: { id: string; scopes: string[] | null; mailboxes: string[] | null } | null;
} {
	const token = principal.token ?? null;
	if (!token) {
		return {
			role: principal.role,
			mailboxes: principal.mailboxes,
			capabilities:
				principal.access === null
					? null
					: principal.access.map((entry) => ({
							mailboxId: entry.id,
							role: entry.role,
							capabilities: [...accessCapabilities(entry)],
						})),
			token: null,
		};
	}

	// The mailboxes the token can actually reach: the allowlist, intersected with
	// the user's grants when the user is not unrestricted.
	const reachable =
		principal.mailboxes === null
			? token.mailboxes
			: token.mailboxes === null
				? principal.mailboxes
				: principal.mailboxes.filter((m) => token.mailboxes!.includes(m));

	// A restricted token is never "everything everywhere" (`null`): its scopes are
	// always explicit, so there is always a list to report.
	const capabilities: MailboxCapabilityView[] =
		reachable === null
			? // Every mailbox, narrowed scopes: no per-mailbox list to enumerate, so
				// report one wildcard row. Clients treat `*` as "any mailbox".
				[{ mailboxId: "*", role: "token", capabilities: [...mailboxCapabilities(principal, "*")] }]
			: reachable.map((mailboxId) => {
					const entry = principal.access?.find((a) => a.id === mailboxId);
					return {
						mailboxId,
						role: entry?.role ?? "owner",
						capabilities: [...mailboxCapabilities(principal, mailboxId)],
					};
				});

	return {
		role: isAdmin(principal) ? "admin" : "member",
		mailboxes: reachable,
		capabilities,
		token: { id: token.id, scopes: token.scopes, mailboxes: token.mailboxes },
	};
}
