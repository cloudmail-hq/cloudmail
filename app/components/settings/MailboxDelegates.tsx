// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Who else can use this mailbox.
 *
 * **Settings → Access** is the instance-wide grant screen and administrator-only,
 * because a grant record lists every mailbox its holder can reach. That left the
 * most ordinary delegation there is impossible from the UI: the person whose
 * mailbox it is could not give their own assistant access to it without an
 * administrator doing it for them. Both products this vocabulary comes from let
 * the owner do it themselves, so this screen does too.
 *
 * Scoped by construction rather than by filtering. The endpoint behind it reads
 * and writes exactly one entry of one grant — this mailbox's — so the other
 * mailboxes in a delegate's grant are neither shown nor touched. They are not the
 * owner's to see.
 *
 * Renders nothing for a caller without `manageDelegates` here. The Worker refuses
 * them regardless, so this is courtesy; an error panel on a page they can
 * otherwise use would read as a fault rather than as "not your business".
 */

import { useState } from "react";
import { Check, Loader2, ShieldCheck, Trash2, UserPlus, X } from "lucide-react";
import {
	useDeleteMailboxDelegate,
	useMailboxDelegates,
	useSaveMailboxDelegate,
} from "~/queries/access";
import { useCurrentUser } from "~/queries/people";
import { errorMessage, showToast } from "~/lib/toast";
import {
	ApiError,
	type MailboxDelegate,
	type MailboxRole,
	type PrincipalKind,
} from "~/services/api";

const INPUT_CLASS =
	"h-9 w-full rounded-[6px] border border-border bg-card px-2.5 text-sm text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15 disabled:opacity-60";

const CHIP_ON = "bg-bg-muted text-text-primary ring-primary/50";
const CHIP_OFF = "bg-bg-subtle text-text-secondary ring-border";

