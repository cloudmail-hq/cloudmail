// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * One provider's models: discover, search, capability badges with their
 * source, admin overrides, custom ids and a per-model Test.
 */

import { Check, Loader2, Play, Plus, RefreshCw, X } from "lucide-react";
import { Fragment, useId, useRef, useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
} from "~/components/ui/dropdown-menu";
import { toast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import {
	useDiscoverAiModels,
	usePatchAiModels,
	useTestAiModel,
	type ProviderView,
	type TestResult,
} from "~/queries/ai-providers";
import type { CatalogModel } from "../../../../shared/ai-providers";
import { PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS, SETTINGS_INPUT_CLASS } from "../settings-ui";
import {
	badgesFor,
	CAP_BADGE_LABELS,
	CATALOGUE_STATUS_LABELS,
	catalogueSummary,
	filterModels,
	type CapBadgeName,
	type KindFilter,
} from "./logic";
import { CapBadge, errorMessage, MoreTrigger, SELECT_CLASS, TOUCH } from "./shared";

const PAGE = 50;

export function ModelsPanel({ provider }: { provider: ProviderView }) {
	const discover = useDiscoverAiModels();
	const [query, setQuery] = useState("");
	const [kind, setKind] = useState<KindFilter>("all");
	const [limit, setLimit] = useState(PAGE);
	const [results, setResults] = useState<Record<string, TestResult[]>>({});
	const searchId = useId();
	const shown = filterModels(provider.models, query, kind);
	const { catalogue } = provider;

	async function runDiscover() {
		try {
			const { provider: next } = await discover.mutateAsync(provider.id);
			const c = next.catalogue;
			if (c.status === "ok") toast.success(`${c.count} model${c.count === 1 ? "" : "s"} found`);
			else toast.error(c.detail || CATALOGUE_STATUS_LABELS[c.status]);
		} catch (e) {
			toast.error(errorMessage(e, "Couldn't reach the gateway."));
		}
	}

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					onClick={() => void runDiscover()}
					disabled={discover.isPending}
					className={cn(SECONDARY_BUTTON_CLASS, "h-8", TOUCH)}
				>
					{discover.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />}
					Discover
				</button>
				<span className="text-xs text-text-tertiary">
					{catalogueSummary(catalogue)}
					{catalogue.status !== "ok" && catalogue.status !== "never" && catalogue.detail ? ` · ${catalogue.detail}` : ""}
				</span>
			</div>

			<AddModelId provider={provider} />

			{provider.models.length > 0 ? (
				<>
					<div className="flex flex-col gap-2 sm:flex-row">
						<label htmlFor={searchId} className="sr-only">
							Search models
						</label>
						<input
							id={searchId}
							type="search"
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								setLimit(PAGE);
							}}
							placeholder="Search models"
							className={cn(SETTINGS_INPUT_CLASS, "touch:h-11 sm:flex-1")}
						/>
						<select
							aria-label="Model kind"
							value={kind}
							onChange={(e) => setKind(e.target.value as KindFilter)}
							className={cn(SELECT_CLASS, "sm:w-36")}
						>
							<option value="all">All kinds</option>
							<option value="chat">Chat</option>
							<option value="embedding">Embeddings</option>
						</select>
					</div>
					{shown.length === 0 ? (
						<p className="text-sm text-text-secondary">No models match.</p>
					) : (
						<ul className="divide-y divide-border/60 rounded-[6px] ring-1 ring-border">
							{shown.slice(0, limit).map((m) => (
								<ModelRow
									key={m.id}
									provider={provider}
									model={m}
									results={results[m.id]}
									onResults={(r) => setResults((all) => ({ ...all, [m.id]: r }))}
								/>
							))}
						</ul>
					)}
					{shown.length > limit ? (
						<button type="button" onClick={() => setLimit((n) => n + PAGE)} className={cn(SECONDARY_BUTTON_CLASS, "h-8", TOUCH)}>
							Show more ({shown.length - limit})
						</button>
					) : null}
				</>
			) : null}
		</div>
	);
}

