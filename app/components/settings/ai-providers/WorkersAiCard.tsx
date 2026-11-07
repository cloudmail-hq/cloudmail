// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The built-in provider's models: one row per role with its Workers AI model,
 * a picker fed by the live catalogue (filtered by task), capability badges,
 * Test, Reset to default, and a warning when the model is no longer listed.
 * The scanner row is locked. Changing embeddings asks for confirmation.
 */

import { AlertTriangle, Check, Loader2, Lock, Play, RotateCcw, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { toast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import {
	routingProblemsFrom,
	usePatchWorkersAiRouting,
	useTestWorkersAiModel,
	useWorkersAiModels,
	type ProvidersResponse,
	type TestResult,
	type WorkersAiRoleView,
} from "~/queries/ai-providers";
import type { AiRole, WorkersAiTested } from "../../../../shared/ai-providers";
import {
	UNLISTED_NOTE,
	checkWorkersAiPick,
	contextLabel,
	modelsForRole,
	needsReindexConfirm,
	priceLabel,
	unlistedModel,
	withTested,
	type WorkersAiModel,
} from "../../../../shared/workers-ai";
import { ApiError } from "~/services/api";
import { ROLE_NEEDS, type RoleNeed } from "../../../../shared/ai-gateway";
import { ConfirmDialog, SECONDARY_BUTTON_CLASS, SETTINGS_INPUT_CLASS } from "../settings-ui";
import { errorMessage, SELECT_CLASS, TOUCH } from "./shared";

const CUSTOM = "__custom__";
const RESET = "__reset__";

export function WorkersAiCard({ data, active }: { data: ProvidersResponse; active: boolean }) {
	const catalogue = useWorkersAiModels();
	const models = catalogue.data?.models ?? [];
	const unlisted = useMemo(
		() => new Map((catalogue.data?.roles ?? []).map((r) => [r.role, r.unlisted] as const)),
		[catalogue.data],
	);
	const labels = useMemo(() => new Map(data.roles.map((r) => [r.role, r.label] as const)), [data.roles]);
	// Same order as the routing table: every role, the scanner last.
	const rows = [...data.workersAi.roles].sort((a, b) => Number(a.locked) - Number(b.locked));

	return (
		<div className="space-y-3 rounded-[8px] bg-card p-4 ring-1 ring-border sm:p-5">
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<h3 className="text-sm font-semibold text-text-primary">
					Models <span className="font-normal text-text-tertiary">· Cloudflare Workers AI</span>
				</h3>
				<span className="text-xs text-text-secondary">
					{catalogue.isLoading
						? "Loading catalogue…"
						: catalogue.data?.source === "live"
							? `${catalogue.data.count} models listed`
							: catalogue.data
								? "Built-in list"
								: null}
				</span>
			</div>
			{!active ? (
				<p className="text-xs text-text-secondary">Used for roles that run on Workers AI: the scanner, exceptions and fallback.</p>
			) : null}
			{catalogue.data?.source === "fallback" && catalogue.data.detail ? (
				<p className="flex items-start gap-1.5 text-xs text-text-secondary">
					<AlertTriangle size={12} className="mt-px shrink-0 text-warning-text" aria-hidden />
					{catalogue.data.detail}
				</p>
			) : null}
			<ul className="divide-y divide-border/60 rounded-[6px] ring-1 ring-border">
				{rows.map((r) => (
					<RoleRow
						key={r.role}
						row={r}
						label={labels.get(r.role) ?? r.role}
						models={models}
						tested={data.workersAi.tested}
						unlisted={unlisted.get(r.role) ?? null}
					/>
				))}
			</ul>
		</div>
	);
}

function RoleRow({
	row,
	label,
	models,
	tested,
	unlisted,
}: {
	row: WorkersAiRoleView;
	label: string;
	models: WorkersAiModel[];
	tested: ProvidersResponse["workersAi"]["tested"];
	unlisted: { successor: string | null } | null;
}) {
	const save = usePatchWorkersAiRouting();
	const test = useTestWorkersAiModel();
	const [custom, setCustom] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	/** The embeddings change waiting for confirmation; `RESET` means the default. */
	const [confirm, setConfirm] = useState<string | null>(null);
	const [results, setResults] = useState<TestResult[] | null>(null);
	/** A pick refused until Test verifies it: Test then runs on it, and a pass applies it. */
	const [candidate, setCandidate] = useState<string | null>(null);
	const customId = useId();

	const options = modelsForRole(models, row.role);
	const current = options.find((m) => m.id === row.modelId) ?? unlistedModel(row.modelId, row.role, tested[row.modelId]);
	const model = withTested(current, tested[row.modelId]);
	const busy = save.isPending || test.isPending;

	async function pick(modelId: string | null, confirmReindex = false, freshTest?: WorkersAiTested | null) {
		setProblem(null);
		setCandidate(null);
		// A reset to the default can change the vector space too.
		if (modelId === null && row.role === "embeddings" && row.defaultModelId !== row.modelId && !confirmReindex) {
			return setConfirm(RESET);
		}
		// Check here first, so the reason shows without a round trip.
		if (modelId) {
			const listed = models.find((m) => m.id === modelId);
			const evidence = freshTest ?? tested[modelId];
			const candidate = listed ? withTested(listed, evidence) : unlistedModel(modelId, row.role, evidence);
			const verdict = checkWorkersAiPick(row.role, { model: candidate, current: row.modelId, confirmReindex });
			if (!verdict.ok) {
				if (needsReindexConfirm(verdict)) return setConfirm(modelId);
				if (/Run Test/.test(verdict.reason)) setCandidate(modelId);
				return setProblem(verdict.reason);
			}
		}
		try {
			await save.mutateAsync({ models: { [row.role]: modelId } as Partial<Record<AiRole, string | null>>, confirmReindex });
			setCustom(null);
			setResults(null);
			toast.success(modelId ? `${label}: ${shortId(modelId)}` : `${label}: default model`);
		} catch (e) {
			const code = e instanceof ApiError ? e.body.code : null;
			if (code === "reindex_confirm_required" && modelId) return setConfirm(modelId);
			const problems = routingProblemsFrom(e);
			if (problems?.length) setProblem(problems[0]!.reason);
			else toast.error(errorMessage(e, "Couldn't save that."));
		}
	}

	async function runTest() {
		const target = candidate ?? row.modelId;
		try {
			const { results: r, tested: fresh } = await test.mutateAsync({ modelId: target });
			setResults(r);
			// Apply with the result just returned; the page query may not have refetched yet.
			if (candidate) await pick(candidate, false, fresh);
		} catch (e) {
			toast.error(errorMessage(e, "Couldn't run the test."));
		}
	}

	return (
		<li className="space-y-2 p-3">
			<div className="grid gap-1.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:items-start sm:gap-3">
				<span className="text-sm text-text-primary sm:pt-2">{label}</span>
				<div className="min-w-0 space-y-1.5">
					{row.locked ? (
						<span className="inline-flex min-h-9 items-center gap-1.5 border border-transparent px-2 font-mono text-xs text-text-secondary touch:min-h-11">
							<Lock size={12} aria-hidden />
							{shortId(row.modelId)}
						</span>
					) : (
						<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
							<select
								aria-label={`${label} model`}
								value={custom !== null ? CUSTOM : row.modelId}
								disabled={busy}
								aria-invalid={!!problem || undefined}
								onChange={(e) => {
									const v = e.target.value;
									if (v === CUSTOM) return setCustom("");
									setCustom(null);
									// Save exactly what was chosen. Reset is the separate button: it can mean SUMMARY_MODEL.
									if (v !== row.modelId) void pick(v);
								}}
								className={cn(SELECT_CLASS, "text-[13px] sm:flex-1 sm:font-mono sm:text-xs")}
							>
								{options.some((m) => m.id === row.modelId) ? null : (
									<option value={row.modelId}>
										{shortId(row.modelId)}
										{row.modelId === row.defaultModelId ? " (default)" : ""}
									</option>
								)}
								{options.map((m) => (
									<option key={m.id} value={m.id}>
										{shortId(m.id)}
										{m.id === row.defaultModelId ? " (default)" : ""}
									</option>
								))}
								<option value={CUSTOM}>Custom model id…</option>
							</select>
							<div className="flex shrink-0 items-center gap-1">
								<button
									type="button"
									onClick={() => void runTest()}
									disabled={busy}
									className={cn(SECONDARY_BUTTON_CLASS, "h-8 px-2.5", TOUCH)}
								>
									{test.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Play size={13} aria-hidden />}
									{candidate ? <span>Test {shortId(candidate).split("/").pop()}</span> : "Test"}
								</button>
								{row.source === "admin" ? (
									<button
										type="button"
										onClick={() => void pick(null)}
										disabled={busy}
										title={`Reset to ${shortId(row.defaultModelId)}`}
										aria-label={`Reset ${label} to the default model`}
										className={cn(SECONDARY_BUTTON_CLASS, "h-8 px-2.5", TOUCH)}
									>
										<RotateCcw size={13} aria-hidden />
										<span className="sm:sr-only">Reset</span>
									</button>
								) : null}
							</div>
						</div>
					)}
					{custom !== null ? (
						<form
							className="flex gap-2"
							onSubmit={(e) => {
								e.preventDefault();
								const v = custom.trim();
								if (v) void pick(v);
							}}
						>
							<label htmlFor={customId} className="sr-only">
								Custom Workers AI model id
							</label>
							<input
								id={customId}
								value={custom}
								onChange={(e) => setCustom(e.target.value)}
								placeholder="@cf/vendor/model"
								spellCheck={false}
								autoFocus
								maxLength={200}
								className={cn(SETTINGS_INPUT_CLASS, "font-mono text-xs touch:h-11")}
							/>
							<button type="submit" disabled={busy} className={cn(SECONDARY_BUTTON_CLASS, TOUCH)}>
								Use
							</button>
							<button
								type="button"
								onClick={() => setCustom(null)}
								aria-label="Cancel custom model"
								className={cn(SECONDARY_BUTTON_CLASS, "px-2.5", TOUCH)}
							>
								<X size={13} aria-hidden />
							</button>
						</form>
					) : null}
					{row.locked ? null : <Badges model={model} need={ROLE_NEEDS[row.role]} />}
					{row.locked ? <p className="text-xs text-text-secondary">Always this model. Not configurable.</p> : null}
					{row.source === "env" ? <p className="text-xs text-text-tertiary">Set by SUMMARY_MODEL.</p> : null}
					{unlisted ? (
						<p className="flex flex-col items-start gap-0.5 text-xs text-warning-text sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2">
							<span className="inline-flex items-start gap-1">
								<AlertTriangle size={12} className="mt-px shrink-0" aria-hidden />
								{UNLISTED_NOTE}
							</span>
							{unlisted.successor && !row.locked ? (
								<button
									type="button"
									disabled={busy}
									onClick={() => void pick(unlisted.successor)}
									className="rounded-[4px] font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50 touch:min-h-11 touch:-my-1"
								>
									Use {shortId(unlisted.successor)}
								</button>
							) : null}
						</p>
					) : null}
					{problem ? (
						<p className="flex items-start gap-1 text-xs text-warning-text" role="alert">
							<AlertTriangle size={12} className="mt-px shrink-0" aria-hidden />
							{problem}
						</p>
					) : null}
					{results?.length ? <Results results={results} onDismiss={() => setResults(null)} /> : null}
				</div>
			</div>
			<ConfirmDialog
				open={confirm !== null}
				onOpenChange={(o) => !o && setConfirm(null)}
				title="Change the embeddings model?"
				description="Every mailbox's search index is rebuilt with the new model, under the daily embedding cap. Search keeps working with full-text meanwhile."
				confirmLabel="Change and re-index"
				destructive={false}
				pending={save.isPending}
				onConfirm={async () => {
					const id = confirm;
					setConfirm(null);
					if (id) await pick(id === RESET ? null : id, true);
				}}
			/>
		</li>
	);
}

/** `@cf/meta/llama-3.1-8b-instruct-fp8` → `meta/llama-3.1-8b-instruct-fp8`. */
function shortId(id: string): string {
	return id.replace(/^@(cf|hf)\//, "");
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-4 ring-1 ring-inset ring-border",
				tone === "warn" ? "text-warning-text" : "text-text-primary",
			)}
		>
			{children}
		</span>
	);
}

