// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Inbound filter rules.
 *
 * Shared between the Worker (which applies them as mail arrives) and the
 * settings UI (which builds and validates them), so the two cannot disagree
 * about what a rule means.
 *
 * The evaluator is deliberately pure: it takes a description of a message and
 * returns what should happen to it, with no database or network access. That
 * makes the interesting part — precedence between rules — testable without
 * standing up a mailbox.
 */

/** Message parts a condition can look at. */
export type RuleField =
	| "from"
	| "to"
	| "cc"
	| "recipient"
	| "subject"
	| "body"
	| "has_attachment";

export type RuleOperator =
	| "contains"
	| "not_contains"
	| "equals"
	| "starts_with"
	| "ends_with"
	| "domain_is"
	| "is_true";

export interface RuleCondition {
	field: RuleField;
	operator: RuleOperator;
	/** Ignored by `is_true`. Compared case-insensitively. */
	value?: string;
}

/**
 * What a matching rule does.
 *
 * Deliberately excludes forwarding: an inbound rule that re-sends mail is how
 * you build a mail loop between two mailboxes, and the mailbox-level forward
 * setting already covers the legitimate case with loop detection.
 */
export type RuleActionType =
	| "move_to_folder"
	| "apply_label"
	| "mark_read"
	| "star"
	| "trash"
	| "set_priority"
	| "skip_auto_draft";

export interface RuleAction {
	type: RuleActionType;
	/** Folder id, label id, or "high" | "low" depending on `type`. */
	value?: string;
}

export interface Rule {
	id: string;
	name: string;
	enabled: boolean;
	/** Lower runs first. */
	sort_order: number;
	/** Whether every condition must match, or just one. */
	match_type: "all" | "any";
	conditions: RuleCondition[];
	actions: RuleAction[];
	/** When true, no later rule is considered once this one matches. */
	stop_processing: boolean;
}

/** The parts of an inbound message a rule can be evaluated against. */
export interface RuleMessage {
	from: string;
	/** Every To recipient, already lowercased by the caller or not — we fold. */
	to: string[];
	cc: string[];
	subject: string;
	/** Plain text or HTML; matched as a flat string either way. */
	body: string;
	hasAttachment: boolean;
}

/** The net effect of every rule that matched, in rule order. */
export interface RuleOutcome {
	/** Target folder, if any rule moved the message. Last writer wins. */
	folder?: string;
	labelIds: string[];
	markRead: boolean;
	star: boolean;
	priority?: "high" | "low";
	/** True when a rule asked the agent to leave this message alone. */
	skipAutoDraft: boolean;
	matchedRuleIds: string[];
}

const EMPTY_OUTCOME: RuleOutcome = {
	labelIds: [],
	markRead: false,
	star: false,
	skipAutoDraft: false,
	matchedRuleIds: [],
};

/** Longest allowed condition value, to bound the work a single rule can do. */
export const MAX_RULE_VALUE_LENGTH = 500;
/** Most rules one mailbox may hold. Keeps inbound evaluation predictable. */
export const MAX_RULES = 100;
/** Most conditions or actions on a single rule. */
export const MAX_RULE_CLAUSES = 20;

/**
 * Pull the bare address out of `Name <addr@host>` as well as a raw address.
 *
 * Inbound headers carry either form, and a domain comparison against the
 * display-name form would otherwise compare against `host>`.
 */
function addressOf(value: string): string {
	const angled = value.match(/<([^>]+)>/);
	return (angled ? angled[1] : value).trim().toLowerCase();
}

function domainOf(address: string): string {
	const bare = addressOf(address);
	const at = bare.lastIndexOf("@");
	return at === -1 ? "" : bare.slice(at + 1);
}

/** Flatten the field a condition reads into one comparable string. */
function fieldValue(message: RuleMessage, field: RuleField): string {
	switch (field) {
		case "from":
			return message.from;
		case "to":
			return message.to.join(", ");
		case "cc":
			return message.cc.join(", ");
		case "recipient":
			// "recipient" is the practical field: users think "was I on this
			// message", not "was I in To or Cc".
			return [...message.to, ...message.cc].join(", ");
		case "subject":
			return message.subject;
		case "body":
			return message.body;
		case "has_attachment":
			return message.hasAttachment ? "true" : "false";
	}
}

