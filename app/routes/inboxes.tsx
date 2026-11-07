/**
 * Mailbox chooser and the entry point into the mail workspace.
 *
 * Mounted at `/`, so the first thing anyone sees is their mail rather than a
 * secondary view. With exactly one mailbox it redirects straight into the inbox;
 * the list only earns screen time when there is a choice to make.
 */

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Eye, EyeOff, Inbox, Layers, Mail, Plus, Trash2 } from "lucide-react";
import MailAccountsPane from "~/components/mail/MailAccountsPane";
import OnboardingBanner from "~/components/onboarding/OnboardingBanner";
import DashboardLayout from "~/components/DashboardLayout";
import { errorMessage, showToast } from "~/lib/toast";
import { queryKeys } from "~/queries/keys";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxes,
} from "~/queries/mailboxes";
import api from "~/services/api";
import { useZoneStore } from "~/hooks/useZoneStore";
import { useMailboxVisibilityStore } from "~/hooks/useMailboxVisibilityStore";
import {
	canHideMailbox,
	isMailboxHidden,
	visibleMailboxes,
} from "~/lib/mailbox-visibility";
import { PageContainer, PageHeader } from "~/components/ui/page";

/**
 * No `title` here on purpose.
 *
 * The document title is the configurable app name, which is only known once the
 * branding record has loaded. A static `title` in a route's `meta()` wins over
 * `document.title`, so declaring one here would stamp a hardcoded product name
 * back over the configured one every time this route rendered. `BrandingHead`
 * (mounted in `root.tsx`) owns the title instead.
 */
export function meta() {
	return [
		{
			name: "description",
			content: "Choose a mailbox to open.",
		},
	];
}

/**
 * Unread count for one mailbox.
 *
 * A chooser listing addresses and nothing else gives no reason to pick one, so
 * each row carries its inbox unread count. Its own component, and its own query,
 * because the counts live in per-mailbox Durable Objects with no endpoint that
 * aggregates them — one request per row is the shape the data actually has.
 * `/state` is two single-row reads, which is what makes that acceptable.
 */
function MailboxUnreadBadge({ mailboxId }: { mailboxId: string }) {
	const { data } = useQuery({
		queryKey: ["mailbox-state", mailboxId],
		queryFn: () => api.getMailboxState(mailboxId),
		// Cheap, but not so cheap it should refetch on every focus change while
		// the user reads down a list of a dozen mailboxes.
		staleTime: 30_000,
	});

	if (!data?.inboxUnread) return null;

	return (
		<span className="shrink-0 rounded-full bg-accent-subtle px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-accent-subtle-fg">
			{data.inboxUnread > 99 ? "99+" : data.inboxUnread}
			<span className="sr-only"> unread</span>
		</span>
	);
}

/** Rows in the shape of the real ones, so the list does not jump when it fills. */
function MailboxListSkeleton() {
	return (
		<ul
			aria-busy="true"
			aria-label="Loading mailboxes"
			className="divide-y divide-border overflow-hidden rounded-[8px] border border-border bg-card"
		>
			{Array.from({ length: 3 }, (_, i) => (
				<li key={i} className="flex items-center gap-3 px-4 py-3">
					<span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-bg-muted" />
					<span className="min-w-0 flex-1 space-y-2">
						<span className="block h-3 w-1/3 animate-pulse rounded bg-bg-muted" />
						<span className="block h-2.5 w-1/2 animate-pulse rounded bg-bg-muted/70" />
					</span>
				</li>
			))}
		</ul>
	);
}

