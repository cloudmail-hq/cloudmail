import { describe, expect, it, vi } from "vitest";
import { routerOver } from "./helpers/ai-router";
import {
	isDraftable,
	isSendable,
	verifyDraft,
	type DraftVerification,
} from "../workers/lib/ai";

/**
 * Minimal `Ai` stand-in (only `run` is exercised), behind the model router.
 * `run` is attached so a test can assert on the binding's calls.
 */
const aiReturning = (response: string | null) => {
	const run = vi.fn(async () => ({ response }));
	return Object.assign(routerOver({ run }), { run });
};

const aiThrowing = (message: string) =>
	routerOver({
		run: vi.fn(async () => {
			throw new Error(message);
		}),
	});

const LONG_BODY =
	"Thanks for reaching out about the Q3 budget. I have attached the figures and can walk through them on Thursday.";

describe("verifyDraft failure handling", () => {
	it("returns the original body and reports unavailable when the model throws", async () => {
		// Regression: this previously returned "" and every caller read that as
		// "the draft was entirely commentary", so a transient Workers AI outage
		// blocked drafting and sending outright.
		const result = await verifyDraft(aiThrowing("429 rate limited"), LONG_BODY);

		expect(result.status).toBe("unavailable");
		expect(result.body).toBe(LONG_BODY);
		expect(result.error).toContain("429");
	});

	it("never throws out of an AI failure", async () => {
		await expect(
			verifyDraft(aiThrowing("boom"), LONG_BODY),
		).resolves.toBeDefined();
	});

	it("keeps the original when the model responds with nothing", async () => {
		// An empty model response is a model failure, not proof the draft was
		// commentary, so the user's text must survive.
		for (const empty of [null, "", "   "]) {
			const result = await verifyDraft(aiReturning(empty), LONG_BODY);
			expect(result.status).toBe("unchanged");
			expect(result.body).toBe(LONG_BODY);
		}
	});

	it("reports unchanged when the model echoes the text back", async () => {
		const result = await verifyDraft(aiReturning(LONG_BODY), LONG_BODY);
		expect(result.status).toBe("unchanged");
		expect(result.body).toBe(LONG_BODY);
	});

	it("reports unchanged when the model strips more than half the content", async () => {
		const result = await verifyDraft(aiReturning("Thanks."), LONG_BODY);
		expect(result.status).toBe("unchanged");
		expect(result.body).toBe(LONG_BODY);
	});

	it("reports cleaned when artifacts are removed", async () => {
		const withArtifact = `${LONG_BODY} Draft saved. The operator can review and send from the UI.`;
		const result = await verifyDraft(aiReturning(LONG_BODY), withArtifact);

		expect(result.status).toBe("cleaned");
		expect(result.body).toContain("Q3 budget");
		expect(result.body).not.toContain("Draft saved");
	});

	it("short-circuits empty and very short bodies without calling the model", async () => {
		const ai = aiReturning("should not be used");

		for (const body of ["", "   ", "ok thanks"]) {
			const result = await verifyDraft(ai, body);
			expect(result.status).toBe("unchanged");
			expect(result.body).toBe(body);
		}
		expect((ai as unknown as { run: ReturnType<typeof vi.fn> }).run)
			.not.toHaveBeenCalled();
	});

	it("preserves the quoted reply block when cleaning HTML", async () => {
		const quoted =
			'<blockquote style="border-left: 2px solid #ccc;">On Monday, alice@example.com wrote:<br><br>Original</blockquote>';
		const body = `<div>${LONG_BODY} Draft saved.</div>${quoted}`;

		const result = await verifyDraft(aiReturning(LONG_BODY), body);

		expect(result.status).toBe("cleaned");
		expect(result.body).toContain("<blockquote");
		expect(result.body).toContain("alice@example.com");
	});
});

describe("caller policy", () => {
	const make = (status: DraftVerification["status"]): DraftVerification => ({
		status,
		body: status === "empty" ? "" : LONG_BODY,
	});

	it("allows drafting for everything except genuinely empty content", () => {
		// A draft is reviewed by a human before it goes anywhere, so an
		// unverified body is acceptable here.
		expect(isDraftable(make("unchanged"))).toBe(true);
		expect(isDraftable(make("cleaned"))).toBe(true);
		expect(isDraftable(make("unavailable"))).toBe(true);
		expect(isDraftable(make("empty"))).toBe(false);
	});

	it("holds sending to a stricter bar than drafting", () => {
		// Nothing downstream reviews an outbound send, so an unreachable
		// verifier must block it.
		expect(isSendable(make("unchanged"))).toBe(true);
		expect(isSendable(make("cleaned"))).toBe(true);
		expect(isSendable(make("unavailable"))).toBe(false);
		expect(isSendable(make("empty"))).toBe(false);
	});

	it("is strictly stronger for sends than for drafts", () => {
		const statuses: DraftVerification["status"][] = [
			"unchanged",
			"cleaned",
			"unavailable",
			"empty",
		];
		for (const status of statuses) {
			const result = make(status);
			if (isSendable(result)) expect(isDraftable(result)).toBe(true);
		}
	});
});
