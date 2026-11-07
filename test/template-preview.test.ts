import { describe, expect, it } from "vitest";
import {
	COMMON_VARIABLES,
	extractVariables,
	insertVariableAt,
	needsHtmlMode,
	renderPreview,
	sampleValue,
	variableChips,
} from "../app/lib/template-preview";

describe("template preview helpers", () => {
	it("extracts distinct variables in first-seen order", () => {
		expect(extractVariables("Hi {{first_name}}", "<p>{{company_name}} {{first_name}}</p>")).toEqual([
			"first_name",
			"company_name",
		]);
		expect(extractVariables("no vars", "{{ spaced }} {{bad-dash}}")).toEqual([]);
	});

	it("offers used variables first, then the common ones without duplicates", () => {
		expect(variableChips(["plan", "first_name"])).toEqual([
			"plan",
			"first_name",
			...COMMON_VARIABLES.filter((v) => v !== "first_name"),
		]);
	});

	it("substitutes known samples and readable stand-ins", () => {
		expect(renderPreview("Hi {{first_name}}, your {{plan_name}}")).toBe("Hi Alex, your plan name");
		expect(renderPreview("{{first_name}}", { values: { first_name: "Sam" } })).toBe("Sam");
		expect(sampleValue("company_name")).toBe("Acme Inc.");
	});

	it("escapes values into HTML bodies only", () => {
		const values = { first_name: "<b>x</b>" };
		expect(renderPreview("<p>{{first_name}}</p>", { html: true, values })).toBe("<p>&lt;b&gt;x&lt;/b&gt;</p>");
		expect(renderPreview("{{first_name}}", { values })).toBe("<b>x</b>");
	});

	it("inserts a token at the selection and reports the caret", () => {
		expect(insertVariableAt("Hello !", "first_name", 6)).toEqual({ text: "Hello {{first_name}}!", caret: 20 });
		expect(insertVariableAt("Hello NAME!", "x", 6, 10)).toEqual({ text: "Hello {{x}}!", caret: 11 });
		expect(insertVariableAt("ab", "x", 99)).toEqual({ text: "ab{{x}}", caret: 7 });
	});

	it("keeps hand-written layout HTML in source mode", () => {
		expect(needsHtmlMode("<p>Hi <strong>{{first_name}}</strong></p><ul><li>x</li></ul>")).toBe(false);
		expect(needsHtmlMode("")).toBe(false);
		expect(needsHtmlMode('<p style="color:red">x</p>')).toBe(true);
		expect(needsHtmlMode("<div>x</div>")).toBe(true);
		expect(needsHtmlMode('<table width="600"><tr><td>x</td></tr></table>')).toBe(true);
		expect(needsHtmlMode("<style>p{}</style>")).toBe(true);
	});
});
