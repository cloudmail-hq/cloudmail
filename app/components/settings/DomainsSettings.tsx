// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Domains: the hostnames this deployment receives and sends mail for.
 *
 * Administrator-only. The list sits on top; picking a domain opens its detail
 * below it (and records it as `?domain=` so the view survives a reload and can
 * be linked). The detail carries one status row per DNS record (expected vs
 * current, from the last DoH audit), Verify now, the catch-all mailbox,
 * Cloudflare provisioning and deletion.
 *
 * Save model: every control here acts immediately (the catch-all picker saves
 * on change, with Undo in the toast); there are no forms to submit.
 *
 * Domains seeded from configuration (`source: "env"`) are listed like any
 * other but cannot be deleted here: removing them from the environment is the
 * only thing that would make them go away.
 */

import {
	AlertTriangle,
	Check,
	CheckCircle2,
	ChevronRight,
	CircleDashed,
	Cloud,
	Copy,
	Globe,
	Info,
	Loader2,
	Plus,
	RefreshCw,
	Trash2,
	X,
	XCircle,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { formatRelativeTime } from "~/lib/auth-helpers";
import { errorMessage, showToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import {
	useCreateDomain,
	useDeleteDomain,
	useDomain,
	useDomains,
	useProvisionDomain,
	useUpdateDomain,
	useVerifyDomain,
} from "~/queries/domains";
import { useMailboxes } from "~/queries/mailboxes";
import SendingHealthPanel from "~/components/SendingHealthPanel";
import { ApiError, type Domain, type DomainProvision } from "~/services/api";
import {
	checkHostname,
	dnsStatusRows,
	dnsStatusSummary,
	mailboxesOnDomain,
	statusTone,
	type DnsRowStatus,
	type DnsStatusRow,
	type StatusTone,
} from "../../../shared/domains-ui";
import {
	ConfirmDialog,
	copyText,
	InlineError,
	PRIMARY_BUTTON_CLASS,
	SaveStatus,
	SECONDARY_BUTTON_CLASS,
	DANGER_BUTTON_CLASS,
	SectionHeading,
	SETTINGS_INPUT_CLASS,
	SettingsField,
} from "./settings-ui";

/** 44px tall on phones, the settings-standard 36px from `sm` up. */
const TOUCH = "min-h-11 sm:min-h-9";

const TONE_CLASS: Record<StatusTone, string> = {
	success: "bg-success/10 text-success",
	warning: "bg-warning-bg text-warning-text",
	danger: "bg-destructive-subtle text-destructive",
	muted: "bg-bg-muted text-text-secondary dark:ring-1 dark:ring-inset dark:ring-border",
};

function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
	const text = status ?? "unknown";
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
				TONE_CLASS[statusTone(status)],
			)}
		>
			{label ? <span className="mr-1 font-normal">{label}</span> : null}
			{text}
		</span>
	);
}

