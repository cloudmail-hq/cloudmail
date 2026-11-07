/**
 * Filter rules editor.
 *
 * Rules run in order on inbound mail, so the list is ordered and the order is
 * editable. Everything is expressed in the same vocabulary as the evaluator in
 * `shared/rules.ts` — no separate client-side notion of what a rule means.
 */

import { useMemo, useState } from "react";
import {
	ArrowDown,
	ArrowUp,
	Filter,
	Pencil,
	Plus,
	Trash2,
	X,
} from "lucide-react";
import {
	MAX_RULE_CLAUSES,
	describeAction,
	describeCondition,
	type Rule,
	type RuleAction,
	type RuleActionType,
	type RuleCondition,
	type RuleField,
	type RuleOperator,
} from "shared/rules";
import { getFolderDisplayName } from "shared/folders";
import { errorMessage, showToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { useFolders } from "~/queries/folders";
import { useLabels } from "~/queries/labels";
import {
	useCreateRule,
	useDeleteRule,
	useReorderRules,
	useUpdateRule,
	useRules,
} from "~/queries/rules";

const FIELDS: { value: RuleField; label: string }[] = [
	{ value: "from", label: "From" },
	{ value: "to", label: "To" },
	{ value: "cc", label: "Cc" },
	{ value: "recipient", label: "Any recipient" },
	{ value: "subject", label: "Subject" },
	{ value: "body", label: "Body" },
	{ value: "has_attachment", label: "Has attachment" },
];

const OPERATORS: { value: RuleOperator; label: string }[] = [
	{ value: "contains", label: "contains" },
	{ value: "not_contains", label: "does not contain" },
	{ value: "equals", label: "is exactly" },
	{ value: "starts_with", label: "starts with" },
	{ value: "ends_with", label: "ends with" },
	{ value: "domain_is", label: "domain is" },
	{ value: "is_true", label: "is present" },
];

const ACTIONS: { value: RuleActionType; label: string; needs?: "folder" | "label" | "priority" }[] = [
	{ value: "move_to_folder", label: "Move to folder", needs: "folder" },
	{ value: "apply_label", label: "Apply label", needs: "label" },
	{ value: "mark_read", label: "Mark as read" },
	{ value: "star", label: "Star" },
	{ value: "trash", label: "Move to Trash" },
	{ value: "set_priority", label: "Set priority", needs: "priority" },
	{ value: "skip_auto_draft", label: "Skip auto-draft" },
];

interface Draft {
	id?: string;
	name: string;
	match_type: "all" | "any";
	conditions: RuleCondition[];
	actions: RuleAction[];
	stop_processing: boolean;
	enabled: boolean;
}

function emptyDraft(): Draft {
	return {
		name: "",
		match_type: "all",
		conditions: [{ field: "from", operator: "contains", value: "" }],
		actions: [{ type: "move_to_folder", value: "archive" }],
		stop_processing: false,
		enabled: true,
	};
}

function toDraft(rule: Rule): Draft {
	return {
		id: rule.id,
		name: rule.name,
		match_type: rule.match_type,
		conditions: rule.conditions.length > 0
			? rule.conditions
			: [{ field: "from", operator: "contains", value: "" }],
		actions: rule.actions.length > 0 ? rule.actions : [{ type: "mark_read" }],
		stop_processing: rule.stop_processing,
		enabled: rule.enabled,
	};
}

const selectClass =
	"rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15";

export default function RulesSettings({ mailboxId }: { mailboxId: string }) {
	// `isPending` so the empty message waits for the first answer instead of
	// claiming "No rules yet" while they load.
	const { data: rules = [], isPending: rulesPending } = useRules(mailboxId);
	const { data: folders = [] } = useFolders(mailboxId);
	const { data: labels = [] } = useLabels(mailboxId);

	const createRule = useCreateRule();
	const updateRule = useUpdateRule();
	const deleteRule = useDeleteRule();
	const reorderRules = useReorderRules();

	const [draft, setDraft] = useState<Draft | null>(null);

	const labelName = useMemo(
		() => new Map(labels.map((label) => [label.id, label.name])),
		[labels],
	);

	/** Render an action using names the user recognises, not stored ids. */
	const describeStoredAction = (action: RuleAction): string => {
		if (action.type === "apply_label") {
			return `Apply label ${labelName.get(action.value ?? "") ?? "(deleted)"}`;
		}
		if (action.type === "move_to_folder") {
			const folder = folders.find((f) => f.id === action.value);
			return `Move to ${folder?.name ?? getFolderDisplayName(action.value ?? "")}`;
		}
		return describeAction(action);
	};

	const move = (index: number, delta: -1 | 1) => {
		const next = [...rules];
		const target = index + delta;
		if (target < 0 || target >= next.length) return;
		[next[index], next[target]] = [next[target], next[index]];
		reorderRules.mutate({ mailboxId, ids: next.map((rule) => rule.id) });
	};

	const save = () => {
		if (!draft) return;

		// A condition with no value never matches, and an action with no target
		// does nothing — both would look configured while being inert.
		const conditions = draft.conditions.filter(
			(condition) =>
				condition.operator === "is_true" || (condition.value ?? "").trim() !== "",
		);
		const actions = draft.actions.filter((action) => {
			const spec = ACTIONS.find((a) => a.value === action.type);
			return !spec?.needs || (action.value ?? "").trim() !== "";
		});

		if (conditions.length === 0) {
			showToast({ kind: "error", message: "Add at least one condition." });
			return;
		}
		if (actions.length === 0) {
			showToast({ kind: "error", message: "Add at least one action." });
			return;
		}

		const payload = {
			name: draft.name.trim() || "Untitled rule",
			match_type: draft.match_type,
			conditions,
			actions,
			stop_processing: draft.stop_processing,
			enabled: draft.enabled,
		};

		const onError = (err: unknown) =>
			showToast({
				kind: "error",
				message: errorMessage(err, "Could not save that rule."),
			});

		if (draft.id) {
			updateRule.mutate(
				{ mailboxId, ruleId: draft.id, patch: payload },
				{ onSuccess: () => setDraft(null), onError },
			);
		} else {
			createRule.mutate(
				{ mailboxId, rule: payload },
				{ onSuccess: () => setDraft(null), onError },
			);
		}
	};

	return (
		<section className="rounded-[10px] border border-border bg-card p-4">
			<div className="mb-3 flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="flex items-center gap-1.5 text-sm font-bold text-text-primary">
						<Filter size={14} className="text-text-tertiary" />
						Filter rules
					</h2>
					<p className="mt-1 text-sm text-text-secondary">
						Applied to mail as it arrives, top to bottom. Rules do not touch mail
						already in the mailbox.
					</p>
				</div>
				<button
					type="button"
					onClick={() => setDraft(emptyDraft())}
					className="inline-flex shrink-0 items-center gap-1 rounded-[6px] border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-muted"
				>
					<Plus size={12} />
					New rule
				</button>
			</div>

			<ul className="space-y-2">
				{rules.map((rule, index) => (
					<li
						key={rule.id}
						className={cn(
							"rounded-[8px] border border-border bg-bg-subtle/50 px-2.5 py-2",
							!rule.enabled && "opacity-60",
						)}
					>
						<div className="flex items-start gap-2">
							<div className="flex shrink-0 flex-col">
								<button
									type="button"
									onClick={() => move(index, -1)}
									disabled={index === 0 || reorderRules.isPending}
									aria-label="Move rule earlier"
									className="rounded-[4px] p-0.5 text-text-tertiary hover:bg-bg-muted disabled:opacity-30"
								>
									<ArrowUp size={11} />
								</button>
								<button
									type="button"
									onClick={() => move(index, 1)}
									disabled={index === rules.length - 1 || reorderRules.isPending}
									aria-label="Move rule later"
									className="rounded-[4px] p-0.5 text-text-tertiary hover:bg-bg-muted disabled:opacity-30"
								>
									<ArrowDown size={11} />
								</button>
							</div>

							<div className="min-w-0 flex-1">
								<div className="flex flex-wrap items-baseline gap-x-2">
									<span className="truncate text-xs font-semibold text-text-primary">
										{rule.name}
									</span>
									{!rule.enabled && (
										<span className="rounded-[4px] bg-bg-muted px-1.5 text-[10px] font-semibold text-text-tertiary">
											Off
										</span>
									)}
									{rule.stop_processing && (
										<span className="rounded-[4px] bg-accent-subtle px-1.5 text-[11px] font-semibold text-accent-subtle-fg">
											Stops here
										</span>
									)}
								</div>
								<p className="mt-0.5 text-xs text-text-secondary">
									{rule.match_type === "any" ? "Any of: " : ""}
									{rule.conditions.map(describeCondition).join(
										rule.match_type === "any" ? " or " : " and ",
									)}
								</p>
								<p className="mt-0.5 text-[11px] font-medium text-text-secondary">
									→ {rule.actions.map(describeStoredAction).join(", ")}
								</p>
							</div>

							<div className="flex shrink-0 items-center gap-1">
								<button
									type="button"
									onClick={() =>
										updateRule.mutate({
											mailboxId,
											ruleId: rule.id,
											patch: { enabled: !rule.enabled },
										})
									}
									className="rounded-[6px] border border-border bg-card px-2 py-0.5 text-[10px] font-medium text-text-secondary hover:bg-bg-muted"
								>
									{rule.enabled ? "Disable" : "Enable"}
								</button>
								<button
									type="button"
									onClick={() => setDraft(toDraft(rule))}
									aria-label={`Edit ${rule.name}`}
									className="rounded-[6px] p-1 text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
								>
									<Pencil size={12} />
								</button>
								<button
									type="button"
									onClick={() => {
										if (!window.confirm(`Delete the rule "${rule.name}"?`)) return;
										deleteRule.mutate({ mailboxId, ruleId: rule.id });
									}}
									aria-label={`Delete ${rule.name}`}
									className="rounded-[6px] p-1 text-text-tertiary hover:bg-destructive/10 hover:text-destructive"
								>
									<Trash2 size={12} />
								</button>
							</div>
						</div>
					</li>
				))}
				{rules.length === 0 && !draft && rulesPending && (
					<li aria-busy="true" className="h-10 animate-pulse rounded-[6px] bg-bg-muted" />
				)}
				{rules.length === 0 && !draft && !rulesPending && (
					<li className="text-sm text-text-tertiary">
						No rules yet. A rule can file, label, flag or silence mail before you
						ever see it.
					</li>
				)}
			</ul>

			{draft && (
				<form
					className="mt-3 space-y-3 rounded-[8px] border border-border bg-card p-3"
					onSubmit={(e) => {
						e.preventDefault();
						save();
					}}
				>
					<div className="flex items-center gap-2">
						<input
							autoFocus
							value={draft.name}
							onChange={(e) => setDraft({ ...draft, name: e.target.value })}
							placeholder="Rule name — e.g. File invoices"
							aria-label="Rule name"
							className="min-w-0 flex-1 rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15"
						/>
						<button
							type="button"
							onClick={() => setDraft(null)}
							aria-label="Cancel"
							className="rounded-[6px] p-1 text-text-tertiary hover:text-text-primary"
						>
							<X size={13} />
						</button>
					</div>

					{/* Conditions */}
					<div className="space-y-1.5">
						<div className="flex items-center gap-2">
							<span className="text-xs font-medium text-text-secondary">
								When
							</span>
							<select
								value={draft.match_type}
								onChange={(e) =>
									setDraft({
										...draft,
										match_type: e.target.value as "all" | "any",
									})
								}
								aria-label="Match type"
								className={selectClass}
							>
								<option value="all">all conditions match</option>
								<option value="any">any condition matches</option>
							</select>
						</div>

						{draft.conditions.map((condition, index) => (
							<div key={index} className="flex flex-wrap items-center gap-1.5">
								<select
									value={condition.field}
									onChange={(e) => {
										const next = [...draft.conditions];
										const field = e.target.value as RuleField;
										next[index] = {
											...condition,
											field,
											// The boolean field only supports presence.
											operator:
												field === "has_attachment" ? "is_true" : condition.operator,
										};
										setDraft({ ...draft, conditions: next });
									}}
									aria-label="Field"
									className={selectClass}
								>
									{FIELDS.map((field) => (
										<option key={field.value} value={field.value}>
											{field.label}
										</option>
									))}
								</select>

								<select
									value={condition.operator}
									onChange={(e) => {
										const next = [...draft.conditions];
										next[index] = {
											...condition,
											operator: e.target.value as RuleOperator,
										};
										setDraft({ ...draft, conditions: next });
									}}
									aria-label="Operator"
									className={selectClass}
								>
									{OPERATORS.filter(
										(operator) =>
											condition.field !== "has_attachment" ||
											operator.value === "is_true",
									).map((operator) => (
										<option key={operator.value} value={operator.value}>
											{operator.label}
										</option>
									))}
								</select>

								{condition.operator !== "is_true" && (
									<input
										value={condition.value ?? ""}
										onChange={(e) => {
											const next = [...draft.conditions];
											next[index] = { ...condition, value: e.target.value };
											setDraft({ ...draft, conditions: next });
										}}
										placeholder="value"
										aria-label="Value"
										className="min-w-[140px] flex-1 rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15"
									/>
								)}

								{draft.conditions.length > 1 && (
									<button
										type="button"
										onClick={() =>
											setDraft({
												...draft,
												conditions: draft.conditions.filter((_, i) => i !== index),
											})
										}
										aria-label="Remove condition"
										className="rounded-[6px] p-1 text-text-tertiary hover:text-destructive"
									>
										<X size={12} />
									</button>
								)}
							</div>
						))}

						{draft.conditions.length < MAX_RULE_CLAUSES && (
							<button
								type="button"
								onClick={() =>
									setDraft({
										...draft,
										conditions: [
											...draft.conditions,
											{ field: "subject", operator: "contains", value: "" },
										],
									})
								}
								className="text-[11px] font-medium text-violet hover:underline"
							>
								+ Add condition
							</button>
						)}
					</div>

					{/* Actions */}
					<div className="space-y-1.5">
						<span className="text-xs font-medium text-text-secondary">
							Then
						</span>

						{draft.actions.map((action, index) => {
							const spec = ACTIONS.find((a) => a.value === action.type);
							return (
								<div key={index} className="flex flex-wrap items-center gap-1.5">
									<select
										value={action.type}
										onChange={(e) => {
											const type = e.target.value as RuleActionType;
											const nextSpec = ACTIONS.find((a) => a.value === type);
											const next = [...draft.actions];
											next[index] = {
												type,
												value:
													nextSpec?.needs === "folder"
														? (folders[0]?.id ?? "archive")
														: nextSpec?.needs === "label"
															? (labels[0]?.id ?? "")
															: nextSpec?.needs === "priority"
																? "high"
																: undefined,
											};
											setDraft({ ...draft, actions: next });
										}}
										aria-label="Action"
										className={selectClass}
									>
										{ACTIONS.map((a) => (
											<option key={a.value} value={a.value}>
												{a.label}
											</option>
										))}
									</select>

									{spec?.needs === "folder" && (
										<select
											value={action.value ?? ""}
											onChange={(e) => {
												const next = [...draft.actions];
												next[index] = { ...action, value: e.target.value };
												setDraft({ ...draft, actions: next });
											}}
											aria-label="Folder"
											className={selectClass}
										>
											{folders.map((folder) => (
												<option key={folder.id} value={folder.id}>
													{folder.name}
												</option>
											))}
										</select>
									)}

									{spec?.needs === "label" && (
										<select
											value={action.value ?? ""}
											onChange={(e) => {
												const next = [...draft.actions];
												next[index] = { ...action, value: e.target.value };
												setDraft({ ...draft, actions: next });
											}}
											aria-label="Label"
											className={selectClass}
										>
											{labels.length === 0 && <option value="">No labels yet</option>}
											{labels.map((label) => (
												<option key={label.id} value={label.id}>
													{label.name}
												</option>
											))}
										</select>
									)}

									{spec?.needs === "priority" && (
										<select
											value={action.value ?? "high"}
											onChange={(e) => {
												const next = [...draft.actions];
												next[index] = { ...action, value: e.target.value };
												setDraft({ ...draft, actions: next });
											}}
											aria-label="Priority"
											className={selectClass}
										>
											<option value="high">High</option>
											<option value="low">Low</option>
										</select>
									)}

									{draft.actions.length > 1 && (
										<button
											type="button"
											onClick={() =>
												setDraft({
													...draft,
													actions: draft.actions.filter((_, i) => i !== index),
												})
											}
											aria-label="Remove action"
											className="rounded-[6px] p-1 text-text-tertiary hover:text-destructive"
										>
											<X size={12} />
										</button>
									)}
								</div>
							);
						})}

						{draft.actions.length < MAX_RULE_CLAUSES && (
							<button
								type="button"
								onClick={() =>
									setDraft({
										...draft,
										actions: [...draft.actions, { type: "mark_read" }],
									})
								}
								className="text-[11px] font-medium text-violet hover:underline"
							>
								+ Add action
							</button>
						)}
					</div>

					<label className="flex items-center gap-2 text-[11px] text-text-secondary">
						<input
							type="checkbox"
							checked={draft.stop_processing}
							onChange={(e) =>
								setDraft({ ...draft, stop_processing: e.target.checked })
							}
							className="h-3.5 w-3.5 accent-violet"
						/>
						Stop processing further rules when this one matches
					</label>

					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={() => setDraft(null)}
							className="rounded-[6px] border border-border px-2.5 py-1.5 text-[11px] font-medium text-text-secondary"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={createRule.isPending || updateRule.isPending}
							className="inline-flex h-9 shrink-0 items-center rounded-[6px] bg-accent px-3.5 text-[13px] font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
						>
							{draft.id ? "Save rule" : "Create rule"}
						</button>
					</div>
				</form>
			)}
		</section>
	);
}