export default function InboxesRoute() {
	const navigate = useNavigate();
	const { selectedZone, setZones } = useZoneStore();
	const { hiddenMailboxIds, toggle, showAll, prune } =
		useMailboxVisibilityStore();

	const {
		data: mailboxes = [],
		refetch,
		isFetched,
	} = useMailboxes(selectedZone?.domain);
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();

	const { data: config } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
	});

	/**
	 * Domains a mailbox can be created on: every zone `/config` reports (the
	 * Worker merges configured and admin-added domains there), plus any bare
	 * `domains` entry without a zone, de-duplicated in that order.
	 */
	const domains = useMemo(() => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const d of [
			...(config?.zones ?? []).map((z) => z.domain),
			...(config?.domains ?? []),
		]) {
			const host = d?.trim().toLowerCase();
			if (!host || seen.has(host)) continue;
			seen.add(host);
			out.push(host);
		}
		return out;
	}, [config?.zones, config?.domains]);
	const emailAddresses = useMemo(
		() => config?.emailAddresses ?? [],
		[config?.emailAddresses],
	);
	const zones = useMemo(() => config?.zones ?? [], [config?.zones]);

	useEffect(() => {
		if (zones.length > 0) setZones(zones);
	}, [zones, setZones]);

	const [prefix, setPrefix] = useState("");
	const [domain, setDomain] = useState("");
	const [name, setName] = useState("");
	const [creating, setCreating] = useState(false);
	// `/?new=jobs@example.com` (linked from analytics) opens the form prefilled.
	const [searchParams] = useSearchParams();
	const requested = searchParams.get("new")?.trim().toLowerCase() ?? "";
	const [showCreate, setShowCreate] = useState(() => requested !== "");
	useEffect(() => {
		const at = requested.lastIndexOf("@");
		if (at <= 0) return;
		setPrefix(requested.slice(0, at));
		setShowCreate(true);
	}, [requested]);

	useEffect(() => {
		// Follow the domain filter when it names a domain we can create on;
		// otherwise keep the current pick if it is still valid.
		const requestedDomain = requested.slice(requested.lastIndexOf("@") + 1);
		if (requested.includes("@") && domains.includes(requestedDomain)) {
			if (domain !== requestedDomain) setDomain(requestedDomain);
		} else if (selectedZone && domains.includes(selectedZone.domain.toLowerCase())) {
			setDomain(selectedZone.domain.toLowerCase());
		} else if (domains.length > 0 && !domains.includes(domain)) {
			setDomain(domains[0]);
		}
	}, [domains, domain, selectedZone, requested]);

	/**
	 * Mailboxes named in configuration are created on first sight, so a fresh
	 * deployment lands on a working inbox instead of an empty chooser.
	 */
	const autoCreated = useRef(false);
	useEffect(() => {
		if (autoCreated.current) return;
		if (emailAddresses.length === 0 || !isFetched) return;

		const existing = new Set(mailboxes.map((m) => m.email.toLowerCase()));
		const missing = emailAddresses.filter(
			(addr) => !existing.has(addr.toLowerCase()),
		);
		autoCreated.current = true;
		if (missing.length === 0) return;

		void Promise.all(
			missing.map((addr) =>
				api.createMailbox(addr, addr.split("@")[0] || addr).catch(() => {}),
			),
		).then(() => refetch());
	}, [emailAddresses, mailboxes, isFetched, refetch]);

	/**
	 * Forget hidden ids whose mailbox has since been deleted, so recreating that
	 * address does not bring back a mailbox nobody can see.
	 *
	 * Only when no zone is selected, because `mailboxes` is filtered by domain:
	 * pruning against a partial list would treat every mailbox on the other
	 * domains as deleted and silently discard the user's choices about them the
	 * moment they switched zones. Leaving a stale id behind is harmless by
	 * comparison — an id matching nothing filters nothing.
	 */
	useEffect(() => {
		if (isFetched && !selectedZone) prune(mailboxes);
	}, [isFetched, selectedZone, mailboxes, prune]);

	const shown = useMemo(
		() => visibleMailboxes(mailboxes, hiddenMailboxIds),
		[mailboxes, hiddenMailboxIds],
	);
	const hiddenCount = mailboxes.length - shown.length;

	// One mailbox is not a choice: go straight to it. Keyed on what is actually
	// on screen, so hiding all but one skips this page the way having only one
	// does.
	useEffect(() => {
		if (!isFetched || shown.length !== 1 || requested) return;
		navigate(`/mail/${encodeURIComponent(shown[0].id)}/inbox`, {
			replace: true,
		});
	}, [isFetched, shown, navigate, requested]);

	const submitCreate = async (e: FormEvent) => {
		e.preventDefault();
		if (!prefix.trim() || !domain) return;
		setCreating(true);
		try {
			const email = `${prefix.trim().toLowerCase()}@${domain}`;
			await createMailbox.mutateAsync({ email, name: name.trim() || prefix.trim() });
			setPrefix("");
			setName("");
			setShowCreate(false);
			navigate(`/mail/${encodeURIComponent(email)}/inbox`);
		} catch (err) {
			showToast({
				kind: "error",
				message: errorMessage(err, "Could not create that mailbox."),
			});
		} finally {
			setCreating(false);
		}
	};

	return (
		<DashboardLayout>
			{/*
			  Part of Mail, with Mail's pane: every inbox at the top, then each
			  mailbox with its unread count, like Outlook's account list at the head
			  of the folder pane. This page is where they are managed.
			*/}
			<div className="flex w-full">
				<MailAccountsPane active="manage" />
				<div className="min-w-0 flex-1">
			<PageContainer narrow>
				{/*
				  The shared page header, as on Templates, Analytics and Settings, so
				  the strip under the top bar has one shape. "People view" is gone: the
				  top bar has People on every page.
				*/}
				<PageHeader
					icon={Mail}
					title="Mailboxes"
					phoneActions={
						<>
							<button
								type="button"
								onClick={() => navigate("/mail/all/inbox")}
								aria-label="All inboxes"
								className="inline-flex h-11 w-11 items-center justify-center rounded-[6px] text-text-secondary hover:bg-bg-muted"
							>
								<Layers size={18} aria-hidden />
							</button>
							<button
								type="button"
								onClick={() => setShowCreate((v) => !v)}
								aria-expanded={showCreate}
								aria-label="New mailbox"
								className="inline-flex h-11 w-11 items-center justify-center rounded-[6px] text-accent hover:bg-bg-muted"
							>
								<Plus size={20} aria-hidden />
							</button>
						</>
					}
					description="Each mailbox is isolated, with its own storage, folders and agent."
					actions={
						<>
							<button
								type="button"
								onClick={() => navigate("/mail/all/inbox")}
								className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 text-xs font-medium text-text-secondary hover:bg-bg-muted touch:h-11"
							>
								<Layers size={13} aria-hidden />
								All inboxes
							</button>
							<button
								type="button"
								onClick={() => setShowCreate((v) => !v)}
								aria-expanded={showCreate}
								className="inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-accent px-2.5 text-xs font-semibold text-accent-foreground hover:bg-accent-hover touch:h-11"
							>
								<Plus size={13} aria-hidden />
								New mailbox
							</button>
						</>
					}
				/>

				<OnboardingBanner />

				{showCreate && (
					<form
						onSubmit={submitCreate}
						className="mb-4 space-y-2.5 rounded-[10px] border border-border bg-card p-4"
					>
						<div className="space-y-2.5">
							<div>
								<span
									id="new-mailbox-address-label"
									className="mb-1 block text-xs font-medium text-text-secondary"
								>
									Address
								</span>
								{/*
								  Local part, "@", domain on one line from `sm` up; on a phone
								  the domain drops under the local part so neither is squeezed.
								*/}
								<div
									role="group"
									aria-labelledby="new-mailbox-address-label"
									className="flex flex-col gap-2 sm:flex-row sm:items-center"
								>
									<div className="flex min-w-0 flex-1 items-center gap-2">
										<label htmlFor="new-mailbox-local" className="sr-only">
											Local part
										</label>
										<input
											id="new-mailbox-local"
											value={prefix}
											onChange={(e) => setPrefix(e.target.value.replace(/@.*$/, ""))}
											placeholder="hello"
											required
											autoCapitalize="none"
											autoComplete="off"
											spellCheck={false}
											className="min-h-11 w-full min-w-0 rounded-[6px] border border-border bg-card px-2.5 py-1.5 text-sm text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15 sm:min-h-9"
										/>
										<span className="shrink-0 text-sm text-text-tertiary" aria-hidden>
											@
										</span>
									</div>
									<label htmlFor="new-mailbox-domain" className="sr-only">
										Domain
									</label>
									<select
										id="new-mailbox-domain"
										value={domain}
										onChange={(e) => setDomain(e.target.value)}
										disabled={domains.length === 0}
										className="min-h-11 w-full min-w-0 rounded-[6px] border border-border bg-card px-2.5 py-1.5 text-sm text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15 sm:min-h-9 sm:w-auto sm:max-w-[50%]"
									>
										{domains.length === 0 ? (
											<option value="">No domains configured</option>
										) : null}
										{domains.map((d) => (
											<option key={d} value={d}>
												{d}
											</option>
										))}
									</select>
								</div>
								{domains.length === 0 ? (
									<p className="mt-1 text-xs text-text-tertiary">
										Add a domain in Settings → Domains first.
									</p>
								) : null}
							</div>
							<label className="block">
								<span className="mb-1 block text-xs font-medium text-text-secondary">
									Display name
								</span>
								<input
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="Support"
									className="min-h-11 w-full rounded-[6px] border border-border bg-card px-2.5 py-1.5 text-sm text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15 sm:min-h-9"
								/>
							</label>
						</div>
						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={() => setShowCreate(false)}
								className="min-h-11 rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary sm:min-h-8"
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={creating || !prefix.trim() || !domain}
								className="min-h-11 rounded-[6px] bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50 sm:min-h-8"
							>
								{creating ? "Creating…" : "Create mailbox"}
							</button>
						</div>
					</form>
				)}

				{/*
				  Loading is its own state. The list defaults to `[]` while the query
				  is in flight, so testing the length alone told everyone they had no
				  mailboxes for the first few hundred milliseconds of every visit.
				  `isFetched` rather than `isLoading` so an errored first fetch still
				  falls through to the empty state instead of a skeleton forever.
				*/}
				{!isFetched ? (
					<MailboxListSkeleton />
				) : mailboxes.length === 0 ? (
					<div className="flex flex-col items-center justify-center rounded-[8px] border border-border bg-card px-6 py-16 text-center">
						<Inbox size={34} className="mb-3 text-text-tertiary" strokeWidth={1.25} />
						<h2 className="mb-1 text-base font-semibold text-text-primary">
							No mailboxes yet
						</h2>
						<p className="max-w-[360px] text-sm text-text-secondary">
							Create a mailbox for any address on your domain to start receiving
							mail through Email Routing.
						</p>
					</div>
				) : (
					<>
						{/*
						  Which mailboxes the dashboard shows. The eye switch is a display
						  preference and nothing else: hiding one stops it appearing in
						  this list and in the switcher, and does not touch delivery,
						  forwarding or the mailbox itself. Mail keeps arriving.
						*/}
						<div className="mb-2 flex items-center justify-between gap-3">
							<p className="text-xs text-text-tertiary">
								{hiddenCount > 0
									? `Showing ${shown.length} of ${mailboxes.length} mailboxes.`
									: "Use the eye on a row to hide that mailbox from the dashboard."}
							</p>
							{hiddenCount > 0 && (
								<button
									type="button"
									onClick={showAll}
									className="shrink-0 rounded-[6px] border border-border bg-card px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-muted"
								>
									Show all
								</button>
							)}
						</div>
						<ul className="divide-y divide-border overflow-hidden rounded-[8px] border border-border bg-card">
							{mailboxes.map((box) => {
								const hidden = isMailboxHidden(hiddenMailboxIds, box.id);
								const canHide = canHideMailbox(hiddenMailboxIds, mailboxes, box.id);
								return (
									<li key={box.id}>
										<div
											className={`group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-bg-subtle ${
												hidden ? "opacity-55" : ""
											}`}
										>
											<span
												className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent-subtle-fg"
												aria-hidden
											>
												<Mail size={15} />
											</span>
											<button
												type="button"
												onClick={() =>
													navigate(`/mail/${encodeURIComponent(box.id)}/inbox`)
												}
												className="min-w-0 flex-1 text-left"
											>
												{(() => {
													// The address only once: as the title when there is no
													// display name, as the subtitle when there is.
													const display = (box.settings?.fromName || box.name || "").trim();
													const named =
														display !== "" &&
														display.toLowerCase() !== box.email.toLowerCase();
													return (
														<>
															<span className="block truncate text-sm font-semibold text-text-primary">
																{named ? display : box.email}
															</span>
															{named && (
																<span className="block truncate text-xs text-text-secondary">
																	{box.email}
																</span>
															)}
														</>
													);
												})()}
											</button>
											<MailboxUnreadBadge mailboxId={box.id} />
											{/*
											  Dashboard visibility as an eye switch, not a checkbox: a
											  checkbox in a list row reads as bulk-select.
											*/}
											<button
												type="button"
												role="switch"
												aria-checked={!hidden}
												disabled={!canHide}
												onClick={() => toggle(mailboxes, box.id)}
												aria-label={`Show ${box.email} on the dashboard`}
												title={
													!canHide
														? "At least one mailbox has to stay visible."
														: hidden
															? "Hidden from the dashboard. Click to show."
															: "Shown on the dashboard. Click to hide."
												}
												className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-40 touch:h-11 touch:w-11"
											>
												{hidden ? <EyeOff size={15} /> : <Eye size={15} />}
											</button>
											<button
												type="button"
												onClick={() => {
													if (
														!window.confirm(
															`Delete ${box.email}? Every message, draft and attachment in it is removed.`,
														)
													) {
														return;
													}
													deleteMailbox.mutate(box.id);
												}}
												aria-label={`Delete ${box.email}`}
												// Always shown on touch, where there is no hover to reveal it.
												className="inline-flex shrink-0 items-center justify-center rounded-[6px] p-1.5 text-text-tertiary opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100"
											>
												<Trash2 size={14} />
											</button>
										</div>
									</li>
								);
							})}
						</ul>
					</>
				)}
			</PageContainer>
				</div>
			</div>
		</DashboardLayout>
	);
}