export default function DomainsSettings() {
	const { data, isLoading, error } = useDomains();
	const location = useLocation();
	const navigate = useNavigate();
	const params = new URLSearchParams(location.search);
	const selected = params.get("domain");
	const [adding, setAdding] = useState(false);

	const select = (id: string | null) => {
		const next = new URLSearchParams(params);
		if (id) next.set("domain", id);
		else next.delete("domain");
		const search = next.toString();
		navigate({ search: search ? `?${search}` : "" }, { replace: true, preventScrollReset: true });
	};

	const domains = data?.domains ?? [];
	const cloudflare = data?.cloudflare;

	return (
		<section className="space-y-3">
			<SectionHeading icon={Globe} title="Domains" busy={isLoading}>
				<button
					type="button"
					onClick={() => setAdding(true)}
					className={cn(PRIMARY_BUTTON_CLASS, TOUCH)}
				>
					<Plus size={14} aria-hidden />
					Add domain
				</button>
			</SectionHeading>
			<p className="text-sm text-text-secondary">
				Every hostname this deployment receives and sends mail for. Mailboxes and
				aliases can only use these domains.{" "}
				<Link to="/onboarding" className="font-medium text-text-primary underline-offset-2 hover:underline">
					Run guided setup
				</Link>
			</p>

			{cloudflare && !cloudflare.configured ? <ManualModeNotice workerScriptName={cloudflare.workerScriptName} /> : null}

			{error ? (
				<InlineError message={errorMessage(error, "Couldn't load domains.")} />
			) : null}

			{!isLoading && !error && domains.length === 0 ? (
				<div className="rounded-[8px] bg-card px-5 py-10 text-center ring-1 ring-border">
					<p className="text-sm font-medium text-text-primary">No domains yet</p>
					<p className="mt-1 text-sm text-text-secondary">
						Add a domain to create mailboxes on it.
					</p>
				</div>
			) : null}

			{domains.length > 0 ? (
				<ul className="divide-y divide-border/60 overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
					{domains.map((domain) => (
						<li key={domain.id}>
							<DomainRow
								domain={domain}
								active={selected === domain.id || selected === domain.hostname}
								onSelect={() =>
									select(
										selected === domain.id || selected === domain.hostname
											? null
											: domain.id,
									)
								}
							/>
						</li>
					))}
				</ul>
			) : null}

			{selected ? <DomainDetail id={selected} onClose={() => select(null)} /> : null}

			{/* Spam-rate circuit breaker: complaint rate per sending domain, and Resume. */}
			<div className="space-y-2 pt-4">
				<h3 className="text-sm font-medium text-text-primary">Sending health</h3>
				<p className="text-sm text-text-secondary">
					Spam complaints over the last 7 days. Above 0.1% you are warned; above 0.3% (the Gmail and Yahoo limit)
					sequences and template sends from the domain pause until you resume them here.
				</p>
				<div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
					{/* This page is admin-only, so Resume is always offered. */}
					<SendingHealthPanel isAdmin />
				</div>
			</div>

			<AddDomainDialog
				open={adding}
				onOpenChange={setAdding}
				onCreated={(domain) => select(domain.id)}
			/>
		</section>
	);
}

function DomainRow({
	domain,
	active,
	onSelect,
}: {
	domain: Domain;
	active: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-expanded={active}
			className={cn(
				"flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet/50",
				active && "bg-accent-subtle/50",
			)}
		>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span className="break-all text-sm font-semibold text-text-primary">
						{domain.hostname}
					</span>
					<StatusBadge status={domain.status} />
				</div>
				{domain.displayName && domain.displayName !== domain.hostname ? (
					<p className="mt-0.5 truncate text-xs text-text-secondary">{domain.displayName}</p>
				) : null}
				<div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-text-tertiary">
					<StatusBadge status={domain.routingStatus} label="Routing" />
					<StatusBadge status={domain.sendingStatus} label="Sending" />
					<span>
						{domain.mailboxCount} {domain.mailboxCount === 1 ? "mailbox" : "mailboxes"}
					</span>
					<span aria-hidden>·</span>
					<span>{domain.source === "env" ? "From configuration" : "Added here"}</span>
				</div>
			</div>
			<ChevronRight
				size={16}
				aria-hidden
				className={cn(
					"mt-0.5 shrink-0 text-text-tertiary transition-transform",
					active && "rotate-90",
				)}
			/>
		</button>
	);
}

