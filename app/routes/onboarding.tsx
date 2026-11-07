// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Guided Cloudflare setup, from a token through the first incoming message. */

import {
	AlertTriangle,
	Check,
	CheckCircle2,
	ChevronDown,
	CircleDashed,
	Cloud,
	ExternalLink,
	Inbox,
	Loader2,
	RefreshCw,
	RotateCcw,
	XCircle,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { CF_CAPABILITY_LABELS } from "../../shared/cf-connection";
import type { ApplyItemResult, CfApplyResponse, CfDnsChange, CfPlanResponse, DnsRecordLite, PlanItem } from "../../shared/cf-setup";
import DashboardLayout from "~/components/DashboardLayout";
import {
	ONBOARDING_DISMISS_KEY,
	applyCount,
	applySelection,
	groupPlanByDomain,
	groupPlanByTier,
	planAfterStale,
	resultFor,
	retrySelection,
	zoneStatusLine,
} from "~/components/onboarding/logic";
import { ReauthPrompt, useCloudflareConnectionFlow } from "~/components/settings/cloudflare-connection-flow";
import {
	InlineError,
	Pill,
	PRIMARY_BUTTON_CLASS,
	SECONDARY_BUTTON_CLASS,
	SettingsField,
} from "~/components/settings/settings-ui";
import { PageContainer, PageHeader } from "~/components/ui/page";
import { useMailboxLiveUpdates } from "~/hooks/useMailboxLiveUpdates";
import { cn } from "~/lib/utils";
import { useCloudflareConnection } from "~/queries/cloudflare";
import {
	useApplyCloudflarePlan,
	useCloudflareChanges,
	useCloudflareDiscovery,
	useCloudflarePlan,
	useRefreshCloudflareDiscovery,
	useRevertCloudflareChange,
} from "~/queries/cloudflare-setup";
import { useReauth } from "~/queries/auth";
import { useCreateMailbox } from "~/queries/mailboxes";
import { useCurrentUser } from "~/queries/people";
import { useLicence } from "~/queries/licence";
import { LicenceKeyForm, PAUSED_WHILE_LOCKED, PRODUCT_NAME, statusLabel } from "~/components/licence/LicenceParts";
import { ApiError } from "~/services/api";
import { authErrorCode, authErrorMessage } from "~/services/auth-api";

export function meta() {
	return [{ title: "Guided setup" }, { name: "robots", content: "noindex" }];
}

type Step = "connect" | "licence" | "domains" | "review" | "result" | "mailbox";
type FreshAction = { kind: "apply" } | { kind: "retry"; id: string } | { kind: "revert"; id: string };
const STEPS: { id: Step; label: string }[] = [
	{ id: "connect", label: "Connect" },
	{ id: "licence", label: "Licence" },
	{ id: "domains", label: "Domains" },
	{ id: "review", label: "Review" },
	{ id: "result", label: "Result" },
	{ id: "mailbox", label: "Mailbox" },
];

function Spinner({ label }: { label: string }) {
	return (
		<div className="flex min-h-40 items-center justify-center gap-2 text-sm text-text-secondary" role="status">
			<Loader2 size={16} className="animate-spin" aria-hidden />
			{label}
		</div>
	);
}

function StepRail({ step }: { step: Step }) {
	const active = STEPS.findIndex((entry) => entry.id === step);
	return (
		<ol className="mb-5 grid grid-cols-6 gap-1" aria-label="Setup progress">
			{STEPS.map((entry, index) => (
				<li key={entry.id} aria-current={index === active ? "step" : undefined} className="min-w-0">
					<div className={cn("h-1 rounded-full", index <= active ? "bg-accent" : "bg-border")} />
					<span className={cn("mt-1.5 block truncate text-[11px] sm:text-xs", index === active ? "font-medium text-text-primary" : "text-text-secondary")}>
						{entry.label}
					</span>
				</li>
			))}
		</ol>
	);
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
	return <div className={cn("rounded-[10px] bg-card p-4 ring-1 ring-border sm:p-5", className)}>{children}</div>;
}

function ConnectStep({ onContinue, onSkip }: { onContinue: () => void; onSkip: () => void }) {
	const { data, isLoading, error: loadError } = useCloudflareConnection();
	const flow = useCloudflareConnectionFlow();
	const authMethod = useCurrentUser().data?.authMethod;
	const canManage = authMethod === "session";
	const fromEnv = data?.source === "env";
	const missing = data?.capabilities.filter((cap) => cap.status === "missing") ?? [];

	if (isLoading) return <Spinner label="Checking Cloudflare…" />;
	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold text-text-primary">Connect Cloudflare</h2>
				<p className="mt-1 text-sm text-text-secondary">The token lets cloudmail inspect your domains and make only the changes you approve.</p>
			</div>
			{loadError ? <InlineError message={authErrorMessage(loadError, "Couldn't load the connection.")} /> : null}
			{data ? (
				<Card className="space-y-4">
					{data.connected ? (
						<>
							<div className="flex items-start gap-3">
								<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-success/10 text-success"><Check size={17} aria-hidden /></span>
								<div className="min-w-0">
									<p className="font-medium text-text-primary">Cloudflare is connected</p>
									<p className="mt-0.5 break-words text-sm text-text-secondary">{data.accountName ?? data.accountId ?? "Cloudflare account"}</p>
									{fromEnv ? <p className="mt-1 text-xs text-text-tertiary">Using the CF_API_TOKEN Worker secret.</p> : null}
								</div>
							</div>
							{missing.length ? (
								<div className="rounded-[6px] bg-warning-bg p-3 text-sm text-warning-text">
									<p className="font-medium">The token is missing access to:</p>
									<ul className="mt-1 list-disc pl-5">{missing.map((cap) => <li key={cap.name}>{CF_CAPABILITY_LABELS[cap.name]}</li>)}</ul>
								</div>
							) : null}
							<button type="button" onClick={onContinue} className={cn(PRIMARY_BUTTON_CLASS, "min-h-11 w-full justify-center sm:w-auto")}>Continue</button>
						</>
					) : (
						<>
							{data.state === "reconnect_required" ? <p className="text-sm text-warning-text">The saved token can no longer be read. Paste it again.</p> : null}
							<a href={data.templateUrl} target="_blank" rel="noopener noreferrer" className={cn(PRIMARY_BUTTON_CLASS, "min-h-11 w-full justify-center sm:w-auto")}>
								<ExternalLink size={14} aria-hidden /> Create token
							</a>
							<p className="text-sm text-text-secondary">The DNS, Email Routing and sending permissions are preselected.</p>
							{canManage ? (
								<form onSubmit={(e) => { e.preventDefault(); if (!flow.token.trim()) return flow.setError("Paste the token first."); void flow.run({ kind: "connect", token: flow.token.trim() }); }} className="space-y-3">
									<SettingsField label="API token" type="password" autoComplete="off" spellCheck={false} value={flow.token} onChange={(e) => flow.setToken(e.target.value)} disabled={flow.busy} />
									<button type="submit" disabled={flow.busy || !flow.token.trim()} className={cn(PRIMARY_BUTTON_CLASS, "min-h-11 w-full justify-center sm:w-auto")}>
										{flow.connectPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null} Save and verify
									</button>
								</form>
							) : <p className="text-sm text-text-secondary">Saving a token needs a password sign-in in this browser.</p>}
							{flow.accounts ? (
								<div className="space-y-2"><p className="text-sm text-text-secondary">Choose the account to use:</p><div className="flex flex-wrap gap-2">{flow.accounts.map((account) => (
									<button key={account.id} type="button" className={SECONDARY_BUTTON_CLASS} disabled={flow.busy} onClick={() => void flow.run({ kind: "connect", token: flow.token.trim(), accountId: account.id })}>{account.name ?? account.id}</button>
								))}</div></div>
							) : null}
						</>
					)}
					{flow.pending ? <ReauthPrompt message="Connecting Cloudflare needs your password or a passkey." busy={flow.busy} pending={flow.reauthPending} onConfirm={flow.confirmReauth} onCancel={flow.cancelReauth} onError={flow.setError} /> : null}
					<InlineError message={flow.error} />
				</Card>
			) : null}
			<button type="button" onClick={onSkip} className="inline-flex min-h-11 items-center text-sm font-medium text-text-primary underline underline-offset-2 hover:text-accent">Skip, set up DNS by hand</button>
		</div>
	);
}

