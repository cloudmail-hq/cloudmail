import { describe, expect, it, vi } from "vitest";
import { buildApprovalNotice, emailApprovalNotice, type ApprovalNoticeInput } from "../workers/lib/approval-notice";
import type { Env } from "../workers/types";

const input: ApprovalNoticeInput = {
	mailboxId: "support@example.com",
	approvalId: "apr_0123456789abcdef0123",
	subject: "Your invoice <script>",
	recipients: ["customer@example.org"],
	actor: { user: "owner@example.com", via: "api", method: "token", tokenId: "t1", tokenName: "Claude agent" },
	expiresAt: Date.UTC(2026, 10, 22),
};
const env = { EMAIL: { send: async () => ({ messageId: "m" }) }, DOMAINS: "example.com" } as unknown as Env;
const LINK = "https://mail.example.com/mail/support%40example.com/approvals?id=apr_0123456789abcdef0123";

describe("approval notice email", () => {
	it("names who asked, the subject, the recipients and the direct link, escaping HTML", () => {
		const n = buildApprovalNotice({ ...input, url: LINK });
		expect(n.subject).toBe("Waiting for your approval: Your invoice <script>");
		expect(n.text).toContain('The API token "Claude agent" asked to send an email from support@example.com');
		expect(n.text).toContain(LINK);
		expect(n.text).toContain("To: customer@example.org");
		expect(n.html).toContain("Your invoice &lt;script&gt;");
		expect(n.html).not.toContain("<script>");
		expect(n.html).toContain(`href="${LINK.replace(/&/g, "&amp;")}"`);
	});

	it("emails the person the token acts for, with the link", async () => {
		const send = vi.fn(async () => ({ messageId: "x" }));
		const ok = await emailApprovalNotice(env, input, { send: send as never, origin: "https://mail.example.com", prefsApprovalEmails: async () => true });
		expect(ok).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		const msg = (send.mock.calls[0] as unknown as [unknown, { to: string; text: string; headers: Record<string, string> }])[1];
		expect(msg.to).toBe("owner@example.com");
		expect(msg.text).toContain(LINK);
		expect(msg.headers["Auto-Submitted"]).toBe("auto-generated");
	});

	it("sends nothing when the person has not turned approval emails on, for the in-app assistant, or without an origin", async () => {
		const send = vi.fn(async () => ({ messageId: "x" }));
		const deps = { send: send as never, origin: "https://mail.example.com" };
		expect(await emailApprovalNotice(env, input, { ...deps, prefsApprovalEmails: async () => false })).toBe(false);
		expect(await emailApprovalNotice(env, { ...input, actor: { ...input.actor, via: "agent" } }, { ...deps, prefsApprovalEmails: async () => true })).toBe(false);
		expect(await emailApprovalNotice(env, { ...input, actor: { ...input.actor, user: "svc-client-id" } }, { ...deps, prefsApprovalEmails: async () => true })).toBe(false);
		expect(await emailApprovalNotice(env, input, { send: send as never, origin: null, prefsApprovalEmails: async () => true })).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});

	it("never throws when sending fails", async () => {
		const send = vi.fn(async () => {
			throw new Error("provider down");
		});
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await emailApprovalNotice(env, input, { send: send as never, origin: "https://mail.example.com", prefsApprovalEmails: async () => true })).toBe(false);
		err.mockRestore();
	});
});
