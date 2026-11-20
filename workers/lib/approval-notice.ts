// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Email the person behind a held send, with the link that opens it.
 *
 * Web Push already reaches people who turned it on in a browser. This covers
 * the rest: an agent's token acts for one person, and that person should learn
 * a send is waiting without depending on the agent to pass the link on.
 *
 * Sent from the deployment's auth sender (the one password resets use), as
 * system mail: not stored in any mailbox, not tracked. Off when that person
 * switched "Pending approval" notifications off. Never throws.
 */

import type { Env } from "../types";
import type { ApprovalActor } from "../../shared/agent-send-policy";
import { resolveAuthEmailSender } from "../auth/config";
import { sendEmail } from "../email-sender";
import { approvalPath } from "./agent-send-gate";
import { deploymentOrigin } from "./deployment-origin";
import { escapeHtml } from "./email-helpers";
import { preSendOrThrow } from "./pre-send";
import { pushRpc } from "./push";

export interface ApprovalNoticeInput {
	mailboxId: string;
	approvalId: string;
	subject: string;
	recipients: string[];
	actor: ApprovalActor;
	expiresAt: number;
}

const ADDRESS_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

function oneLine(value: string, max: number): string {
	const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Who asked, in words. */
function requester(actor: ApprovalActor): string {
	if (actor.via === "agent") return "The in-app assistant";
	if (actor.method === "oauth") return `The connected app ${actor.oauthClientName || actor.oauthClientId || ""}`.trim();
	if (actor.method === "token") return `The API token "${actor.tokenName || actor.tokenId || "unnamed"}"`;
	return "An MCP client";
}

/** Subject, text and HTML of the notice. Pure; exported for tests. */
export function buildApprovalNotice(input: ApprovalNoticeInput & { url: string }) {
	const subjectLine = oneLine(input.subject || "(no subject)", 120);
	const to = input.recipients.slice(0, 5).join(", ") + (input.recipients.length > 5 ? ` and ${input.recipients.length - 5} more` : "");
	const who = requester(input.actor);
	const expires = new Date(input.expiresAt).toUTCString();
	const subject = oneLine(`Waiting for your approval: ${subjectLine}`, 160);
	const text = [
		`${who} asked to send an email from ${input.mailboxId}. Nothing has been sent yet.`,
		"",
		`Subject: ${subjectLine}`,
		`To: ${to || "(none)"}`,
		"",
		`Review, edit, approve or reject it here:`,
		input.url,
		"",
		`If nobody decides, it expires on ${expires}.`,
		`You get this because the token or app that asked acts for you. Turn these off in Settings -> Notifications -> Pending approval.`,
	].join("\n");
	const e = escapeHtml;
	const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f6f6;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px;">
<p style="margin:0 0 16px;font-size:14px;line-height:1.5;">${e(who)} asked to send an email from <strong>${e(input.mailboxId)}</strong>. Nothing has been sent yet.</p>
<p style="margin:0 0 4px;font-size:14px;"><strong>Subject:</strong> ${e(subjectLine)}</p>
<p style="margin:0 0 16px;font-size:14px;"><strong>To:</strong> ${e(to || "(none)")}</p>
<p style="margin:0 0 16px;"><a href="${e(input.url)}" style="display:inline-block;padding:10px 16px;background:#1B4BC4;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Review it</a></p>
<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#555555;word-break:break-all;">${e(input.url)}</p>
<p style="margin:0;font-size:12px;line-height:1.5;color:#777777;">It expires on ${e(expires)} if nobody decides. Turn these emails off in Settings → Notifications → Pending approval.</p>
</div></body></html>`;
	return { subject, text, html };
}

export interface ApprovalNoticeDeps {
	/** Injected in tests. */
	send?: typeof sendEmail;
	origin?: string | null;
	prefsApprovalEmails?: (userKey: string) => Promise<boolean>;
}

/** Send the notice. Resolves to whether one was sent. */
export async function emailApprovalNotice(env: Env, input: ApprovalNoticeInput, deps: ApprovalNoticeDeps = {}): Promise<boolean> {
	try {
		// The in-app assistant runs while its person is looking at the app.
		if (input.actor.via === "agent") return false;
		const to = input.actor.user?.trim().toLowerCase() ?? "";
		if (!ADDRESS_RE.test(to)) return false;
		const from = resolveAuthEmailSender(env);
		if (!from) return false;
		const wants = deps.prefsApprovalEmails
			? await deps.prefsApprovalEmails(to)
			: await (async () => {
					const rpc = pushRpc(env);
					return rpc ? (await rpc.pushGetPrefs(to)).approvalEmails : false;
				})();
		if (!wants) return false;
		const origin = deps.origin !== undefined ? deps.origin : await deploymentOrigin(env);
		// No origin, no clickable link; the push and the agent's own output still carry one.
		if (!origin) return false;
		const url = `${origin}${approvalPath(input.mailboxId, input.approvalId)}`;
		const content = buildApprovalNotice({ ...input, url });
		const headers = { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" };
		const gate = await preSendOrThrow(env, {
			kind: "system",
			from: from.email,
			mailboxId: null,
			to,
			text: content.text,
			html: content.html,
			headers,
			actor: { via: "system" },
		});
		await (deps.send ?? sendEmail)(
			env,
			{ to, from: from.name ? { email: from.email, name: from.name } : from.email, subject: content.subject, text: content.text, html: content.html, headers },
			gate.clearance,
		);
		return true;
	} catch (e) {
		console.error("approval notice email failed:", (e as Error).message);
		return false;
	}
}
