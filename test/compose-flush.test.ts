import { describe, expect, it } from "vitest";
import { shouldFlushDraftOnClose, type ComposeFlushState } from "~/lib/compose-flush";

const base: ComposeFlushState = {
	dispatched: false,
	loadingAttachments: false,
	snapshot: JSON.stringify(["a@example.com", "", "", "Hi", "<p>Hello</p>"]),
	savedSnapshot: null,
	attachmentsChanged: false,
	hasContent: true,
};

describe("shouldFlushDraftOnClose", () => {
	it("saves typing that autosave has not written yet", () => {
		expect(shouldFlushDraftOnClose(base)).toBe(true);
	});

	it("saves when only the attachments changed", () => {
		expect(
			shouldFlushDraftOnClose({ ...base, savedSnapshot: base.snapshot, attachmentsChanged: true }),
		).toBe(true);
	});

	it("does nothing when the last autosave already holds the fields", () => {
		expect(shouldFlushDraftOnClose({ ...base, savedSnapshot: base.snapshot })).toBe(false);
	});

	it("never re-creates a message that was sent, scheduled or discarded", () => {
		expect(shouldFlushDraftOnClose({ ...base, dispatched: true })).toBe(false);
	});

	it("does not save an empty composer", () => {
		expect(shouldFlushDraftOnClose({ ...base, hasContent: false })).toBe(false);
	});

	it("waits for a reopened draft's attachments, which would otherwise be dropped", () => {
		expect(shouldFlushDraftOnClose({ ...base, loadingAttachments: true })).toBe(false);
	});
});
