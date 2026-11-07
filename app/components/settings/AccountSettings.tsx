// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * "Account & security": the signed-in user's own account, in password mode.
 *
 * Visible to every user, not only administrators — everything here acts on the
 * caller's own account and the Worker scopes each endpoint to it.
 */

import {
	AppWindow,
	Check,
	KeyRound,
	Laptop,
	Loader2,
	LogOut,
	Plus,
	Terminal,
	Trash2,
	UserCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	describeUserAgent,
	formatRelativeTime,
	PASSWORD_MIN_LENGTH,
} from "~/lib/auth-helpers";
import { toast } from "~/lib/toast";
import {
	useApiTokens,
	useChangePassword,
	useOAuthGrants,
	useRevokeOAuthGrant,
	useSetOAuthGrantSendAuto,
	useCreateApiToken,
	useRevokeApiToken,
	useRevokeOtherSessions,
	useRevokeSession,
	useSessions,
	useUpdateProfile,
} from "~/queries/auth";
import { useCurrentUser } from "~/queries/people";
import type { ApiTokenInfo, OAuthGrantInfo, SessionInfo } from "~/services/auth-api";
import { authErrorCode, authErrorMessage } from "~/services/auth-api";
import { PasswordStrengthMeter } from "~/components/auth/AuthShell";
import ApiTokensPanel from "./ApiTokensPanel";
import PasskeySettings from "./PasskeySettings";
import TwoFactorSettings from "./TwoFactorSettings";
import YourDataPanel from "./YourDataPanel";
import {
	ConfirmDialog,
	InlineError,
	ListRow,
	Pill,
	PRIMARY_BUTTON_CLASS,
	ROW_ACTION_CLASS,
	ROW_ICON_ACTION_CLASS,
	SecretBox,
	SECONDARY_BUTTON_CLASS,
	SectionHeading,
	SETTINGS_INPUT_CLASS,
	SettingsField,
} from "./settings-ui";
import { cn } from "~/lib/utils";

export default function AccountSettings() {
	const { data: me } = useCurrentUser();
	if (!me) return null;

	return (
		<section className="space-y-3">
			<SectionHeading icon={UserCircle} title="Account & security" />

			<div className="divide-y divide-border/60 rounded-[8px] bg-card ring-1 ring-border">
				<ProfileForm name={me.name} email={me.email ?? ""} isOwner={me.isOwner ?? false} />
				<PasswordForm email={me.email ?? ""} name={me.name} />
				<TwoFactorSettings enabled={me.totpEnabled ?? false} />
				<PasskeySettings totpEnabled={me.totpEnabled ?? false} canManage={me.authMethod === "session"} />
			</div>

			<SessionsPanel />
			<ApiTokensPanel canCreate={me.authMethod !== "token"} />
			<ConnectedAppsPanel />
			<div className="rounded-[8px] bg-card ring-1 ring-border">
				<YourDataPanel isOwner={me.isOwner ?? false} canManage={me.authMethod === "session"} />
			</div>
		</section>
	);
}

/* --------------------------------- Profile -------------------------------- */

function ProfileForm({ name, email, isOwner }: { name: string; email: string; isOwner: boolean }) {
	const [value, setValue] = useState(name);
	const [error, setError] = useState<string | null>(null);
	const update = useUpdateProfile();
	useEffect(() => setValue(name), [name]);

	const dirty = value.trim() !== name && value.trim().length > 0;

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!value.trim()) return setError("Your name can't be empty.");
		try {
			await update.mutateAsync(value.trim());
			toast.success("Name updated");
		} catch (err) {
			setError(authErrorMessage(err, "Couldn't update your name."));
		}
	}

	return (
		<form onSubmit={onSubmit} className="space-y-3 p-5">
			<div>
				<h3 className="flex items-center gap-2 text-sm font-medium text-text-primary">
					Profile
					{isOwner ? <Pill tone="violet">Owner</Pill> : null}
				</h3>
				<p className="mt-1 text-sm text-text-secondary">
					Signed in as <span className="font-medium text-text-primary">{email}</span>. Your email
					is your sign-in name; an administrator can't change it here.
				</p>
			</div>
			<div className="flex flex-wrap items-end gap-2">
				<SettingsField
					label="Display name"
					autoComplete="name"
					value={value}
					maxLength={100}
					onChange={(e) => setValue(e.target.value)}
					disabled={update.isPending}
					className="w-full max-w-xs"
				/>
				<button type="submit" disabled={!dirty || update.isPending} className={PRIMARY_BUTTON_CLASS}>
					{update.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
					Save
				</button>
			</div>
			<InlineError message={error} />
		</form>
	);
}

/* --------------------------------- Password -------------------------------- */