/**
 * Capability badges. A capability the role needs is always shown, with ✓, ✗
 * or ? (unverified); others only when the model has them, so a row stays short.
 */
function Badges({ model, need }: { model: WorkersAiModel; need?: RoleNeed }) {
	const ctx = contextLabel(model.contextTokens);
	const price = priceLabel(model.price);
	const embedding = model.task === "Text Embeddings";
	const cap = (name: string, c: WorkersAiModel["tools"], needed: boolean) => {
		const known = c.value === true && c.source !== "hint";
		if (!needed && !known) return null;
		const mark = known ? "✓" : c.value === false ? "✗" : "?";
		const said = known ? "yes" : c.value === false ? "no" : "not verified";
		return (
			<Badge tone={needed && !known ? "warn" : undefined}>
				{name} <span aria-hidden>{mark}</span>
				<span className="sr-only">{said}</span>
				{c.source === "probe" ? <span className="text-text-secondary">tested</span> : null}
			</Badge>
		);
	};
	return (
		<div className="flex flex-wrap gap-1">
			{embedding ? (
				<Badge tone={model.dims == null ? "warn" : undefined}>{model.dims ? `${model.dims}d` : "Size ?"}</Badge>
			) : (
				<>
					{cap("Tools", model.tools, need === "tools")}
					{cap("JSON", model.json, need === "json")}
					{model.reasoning ? <Badge>Reasoning</Badge> : null}
					{model.vision ? <Badge>Vision</Badge> : null}
				</>
			)}
			{ctx ? <Badge>{ctx} ctx</Badge> : null}
			{price ? <Badge>{price}</Badge> : null}
			{model.beta ? <Badge tone="warn">Beta</Badge> : null}
		</div>
	);
}

