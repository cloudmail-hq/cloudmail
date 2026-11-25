/**
 * Security notices: an email to the account holder whenever the ways into
 * their account change, or someone gets past their password.
 *
 * NIST SP 800-63B-4 §4.6 asks for a notice when an authenticator is added and
 * on account recovery; OWASP asks for one on every factor change. The case
 * that matters most is an attacker with a stolen session enrolling their own
 * passkey: this email is how the real owner finds out.
 *
 * Sent the same way as the password reset email (`reset-email.ts`): straight
 * through the `EMAIL` binding from `AUTH_EMAIL_FROM` (or `no-reply@` the first
 * domain), never through a mailbox, and also while the licence is locked. A
 * deployment with no sender sends none.
 * Always after the response, and never throws: a mail outage must not block
 * a sign-in or a settings change.
 *
 * The notice names the device ("Chrome on Mac") and the time, never the IP:
 * enough to tell "that was me" from "that wasn't", and nothing a forwarded
 * email would leak.
 */

import type { Context } from "hono";
import { deviceLabel } from "../../shared/push-policy";
import { escapeHtml } from "../lib/email-helpers";
import type { MailboxContext } from "../lib/mailbox";
import { appBaseUrl, resolveAuthEmailSender } from "./config";
import { sendResetEmail, type ResetEmailContent } from "./reset-email";
import { issuerName } from "./routes";

type C = Context<MailboxContext>;

export type SecurityEvent =
	| { kind: "totp_added" }
	| { kind: "totp_removed" }
	| { kind: "passkey_added"; name: string }
	| { kind: "passkey_removed"; name: string }
	| { kind: "recovery_codes_new" }
	| { kind: "recovery_code_used"; codesLeft: number }
	| { kind: "password_changed" }
	| { kind: "password_reset" }
	| { kind: "owner_recovered" }
	/** The password was right and the second step failed this many times in a row. */
	| { kind: "second_step_failing"; failures: number; appCodesOff: boolean }
	| { kind: "two_factor_reset"; by: string };

interface Copy {
	subject: string;
	/** What happened, in one or two sentences. */
	lines: string[];
	/** What to do if it wasn't them. */
	ifNotYou: string;
	/** Show "If this was you, ignore this email." Not for events nobody asked for. */
	maybeYou: boolean;
	/** Whose device to name: the signed-in user's, or none (an admin acted). */
	showDevice: boolean;
}

const CHANGE_PASSWORD = "change your password and check Account & security";

function copyFor(event: SecurityEvent, app: string): Copy {
	switch (event.kind) {
		case "totp_added":
			return {
				subject: `Authenticator app added to your ${app} account`,
				lines: ["An authenticator app was added to your account. Signing in with your password can now ask for a code from it."],
				ifNotYou: `remove it, ${CHANGE_PASSWORD}`,
				maybeYou: true,
				showDevice: true,
			};
		case "totp_removed":
			return {
				subject: `Authenticator app removed from your ${app} account`,
				lines: ["The authenticator app was removed from your account. Its codes no longer sign in."],
				ifNotYou: CHANGE_PASSWORD,
				maybeYou: true,
				showDevice: true,
			};
		case "passkey_added":
			return {
				subject: `New passkey added to your ${app} account`,
				lines: [`A passkey named “${event.name}” was added to your account. It can sign in without your password.`],
				ifNotYou: `delete that passkey, ${CHANGE_PASSWORD}`,
				maybeYou: true,
				showDevice: true,
			};
		case "passkey_removed":
			return {
				subject: `Passkey removed from your ${app} account`,
				lines: [`The passkey “${event.name}” was removed from your account.`],
				ifNotYou: CHANGE_PASSWORD,
				maybeYou: true,
				showDevice: true,
			};
		case "recovery_codes_new":
			return {
				subject: `New recovery codes for your ${app} account`,
				lines: ["A new set of recovery codes was made for your account. The old codes no longer work."],
				ifNotYou: `make a new set, ${CHANGE_PASSWORD}`,
				maybeYou: true,
				showDevice: true,
			};
		case "recovery_code_used": {
			const left = `${event.codesLeft} recovery code${event.codesLeft === 1 ? "" : "s"} left`;
			return {
				subject: `A recovery code was used to sign in to your ${app} account`,
				lines: [`Someone signed in to your account with your password and a recovery code. You have ${left}.`],
				ifNotYou: `${CHANGE_PASSWORD}, then make new recovery codes`,
				maybeYou: true,
				showDevice: true,
			};
		}
		case "password_changed":
			return {
				subject: `Your ${app} password was changed`,
				lines: ["The password for your account was changed. Other browsers were signed out."],
				ifNotYou: "reset your password from the sign-in page, then check Account & security",
				maybeYou: true,
				showDevice: true,
			};
		case "password_reset":
			return {
				subject: `Your ${app} password was reset`,
				lines: ["The password for your account was reset with an emailed link. Every browser was signed out."],
				ifNotYou: "reset your password again from the sign-in page and tell your administrator",
				maybeYou: true,
				showDevice: true,
			};
		case "owner_recovered":
			return {
				subject: `Your ${app} owner account was recovered`,
				lines: [
					"The owner password was reset with this deployment's setup token. Two-factor, passkeys and recovery codes were removed, and every browser was signed out.",
				],
				ifNotYou: "someone has the setup token: change SETUP_TOKEN, recover the account again, and set up two-factor",
				maybeYou: true,
				showDevice: true,
			};
		case "second_step_failing":
			return {
				subject: `Someone may know your ${app} password`,
				lines: [
					`Someone signed in with your correct password, then failed the two-factor step ${event.failures} times in a row. Two-factor stopped them.`,
					event.appCodesOff
						? "Authenticator app codes are now turned off for a day. Your passkeys and recovery codes still work."
						: "The two-factor step is locked for a while after each wrong try.",
				],
				ifNotYou: "change your password now",
				maybeYou: false,
				showDevice: false,
			};
		case "two_factor_reset":
			return {
				subject: `Your ${app} two-factor was reset`,
				lines: [
					`An administrator (${event.by}) removed your authenticator app, passkeys and recovery codes, and signed you out everywhere.`,
					"Sign in with your password, then set up two-factor again.",
				],
				ifNotYou: "contact your administrator",
				maybeYou: false,
				showDevice: false,
			};
	}
}

