// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Analytics → Usage: this month's Cloudflare bill in one place. Lead tiles
 * (emails, AI, storage, DO requests, daily quota), AI calls by feature, by
 * provider and by role, the
 * per-mailbox caps (read-only, linking to where they are edited), and the
 * admin's budget thresholds. Data: `GET /api/v1/usage` (`shared/usage.ts`).
 */

import * as React from "react";
import { Link } from "react-router";
import type { UsageResponse } from "../../../shared/usage";
import { useUpdateUsageBudget } from "~/queries/analytics";
import { errorMessage, showToast } from "~/lib/toast";
import { formatCount } from "./format";
import { Addr, Alert, AlertGroup, InfoTip, Panel, ResponsiveTable, TileRow, TileSkeleton, type Column, type TileData } from "./primitives";
import { ChartSkeleton, PanelTitle } from "./sending";

// ── Formatting (pure, unit-tested) ────────────────────────────────────────

export function formatUsd(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n)) return "—";
	if (n === 0) return "$0";
	if (Math.abs(n) < 0.01) return "<$0.01";
	return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatBytes(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n)) return "—";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let v = n;
	let i = 0;
	while (v >= 1000 && i < units.length - 1) {
		v /= 1000;
		i++;
	}
	return `${i === 0 ? Math.round(v) : v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** "1.2K / 340" for tokens in and out; "—" when neither was reported. */
export function formatTokens(input: number | null | undefined, output: number | null | undefined): string {
	if (input == null && output == null) return "—";
	return `${formatCount(input)} / ${formatCount(output)}`;
}

/** Budget banner lines, one per exceeded kind. */
export function budgetAlertTitles(data: Pick<UsageResponse, "budget">): string[] {
	return data.budget.alerts
		.filter((a) => a.exceeded)
		.map(
			(a) =>
				`Projected ${a.kind === "ai" ? "Workers AI" : "Email Service"} cost ${formatUsd(a.projected_usd)} is over your ${formatUsd(a.threshold_usd)} budget`,
		);
}

export function usageTiles(d: UsageResponse): TileData[] {
	const e = d.email;
	const over = e.projected > e.included;
	const tiles: TileData[] = [
		{
			key: "email",
			label: "Emails this month",
			value: formatCount(e.sent_mtd),
			sub: `of ${formatCount(e.included)} included · ${formatCount(e.projected)} projected${e.projected_cost > 0 ? ` · ${formatUsd(e.projected_cost)}` : ""}`,
			meter: { value: e.sent_mtd, max: e.included },
			tone: over ? "warning" : undefined,
			toneLabel: over ? "Over" : undefined,
			info:
				e.source === "cloudflare"
					? "Cloudflare's count for the whole account, per recipient. 3,000 a month are included on Workers Paid, then $0.35 per 1,000."
					: "This app's sent messages. Connect Cloudflare (Settings → Cloudflare connection) for Cloudflare's billed count.",
		},
		{
			key: "ai",
			label: "Workers AI",
			value: d.ai.neurons ? formatUsd(d.ai.neurons.projected_cost) : formatCount(d.ai.calls_mtd),
			sub: d.ai.neurons
				? `projected · ${formatCount(d.ai.neurons.neurons_mtd)} neurons so far`
				: `calls this month`,
			info: "Neurons are account-wide (every Worker). 10,000 a day are free, then $0.011 per 1,000. Calls are this app's, counted here.",
		},
	];
	if (d.r2) tiles.push({ key: "r2", label: "Storage", value: formatBytes(d.r2.bytes), sub: `${formatCount(d.r2.objects)} objects in R2` });
	if (d.durable_objects)
		tiles.push({
			key: "do",
			label: "DO requests",
			value: formatCount(d.durable_objects.requests_mtd),
			sub: `${formatCount(d.durable_objects.projected)} projected`,
			info: "This Worker's Durable Object requests. Workers Paid includes 1 million a month, shared by every Worker on the account.",
		});
	if (d.quota)
		tiles.push({
			key: "quota",
			label: "Daily send quota",
			value: formatCount(d.quota.used),
			sub: `of ${formatCount(d.quota.limit)} today`,
			meter: { value: d.quota.used, max: d.quota.limit },
		});
	return tiles.slice(0, 5);
}

// ── Components ────────────────────────────────────────────────────────────

export function UsageSkeleton() {
	return (
		<div className="space-y-4">
			<TileSkeleton count={5} />
			<ChartSkeleton />
		</div>
	);
}

export function UsagePanel({ data }: { data: UsageResponse }) {
	const alerts = budgetAlertTitles(data);
	return (
		<div className="space-y-4">
			<AlertGroup
				items={[
					...alerts.map((title) => <Alert key={title} tone="critical" title={title} />),
					!data.provider.configured && (
						<Alert
							key="setup"
							tone="neutral"
							title="Connect Cloudflare for neurons, storage and billed sends"
							info="Settings → Cloudflare connection, or a CF_ANALYTICS_TOKEN secret with Account Analytics Read. Without it this tab shows this app's own counts."
							action={{ label: "Connect", to: "/settings/cloudflare" }}
						/>
					),
					!!data.provider.error && <Alert key="err" tone="neutral" title="Some Cloudflare data didn't load" info={data.provider.error} />,
				]}
			/>
			<TileRow label="This month" tiles={usageTiles(data)} />
			<AiFeaturesPanel data={data} />
			<AiProvidersPanel data={data} />
			<CapsPanel data={data} />
			<BudgetPanel data={data} />
		</div>
	);
}

function AiFeaturesPanel({ data }: { data: UsageResponse }) {
	const rows = data.ai.by_feature;
	const max = Math.max(1, ...rows.map((r) => r.calls_mtd));
	return (
		<Panel>
			<PanelTitle
				title="AI calls by feature"
				info="Counted by this app on each Workers AI call. Neurons per call vary by model."
			/>
			<ul className="divide-y divide-border">
				{rows.map((r) => (
					<li key={r.feature} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 px-4 py-2.5 text-sm sm:px-5">
						<span className="truncate text-text-primary">{r.label}</span>
						<span aria-hidden className="h-2 overflow-hidden rounded-full bg-[var(--viz-track)]">
							<span
								className="block h-full rounded-full"
								style={{ width: `${(r.calls_mtd / max) * 100}%`, minWidth: r.calls_mtd > 0 ? 4 : 0, backgroundColor: "var(--viz-1)" }}
							/>
						</span>
						<span className="tabular-nums text-text-primary">
							{formatCount(r.calls_mtd)}
							<span className="ml-1.5 text-xs text-text-secondary">{formatCount(r.calls_today)} today</span>
						</span>
					</li>
				))}
			</ul>
		</Panel>
	);
}

type ProviderRow = UsageResponse["ai"]["by_provider"][number];
type RoleRow = UsageResponse["ai"]["by_role"][number];

/** Per-provider and per-role tables. Each is hidden while it has no rows. */
function AiProvidersPanel({ data }: { data: UsageResponse }) {
	const providers = data.ai.by_provider ?? [];
	const roles = data.ai.by_role ?? [];
	if (providers.length === 0 && roles.length === 0) return null;
	const providerLabel = new Map(providers.map((p) => [p.provider_id, p.label] as const));
	const providerColumns: Column<ProviderRow>[] = [
		{ key: "provider", header: "Provider", primary: true, cell: (r) => <span className="text-text-primary">{r.label}</span> },
		{ key: "mtd", header: "Calls", align: "right", cell: (r) => formatCount(r.calls_mtd) },
		{ key: "today", header: "Today", align: "right", cell: (r) => formatCount(r.calls_today), emptyOnMobile: (r) => r.calls_today === 0 },
		{
			key: "tokens",
			header: "Tokens in / out",
			align: "right",
			cell: (r) => formatTokens(r.input_tokens_mtd, r.output_tokens_mtd),
			emptyOnMobile: (r) => r.input_tokens_mtd == null && r.output_tokens_mtd == null,
		},
		{ key: "cost", header: "Cost", align: "right", cell: (r) => formatUsd(r.cost_mtd_usd), emptyOnMobile: (r) => r.cost_mtd_usd == null },
	];
	const roleColumns: Column<RoleRow>[] = [
		{ key: "role", header: "Role", primary: true, cell: (r) => <span className="text-text-primary">{r.label}</span> },
		{ key: "provider", header: "Provider", cell: (r) => providerLabel.get(r.provider_id) ?? (r.provider_id === "workers-ai" ? "Workers AI" : r.provider_id) },
		{ key: "mtd", header: "Calls", align: "right", cell: (r) => formatCount(r.calls_mtd) },
		{ key: "today", header: "Today", align: "right", cell: (r) => formatCount(r.calls_today), emptyOnMobile: (r) => r.calls_today === 0 },
		{
			key: "tokens",
			header: "Tokens in / out",
			align: "right",
			cell: (r) => formatTokens(r.input_tokens_mtd, r.output_tokens_mtd),
			emptyOnMobile: (r) => r.input_tokens_mtd == null && r.output_tokens_mtd == null,
		},
	];
	return (
		<>
			{providers.length > 0 && (
				<Panel>
					<PanelTitle
						title="By provider"
						info="Model requests this month, counted by this app. Tokens show when the provider reports them; cost only when the gateway publishes prices."
					/>
					<ResponsiveTable caption="AI requests by provider" columns={providerColumns} rows={providers} rowKey={(r) => r.provider_id} />
				</Panel>
			)}
			{roles.length > 0 && (
				<Panel>
					<PanelTitle title="By role" info="Model requests this month per role, with the provider that served them." />
					<ResponsiveTable caption="AI requests by role" columns={roleColumns} rows={roles} rowKey={(r) => `${r.role}:${r.provider_id}`} mobileLimit={8} />
				</Panel>
			)}
		</>
	);
}

type CapRow = UsageResponse["mailboxes"][number];

function settingsHref(email: string, anchor: string) {
	return `/mail/${encodeURIComponent(email)}/settings#${anchor}`;
}

