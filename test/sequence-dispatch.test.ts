// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for sequence dispatch.
 *
 * The sequences feature previously did nothing: enrolling a contact wrote
 * pending step rows and there was no cron trigger, no `scheduled()` handler, and
 * no caller for `getPendingEmails` or `markEmailSent`. The UI reported
 * enrollments as active and no mail was ever sent.
 *
 * The behaviours worth pinning are the ones that decide whether a drip campaign
 * misbehaves in a way the user cannot see: sending a step that is not due,
 * continuing to send after cancellation, retrying a deleted template forever, or
 * one bad contact stopping everyone else's mail.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	SEQUENCE_BATCH_LIMIT,
	dispatchDueSequenceEmails,
} from "../workers/lib/sequence-dispatch";
import type { Env } from "../workers/types";

const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);

/** In-memory stand-in for the R2 bucket the sequence store uses. */
function fakeBucket() {
	const store = new Map<string, string>();

	return {
		store,
		async get(key: string) {
			const value = store.get(key);
			if (value === undefined) return null;
			return { json: async <T>() => JSON.parse(value) as T, text: async () => value };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async head(key: string) {
			return store.has(key) ? {} : null;
		},
		async delete(key: string) {
			store.delete(key);
		},
		async list({ prefix }: { prefix: string }) {
			return {
				objects: [...store.keys()]
					.filter((k) => k.startsWith(prefix))
					.map((key) => ({ key })),
			};
		},
	};
}

interface Harness {
	env: Env;
	bucket: ReturnType<typeof fakeBucket>;
	sent: any[];
	created: { folder: string; email: any }[];
}

function harness(options: { sendThrows?: boolean } = {}): Harness {
	const bucket = fakeBucket();
	const sent: any[] = [];
	const created: { folder: string; email: any }[] = [];

	const stub = {
		createEmail: async (folder: string, email: any) => {
			created.push({ folder, email });
		},
	};

	const env = {
		BUCKET: bucket,
		MAILBOX: {
			idFromName: (name: string) => name,
			get: () => stub,
		},
		EMAIL: {
			// Returns a result because `sendEmail` reads `result.messageId` from it.
			send: async (message: unknown) => {
				if (options.sendThrows) throw new Error("mail service refused");
				sent.push(message);
				return { messageId: `msg-${sent.length}` };
			},
		},
	} as unknown as Env;

	return { env, bucket, sent, created };
}

function putTemplate(
	h: Harness,
	slug: string,
	subject = "Hello {{name}}",
	bodyHtml = "<p>Hi {{name}}, at {{email}}</p>",
) {
	h.bucket.store.set(
		`templates/${slug}.json`,
		JSON.stringify({
			id: slug,
			slug,
			name: slug,
			subject,
			bodyHtml,
			createdAt: now(),
			updatedAt: now(),
		}),
	);
}

function putEnrollment(
	h: Harness,
	id: string,
	overrides: Record<string, unknown> = {},
) {
	h.bucket.store.set(
		`sequence-enrollments/${id}.json`,
		JSON.stringify({
			id,
			sequenceId: "seq-1",
			personId: "person-1",
			personEmail: "contact@example.com",
			personName: "Ada Lovelace",
			fromAddress: "sales@tapetide.com",
			status: "active",
			variables: {},
			enrolledAt: now(),
			cancelledAt: null,
			...overrides,
		}),
	);
}

function putStep(
	h: Harness,
	id: string,
	overrides: Record<string, unknown> = {},
) {
	h.bucket.store.set(
		`sequence-emails/${id}.json`,
		JSON.stringify({
			id,
			enrollmentId: "enr-1",
			stepOrder: 1,
			templateSlug: "welcome",
			scheduledAt: now() - 60,
			status: "pending",
			sentAt: null,
			sentEmailId: null,
			...overrides,
		}),
	);
}

function readStep(h: Harness, id: string) {
	return JSON.parse(h.bucket.store.get(`sequence-emails/${id}.json`)!);
}

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("dispatching due steps", () => {
	it("sends a step whose time has come", async () => {
		const h = harness();
		putTemplate(h, "welcome");
		putEnrollment(h, "enr-1");
		putStep(h, "step-1");

		const result = await dispatchDueSequenceEmails(h.env);

		expect(result).toEqual({ sent: 1, skipped: 0, suppressed: 0, failed: 0 });
		expect(h.sent).toHaveLength(1);
	});

	it("interpolates the contact into subject and body", async () => {
		const h = harness();
		putTemplate(h, "welcome");
		putEnrollment(h, "enr-1");
		putStep(h, "step-1");

		await dispatchDueSequenceEmails(h.env);

		const message = h.sent[0];
		expect(message.subject).toBe("Hello Ada Lovelace");
		expect(message.html).toContain("Ada Lovelace");
		expect(message.html).toContain("contact@example.com");
	});

	it("lets enrollment variables override the derived defaults", async () => {
		const h = harness();
		putTemplate(h, "welcome", "Hi {{name}}", "<p>{{company}}</p>");
		putEnrollment(h, "enr-1", {
			variables: { name: "Ada", company: "Analytical Engines Ltd" },
		});
		putStep(h, "step-1");

		await dispatchDueSequenceEmails(h.env);

		expect(h.sent[0].subject).toBe("Hi Ada");
		expect(h.sent[0].html).toContain("Analytical Engines Ltd");
	});

	it("falls back to the address local part when the contact has no name", async () => {
		const h = harness();
		putTemplate(h, "welcome", "Hi {{name}}", "<p>x</p>");
		putEnrollment(h, "enr-1", { personName: null });
		putStep(h, "step-1");

		await dispatchDueSequenceEmails(h.env);
		expect(h.sent[0].subject).toBe("Hi contact");
	});

	it("files a copy in the sender's Sent folder", async () => {
		// Otherwise the user has no record of mail sent on their behalf.
		const h = harness();
		putTemplate(h, "welcome");
		putEnrollment(h, "enr-1");
		putStep(h, "step-1");

		await dispatchDueSequenceEmails(h.env);

		expect(h.created).toHaveLength(1);
		expect(h.created[0].folder).toBe("sent");
		expect(h.created[0].email.sender).toBe("sales@tapetide.com");
		expect(h.created[0].email.recipient).toBe("contact@example.com");
	});

	it("marks the step sent so it is not sent again", async () => {
		const h = harness();
		putTemplate(h, "welcome");
		putEnrollment(h, "enr-1");
		putStep(h, "step-1");

		await dispatchDueSequenceEmails(h.env);
		expect(readStep(h, "step-1").status).toBe("sent");

		// A second tick finds nothing to do.
		const second = await dispatchDueSequenceEmails(h.env);
		expect(second.sent).toBe(0);
		expect(h.sent).toHaveLength(1);
	});

	it("completes the enrollment once every step has gone out", async () => {
		const h = harness();
		putTemplate(h, "welcome");
		putEnrollment(h, "enr-1");
		putStep(h, "step-1");

		await dispatchDueSequenceEmails(h.env);

		const enrollment = JSON.parse(
			h.bucket.store.get("sequence-enrollments/enr-1.json")!,
		);
		expect(enrollment.status).toBe("completed");
	});
});

describe("steps that are not due", () => {
	it("leaves a future step alone", async () => {
		const h = harness();
		putTemplate(h, "welcome");
		putEnrollment(h, "enr-1");
		putStep(h, "step-1", { scheduledAt: now() + 48 * HOUR });

		const result = await dispatchDueSequenceEmails(h.env);

		expect(result.sent).toBe(0);
		expect(h.sent).toHaveLength(0);
		expect(readStep(h, "step-1").status).toBe("pending");
	});

	it("sends only the due steps of a multi-step sequence", async () => {
		const h = harness();
		putTemplate(h, "welcome");
		putEnrollment(h, "enr-1");
		putStep(h, "step-1", { stepOrder: 1, scheduledAt: now() - 60 });
		putStep(h, "step-2", { stepOrder: 2, scheduledAt: now() + 72 * HOUR });

		await dispatchDueSequenceEmails(h.env);

		expect(h.sent).toHaveLength(1);
		expect(readStep(h, "step-1").status).toBe("sent");
		expect(readStep(h, "step-2").status).toBe("pending");
	});

	it("ignores steps already sent or cancelled", async () => {
		const h = harness();
		putTemplate(h, "welcome");
		putEnrollment(h, "enr-1");
		putStep(h, "step-1", { status: "sent" });
		putStep(h, "step-2", { status: "cancelled" });

		const result = await dispatchDueSequenceEmails(h.env);
		expect(result).toEqual({ sent: 0, skipped: 0, suppressed: 0, failed: 0 });
	});
});

describe("cancellation and missing data", () => {
	it("does not send for a cancelled enrollment", async () => {
		// Cancelling writes one object per step; a partial failure there must not
		// leave a stopped sequence still sending.
		const h = harness();
		putTemplate(h, "welcome");
		putEnrollment(h, "enr-1", { status: "cancelled" });
		putStep(h, "step-1");

		const result = await dispatchDueSequenceEmails(h.env);

		expect(h.sent).toHaveLength(0);
		expect(result.skipped).toBe(1);
		// And the orphaned step is cancelled, so it stops being reconsidered.
		expect(readStep(h, "step-1").status).toBe("cancelled");
	});

	it("cancels a step whose enrollment has vanished", async () => {
		const h = harness();
		putTemplate(h, "welcome");
		putStep(h, "step-1");

		const result = await dispatchDueSequenceEmails(h.env);

		expect(result.skipped).toBe(1);
		expect(readStep(h, "step-1").status).toBe("cancelled");
	});

	it("cancels a step whose template was deleted rather than retrying forever", async () => {
		// Left pending, this would fail identically on every tick.
		const h = harness();
		putEnrollment(h, "enr-1");
		putStep(h, "step-1", { templateSlug: "deleted-template" });

		const result = await dispatchDueSequenceEmails(h.env);

		expect(result.skipped).toBe(1);
		expect(h.sent).toHaveLength(0);
		expect(readStep(h, "step-1").status).toBe("cancelled");
	});
});

describe("failure isolation", () => {
	it("keeps a step pending when the send throws, so the next tick retries", async () => {
		const h = harness({ sendThrows: true });
		putTemplate(h, "welcome");
		putEnrollment(h, "enr-1");
		putStep(h, "step-1");

		const result = await dispatchDueSequenceEmails(h.env);

		expect(result.failed).toBe(1);
		expect(readStep(h, "step-1").status).toBe("pending");
	});

	it("does not let one unsendable contact stop the rest of the batch", async () => {
		const h = harness();
		putTemplate(h, "welcome");
		putEnrollment(h, "enr-1");
		putEnrollment(h, "enr-2", { personEmail: "second@example.com" });
		// First step has no template and will be skipped; the second must still go.
		putStep(h, "step-1", {
			templateSlug: "missing",
			scheduledAt: now() - 120,
		});
		putStep(h, "step-2", {
			enrollmentId: "enr-2",
			scheduledAt: now() - 60,
		});

		const result = await dispatchDueSequenceEmails(h.env);

		expect(result.skipped).toBe(1);
		expect(result.sent).toBe(1);
		expect(h.sent[0].to).toBe("second@example.com");
	});
});

describe("batching", () => {
	it("caps a single tick and leaves the rest for the next one", async () => {
		const h = harness();
		putTemplate(h, "welcome");
		putEnrollment(h, "enr-1");
		for (let i = 0; i < 5; i++) {
			putStep(h, `step-${i}`, { scheduledAt: now() - (100 - i) });
		}

		const result = await dispatchDueSequenceEmails(h.env, { limit: 2 });

		expect(result.sent).toBe(2);
		expect(h.sent).toHaveLength(2);

		// The remainder is still pending and picked up subsequently.
		const remaining = await dispatchDueSequenceEmails(h.env, { limit: 10 });
		expect(remaining.sent).toBe(3);
	});

	it("sends the most overdue first", async () => {
		const h = harness();
		putTemplate(h, "welcome");
		putEnrollment(h, "enr-1", { personEmail: "a@example.com" });
		putEnrollment(h, "enr-2", { personEmail: "b@example.com" });
		putStep(h, "recent", { enrollmentId: "enr-1", scheduledAt: now() - 10 });
		putStep(h, "stale", { enrollmentId: "enr-2", scheduledAt: now() - 10000 });

		await dispatchDueSequenceEmails(h.env, { limit: 1 });

		expect(h.sent[0].to).toBe("b@example.com");
	});

	it("exposes a sane default batch cap", async () => {
		expect(SEQUENCE_BATCH_LIMIT).toBeGreaterThan(0);
		expect(SEQUENCE_BATCH_LIMIT).toBeLessThanOrEqual(100);
	});

	it("does nothing and touches no mail service when there is no work", async () => {
		const h = harness();
		const result = await dispatchDueSequenceEmails(h.env);
		expect(result).toEqual({ sent: 0, skipped: 0, suppressed: 0, failed: 0 });
		expect(h.sent).toHaveLength(0);
	});
});
