// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → Notifications: Web Push on this and your other devices.
 *
 * Per person. The device list and preferences live in the AuthDO
 * (`/api/v1/push/*`); the browser half is `~/lib/web-push`. Preferences save as
 * they change, like the other autosave pages. The in-tab desktop alerts and
 * chime stay under Sending & notifications.
 */

import { BellRing, Loader2, Smartphone, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Switch } from "~/components/ui/switch";
import { showToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import {
	currentPushEnvironment,
	currentSubscription,
	disablePushHere,
	enablePush,
	pushSupport,
	type PushSupport,
} from "~/lib/web-push";
import { useMailboxes } from "~/queries/mailboxes";
import { useProducts } from "~/queries/products";
import {
	usePushDevices,
	usePushPrefs,
	useRevokePushDevice,
	useSendTestPush,
	useUpdatePushPrefs,
	type PushDevice,
} from "~/queries/push";
import { DEFAULT_PUSH_PREFS, type PushMailboxMode, type PushMailMode, type PushPrefsPatch } from "shared/push-policy";
import { ListRow, PRIMARY_BUTTON_CLASS, ROW_ICON_ACTION_CLASS, SaveStatus, SECONDARY_BUTTON_CLASS, SETTINGS_INPUT_CLASS } from "./settings-ui";

function Row({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
	return (
		<div className="flex items-start justify-between gap-4 p-5">
			<div className="min-w-0">
				<h4 className="text-sm font-medium text-text-primary">{title}</h4>
				<p className="mt-1 text-sm text-text-secondary">{description}</p>
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

function Card({ children }: { children: React.ReactNode }) {
	return <div className="divide-y divide-border/60 rounded-[8px] bg-card ring-1 ring-border">{children}</div>;
}

/** What to tell someone whose device cannot subscribe from here. */
function SupportNotice({ support }: { support: PushSupport }) {
	if (support === "supported") return null;
	const text: Record<Exclude<PushSupport, "supported">, { title: string; body: React.ReactNode }> = {
		"ios-needs-install": {
			title: "Add cloudmail to your Home Screen first",
			body: (
				<ol className="mt-2 list-decimal space-y-1 pl-5">
					<li>
						In Safari, tap the Share button, then <span className="font-medium">Add to Home Screen</span>.
					</li>
					<li>Open cloudmail from the new Home Screen icon and sign in.</li>
					<li>Come back to Settings → Notifications and turn them on.</li>
				</ol>
			),
		},
		"ios-too-old": {
			title: "This iOS version has no web notifications",
			body: "Notifications for web apps need iOS or iPadOS 16.4 or later. Update in Settings → General → Software Update.",
		},
		insecure: {
			title: "Notifications need a secure connection",
			body: "Open this page over https to turn them on.",
		},
		unsupported: {
			title: "This browser can't receive push notifications",
			body: "Try a current Chrome, Edge, Firefox or Safari.",
		},
	};
	const { title, body } = text[support];
	return (
		<div role="note" className="rounded-[8px] bg-bg-subtle p-4 text-sm text-text-secondary ring-1 ring-border">
			<p className="font-medium text-text-primary">{title}</p>
			<div className="mt-1">{body}</div>
		</div>
	);
}

function relative(iso: string | null): string | null {
	if (!iso) return null;
	const ms = Date.now() - new Date(iso).getTime();
	const mins = Math.round(ms / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins} min ago`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours} h ago`;
	return new Date(iso).toLocaleDateString();
}

const MODE_OPTIONS: { value: PushMailMode; label: string; hint: string }[] = [
	{ value: "all", label: "All new mail", hint: "Every message that lands in an Inbox" },
	{ value: "important", label: "Needs reply or VIP", hint: "Threads you wrote in, urgent mail, and VIP senders" },
	{ value: "products", label: "Only some products", hint: "Mail addressed to the products you pick" },
];

const MAILBOX_OPTIONS: { value: PushMailboxMode; label: string }[] = [
	{ value: "inherit", label: "Default" },
	{ value: "all", label: "All mail" },
	{ value: "important", label: "Needs reply or VIP" },
	{ value: "off", label: "Off" },
];

export default function NotificationSettings() {
	const env = useMemo(() => currentPushEnvironment(), []);
	const support: PushSupport = env ? pushSupport(env) : "unsupported";
	const devices = usePushDevices();
	const { data: prefsData } = usePushPrefs();
	const prefs = prefsData ?? DEFAULT_PUSH_PREFS;
	const update = useUpdatePushPrefs();
	const revoke = useRevokePushDevice();
	const test = useSendTestPush();
	const { data: mailboxes = [] } = useMailboxes();
	const { data: products = [] } = useProducts();

	const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
	const [enabling, setEnabling] = useState(false);
	const [permission, setPermission] = useState<NotificationPermission | null>(null);
	const [vipDraft, setVipDraft] = useState("");

	useEffect(() => {
		if (support !== "supported") return;
		setPermission(Notification.permission);
		void currentSubscription().then((s) => setThisEndpoint(s?.endpoint ?? null));
	}, [support]);

	const signedIn = devices.data !== null;
	const hasDevices = (devices.data?.length ?? 0) > 0;
	// The device list carries no endpoints, so "this device" is known only locally.
	const enabledHere = !!thisEndpoint;

	const save = (patch: PushPrefsPatch) =>
		update.mutate(patch, {
			onError: () => showToast({ kind: "error", message: "Could not save that preference.", description: "Try again." }),
		});

	const onEnable = async () => {
		setEnabling(true);
		const result = await enablePush();
		setEnabling(false);
		setPermission(typeof Notification !== "undefined" ? Notification.permission : null);
		if (result.ok) {
			setThisEndpoint(result.endpoint);
			void devices.refetch();
			showToast({ kind: "success", message: "Notifications are on for this device." });
		} else if (result.reason === "denied") {
			showToast({
				kind: "error",
				message: "This browser blocked notifications for this site.",
				description: "Allow them in the browser's site settings, then try again.",
			});
		} else if (result.reason === "failed") {
			showToast({ kind: "error", message: "Could not turn on notifications.", description: result.message });
		}
	};

	const onDisableHere = async () => {
		await disablePushHere();
		setThisEndpoint(null);
		void devices.refetch();
	};

	const onTest = () =>
		test.mutate(undefined, {
			onSuccess: (r) =>
				showToast({
					kind: r.sent > 0 ? "success" : "error",
					message: r.sent > 0 ? `Sent to ${r.sent} of ${r.devices} device${r.devices === 1 ? "" : "s"}.` : "No device accepted the notification.",
					description: r.removed > 0 ? `${r.removed} expired device${r.removed === 1 ? " was" : "s were"} removed.` : undefined,
				}),
			onError: (e) => showToast({ kind: "error", message: "Could not send a test notification.", description: (e as Error).message }),
		});

	const addVip = () => {
		const entry = vipDraft.trim().toLowerCase();
		if (!entry) return;
		if (!/^([^\s@]+@[^\s@]+\.[^\s@]+|@[^\s@]+\.[^\s@]+)$/.test(entry)) {
			showToast({ kind: "error", message: "Use an address (ada@example.com) or a domain (@example.com)." });
			return;
		}
		save({ vipSenders: [...new Set([...prefs.vipSenders, entry])] });
		setVipDraft("");
	};

	return (
		<section className="space-y-6" aria-labelledby="notifications-heading">
			<div className="flex items-center gap-2">
				<BellRing size={14} className="text-text-tertiary" aria-hidden />
				<h2 id="notifications-heading" className="text-base font-semibold text-text-primary">
					Notifications
				</h2>
				<SaveStatus status={update.status} className="ml-auto" />
			</div>

			<p className="text-sm text-text-secondary">
				Push notifications reach your devices even when cloudmail is closed. They show the sender and subject
				unless you hide them below, and never mail in Spam, the Screener, muted threads or mail filed away by
				rules or triage.
			</p>

			{/* This device */}
			<div className="space-y-3">
				<h3 className="text-sm font-semibold text-text-primary">This device</h3>
				<SupportNotice support={support} />
				{support === "supported" ? (
					<Card>
						<div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
							<div className="min-w-0">
								<h4 className="text-sm font-medium text-text-primary">
									{enabledHere ? "Notifications are on here" : "Get notifications on this device"}
								</h4>
								<p className="mt-1 text-sm text-text-secondary">
									{permission === "denied"
										? "This browser has blocked notifications for this site. Allow them in the browser's site settings, then turn them on."
										: enabledHere
											? "New mail, approvals and reminders will appear here."
											: "Your browser will ask for permission."}
								</p>
							</div>
							<div className="flex shrink-0 gap-2">
								{enabledHere ? (
									<button type="button" className={SECONDARY_BUTTON_CLASS} onClick={() => void onDisableHere()}>
										Turn off here
									</button>
								) : (
									<button
										type="button"
										className={PRIMARY_BUTTON_CLASS}
										onClick={() => void onEnable()}
										disabled={enabling || !signedIn || permission === "denied"}
									>
										{enabling ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
										Turn on notifications
									</button>
								)}
							</div>
						</div>
					</Card>
				) : null}
				{!signedIn ? (
					<p className="text-sm text-text-tertiary">Sign in as a person (not with an API token) to use notifications.</p>
				) : null}
			</div>

			{/* Devices */}
			<div className="space-y-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h3 className="text-sm font-semibold text-text-primary">Your devices</h3>
					<button type="button" className={SECONDARY_BUTTON_CLASS} onClick={onTest} disabled={!hasDevices || test.isPending}>
						{test.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
						Send test notification
					</button>
				</div>
				{devices.isLoading ? (
					<div aria-busy="true" aria-label="Loading devices" className="h-14 animate-pulse rounded-[8px] bg-bg-muted" />
				) : hasDevices ? (
					<ul className="space-y-2" aria-label="Devices receiving notifications">
						{devices.data!.map((d: PushDevice) => (
							<ListRow
								key={d.id}
								icon={<Smartphone size={16} />}
								title={d.label}
								details={[
									`added ${relative(d.created_at)}`,
									d.last_success_at ? `last delivered ${relative(d.last_success_at)}` : "nothing delivered yet",
									d.failures > 0 ? `${d.failures} failed` : null,
								]}
								actions={
									<button
										type="button"
										className={cn(ROW_ICON_ACTION_CLASS, "touch:h-11 touch:w-11")}
										aria-label={`Revoke ${d.label}`}
										onClick={() => revoke.mutate(d.id)}
										disabled={revoke.isPending}
									>
										<Trash2 size={14} aria-hidden />
									</button>
								}
							/>
						))}
					</ul>
				) : (
					<p className="text-sm text-text-tertiary">No devices yet. Turn on notifications on each device you want them on.</p>
				)}
			</div>

			{/* What to notify about */}
			<div className="space-y-3">
				<h3 className="text-sm font-semibold text-text-primary">What to notify about</h3>
				<Card>
					<Row title="New mail" description="Mail that lands in an Inbox you can read.">
						<Switch checked={prefs.newMail} onCheckedChange={(newMail) => save({ newMail })} aria-label="New mail" disabled={!signedIn} />
					</Row>
					<div className="space-y-3 p-5">
						<h4 id="push-mode-label" className="text-sm font-medium text-text-primary">
							Which new mail
						</h4>
						<div role="radiogroup" aria-labelledby="push-mode-label" className="flex flex-col gap-1.5">
							{MODE_OPTIONS.map((o) => {
								const active = prefs.mode === o.value;
								return (
									<button
										key={o.value}
										type="button"
										role="radio"
										aria-checked={active}
										disabled={!signedIn || !prefs.newMail}
										onClick={() => save({ mode: o.value })}
										className={cn(
											"flex min-h-11 flex-wrap items-baseline gap-x-2 rounded-[6px] border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/60 disabled:opacity-50",
											active ? "border-violet bg-violet/[0.07]" : "border-border hover:bg-bg-subtle/70",
										)}
									>
										<span className="text-sm font-medium text-text-primary">{o.label}</span>
										<span className="text-xs text-text-tertiary">{o.hint}</span>
									</button>
								);
							})}
						</div>
						{prefs.mode === "products" ? (
							<fieldset className="space-y-1.5 pt-1">
								<legend className="text-xs font-medium text-text-secondary">Products</legend>
								{products.length === 0 ? (
									<p className="text-sm text-text-tertiary">No products yet.</p>
								) : (
									products.map((p) => {
										const checked = prefs.products.includes(p.id);
										return (
											<label key={p.id} className="flex min-h-11 items-center gap-2 text-sm text-text-primary">
												<input
													type="checkbox"
													className="h-4 w-4 accent-[var(--color-accent)]"
													checked={checked}
													onChange={() =>
														save({ products: checked ? prefs.products.filter((id) => id !== p.id) : [...prefs.products, p.id] })
													}
												/>
												{p.name}
											</label>
										);
									})
								)}
							</fieldset>
						) : null}
						{prefs.mode === "important" ? (
							<div className="space-y-2 pt-1">
								<label htmlFor="push-vip" className="block text-xs font-medium text-text-secondary">
									VIP senders
								</label>
								<div className="flex gap-2">
									<input
										id="push-vip"
										className={SETTINGS_INPUT_CLASS}
										placeholder="ada@example.com or @example.com"
										value={vipDraft}
										onChange={(e) => setVipDraft(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												addVip();
											}
										}}
									/>
									<button type="button" className={SECONDARY_BUTTON_CLASS} onClick={addVip}>
										Add
									</button>
								</div>
								{prefs.vipSenders.length > 0 ? (
									<ul className="flex flex-wrap gap-1.5" aria-label="VIP senders">
										{prefs.vipSenders.map((v) => (
											<li key={v} className="inline-flex items-center gap-1 rounded-full bg-bg-subtle px-2.5 py-1 text-xs text-text-primary ring-1 ring-border">
												{v}
												<button
													type="button"
													className="rounded-full p-0.5 text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50"
													aria-label={`Remove ${v}`}
													onClick={() => save({ vipSenders: prefs.vipSenders.filter((x) => x !== v) })}
												>
													×
												</button>
											</li>
										))}
									</ul>
								) : null}
							</div>
						) : null}
					</div>
					<Row title="Pending approval" description="An agent or API send is waiting for you to approve it.">
						<Switch checked={prefs.approvals} onCheckedChange={(approvals) => save({ approvals })} aria-label="Pending approval" disabled={!signedIn} />
					</Row>
					<Row title="Follow-up reminders" description="Sent mail you asked to be reminded about got no reply.">
						<Switch checked={prefs.followups} onCheckedChange={(followups) => save({ followups })} aria-label="Follow-up reminders" disabled={!signedIn} />
					</Row>
				</Card>
			</div>

			{/* Per mailbox */}
			{mailboxes.length > 1 ? (
				<div className="space-y-3">
					<h3 className="text-sm font-semibold text-text-primary">Per mailbox</h3>
					<Card>
						{mailboxes.map((m) => {
							const id = m.email.toLowerCase();
							const value: PushMailboxMode = prefs.mailboxes[id] ?? "inherit";
							return (
								<div key={id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
									<label htmlFor={`push-mb-${id}`} className="min-w-0 break-all text-sm text-text-primary">
										{m.email}
									</label>
									<select
										id={`push-mb-${id}`}
										className={cn(SETTINGS_INPUT_CLASS, "sm:w-52 touch:h-11")}
										value={value}
										disabled={!signedIn || !prefs.newMail}
										onChange={(e) => save({ mailboxes: { [id]: e.target.value as PushMailboxMode } })}
									>
										{MAILBOX_OPTIONS.map((o) => (
											<option key={o.value} value={o.value}>
												{o.label}
											</option>
										))}
									</select>
								</div>
							);
						})}
					</Card>
				</div>
			) : null}

			{/* Privacy and quiet hours */}
			<div className="space-y-3">
				<h3 className="text-sm font-semibold text-text-primary">Privacy and quiet hours</h3>
				<Card>
					<Row title="Hide message content" description={'Show only "New mail in support@…", with no sender or subject, on the lock screen.'}>
						<Switch checked={prefs.hideContent} onCheckedChange={(hideContent) => save({ hideContent })} aria-label="Hide message content" disabled={!signedIn} />
					</Row>
					<Row title="Quiet hours" description="Hold notifications overnight. Mail still arrives; you just are not woken by it.">
						<Switch
							checked={prefs.quietHours.enabled}
							onCheckedChange={(enabled) => save({ quietHours: { enabled } })}
							aria-label="Quiet hours"
							disabled={!signedIn}
						/>
					</Row>
					<div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3">
						<div className="space-y-1.5">
							<label htmlFor="push-quiet-start" className="block text-[11px] font-medium text-text-secondary">
								From
							</label>
							<input
								id="push-quiet-start"
								type="time"
								className={SETTINGS_INPUT_CLASS}
								value={prefs.quietHours.start}
								disabled={!signedIn || !prefs.quietHours.enabled}
								onChange={(e) => e.target.value && save({ quietHours: { start: e.target.value } })}
							/>
						</div>
						<div className="space-y-1.5">
							<label htmlFor="push-quiet-end" className="block text-[11px] font-medium text-text-secondary">
								Until
							</label>
							<input
								id="push-quiet-end"
								type="time"
								className={SETTINGS_INPUT_CLASS}
								value={prefs.quietHours.end}
								disabled={!signedIn || !prefs.quietHours.enabled}
								onChange={(e) => e.target.value && save({ quietHours: { end: e.target.value } })}
							/>
						</div>
						<p className="col-span-2 self-end text-xs text-text-tertiary sm:col-span-1">
							{prefs.quietHours.timeZone
								? `In ${prefs.quietHours.timeZone}.`
								: "In the time zone from AI assistant settings (UTC if none is set)."}
						</p>
					</div>
				</Card>
			</div>
		</section>
	);
}
