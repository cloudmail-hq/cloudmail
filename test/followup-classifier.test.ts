// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Auto mode: the reply-expectation classifier and the send hook around it.
 *
 * The property that matters most is failing closed: an AI error, an empty or
 * ambiguous answer, or no binding at all must set no reminder. Also pinned:
 * quoted history is stripped before classifying, an explicit request beats the
 * mailbox default, and a queued send's reminder counts from its send time.
 */

import { describe, expect, it, vi } from "vitest";
import { EXPECTS_REPLY_MODEL, expectsReply } from "../workers/lib/ai";
import { routerOver } from "./helpers/ai-router";
import { applySendFollowup, parseFollowupField, resolveExplicitFollowup } from "../workers/lib/followups";
import { DAY_SECONDS, resolveFollowup } from "../shared/followups";

function fakeAi(answer: string | (() => never)) {
	const run = vi.fn(async (_model: string, _input: { messages: { role: string; content: string }[] }) => {
		if (typeof answer === "function") answer();
		return { response: answer };
	});
	return { ai: { run } as unknown as Ai, run };
}

describe("expectsReply", () => {
	it("is true only for a clear YES", async () => {
		expect(await expectsReply(routerOver(fakeAi("YES").ai), "<p>Can you send the invoice?</p>")).toBe(true);
		expect(await expectsReply(routerOver(fakeAi("yes.").ai), "Can you send the invoice?")).toBe(true);
		expect(await expectsReply(routerOver(fakeAi("NO").ai), "Thanks, all done.")).toBe(false);
		expect(await expectsReply(routerOver(fakeAi("Maybe").ai), "Thanks, all done.")).toBe(false);
		expect(await expectsReply(routerOver(fakeAi("").ai), "Thanks, all done.")).toBe(false);
	});

	it("fails closed when the model throws", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { ai } = fakeAi(() => {
			throw new Error("AI unavailable");
		});
		expect(await expectsReply(routerOver(ai), "Can you send the invoice?")).toBe(false);
		spy.mockRestore();
	});

	it("fails closed with no binding or no body", async () => {
		expect(await expectsReply(undefined, "Can you send the invoice?")).toBe(false);
		expect(await expectsReply(routerOver(fakeAi("YES").ai), "")).toBe(false);
	});

	it("strips quoted text before classifying", async () => {
		const { ai, run } = fakeAi("NO");
		const body =
			"<p>Thanks, that works.</p>" +
			'<div class="gmail_quote">On Mon, Customer wrote:<blockquote>Can you send me the contract? When can we start?</blockquote></div>';
		await expectsReply(routerOver(ai), body);
		const sent = run.mock.calls[0]![1].messages.find((m) => m.role === "user")!.content;
		expect(sent).toContain("Thanks, that works.");
		expect(sent).not.toContain("contract");
		expect(run.mock.calls[0]![0]).toBe(EXPECTS_REPLY_MODEL);
	});
});

describe("resolveFollowup", () => {
	const SENT = Date.parse("2026-10-01T09:00:00.000Z");

	it("uses the mailbox default only when the request says nothing", () => {
		expect(resolveFollowup(undefined, "off", SENT)).toEqual({ kind: "none" });
		expect(resolveFollowup(undefined, "3d", SENT)).toEqual({
			kind: "manual",
			at: new Date(SENT + 3 * DAY_SECONDS * 1000).toISOString(),
			durationSeconds: 3 * DAY_SECONDS,
		});
		expect(resolveFollowup(undefined, "auto", SENT).kind).toBe("auto");
		expect(resolveFollowup({ mode: "off" }, "3d", SENT)).toEqual({ kind: "none" });
	});

	it("counts delay_seconds from the send time and refuses an `at` in the past", () => {
		expect(resolveFollowup({ mode: "manual", delay_seconds: 86400 }, "off", SENT)).toMatchObject({
			at: "2026-10-02T09:00:00.000Z",
		});
		expect(resolveFollowup({ mode: "manual", at: "2026-09-01T00:00:00Z" }, "off", SENT)).toEqual({
			kind: "none",
		});
	});

	it("ignores an invalid followup field rather than failing the send", () => {
		expect(parseFollowupField({ followup: { mode: "manual" } })).toBeUndefined();
		expect(parseFollowupField({ followup: { mode: "sometimes" } })).toBeUndefined();
		expect(parseFollowupField({ followup: { mode: "auto" } })).toEqual({ mode: "auto" });
	});

	it("validates explicit sets", () => {
		const now = Date.parse("2026-10-01T09:00:00Z");
		expect(resolveExplicitFollowup({}, now).ok).toBe(false);
		expect(resolveExplicitFollowup({ at: "2026-09-01T00:00:00Z" }, now).ok).toBe(false);
		expect(resolveExplicitFollowup({ delaySeconds: 3600 }, now)).toEqual({
			ok: true,
			at: "2026-10-01T10:00:00.000Z",
			durationSeconds: 3600,
		});
	});
});

