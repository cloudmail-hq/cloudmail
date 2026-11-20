// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Passkeys: add, rename and remove the passkeys that sign in to this account.
 *
 * Adding one is adding a way into the account, so the Worker asks for a
 * recent sign-in (15 minutes). Past that, this panel asks the user to confirm
 * who they are first, with a passkey they already have, their password, or an
 * authenticator code, then continues straight into adding the new one.
 */

import { Fingerprint, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { formatRelativeTime } from "~/lib/auth-helpers";
import { describePasskeyError, isPasskeyCancel, passkeysSupported } from "~/lib/passkeys";
import { toast } from "~/lib/toast";
import {
	useDeletePasskey,
	usePasskeys,
	useReauth,
	useRegisterPasskey,
	useRenamePasskey,
} from "~/queries/auth";
import { authErrorCode, authErrorMessage, type PasskeyInfo } from "~/services/auth-api";
import {
	ConfirmDialog,
	InlineError,
	ListRow,
	Pill,
	PRIMARY_BUTTON_CLASS,
	ROW_ICON_ACTION_CLASS,
	SECONDARY_BUTTON_CLASS,
	SettingsField,
} from "./settings-ui";
import { cn } from "~/lib/utils";

type Mode = { kind: "idle" } | { kind: "reauth" } | { kind: "rename"; passkey: PasskeyInfo };

/** "Synced" passkeys survive losing the device; device-bound ones do not. */
function describeKind(p: PasskeyInfo): string {
	if (p.deviceType === "multiDevice") return p.backedUp ? "Synced passkey" : "Syncable passkey";
	return "This device only";
}

export default function PasskeySettings({ totpEnabled, canManage }: { totpEnabled: boolean; canManage: boolean }) {
	const { data: passkeys, isLoading, isError, refetch } = usePasskeys();
	const register = useRegisterPasskey();
	const reauth = useReauth();
	const rename = useRenamePasskey();
	const remove = useDeletePasskey();

	const [mode, setMode] = useState<Mode>({ kind: "idle" });
	const [error, setError] = useState<string | null>(null);
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [name, setName] = useState("");
	const [confirmDelete, setConfirmDelete] = useState<PasskeyInfo | null>(null);
	const [supported, setSupported] = useState(true);

	// Decided after hydration: the server render cannot know.
	useEffect(() => setSupported(passkeysSupported()), []);

	const list = passkeys ?? [];

	function reset() {
		setMode({ kind: "idle" });
		setPassword("");
		setCode("");
		setName("");
		setError(null);
	}

	async function add() {
		setError(null);
		try {
			const { passkey } = await register.mutateAsync(undefined);
			toast.success(`Added “${passkey.name}”`, { description: "Give it a name you'll recognise." });
			// Straight into naming it: "Passkey 2" tells nobody which device it is.
			setMode({ kind: "rename", passkey });
			setName(passkey.name);
		} catch (err) {
			if (authErrorCode(err) === "reauth_required") {
				setMode({ kind: "reauth" });
				return;
			}
			if (isPasskeyCancel(err)) return;
			setError(
				authErrorCode(err)
					? authErrorMessage(err, "Couldn't add the passkey.")
					: describePasskeyError(err, "Couldn't add the passkey."),
			);
		}
	}

	async function confirm(input: { password: string } | { code: string } | { passkey: true }) {
		setError(null);
		try {
			await reauth.mutateAsync(input);
			setPassword("");
			setCode("");
			await add();
		} catch (err) {
			if (isPasskeyCancel(err)) return;
			setError(
				authErrorCode(err)
					? authErrorMessage(err, "Couldn't confirm it's you.")
					: describePasskeyError(err, "Couldn't confirm it's you."),
			);
		}
	}

	async function onRename(e: React.FormEvent) {
		e.preventDefault();
		if (mode.kind !== "rename") return;
		setError(null);
		if (!name.trim()) return setError("Give the passkey a name.");
		try {
			await rename.mutateAsync({ id: mode.passkey.id, name: name.trim() });
			reset();
		} catch (err) {
			setError(authErrorMessage(err, "Couldn't rename the passkey."));
		}
	}

	async function onDelete() {
		if (!confirmDelete) return;
		try {
			await remove.mutateAsync(confirmDelete.id);
			toast.success(`Removed “${confirmDelete.name}”`);
			setConfirmDelete(null);
		} catch (err) {
			toast.error(authErrorMessage(err, "Couldn't remove that passkey."));
		}
	}

	const busy = register.isPending || reauth.isPending;

	return (
		<div className="space-y-4 p-5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="flex items-center gap-2 text-sm font-medium text-text-primary">
						Passkeys
						{list.length > 0 ? <Pill tone="success">{list.length}</Pill> : null}
					</h3>
					<p className="mt-1 text-sm text-text-secondary">
						Sign in with your fingerprint, face or device PIN instead of a password. A passkey
						also counts as your second factor.
					</p>
				</div>
				{mode.kind === "idle" && canManage && supported ? (
					<button type="button" onClick={add} disabled={busy} className={SECONDARY_BUTTON_CLASS}>
						{busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Plus size={13} aria-hidden />}
						Add a passkey
					</button>
				) : null}
			</div>

			{!supported ? (
				<p className="text-xs text-text-tertiary">This browser doesn't support passkeys.</p>
			) : null}
			{!canManage ? (
				<p className="text-xs text-text-tertiary">
					Passkeys can only be managed from a signed-in browser session.
				</p>
			) : null}

			{mode.kind === "reauth" ? (
				<div className="space-y-3 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
					<div>
						<h4 className="text-sm font-medium text-text-primary">Confirm it's you</h4>
						<p className="mt-1 text-sm text-text-secondary">
							You signed in a while ago. Confirm before adding a new way to sign in.
						</p>
					</div>
					{list.length > 0 ? (
						<button
							type="button"
							onClick={() => confirm({ passkey: true })}
							disabled={busy}
							className={PRIMARY_BUTTON_CLASS}
						>
							<Fingerprint size={13} aria-hidden />
							Use an existing passkey
						</button>
					) : null}
					<form
						onSubmit={(e) => {
							e.preventDefault();
							if (!password) return setError("Enter your password.");
							confirm({ password });
						}}
						className="flex flex-wrap items-end gap-2"
					>
						<SettingsField
							label="Password"
							type="password"
							autoComplete="current-password"
							// biome-ignore lint/a11y/noAutofocus: opened by an explicit click.
							autoFocus={list.length === 0}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							disabled={busy}
							className="w-full max-w-xs"
						/>
						<button type="submit" disabled={busy} className={list.length > 0 ? SECONDARY_BUTTON_CLASS : PRIMARY_BUTTON_CLASS}>
							{busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
							Confirm
						</button>
					</form>
					{totpEnabled ? (
						<form
							onSubmit={(e) => {
								e.preventDefault();
								if (!/^\d{6}$/.test(code)) return setError("Enter the 6-digit code from your authenticator app.");
								confirm({ code });
							}}
							className="flex flex-wrap items-end gap-2"
						>
							<SettingsField
								label="Or an authenticator code"
								inputMode="numeric"
								autoComplete="one-time-code"
								maxLength={6}
								value={code}
								onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
								disabled={busy}
								className="w-40"
							/>
							<button type="submit" disabled={busy} className={SECONDARY_BUTTON_CLASS}>
								Confirm
							</button>
						</form>
					) : null}
					<button type="button" onClick={reset} className="text-xs font-medium text-text-secondary hover:text-text-primary">
						Cancel
					</button>
				</div>
			) : null}

			{mode.kind === "rename" ? (
				<form onSubmit={onRename} className="flex flex-wrap items-end gap-2 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
					<SettingsField
						label="Passkey name"
						placeholder="MacBook Touch ID"
						maxLength={64}
						// biome-ignore lint/a11y/noAutofocus: opened by an explicit action.
						autoFocus
						value={name}
						onChange={(e) => setName(e.target.value)}
						disabled={rename.isPending}
						className="w-full max-w-xs"
					/>
					<button type="submit" disabled={rename.isPending} className={PRIMARY_BUTTON_CLASS}>
						{rename.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
						Save
					</button>
					<button type="button" onClick={reset} className={SECONDARY_BUTTON_CLASS}>
						Cancel
					</button>
				</form>
			) : null}

			<InlineError message={error} />

			{isLoading ? (
				<p className="flex items-center gap-2 text-xs text-text-secondary">
					<Loader2 size={12} className="animate-spin" aria-hidden /> Loading
				</p>
			) : isError ? (
				<p className="text-xs text-text-secondary">
					Couldn't load your passkeys.{" "}
					<button type="button" onClick={() => refetch()} className="font-medium text-text-primary hover:underline">
						Retry
					</button>
				</p>
			) : list.length > 0 ? (
				<ul className="space-y-1.5">
					{list.map((p) => (
						<ListRow
							key={p.id}
							icon={<Fingerprint size={14} />}
							title={p.name}
							badges={
								<Pill tone={p.deviceType === "multiDevice" ? "violet" : "muted"}>{describeKind(p)}</Pill>
							}
							details={[
								`added ${formatRelativeTime(p.createdAt)}`,
								p.lastUsedAt ? `used ${formatRelativeTime(p.lastUsedAt)}` : "never used",
							]}
							actions={
								canManage ? (
									<>
										<button
											type="button"
											onClick={() => {
												setError(null);
												setName(p.name);
												setMode({ kind: "rename", passkey: p });
											}}
											aria-label={`Rename passkey ${p.name}`}
											className={ROW_ICON_ACTION_CLASS}
										>
											<Pencil size={13} aria-hidden />
										</button>
										<button
											type="button"
											onClick={() => setConfirmDelete(p)}
											aria-label={`Remove passkey ${p.name}`}
											className={cn(ROW_ICON_ACTION_CLASS, "hover:text-destructive")}
										>
											<Trash2 size={14} aria-hidden />
										</button>
									</>
								) : null
							}
						/>
					))}
				</ul>
			) : null}

			<ConfirmDialog
				open={confirmDelete !== null}
				onOpenChange={(open) => !open && setConfirmDelete(null)}
				title="Remove this passkey?"
				description={
					<>
						“{confirmDelete?.name}” will no longer sign in to this account. Remove it from the device
						or password manager too.
					</>
				}
				confirmLabel="Remove passkey"
				onConfirm={onDelete}
				pending={remove.isPending}
			/>
		</div>
	);
}
