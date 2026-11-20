// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Inbound filter rules.
 *
 * The matcher is easy; precedence is not. These pin down the parts that decide
 * what actually happens to a message when several rules have an opinion about
 * it: order, last-writer-wins on single-valued effects, accumulation on
 * set-valued ones, and `stop_processing`.
 */

import { describe, expect, it } from "vitest";
import {
	evaluateRules,
	matchesCondition,
	matchesRule,
	type Rule,
	type RuleMessage,
} from "../shared/rules";

const message: RuleMessage = {
	from: "Alice <alice@vendor.example>",
	to: ["hello@example.com"],
	cc: ["team@example.com"],
	subject: "Invoice 4821 for March",
	body: "Payment is due within 30 days. Thanks!",
	hasAttachment: true,
};

function rule(overrides: Partial<Rule> = {}): Rule {
	return {
		id: "r1",
		name: "Rule",
		enabled: true,
		sort_order: 0,
		match_type: "all",
		conditions: [{ field: "subject", operator: "contains", value: "invoice" }],
		actions: [{ type: "mark_read" }],
		stop_processing: false,
		...overrides,
	};
}

describe("matchesCondition", () => {
	it("matches case-insensitively on substring", () => {
		expect(
			matchesCondition(message, {
				field: "subject",
				operator: "contains",
				value: "INVOICE",
			}),
		).toBe(true);
	});

	it("treats an empty value as unconfigured rather than matching everything", () => {
		// `not_contains ""` would otherwise be vacuously true and silently apply
		// the rule's actions to all incoming mail.
		expect(
			matchesCondition(message, {
				field: "subject",
				operator: "not_contains",
				value: "",
			}),
		).toBe(false);
		expect(
			matchesCondition(message, {
				field: "subject",
				operator: "contains",
				value: "   ",
			}),
		).toBe(false);
	});

	it("compares the sender domain, tolerating a leading @", () => {
		for (const value of ["vendor.example", "@vendor.example"]) {
			expect(
				matchesCondition(message, {
					field: "from",
					operator: "domain_is",
					value,
				}),
			).toBe(true);
		}
		expect(
			matchesCondition(message, {
				field: "from",
				operator: "domain_is",
				value: "other.example",
			}),
		).toBe(false);
	});

	it("searches To and Cc together for `recipient`", () => {
		expect(
			matchesCondition(message, {
				field: "recipient",
				operator: "contains",
				value: "team@example.com",
			}),
		).toBe(true);
	});

	it("reads has_attachment as a boolean, ignoring the value", () => {
		expect(
			matchesCondition(message, {
				field: "has_attachment",
				operator: "is_true",
			}),
		).toBe(true);
		expect(
			matchesCondition(
				{ ...message, hasAttachment: false },
				{ field: "has_attachment", operator: "is_true" },
			),
		).toBe(false);
	});

	it("anchors starts_with and ends_with", () => {
		expect(
			matchesCondition(message, {
				field: "subject",
				operator: "starts_with",
				value: "invoice",
			}),
		).toBe(true);
		expect(
			matchesCondition(message, {
				field: "subject",
				operator: "ends_with",
				value: "march",
			}),
		).toBe(true);
		expect(
			matchesCondition(message, {
				field: "subject",
				operator: "ends_with",
				value: "invoice",
			}),
		).toBe(false);
	});
});

describe("matchesRule", () => {
	it("requires every condition for match_type all", () => {
		const r = rule({
			conditions: [
				{ field: "subject", operator: "contains", value: "invoice" },
				{ field: "from", operator: "domain_is", value: "other.example" },
			],
		});
		expect(matchesRule(message, r)).toBe(false);
	});

	it("requires one condition for match_type any", () => {
		const r = rule({
			match_type: "any",
			conditions: [
				{ field: "subject", operator: "contains", value: "invoice" },
				{ field: "from", operator: "domain_is", value: "other.example" },
			],
		});
		expect(matchesRule(message, r)).toBe(true);
	});

	it("never matches a disabled rule or one with no conditions", () => {
		expect(matchesRule(message, rule({ enabled: false }))).toBe(false);
		expect(matchesRule(message, rule({ conditions: [] }))).toBe(false);
	});
});