function CapsPanel({ data }: { data: UsageResponse }) {
	const columns: Column<CapRow>[] = [
		{ key: "mailbox", header: "Mailbox", primary: true, cell: (r) => <Addr>{r.email}</Addr> },
		{
			key: "ai",
			header: "AI today",
			align: "right",
			cell: (r) => (
				<Link to={settingsHref(r.email, "triage")} className="inline-flex min-h-11 items-center hover:underline sm:min-h-0" aria-label={`Edit the AI cap for ${r.email}`}>
					{r.triage.enabled ? `${formatCount(r.triage.calls_today)} / ${formatCount(r.triage.daily_ai_cap)}` : "Off"}
				</Link>
			),
		},
		{
			key: "sends",
			header: "Sends hour / day",
			align: "right",
			cell: (r) =>
				r.send_caps ? (
					<Link
						to={settingsHref(r.email, "send-limits")}
						className="inline-flex min-h-11 items-center hover:underline sm:min-h-0"
						aria-label={`Edit the send caps for ${r.email}`}
					>
						{`${r.send_caps.sent_last_hour}/${r.send_caps.hourly} · ${r.send_caps.sent_last_day}/${r.send_caps.daily}`}
					</Link>
				) : (
					"—"
				),
		},
	];
	return (
		<Panel>
			<PanelTitle title="Caps" info="AI triage calls per day and sends per rolling hour and day, per mailbox. Select one to edit it in the mailbox's settings." />
			<ResponsiveTable caption="Per-mailbox caps" columns={columns} rows={data.mailboxes} rowKey={(r) => r.email} mobileLimit={8} />
		</Panel>
	);
}

