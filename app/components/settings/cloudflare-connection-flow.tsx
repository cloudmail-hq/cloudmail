// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Connect, verify and disconnect Cloudflare, with the recent-sign-in step.
 * Shared by Settings → Cloudflare connection and the onboarding wizard.
 */

import { Fingerprint, Loader2 } from "lucide-react";
import { useState } from "react";
import type { CfAccountChoice } from "../../../shared/cf-connection";
import { toast } from "~/lib/toast";
import { useReauth } from "~/queries/auth";
import { useConnectCloudflare, useDisconnectCloudflare, useVerifyCloudflare } from "~/queries/cloudflare";
import { ApiError } from "~/services/api";
import { authErrorCode, authErrorMessage } from "~/services/auth-api";
import { PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS, SettingsField } from "./settings-ui";

export type CloudflareAction =
	| { kind: "connect"; token: string; accountId?: string }
	| { kind: "verify" }
	| { kind: "disconnect" };

export function useCloudflareConnectionFlow(options: { onDisconnectStarted?: () => void } = {}) {
	const connect = useConnectCloudflare();
	const verify = useVerifyCloudflare();
	const disconnect = useDisconnectCloudflare();
	const reauth = useReauth();
	const [token, setToken] = useState("");
	const [accounts, setAccounts] = useState<CfAccountChoice[] | null>(null);
	const [pending, setPending] = useState<CloudflareAction | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function run(action: CloudflareAction): Promise<boolean> {
		setError(null);
		try {
			if (action.kind === "connect") {
				await connect.mutateAsync({ token: action.token, ...(action.accountId ? { accountId: action.accountId } : {}) });
				setToken("");
				setAccounts(null);
				toast.success("Cloudflare connected");
			} else if (action.kind === "verify") {
				await verify.mutateAsync();
				toast.success("Checked");
			} else {
				await disconnect.mutateAsync();
				toast.success("Cloudflare disconnected");
			}
			return true;
		} catch (err) {
			const code = authErrorCode(err);
			if (code === "reauth_required") {
				options.onDisconnectStarted?.();
				setPending(action);
				return false;
			}
			if (code === "multiple_accounts" && err instanceof ApiError && Array.isArray(err.body.accounts)) {
				setAccounts(err.body.accounts as CfAccountChoice[]);
				return false;
			}
			setError(authErrorMessage(err, "Couldn't reach Cloudflare. Try again."));
			return false;
		}
	}

	async function confirmReauth(input: { password: string } | { passkey: true }) {
		setError(null);
		try {
			await reauth.mutateAsync(input);
			const action = pending;
			setPending(null);
			if (action) await run(action);
		} catch (err) {
			setError(authErrorMessage(err, "Couldn't confirm it's you."));
		}
	}

	return {
		token,
		setToken,
		accounts,
		pending,
		error,
		setError,
		run,
		confirmReauth,
		cancelReauth: () => {
			setPending(null);
			setError(null);
		},
		busy: connect.isPending || verify.isPending || disconnect.isPending || reauth.isPending,
		connectPending: connect.isPending,
		verifyPending: verify.isPending,
		disconnectPending: disconnect.isPending,
		reauthPending: reauth.isPending,
	};
}

/** Password or passkey prompt after `reauth_required`; the caller replays its action. */
export function ReauthPrompt({
	message,
	busy,
	pending,
	onConfirm,
	onCancel,
	onError,
}: {
	message: string;
	busy: boolean;
	pending: boolean;
	onConfirm: (input: { password: string } | { passkey: true }) => void | Promise<void>;
	onCancel: () => void;
	onError: (message: string) => void;
}) {
	const [password, setPassword] = useState("");
	return (
		<div className="space-y-3 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
			<div>
				<h4 className="text-sm font-medium text-text-primary">Confirm it's you</h4>
				<p className="mt-1 text-sm text-text-secondary">{message}</p>
			</div>
			<form
				onSubmit={async (e) => {
					e.preventDefault();
					if (!password) return onError("Enter your password.");
					await onConfirm({ password });
					setPassword("");
				}}
				className="flex flex-wrap items-end gap-2"
			>
				<SettingsField
					label="Password"
					type="password"
					autoComplete="current-password"
					// biome-ignore lint/a11y/noAutofocus: opened by an explicit action.
					autoFocus
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					disabled={busy}
					className="w-full max-w-xs"
				/>
				<button type="submit" disabled={busy} className={PRIMARY_BUTTON_CLASS}>
					{pending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
					Confirm
				</button>
				<button type="button" onClick={() => void onConfirm({ passkey: true })} disabled={busy} className={SECONDARY_BUTTON_CLASS}>
					<Fingerprint size={13} aria-hidden />
					Use a passkey
				</button>
			</form>
			<button type="button" onClick={onCancel} className="text-xs font-medium text-text-secondary hover:text-text-primary">
				Cancel
			</button>
		</div>
	);
}
