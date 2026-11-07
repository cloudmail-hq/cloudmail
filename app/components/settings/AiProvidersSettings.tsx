// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → AI providers: where AI runs, and the models it uses.
 *
 * The built-in provider, Cloudflare Workers AI, is always listed and is
 * active whenever no gateway is. Its card sets a Workers AI model per role.
 * Bring-your-own gateways (Anthropic Messages or OpenAI Chat Completions) sit
 * beside it; at most one is active. Tokens are write-only; reads carry a
 * "…a1b2" hint only.
 *
 * Pieces live in `./ai-providers/`: the add/edit form, the gateway models
 * panel and routing card, and the Workers AI card. Pure rules are in
 * `./ai-providers/logic.ts` and shared/workers-ai.ts.
 */

import { AlertTriangle, Cloud, Cpu, Plus } from "lucide-react";
import { Fragment, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "~/components/ui/dropdown-menu";
import { toast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import {
	useAiProviders,
	useDeleteAiProvider,
	usePatchAiRouting,
	useUpdateAiProvider,
	type ProvidersResponse,
	type ProviderView,
} from "~/queries/ai-providers";
import { ApiError } from "~/services/api";
import { ConfirmDialog, Pill, SECONDARY_BUTTON_CLASS, SectionHeading } from "./settings-ui";
import {
	catalogueSummary,
	hostOf,
	providerStatus,
	STATUS_LABELS,
	usageLabel,
	WIRE_LABELS,
	type ProviderStatus,
} from "./ai-providers/logic";
import { ModelsPanel } from "./ai-providers/ModelsPanel";
import { ProviderForm } from "./ai-providers/ProviderForm";
import { RoutingCard } from "./ai-providers/RoutingCard";
import { WorkersAiCard } from "./ai-providers/WorkersAiCard";
import { errorMessage, MoreTrigger, TouchSwitch, TOUCH } from "./ai-providers/shared";

const BUILT_IN = "workers-ai";

/** Facts joined with dots; each fact stays on one line, as in ListRow. The host may break. */
function MetaLine({ facts }: { facts: string[] }) {
	return (
		<span className="mt-0.5 block text-xs text-text-secondary">
			{facts.map((fact, i) => (
				<Fragment key={i}>
					{i > 0 ? " " : null}
					<span className={i === 0 ? "break-all" : "whitespace-nowrap"}>
						{fact}
						{i < facts.length - 1 ? <span aria-hidden>{" ·"}</span> : null}
					</span>
				</Fragment>
			))}
		</span>
	);
}

export default function AiProvidersSettings() {
	const query = useAiProviders();
	const [editing, setEditing] = useState<ProviderView | "new" | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const data = query.data;
	const unavailable = query.error instanceof ApiError && (query.error.status === 403 || query.error.status === 503);

	const providers = data?.providers ?? [];
	const activeId = data?.status.mode === "gateway" ? data.status.activeProviderId : null;
	// The detail cards follow the picked provider, else the active one (the built-in one when no gateway is).
	const selectedGateway = selectedId === BUILT_IN ? null : (providers.find((p) => p.id === (selectedId ?? activeId)) ?? null);
	const gateway = providers.find((p) => p.id === activeId) ?? null;
	const calls = new Map((data?.usage.byProvider ?? []).map((u) => [u.providerId, u.calls] as const));

	return (
		<section className="space-y-3">
			<SectionHeading icon={Cpu} title="AI providers" busy={query.isFetching && !query.isLoading} />

			{query.isLoading ? (
				<div className="space-y-2" aria-busy="true" aria-label="Loading AI providers">
					{[0, 1].map((i) => (
						<div key={i} className="h-16 animate-pulse rounded-[8px] bg-bg-muted" />
					))}
				</div>
			) : unavailable ? (
				<p className="text-sm text-text-secondary">{(query.error as ApiError).message}</p>
			) : query.isError || !data ? (
				<div className="flex items-center gap-3 text-sm text-text-secondary">
					Couldn't load AI providers.
					<button type="button" onClick={() => query.refetch()} className={cn(SECONDARY_BUTTON_CLASS, TOUCH)}>
						Retry
					</button>
				</div>
			) : (
				<>
					<StatusLine data={data} />

					<div className="space-y-2 rounded-[8px] bg-card p-4 ring-1 ring-border sm:p-5">
						<ul className="space-y-2">
							<BuiltInRow
								active={!gateway}
								selected={!selectedGateway}
								calls={calls.get(BUILT_IN)}
								onSelect={() => setSelectedId(BUILT_IN)}
							/>
							{providers.map((p) => (
								<ProviderRow
									key={p.id}
									provider={p}
									active={p.id === activeId}
									selected={p.id === selectedGateway?.id}
									calls={calls.get(p.id)}
									onSelect={() => setSelectedId(p.id)}
									onEdit={() => setEditing(p)}
								/>
							))}
						</ul>
						{/* The one way to add a gateway, right under the providers it joins. */}
						<button
							type="button"
							onClick={() => setEditing("new")}
							className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-[8px] border border-dashed border-border px-3 py-2 text-sm font-medium text-text-primary hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50"
						>
							<Plus size={14} aria-hidden />
							Add provider
							<span className="font-normal text-text-secondary">· bring your own key</span>
						</button>
					</div>

					<Notices data={data} gateway={gateway} />

					{selectedGateway ? (
						<>
							<div className="space-y-3 rounded-[8px] bg-card p-4 ring-1 ring-border sm:p-5">
								<h3 className="text-sm font-semibold text-text-primary">
									Models <span className="font-normal text-text-tertiary">· {selectedGateway.label}</span>
								</h3>
								<ModelsPanel key={selectedGateway.id} provider={selectedGateway} />
							</div>
							<RoutingCard key={selectedGateway.id} provider={selectedGateway} data={data} />
						</>
					) : (
						<WorkersAiCard data={data} active={!gateway} />
					)}
				</>
			)}

			{editing ? <ProviderForm provider={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
		</section>
	);
}

/** "All AI runs on …", and the exceptions. A plain line, not another card. */
function StatusLine({ data }: { data: ProvidersResponse }) {
	return (
		<div role="status">
			<p className="text-sm font-medium text-text-primary">{data.status.line}</p>
			{data.status.exceptions.length ? (
				<ul className="mt-0.5 space-y-0.5 text-xs text-text-secondary">
					{data.status.exceptions.map((e, i) => (
						<li key={i}>{e.text}</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

const STATUS_TONES: Record<ProviderStatus, "violet" | "warning" | "muted"> = {
	active: "violet",
	inactive: "muted",
	paused: "warning",
	failing: "warning",
	off: "muted",
};

function StatusPill({ status }: { status: ProviderStatus }) {
	return <Pill tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Pill>;
}

/** The built-in provider: always present; switching back to it is one click. */
function BuiltInRow({
	active,
	selected,
	calls,
	onSelect,
}: {
	active: boolean;
	selected: boolean;
	calls?: number;
	onSelect: () => void;
}) {
	const save = usePatchAiRouting();
	const usage = usageLabel(calls);
	return (
		<li className={cn("rounded-[8px] bg-bg-subtle px-3 py-2.5 ring-1", selected ? "ring-accent/40" : "ring-transparent")}>
			<div className="flex items-start gap-2">
				<button
					type="button"
					onClick={onSelect}
					aria-pressed={selected}
					className="flex min-w-0 flex-1 items-start gap-2.5 rounded-[6px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50"
				>
					<Cloud size={16} className="mt-0.5 shrink-0 text-text-tertiary" aria-hidden />
					<span className="min-w-0">
						<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span className="text-sm font-medium text-text-primary">Cloudflare Workers AI</span>
							<StatusPill status={active ? "active" : "inactive"} />
						</span>
						<MetaLine facts={["Built-in", ...(usage ? [usage] : [])]} />
					</span>
				</button>
				{!active ? (
					<button
						type="button"
						disabled={save.isPending}
						onClick={async () => {
							try {
								await save.mutateAsync({ gatewayProviderId: null });
								toast.success("AI runs on Workers AI");
							} catch (e) {
								toast.error(errorMessage(e, "Couldn't switch."));
							}
						}}
						className={cn(SECONDARY_BUTTON_CLASS, "h-8 shrink-0 px-2.5", TOUCH)}
					>
						Use built-in
					</button>
				) : null}
			</div>
		</li>
	);
}

function Notices({ data, gateway }: { data: ProvidersResponse; gateway: ProviderView | null }) {
	return (
		<div className="space-y-2">
			{gateway ? (
				<p className="text-xs text-text-secondary">
					Mail content is sent to <span className="font-mono">{hostOf(gateway.baseUrl)}</span>.
				</p>
			) : null}
			{!data.authSecretSet && data.providers.length > 0 ? (
				<p className="flex items-start gap-2 rounded-[6px] bg-warning-bg px-3 py-2 text-xs text-warning-text ring-1 ring-warning-border">
					<AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
					<span>
						Tokens are encrypted with a key stored in the app. Set <span className="font-mono">AUTH_SECRET</span> for stronger
						protection.
					</span>
				</p>
			) : null}
		</div>
	);
}

function ProviderRow({
	provider,
	active,
	selected,
	calls,
	onSelect,
	onEdit,
}: {
	provider: ProviderView;
	active: boolean;
	selected: boolean;
	calls?: number;
	onSelect: () => void;
	onEdit: () => void;
}) {
	const update = useUpdateAiProvider();
	const remove = useDeleteAiProvider();
	const [confirmDelete, setConfirmDelete] = useState(false);
	const status = providerStatus(provider, active);
	const usage = usageLabel(calls);

	async function toggle(enabled: boolean) {
		try {
			await update.mutateAsync({ id: provider.id, patch: { enabled } });
		} catch (e) {
			toast.error(errorMessage(e, "Couldn't change that."));
		}
	}

	return (
		<li
			className={cn(
				"rounded-[8px] bg-bg-subtle px-3 py-2.5 ring-1",
				selected ? "ring-accent/40" : "ring-transparent",
			)}
		>
			<div className="flex items-start gap-2">
				<button
					type="button"
					onClick={onSelect}
					aria-pressed={selected}
					className="min-w-0 flex-1 rounded-[6px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50"
				>
					<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span className="min-w-0 break-words text-sm font-medium text-text-primary">{provider.label}</span>
						<StatusPill status={status} />
					</span>
					<MetaLine
						facts={[
							hostOf(provider.baseUrl),
							WIRE_LABELS[provider.wire],
							catalogueSummary(provider.catalogue),
							provider.tokenSet ? `Token ${provider.tokenHint ?? "set"}` : "No token",
							...(usage ? [usage] : []),
						]}
					/>
				</button>
				<div className="-my-1 -mr-1 flex shrink-0 items-center gap-0.5">
					<TouchSwitch
						checked={provider.enabled}
						onCheckedChange={(next) => void toggle(next)}
						busy={update.isPending}
						// A fixed name: aria-checked says on or off. "Turn off X" read as
						// "Turn off X, switch, on", the action and the state at once.
						aria-label={`Enable ${provider.label}`}
					/>
					<DropdownMenu>
						<MoreTrigger label={`More actions for ${provider.label}`} />
						<DropdownMenuContent align="end">
							<DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem className="text-destructive" disabled={active} onSelect={() => setConfirmDelete(true)}>
								{active ? "Delete (deactivate first)" : "Delete"}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			{status === "paused" || status === "failing" ? (
				<p className="mt-2 flex items-start gap-1.5 text-xs text-warning-text">
					<AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
					{status === "paused" ? "Gateway failing. AI calls paused" : "The gateway is rejecting requests"}
					{status === "paused" && provider.breaker.openUntil
						? ` until ${new Date(provider.breaker.openUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
						: ""}
					.
				</p>
			) : null}

			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={(o) => !o && setConfirmDelete(false)}
				title={`Delete ${provider.label}?`}
				description="Its token and routing picks are removed."
				confirmLabel="Delete provider"
				pending={remove.isPending}
				onConfirm={async () => {
					try {
						await remove.mutateAsync(provider.id);
						setConfirmDelete(false);
						toast.success("Provider deleted");
					} catch (e) {
						const code = e instanceof ApiError ? e.body.code : null;
						toast.error(code === "provider_active" ? "Deactivate it first." : errorMessage(e, "Couldn't delete it."));
					}
				}}
			/>
		</li>
	);
}
