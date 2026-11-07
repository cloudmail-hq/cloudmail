// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Routing for one gateway: a model per role, the default model, the
 * embeddings choice, the Active switch and the Workers AI fallback.
 */

import { AlertTriangle, Loader2, Lock } from "lucide-react";
import { Children, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import {
	routingProblemsFrom,
	usePatchAiRouting,
	type EmbeddingsMode,
	type ProvidersResponse,
	type ProviderView,
} from "~/queries/ai-providers";
import type { AiRole, CatalogModel } from "../../../../shared/ai-providers";
import type { RoleProblem } from "../../../../shared/ai-gateway";
import { ConfirmDialog, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from "../settings-ui";
import {
	draftProblems,
	hostOf,
	modelsForNeed,
	needsEmbeddingsChoice,
	problemsByRole,
	routingDraftFrom,
	routingPatch,
	type RoutingDraft,
} from "./logic";
import { errorMessage, RADIO_CLASS, RADIO_ROW_CLASS, SELECT_CLASS, TOUCH, TouchSwitch } from "./shared";

export function RoutingCard({ provider, data }: { provider: ProviderView; data: ProvidersResponse }) {
	const save = usePatchAiRouting();
	// Keyed on content: a refetch after Test or Discover returns a new object
	// with the same routing, and must not wipe unsaved picks.
	const savedKey = JSON.stringify(routingDraftFrom(data.routing));
	const saved = useMemo(() => JSON.parse(savedKey) as RoutingDraft, [savedKey]);
	const [draft, setDraft] = useState<RoutingDraft>(saved);
	const [serverProblems, setServerProblems] = useState<RoleProblem[] | null>(null);
	const [confirmSwitch, setConfirmSwitch] = useState(false);
	// A refetch after save (or another admin's change) resets the draft.
	useEffect(() => setDraft(saved), [saved]);

	// Discard or Save unmounts the unsaved bar with focus on one of its buttons,
	// which drops focus to <body>. Browsers fire no blur on removal, so the flag
	// stays set and focus moves to the card's heading instead.
	const headingRef = useRef<HTMLHeadingElement>(null);
	const focusInBar = useRef(false);

	const isActive = data.routing.gatewayProviderId === provider.id;
	const rows = data.roles.filter((r) => !r.pinned);
	const pinned = data.roles.filter((r) => r.pinned);
	const roleIds = data.roles.map((r) => r.role);
	const chatModels = modelsForNeed(provider.models, "text");
	const embedModels = modelsForNeed(provider.models, "embed");
	const showEmbedChoice = needsEmbeddingsChoice(provider.models, provider.wire);
	const showEmbedPicker = provider.wire === "openai" && embedModels.length > 0;

	const patch = routingPatch(saved, draft, roleIds);
	const dirty = Object.keys(patch).length > 0;
	useEffect(() => {
		if (!dirty && focusInBar.current) {
			focusInBar.current = false;
			if (document.activeElement === document.body || document.activeElement === null) headingRef.current?.focus();
		}
	}, [dirty]);
	const live = draftProblems(draft, provider.models, provider.wire, roleIds);
	const rowProblem = problemsByRole(serverProblems ?? live);
	// Activation checks what is saved: the server's verdict when this gateway is
	// active, else the same rule run here on the saved routing.
	const savedProblems = isActive ? data.problems : draftProblems(saved, provider.models, provider.wire, roleIds);
	const canActivate = savedProblems.length === 0 && !dirty && provider.enabled;

	function setRole(role: AiRole, modelId: string) {
		setServerProblems(null);
		setDraft((d) => ({ ...d, models: { ...d.models, [role]: modelId } }));
	}

	async function submit() {
		try {
			await save.mutateAsync(patch);
			setServerProblems(null);
			toast.success("Routing saved");
		} catch (e) {
			const problems = routingProblemsFrom(e);
			if (problems) setServerProblems(problems);
			else toast.error(errorMessage(e, "Couldn't save routing."));
		}
	}

	async function setActive(on: boolean) {
		try {
			await save.mutateAsync({ gatewayProviderId: on ? provider.id : null });
			toast.success(on ? `${provider.label} is active` : "AI runs on Workers AI");
		} catch (e) {
			const problems = routingProblemsFrom(e);
			if (problems) setServerProblems(problems);
			toast.error(errorMessage(e, "Couldn't change the active provider."));
		}
	}

	async function setFallback(on: boolean) {
		try {
			await save.mutateAsync({ fallbackToWorkersAi: on });
		} catch (e) {
			toast.error(errorMessage(e, "Couldn't save that."));
		}
	}

	return (
		<div className="space-y-4 rounded-[8px] bg-card p-4 ring-1 ring-border sm:p-5">
			<div className="flex items-center justify-between gap-3">
				<h3 ref={headingRef} tabIndex={-1} className="min-w-0 text-sm font-semibold text-text-primary focus:outline-none">
					Routing <span className="font-normal text-text-tertiary">· {provider.label}</span>
				</h3>
				{save.isPending ? <Loader2 size={13} className="animate-spin text-text-tertiary" aria-label="Saving" /> : null}
			</div>

			<ConfirmDialog
				open={confirmSwitch}
				onOpenChange={(o) => !o && setConfirmSwitch(false)}
				title={`Switch to ${provider.label}?`}
				description={`Every AI feature except the prompt-injection scanner${data.routing.embeddingsMode === "gateway" ? "" : " and embeddings"} sends mail content to ${hostOf(provider.baseUrl)}. Only one provider is active at a time; Workers AI stays one click away.`}
				confirmLabel="Switch"
				destructive={false}
				pending={save.isPending}
				onConfirm={async () => {
					setConfirmSwitch(false);
					await setActive(true);
				}}
			/>
			<SwitchRow
				title="Active provider"
				// "Active provider" alone doesn't say which provider the switch activates.
				label={`Active provider: ${provider.label}`}
				checked={isActive}
				onChange={(on) => (on ? setConfirmSwitch(true) : void setActive(false))}
				disabled={save.isPending || (!isActive && !canActivate)}
			>
				{!isActive && savedProblems.length > 0 ? (
					<p className="mt-1 text-xs text-text-secondary">
						{savedProblems.length === 1 ? "1 role has no usable model yet:" : `${savedProblems.length} roles have no usable model yet:`}
					</p>
				) : null}
				{!isActive && savedProblems.length > 0 ? (
					<ul className="mt-1 space-y-0.5 text-xs text-warning-text">
						{savedProblems.map((p) => (
							<li key={p.role}>
								{data.roles.find((r) => r.role === p.role)?.label ?? p.role}: {p.reason}
							</li>
						))}
					</ul>
				) : !isActive && dirty ? (
					<p className="mt-1 text-xs text-text-tertiary">Save routing first.</p>
				) : !provider.enabled ? (
					<p className="mt-1 text-xs text-text-tertiary">Provider is turned off.</p>
				) : null}
			</SwitchRow>

			<ul className="divide-y divide-border/60 rounded-[6px] ring-1 ring-border">
				<li className="grid gap-1.5 p-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:items-center sm:gap-3">
					<span className="text-sm font-medium text-text-primary">Default model</span>
					<ModelSelect
						label="Default model"
						value={draft.default}
						models={chatModels}
						emptyLabel="None"
						onChange={(v) => {
							setServerProblems(null);
							setDraft((d) => ({ ...d, default: v }));
						}}
					/>
				</li>
				{rows.map((r) => {
					if (r.role === "embeddings" && !showEmbedPicker) return null;
					const problem = rowProblem[r.role];
					return (
						<li key={r.role} className="grid gap-1.5 p-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:items-start sm:gap-3">
							<span className="text-sm text-text-primary sm:pt-2">{r.label}</span>
							<div className="min-w-0 space-y-1">
								<ModelSelect
									label={r.label}
									value={draft.models[r.role] ?? ""}
									models={r.needs === "embed" ? embedModels : chatModels}
									emptyLabel={r.needs === "embed" ? "None" : "Default model"}
									invalid={!!problem}
									onChange={(v) => setRole(r.role, v)}
								/>
								{problem ? (
									<p className="flex items-start gap-1 text-xs text-warning-text">
										<AlertTriangle size={12} className="mt-px shrink-0" aria-hidden />
										{problem}
									</p>
								) : null}
							</div>
						</li>
					);
				})}
				{pinned.map((r) => (
					<li key={r.role} className="grid gap-1.5 p-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:items-center sm:gap-3">
						<span className="text-sm text-text-primary">{r.label}</span>
						{/* Same box as a select (height, 1px border + px-2) so the text lines up with the pickers above. */}
						<span className="inline-flex h-9 items-center gap-1.5 border border-transparent px-2 text-sm text-text-secondary touch:h-11">
							Workers AI (always)
							<Lock size={12} aria-hidden />
						</span>
					</li>
				))}
			</ul>

			{showEmbedChoice ? (
				<EmbeddingsChoice
					value={draft.models.embeddings ? "gateway" : draft.embeddings}
					problem={!draft.models.embeddings ? rowProblem.embeddings : undefined}
					onChange={(mode) => {
						setServerProblems(null);
						setDraft((d) => ({ ...d, embeddings: mode, models: { ...d.models, embeddings: "" } }));
					}}
				/>
			) : null}

			{/* Always in the tree, so a screen reader hears the change; the bar below is what's seen. */}
			<p role="status" className="sr-only">
				{dirty ? "Unsaved routing changes" : ""}
			</p>
			{/*
			  Only with unsaved picks: a disabled primary reads grey, so it isn't shown
			  idle. Sticky above the phone tab bar while the card is in view, so a pick
			  at the top of the list still shows it.
			*/}
			{dirty ? (
				<div
					data-unsaved-bar
					onFocus={() => {
						focusInBar.current = true;
					}}
					onBlur={(e) => {
						if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusInBar.current = false;
					}}
					className="sticky bottom-[calc(var(--app-tabbar-h)+0.75rem)] z-10 flex flex-wrap items-center justify-between gap-2 rounded-[8px] bg-card px-3 py-2 shadow-md ring-1 ring-border"
				>
					<span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
						<span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning-text" />
						Unsaved changes
					</span>
					<div className="flex gap-2">
						<button
							type="button"
							disabled={save.isPending}
							onClick={() => {
								setServerProblems(null);
								setDraft(saved);
							}}
							className={cn(SECONDARY_BUTTON_CLASS, "text-text-secondary", TOUCH)}
						>
							Discard
						</button>
						<button type="button" disabled={save.isPending} onClick={() => void submit()} className={cn(PRIMARY_BUTTON_CLASS, TOUCH)}>
							{save.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
							Save routing
						</button>
					</div>
				</div>
			) : null}

			<SwitchRow
				title="Fall back to Workers AI"
				checked={data.routing.fallbackToWorkersAi}
				onChange={(on) => void setFallback(on)}
				disabled={save.isPending}
			>
				<p className="mt-1 text-xs text-text-secondary">
					If your gateway fails, AI features pause. Turn this on to send those requests to Workers AI instead.
				</p>
			</SwitchRow>
		</div>
	);
}

function ModelSelect({
	label,
	value,
	models,
	emptyLabel,
	invalid,
	onChange,
}: {
	label: string;
	value: string;
	models: CatalogModel[];
	emptyLabel: string;
	invalid?: boolean;
	onChange: (id: string) => void;
}) {
	const known = !value || models.some((m) => m.id === value);
	return (
		<select
			aria-label={label}
			value={value}
			aria-invalid={invalid || undefined}
			onChange={(e) => onChange(e.target.value)}
			className={SELECT_CLASS}
		>
			<option value="">{emptyLabel}</option>
			{known ? null : <option value={value}>{value} (not listed)</option>}
			{models.map((m) => (
				<option key={m.id} value={m.id}>
					{m.id}
				</option>
			))}
		</select>
	);
}

function EmbeddingsChoice({
	value,
	problem,
	onChange,
}: {
	value: EmbeddingsMode;
	problem?: string;
	onChange: (mode: EmbeddingsMode) => void;
}) {
	const name = useId();
	const options: { mode: EmbeddingsMode; label: string; note?: string }[] = [
		{
			mode: "workers-ai",
			label: "Workers AI (stated exception)",
			note: "Search indexing sends message text to Workers AI for embeddings.",
		},
		{ mode: "off", label: "Semantic search off" },
	];
	return (
		<fieldset className="space-y-2">
			<legend className="text-sm font-medium text-text-primary">Embeddings</legend>
			<div className="space-y-1.5">
				{options.map((o) => (
					<label
						key={o.mode}
						className={RADIO_ROW_CLASS}
					>
						<input
							type="radio"
							name={name}
							className={RADIO_CLASS}
							checked={value === o.mode}
							onChange={() => onChange(o.mode)}
						/>
						<span className="min-w-0">
							<span className="block text-sm text-text-primary">{o.label}</span>
							{o.note ? <span className="block text-xs text-text-secondary">{o.note}</span> : null}
						</span>
					</label>
				))}
			</div>
			{problem ? (
				<p className="flex items-start gap-1 text-xs text-warning-text">
					<AlertTriangle size={12} className="mt-px shrink-0" aria-hidden />
					{problem}
				</p>
			) : null}
		</fieldset>
	);
}

function SwitchRow({
	title,
	label,
	checked,
	onChange,
	disabled,
	children,
}: {
	title: string;
	/** Accessible name when the title alone lacks context. Starts with the title, so voice control still matches it. */
	label?: string;
	checked: boolean;
	onChange: (on: boolean) => void;
	disabled?: boolean;
	children?: React.ReactNode;
}) {
	const id = useId();
	const descId = useId();
	const described = Children.toArray(children).length > 0;
	return (
		<div className="flex items-start justify-between gap-4">
			<div className="min-w-0">
				<span id={id} className="text-sm font-medium text-text-primary">
					{title}
				</span>
				{/* The note under the title (why it can't be turned on, what it does) describes the switch. */}
				{/* Several `cond ? … : null` children make an array of nulls, which is truthy: count real nodes. */}
				{described ? <div id={descId}>{children}</div> : null}
			</div>
			<TouchSwitch
				checked={checked}
				onCheckedChange={onChange}
				disabled={disabled}
				{...(label ? { "aria-label": label } : { "aria-labelledby": id })}
				aria-describedby={described ? descId : undefined}
			/>
		</div>
	);
}