function LicenceStep({ onContinue }: { onContinue: () => void }) {
	const { data, isLoading, error } = useLicence();
	// Enforcement off (the vendor's own deployment): nothing to activate.
	const skipped = useRef(false);
	useEffect(() => {
		if (data?.status !== "off" || skipped.current) return;
		skipped.current = true;
		onContinue();
	}, [data?.status, onContinue]);
	if (isLoading || data?.status === "off") return <Spinner label="Checking the licence…" />;
	const done = data && !data.locked;
	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold text-text-primary">Activate your licence</h2>
				<p className="mt-1 text-sm text-text-secondary">Paste the licence key from your {PRODUCT_NAME} purchase email. It binds this deployment; the key itself isn't stored.</p>
			</div>
			<InlineError message={error ? authErrorMessage(error, "Couldn't check the licence.") : null} />
			<Card className="space-y-4">
				{done ? (
					<>
						<div className="flex items-start gap-3">
							<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-success/10 text-success"><Check size={17} aria-hidden /></span>
							<div className="min-w-0">
								<p className="font-medium text-text-primary">{statusLabel(data)}</p>
								{data.host ? <p className="mt-0.5 text-sm text-text-secondary">{data.host}</p> : null}
							</div>
						</div>
						<button type="button" onClick={onContinue} className={cn(PRIMARY_BUTTON_CLASS, "min-h-11 w-full justify-center sm:w-auto")}>Continue</button>
					</>
				) : (
					<>
						<p className="text-sm text-text-secondary">{PAUSED_WHILE_LOCKED}</p>
						<LicenceKeyForm submitLabel="Activate and continue" onActivated={onContinue} />
					</>
				)}
			</Card>
		</div>
	);
}

