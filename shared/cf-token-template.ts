// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The "Create token" link for Settings → Cloudflare connection: the
 * dashboard's account-owned API token form, prefilled with every permission
 * this app uses. Pure, so the worker and the UI build the same URL.
 *
 * Account-token URLs accept permission group IDs as `key`. The IDs below were
 * read from the live `/accounts/{id}/tokens/permission_groups` API on
 * 2026-10-29. Write groups map to `type: "edit"`, Read groups to `"read"`.
 */

export interface CfPermissionGroup {
	id: string;
	name: string;
	type: "read" | "edit";
	/** One line: what the app does with it. */
	why: string;
}

export const CF_TOKEN_PERMISSION_GROUPS: readonly CfPermissionGroup[] = [
	{ id: "c8fed203ed3043cba015a93ad1616f1f", name: "Zone Read", type: "read", why: "List your zones." },
	{ id: "4755a26eedb94da69e1066d98aa820be", name: "DNS Write", type: "edit", why: "Add DMARC and SPF records; replace MX only when you confirm." },
	{ id: "3030687196b94b638145a3953da2b699", name: "Zone Settings Write", type: "edit", why: "Turn on Email Routing." },
	{ id: "79b3ec0d10ce4148a8f8bdc0cc5f97f2", name: "Email Routing Rules Write", type: "edit", why: "Point the catch-all at this app." },
	{ id: "5272e56105d04b5897466995b9bd4643", name: "Email Routing Addresses Read", type: "read", why: "Read forwarding destinations." },
	{ id: "5df633d6b41c42bcaf5b4a62b9d14b64", name: "Email Sending Write", type: "edit", why: "Set up sending domains." },
	{ id: "9c88f9c5bce24ce7af9a958ba9c504db", name: "Analytics Read", type: "read", why: "Zone email analytics." },
	{ id: "b89a480218d04ceb98b4fe57ca29dc1f", name: "Account Analytics Read", type: "read", why: "Account email analytics and usage." },
	{ id: "1047880d37b649b49db4a504a245896f", name: "Email Security DMARC Reports Read", type: "read", why: "DMARC reports." },
	{ id: "64156ba5be47441096c83c7fc17c488b", name: "Vectorize Write", type: "edit", why: "Semantic search index." },
	{ id: "1a71c399035b4950a1bd1466bbe4f420", name: "Workers Scripts Read", type: "read", why: "Check the catch-all target Worker exists." },
	{ id: "c1fde68c7bcc44588cbb6ddbc16d6480", name: "Account Settings Read", type: "read", why: "Find the account id and name." },
];

export const CF_TOKEN_DEFAULT_NAME = "cloudmail";

/**
 * `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=…&name=…`.
 * With `accountId` the dashboard skips its account picker.
 */
export function cfTokenTemplateUrl(options: { name?: string; accountId?: string | null } = {}): string {
	const account = options.accountId && /^[a-f0-9]{32}$/i.test(options.accountId) ? options.accountId : ":account";
	const keys = CF_TOKEN_PERMISSION_GROUPS.map((g) => ({ key: g.id, type: g.type }));
	const name = options.name?.trim() || CF_TOKEN_DEFAULT_NAME;
	return (
		`https://dash.cloudflare.com/?to=/${account}/api-tokens` +
		`&permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}` +
		`&name=${encodeURIComponent(name)}`
	);
}
