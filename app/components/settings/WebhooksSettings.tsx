// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → Webhooks.
 *
 * Endpoints that receive a signed POST when mail arrives, is sent, fails,
 * bounces, or is opened or clicked. The secret is shown once, on create and on
 * rotate; after that only its last four characters are visible.
 */

import {
	AlertTriangle,
	Check,
	ChevronDown,
	ChevronRight,
	Loader2,
	MoreHorizontal,
	Plus,
	RefreshCw,
	Send,
	Webhook,
} from "lucide-react";
import { useId, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Switch } from "~/components/ui/switch";
import { formatRelativeTime } from "~/lib/auth-helpers";
import { toast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { useMailboxes } from "~/queries/mailboxes";
import {
	useCreateWebhook,
	useDeleteWebhook,
	useRetryWebhookDelivery,
	useRotateWebhookSecret,
	useTestWebhook,
	useUpdateWebhook,
	useWebhookDeliveries,
	useWebhooks,
} from "~/queries/webhooks";
import { ApiError } from "~/services/api";
import type { WebhookDelivery, WebhookEndpoint, WebhookInput } from "~/services/webhooks-api";
import {
	WEBHOOK_EVENT_LABELS,
	WEBHOOK_EVENT_TYPES,
	validateWebhookUrl,
	type WebhookEventType,
} from "shared/webhooks";
import {
	ConfirmDialog,
	CopyButton,
	InlineError,
	Pill,
	PRIMARY_BUTTON_CLASS,
	SecretBox,
	SECONDARY_BUTTON_CLASS,
	SectionHeading,
	SettingsField,
} from "./settings-ui";

function errorMessage(e: unknown, fallback: string): string {
	if (e instanceof ApiError) return e.message;
	return fallback;
}

/** 44px tall on touch screens, the compact 36px from `sm` up. */
const TOUCH = "max-sm:h-11 max-sm:min-w-11";

export default function WebhooksSettings({ isAdmin }: { isAdmin: boolean }) {
	const hooks = useWebhooks();
	const [editing, setEditing] = useState<WebhookEndpoint | "new" | null>(null);
	const [shownSecret, setShownSecret] = useState<{ name: string; secret: string } | null>(null);

	const unavailable = hooks.error instanceof ApiError && (hooks.error.status === 503 || hooks.error.status === 403);

	return (
		<section className="space-y-3">
			<SectionHeading icon={Webhook} title="Webhooks" busy={hooks.isFetching && !hooks.isLoading}>
				{!unavailable ? (
					<button type="button" onClick={() => setEditing("new")} className={cn(PRIMARY_BUTTON_CLASS, TOUCH)}>
						<Plus size={14} aria-hidden />
						Add endpoint
					</button>
				) : null}
			</SectionHeading>

			<div className="space-y-4 rounded-[8px] bg-card p-4 ring-1 ring-border sm:p-5">
				<p className="text-sm text-text-secondary">
					Send a signed HTTPS POST to your backend when mail arrives, is sent, fails, bounces, or is opened or
					clicked. Failed deliveries retry after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours.
					{isAdmin ? null : " You can add webhooks for the mailboxes whose settings you manage."}
				</p>

				{shownSecret ? (
					<SecretBox
						label={`Signing secret for ${shownSecret.name}`}
						value={shownSecret.secret}
						what="Secret copied"
						note="Store it with your backend now. It is not shown again; rotate it if you lose it."
					>
						<div className="flex justify-end">
							<button type="button" onClick={() => setShownSecret(null)} className={cn(PRIMARY_BUTTON_CLASS, "h-8", TOUCH)}>
								<Check size={13} aria-hidden />
								Done
							</button>
						</div>
					</SecretBox>
				) : null}

				{hooks.isLoading ? (
					<div className="space-y-2" aria-busy="true" aria-label="Loading webhooks">
						{[0, 1].map((i) => (
							<div key={i} className="h-16 animate-pulse rounded-[6px] bg-bg-muted" />
						))}
					</div>
				) : unavailable ? (
					<p className="text-sm text-text-secondary">{(hooks.error as ApiError).message}</p>
				) : hooks.isError ? (
					<div className="flex items-center gap-3 text-sm text-text-secondary">
						Couldn't load webhooks.
						<button type="button" onClick={() => hooks.refetch()} className={SECONDARY_BUTTON_CLASS}>
							Retry
						</button>
					</div>
				) : (hooks.data ?? []).length === 0 ? (
					<div className="rounded-[6px] border border-dashed border-border px-4 py-8 text-center">
						<p className="text-sm font-medium text-text-primary">No webhooks yet</p>
						<p className="mt-1 text-sm text-text-secondary">
							Add an endpoint to let your SaaS backend or an agent react to mail.
						</p>
					</div>
				) : (
					<ul className="divide-y divide-border/60 rounded-[6px] ring-1 ring-border">
						{hooks.data!.map((hook) => (
							<WebhookRow
								key={hook.id}
								hook={hook}
								onEdit={() => setEditing(hook)}
								onSecret={(secret) => setShownSecret({ name: hook.name, secret })}
							/>
						))}
					</ul>
				)}

				<VerifySnippet />
			</div>

			{editing ? (
				<WebhookDialog
					hook={editing === "new" ? null : editing}
					isAdmin={isAdmin}
					onClose={() => setEditing(null)}
					onCreated={(name, secret) => setShownSecret({ name, secret })}
				/>
			) : null}
		</section>
	);
}

/* --------------------------------- One endpoint -------------------------------- */

function WebhookRow({
	hook,
	onEdit,
	onSecret,
}: {
	hook: WebhookEndpoint;
	onEdit: () => void;
	onSecret: (secret: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [confirm, setConfirm] = useState<"delete" | "rotate" | null>(null);
	const update = useUpdateWebhook();
	const remove = useDeleteWebhook();
	const rotate = useRotateWebhookSecret();
	const test = useTestWebhook();
	const logId = useId();

	async function sendTest() {
		try {
			const delivery = await test.mutateAsync(hook.id);
			setOpen(true);
			if (delivery?.status === "delivered") {
				toast.success(`Test delivered (HTTP ${delivery.lastStatusCode})`);
			} else {
				toast.error(`Test failed: ${delivery?.lastError ?? "no response"}`);
			}
		} catch (e) {
			toast.error(errorMessage(e, "Couldn't send the test."));
		}
	}

	async function toggle(enabled: boolean) {
		try {
			await update.mutateAsync({ id: hook.id, patch: { enabled } });
		} catch (e) {
			toast.error(errorMessage(e, "Couldn't change that."));
		}
	}

	return (
		<li className="p-4">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="truncate text-sm font-medium text-text-primary">{hook.name}</span>
						{hook.enabled ? null : hook.disabledReason ? (
							<Pill tone="warning">Auto-disabled</Pill>
						) : (
							<Pill>Paused</Pill>
						)}
						{hook.enabled && hook.consecutiveFailures > 0 ? (
							<Pill tone="warning">{hook.consecutiveFailures} failing</Pill>
						) : null}
					</div>
					<p className="mt-0.5 truncate font-mono text-xs text-text-secondary" title={hook.url}>
						{hook.url}
					</p>
					<ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-tertiary" aria-label="Webhook details">
						<li>
							{hook.events.length === WEBHOOK_EVENT_TYPES.length
								? "All events"
								: hook.events.map((e) => WEBHOOK_EVENT_LABELS[e].label).join(", ")}
						</li>
						<li className="break-all">{hook.mailboxes === null ? "Every mailbox" : hook.mailboxes.join(", ")}</li>
						<li className="whitespace-nowrap">Secret …{hook.secretHint}</li>
					</ul>
					{hook.disabledReason ? (
						<p className="mt-2 flex items-start gap-1.5 text-xs text-warning-text">
							<AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
							{hook.disabledReason} Fix the endpoint, then switch it back on.
						</p>
					) : null}
				</div>

				<div className="flex shrink-0 items-center gap-1">
					{/* The switch is 36x20; the padding gives it a 44px touch area on phones. */}
					<span className="inline-flex items-center max-sm:h-11 max-sm:px-1">
						<Switch
							checked={hook.enabled}
							onCheckedChange={(next) => void toggle(next)}
							busy={update.isPending}
							aria-label={`${hook.enabled ? "Pause" : "Enable"} ${hook.name}`}
							className="max-sm:before:absolute max-sm:before:-inset-3 max-sm:before:content-[''] relative"
						/>
					</span>
					<button
						type="button"
						onClick={() => void sendTest()}
						disabled={test.isPending}
						className={cn(SECONDARY_BUTTON_CLASS, "h-8", TOUCH)}
					>
						{test.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Send size={13} aria-hidden />}
						Send test
					</button>
					<DropdownMenu>
						<DropdownMenuTrigger
							aria-label={`More actions for ${hook.name}`}
							className={cn(
								"inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-text-secondary hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/60",
								TOUCH,
							)}
						>
							<MoreHorizontal size={16} aria-hidden />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => setConfirm("rotate")}>Rotate secret</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem className="text-destructive" onSelect={() => setConfirm("delete")}>
								Delete
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			<button
				type="button"
				aria-expanded={open}
				aria-controls={logId}
				onClick={() => setOpen((v) => !v)}
				className={cn(
					"mt-3 inline-flex items-center gap-1 rounded-[6px] px-1 py-1 text-xs font-medium text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50",
					"max-sm:h-11",
				)}
			>
				{open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
				Recent deliveries
				{hook.lastSuccessAt ? (
					<span className="font-normal text-text-tertiary">· last success {formatRelativeTime(hook.lastSuccessAt)}</span>
				) : null}
			</button>
			<div id={logId}>{open ? <DeliveryLog webhookId={hook.id} /> : null}</div>

			<ConfirmDialog
				open={confirm === "delete"}
				onOpenChange={(o) => !o && setConfirm(null)}
				title={`Delete ${hook.name}?`}
				description="It stops receiving events immediately, and its delivery log is deleted with it."
				confirmLabel="Delete webhook"
				pending={remove.isPending}
				onConfirm={async () => {
					try {
						await remove.mutateAsync(hook.id);
						setConfirm(null);
						toast.success("Webhook deleted");
					} catch (e) {
						toast.error(errorMessage(e, "Couldn't delete it."));
					}
				}}
			/>
			<ConfirmDialog
				open={confirm === "rotate"}
				onOpenChange={(o) => !o && setConfirm(null)}
				title="Rotate the signing secret?"
				description="The old secret stops working at once, so deliveries fail verification until your backend has the new one."
				confirmLabel="Rotate secret"
				destructive={false}
				pending={rotate.isPending}
				onConfirm={async () => {
					try {
						const { secret } = await rotate.mutateAsync(hook.id);
						setConfirm(null);
						onSecret(secret);
					} catch (e) {
						toast.error(errorMessage(e, "Couldn't rotate the secret."));
					}
				}}
			/>
		</li>
	);
}

/* --------------------------------- Delivery log -------------------------------- */

function StatusChip({ delivery }: { delivery: WebhookDelivery }) {
	const map: Record<WebhookDelivery["status"], { label: string; tone: "success" | "warning" | "muted" | "admin" }> = {
		delivered: { label: "Delivered", tone: "success" },
		retrying: { label: "Retrying", tone: "warning" },
		pending: { label: "Pending", tone: "muted" },
		failed: { label: "Failed", tone: "admin" },
	};
	const { label, tone } = map[delivery.status];
	return (
		<span
			className={cn(
				"shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
				tone === "success" && "bg-success/10 text-success",
				tone === "warning" && "bg-warning-bg text-warning-text",
				tone === "muted" && "bg-bg-muted text-text-secondary",
				tone === "admin" && "bg-destructive-subtle text-destructive",
			)}
		>
			{label}
		</span>
	);
}

function DeliveryLog({ webhookId }: { webhookId: string }) {
	const deliveries = useWebhookDeliveries(webhookId);
	const retry = useRetryWebhookDelivery();
	const [expanded, setExpanded] = useState<string | null>(null);

	if (deliveries.isLoading) {
		return (
			<p className="mt-2 flex items-center gap-2 text-xs text-text-tertiary">
				<Loader2 size={12} className="animate-spin" aria-hidden /> Loading deliveries…
			</p>
		);
	}
	if (deliveries.isError) {
		return <p className="mt-2 text-xs text-destructive">Couldn't load deliveries.</p>;
	}
	const list = deliveries.data ?? [];
	if (list.length === 0) {
		return <p className="mt-2 text-xs text-text-tertiary">Nothing sent yet. Use "Send test" to try it.</p>;
	}

	return (
		<ul className="mt-2 divide-y divide-border/50 sm:rounded-[6px] sm:bg-bg-subtle/50 sm:ring-1 sm:ring-border/70">
			{list.map((d) => (
				<li key={d.id} className="py-2 sm:px-3">
					<div className="flex flex-wrap items-center gap-2">
						<StatusChip delivery={d} />
						<span className="font-mono text-xs text-text-primary">{d.eventType}</span>
						{d.test ? <Pill tone="violet">Test</Pill> : null}
					</div>
					{/* Separate items rather than one "a · b · c" string, so a wrap never starts with a dot. */}
					<ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-tertiary" aria-label="Delivery details">
						<li>{d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : d.attempts > 0 ? "No response" : "Not sent yet"}</li>
						{d.lastDurationMs != null && d.attempts > 0 ? <li>{d.lastDurationMs} ms</li> : null}
						<li>attempt {d.attempts}</li>
						<li>{formatRelativeTime(d.updatedAt)}</li>
						{d.status === "retrying" && d.nextAttemptAt ? <li>next {formatRelativeTime(d.nextAttemptAt)}</li> : null}
					</ul>
					{d.lastError && d.status !== "delivered" ? (
						<p className="mt-1 line-clamp-2 break-words text-xs text-text-secondary" title={d.lastError}>
							{d.lastError}
						</p>
					) : null}
					{(d.attemptLog?.length ?? 0) > 0 || d.status === "failed" || d.status === "retrying" ? (
						<div className="mt-1.5 flex items-center gap-1">
							{(d.attemptLog?.length ?? 0) > 0 ? (
								<button
									type="button"
									aria-expanded={expanded === d.id}
									onClick={() => setExpanded(expanded === d.id ? null : d.id)}
									className={cn(SECONDARY_BUTTON_CLASS, "h-7 px-2 text-xs", TOUCH)}
								>
									{expanded === d.id ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
									Attempts
								</button>
							) : null}
							{d.status === "failed" || d.status === "retrying" ? (
								<button
									type="button"
									disabled={retry.isPending}
									onClick={async () => {
										try {
											const out = await retry.mutateAsync({ deliveryId: d.id, webhookId });
											if (out?.status === "delivered") toast.success("Delivered");
											else toast.error(`Still failing: ${out?.lastError ?? "no response"}`);
										} catch (e) {
											toast.error(errorMessage(e, "Couldn't retry it."));
										}
									}}
									className={cn(SECONDARY_BUTTON_CLASS, "h-7 px-2 text-xs", TOUCH)}
								>
									<RefreshCw size={12} aria-hidden />
									Retry
								</button>
							) : null}
						</div>
					) : null}
					{expanded === d.id ? (
						<ol className="mt-2 space-y-1 border-l border-border pl-3">
							{d.attemptLog!.map((a) => (
								<li key={a.attempt} className="text-xs text-text-secondary">
									<span className="font-medium text-text-primary">#{a.attempt}</span>{" "}
									{new Date(a.at).toLocaleString()}, {a.statusCode ? `HTTP ${a.statusCode}` : "no response"},{" "}
									{a.durationMs} ms
									{a.error ? <span className="block line-clamp-2 break-words">{a.error}</span> : null}
								</li>
							))}
						</ol>
					) : null}
				</li>
			))}
		</ul>
	);
}

/* ------------------------------- Create / edit dialog -------------------------- */

function WebhookDialog({
	hook,
	isAdmin,
	onClose,
	onCreated,
}: {
	hook: WebhookEndpoint | null;
	isAdmin: boolean;
	onClose: () => void;
	onCreated: (name: string, secret: string) => void;
}) {
	const create = useCreateWebhook();
	const update = useUpdateWebhook();
	const mailboxes = useMailboxes();
	const [name, setName] = useState(hook?.name ?? "");
	const [url, setUrl] = useState(hook?.url ?? "");
	const [events, setEvents] = useState<WebhookEventType[]>(hook?.events ?? ["message.received"]);
	const [scope, setScope] = useState<"all" | "some">(hook ? (hook.mailboxes === null ? "all" : "some") : isAdmin ? "all" : "some");
	const [selected, setSelected] = useState<string[]>(hook?.mailboxes ?? []);
	const [error, setError] = useState<string | null>(null);
	const [touchedUrl, setTouchedUrl] = useState(false);
	const pending = create.isPending || update.isPending;
	const groupId = useId();
	const scopeId = useId();

	const urlCheck = url.trim() ? validateWebhookUrl(url) : null;
	const urlError = touchedUrl && urlCheck && !urlCheck.ok ? urlCheck.error : null;

	function toggleEvent(type: WebhookEventType) {
		setEvents((current) => (current.includes(type) ? current.filter((e) => e !== type) : [...current, type]));
	}
	function toggleMailbox(address: string) {
		setSelected((current) => (current.includes(address) ? current.filter((m) => m !== address) : [...current, address]));
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setTouchedUrl(true);
		if (!name.trim()) return setError("Give it a name.");
		const check = validateWebhookUrl(url);
		if (!check.ok) return setError(check.error);
		if (events.length === 0) return setError("Pick at least one event.");
		if (scope === "some" && selected.length === 0) return setError("Pick at least one mailbox.");
		const input: WebhookInput = {
			name: name.trim(),
			url: url.trim(),
			events,
			mailboxes: scope === "all" ? null : selected,
		};
		try {
			if (hook) {
				await update.mutateAsync({ id: hook.id, patch: input });
				toast.success("Webhook saved");
			} else {
				const { webhook, secret } = await create.mutateAsync(input);
				onCreated(webhook.name, secret);
			}
			onClose();
		} catch (err) {
			setError(errorMessage(err, "Couldn't save the webhook."));
		}
	}

	const allMailboxes = (mailboxes.data ?? []).map((m) => m.email.toLowerCase());

	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto max-sm:max-w-[calc(100vw-1.5rem)] max-sm:p-4">
				<form onSubmit={submit} className="space-y-4" noValidate>
					<DialogHeader className="pr-8 text-left">
						<DialogTitle className="text-base">{hook ? "Edit webhook" : "Add webhook"}</DialogTitle>
						<DialogDescription className="text-xs">
							Deliveries are signed with a secret you will see once, after saving.
						</DialogDescription>
					</DialogHeader>

					<SettingsField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Billing backend" maxLength={100} autoFocus />
					<SettingsField
						label="Endpoint URL"
						type="url"
						inputMode="url"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						onBlur={() => setTouchedUrl(true)}
						placeholder="https://api.example.com/hooks/tapetide"
						error={urlError}
						hint="HTTPS only. Private and internal addresses are refused."
						spellCheck={false}
					/>

					<fieldset aria-labelledby={groupId} className="space-y-2">
						<legend id={groupId} className="text-[11px] font-medium text-text-secondary">
							Events
						</legend>
						<div className="grid gap-1.5 sm:grid-cols-2">
							{WEBHOOK_EVENT_TYPES.map((type) => (
								<label
									key={type}
									className="flex min-h-11 cursor-pointer items-start gap-2 rounded-[6px] px-2 py-1.5 ring-1 ring-border hover:bg-bg-subtle sm:min-h-0"
								>
									<input
										type="checkbox"
										className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
										checked={events.includes(type)}
										onChange={() => toggleEvent(type)}
									/>
									<span className="min-w-0">
										<span className="block text-xs font-medium text-text-primary">{WEBHOOK_EVENT_LABELS[type].label}</span>
										<span className="block text-[11px] text-text-tertiary">{WEBHOOK_EVENT_LABELS[type].hint}</span>
									</span>
								</label>
							))}
						</div>
					</fieldset>

					<fieldset aria-labelledby={scopeId} className="space-y-2">
						<legend id={scopeId} className="text-[11px] font-medium text-text-secondary">
							Mailboxes
						</legend>
						<div
							className="grid grid-cols-2 gap-1 rounded-[6px] bg-bg-subtle p-1 ring-1 ring-border"
							role="radiogroup"
							aria-label="Which mailboxes"
						>
							{(
								[
									["all", "Every mailbox"],
									["some", "Only these"],
								] as const
							).map(([value, label]) => (
								<label
									key={value}
									className={cn(
										"inline-flex min-h-11 cursor-pointer items-center justify-center rounded-[4px] px-3 text-xs font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-violet/60 sm:min-h-8",
										scope === value
											? "bg-card text-text-primary shadow-sm ring-1 ring-border"
											: "text-text-secondary hover:text-text-primary",
										value === "all" && !isAdmin && "cursor-not-allowed opacity-50",
									)}
								>
									<input
										type="radio"
										name="scope"
										value={value}
										className="sr-only"
										checked={scope === value}
										disabled={value === "all" && !isAdmin}
										onChange={() => setScope(value)}
									/>
									{label}
								</label>
							))}
						</div>
						{!isAdmin ? (
							<p className="text-[11px] text-text-tertiary">Only an administrator can add a webhook for every mailbox.</p>
						) : null}
						{scope === "some" ? (
							<div className="max-h-48 space-y-1 overflow-y-auto rounded-[6px] p-1 ring-1 ring-border">
								{allMailboxes.length === 0 ? (
									<p className="p-2 text-xs text-text-tertiary">{mailboxes.isLoading ? "Loading…" : "No mailboxes."}</p>
								) : (
									allMailboxes.map((address) => (
										<label key={address} className="flex min-h-11 cursor-pointer items-center gap-2 rounded px-2 text-xs hover:bg-bg-subtle sm:min-h-8">
											<input
												type="checkbox"
												className="h-4 w-4 shrink-0 accent-accent"
												checked={selected.includes(address)}
												onChange={() => toggleMailbox(address)}
											/>
											<span className="truncate">{address}</span>
										</label>
									))
								)}
							</div>
						) : null}
					</fieldset>

					<InlineError message={error} />

					{/* Sticky so Save stays reachable while the form scrolls on a phone. */}
					<DialogFooter className="sticky bottom-0 -mx-4 -mb-4 gap-2 border-t border-border bg-card px-4 py-3 sm:static sm:m-0 sm:border-0 sm:p-0">
						<button type="button" onClick={onClose} className={cn(SECONDARY_BUTTON_CLASS, TOUCH)} disabled={pending}>
							Cancel
						</button>
						<button type="submit" className={cn(PRIMARY_BUTTON_CLASS, TOUCH)} disabled={pending}>
							{pending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
							{hook ? "Save" : "Add webhook"}
						</button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/* ------------------------------ Verification snippet -------------------------- */

const NODE_SNIPPET = `import crypto from "node:crypto";

// Use the raw request body, before any JSON parsing.
export function verifyTapetide(rawBody, headers, secret) {
  const ts = headers["x-tapetide-timestamp"];
  const header = headers["x-tapetide-signature"] ?? "";
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = "v1=" + crypto
    .createHmac("sha256", secret)
    .update(\`\${ts}.\${rawBody}\`)
    .digest("hex");
  return header.split(",").some((sig) => {
    const a = Buffer.from(sig.trim());
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}`;

const GO_SNIPPET = `import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// body is the raw request body, read before decoding.
func VerifyTapetide(r *http.Request, body []byte, secret string) bool {
	ts := r.Header.Get("X-Tapetide-Timestamp")
	n, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || math.Abs(float64(time.Now().Unix()-n)) > 300 {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "." + string(body)))
	expected := "v1=" + hex.EncodeToString(mac.Sum(nil))
	for _, sig := range strings.Split(r.Header.Get("X-Tapetide-Signature"), ",") {
		if hmac.Equal([]byte(strings.TrimSpace(sig)), []byte(expected)) {
			return true
		}
	}
	return false
}`;

function VerifySnippet() {
	const [lang, setLang] = useState<"node" | "go">("node");
	const code = lang === "node" ? NODE_SNIPPET : GO_SNIPPET;
	return (
		<details className="group min-w-0 max-w-full rounded-[6px] ring-1 ring-border">
			<summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-3 text-xs font-medium text-text-secondary hover:text-text-primary sm:min-h-9">
				<ChevronRight size={14} className="transition-transform group-open:rotate-90" aria-hidden />
				Verifying the signature
			</summary>
			<div className="space-y-3 border-t border-border px-3 pb-3 pt-3">
				<p className="text-xs text-text-secondary [overflow-wrap:anywhere]">
					Each request carries <code className="font-mono">X-Tapetide-Event</code>,{" "}
					<code className="font-mono">X-Tapetide-Delivery</code>, <code className="font-mono">X-Tapetide-Timestamp</code>{" "}
					and <code className="font-mono">X-Tapetide-Signature: v1=&lt;hex&gt;</code>, an HMAC-SHA256 of{" "}
					<code className="font-mono">{"${timestamp}.${body}"}</code> keyed with your secret. Answer 2xx within 10
					seconds; use <code className="font-mono">X-Tapetide-Delivery</code> to ignore repeats.
				</p>
				<div className="flex items-center gap-2">
					<div role="tablist" aria-label="Language" className="inline-flex rounded-[6px] p-0.5 ring-1 ring-border">
						{(["node", "go"] as const).map((l) => (
							<button
								key={l}
								type="button"
								role="tab"
								aria-selected={lang === l}
								onClick={() => setLang(l)}
								className={cn(
									"rounded-[4px] px-3 py-1 text-xs font-medium max-sm:h-10",
									lang === l ? "bg-accent-subtle text-accent-subtle-fg" : "text-text-secondary hover:text-text-primary",
								)}
							>
								{l === "node" ? "Node.js" : "Go"}
							</button>
						))}
					</div>
					<CopyButton text={code} what="Snippet copied" className="ml-auto max-sm:h-11" />
				</div>
				<pre className="max-h-80 max-w-full min-w-0 overflow-x-auto overflow-y-auto rounded-[6px] bg-bg-subtle p-3 font-mono text-[11px] leading-relaxed text-text-primary ring-1 ring-border/70">
					<code>{code}</code>
				</pre>
			</div>
		</details>
	);
}
