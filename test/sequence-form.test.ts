import { describe, expect, it } from "vitest";
import { formatDelay, sequenceBlockers, stepsSummary } from "../app/lib/sequence-form";
import { slugify } from "../app/lib/template-preview";

describe("sequence form helpers", () => {
	it("counts only steps with a template", () => {
		expect(stepsSummary([{ templateSlug: "", delayHours: 0 }])).toBe(
			"0 steps yet. Pick a template for the first step.",
		);
		expect(stepsSummary([{ templateSlug: "a", delayHours: 0 }])).toBe("1 step · sends immediately.");
		expect(
			stepsSummary([
				{ templateSlug: "a", delayHours: 0 },
				{ templateSlug: "b", delayHours: 72 },
				{ templateSlug: "", delayHours: 24 },
			]),
		).toBe("2 steps · spans 3 days end-to-end.");
	});

	it("explains why saving is blocked", () => {
		expect(sequenceBlockers("", [{ templateSlug: "", delayHours: 0 }])).toEqual([
			"Name required",
			"Pick a template for the step",
		]);
		expect(
			sequenceBlockers("Onboarding", [
				{ templateSlug: "a", delayHours: 0 },
				{ templateSlug: "", delayHours: 1 },
			]),
		).toEqual(["Pick a template for every step"]);
		expect(sequenceBlockers("Onboarding", [])).toEqual(["Add at least one step"]);
		expect(sequenceBlockers("Onboarding", [{ templateSlug: "a", delayHours: 0 }])).toEqual([]);
	});

	it("formats delays", () => {
		expect(formatDelay(0)).toBe("immediately");
		expect(formatDelay(5)).toBe("5h");
		expect(formatDelay(24)).toBe("1 day");
		expect(formatDelay(36)).toBe("1.5 days");
	});

	it("slugifies template names", () => {
		expect(slugify("  Welcome Email!! v2 ")).toBe("welcome-email-v2");
		expect(slugify("---")).toBe("");
	});
});