export function matchesCondition(
	message: RuleMessage,
	condition: RuleCondition,
): boolean {
	const haystack = (fieldValue(message, condition.field) ?? "").toLowerCase();
	const needle = (condition.value ?? "").trim().toLowerCase();

	switch (condition.operator) {
		case "is_true":
			// Only meaningful for boolean fields; anything non-empty counts as set.
			return condition.field === "has_attachment"
				? message.hasAttachment
				: haystack.length > 0;
		case "contains":
			return needle === "" ? false : haystack.includes(needle);
		case "not_contains":
			// An empty needle would make this vacuously true and quietly match
			// every message, so it is treated as unconfigured instead.
			return needle === "" ? false : !haystack.includes(needle);
		case "equals":
			return haystack.trim() === needle;
		case "starts_with":
			return needle === "" ? false : haystack.trimStart().startsWith(needle);
		case "ends_with":
			return needle === "" ? false : haystack.trimEnd().endsWith(needle);
		case "domain_is": {
			if (needle === "") return false;
			const wanted = needle.replace(/^@/, "");
			const addresses =
				condition.field === "from"
					? [message.from]
					: condition.field === "cc"
						? message.cc
						: condition.field === "to" || condition.field === "recipient"
							? [...message.to, ...(condition.field === "recipient" ? message.cc : [])]
							: [haystack];
			return addresses.some((address) => domainOf(address) === wanted);
		}
	}
}

export function matchesRule(message: RuleMessage, rule: Rule): boolean {
	if (!rule.enabled) return false;
	// A rule with no conditions would match everything, which is never what
	// someone meant to build.
	if (rule.conditions.length === 0) return false;

	return rule.match_type === "any"
		? rule.conditions.some((condition) => matchesCondition(message, condition))
		: rule.conditions.every((condition) => matchesCondition(message, condition));
}

/**
 * Fold every matching rule into a single outcome.
 *
 * Rules run in `sort_order`. Later rules override earlier ones for
 * single-valued effects (folder, priority) and accumulate for set-valued ones
 * (labels, flags), which is the behaviour people expect from a rule list read
 * top to bottom. `stop_processing` ends the pass.
 */
export function evaluateRules(rules: Rule[], message: RuleMessage): RuleOutcome {
	const ordered = [...rules].sort(
		(a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id),
	);

	const outcome: RuleOutcome = {
		...EMPTY_OUTCOME,
		labelIds: [],
		matchedRuleIds: [],
	};

	for (const rule of ordered) {
		if (!matchesRule(message, rule)) continue;
		outcome.matchedRuleIds.push(rule.id);

		for (const action of rule.actions) {
			switch (action.type) {
				case "move_to_folder":
					if (action.value) outcome.folder = action.value;
					break;
				case "trash":
					// Trash is a folder move with a fixed target, expressed as its own
					// action so the UI does not have to teach folder ids.
					outcome.folder = "trash";
					break;
				case "apply_label":
					if (action.value && !outcome.labelIds.includes(action.value)) {
						outcome.labelIds.push(action.value);
					}
					break;
				case "mark_read":
					outcome.markRead = true;
					break;
				case "star":
					outcome.star = true;
					break;
				case "set_priority":
					if (action.value === "high" || action.value === "low") {
						outcome.priority = action.value;
					}
					break;
				case "skip_auto_draft":
					outcome.skipAutoDraft = true;
					break;
			}
		}

		if (rule.stop_processing) break;
	}

	return outcome;
}

/** Human summary for the rule list, e.g. "Subject contains invoice → Archive". */
export function describeCondition(condition: RuleCondition): string {
	const field: Record<RuleField, string> = {
		from: "From",
		to: "To",
		cc: "Cc",
		recipient: "Any recipient",
		subject: "Subject",
		body: "Body",
		has_attachment: "Attachment",
	};
	const operator: Record<RuleOperator, string> = {
		contains: "contains",
		not_contains: "does not contain",
		equals: "is",
		starts_with: "starts with",
		ends_with: "ends with",
		domain_is: "domain is",
		is_true: "is present",
	};

	const head = `${field[condition.field]} ${operator[condition.operator]}`;
	return condition.operator === "is_true"
		? head
		: `${head} “${condition.value ?? ""}”`;
}

export function describeAction(action: RuleAction): string {
	switch (action.type) {
		case "move_to_folder":
			return `Move to ${action.value ?? "folder"}`;
		case "apply_label":
			return "Apply label";
		case "mark_read":
			return "Mark as read";
		case "star":
			return "Star";
		case "trash":
			return "Move to Trash";
		case "set_priority":
			return `Set priority ${action.value ?? ""}`.trim();
		case "skip_auto_draft":
			return "Skip auto-draft";
	}
}