describe("evaluateRules", () => {
	it("returns an inert outcome when nothing matches", () => {
		const outcome = evaluateRules(
			[rule({ conditions: [{ field: "subject", operator: "contains", value: "receipt" }] })],
			message,
		);
		expect(outcome).toEqual({
			labelIds: [],
			markRead: false,
			star: false,
			skipAutoDraft: false,
			matchedRuleIds: [],
		});
	});

	it("applies actions from a matching rule", () => {
		const outcome = evaluateRules(
			[
				rule({
					actions: [
						{ type: "move_to_folder", value: "archive" },
						{ type: "apply_label", value: "label-invoices" },
						{ type: "mark_read" },
						{ type: "star" },
						{ type: "set_priority", value: "low" },
						{ type: "skip_auto_draft" },
					],
				}),
			],
			message,
		);

		expect(outcome).toEqual({
			folder: "archive",
			labelIds: ["label-invoices"],
			markRead: true,
			star: true,
			priority: "low",
			skipAutoDraft: true,
			matchedRuleIds: ["r1"],
		});
	});

	it("runs in sort_order, with the later rule winning the folder", () => {
		const outcome = evaluateRules(
			[
				rule({
					id: "second",
					sort_order: 2,
					actions: [{ type: "move_to_folder", value: "archive" }],
				}),
				rule({
					id: "first",
					sort_order: 1,
					actions: [{ type: "move_to_folder", value: "spam" }],
				}),
			],
			message,
		);

		expect(outcome.matchedRuleIds).toEqual(["first", "second"]);
		expect(outcome.folder).toBe("archive");
	});

	it("accumulates labels across rules without duplicating", () => {
		const outcome = evaluateRules(
			[
				rule({ id: "a", sort_order: 1, actions: [{ type: "apply_label", value: "x" }] }),
				rule({ id: "b", sort_order: 2, actions: [{ type: "apply_label", value: "x" }] }),
				rule({ id: "c", sort_order: 3, actions: [{ type: "apply_label", value: "y" }] }),
			],
			message,
		);
		expect(outcome.labelIds).toEqual(["x", "y"]);
	});

	it("stops after a rule that says so", () => {
		const outcome = evaluateRules(
			[
				rule({
					id: "first",
					sort_order: 1,
					stop_processing: true,
					actions: [{ type: "move_to_folder", value: "archive" }],
				}),
				rule({
					id: "second",
					sort_order: 2,
					actions: [{ type: "move_to_folder", value: "trash" }],
				}),
			],
			message,
		);

		expect(outcome.matchedRuleIds).toEqual(["first"]);
		expect(outcome.folder).toBe("archive");
	});

	it("maps the trash action to the trash folder", () => {
		const outcome = evaluateRules(
			[rule({ actions: [{ type: "trash" }] })],
			message,
		);
		expect(outcome.folder).toBe("trash");
	});

	it("ignores an unusable priority value", () => {
		const outcome = evaluateRules(
			[rule({ actions: [{ type: "set_priority", value: "urgent" }] })],
			message,
		);
		expect(outcome.priority).toBeUndefined();
	});

	it("breaks sort_order ties deterministically by id", () => {
		const outcome = evaluateRules(
			[
				rule({ id: "b", sort_order: 0, actions: [{ type: "move_to_folder", value: "b" }] }),
				rule({ id: "a", sort_order: 0, actions: [{ type: "move_to_folder", value: "a" }] }),
			],
			message,
		);
		expect(outcome.matchedRuleIds).toEqual(["a", "b"]);
		expect(outcome.folder).toBe("b");
	});
});
