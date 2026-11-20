// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Who may open which mailbox.
 *
 * Cloudflare Access decides who gets in; this decides what they reach once they
 * are in. Without a screen the model was only reachable by hand-writing R2
 * objects, which is not a feature anybody would use.
 *
 * In Access mode, machines appear here alongside people, because a machine is
 * just an Access service token and is granted the same way. In password mode
 * (built-in accounts) there are no service tokens: a script uses an API token
 * from Account & security, which acts as the user who created it, so the
 * service-token parts of this panel are hidden.
 *
 * The section explains its own state rather than just rendering controls, because
 * the important thing about this model is *whether it is switched on*: while
 * `ADMIN_EMAILS` is unset every authenticated caller is an administrator of every
 * mailbox, and a grant list shown without that context would imply a boundary that
 * is not being enforced. See `workers/lib/authz.ts`.
 */

import { useState } from "react";
import {
	AlertTriangle,
	Bot,
	Check,
	Loader2,
	Lock,
	Plus,
	ShieldCheck,
	Trash2,
	User as UserIcon,
	X,
} from "lucide-react";
import {
	useAccess,
	useDeleteAccessGrant,
	useSaveAccessGrant,
} from "~/queries/access";
import { useMailboxes } from "~/queries/mailboxes";
import { useCurrentUser } from "~/queries/people";
import { toast } from "~/lib/toast";
import {
	ApiError,
	type AccessGrant,
	type MailboxRole,
	type PrincipalKind,
} from "~/services/api";

function messageOf(error: unknown, fallback: string): string {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error && error.message) return error.message;
	return fallback;
}

/**
 * One line describing which mailboxes a grant reaches, and how far.
 *
 * The role is named only where it is narrower than full access, so a list of
 * ordinary grants stays readable and a narrowed one stands out — which is the
 * thing worth noticing when auditing who can send as a shared inbox.
 */
function summariseAccess(grant: AccessGrant, fullAccessRole: MailboxRole): string {
	const entries = grant.access?.length
		? grant.access
		: grant.mailboxes.map((id) => ({ id, role: fullAccessRole }));

	return entries
		.map((entry) =>
			entry.role === fullAccessRole ? entry.id : `${entry.id} (${entry.role})`,
		)
		.join(", ");
}

/**
 * What a narrowed role actually permits, worded from the Worker's own answer.
 *
 * The capability list is served rather than restated here, so a preset widened
 * server-side describes itself correctly without a client release.
 */
function describeRole(
	role: MailboxRole,
	options: { role: MailboxRole; capabilities: string[] }[],
): string {
	return options.find((option) => option.role === role)?.capabilities.join(", ") ?? "";
}

const INPUT_CLASS =
	"h-10 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/30 disabled:opacity-60";

const CHIP_ON =
	"bg-bg-muted text-text-primary ring-primary/50";
const CHIP_OFF = "bg-bg-subtle text-text-secondary ring-border";

