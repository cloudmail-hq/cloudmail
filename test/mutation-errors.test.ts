import { describe, expect, it } from "vitest";
import { errorMessage, mutationFailureMessage } from "~/lib/toast";
import { ApiError } from "~/services/api";
import { labelIdsWith } from "~/queries/labels";

describe("errorMessage", () => {
	it("keeps a server's own explanation", () => {
		expect(errorMessage(new ApiError(400, { error: "Mailbox already exists" }), "Could not create.")).toBe(
			"Mailbox already exists",
		);
	});

	it("turns the browser's network error into words", () => {
		expect(errorMessage(new TypeError("Failed to fetch"), "Could not star.")).toBe(
			"Could not star. Check your connection and try again.",
		);
	});

	it("hides a bare status line and says when the server failed", () => {
		expect(errorMessage(new ApiError(503, {}), "Could not star.")).toBe(
			"Could not star. The server had a problem; try again in a moment.",
		);
		expect(errorMessage(new ApiError(404, {}), "Could not star.")).toBe("Could not star.");
	});

	it("falls back for things that are not errors", () => {
		expect(errorMessage("nope", "Could not star.")).toBe("Could not star.");
	});
});

describe("mutationFailureMessage", () => {
	it("toasts only for mutations that opted in", () => {
		expect(mutationFailureMessage(undefined, new Error("x"))).toBeNull();
		expect(mutationFailureMessage({}, new Error("x"))).toBeNull();
		expect(mutationFailureMessage({ errorMessage: "Could not change the labels." }, new TypeError("Failed to fetch"))).toBe(
			"Could not change the labels. Check your connection and try again.",
		);
	});
});

describe("labelIdsWith", () => {
	it("adds without dropping the labels already applied", () => {
		expect(labelIdsWith([{ id: "a" }, { id: "b" }], "c")).toEqual(["a", "b", "c"]);
	});

	it("does not duplicate a label that is already there", () => {
		expect(labelIdsWith([{ id: "a" }], "a")).toEqual(["a"]);
	});
});