function DomainsStep({ selected, setSelected, onReview }: { selected: string[]; setSelected: (zones: string[]) => void; onReview: () => void }) {
	const discovery = useCloudflareDiscovery(true);
	const refresh = useRefreshCloudflareDiscovery();
	const data = discovery.data;
	const error = discovery.error ?? refresh.error;
	function toggle(id: string) {
		setSelected(selected.includes(id) ? selected.filter((value) => value !== id) : selected.length < 5 ? [...selected, id] : selected);
	}
	return (
		<div className="space-y-4">
			<div className="flex items-start justify-between gap-3">
				<div><h2 className="text-lg font-semibold text-text-primary">Pick domains</h2><p className="mt-1 text-sm text-text-secondary">Choose up to 5 domains. You can run setup again for the rest.</p></div>
				<button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending} className={cn(SECONDARY_BUTTON_CLASS, "min-h-11 shrink-0 px-3")} aria-label="Refresh domains">
					<RefreshCw size={14} className={refresh.isPending ? "animate-spin" : ""} aria-hidden /><span className="hidden sm:inline">Refresh</span>
				</button>
			</div>
			{discovery.isLoading ? <Spinner label="Finding domains…" /> : null}
			<InlineError message={error ? authErrorMessage(error, "Couldn't find your Cloudflare domains.") : null} />
			{data ? (
				<>
					{data.missingCapabilities.length ? <div className="rounded-[6px] bg-warning-bg p-3 text-sm text-warning-text">The token can't {data.missingCapabilities.map((name) => CF_CAPABILITY_LABELS[name].toLowerCase()).join(", ")}. Setup will show manual steps instead.</div> : null}
					{data.errors.map((message) => <InlineError key={message} message={message} />)}
					<ul className="divide-y divide-border/60 overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
						{data.zones.map((zone) => {
							const checked = selected.includes(zone.zoneId);
							const disabled = !checked && selected.length >= 5;
							return (
								<li key={zone.zoneId}>
									<label className={cn("flex min-h-16 items-start gap-3 px-4 py-3", disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer hover:bg-bg-muted/50")}>
										<input type="checkbox" className="mt-1 size-4 accent-accent" checked={checked} disabled={disabled} onChange={() => toggle(zone.zoneId)} />
										<span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-1.5"><span className="break-all text-sm font-medium text-text-primary">{zone.name}</span>{zone.managed ? <Pill tone="success">Managed</Pill> : null}{zone.envDomain ? <Pill tone="warning">From config</Pill> : null}</span><span className="mt-0.5 block text-xs text-text-secondary">{zoneStatusLine(zone)}</span></span>
									</label>
								</li>
							);
						})}
					</ul>
					{data.zones.length === 0 ? <Card><p className="text-sm font-medium text-text-primary">No visible domains</p><p className="mt-1 text-sm text-text-secondary">Check the token's zone access, then refresh.</p></Card> : null}
					{data.truncated ? <p className="text-xs text-text-tertiary">Showing {data.zones.length} of {data.zoneCount} domains. Only the first 12 active domains include a status check.</p> : null}
					<div className="flex items-center justify-between gap-3"><p className="text-xs text-text-tertiary">{selected.length} of 5 selected</p><button type="button" onClick={onReview} disabled={!selected.length} className={cn(PRIMARY_BUTTON_CLASS, "min-h-11 justify-center")}>Review setup</button></div>
				</>
			) : null}
		</div>
	);
}

function RecordLine({ record }: { record: DnsRecordLite }) {
	return <span className="block break-all">{record.type} {record.name} {record.priority !== undefined ? `${record.priority} ` : ""}{record.content}</span>;
}

function RecordDiff({ item }: { item: PlanItem }) {
	if (!item.before?.length && !item.after?.length) return null;
	return (
		<div className="mt-2 overflow-x-auto rounded-[6px] bg-bg-subtle p-2 font-mono text-[11px] leading-5">
			{item.before?.map((record, index) => <div key={`before-${record.id ?? index}`} className="text-destructive"><span aria-hidden>− </span><RecordLine record={record} /></div>)}
			{item.after?.map((record, index) => <div key={`after-${record.id ?? index}`} className="text-success"><span aria-hidden>+ </span><RecordLine record={record} /></div>)}
		</div>
	);
}

const TIER_COPY = {
	auto: { title: "We'll do this", description: "Safe additions and missing setup." },
	confirm: { title: "Needs your OK", description: "These changes replace or affect something already there." },
	manual: { title: "You do this", description: "Cloudflare needs you to complete these steps." },
	done: { title: "Already done", description: "Nothing to change." },
} as const;

function PlanItems({ items, tier, confirmed, setConfirmed }: { items: PlanItem[]; tier: PlanItem["tier"]; confirmed: Set<string>; setConfirmed: (next: Set<string>) => void }) {
	if (!items.length) return null;
	const body = (
		<ul className="mt-2 divide-y divide-border/60 rounded-[6px] ring-1 ring-border">
			{items.map((item) => (
				<li key={item.id} className="p-3">
					<label className={cn("flex items-start gap-2", tier === "confirm" && "cursor-pointer")}>
						{tier === "confirm" ? <input type="checkbox" className="mt-0.5 size-4 accent-accent" checked={confirmed.has(item.id)} onChange={() => { const next = new Set(confirmed); next.has(item.id) ? next.delete(item.id) : next.add(item.id); setConfirmed(next); }} /> : tier === "done" ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" aria-hidden /> : null}
						<span className="min-w-0"><span className="block text-sm font-medium text-text-primary">{item.title}</span><span className="mt-0.5 block text-xs text-text-secondary">{item.detail}</span></span>
					</label>
					{tier === "confirm" ? <RecordDiff item={item} /> : null}
					{tier === "manual" && item.manualSteps?.length ? <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-text-secondary">{item.manualSteps.map((step, index) => <li key={`${item.id}-${index}`}>{step}</li>)}</ol> : null}
				</li>
			))}
		</ul>
	);
	if (tier === "done") return <details className="group"><summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-text-secondary [&::-webkit-details-marker]:hidden"><ChevronDown size={14} className="-rotate-90 transition-transform group-open:rotate-0" aria-hidden />{TIER_COPY.done.title} ({items.length})</summary>{body}</details>;
	return <section><h4 className="text-sm font-semibold text-text-primary">{TIER_COPY[tier].title}</h4><p className="mt-0.5 text-xs text-text-tertiary">{TIER_COPY[tier].description}</p>{body}</section>;
}

function ReviewStep({ plan, confirmed, setConfirmed, onApply, onRecheck, stale, busy }: { plan: CfPlanResponse; confirmed: Set<string>; setConfirmed: (next: Set<string>) => void; onApply: () => void; onRecheck: () => void; stale: boolean; busy: boolean }) {
	const count = applyCount(plan.items, confirmed);
	return (
		<div className="space-y-5">
			<div><h2 className="text-lg font-semibold text-text-primary">Review the plan</h2><p className="mt-1 text-sm text-text-secondary">Nothing changes until you apply it. Check each existing record change separately.</p></div>
			{stale ? <div role="alert" className="rounded-[6px] bg-warning-bg p-3 text-sm font-medium text-warning-text">Something changed since you reviewed; review again.</div> : null}
			{groupPlanByDomain(plan.items, plan.zones).map((group) => {
				const tiers = groupPlanByTier(group.items);
				return <Card key={group.key} className="space-y-4"><h3 className="break-all text-base font-semibold text-text-primary">{group.label}</h3><PlanItems items={tiers.auto} tier="auto" confirmed={confirmed} setConfirmed={setConfirmed} /><PlanItems items={tiers.confirm} tier="confirm" confirmed={confirmed} setConfirmed={setConfirmed} /><PlanItems items={tiers.manual} tier="manual" confirmed={confirmed} setConfirmed={setConfirmed} /><PlanItems items={tiers.done} tier="done" confirmed={confirmed} setConfirmed={setConfirmed} /></Card>;
			})}
			{plan.items.some((item) => item.tier === "manual") ? <button type="button" onClick={onRecheck} disabled={busy} className={cn(SECONDARY_BUTTON_CLASS, "min-h-11")}><RefreshCw size={14} className={busy ? "animate-spin" : ""} aria-hidden />Re-check</button> : null}
			<div className="flex justify-end"><button type="button" onClick={onApply} disabled={busy || count === 0} className={cn(PRIMARY_BUTTON_CLASS, "min-h-11 justify-center")}>
				{busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null} Apply {count} {count === 1 ? "change" : "changes"}
			</button></div>
		</div>
	);
}

function ChangesList({ changes, busyId, onUndo }: { changes: CfDnsChange[]; busyId: string | null; onUndo: (id: string) => void }) {
	if (!changes.length) return null;
	return (
		<section id="changes" className="space-y-2 scroll-mt-24"><h3 className="text-sm font-semibold text-text-primary">Changes you can undo</h3><ul className="divide-y divide-border/60 overflow-hidden rounded-[8px] bg-card ring-1 ring-border">{changes.map((change) => (
			<li key={change.id} className="flex items-center gap-3 px-3 py-2.5"><span className="min-w-0 flex-1"><span className="block break-all font-mono text-xs text-text-primary">{change.recordType} {change.name}</span><span className="block text-xs text-text-tertiary">{change.zoneName ?? change.zoneId}</span></span>{change.revertedAt ? <Pill>Undone</Pill> : <button type="button" onClick={() => onUndo(change.id)} disabled={busyId === change.id} className={SECONDARY_BUTTON_CLASS}>{busyId === change.id ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <RotateCcw size={13} aria-hidden />}Undo</button>}</li>
		))}</ul></section>
	);
}

function ResultStep({ plan, results, retrying, onRetry, changes, busyChange, onUndo, onMailbox }: { plan: CfPlanResponse; results: ApplyItemResult[]; retrying: string | null; onRetry: (id: string) => void; changes: CfDnsChange[]; busyChange: string | null; onUndo: (id: string) => void; onMailbox: () => void }) {
	return (
		<div className="space-y-5"><div><h2 className="text-lg font-semibold text-text-primary">Setup result</h2><p className="mt-1 text-sm text-text-secondary">Each change reports what Cloudflare accepted.</p></div>
			<ul className="divide-y divide-border/60 overflow-hidden rounded-[8px] bg-card ring-1 ring-border">{results.map((result) => {
				const item = plan.items.find((candidate) => candidate.id === result.id);
				const Icon = result.status === "ok" ? CheckCircle2 : result.status === "error" ? XCircle : CircleDashed;
				return <li key={result.id} className="flex items-start gap-3 p-3"><Icon size={16} className={cn("mt-0.5 shrink-0", result.status === "ok" ? "text-success" : result.status === "error" ? "text-destructive" : "text-text-tertiary")} aria-hidden /><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-text-primary">{item?.title ?? result.id}</span><span className="mt-0.5 block text-xs text-text-secondary">{result.detail}</span></span>{result.status === "error" ? <button type="button" onClick={() => onRetry(result.id)} disabled={retrying === result.id} className={SECONDARY_BUTTON_CLASS}>{retrying === result.id ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}Retry</button> : null}</li>;
			})}</ul>
			<ChangesList changes={changes} busyId={busyChange} onUndo={onUndo} />
			<div className="flex flex-wrap items-center justify-between gap-3"><a href="#changes" className="text-sm font-medium text-text-secondary underline-offset-2 hover:underline">View changes and undo</a><button type="button" onClick={onMailbox} className={cn(PRIMARY_BUTTON_CLASS, "min-h-11 justify-center")}>Create your first mailbox</button></div>
		</div>
	);
}

function MailboxStep({ domain }: { domain: string }) {
	const navigate = useNavigate();
	const createMailbox = useCreateMailbox();
	const [prefix, setPrefix] = useState("hello");
	const [name, setName] = useState("Hello");
	const [mailboxId, setMailboxId] = useState<string>();
	const [baselineVersion, setBaselineVersion] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const live = useMailboxLiveUpdates(mailboxId, { mailboxLabel: mailboxId });
	const address = mailboxId ?? `${prefix.trim().toLowerCase()}@${domain}`;
	const baselineCaptured = useRef(false);
	useEffect(() => {
		if (!mailboxId || live.version === null || baselineCaptured.current) return;
		baselineCaptured.current = true;
		setBaselineVersion(live.version);
	}, [mailboxId, live.version]);
	const arrived = mailboxId !== undefined && baselineVersion !== null && (live.version !== baselineVersion || live.inboxUnread > 0);

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (!prefix.trim()) return;
		setError(null);
		try {
			const email = `${prefix.trim().toLowerCase()}@${domain}`;
			const mailbox = await createMailbox.mutateAsync({ email, name: name.trim() || prefix.trim() });
			setMailboxId(mailbox.id);
		} catch (err) { setError(authErrorMessage(err, "Couldn't create that mailbox.")); }
	}
	function finish() {
		try { localStorage.setItem(ONBOARDING_DISMISS_KEY, "1"); } catch { /* private mode */ }
		navigate(`/mail/${encodeURIComponent(mailboxId ?? address)}/inbox`);
	}
	return (
		<div className="space-y-5"><div><h2 className="text-lg font-semibold text-text-primary">Create your first mailbox</h2><p className="mt-1 text-sm text-text-secondary">Start with a simple address. You can add more later.</p></div>
			{!mailboxId ? <Card><form onSubmit={submit} className="space-y-3"><div className="flex items-end gap-2"><SettingsField label="Address" value={prefix} onChange={(e) => setPrefix(e.target.value.replace(/@.*$/, ""))} autoCapitalize="none" autoComplete="off" spellCheck={false} className="min-w-0 flex-1" inputClassName="min-h-11" /><span className="mb-3 shrink-0 text-sm text-text-secondary">@{domain}</span></div><SettingsField label="Display name" value={name} onChange={(e) => setName(e.target.value)} inputClassName="min-h-11" /><button type="submit" disabled={createMailbox.isPending || !prefix.trim()} className={cn(PRIMARY_BUTTON_CLASS, "min-h-11 w-full justify-center sm:w-auto")}>{createMailbox.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}Create mailbox</button><InlineError message={error} /></form></Card> : (
				<Card className="space-y-4"><div className="flex items-start gap-3"><Inbox size={20} className="mt-0.5 shrink-0 text-accent" aria-hidden /><div><p className="font-medium text-text-primary">Send a test from Gmail to</p><p className="mt-1 break-all font-mono text-sm text-text-primary">{address}</p></div></div><div aria-live="polite" className={cn("flex items-center gap-2 rounded-[6px] p-3 text-sm", arrived ? "bg-success/10 text-success" : "bg-bg-subtle text-text-secondary")}>{arrived ? <CheckCircle2 size={16} aria-hidden /> : live.stalled ? <AlertTriangle size={16} aria-hidden /> : <Loader2 size={16} className="animate-spin" aria-hidden />}{arrived ? "Your first message arrived." : live.stalled ? "Connection paused. We'll keep trying." : "Waiting for the first message…"}</div><button type="button" onClick={finish} className={cn(PRIMARY_BUTTON_CLASS, "min-h-11 w-full justify-center sm:w-auto")}>Finish and open inbox</button></Card>
			)}
		</div>
	);
}

export default function OnboardingRoute() {
	const navigate = useNavigate();
	const { data: me, isLoading: userLoading } = useCurrentUser();
	const planMutation = useCloudflarePlan();
	const applyMutation = useApplyCloudflarePlan();
	const changesQuery = useCloudflareChanges(false);
	const revertMutation = useRevertCloudflareChange();
	const [step, setStep] = useState<Step>("connect");
	const [selected, setSelected] = useState<string[]>([]);
	const [plan, setPlan] = useState<CfPlanResponse | null>(null);
	const [confirmed, setConfirmed] = useState(new Set<string>());
	const [applyResult, setApplyResult] = useState<CfApplyResponse | null>(null);
	const [stale, setStale] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [freshAction, setFreshAction] = useState<FreshAction | null>(null);
	const [retrying, setRetrying] = useState<string | null>(null);
	const [reverting, setReverting] = useState<string | null>(null);
	const { mutateAsync: reauth, isPending: reauthPending } = useReauth();

	if (userLoading) return <DashboardLayout><PageContainer narrow><Spinner label="Loading setup…" /></PageContainer></DashboardLayout>;
	if (!me || me.role !== "admin") return <Navigate to="/" replace />;

	async function loadPlan() {
		setError(null);
		try {
			const fresh = await planMutation.mutateAsync(selected);
			setPlan(fresh); setConfirmed(new Set()); setStale(false); setStep("review");
		} catch (err) { setError(authErrorMessage(err, "Couldn't build the setup plan.")); }
	}

	// `plan` is always the plan the admin last reviewed; retries build a fresh
	// plan without replacing it, so later retries compare against what was seen.
	async function runApply() {
		if (!plan) return;
		setError(null);
		const items = applySelection(plan.items, confirmed);
		try {
			const result = await applyMutation.mutateAsync({ zones: selected, planHash: plan.planHash, items });
			setApplyResult(result);
			setStep("result");
			void changesQuery.refetch();
		} catch (err) {
			if (err instanceof ApiError) {
				const fresh = planAfterStale(plan, err.body);
				if (fresh) { setPlan(fresh); setConfirmed(new Set()); setStale(true); setStep("review"); return; }
			}
			if (authErrorCode(err) === "reauth_required") { setFreshAction({ kind: "apply" }); return; }
			setError(authErrorMessage(err, "Couldn't apply the changes."));
		}
	}

	async function retry(id: string) {
		setRetrying(id); setError(null);
		try {
			const reviewed = plan?.items.find((candidate) => candidate.id === id);
			const fresh = await planMutation.mutateAsync(selected);
			const item = fresh.items.find((candidate) => candidate.id === id);
			if (!item || item.tier === "done") {
				setApplyResult((old) => old ? { ...old, results: old.results.map((entry) => entry.id === id ? { id, status: "ok", detail: item?.detail ?? "Already complete." } : entry) } : old);
				return;
			}
			// Never approve on the admin's behalf: a change that now needs a
			// confirmation it didn't have (or shows other records) goes back to review.
			const pick = retrySelection(reviewed, item, confirmed);
			if (!pick) { setPlan(fresh); setConfirmed(new Set()); setStale(true); setStep("review"); return; }
			await runApplyWithPlan(fresh, pick);
		} catch (err) {
			if (authErrorCode(err) === "reauth_required") { setFreshAction({ kind: "retry", id }); return; }
			setError(authErrorMessage(err, "Couldn't retry that change."));
		} finally { setRetrying(null); }
	}

	async function runApplyWithPlan(fresh: CfPlanResponse, pick: { id: string; confirm?: true }) {
		try {
			const result = await applyMutation.mutateAsync({ zones: selected, planHash: fresh.planHash, items: [pick] });
			setApplyResult((old) => old ? { ok: result.ok && old.ok, results: old.results.map((entry) => resultFor(result.results, entry.id) ?? entry) } : result);
			void changesQuery.refetch();
		} catch (err) {
			if (err instanceof ApiError) { const replacement = planAfterStale(fresh, err.body); if (replacement) { setPlan(replacement); setConfirmed(new Set()); setStale(true); setStep("review"); return; } }
			throw err;
		}
	}

	async function undo(id: string) {
		setReverting(id); setError(null);
		try { await revertMutation.mutateAsync(id); }
		catch (err) { if (authErrorCode(err) === "reauth_required") { setFreshAction({ kind: "revert", id }); return; } setError(authErrorMessage(err, "Couldn't undo that change.")); }
		finally { setReverting(null); }
	}

	async function confirmFresh(input: { password: string } | { passkey: true }) {
		setError(null);
		try {
			await reauth(input); const action = freshAction; setFreshAction(null);
			if (action?.kind === "apply") await runApply(); else if (action?.kind === "retry") await retry(action.id); else if (action?.kind === "revert") await undo(action.id);
		} catch (err) { setError(authErrorMessage(err, "Couldn't confirm it's you.")); }
	}

	const changeIds = new Set(applyResult?.results.flatMap((result) => result.changeIds ?? []) ?? []);
	const visibleChanges = (changesQuery.data?.changes ?? []).filter((change) => changeIds.has(change.id));
	const appliedDomain = plan?.zones.find((zone) => applyResult?.results.some((result) => result.status === "ok" && plan.items.find((item) => item.id === result.id)?.zoneId === zone.zoneId))?.name ?? plan?.zones[0]?.name ?? "";

	return (
		<DashboardLayout><PageContainer narrow><PageHeader icon={Cloud} title="Guided setup" />
			<StepRail step={step} />
			{error ? <div className="mb-4"><InlineError message={error} /></div> : null}
			{freshAction ? <div className="mb-4"><ReauthPrompt message="Changing Cloudflare needs your password or a passkey." busy={reauthPending} pending={reauthPending} onConfirm={confirmFresh} onCancel={() => { setFreshAction(null); setError(null); }} onError={setError} /></div> : null}
			{step === "connect" ? <ConnectStep onContinue={() => setStep("licence")} onSkip={() => { try { localStorage.setItem(ONBOARDING_DISMISS_KEY, "1"); } catch {} navigate("/settings/domains"); }} /> : null}
			{step === "licence" ? <LicenceStep onContinue={() => setStep("domains")} /> : null}
			{step === "domains" ? <DomainsStep selected={selected} setSelected={setSelected} onReview={() => void loadPlan()} /> : null}
			{step === "review" && plan ? <ReviewStep plan={plan} confirmed={confirmed} setConfirmed={setConfirmed} onApply={() => void runApply()} onRecheck={() => void loadPlan()} stale={stale} busy={planMutation.isPending || applyMutation.isPending} /> : null}
			{step === "result" && plan && applyResult ? <ResultStep plan={plan} results={applyResult.results} retrying={retrying} onRetry={(id) => void retry(id)} changes={visibleChanges} busyChange={reverting} onUndo={(id) => void undo(id)} onMailbox={() => setStep("mailbox")} /> : null}
			{step === "mailbox" ? <MailboxStep domain={appliedDomain} /> : null}
		</PageContainer></DashboardLayout>
	);
}