/** "" for an empty field (no threshold), else a non-negative number, else NaN. */
export function parseThreshold(raw: string): number | null {
	const t = raw.trim().replace(/^\$/, "");
	if (t === "") return null;
	const n = Number(t);
	return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}

function BudgetPanel({ data }: { data: UsageResponse }) {
	const save = useUpdateUsageBudget();
	const [ai, setAi] = React.useState(data.budget.ai_usd?.toString() ?? "");
	const [email, setEmail] = React.useState(data.budget.email_usd?.toString() ?? "");
	React.useEffect(() => setAi(data.budget.ai_usd?.toString() ?? ""), [data.budget.ai_usd]);
	React.useEffect(() => setEmail(data.budget.email_usd?.toString() ?? ""), [data.budget.email_usd]);
	const aiV = parseThreshold(ai);
	const emailV = parseThreshold(email);
	const invalid = Number.isNaN(aiV) || Number.isNaN(emailV);
	const dirty = aiV !== data.budget.ai_usd || emailV !== data.budget.email_usd;
	const aiId = React.useId();
	const emailId = React.useId();
	const input =
		"h-11 w-full rounded-[6px] border border-border bg-card px-2.5 text-sm tabular-nums text-text-primary outline-none focus:ring-2 focus:ring-ring/30 sm:h-9 sm:w-32";

	return (
		<Panel>
			<PanelTitle
				title="Budget alert"
				info="When the projected monthly cost passes a threshold, this tab shows a banner and a usage.budget_exceeded webhook fires, once per month. Leave empty for none."
			/>
			<form
				className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-end sm:px-5"
				onSubmit={(e) => {
					e.preventDefault();
					if (invalid || !dirty) return;
					save.mutate(
						{ ai_usd: aiV as number | null, email_usd: emailV as number | null },
						{
							onSuccess: () => showToast({ message: "Budget saved", kind: "success" }),
							onError: (err) => showToast({ message: errorMessage(err, "Could not save the budget"), kind: "error" }),
						},
					);
				}}
			>
				<label htmlFor={aiId} className="flex flex-col gap-1 text-xs text-text-secondary">
					Workers AI, USD/month
					<input id={aiId} inputMode="decimal" placeholder="None" value={ai} onChange={(e) => setAi(e.target.value)} className={input} aria-invalid={Number.isNaN(aiV) || undefined} />
				</label>
				<label htmlFor={emailId} className="flex flex-col gap-1 text-xs text-text-secondary">
					Email, USD/month
					<input id={emailId} inputMode="decimal" placeholder="None" value={email} onChange={(e) => setEmail(e.target.value)} className={input} aria-invalid={Number.isNaN(emailV) || undefined} />
				</label>
				<button
					type="submit"
					disabled={invalid || !dirty || save.isPending}
					className="inline-flex h-11 items-center justify-center rounded-[6px] bg-accent px-4 text-sm font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50 sm:h-9"
				>
					{save.isPending ? "Saving…" : "Save"}
				</button>
				{data.budget.alerts.length > 0 && (
					<p className="text-xs text-text-secondary sm:ml-auto sm:self-center">
						{data.budget.alerts.map((a) => `${a.kind === "ai" ? "AI" : "Email"} ${formatUsd(a.projected_usd)} projected`).join(" · ")}
						<InfoTip label="About projections" className="ml-1">
							Month to date, extended at the same daily rate to the end of the month.
						</InfoTip>
					</p>
				)}
			</form>
		</Panel>
	);
}