function AddDomainDialog({
	open,
	onOpenChange,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (domain: Domain) => void;
}) {
	const create = useCreateDomain();
	const [hostname, setHostname] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [zoneId, setZoneId] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setHostname("");
		setDisplayName("");
		setZoneId("");
		setError(null);
	}, [open]);

	const submit = (e: FormEvent) => {
		e.preventDefault();
		const check = checkHostname(hostname);
		if (!check.ok) {
			setError(check.error);
			return;
		}
		setError(null);
		create.mutate(
			{
				hostname: check.hostname,
				...(displayName.trim() ? { displayName: displayName.trim() } : {}),
				...(zoneId.trim() ? { zoneId: zoneId.trim() } : {}),
			},
			{
				onSuccess: ({ domain }) => {
					showToast({ kind: "success", message: `Added ${domain.hostname}` });
					onOpenChange(false);
					onCreated(domain);
				},
				onError: (err) =>
					setError(
						err instanceof ApiError && err.status === 409
							? `${check.hostname} is already added.`
							: errorMessage(err, "Couldn't add that domain."),
					),
			},
		);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
				<form onSubmit={submit} className="space-y-4">
					<DialogHeader>
						<DialogTitle className="text-base">Add domain</DialogTitle>
						<DialogDescription className="text-xs">
							The DNS records to publish are listed once it's added.
						</DialogDescription>
					</DialogHeader>
					<SettingsField
						label="Domain"
						value={hostname}
						onChange={(e) => setHostname(e.target.value)}
						placeholder="example.com"
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						required
						inputClassName={TOUCH}
					/>
					<SettingsField
						label="Display name"
						value={displayName}
						onChange={(e) => setDisplayName(e.target.value)}
						placeholder="Example Inc."
						hint="Optional. Shown in the domain list."
						inputClassName={TOUCH}
					/>
					<SettingsField
						label="Cloudflare zone ID"
						value={zoneId}
						onChange={(e) => setZoneId(e.target.value)}
						placeholder="Looked up automatically"
						autoComplete="off"
						spellCheck={false}
						hint="Optional. Only needed if the zone can't be found by name."
						inputClassName={cn("font-mono text-xs", TOUCH)}
					/>
					<InlineError message={error} />
					<DialogFooter className="gap-2">
						<button
							type="button"
							onClick={() => onOpenChange(false)}
							className={cn(SECONDARY_BUTTON_CLASS, TOUCH, "justify-center")}
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={create.isPending || !hostname.trim()}
							className={cn(PRIMARY_BUTTON_CLASS, TOUCH, "justify-center")}
						>
							{create.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
							Add domain
						</button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function DetailBlock({
	title,
	description,
	action,
	children,
}: {
	title: string;
	description?: React.ReactNode;
	action?: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<div className="space-y-3 p-4 sm:p-5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h4 className="text-sm font-semibold text-text-primary">{title}</h4>
					{description ? (
						<p className="mt-0.5 text-xs text-text-secondary">{description}</p>
					) : null}
				</div>
				{action}
			</div>
			{children}
		</div>
	);
}

/**
 * Shown once above the list when no Cloudflare token is available (neither a
 * connection in Settings → Cloudflare connection nor `CF_API_TOKEN`).
 * Provisioning is then manual, but the DNS check still works (it uses
 * DNS-over-HTTPS), so the notice says what to do rather than only what is
 * missing.
 */
function ManualModeNotice({ workerScriptName }: { workerScriptName: string }) {
	return (
		<details className="group rounded-[6px] bg-warning-bg px-3 py-2.5 text-sm text-warning-text ring-1 ring-warning-border">
			<summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-medium sm:min-h-0 [&::-webkit-details-marker]:hidden">
				<Info size={14} aria-hidden className="shrink-0" />
				<span className="min-w-0 flex-1">
					Manual setup: Cloudflare isn't connected, so provisioning is off. DNS checks still work.
				</span>
				<ChevronRight size={14} aria-hidden className="shrink-0 transition-transform group-open:rotate-90" />
			</summary>
			<div className="mt-2 space-y-2 text-text-secondary">
				<p>
					Open a domain below to see each record it needs, copy the values into your DNS
					provider, then press <span className="font-medium text-text-primary">Verify now</span>.
				</p>
				<p>To let this app set domains up for you instead:</p>
				<ol className="list-decimal space-y-1 pl-5">
					<li>
						Open{" "}
						<Link to="/settings/cloudflare" className="font-medium text-text-primary underline-offset-2 hover:underline">
							Settings → Cloudflare connection
						</Link>
						, create a token from the template and paste it. (A <code>CF_API_TOKEN</code> Worker secret works too.)
					</li>
					<li>
						Come back and press <span className="font-medium text-text-primary">Provision on Cloudflare</span>. The
						catch-all rule will point at the <code>{workerScriptName}</code> Worker.
					</li>
				</ol>
			</div>
		</details>
	);
}

const ROW_TONE: Record<DnsRowStatus, StatusTone> = {
	pass: "success",
	warn: "warning",
	fail: "danger",
	unchecked: "muted",
};

const ROW_LABEL: Record<DnsRowStatus, string> = {
	pass: "Pass",
	warn: "Warn",
	fail: "Fail",
	unchecked: "Not checked",
};

function RowStatusIcon({ status }: { status: DnsRowStatus }) {
	const Icon =
		status === "pass" ? CheckCircle2 : status === "warn" ? AlertTriangle : status === "fail" ? XCircle : CircleDashed;
	return <Icon size={14} aria-hidden className="shrink-0" />;
}

function DnsRowBadge({ status }: { status: DnsRowStatus }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
				TONE_CLASS[ROW_TONE[status]],
			)}
		>
			<RowStatusIcon status={status} />
			{ROW_LABEL[status]}
		</span>
	);
}