function PasswordForm({ email, name }: { email: string; name: string }) {
	const [open, setOpen] = useState(false);
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});
	const [error, setError] = useState<string | null>(null);
	const change = useChangePassword();

	function close() {
		setOpen(false);
		setCurrent("");
		setNext("");
		setConfirm("");
		setErrors({});
		setError(null);
	}

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		const v: typeof errors = {};
		if (!current) v.current = "Enter your current password.";
		if ([...next].length < PASSWORD_MIN_LENGTH) v.next = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
		else if (next === current) v.next = "Choose a password you haven't used here.";
		if (confirm !== next) v.confirm = "The passwords don't match.";
		setErrors(v);
		if (Object.keys(v).length > 0) return;
		try {
			await change.mutateAsync({ currentPassword: current, newPassword: next });
			close();
			toast.success("Password changed", {
				description: "Every other session has been signed out.",
			});
		} catch (err) {
			const code = authErrorCode(err);
			if (code === "wrong_password") setErrors({ current: authErrorMessage(err, "Wrong password.") });
			else if (code === "weak_password") setErrors({ next: authErrorMessage(err, "Choose a stronger password.") });
			else setError(authErrorMessage(err, "Couldn't change your password."));
		}
	}

	return (
		<div className="space-y-3 p-5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="text-sm font-medium text-text-primary">Password</h3>
					<p className="mt-1 text-sm text-text-secondary">
						Changing it signs you out everywhere except this browser.
					</p>
				</div>
				{!open ? (
					<button type="button" onClick={() => setOpen(true)} className={SECONDARY_BUTTON_CLASS}>
						<KeyRound size={13} aria-hidden />
						Change password
					</button>
				) : null}
			</div>
			{open ? (
				<form onSubmit={onSubmit} className="space-y-3 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
					{/* Lets password managers file the new password under the right account. */}
					<input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
					<SettingsField
						label="Current password"
						type="password"
						autoComplete="current-password"
						// biome-ignore lint/a11y/noAutofocus: opened by an explicit click.
						autoFocus
						value={current}
						onChange={(e) => setCurrent(e.target.value)}
						error={errors.current}
						disabled={change.isPending}
						className="max-w-xs"
					/>
					<div className="grid max-w-xl gap-3 sm:grid-cols-2">
						<SettingsField
							label="New password"
							type="password"
							autoComplete="new-password"
							value={next}
							onChange={(e) => setNext(e.target.value)}
							error={errors.next}
							hint={<PasswordStrengthMeter password={next} context={[email, name]} />}
							disabled={change.isPending}
						/>
						<SettingsField
							label="Confirm new password"
							type="password"
							autoComplete="new-password"
							value={confirm}
							onChange={(e) => setConfirm(e.target.value)}
							error={errors.confirm}
							disabled={change.isPending}
						/>
					</div>
					<InlineError message={error} />
					<div className="flex gap-2">
						<button type="submit" disabled={change.isPending} className={PRIMARY_BUTTON_CLASS}>
							{change.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
							Update password
						</button>
						<button type="button" onClick={close} className={SECONDARY_BUTTON_CLASS}>
							Cancel
						</button>
					</div>
				</form>
			) : null}
		</div>
	);
}

/* --------------------------------- Sessions -------------------------------- */

function SessionsPanel() {
	const { data: sessions, isLoading, isError, refetch } = useSessions();
	const revoke = useRevokeSession();
	const revokeOthers = useRevokeOtherSessions();
	const others = (sessions ?? []).filter((s) => !s.current);

	async function onRevoke(session: SessionInfo) {
		try {
			await revoke.mutateAsync(session.id);
			toast.success("Session signed out");
		} catch (err) {
			toast.error(authErrorMessage(err, "Couldn't sign that session out."));
		}
	}

	async function onRevokeOthers() {
		try {
			const { revoked } = await revokeOthers.mutateAsync();
			toast.success(revoked === 1 ? "Signed out 1 other session" : `Signed out ${revoked} other sessions`);
		} catch (err) {
			toast.error(authErrorMessage(err, "Couldn't sign the other sessions out."));
		}
	}

	return (
		<div className="space-y-3 rounded-[8px] bg-card p-5 ring-1 ring-border">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h3 className="text-sm font-medium text-text-primary">Active sessions</h3>
					<p className="mt-1 text-sm text-text-secondary">
						Browsers signed in to your account. Sessions end after 14 days without use.
					</p>
				</div>
				{others.length > 0 ? (
					<button
						type="button"
						onClick={onRevokeOthers}
						disabled={revokeOthers.isPending}
						className={SECONDARY_BUTTON_CLASS}
					>
						{revokeOthers.isPending ? (
							<Loader2 size={13} className="animate-spin" aria-hidden />
						) : (
							<LogOut size={13} aria-hidden />
						)}
						Sign out all others
					</button>
				) : null}
			</div>

			{isLoading ? (
				<p className="flex items-center gap-2 text-xs text-text-secondary">
					<Loader2 size={12} className="animate-spin" aria-hidden /> Loading
				</p>
			) : isError ? (
				<p className="text-xs text-text-secondary">
					Couldn't load your sessions.{" "}
					<button type="button" onClick={() => refetch()} className="font-medium text-text-primary hover:underline">
						Retry
					</button>
				</p>
			) : (
				<ul className="space-y-1.5">
					{(sessions ?? [])
						.slice()
						.sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt)
						.map((session) => (
							<ListRow
								key={session.id}
								icon={<Laptop size={14} />}
								title={describeUserAgent(session.userAgent)}
								badges={session.current ? <Pill tone="success">This browser</Pill> : null}
								details={[
									session.ip,
									session.current ? "active now" : `last active ${formatRelativeTime(session.lastSeenAt)}`,
									`signed in ${formatRelativeTime(session.createdAt)}`,
								]}
								actions={
									!session.current ? (
										<button
											type="button"
											onClick={() => onRevoke(session)}
											disabled={revoke.isPending}
											className={ROW_ACTION_CLASS}
										>
											Sign out
										</button>
									) : null
								}
							/>
						))}
				</ul>
			)}
		</div>
	);
}

