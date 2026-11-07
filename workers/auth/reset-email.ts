// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The "reset your password" email sent by `POST /api/auth/password/forgot`.
 *
 * Deliberately sparse. It carries no request IP, time or device: the person
 * reading it may not be the person who asked, and telling a stranger's inbox
 * where a request came from helps nobody. It says only what the reader needs
 * to act or to ignore it safely.
 */

import { escapeHtml } from "../lib/email-helpers";
import { sendEmail } from "../email-sender";
import { preSendOrThrow } from "../lib/pre-send";
import type { Env } from "../types";
import type { AuthEmailSender } from "./config";

export interface ResetEmailContent {
	subject: string;
	text: string;
	html: string;
}

/**
 * Drop characters that could break out of a header or a line. The app name is
 * admin-editable branding, and it lands in the Subject and the From name.
 */
function headerSafe(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

export function buildResetEmail(input: {
	appName: string;
	url: string;
	expiresInMinutes: number;
}): ResetEmailContent {
	const appName = headerSafe(input.appName) || "cloudmail";
	const minutes = input.expiresInMinutes;
	const subject = `Reset your ${appName} password`;

	const text = [
		`Someone asked to reset the password for your ${appName} account.`,
		"",
		"To choose a new password, open this link:",
		input.url,
		"",
		`The link works once and expires in ${minutes} minutes. Using it signs you out on every device.`,
		"",
		"If you didn't ask for this, you can ignore this email. Your password won't change.",
	].join("\n");

	// Every interpolated value is escaped, including the URL: it is built from
	// APP_URL or the request origin, and neither should be trusted as markup.
	const name = escapeHtml(appName);
	const href = escapeHtml(input.url);
	const html = `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f6f6f6;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px;">
<p style="margin:0 0 16px;font-size:16px;font-weight:600;">${name}</p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.5;">Someone asked to reset the password for your ${name} account.</p>
<p style="margin:0 0 16px;"><a href="${href}" style="display:inline-block;padding:10px 16px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Choose a new password</a></p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#555555;">The link works once and expires in ${minutes} minutes. Using it signs you out on every device.</p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#555555;word-break:break-all;">If the button doesn't work, copy this address into your browser:<br>${href}</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#555555;">If you didn't ask for this, you can ignore this email. Your password won't change.</p>
</div>
</body>
</html>`;

	return { subject, text, html };
}

/**
 * Send the reset email straight through the `EMAIL` binding.
 *
 * Not through any mailbox: the message is not stored in a Sent folder, does
 * not count against a mailbox's send limit and is not tracked. It is the
 * deployment talking to an account holder, not a mailbox talking to the world.
 */
export async function sendResetEmail(
	binding: SendEmail,
	sender: AuthEmailSender,
	to: string,
	content: ResetEmailContent,
	appName: string,
): Promise<void> {
	// System mail through the shared gate: provider limits only. No mailbox caps
	// and no suppression filter — the account holder asked for this message.
	const gate = await preSendOrThrow({} as Env, {
		kind: "system",
		from: sender.email,
		mailboxId: null,
		to,
		text: content.text,
		html: content.html,
		// The one send allowed while the licence is locked: without it an
		// admin who forgot their password could never sign in to activate.
		licenceExempt: true,
	});
	await sendEmail(binding, {
		to,
		from: { email: sender.email, name: headerSafe(sender.name ?? appName) || "cloudmail" },
		subject: content.subject,
		text: content.text,
		html: content.html,
	}, gate.clearance);
}