/** A compact copy button for a table cell: icon on desktop, 44px on touch. */
function CopyIconButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const t = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(t);
	}, [copied]);
	return (
		<button
			type="button"
			onClick={async () => setCopied(await copyText(text, label))}
			aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
			title={`Copy ${label.toLowerCase()}`}
			className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary hover:bg-bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50 touch:h-11 touch:w-11"
		>
			{copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
		</button>
	);
}

function ValueList({ values, empty, prose }: { values: string[]; empty: string; prose?: boolean }) {
	if (values.length === 0) return <span className="text-text-tertiary">{empty}</span>;
	return (
		<ul className="space-y-0.5">
			{values.map((v, i) => (
				// DNS tokens have no spaces, so they may break anywhere; prose
				// (Cloudflare-generated placeholders) wraps between words.
				<li key={i} className={prose ? "text-text-secondary" : "font-mono [overflow-wrap:anywhere]"}>
					{v}
				</li>
			))}
		</ul>
	);
}

/** A value with its copy button pinned top-right, so buttons line up down the column. */
function CopyableValue({
	label,
	values,
	empty,
	copy,
	prose,
}: {
	label: string;
	values: string[];
	empty: string;
	copy: boolean;
	prose?: boolean;
}) {
	return (
		<div className="flex items-start gap-1">
			<div className="min-w-0 flex-1 py-1">
				<ValueList values={values} empty={empty} prose={prose} />
			</div>
			{copy && values.length > 0 ? <CopyIconButton text={values.join("\n")} label={label} /> : null}
		</div>
	);
}

/**
 * One row per record: what it's for, its status at the last check, and the
 * name and expected value to publish beside what DNS answered, each with a
 * copy button.
 *
 * A real table from `md` up (scoped headers, so a screen reader reads
 * "Expected" with every value); stacked cards below that.
 */