/* ------------------------------- Connected apps ------------------------------ */

/**
 * MCP clients (Claude Code, Cursor, …) the user approved by signing in through
 * the browser. Each acts as the user, with the same mailbox access as an API
 * token; revoking one cuts it off on its next request.
 */
function ConnectedAppsPanel() {
	const { data: grants, isLoading, isError, refetch } = useOAuthGrants();
	const revoke = useRevokeOAuthGrant();
	const setSendAuto = useSetOAuthGrantSendAuto();
	const [confirmRevoke, setConfirmRevoke] = useState<OAuthGrantInfo | null>(null);

	/**
	 * Lets this app send without approval, but only on mailboxes whose owner
	 * chose "Send automatically". Everywhere else its sends still wait.
	 */
	async function onSendAuto(grant: OAuthGrantInfo, sendAuto: boolean) {
		try {
			await setSendAuto.mutateAsync({ id: grant.id, sendAuto });
			toast.success(
				sendAuto
					? `“${grant.clientName}” can send without approval on mailboxes set to send automatically`
					: `Sends from “${grant.clientName}” need approval again`,
			);
		} catch (err) {
			toast.error(authErrorMessage(err, "Couldn't change that."));
		}
	}

	async function onRevoke() {
		if (!confirmRevoke) return;
		try {
			await revoke.mutateAsync(confirmRevoke.id);
			toast.success(`Disconnected “${confirmRevoke.clientName}”`);
			setConfirmRevoke(null);
		} catch (err) {
			toast.error(authErrorMessage(err, "Couldn't disconnect that app."));
		}
	}

	return (
		<div className="space-y-3 rounded-[8px] bg-card p-5 ring-1 ring-border">
			<div className="min-w-0">
				<h3 className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
					<AppWindow size={13} className="text-text-tertiary" aria-hidden />
					Connected apps
				</h3>
				<p className="mt-1 text-sm text-text-secondary">
					AI clients you signed in to over MCP, like Claude Code or Cursor. Each acts as you, with
					your mailbox access. Signing out all other sessions also disconnects them.
				</p>
			</div>

			{isLoading ? (
				<p className="flex items-center gap-2 text-xs text-text-secondary">
					<Loader2 size={12} className="animate-spin" aria-hidden /> Loading
				</p>
			) : isError ? (
				<p className="text-xs text-text-secondary">
					Couldn't load your connected apps.{" "}
					<button type="button" onClick={() => refetch()} className="font-medium text-text-primary hover:underline">
						Retry
					</button>
				</p>
			) : (grants ?? []).length === 0 ? (
				<p className="rounded-[6px] bg-bg-subtle px-3 py-2.5 text-sm text-text-secondary">
					No apps connected. Add this mailbox to an MCP client with its{" "}
					<code className="font-mono">/mcp</code> URL and sign in when your browser opens.
				</p>
			) : (
				<ul className="space-y-1.5">
					{(grants ?? []).map((grant) => (
						<ListRow
							key={grant.id}
							title={grant.clientName}
							badges={
								<span className="break-all font-mono text-[11px] text-text-tertiary">
									{grant.redirectHost}
								</span>
							}
							details={[
								`connected ${formatRelativeTime(grant.createdAt)}`,
								grant.lastUsedAt ? `used ${formatRelativeTime(grant.lastUsedAt)}` : "not used yet",
								grant.sendAuto ? "sends without approval" : "sends need approval",
							]}
							actions={
								<>
								<label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-secondary max-sm:min-h-11">
									<input
										type="checkbox"
										checked={grant.sendAuto === true}
										disabled={setSendAuto.isPending}
										onChange={(e) => void onSendAuto(grant, e.target.checked)}
										className="size-4 accent-accent"
									/>
									<span>Send without approval</span>
								</label>
								<button
									type="button"
									onClick={() => setConfirmRevoke(grant)}
									aria-label={`Disconnect ${grant.clientName}`}
									className={cn(ROW_ICON_ACTION_CLASS, "hover:text-destructive")}
								>
									<Trash2 size={14} aria-hidden />
								</button>
								</>
							}
						/>
					))}
				</ul>
			)}

			<ConfirmDialog
				open={confirmRevoke !== null}
				onOpenChange={(open) => !open && setConfirmRevoke(null)}
				title="Disconnect this app?"
				description={
					<>
						“{confirmRevoke?.clientName}” will lose access immediately and has to sign in again to
						reconnect.
					</>
				}
				confirmLabel="Disconnect"
				onConfirm={onRevoke}
				pending={revoke.isPending}
			/>
		</div>
	);
}