describe("applySendFollowup", () => {
	const bucket = (settings: unknown) =>
		({ get: async () => ({ json: async () => settings }) }) as unknown as R2Bucket;

	function fakeStub() {
		const setFollowup = vi.fn(async (args: { emailId: string; followupAt: string }) => ({
			email_id: args.emailId,
			followup_at: args.followupAt,
		}));
		return { stub: { setFollowup } as never, setFollowup };
	}

	it("auto mode sets nothing when the classifier errors (fail closed)", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { stub, setFollowup } = fakeStub();
		const { ai } = fakeAi(() => {
			throw new Error("boom");
		});
		const result = await applySendFollowup({ BUCKET: bucket({}), AI: ai }, stub, {
			mailboxId: "founder@tapetide.com",
			emailId: "e1",
			request: { mode: "auto" },
			body: "Can we talk Tuesday?",
		});
		expect(result).toBeNull();
		expect(setFollowup).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("auto mode sets a three-day reminder when the message asks for something", async () => {
		const { stub, setFollowup } = fakeStub();
		const sentAtMs = Date.parse("2026-10-01T09:00:00Z");
		await applySendFollowup({ BUCKET: bucket({}), AI: fakeAi("YES").ai }, stub, {
			mailboxId: "founder@tapetide.com",
			emailId: "e1",
			request: { mode: "auto" },
			body: "Can we talk Tuesday?",
			sentAtMs,
		});
		expect(setFollowup).toHaveBeenCalledWith({
			emailId: "e1",
			followupAt: "2026-10-04T09:00:00.000Z",
			mode: "auto",
			durationSeconds: 3 * DAY_SECONDS,
		});
	});

	it("falls back to the mailbox default", async () => {
		const { stub, setFollowup } = fakeStub();
		await applySendFollowup(
			{ BUCKET: bucket({ followups: { default: "3d", draftNudge: false } }), AI: fakeAi("NO").ai },
			stub,
			{ mailboxId: "founder@tapetide.com", emailId: "e1", request: undefined, body: "FYI", sentAtMs: 0 },
		);
		expect(setFollowup).toHaveBeenCalledWith(expect.objectContaining({ mode: "manual", durationSeconds: 3 * DAY_SECONDS }));
	});

	it("an explicit off on a reply cancels the thread's restarted reminder", async () => {
		const { stub, setFollowup } = fakeStub();
		const cancelFollowup = vi.fn(async () => null);
		(stub as { cancelFollowup?: unknown }).cancelFollowup = cancelFollowup;
		await applySendFollowup({ BUCKET: bucket({ followups: { default: "3d" } }), AI: fakeAi("YES").ai }, stub, {
			mailboxId: "founder@tapetide.com",
			emailId: "reply-2",
			request: { mode: "off" },
			body: "Thanks!",
		});
		expect(cancelFollowup).toHaveBeenCalledWith("reply-2");
		expect(setFollowup).not.toHaveBeenCalled();
	});

	it("does nothing with the default off and no request", async () => {
		const { stub, setFollowup } = fakeStub();
		await applySendFollowup({ BUCKET: bucket({}), AI: fakeAi("YES").ai }, stub, {
			mailboxId: "founder@tapetide.com",
			emailId: "e1",
			request: undefined,
			body: "Can we talk?",
		});
		expect(setFollowup).not.toHaveBeenCalled();
	});
});
