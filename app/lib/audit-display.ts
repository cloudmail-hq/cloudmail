// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * How audit entries read in the access logs. Shared by the deployment log and
 * each mailbox's log so the two describe an action the same way.
 */

import type { AuditEntry, AuditFilter } from "~/services/api";

/** Each action as a phrase. An unknown action falls back to its id. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
	"mail.send": "sent mail",
	"mail.delete": "moved mail to Trash",
	"mail.destroy": "destroyed mail",
	"mailbox.settings": "changed mailbox settings",
	"mailbox.create": "created a mailbox",
	"mailbox.delete": "deleted a mailbox",
	"access.grant": "granted access",
	"access.revoke": "revoked access",
	"domain.change": "changed a domain",
	"mailbox.aliases": "changed mailbox aliases",
	"product.change": "changed a product",
	"account.delete": "deleted an account",
	"privacy.settings": "changed the privacy notice",
	"mailbox.tracking": "changed tracking settings",
	"mailbox.send_limits": "changed mailbox send caps",
	"sending.resume": "resumed bulk sending",
	"sending.pause": "paused bulk sending",
	"agent_inbox.create": "created an agent inbox",
	"agent_inbox.expire": "agent inbox expired",
	"agent_inbox.delete": "ended an agent inbox",
	"agent_inbox.update": "changed an agent inbox's recipients",
	"auth.login": "signed in",
	"auth.login_failed": "failed to sign in",
	"auth.logout": "signed out",
	"auth.password_change": "changed their password",
	"auth.password_reset": "reset their password",
	"auth.2fa_enable": "turned on two-factor",
	"auth.2fa_disable": "turned off two-factor",
	"auth.recovery_codes": "made new recovery codes",
	"auth.passkey_add": "added a passkey",
	"auth.passkey_remove": "removed a passkey",
	"auth.session_revoke": "signed out a session",
	"auth.token_create": "created an API token",
	"auth.token_revoke": "revoked an API token",
	"auth.oauth_revoke": "disconnected an app",
	"auth.oauth_send_auto": "changed an app's send permission",
	"agent.write": "changed mail via an agent",
	"agent.send_held": "asked to send (held for approval)",
	"agent.send_revised": "revised a send waiting for approval",
	"agent.send": "sent mail via an agent",
	"agent.send_refused": "was refused a send",
	"approval.approve": "approved a held send",
	"approval.reject": "rejected a held send",
	"mailbox.import": "started a mail import",
	"cloudflare.connect": "connected Cloudflare",
	"cloudflare.disconnect": "disconnected Cloudflare",
	"cloudflare.dns_change": "changed Cloudflare mail settings",
	"cloudflare.revert": "reverted a Cloudflare change",
};

export const AUDIT_CATEGORY_OPTIONS: { id: NonNullable<AuditFilter["category"]> | ""; label: string }[] = [
	{ id: "", label: "Everything" },
	{ id: "security", label: "Sign-ins and security" },
	{ id: "agent", label: "Agents and MCP" },
	{ id: "mail", label: "Mail" },
	{ id: "settings", label: "Settings" },
	{ id: "access", label: "Access grants" },
];

/** The interesting parts of `detail`, worded rather than dumped as JSON. */
export function describeAuditDetail(entry: AuditEntry): string | null {
	const d = entry.detail;
	if (!d) return null;
	const parts: string[] = [];

	if (d.attribution === "as") parts.push("as the mailbox");
	if (d.attribution === "onBehalfOf") parts.push("on behalf of the mailbox");
	if (typeof d.tool === "string") parts.push(String(d.tool).replace(/_/g, " "));
	if (typeof d.op === "string") parts.push(String(d.op));
	if (typeof d.method === "string") parts.push(`with ${d.method}`);
	if (typeof d.reason === "string") parts.push(String(d.reason).replace(/_/g, " "));
	if (typeof d.outcome === "string") parts.push(String(d.outcome));
	// Which credential: the question an operator asks about any agent action.
	if (typeof d.oauthClientName === "string") parts.push(`app ${d.oauthClientName}`);
	else if (typeof d.oauthClient === "string") parts.push(`app ${d.oauthClient}`);
	if (typeof d.tokenName === "string") parts.push(`token ${d.tokenName}`);
	else if (typeof d.token === "string") parts.push(`token ${d.token}`);
	if (typeof d.requestedBy === "string") parts.push(`requested by ${d.requestedBy}`);
	if (typeof d.messages === "number") parts.push(`${d.messages} message${d.messages === 1 ? "" : "s"}`);
	if (typeof d.recipients === "number" && d.recipients > 1) parts.push(`${d.recipients} recipients`);
	if (d.scope === "trash") parts.push("emptied the bin");
	if (d.forwardingEnabled === true) parts.push("forwarding on");
	if (d.forwardingEnabled === false) parts.push("forwarding off");
	if (d.sendAuto === true) parts.push("may send without approval");
	if (d.sendAuto === false) parts.push("sends need approval");
	if (typeof d.role === "string") parts.push(`role ${d.role}`);
	if (typeof d.mailboxes === "string" && d.mailboxes !== "none") parts.push(String(d.mailboxes));
	if (typeof d.ip === "string") parts.push(`from ${d.ip}`);

	return parts.length > 0 ? parts.join(" · ") : null;
}
