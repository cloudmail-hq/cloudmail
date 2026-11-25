/**
 * AI triage and Screener settings for one mailbox.
 *
 * Saves itself, like the rules above it: the switches patch the settings blob
 * (`triage`, `screener`) and the label rows call the prompt API, each as soon
 * as it changes. Presets come first because they are what most people want;
 * custom label prompts sit below for anything the presets do not cover.
 */

import { useEffect, useState } from "react";
import { Inbox as InboxIcon, Sparkles, UserCheck } from "lucide-react";
import {
	LABEL_PROMPT_MAX_LENGTH,
	MAX_DAILY_AI_CAP,
	MOVE_TARGET_FORBIDDEN,
	SALES_PITCH_FOLDER,
	type TriagePresetKey,
} from "shared/ai-triage";
import { cn } from "~/lib/utils";
import { errorMessage, showToast } from "~/lib/toast";
import { useFolders } from "~/queries/folders";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import {
	useBackfillTriage,
	useLabelPrompts,
	useSetLabelPrompt,
	useSetTriagePreset,
} from "~/queries/triage";
import type { LabelPrompt } from "~/types";

function Switch({
	checked,
	onChange,
	label,
	disabled,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	label: string;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 touch:before:absolute touch:before:-inset-3 touch:before:content-['']",
				checked ? "bg-violet" : "bg-bg-muted",
			)}
		>
			<span
				className={cn(
					"absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
					checked ? "translate-x-[18px]" : "translate-x-0.5",
				)}
			/>
		</button>
	);
}

function Check({
	checked,
	onChange,
	label,
	disabled,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	label: string;
	disabled?: boolean;
}) {
	return (
		<label className={cn("inline-flex cursor-pointer items-center gap-1.5 text-xs text-text-secondary touch:min-h-11", disabled && "opacity-50")}>
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={(e) => onChange(e.target.checked)}
				className="accent-[var(--color-accent)]"
			/>
			{label}
		</label>
	);
}

/** Where an auto-label's matches go: stay in the Inbox, or a folder. */
function MoveSelect({
	mailboxId,
	value,
	onChange,
	label,
	disabled,
}: {
	mailboxId: string;
	value: string | null | undefined;
	onChange: (folder: string | null) => void;
	label: string;
	disabled?: boolean;
}) {
	const { data: folders } = useFolders(mailboxId);
	const options = (folders ?? []).filter((f) => !MOVE_TARGET_FORBIDDEN.includes(f.id) && f.id !== "archive");
	if (!options.some((f) => f.id === SALES_PITCH_FOLDER.id)) options.push({ id: SALES_PITCH_FOLDER.id, name: `${SALES_PITCH_FOLDER.name} (new)` } as never);
	return (
		<label className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
			<span>Move to</span>
			<select
				aria-label={label}
				value={value ?? ""}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value || null)}
				className="h-8 rounded-[6px] border border-border bg-card px-2 text-xs text-text-primary touch:h-11"
			>
				<option value="">Keep in Inbox</option>
				{options.map((f) => (
					<option key={f.id} value={f.id}>
						{f.name}
					</option>
				))}
			</select>
		</label>
	);
}

function PromptRow({ mailboxId, label }: { mailboxId: string; label: LabelPrompt }) {
	const setPrompt = useSetLabelPrompt();
	const [draft, setDraft] = useState(label.prompt ?? "");
	useEffect(() => setDraft(label.prompt ?? ""), [label.prompt]);
	const dirty = draft.trim() !== (label.prompt ?? "");
	const save = (patch: { prompt?: string | null; auto_archive?: boolean; show_tab?: boolean; move_to_folder?: string | null }) =>
		setPrompt.mutate(
			{ mailboxId, labelId: label.id, patch },
			{ onError: (err) => showToast({ kind: "error", message: errorMessage(err, "Could not save the label.") }) },
		);
	return (
		<li className="flex flex-col gap-2 py-3">
			<div className="flex items-center gap-2">
				<span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
				<span className="min-w-0 truncate text-sm font-medium text-text-primary">{label.name}</span>
			</div>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					maxLength={LABEL_PROMPT_MAX_LENGTH}
					placeholder="Describe the mail for this label, e.g. Customer bug reports"
					aria-label={`Prompt for ${label.name}`}
					className="h-9 min-w-0 flex-1 rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:ring-2 focus:ring-ring/30"
				/>
				<button
					type="button"
					disabled={!dirty || setPrompt.isPending}
					onClick={() => save({ prompt: draft.trim() ? draft.trim() : null })}
					className="inline-flex h-9 shrink-0 items-center justify-center rounded-[6px] border border-border px-3 text-xs font-semibold text-text-primary hover:bg-bg-muted disabled:opacity-40 touch:h-11"
				>
					Save prompt
				</button>
			</div>
			<div className="flex flex-wrap gap-x-4">
				<Check checked={label.show_tab} onChange={(v) => save({ show_tab: v })} label="Inbox tab" disabled={setPrompt.isPending} />
				<Check checked={label.auto_archive} onChange={(v) => save({ auto_archive: v })} label="Skip the Inbox" disabled={setPrompt.isPending} />
				<MoveSelect
					mailboxId={mailboxId}
					value={label.move_to_folder}
					onChange={(v) => save({ move_to_folder: v })}
					label={`Folder for ${label.name}`}
					disabled={setPrompt.isPending}
				/>
			</div>
		</li>
	);
}

