// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Account & security > Your data: export everything, or delete the account.
 *
 * Both start only from a recently confirmed browser session. When the server
 * answers `reauth_required`, the panel asks for the password or a passkey
 * (the same `/api/auth/passkeys/reauth` step adding a passkey uses), then
 * retries the action.
 */

import { Download, Fingerprint, Loader2, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "~/lib/toast";
import { useReauth } from "~/queries/auth";
import {
	useAccountDeletion,
	useAccountExports,
	useCancelAccountDeletion,
	useDeleteAccount,
	useStartAccountExport,
} from "~/queries/privacy";
import { authErrorCode, authErrorMessage } from "~/services/auth-api";
import {
	ConfirmDialog,
	DANGER_BUTTON_CLASS,
	InlineError,
	PRIMARY_BUTTON_CLASS,
	SECONDARY_BUTTON_CLASS,
	SettingsField,
} from "./settings-ui";

type Pending = "export" | "delete" | null;

function formatBytes(n: number | null): string {
	if (!n) return "";
	if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
	return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function YourDataPanel({
	isOwner,
	canManage,
}: {
	isOwner: boolean;
	/** A browser session (API tokens cannot export or delete). */
	canManage: boolean;
}) {
	const exportsQuery = useAccountExports(canManage);
	const deletion = useAccountDeletion(canManage);
	const startExport = useStartAccountExport();
	const deleteAccount = useDeleteAccount();
	const cancelDeletion = useCancelAccountDeletion();
	const reauth = useReauth();

	const [needsReauth, setNeedsReauth] = useState<Pending>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);

	const latest = exportsQuery.data?.[0];
	const building = latest && (latest.status === "pending" || latest.status === "running");

	async function run(action: Exclude<Pending, null>) {
		setError(null);
		try {
			if (action === "export") {
				await startExport.mutateAsync();
				toast.success("Export started", { description: "It's built in the background. This page updates when it's ready." });
			} else {
				const result = await deleteAccount.mutateAsync();
				setConfirmDelete(false);
				toast.success("Account scheduled for deletion", {
					description: `Everything is removed after ${formatDate(result.purgeAfter)}. You've been signed out.`,
				});
				// Every session was just revoked, including this one.
				window.location.assign("/login");
			}
		} catch (err) {
			if (authErrorCode(err) === "reauth_required") {
				setConfirmDelete(false);
				setNeedsReauth(action);
				return;
			}
			setError(authErrorMessage(err, action === "export" ? "Couldn't start the export." : "Couldn't delete the account."));
		}
	}

	async function confirm(input: { password: string } | { passkey: true }) {
		setError(null);
		try {
			await reauth.mutateAsync(input);
			setPassword("");
			const action = needsReauth;
			setNeedsReauth(null);
			if (action === "delete") setConfirmDelete(true);
			else if (action) await run(action);
		} catch (err) {
			setError(authErrorMessage(err, "Couldn't confirm it's you."));
		}
	}

	const busy = startExport.isPending || deleteAccount.isPending || reauth.isPending;

	return (
		<div className="space-y-5 p-5">
			<div>
				<h3 className="text-sm font-medium text-text-primary">Your data</h3>
				<p className="mt-1 text-sm text-text-secondary">
					Download a copy of your account and the mailboxes you own, or delete your account. See the{" "}
					<Link to="/privacy" reloadDocument className="font-medium text-accent underline-offset-2 hover:underline">
						privacy notice
					</Link>{" "}
					for what is kept and for how long.
				</p>
			</div>

			{!canManage ? (
				<p className="text-xs text-text-tertiary">Export and deletion are only available from a signed-in browser session.</p>
			) : (
				<>
					<div className="space-y-2">
						<div className="flex flex-wrap items-center gap-2">
							<button
								type="button"
								onClick={() => run("export")}
								disabled={busy || !!building}
								className={SECONDARY_BUTTON_CLASS}
							>
								{startExport.isPending || building ? (
									<Loader2 size={13} className="animate-spin" aria-hidden />
								) : (
									<Download size={13} aria-hidden />
								)}
								{building ? "Preparing export…" : "Export my data"}
							</button>
							{latest?.status === "ready" && latest.downloadUrl ? (
								<a href={latest.downloadUrl} className={PRIMARY_BUTTON_CLASS} download>
									<Download size={13} aria-hidden />
									Download ({formatBytes(latest.size)})
								</a>
							) : null}
						</div>
						<p className="text-xs text-text-tertiary" aria-live="polite">
							{latest?.status === "ready"
								? `Ready. The link works until ${formatDate(latest.expiresAt)}.`
								: latest?.status === "failed"
									? `The last export failed${latest.error ? `: ${latest.error}` : ""}. Try again.`
									: "A ZIP with account.json (profile, sessions, token metadata, settings) and one mbox file per mailbox you own."}
						</p>
					</div>

					<div className="space-y-2 border-t border-border/60 pt-4">
						{deletion.data?.pending ? (
							<div className="flex flex-wrap items-center gap-3 rounded-[6px] bg-destructive-subtle px-3 py-2.5 text-sm text-destructive ring-1 ring-destructive/30">
								<ShieldAlert size={14} aria-hidden />
								<span className="min-w-0 flex-1">
									Deletion scheduled. Everything is removed after {formatDate(deletion.data.purgeAfter!)}.
								</span>
								<button
									type="button"
									onClick={() =>
										cancelDeletion.mutate(undefined, {
											onSuccess: () => toast.success("Deletion cancelled"),
											onError: (err) => toast.error(authErrorMessage(err, "Couldn't cancel.")),
										})
									}
									disabled={cancelDeletion.isPending}
									className={SECONDARY_BUTTON_CLASS}
								>
									Keep my account
								</button>
							</div>
						) : isOwner ? (
							<p className="text-xs text-text-tertiary">
								You're the owner of this deployment. The owner can't delete their own account while they are the only
								owner.
							</p>
						) : (
							<>
								<button
									type="button"
									onClick={() => setConfirmDelete(true)}
									disabled={busy}
									className={DANGER_BUTTON_CLASS}
								>
									Delete my account
								</button>
								<p className="text-xs text-text-tertiary">
									Signs you out everywhere and revokes your API tokens now. After 7 days your account and the mailboxes
									only you own are deleted. Sign in before then to cancel.
								</p>
							</>
						)}
					</div>

					{needsReauth ? (
						<div className="space-y-3 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
							<div>
								<h4 className="text-sm font-medium text-text-primary">Confirm it's you</h4>
								<p className="mt-1 text-sm text-text-secondary">
									{needsReauth === "delete" ? "Deleting your account" : "Exporting your data"} needs your password or
									a passkey.
								</p>
							</div>
							<form
								onSubmit={(e) => {
									e.preventDefault();
									if (!password) return setError("Enter your password.");
									void confirm({ password });
								}}
								className="flex flex-wrap items-end gap-2"
							>
								<SettingsField
									label="Password"
									type="password"
									autoComplete="current-password"
									// biome-ignore lint/a11y/noAutofocus: opened by an explicit click.
									autoFocus
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									disabled={busy}
									className="w-full max-w-xs"
								/>
								<button type="submit" disabled={busy} className={PRIMARY_BUTTON_CLASS}>
									{reauth.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
									Confirm
								</button>
								<button
									type="button"
									onClick={() => void confirm({ passkey: true })}
									disabled={busy}
									className={SECONDARY_BUTTON_CLASS}
								>
									<Fingerprint size={13} aria-hidden />
									Use a passkey
								</button>
							</form>
							<button
								type="button"
								onClick={() => {
									setNeedsReauth(null);
									setError(null);
								}}
								className="text-xs font-medium text-text-secondary hover:text-text-primary"
							>
								Cancel
							</button>
						</div>
					) : null}

					<InlineError message={error} />
				</>
			)}

			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete your account?"
				description="You'll be signed out on every device and your API tokens stop working now. In 7 days your account and every mailbox only you own are deleted for good. Mailboxes shared with others are kept. Export your data first if you want a copy."
				confirmLabel="Delete my account"
				pending={deleteAccount.isPending}
				onConfirm={() => void run("delete")}
			/>
		</div>
	);
}