export default function AccessSettings() {
	const { data, isLoading, isError, refetch } = useAccess();
	const { data: mailboxes } = useMailboxes();
	const { data: me } = useCurrentUser();
	const saveGrant = useSaveAccessGrant();
	// Built-in accounts have no service tokens: machines use per-user API tokens,
	// which act as the user who created them.
	const passwordMode = me?.authMode === "password";
	const deleteGrant = useDeleteAccessGrant();

	const [kind, setKind] = useState<PrincipalKind>("user");
	const [id, setId] = useState("");
	const [label, setLabel] = useState("");
	const [role, setRole] = useState<"admin" | "member">("member");
	/**
	 * Which mailboxes are granted, and how far each reaches.
	 *
	 * Keyed by address rather than held as a list so the selection and the role
	 * cannot disagree: a mailbox is granted exactly when it has a role here.
	 */
	const [selected, setSelected] = useState<Record<string, MailboxRole>>({});
	const [error, setError] = useState<string | null>(null);

	const addresses = (mailboxes ?? []).map((m) => m.email);
	const busy = saveGrant.isPending || deleteGrant.isPending;

	/**
	 * The role a newly-ticked mailbox starts at.
	 *
	 * Full access, matching what ticking a box has always meant, so offering roles
	 * does not quietly narrow what an operator was about to grant. Named by the
	 * Worker rather than assumed here.
	 */
	const defaultRole: MailboxRole = data?.fullAccessRole ?? "owner";
	const roleOptions = data?.roles ?? [];

	function toggleMailbox(address: string) {
		setSelected((current) => {
			if (address in current) {
				const next = { ...current };
				delete next[address];
				return next;
			}
			return { ...current, [address]: defaultRole };
		});
	}

	function setMailboxRole(address: string, next: MailboxRole) {
		setSelected((current) => ({ ...current, [address]: next }));
	}

	function editExisting(grant: AccessGrant) {
		setKind(grant.kind);
		setId(grant.id);
		setLabel(grant.label ?? "");
		setRole(grant.role);
		// `access` carries the role per mailbox; a record written before roles
		// existed reports every entry at full access.
		setSelected(
			Object.fromEntries((grant.access ?? []).map((entry) => [entry.id, entry.role])),
		);
		setError(null);
	}

	function resetForm() {
		setId("");
		setLabel("");
		setRole("member");
		setSelected({});
		setError(null);
	}

	async function onSave() {
		setError(null);
		const identifier = id.trim().toLowerCase();

		if (kind === "user" && !identifier.includes("@")) {
			setError(
				passwordMode
					? "Enter the email address of their account."
					: "Enter the email address they sign in to Cloudflare Access with.",
			);
			return;
		}
		if (kind === "service" && !identifier) {
			setError("Enter the service token Client ID from Cloudflare Access.");
			return;
		}
		// A member with no mailboxes can authenticate and reach nothing, which is
		// more likely a half-finished form than an intention.
		const granted = Object.entries(selected);
		if (role === "member" && granted.length === 0) {
			setError("Pick at least one mailbox, or grant the administrator role.");
			return;
		}

		try {
			await saveGrant.mutateAsync({
				id: identifier,
				kind,
				role,
				// A full-access entry goes as a bare address — the shape every grant
				// used before roles existed — so an unchanged grant round-trips
				// unaltered instead of being rewritten into a more verbose equivalent.
				mailboxes:
					role === "admin"
						? []
						: granted.map(([address, mailboxRole]) =>
								mailboxRole === defaultRole
									? address
									: { id: address, role: mailboxRole },
							),
				...(label.trim() ? { label: label.trim() } : {}),
			});
			toast.success(`Saved access for ${identifier}`);
			resetForm();
		} catch (e) {
			setError(messageOf(e, "Couldn't save that grant."));
		}
	}

	async function onDelete(grant: AccessGrant) {
		try {
			await deleteGrant.mutateAsync({ kind: grant.kind, id: grant.id });
			toast.success(`Removed access for ${grant.id}`);
		} catch (e) {
			toast.error(messageOf(e, "Couldn't remove that grant."));
		}
	}

	function renderGrants(grants: AccessGrant[], emptyNote: string) {
		if (grants.length === 0) {
			return (
				<p className="rounded-[6px] bg-bg-subtle px-3 py-2.5 text-sm text-text-secondary">
					{emptyNote}
				</p>
			);
		}

		return (
			<ul className="space-y-1.5">
				{grants.map((grant) => (
					<li
						key={`${grant.kind}:${grant.id}`}
						className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[6px] bg-bg-subtle px-3 py-2"
					>
						<span className="truncate font-mono text-xs text-text-primary">
							{grant.id}
						</span>
						{grant.label ? (
							<span className="shrink-0 text-xs text-text-secondary">
								{grant.label}
							</span>
						) : null}
						{grant.kind === me?.kind && grant.id === me?.email ? (
							<span className="shrink-0 text-xs font-medium text-text-secondary">
								you
							</span>
						) : null}
						<span
							className={
								grant.role === "admin"
									? "shrink-0 rounded-[4px] bg-destructive-subtle px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-destructive"
									: "shrink-0 rounded-[4px] bg-bg-muted px-1.5 py-0.5 text-xs font-medium text-text-secondary"
							}
						>
							{grant.role}
						</span>
						<span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
							{grant.role === "admin"
								? "Every mailbox"
								: summariseAccess(grant, defaultRole) || "No mailboxes"}
						</span>
						<div className="ml-auto flex shrink-0 items-center gap-1">
							<button
								type="button"
								onClick={() => editExisting(grant)}
								disabled={busy}
								className="rounded-[4px] px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
							>
								Edit
							</button>
							<button
								type="button"
								onClick={() => onDelete(grant)}
								disabled={busy}
								aria-label={`Remove access for ${grant.id}`}
								className="rounded-[4px] p-1.5 text-text-tertiary hover:bg-bg-muted hover:text-destructive disabled:opacity-50"
							>
								<Trash2 size={13} />
							</button>
						</div>
					</li>
				))}
			</ul>
		);
	}

	return (
		<section className="space-y-3">
			<div className="flex items-center gap-2">
				<ShieldCheck size={14} className="text-text-tertiary" />
				<h2 className="text-base font-semibold text-text-primary">Access</h2>
			</div>

			<div className="space-y-5 rounded-[8px] bg-card p-5 ring-1 ring-border">
				<p className="text-sm text-text-secondary">
					{passwordMode
						? "People sign in with their email and password. This decides which mailboxes they reach once they have. Invite new people from Users & invites above."
						: "Cloudflare Access decides who can sign in. This decides which mailboxes they reach once they have."}
				</p>

				{/* The state of enforcement is the headline, not a footnote: a grant list
				    shown while enforcement is off would imply a boundary that is not
				    being applied. */}
				{data && !data.enforced ? (
					<div className="flex items-start gap-2.5 rounded-[6px] bg-warning-bg px-3 py-2.5 ring-1 ring-warning-border">
						<AlertTriangle
							size={14}
							className="mt-0.5 shrink-0 text-warning-text"
							aria-hidden
						/>
						<div className="space-y-1">
							<p className="text-xs font-medium text-text-primary">
								Not enforced yet
							</p>
							<p className="text-xs text-text-secondary">
								Everyone who passes your Cloudflare Access policy is currently an
								administrator of every mailbox. Set the{" "}
								<code className="rounded-[3px] bg-bg-subtle px-1 py-0.5 font-mono text-[10px]">
									ADMIN_EMAILS
								</code>{" "}
								Worker variable to a comma-separated list of addresses to switch
								this on. Those addresses stay administrators no matter what is
								saved here, so you cannot lock yourself out.
							</p>
						</div>
					</div>
				) : null}

				{isError ? (
					<div className="flex items-center justify-between gap-3 rounded-[6px] bg-bg-subtle px-3 py-2">
						<p className="text-xs text-text-secondary">
							Couldn't load the access list.
						</p>
						<button
							type="button"
							onClick={() => refetch()}
							className="text-xs font-medium text-text-primary hover:underline"
						>
							Retry
						</button>
					</div>
				) : null}

				{/* ----------------------- Configured administrators ------------------ */}
				{data?.configuredAdmins.length ? (
					<div className="space-y-2">
						<h3 className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
							Administrators from configuration
						</h3>
						<ul className="space-y-1.5">
							{data.configuredAdmins.map((address) => (
								<li
									key={address}
									className="flex items-center gap-2 rounded-[6px] bg-bg-subtle px-3 py-2"
								>
									<Lock size={12} className="shrink-0 text-text-tertiary" aria-hidden />
									<span className="truncate text-sm text-text-primary">{address}</span>
									<span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wider text-text-tertiary">
										ADMIN_EMAILS
									</span>
								</li>
							))}
						</ul>
						<p className="text-xs text-text-tertiary">
							Set in the Worker configuration, so they can't be changed or revoked
							here. That is deliberate: it is what guarantees a way back in.
						</p>
					</div>
				) : null}

				{isLoading ? (
					<div className="flex items-center gap-2 px-3 py-2 text-xs text-text-secondary">
						<Loader2 size={12} className="animate-spin" aria-hidden />
						Loading
					</div>
				) : (
					<>
						{/* -------------------------------- People ------------------------ */}
						<div className="space-y-2">
							<h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-text-tertiary">
								<UserIcon size={11} aria-hidden />
								People
							</h3>
							{renderGrants(
								data?.users ?? [],
								"Nobody has been granted a mailbox yet. Anyone who signs in and is not listed above reaches nothing until you add them.",
							)}
						</div>

						{/* ------------------------------ Machines ----------------------- */}
						{passwordMode ? null : (
						<div className="space-y-2">
							<h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-text-tertiary">
								<Bot size={11} aria-hidden />
								Service tokens
							</h3>
							{renderGrants(
								data?.services ?? [],
								"No service tokens have been granted a mailbox. Create one in Cloudflare Zero Trust, add its Client ID to your Access policy, then grant it here.",
							)}
						</div>
						)}
					</>
				)}

				{/* -------------------------------- Editor ---------------------------- */}
				<div className="space-y-3 border-t border-border pt-4">
					<h3 className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
						Add or update
					</h3>

					{passwordMode ? null : (
					<fieldset className="space-y-2">
						<legend className="text-xs text-text-secondary">
							Who is this for
						</legend>
						<div className="flex flex-wrap gap-2">
							{(
								[
									["user", "A person", "signs in through your identity provider"],
									["service", "A service token", "for scripts, CI and AI clients"],
								] as const
							).map(([option, title, hint]) => (
								<label
									key={option}
									className={`flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-2 text-xs ring-1 ${
										kind === option ? CHIP_ON : CHIP_OFF
									}`}
								>
									<input
										type="radio"
										name="access-kind"
										value={option}
										checked={kind === option}
										onChange={() => {
											setKind(option);
											setError(null);
										}}
										disabled={busy}
										className="sr-only"
									/>
									{kind === option ? <Check size={12} aria-hidden /> : null}
									<span className="font-medium">{title}</span>
									<span className="font-light text-text-tertiary">{hint}</span>
								</label>
							))}
						</div>
					</fieldset>
					)}

					<div className="space-y-2">
						<label
							htmlFor="access-id"
							className="block text-xs text-text-secondary"
						>
							{kind === "user"
								? passwordMode
									? "The email address of their account"
									: "The address they sign in to Cloudflare Access with"
								: "The service token Client ID, from Zero Trust → Access → Service auth"}
						</label>
						<input
							id="access-id"
							type={kind === "user" ? "email" : "text"}
							value={id}
							onChange={(e) => setId(e.target.value)}
							disabled={busy}
							placeholder={
								kind === "user"
									? "teammate@example.com"
									: "1a2b3c4d5e6f7890abcdef1234567890.access"
							}
							autoComplete="off"
							spellCheck={false}
							className={`${INPUT_CLASS} max-w-md ${kind === "service" ? "font-mono text-xs" : ""}`}
						/>
					</div>

					{/* Client IDs are opaque hex, so without a note an operator cannot tell
					    which row to revoke six months later. */}
					{kind === "service" ? (
						<div className="space-y-2">
							<label
								htmlFor="access-label"
								className="block text-xs text-text-secondary"
							>
								Label, so you can recognise it later
							</label>
							<input
								id="access-label"
								type="text"
								value={label}
								onChange={(e) => setLabel(e.target.value)}
								disabled={busy}
								maxLength={80}
								placeholder="CI deploy bot"
								className={`${INPUT_CLASS} max-w-sm`}
							/>
						</div>
					) : null}

					<fieldset className="space-y-2">
						<legend className="text-xs text-text-secondary">Role</legend>
						<div className="flex flex-wrap gap-2">
							{(["member", "admin"] as const).map((option) => (
								<label
									key={option}
									className={`flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-2 text-xs ring-1 ${
										role === option ? CHIP_ON : CHIP_OFF
									}`}
								>
									<input
										type="radio"
										name="access-role"
										value={option}
										checked={role === option}
										onChange={() => setRole(option)}
										disabled={busy}
										className="sr-only"
									/>
									{role === option ? <Check size={12} aria-hidden /> : null}
									<span className="font-medium capitalize">{option}</span>
									<span className="font-light text-text-tertiary">
										{option === "admin"
											? "every mailbox, and can manage access"
											: "only the mailboxes you pick"}
									</span>
								</label>
							))}
						</div>
					</fieldset>

					{role === "member" ? (
						<fieldset className="space-y-2">
							<legend className="text-xs text-text-secondary">
								Mailboxes, and how far each reaches
							</legend>
							{addresses.length === 0 ? (
								<p className="text-sm text-text-tertiary">
									No mailboxes exist yet. Create one first.
								</p>
							) : (
								<div className="space-y-1.5">
									{addresses.map((address) => {
										const granted = selected[address];
										const on = granted !== undefined;
										return (
											<div key={address} className="flex flex-wrap items-center gap-2">
												<label
													className={`flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-2 text-xs ring-1 ${
														on ? CHIP_ON : CHIP_OFF
													}`}
												>
													<input
														type="checkbox"
														checked={on}
														onChange={() => toggleMailbox(address)}
														disabled={busy}
														className="sr-only"
													/>
													{on ? (
														<Check size={12} aria-hidden />
													) : (
														<Plus size={12} aria-hidden />
													)}
													{address}
												</label>

												{/* Only meaningful once the mailbox is granted, and the options
												    come from the Worker so the screen cannot offer a role that
												    would be rejected on save. */}
												{on ? (
													<select
														value={granted}
														onChange={(e) =>
															setMailboxRole(address, e.target.value as MailboxRole)
														}
														disabled={busy || roleOptions.length === 0}
														aria-label={`Role for ${address}`}
														className="h-8 rounded-[6px] border border-border bg-card px-2 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/30 disabled:opacity-60"
													>
														{roleOptions.map((option) => (
															<option key={option.role} value={option.role}>
																{option.role}
															</option>
														))}
													</select>
												) : null}

												{on && granted !== defaultRole ? (
													<span className="text-xs text-text-tertiary">
														{describeRole(granted, roleOptions)}
													</span>
												) : null}
											</div>
										);
									})}
								</div>
							)}
						</fieldset>
					) : null}

					{error ? (
						<p role="alert" className="text-xs text-destructive">
							{error}
						</p>
					) : null}

					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={onSave}
							disabled={busy}
							className="inline-flex h-9 items-center gap-1.5 rounded-[6px] bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-accent-hover disabled:opacity-50"
						>
							{saveGrant.isPending ? (
								<Loader2 size={13} className="animate-spin" aria-hidden />
							) : null}
							Save access
						</button>
						{id || Object.keys(selected).length > 0 || label ? (
							<button
								type="button"
								onClick={resetForm}
								disabled={busy}
								className="inline-flex h-9 items-center gap-1.5 rounded-[6px] px-3 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50"
							>
								<X size={13} aria-hidden />
								Clear
							</button>
						) : null}
					</div>
				</div>
			</div>
		</section>
	);
}