export function buildSecurityEmail(input: {
	appName: string;
	event: SecurityEvent;
	settingsUrl: string;
	device: string | null;
	at: number;
}): ResetEmailContent {
	const app = input.appName.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() || "cloudmail";
	const copy = copyFor(input.event, app);
	const when = new Date(input.at).toUTCString();
	const facts = [`When: ${when}`, ...(copy.showDevice && input.device ? [`Device: ${input.device}`] : [])];
	const closing = copy.maybeYou
		? `If this was you, you can ignore this email. If it wasn't, ${copy.ifNotYou}:`
		: `If this wasn't you, ${copy.ifNotYou}:`;

	const text = [...copy.lines, "", ...facts, "", closing, input.settingsUrl].join("\n");

	const p = (s: string, extra = "") =>
		`<p style="margin:0 0 16px;font-size:14px;line-height:1.5;${extra}">${escapeHtml(s)}</p>`;
	const html = `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f6f6f6;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px;">
<p style="margin:0 0 16px;font-size:16px;font-weight:600;">${escapeHtml(app)}</p>
${copy.lines.map((l) => p(l)).join("\n")}
<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#555555;">${facts.map(escapeHtml).join("<br>")}</p>
${p(closing, "color:#555555;font-size:13px;")}
<p style="margin:0;"><a href="${escapeHtml(input.settingsUrl)}" style="display:inline-block;padding:10px 16px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Open Account &amp; security</a></p>
</div>
</body>
</html>`;
	return { subject: copy.subject, text, html };
}

/**
 * Email `to` about `event`, after the response. A no-op when the deployment
 * cannot send (no `EMAIL` binding or no domain). Never throws.
 */
export function notifySecurityEvent(c: C, to: string, event: SecurityEvent, now: number): void {
	const sender = resolveAuthEmailSender(c.env);
	if (!sender) return;
	const env = c.env;
	const settingsUrl = `${appBaseUrl(env, c.req.url)}/settings/account`;
	const label = deviceLabel(c.req.header("user-agent") ?? null);
	const device = label === "Browser on Device" ? null : label;
	const work = (async () => {
		const appName = await issuerName(env);
		const content = buildSecurityEmail({ appName, event, settingsUrl, device, at: now });
		await sendResetEmail(env, sender, to, content, appName);
	})().catch((e) => {
		console.error(`[auth] Failed to send a ${event.kind} security notice:`, (e as Error).message);
	});
	try {
		c.executionCtx.waitUntil(work);
	} catch {
		// No execution context (some tests): the promise still runs on its own.
	}
}