export default function MailboxDelegates({ mailboxId }: { mailboxId: string }) {
	const { data, isLoading, error } = useMailboxDelegates(mailboxId);
	const { data: me } = useCurrentUser();
	const save = useSaveMailboxDelegate(mailboxId);
	const remove = useDeleteMailboxDelegate(mailboxId);

	const [kind, setKind] = useState<PrincipalKind>("user");
	const [id, setId] = useState("");
	const [label, setLabel] = useState("");
	const [role, setRole] = useState<MailboxRole | "">("");
	const [formError, setFormError] = useState<string | null>(null);

	// Not permitted to manage this: say nothing rather than showing a failure.
	if (error instanceof ApiError && error.status === 403) return null;

	const busy = save.isPending || remove.isPending;
	const roleOptions = data?.roles ?? [];
	// `agent` is the sensible default for handing a mailbox to somebody else: it can
	// answer mail without being able to rewrite where the mail goes.
	const effectiveRole: MailboxRole | "" =
		role || (roleOptions.some((r) => r.role === "agent") ? "agent" : "");

	function resetForm() {
		setId("");
		setLabel("");
		setRole("");
		setFormError(null);
	}

	async function onSave() {
		setFormError(null);
		const identifier = id.trim().toLowerCase();

		if (kind === "user" && !identifier.includes("@")) {
			setFormError("Enter the email address they sign in to Cloudflare Access with.");
			return;
		}
		if (kind === "service" && !identifier) {
			setFormError("Enter the service token Client ID from Cloudflare Access.");
			return;
		}
		if (!effectiveRole) {
			setFormError("Pick how far their access should reach.");
			return;
		}

		try {
			await save.mutateAsync({
				id: identifier,
				kind,
				role: effectiveRole,
				...(label.trim() ? { label: label.trim() } : {}),
			});
			showToast({ kind: "success", message: `${identifier} can now use this mailbox` });
			resetForm();
		} catch (e) {
			setFormError(errorMessage(e, "Couldn't save that."));
		}
	}

	async function onRemove(delegate: MailboxDelegate) {
		try {
			await remove.mutateAsync({ kind: delegate.kind, id: delegate.id });
			showToast({ kind: "success", message: `Removed ${delegate.id}` });
		} catch (e) {
			showToast({ kind: "error", message: errorMessage(e, "Couldn't remove that.") });
		}
	}

	/** Everyone except the owner reading this, who is always in the list. */
	const others = (data?.delegates ?? []).filter((d) => d.id !== me?.email);

	return (
		<section className="rounded-[10px] border border-border bg-card p-4">
			<div className="mb-3 flex items-start gap-2">
				<ShieldCheck size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
				<div>
					<h2 className="text-sm font-semibold text-text-primary">
						Who else can use this mailbox
					</h2>
					<p className="text-xs text-text-secondary">
						They sign in as themselves and reach this mailbox alongside their own.
						Replies they send are attributed to them unless you grant Manager.
					</p>
				</div>
			</div>

			{isLoading ? (
				<div className="flex items-center gap-2 text-sm text-text-secondary">
					<Loader2 size={13} className="animate-spin" aria-hidden />
					Loading…
				</div>
			) : null}

			{error && !(error instanceof ApiError && error.status === 403) ? (
				<p className="text-xs text-destructive">Couldn't load the list.</p>
			) : null}

			{data ? (
				<div className="space-y-4">
					{others.length === 0 ? (
						<p className="rounded-[6px] bg-bg-subtle px-3 py-2.5 text-sm text-text-secondary">
							Nobody else has been given access.
						</p>
					) : (
						<ul className="space-y-1.5">
							{others.map((delegate) => (
								<li
									key={`${delegate.kind}:${delegate.id}`}
									className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[6px] bg-bg-subtle px-3 py-2"
								>
									<span className="truncate font-mono text-xs text-text-primary">
										{delegate.id}
									</span>
									{delegate.label ? (
										<span className="shrink-0 text-xs text-text-secondary">
											{delegate.label}
										</span>
									) : null}
									<span className="shrink-0 rounded-[4px] bg-bg-muted px-1.5 py-0.5 text-xs font-medium text-text-secondary">
										{delegate.role}
									</span>
									{delegate.viaAdminRole ? (
										<span className="text-xs text-text-tertiary">
											administrator — managed in Settings → Access
										</span>
									) : null}

									{/* An administrator's reach comes from their role, not from an
									    entry here, so removing one would silently do nothing. */}
									{delegate.viaAdminRole ? null : (
										<button
											type="button"
											onClick={() => onRemove(delegate)}
											disabled={busy}
											aria-label={`Remove ${delegate.id}`}
											className="ml-auto shrink-0 rounded-[4px] p-1.5 text-text-tertiary hover:bg-bg-muted hover:text-destructive disabled:opacity-50"
										>
											<Trash2 size={13} />
										</button>
									)}
								</li>
							))}
						</ul>
					)}

					{/* Administrators reach every mailbox without an entry, so a short list
					    above would otherwise imply nobody else can get in. */}
					{data.configuredAdmins.length > 0 ? (
						<p className="text-xs text-text-tertiary">
							Administrators can also open this mailbox:{" "}
							{data.configuredAdmins.join(", ")}.
						</p>
					) : null}

					{!data.enforced ? (
						<p className="rounded-[6px] bg-warning-bg px-3 py-2 text-[11px] text-warning-text ring-1 ring-warning-border">
							Per-mailbox access is not being enforced on this deployment, so
							everyone who can sign in already reaches every mailbox. Set
							ADMIN_EMAILS to turn it on.
						</p>
					) : null}

					<div className="space-y-3 border-t border-border pt-3">
						<div className="flex flex-wrap gap-2">
							{(["user", "service"] as const).map((option) => (
								<label
									key={option}
									className={`flex cursor-pointer items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-xs ring-1 ${
										kind === option ? CHIP_ON : CHIP_OFF
									}`}
								>
									<input
										type="radio"
										name="delegate-kind"
										checked={kind === option}
										onChange={() => setKind(option)}
										disabled={busy}
										className="sr-only"
									/>
									{kind === option ? <Check size={12} aria-hidden /> : null}
									{option === "user" ? "A person" : "A service token"}
								</label>
							))}
						</div>

						<div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
							<input
								type={kind === "user" ? "email" : "text"}
								value={id}
								onChange={(e) => setId(e.target.value)}
								disabled={busy}
								placeholder={
									kind === "user"
										? "assistant@example.com"
										: "1a2b3c4d….access"
								}
								autoComplete="off"
								spellCheck={false}
								aria-label="Who to give access to"
								className={`${INPUT_CLASS} ${kind === "service" ? "font-mono text-xs" : ""}`}
							/>
							<select
								value={effectiveRole}
								onChange={(e) => setRole(e.target.value as MailboxRole)}
								disabled={busy || roleOptions.length === 0}
								aria-label="How far their access reaches"
								className="h-9 rounded-[6px] border border-border bg-card px-2 text-xs text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15 disabled:opacity-60"
							>
								{roleOptions.map((option) => (
									<option key={option.role} value={option.role}>
										{option.role}
									</option>
								))}
							</select>
						</div>

						{/* Client IDs are opaque hex, so without a note an owner cannot tell
						    which row to revoke later. */}
						{kind === "service" ? (
							<input
								type="text"
								value={label}
								onChange={(e) => setLabel(e.target.value)}
								disabled={busy}
								maxLength={80}
								placeholder="What is it — e.g. CI deploy bot"
								aria-label="Label"
								className={INPUT_CLASS}
							/>
						) : null}

						{effectiveRole ? (
							<p className="text-xs text-text-tertiary">
								{roleOptions
									.find((r) => r.role === effectiveRole)
									?.capabilities.join(", ")}
							</p>
						) : null}

						{formError ? (
							<p role="alert" className="text-xs text-destructive">
								{formError}
							</p>
						) : null}

						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={onSave}
								disabled={busy}
								className="inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-primary px-2.5 text-xs font-semibold text-primary-foreground hover:bg-accent-hover disabled:opacity-50"
							>
								{save.isPending ? (
									<Loader2 size={12} className="animate-spin" aria-hidden />
								) : (
									<UserPlus size={12} aria-hidden />
								)}
								Give access
							</button>
							{id || label ? (
								<button
									type="button"
									onClick={resetForm}
									disabled={busy}
									className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50"
								>
									<X size={12} aria-hidden />
									Clear
								</button>
							) : null}
						</div>
					</div>
				</div>
			) : null}
		</section>
	);
}