function DnsStatusTable({ rows }: { rows: DnsStatusRow[] }) {
	return (
		<>
			<table className="hidden w-full table-fixed border-separate border-spacing-0 text-xs md:table">
				<caption className="sr-only">DNS records and their status at the last check</caption>
				<colgroup>
					<col className="w-[156px]" />
					<col className="w-[104px]" />
					<col />
					<col className="w-[30%]" />
				</colgroup>
				<thead>
					<tr className="text-left text-[11px] font-medium text-text-tertiary">
						<th scope="col" className="border-b border-border pb-2 pr-3 font-medium">
							Record
						</th>
						<th scope="col" className="border-b border-border pb-2 pr-3 font-medium">
							Status
						</th>
						<th scope="col" className="border-b border-border pb-2 pr-3 font-medium">
							Expected (name, value)
						</th>
						<th scope="col" className="border-b border-border pb-2 font-medium">
							Current
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.id} className="align-top">
							<th scope="row" className="border-b border-border/60 py-3 pr-3 text-left font-normal">
								<span className="flex flex-wrap items-center gap-1.5">
									<span className="rounded-[4px] bg-bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-text-primary">
										{row.type}
									</span>
									<span className="whitespace-nowrap font-medium text-text-primary">{row.label}</span>
								</span>
								<span className="mt-1 block text-text-tertiary">{row.role}</span>
							</th>
							<td className="border-b border-border/60 py-3 pr-3">
								<DnsRowBadge status={row.status} />
							</td>
							<td className="space-y-1 border-b border-border/60 py-2 pr-3 text-text-primary">
								<CopyableValue label="Name" values={[row.name]} empty="—" copy />
								<div className="border-t border-border/50 pt-1">
									<CopyableValue
										label="Value"
										values={row.expected}
										empty="—"
										copy={!row.generated}
										prose={row.generated}
									/>
								</div>
								{row.note ? <p className="text-text-tertiary">{row.note}</p> : null}
							</td>
							<td className="border-b border-border/60 py-3 text-text-primary">
								{row.status === "unchecked" ? (
									<span className="text-text-tertiary">Not checked yet</span>
								) : (
									<ValueList values={row.found} empty="Nothing published" />
								)}
								{row.message && row.status !== "pass" ? (
									<p className="mt-1 text-text-secondary">{row.message}</p>
								) : null}
							</td>
						</tr>
					))}
				</tbody>
			</table>

			<ul className="space-y-2 md:hidden" aria-label="DNS records">
				{rows.map((row) => (
					<li key={row.id} className="rounded-[6px] p-3 ring-1 ring-border">
						<div className="flex flex-wrap items-center gap-2">
							<span className="rounded-[4px] bg-bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-text-primary">
								{row.type}
							</span>
							<span className="text-sm font-medium text-text-primary">{row.label}</span>
							<DnsRowBadge status={row.status} />
						</div>
						<p className="mt-1 text-xs text-text-tertiary">{row.role}</p>
						<dl className="mt-2 space-y-2 text-xs">
							<div>
								<dt className="text-text-tertiary">Name</dt>
								<dd className="text-text-primary">
									<CopyableValue label="Name" values={[row.name]} empty="—" copy />
								</dd>
							</div>
							<div>
								<dt className="text-text-tertiary">Expected</dt>
								<dd className="text-text-primary">
									<CopyableValue
										label="Value"
										values={row.expected}
										empty="—"
										copy={!row.generated}
										prose={row.generated}
									/>
								</dd>
							</div>
							<div>
								<dt className="text-text-tertiary">Current</dt>
								<dd className="text-text-primary">
									{row.status === "unchecked" ? (
										<span className="text-text-tertiary">Not checked yet</span>
									) : (
										<ValueList values={row.found} empty="Nothing published" />
									)}
								</dd>
							</div>
						</dl>
						{row.message && row.status !== "pass" ? (
							<p className="mt-2 text-xs text-text-secondary">{row.message}</p>
						) : null}
						{row.note ? <p className="mt-1 text-xs text-text-tertiary">{row.note}</p> : null}
					</li>
				))}
			</ul>
		</>
	);
}