function Results({ results, onDismiss }: { results: TestResult[]; onDismiss: () => void }) {
	return (
		<div className="flex items-start gap-2 rounded-[6px] bg-bg-subtle px-2.5 py-2" role="status">
			<ul className="min-w-0 flex-1 space-y-1">
				{results.map((r) => (
					<li key={r.check} className="text-xs">
						<span className="inline-flex items-center gap-1.5">
							{r.ok ? <Check size={12} className="text-success" aria-hidden /> : <X size={12} className="text-destructive" aria-hidden />}
							<span className="font-medium text-text-primary">{r.check === "embed" ? "embeddings" : r.check}</span>
							<span className="sr-only">{r.ok ? "passed" : "failed"}</span>
							<span className="text-text-tertiary">
								{r.ms} ms{r.dims ? ` · ${r.dims}d` : ""}
							</span>
						</span>
						{r.error ? <p className="mt-0.5 break-words pl-[18px] text-text-secondary">{r.error}</p> : null}
					</li>
				))}
			</ul>
			<button
				type="button"
				onClick={onDismiss}
				aria-label="Dismiss test results"
				className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] text-text-tertiary hover:bg-bg-muted touch:h-11 touch:w-11"
			>
				<X size={12} aria-hidden />
			</button>
		</div>
	);
}
