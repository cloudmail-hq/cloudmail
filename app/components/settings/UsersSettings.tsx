/**
 * Users & invites: the accounts on a password-mode deployment.
 *
 * Administrator-only. There is no outgoing email here, so invites and password
 * resets are links the administrator copies and sends themselves. Each link is
 * shown once: only its hash is stored.
 *
 * What a user can reach is still the grant in the Access panel below; an invite
 * writes that grant when it is accepted.
 */

import {
	Check,
	Link2,
	Loader2,
	MailPlus,
	MoreHorizontal,
	Plus,
	ShieldOff,
	Trash2,
	Users,
} from "lucide-react";
import { useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { formatRelativeTime, looksLikeEmail } from "~/lib/auth-helpers";
import { toast } from "~/lib/toast";
import {
	useAdminInvites,
	useAdminUsers,
	useCreateInvite,
	useCreateResetLink,
	useDeleteUser,
	useReauth,
	useResetTwoFactor,
	useRevokeInvite,
	useSecurityPolicy,
	useSetSecurityPolicy,
	useSetUserDisabled,
} from "~/queries/auth";
import { useMailboxes } from "~/queries/mailboxes";
import { useCurrentUser } from "~/queries/people";
import type { AdminUser, InviteInfo, InviteMailboxRole, InviteRole } from "~/services/auth-api";
import { authErrorCode, authErrorMessage } from "~/services/auth-api";
import { describePasskeyError, isPasskeyCancel } from "~/lib/passkeys";
import { ReauthPrompt } from "./cloudflare-connection-flow";
import {
	ConfirmDialog,
	InlineError,
	Pill,
	PRIMARY_BUTTON_CLASS,
	SecretBox,
	SECONDARY_BUTTON_CLASS,
	SectionHeading,
	SETTINGS_INPUT_CLASS,
	SettingsField,
} from "./settings-ui";

const CHIP_ON = "bg-bg-muted text-text-primary ring-primary/50";
const CHIP_OFF = "bg-bg-subtle text-text-secondary ring-border";

const INVITE_EXPIRY = [1, 3, 7, 14, 30];

/** "Require two-factor for everyone": one switch, enforced on browser sign-in. */
function SecurityPolicyToggle({ canTurnOn }: { canTurnOn: boolean }) {
	const policy = useSecurityPolicy();
	const save = useSetSecurityPolicy();
	const on = policy.data?.requireMfa === true;
	const blocked = !on && !canTurnOn;
	return (
		<div className="flex items-start gap-3 rounded-[6px] bg-bg-subtle/60 p-3 ring-1 ring-border">
			<input
				id="require-mfa"
				type="checkbox"
				checked={on}
				disabled={policy.isLoading || save.isPending || blocked}
				onChange={async (e) => {
					try {
						await save.mutateAsync({ requireMfa: e.target.checked });
						toast.success(e.target.checked ? "Two-factor is now required for everyone" : "Two-factor is now optional");
					} catch (err) {
						toast.error(authErrorMessage(err, "Couldn't change the sign-in policy."));
					}
				}}
				className="mt-0.5 size-4 accent-[var(--color-accent)]"
			/>
			<label htmlFor="require-mfa" className="min-w-0 text-sm">
				<span className="font-medium text-text-primary">Require two-factor sign-in for everyone</span>
				<span className="block text-xs text-text-secondary">
					{blocked
						? "Set up a passkey or authenticator app on your own account first (Account & security)."
						: "People without a passkey or authenticator app are asked to add one the next time they open the app, and can't read mail until they do. API tokens keep working."}
				</span>
			</label>
		</div>
	);
}

const INVITE_MAILBOX_ROLES: InviteMailboxRole[] = ["owner", "manager", "agent", "viewer"];

export const INVITE_ROLE_LABELS: Record<InviteMailboxRole, string> = {
	owner: "Owner",
	manager: "Manager",
	agent: "Can reply",
	viewer: "Read only",
};

/**
 * The role a mailbox starts at in the invite form: the invitee owns a mailbox
 * at their own address, and answers from any other (support@, sales@) unless
 * the admin picks otherwise. Owning a shared mailbox would let them remove
 * the others.
 */
export function defaultInviteRole(mailbox: string, inviteeEmail: string): InviteMailboxRole {
	return mailbox.trim().toLowerCase() === inviteeEmail.trim().toLowerCase() ? "owner" : "agent";
}

export default function UsersSettings() {
	const { data: me } = useCurrentUser();
	const users = useAdminUsers();
	const invites = useAdminInvites();
	const [shownLink, setShownLink] = useState<{ label: string; url: string; note: string } | null>(null);

	return (
		<section className="space-y-3">
			<SectionHeading icon={Users} title="Users & invites" />

			<div className="space-y-5 rounded-[8px] bg-card p-5 ring-1 ring-border">
				<p className="text-sm text-text-secondary">
					Everyone with an account here signs in with their email and password. Invite people with
					a link; choose which mailboxes they reach below, in Access.
				</p>

				{shownLink ? (
					<SecretBox label={shownLink.label} value={shownLink.url} what="Link copied" note={shownLink.note}>
						<div className="flex justify-end">
							<button type="button" onClick={() => setShownLink(null)} className={`${PRIMARY_BUTTON_CLASS} h-8`}>
								<Check size={13} aria-hidden />
								Done
							</button>
						</div>
					</SecretBox>
				) : null}

				<SecurityPolicyToggle canTurnOn={Boolean(me?.totpEnabled || me?.hasPasskey)} />

				<UserList
					users={users.data ?? []}
					loading={users.isLoading}
					error={users.isError}
					retry={() => users.refetch()}
					selfId={me?.userId ?? null}
					callerIsOwner={me?.isOwner === true}
					onLink={setShownLink}
				/>

				<InviteSection
					invites={invites.data ?? []}
					loading={invites.isLoading}
					onLink={setShownLink}
				/>
			</div>
		</section>
	);
}

/* ---------------------------------- Users --------------------------------- */

function UserList({
	users,
	loading,
	error,
	retry,
	selfId,
	callerIsOwner,
	onLink,
}: {
	users: AdminUser[];
	loading: boolean;
	error: boolean;
	retry: () => void;
	selfId: string | null;
	/** Only the owner can reset the owner's or another admin's two-factor. */
	callerIsOwner: boolean;
	onLink: (link: { label: string; url: string; note: string }) => void;
}) {
	const resetLink = useCreateResetLink();
	const setDisabled = useSetUserDisabled();
	const deleteUser = useDeleteUser();
	const resetTwoFactor = useResetTwoFactor();
	const reauth = useReauth();
	const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null);
	const [confirmReset2fa, setConfirmReset2fa] = useState<AdminUser | null>(null);
	/** Set while the admin must re-confirm before the reset can go through. */
	const [reauthFor, setReauthFor] = useState<AdminUser | null>(null);
	const [reauthError, setReauthError] = useState<string | null>(null);

	async function doReset2fa(user: AdminUser) {
		try {
			await resetTwoFactor.mutateAsync(user.id);
			toast.success(`Reset two-factor for ${user.email}`, {
				description: "Their passkeys, authenticator app and recovery codes were removed, and they were signed out.",
			});
			setConfirmReset2fa(null);
			setReauthFor(null);
		} catch (err) {
			if (authErrorCode(err) === "reauth_required") {
				setConfirmReset2fa(null);
				setReauthError(null);
				setReauthFor(user);
				return;
			}
			toast.error(authErrorMessage(err, "Couldn't reset two-factor."));
		}
	}

	async function onReset(user: AdminUser) {
		try {
			const { url, expiresAt } = await resetLink.mutateAsync(user.id);
			onLink({
				label: `Password reset link for ${user.email}`,
				url,
				note: `Send it to them directly. It works once and expires ${formatRelativeTime(expiresAt)}. Using it signs them out everywhere.`,
			});
		} catch (err) {
			toast.error(authErrorMessage(err, "Couldn't create a reset link."));
		}
	}

	async function onToggleDisabled(user: AdminUser) {
		try {
			await setDisabled.mutateAsync({ userId: user.id, disabled: !user.disabled });
			toast.success(user.disabled ? `Enabled ${user.email}` : `Disabled ${user.email}`, {
				description: user.disabled ? undefined : "Their sessions and API tokens were revoked.",
			});
		} catch (err) {
			toast.error(authErrorMessage(err, "Couldn't change that account."));
		}
	}

	async function onDelete() {
		if (!confirmDelete) return;
		try {
			await deleteUser.mutateAsync(confirmDelete.id);
			toast.success(`Deleted ${confirmDelete.email}`);
			setConfirmDelete(null);
		} catch (err) {
			toast.error(authErrorMessage(err, "Couldn't delete that account."));
		}
	}

	return (
		<div className="space-y-2">
			<h3 className="text-xs font-medium uppercase tracking-wider text-text-tertiary">Users</h3>
			{reauthFor ? (
				<>
					<ReauthPrompt
						message={`Resetting two-factor for ${reauthFor.email} needs your password or a passkey.`}
						busy={reauth.isPending || resetTwoFactor.isPending}
						pending={reauth.isPending}
						onConfirm={async (input) => {
							setReauthError(null);
							try {
								await reauth.mutateAsync(input);
								await doReset2fa(reauthFor);
							} catch (err) {
								if (isPasskeyCancel(err)) return;
								setReauthError(
									authErrorCode(err)
										? authErrorMessage(err, "Couldn't confirm it's you.")
										: describePasskeyError(err, "Couldn't confirm it's you."),
								);
							}
						}}
						onCancel={() => setReauthFor(null)}
						onError={setReauthError}
					/>
					<InlineError message={reauthError} />
				</>
			) : null}
			{loading ? (
				<p className="flex items-center gap-2 px-3 py-2 text-xs text-text-secondary">
					<Loader2 size={12} className="animate-spin" aria-hidden /> Loading
				</p>
			) : error ? (
				<p className="text-xs text-text-secondary">
					Couldn't load users.{" "}
					<button type="button" onClick={retry} className="font-medium text-text-primary hover:underline">
						Retry
					</button>
				</p>
			) : (
				<ul className="space-y-1.5">
					{users.map((user) => {
						const self = user.id === selfId;
						const protectedAccount = user.isOwner || self;
						return (
							<li
								key={user.id}
								className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[6px] bg-bg-subtle px-3 py-2 ${user.disabled ? "opacity-70" : ""}`}
							>
								<div className="min-w-0">
									<p className="truncate text-xs font-medium text-text-primary">
										{user.name || user.email}
									</p>
									{user.name ? (
										<p className="truncate text-xs text-text-secondary">{user.email}</p>
									) : null}
								</div>
								<div className="flex flex-wrap items-center gap-1">
									{self ? <Pill>You</Pill> : null}
									{user.isOwner ? <Pill tone="violet">Owner</Pill> : null}
									{user.isAdmin ? <Pill tone="admin">Admin</Pill> : <Pill>Member</Pill>}
									{user.totpEnabled || user.hasPasskey ? <Pill tone="success">2FA</Pill> : null}
									{user.disabled ? <Pill tone="warning">Disabled</Pill> : null}
								</div>
								<span className="min-w-0 flex-1 truncate text-right text-xs text-text-tertiary">
									{user.lastLoginAt ? `last sign-in ${formatRelativeTime(user.lastLoginAt)}` : "never signed in"}
								</span>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<button
											type="button"
											aria-label={`Actions for ${user.email}`}
											className="rounded-[4px] p-1.5 text-text-tertiary hover:bg-bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50"
										>
											<MoreHorizontal size={14} aria-hidden />
										</button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-48">
										<DropdownMenuItem onClick={() => onReset(user)} className="cursor-pointer" disabled={user.disabled}>
											<Link2 className="h-4 w-4" aria-hidden />
											Password reset link
										</DropdownMenuItem>
										{!self && (user.totpEnabled || user.hasPasskey) && (callerIsOwner || (!user.isOwner && !user.isAdmin)) ? (
											<DropdownMenuItem onClick={() => setConfirmReset2fa(user)} className="cursor-pointer">
												<ShieldOff className="h-4 w-4" aria-hidden />
												Reset two-factor
											</DropdownMenuItem>
										) : null}
										{!protectedAccount ? (
											<>
												<DropdownMenuItem onClick={() => onToggleDisabled(user)} className="cursor-pointer">
													{user.disabled ? "Enable account" : "Disable account"}
												</DropdownMenuItem>
												<DropdownMenuSeparator />
												<DropdownMenuItem
													onClick={() => setConfirmDelete(user)}
													className="cursor-pointer text-destructive focus:bg-destructive-subtle focus:text-destructive"
												>
													<Trash2 className="h-4 w-4" aria-hidden />
													Delete account
												</DropdownMenuItem>
											</>
										) : null}
									</DropdownMenuContent>
								</DropdownMenu>
							</li>
						);
					})}
				</ul>
			)}

			<ConfirmDialog
				open={confirmReset2fa !== null}
				onOpenChange={(open) => !open && setConfirmReset2fa(null)}
				title={`Reset two-factor for ${confirmReset2fa?.email ?? "this account"}?`}
				description="Their passkeys, authenticator app and recovery codes are removed and they're signed out everywhere. They sign in with their password and set two-factor up again. Only do this after checking who's asking."
				confirmLabel="Reset two-factor"
				onConfirm={() => (confirmReset2fa ? doReset2fa(confirmReset2fa) : undefined)}
				pending={resetTwoFactor.isPending}
			/>

			<ConfirmDialog
				open={confirmDelete !== null}
				onOpenChange={(open) => !open && setConfirmDelete(null)}
				title={`Delete ${confirmDelete?.email ?? "this account"}?`}
				description="Their account, sessions, API tokens and mailbox access are removed. Mail in shared mailboxes stays. This can't be undone."
				confirmLabel="Delete account"
				onConfirm={onDelete}
				pending={deleteUser.isPending}
			/>
		</div>
	);
}

/* --------------------------------- Invites -------------------------------- */

function InviteSection({
	invites,
	loading,
	onLink,
}: {
	invites: InviteInfo[];
	loading: boolean;
	onLink: (link: { label: string; url: string; note: string }) => void;
}) {
	const { data: mailboxes } = useMailboxes();
	const create = useCreateInvite();
	const revoke = useRevokeInvite();

	const [open, setOpen] = useState(false);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<InviteRole>("member");
	const [selected, setSelected] = useState<string[]>([]);
	const [mailboxRoles, setMailboxRoles] = useState<Record<string, InviteMailboxRole>>({});
	const [days, setDays] = useState(7);
	const [error, setError] = useState<string | null>(null);

	const addresses = (mailboxes ?? []).map((m) => m.email);

	function close() {
		setOpen(false);
		setEmail("");
		setRole("member");
		setSelected([]);
		setMailboxRoles({});
		setDays(7);
		setError(null);
	}

	/** Their own address they own; a shared one they answer from unless the admin says otherwise. */
	const roleFor = (address: string): InviteMailboxRole =>
		mailboxRoles[address] ?? defaultInviteRole(address, email);

	async function onCreate(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!looksLikeEmail(email)) return setError("Enter the email address of the person you're inviting.");
		if (role === "member" && selected.length === 0)
			return setError("Pick at least one mailbox, or invite them as an administrator.");
		try {
			const { invite, url } = await create.mutateAsync({
				email: email.trim().toLowerCase(),
				role,
				...(role === "member"
					? { mailboxes: selected, mailboxRoles: Object.fromEntries(selected.map((a) => [a, roleFor(a)])) }
					: {}),
				expiresInDays: days,
			});
			onLink({
				label: `Invite link for ${invite.email}`,
				url,
				note: `Send it to them directly. It works once and expires ${formatRelativeTime(invite.expiresAt)}.`,
			});
			close();
		} catch (err) {
			setError(authErrorMessage(err, "Couldn't create the invite."));
		}
	}

	async function onRevoke(invite: InviteInfo) {
		try {
			await revoke.mutateAsync(invite.id);
			toast.success(`Revoked the invite for ${invite.email}`);
		} catch (err) {
			toast.error(authErrorMessage(err, "Couldn't revoke that invite."));
		}
	}

	return (
		<div className="space-y-2 border-t border-border pt-4">
			<div className="flex items-center justify-between gap-2">
				<h3 className="text-xs font-medium uppercase tracking-wider text-text-tertiary">Pending invites</h3>
				{!open ? (
					<button type="button" onClick={() => setOpen(true)} className={`${SECONDARY_BUTTON_CLASS} h-8`}>
						<MailPlus size={13} aria-hidden />
						Invite someone
					</button>
				) : null}
			</div>

			{open ? (
				<form onSubmit={onCreate} className="space-y-3 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
					<div className="flex flex-wrap items-end gap-3">
						<SettingsField
							label="Email"
							type="email"
							autoComplete="off"
							placeholder="teammate@example.com"
							// biome-ignore lint/a11y/noAutofocus: opened by an explicit click.
							autoFocus
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							disabled={create.isPending}
							className="w-full max-w-xs"
						/>
						<div className="space-y-1.5">
							<label htmlFor="invite-expiry" className="block text-[11px] font-medium text-text-secondary">
								Link expires after
							</label>
							<select
								id="invite-expiry"
								value={days}
								onChange={(e) => setDays(Number(e.target.value))}
								disabled={create.isPending}
								className={`${SETTINGS_INPUT_CLASS} w-32`}
							>
								{INVITE_EXPIRY.map((d) => (
									<option key={d} value={d}>
										{d === 1 ? "1 day" : `${d} days`}
									</option>
								))}
							</select>
						</div>
					</div>

					<fieldset className="space-y-2">
						<legend className="text-[11px] font-medium text-text-secondary">Role</legend>
						<div className="flex flex-wrap gap-2">
							{(["member", "admin"] as const).map((option) => (
								<label
									key={option}
									className={`flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-2 text-xs ring-1 focus-within:ring-2 focus-within:ring-violet/50 ${role === option ? CHIP_ON : CHIP_OFF}`}
								>
									<input
										type="radio"
										name="invite-role"
										value={option}
										checked={role === option}
										onChange={() => setRole(option)}
										disabled={create.isPending}
										className="sr-only"
									/>
									{role === option ? <Check size={12} aria-hidden /> : null}
									<span className="font-medium capitalize">{option}</span>
									<span className="font-light text-text-tertiary">
										{option === "admin" ? "every mailbox, and can manage people" : "only the mailboxes you pick"}
									</span>
								</label>
							))}
						</div>
					</fieldset>

					{role === "member" ? (
						<fieldset className="space-y-2">
							<legend className="text-[11px] font-medium text-text-secondary">Mailboxes</legend>
							{addresses.length === 0 ? (
								<p className="text-sm text-text-tertiary">No mailboxes exist yet. Create one first.</p>
							) : (
								<div className="flex flex-wrap gap-1.5">
									{addresses.map((address) => {
										const on = selected.includes(address);
										return (
											<label
												key={address}
												className={`flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-2 text-xs ring-1 focus-within:ring-2 focus-within:ring-violet/50 ${on ? CHIP_ON : CHIP_OFF}`}
											>
												<input
													type="checkbox"
													checked={on}
													onChange={() =>
														setSelected((cur) =>
															on ? cur.filter((a) => a !== address) : [...cur, address],
														)
													}
													disabled={create.isPending}
													className="sr-only"
												/>
												{on ? <Check size={12} aria-hidden /> : <Plus size={12} aria-hidden />}
												{address}
											</label>
										);
									})}
								</div>
							)}
							{selected.length > 0 ? (
								<ul className="space-y-1.5">
									{selected.map((address) => (
										<li key={address} className="flex flex-wrap items-center gap-2 text-xs">
											<span className="min-w-0 truncate font-mono text-text-primary">{address}</span>
											<label className="sr-only" htmlFor={`invite-role-${address}`}>
												Access to {address}
											</label>
											<select
												id={`invite-role-${address}`}
												value={roleFor(address)}
												onChange={(e) =>
													setMailboxRoles((cur) => ({ ...cur, [address]: e.target.value as InviteMailboxRole }))
												}
												disabled={create.isPending}
												className={`${SETTINGS_INPUT_CLASS} h-8 w-auto`}
											>
												{INVITE_MAILBOX_ROLES.map((r) => (
													<option key={r} value={r}>
														{INVITE_ROLE_LABELS[r]}
													</option>
												))}
											</select>
										</li>
									))}
								</ul>
							) : null}
							<p className="text-xs text-text-tertiary">
								Owner: everything, including who else gets in. Manager: runs the mailbox but can't share it. Can reply:
								reads and sends. Read only: reads. You can change this later in Access.
							</p>
						</fieldset>
					) : null}

					<InlineError message={error} />
					<div className="flex gap-2">
						<button type="submit" disabled={create.isPending} className={PRIMARY_BUTTON_CLASS}>
							{create.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
							Create invite link
						</button>
						<button type="button" onClick={close} className={SECONDARY_BUTTON_CLASS}>
							Cancel
						</button>
					</div>
				</form>
			) : null}

			{loading ? (
				<p className="flex items-center gap-2 px-3 py-2 text-xs text-text-secondary">
					<Loader2 size={12} className="animate-spin" aria-hidden /> Loading
				</p>
			) : invites.length === 0 ? (
				<p className="rounded-[6px] bg-bg-subtle px-3 py-2.5 text-sm text-text-secondary">
					No pending invites.
				</p>
			) : (
				<ul className="space-y-1.5">
					{invites.map((invite) => (
						<li
							key={invite.id}
							className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[6px] bg-bg-subtle px-3 py-2"
						>
							<span className="truncate text-xs font-medium text-text-primary">{invite.email}</span>
							<Pill tone={invite.role === "admin" ? "admin" : "muted"}>{invite.role}</Pill>
							<span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
								{invite.role === "admin"
									? "Every mailbox"
									: (invite.access ?? invite.mailboxes.map((id) => ({ id, role: "owner" as const })))
											.map((a) => `${a.id} (${INVITE_ROLE_LABELS[a.role].toLowerCase()})`)
											.join(", ") || "No mailboxes"}
								{" · "}expires {formatRelativeTime(invite.expiresAt)}
							</span>
							<button
								type="button"
								onClick={() => onRevoke(invite)}
								disabled={revoke.isPending}
								aria-label={`Revoke invite for ${invite.email}`}
								className="rounded-[4px] p-1.5 text-text-tertiary hover:bg-bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50 disabled:opacity-50"
							>
								<Trash2 size={13} aria-hidden />
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