function DomainDetail({ id, onClose }: { id: string; onClose: () => void }) {
	const { data, isLoading, error } = useDomain(id);
	const verify = useVerifyDomain();
	const provision = useProvisionDomain();
	const update = useUpdateDomain();
	const remove = useDeleteDomain();
	const { data: mailboxes = [] } = useMailboxes();
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [confirmProvision, setConfirmProvision] = useState(false);
	const [overwriteCatchAll, setOverwriteCatchAll] = useState(false);
	const overwriteId = useId();
	const [lastProvision, setLastProvision] = useState<DomainProvision | null>(null);
	const catchAllId = useId();
	const catchAllHintId = useId();

	// A different domain's run must not linger under this one.
	useEffect(() => setLastProvision(null), [id]);

	if (isLoading) {
		return (
			<div
				aria-busy="true"
				aria-label="Loading domain"
				className="space-y-3 rounded-[8px] bg-card p-5 ring-1 ring-border"
			>
				<div className="h-5 w-48 animate-pulse rounded bg-bg-muted" />
				<div className="h-3 w-72 animate-pulse rounded bg-bg-muted/70" />
				{Array.from({ length: 5 }, (_, i) => (
					<div key={i} className="h-10 animate-pulse rounded bg-bg-muted/50" />
				))}
			</div>
		);
	}
	if (error || !data) {
		return (
			<div className="rounded-[8px] bg-card p-5 ring-1 ring-border">
				<InlineError message={errorMessage(error, "Couldn't load that domain.")} />
			</div>
		);
	}

	const { domain, records, manualSteps, audit, cloudflare } = data;
	const provisionResult = lastProvision ?? data.provision;
	const onDomain = mailboxesOnDomain(mailboxes, domain.hostname);
	const canDelete = domain.source !== "env";
	const rows = dnsStatusRows(records, audit);
	const counts = dnsStatusSummary(rows);

	const runVerify = () =>
		verify.mutate(domain.id, {
			onSuccess: ({ audit }) => {
				const issues = audit.checks.filter((c) => c.status !== "pass").length;
				showToast({
					kind: audit.summary === "pass" ? "success" : "warning",
					message:
						audit.summary === "pass"
							? `${domain.hostname}: DNS looks right`
							: `${domain.hostname}: ${issues} record${issues === 1 ? "" : "s"} need attention`,
				});
			},
			onError: (err) => showToast({ kind: "error", message: errorMessage(err, "Couldn't check DNS.") }),
		});

	const runProvision = () =>
		provision.mutate(
			{
				id: domain.id,
				overwriteCatchAll,
				// The dialog below is the explicit confirmation env domains need.
				confirmEnvDomain: domain.source === "env",
			},
			{
				onSuccess: ({ provision }) => {
					setConfirmProvision(false);
					setOverwriteCatchAll(false);
					setLastProvision(provision);
					showToast({
						kind: provision.ok ? "success" : "warning",
						message: provision.ok ? "Provisioned on Cloudflare" : "Provisioning finished with problems",
					});
				},
				onError: (err) =>
					showToast({ kind: "error", message: errorMessage(err, "Couldn't provision on Cloudflare.") }),
			},
		);

	/**
	 * Autosaves, with Undo in the toast: the catch-all decides where unknown
	 * mail goes, so a slip of the picker should be one click to reverse.
	 */
	const setCatchAll = (value: string, previous = domain.catchAllMailbox ?? "") =>
		update.mutate(
			{ id: domain.id, patch: { catchAllMailbox: value || null } },
			{
				onSuccess: () =>
					showToast({
						kind: "success",
						message: value ? `Unknown addresses on ${domain.hostname} go to ${value}` : `Unknown addresses on ${domain.hostname} are dropped`,
						action: {
							label: "Undo",
							onClick: (dismiss) => {
								dismiss();
								setCatchAll(previous, value);
							},
						},
					}),
				onError: (err) => showToast({ kind: "error", message: errorMessage(err, "Couldn't save the catch-all.") }),
			},
		);

	const doDelete = () =>
		remove.mutate(domain.id, {
			onSuccess: () => {
				setConfirmDelete(false);
				showToast({ kind: "success", message: `Removed ${domain.hostname}` });
				onClose();
			},
			onError: (err) => {
				setConfirmDelete(false);
				showToast({ kind: "error", message: errorMessage(err, "Couldn't remove that domain.") });
			},
		});

	const verifyButton = (
		<button
			type="button"
			onClick={runVerify}
			disabled={verify.isPending}
			className={cn(PRIMARY_BUTTON_CLASS, TOUCH)}
		>
			{verify.isPending ? (
				<Loader2 size={13} className="animate-spin" aria-hidden />
			) : (
				<RefreshCw size={13} aria-hidden />
			)}
			{verify.isPending ? "Checking…" : "Verify now"}
		</button>
	);

	return (
		<div
			className="divide-y divide-border/60 rounded-[8px] bg-card ring-1 ring-border"
			aria-label={`${domain.hostname} details`}
			role="region"
		>
			{/* Header */}
			<div className="flex items-start gap-3 p-4 sm:p-5">
				<div className="min-w-0 flex-1">
					<h3 className="break-all text-base font-semibold text-text-primary">{domain.hostname}</h3>
					<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
						<StatusBadge status={domain.status} />
						<StatusBadge status={domain.routingStatus} label="Routing" />
						<StatusBadge status={domain.sendingStatus} label="Sending" />
					</div>
					<p className="mt-1.5 text-xs text-text-tertiary">
						Last checked {formatRelativeTime(domain.lastCheckedAt)}
						{domain.zoneId ? (
							<>
								{" · "}Zone <span className="break-all font-mono">{domain.zoneId}</span>
							</>
						) : null}
					</p>
					{domain.lastError ? (
						<p className="mt-2 break-words text-xs text-destructive">{domain.lastError}</p>
					) : null}
				</div>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close domain details"
					className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary hover:bg-bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50 sm:h-8 sm:w-8"
				>
					<X size={16} aria-hidden />
				</button>
			</div>

			{/* DNS status */}
			<DetailBlock
				title="DNS records"
				description={
					audit ? (
						<span aria-live="polite">
							{counts.pass} passing
							{counts.warn ? `, ${counts.warn} warning` : ""}
							{counts.fail ? `, ${counts.fail} failing` : ""}. Checked {formatRelativeTime(audit.checkedAt)}{" "}
							over DNS-over-HTTPS.
						</span>
					) : (
						"Not checked yet. Verify compares what DNS answers with what each record should be."
					)
				}
				action={verifyButton}
			>
				{rows.length === 0 ? (
					<p className="text-sm text-text-tertiary">No records to publish.</p>
				) : (
					<DnsStatusTable rows={rows} />
				)}
				{!cloudflare.configured && manualSteps.length > 0 ? (
					<details className="rounded-[6px] bg-bg-subtle/60 px-3 py-2 ring-1 ring-border">
						<summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-xs font-semibold text-text-primary sm:min-h-0 [&::-webkit-details-marker]:hidden">
							<ChevronRight size={14} aria-hidden className="shrink-0 transition-transform [details[open]_&]:rotate-90" />
							Step-by-step in the Cloudflare dashboard
						</summary>
						<ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-text-secondary">
							{manualSteps.map((step, i) => (
								<li key={i} className="break-words">
									{step.replace('"Re-check DNS"', '"Verify now"')}
								</li>
							))}
						</ol>
					</details>
				) : null}
			</DetailBlock>

			{/* Catch-all */}
			<DetailBlock
				title="Catch-all mailbox"
				description="Where mail to an address with no mailbox or alias on this domain goes. Saves as you choose."
				action={<SaveStatus status={update.status} />}
			>
				<div className="space-y-1.5">
					<label htmlFor={catchAllId} className="block text-[11px] font-medium text-text-secondary">
						Deliver unknown addresses to
					</label>
					<select
						id={catchAllId}
						value={domain.catchAllMailbox ?? ""}
						onChange={(e) => setCatchAll(e.target.value)}
						disabled={update.isPending}
						aria-describedby={catchAllHintId}
						className={cn(SETTINGS_INPUT_CLASS, TOUCH, "max-w-md")}
					>
						<option value="">None: drop unknown addresses</option>
						{onDomain.map((m) => (
							<option key={m.id} value={m.email}>
								{m.email}
							</option>
						))}
						{/* Keep a stored target selectable even if it isn't listed. */}
						{domain.catchAllMailbox && !onDomain.some((m) => m.email === domain.catchAllMailbox) ? (
							<option value={domain.catchAllMailbox}>{domain.catchAllMailbox}</option>
						) : null}
					</select>
					<p id={catchAllHintId} className="text-xs text-text-tertiary">
						{onDomain.length === 0
							? `Create a mailbox on ${domain.hostname} to use it as the catch-all.`
							: cloudflare.configured
								? "Cloudflare's catch-all rule must send to this Worker for this to take effect. Provisioning sets that up."
								: "Cloudflare's catch-all rule must send to this Worker (step 3 of the dashboard steps above)."}
					</p>
				</div>
			</DetailBlock>

			{/* Provision */}
			<DetailBlock
				title="Cloudflare"
				description={
					cloudflare.configured
						? "Enables Email Routing, routes addresses to this Worker, sets up sending and creates the DNS records."
						: "Manual mode. Connect Cloudflare in Settings → Cloudflare connection to let this app do it."
				}
				action={
					cloudflare.configured ? (
						<button
							type="button"
							onClick={() => setConfirmProvision(true)}
							disabled={provision.isPending}
							className={cn(SECONDARY_BUTTON_CLASS, TOUCH)}
						>
							{provision.isPending ? (
								<Loader2 size={13} className="animate-spin" aria-hidden />
							) : (
								<Cloud size={13} aria-hidden />
							)}
							Provision on Cloudflare
						</button>
					) : null
				}
			>
				{provisionResult ? (
					<div className="space-y-1.5">
						<p className="text-xs text-text-tertiary">Last run {formatRelativeTime(provisionResult.ranAt)}</p>
						<ul className="space-y-1.5">
							{provisionResult.steps.map((step, i) => (
								<li
									key={`${step.step}-${i}`}
									className="flex flex-wrap items-start gap-2 rounded-[6px] px-3 py-2 ring-1 ring-border"
								>
									<StatusBadge status={step.status} />
									<span className="font-mono text-xs text-text-primary">{step.step}</span>
									<span className="min-w-0 flex-1 basis-full break-words text-xs text-text-secondary sm:basis-auto">
										{step.detail}
									</span>
								</li>
							))}
						</ul>
					</div>
				) : null}
			</DetailBlock>

			{/* Delete */}
			<DetailBlock
				title="Remove domain"
				description={
					canDelete
						? "Stops treating this as one of your domains. Mailboxes on it have to be deleted first."
						: "This domain comes from the Worker's DOMAINS/ZONES configuration. Remove it there to remove it here."
				}
				action={
					<button
						type="button"
						onClick={() => setConfirmDelete(true)}
						disabled={!canDelete || remove.isPending}
						className={cn(DANGER_BUTTON_CLASS, TOUCH)}
					>
						<Trash2 size={13} aria-hidden />
						Remove
					</button>
				}
			/>

			<ConfirmDialog
				open={confirmProvision}
				onOpenChange={(open) => {
					setConfirmProvision(open);
					if (!open) setOverwriteCatchAll(false);
				}}
				title={`Provision ${domain.hostname} on Cloudflare?`}
				description={
					domain.source === "env"
						? `${domain.hostname} comes from DOMAINS/ZONES and is probably already receiving mail. Provisioning only adds what is missing, but it does change live Cloudflare settings for this zone.`
						: "Enables Email Routing, sets up sending and adds the DNS records. Steps already done are skipped."
				}
				confirmLabel="Provision"
				onConfirm={runProvision}
				pending={provision.isPending}
				destructive={domain.source === "env"}
			>
				<div className="space-y-2">
					<label htmlFor={overwriteId} className="flex min-h-11 items-start gap-2 text-sm text-text-primary sm:min-h-0">
						<input
							id={overwriteId}
							type="checkbox"
							className="mt-0.5 size-4 accent-accent"
							checked={overwriteCatchAll}
							onChange={(e) => setOverwriteCatchAll(e.target.checked)}
						/>
						<span>Overwrite the existing catch-all rule</span>
					</label>
					<p className="text-xs text-text-secondary">
						{overwriteCatchAll
							? domain.catchAllMailbox
								? `Every unknown address on ${domain.hostname} will be delivered to ${domain.catchAllMailbox}.`
								: `Every unknown address on ${domain.hostname} will reach this Worker and be dropped, instead of bouncing. Pick a catch-all mailbox first if you want to keep that mail.`
							: "Left unchecked, an existing catch-all rule (even a disabled one) is not changed and Cloudflare keeps bouncing unknown addresses."}
					</p>
				</div>
			</ConfirmDialog>

			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={`Remove ${domain.hostname}?`}
				description="DNS records and Cloudflare settings are left as they are. You can add the domain again later."
				confirmLabel="Remove domain"
				onConfirm={doDelete}
				pending={remove.isPending}
			/>
		</div>
	);
}