export default function TriageSettings({ mailboxId }: { mailboxId: string }) {
	const { data: mailbox } = useMailbox(mailboxId);
	const update = useUpdateMailbox();
	const { data: view } = useLabelPrompts(mailboxId);
	const setPreset = useSetTriagePreset();
	const backfill = useBackfillTriage();
	const [cap, setCap] = useState("");

	const triage = mailbox?.settings?.triage ?? { enabled: false, dailyAiCap: 200, screenerVerdict: true };
	const screener = mailbox?.settings?.screener ?? "off";
	useEffect(() => setCap(String(triage.dailyAiCap)), [triage.dailyAiCap]);

	const patch = (settings: { triage?: Partial<typeof triage>; screener?: "off" | "unknown_only" }) =>
		update.mutate(
			{ mailboxId, settings },
			{ onError: (err) => showToast({ kind: "error", message: errorMessage(err, "Could not save.") }) },
		);

	const togglePreset = (
		key: TriagePresetKey,
		body: { enabled: boolean; auto_archive?: boolean; show_tab?: boolean; move_to_folder?: string | null },
	) =>
		setPreset.mutate(
			{ mailboxId, key, body },
			{ onError: (err) => showToast({ kind: "error", message: errorMessage(err, "Could not change the preset.") }) },
		);

	const runBackfill = () =>
		backfill.mutate(
			{ mailboxId },
			{
				onSuccess: (r) =>
					showToast({
						kind: "success",
						message: r.capped
							? `Labelled ${r.classified} of ${r.processed}. Daily AI cap reached.`
							: `Labelled ${r.classified} of ${r.processed}. ${r.remaining} left.`,
					}),
				onError: (err) => showToast({ kind: "error", message: errorMessage(err, "Backfill failed.") }),
			},
		);

	const presetLabelIds = new Set((view?.presets ?? []).map((p) => p.label_id).filter(Boolean));
	const customLabels = (view?.labels ?? []).filter((l) => !presetLabelIds.has(l.id));

	return (
		<section id="triage" className="scroll-mt-20 rounded-[8px] border border-border bg-card p-5">
			<div className="mb-4 flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
						<Sparkles size={15} className="text-text-tertiary" aria-hidden />
						AI triage
					</h2>
					<p className="mt-1 text-sm text-text-secondary">
						New mail gets the labels whose description fits, in one AI call per message. Rules always win,
						and Spam and Trash are never touched. Newsletters, notifications and billing mail are recognised
						from their headers without a model call. A label with a folder moves its mail there only when the
						AI is sure, and never mail from people you have written to or replies in your conversations.
					</p>
				</div>
				<Switch checked={triage.enabled} onChange={(v) => patch({ triage: { enabled: v } })} label="AI triage" />
			</div>

			<div className={cn("space-y-5", !triage.enabled && "opacity-60")}>
				<fieldset>
					<legend className="mb-1 text-xs font-medium text-text-secondary">Presets</legend>
					<ul className="divide-y divide-border rounded-[6px] border border-border">
						{(view?.presets ?? []).map((p) => (
							<li key={p.key} className="flex flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
								<div className="min-w-0 flex-1">
									<p className="text-sm font-medium text-text-primary">{p.name}</p>
									<p className="text-[11px] text-text-secondary">{p.prompt}</p>
								</div>
								<div className="flex shrink-0 items-center justify-end gap-3">
									{p.enabled && (
										<>
											<Check
												checked={p.show_tab}
												onChange={(v) => togglePreset(p.key, { enabled: true, show_tab: v })}
												label="Tab"
											/>
											<Check
												checked={p.auto_archive}
												onChange={(v) => togglePreset(p.key, { enabled: true, auto_archive: v })}
												label="Skip Inbox"
											/>
											<MoveSelect
												mailboxId={mailboxId}
												value={p.move_to_folder}
												onChange={(v) => togglePreset(p.key, { enabled: true, move_to_folder: v })}
												label={`Folder for ${p.name}`}
												disabled={setPreset.isPending}
											/>
										</>
									)}
									<Switch
										checked={p.enabled}
										onChange={(v) => togglePreset(p.key, { enabled: v })}
										label={`${p.name} preset`}
										disabled={setPreset.isPending}
									/>
								</div>
							</li>
						))}
					</ul>
				</fieldset>

				{customLabels.length > 0 && (
					<div>
						<p className="text-xs font-medium text-text-secondary">Your labels</p>
						<p className="text-[11px] text-text-tertiary">
							Give a label a short description to have AI apply it. Leave it empty to keep it manual.
						</p>
						<ul className="divide-y divide-border">
							{customLabels.map((l) => (
								<PromptRow key={l.id} mailboxId={mailboxId} label={l} />
							))}
						</ul>
					</div>
				)}

				<div className="flex flex-col gap-3 rounded-[6px] bg-bg-subtle p-3 sm:flex-row sm:items-end">
					<label className="flex flex-col gap-1 text-xs text-text-secondary">
						Daily AI limit
						<input
							type="number"
							inputMode="numeric"
							min={0}
							max={MAX_DAILY_AI_CAP}
							value={cap}
							onChange={(e) => setCap(e.target.value)}
							onBlur={() => {
								const n = Math.max(0, Math.min(MAX_DAILY_AI_CAP, Math.floor(Number(cap) || 0)));
								if (n !== triage.dailyAiCap) patch({ triage: { dailyAiCap: n } });
							}}
							className="h-9 w-28 rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-ring/30"
						/>
					</label>
					<p className="min-w-0 flex-1 text-[11px] text-text-secondary">
						{view ? `${view.ai_calls_today} of ${view.daily_ai_cap} calls used today (UTC). ` : ""}
						Each message costs 2: a safety scan and the classifier. Past the limit, mail is still
						delivered, just not labelled.
					</p>
					<button
						type="button"
						onClick={runBackfill}
						disabled={!triage.enabled || backfill.isPending}
						className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[6px] border border-border bg-card px-3 text-xs font-semibold text-text-primary hover:bg-bg-muted disabled:opacity-40 touch:h-11"
					>
						<InboxIcon size={13} aria-hidden />
						{backfill.isPending ? "Labelling…" : "Label recent mail"}
					</button>
				</div>
				{view && view.backfill_remaining > 0 && triage.enabled && (
					<p className="-mt-3 text-[11px] text-text-tertiary">
						{view.backfill_remaining} message{view.backfill_remaining === 1 ? "" : "s"} from the last 14 days not
						yet labelled.
					</p>
				)}
			</div>

			<div className="mt-6 border-t border-border pt-5">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
							<UserCheck size={14} className="text-text-tertiary" aria-hidden />
							Screener
						</h3>
						<p className="mt-1 text-sm text-text-secondary">
							First-time senders wait in the Screener until you say Yes or No. People you have written to,
							replies in your threads, allowlisted senders and this domain's own mailboxes always reach the
							Inbox.
						</p>
					</div>
					<Switch
						checked={screener === "unknown_only"}
						onChange={(v) => patch({ screener: v ? "unknown_only" : "off" })}
						label="Screener"
					/>
				</div>
				<div className="mt-3">
					<Check
						checked={triage.screenerVerdict}
						onChange={(v) => patch({ triage: { screenerVerdict: v } })}
						label="Show an AI guess for each sender, e.g. Looks like cold sales"
						disabled={screener !== "unknown_only"}
					/>
				</div>
			</div>
		</section>
	);
}