function AddModelId({ provider }: { provider: ProviderView }) {
	const patch = usePatchAiModels();
	const [id, setId] = useState("");
	const [kind, setKind] = useState<"chat" | "embedding">("chat");
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const prominent = provider.needsCustomIds || provider.catalogue.status === "no-discovery";

	async function add(e: React.FormEvent) {
		e.preventDefault();
		const value = id.trim();
		// Add stays enabled (a disabled primary reads grey); empty just focuses the field.
		if (!value) return inputRef.current?.focus();
		try {
			await patch.mutateAsync({ id: provider.id, patch: { add: [{ id: value, kind }] } });
			setId("");
		} catch (err) {
			toast.error(errorMessage(err, "Couldn't add that model."));
		}
	}

	return (
		<form
			onSubmit={add}
			className={cn("space-y-1.5", prominent && "rounded-[6px] bg-accent-subtle/50 p-3 ring-1 ring-accent/25")}
		>
			<label htmlFor={inputId} className="block text-[11px] font-medium text-text-secondary">
				Add model id
			</label>
			<div className="flex flex-col gap-2 sm:flex-row">
				<input
					id={inputId}
					ref={inputRef}
					value={id}
					onChange={(e) => setId(e.target.value)}
					placeholder={provider.needsCustomIds ? "my-gpt-deployment" : "model-id"}
					spellCheck={false}
					maxLength={200}
					className={cn(SETTINGS_INPUT_CLASS, "touch:h-11 sm:flex-1")}
				/>
				<div className="flex gap-2">
					<select
						aria-label="Model kind"
						value={kind}
						onChange={(e) => setKind(e.target.value as "chat" | "embedding")}
						className={cn(SELECT_CLASS, "flex-1 sm:w-32")}
					>
						<option value="chat">Chat</option>
						<option value="embedding">Embedding</option>
					</select>
					<button type="submit" disabled={patch.isPending} className={cn(PRIMARY_BUTTON_CLASS, TOUCH)}>
						{patch.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Plus size={13} aria-hidden />}
						Add
					</button>
				</div>
			</div>
			<p className="text-xs text-text-secondary">Azure deployment names and Cloudflare AI Gateway ids go here.</p>
		</form>
	);
}

type OverrideValue = "yes" | "no" | "clear";

function ModelRow({
	provider,
	model,
	results,
	onResults,
}: {
	provider: ProviderView;
	model: CatalogModel;
	results?: TestResult[];
	onResults: (r: TestResult[]) => void;
}) {
	const patch = usePatchAiModels();
	const test = useTestAiModel();
	const badges = badgesFor(model);

	async function override(name: CapBadgeName, value: OverrideValue) {
		const v = value === "clear" ? null : value === "yes";
		try {
			await patch.mutateAsync({ id: provider.id, patch: { caps: [{ id: model.id, [name]: v }] } });
		} catch (e) {
			toast.error(errorMessage(e, "Couldn't save that."));
		}
	}

	async function remove() {
		try {
			await patch.mutateAsync({ id: provider.id, patch: { remove: [model.id] } });
		} catch (e) {
			toast.error(errorMessage(e, "Couldn't remove it."));
		}
	}

	async function runTest() {
		try {
			const { results: r } = await test.mutateAsync({ id: provider.id, modelId: model.id });
			onResults(r);
		} catch (e) {
			toast.error(errorMessage(e, "Couldn't run the test."));
		}
	}

	return (
		<li className="space-y-2 p-3">
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span className="min-w-0 break-all font-mono text-xs font-medium text-text-primary">{model.id}</span>
						{model.custom ? <span className="text-[11px] text-text-tertiary">custom</span> : null}
						{model.kind === "embedding" ? <span className="text-[11px] text-text-tertiary">embedding</span> : null}
						{model.lifecycle === "deprecated" ? <span className="text-[11px] text-warning-text">deprecated</span> : null}
					</div>
					<div className="mt-1.5 flex flex-wrap gap-1">
						{badges.map((b) => (
							<CapBadge key={b} name={b} cap={model.caps[b]} dims={model.embeddingDims} />
						))}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					<button
						type="button"
						onClick={() => void runTest()}
						disabled={test.isPending}
						className={cn(SECONDARY_BUTTON_CLASS, "h-8 px-2.5", TOUCH)}
					>
						{test.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Play size={13} aria-hidden />}
						Test
					</button>
					<DropdownMenu>
						<MoreTrigger label={`Capabilities for ${model.id}`} disabled={patch.isPending}>
							{patch.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : undefined}
						</MoreTrigger>
						<DropdownMenuContent align="end" className="w-52">
							{badges.map((b, i) => (
								<Fragment key={b}>
									{i > 0 ? <DropdownMenuSeparator /> : null}
									<DropdownMenuLabel className="text-xs">{CAP_BADGE_LABELS[b]}</DropdownMenuLabel>
									<DropdownMenuRadioGroup
										value={model.caps[b].source === "admin" ? (model.caps[b].value ? "yes" : "no") : "clear"}
										onValueChange={(v) => void override(b, v as OverrideValue)}
									>
										<DropdownMenuRadioItem value="yes" className="touch:min-h-11">
											Supported
										</DropdownMenuRadioItem>
										<DropdownMenuRadioItem value="no" className="touch:min-h-11">
											Not supported
										</DropdownMenuRadioItem>
										<DropdownMenuRadioItem value="clear" className="touch:min-h-11">
											Not set by admin
										</DropdownMenuRadioItem>
									</DropdownMenuRadioGroup>
								</Fragment>
							))}
							{model.custom ? (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem className="text-destructive touch:min-h-11" onSelect={() => void remove()}>
										Remove model id
									</DropdownMenuItem>
								</>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			{results ? <TestResults results={results} onDismiss={() => onResults([])} /> : null}
		</li>
	);
}

function TestResults({ results, onDismiss }: { results: TestResult[]; onDismiss: () => void }) {
	if (results.length === 0) return null;
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
