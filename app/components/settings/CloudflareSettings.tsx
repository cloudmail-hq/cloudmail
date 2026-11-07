// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → Cloudflare connection (admin).
 *
 * One API token lets the app set up domains (Settings → Domains), read
 * analytics and check routing. "Create token" opens Cloudflare's form with
 * every permission prefilled; the admin pastes the result here. Saving,
 * re-checking and disconnecting need a recently confirmed browser session:
 * on `reauth_required` the page asks for the password or a passkey, then
 * retries (the same step as Account → Your data).
 *
 * A `CF_API_TOKEN` Worker secret always wins; the page then only shows it.
 */

import { Cloud, ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { CF_CAPABILITY_LABELS, type CfCapability } from "../../../shared/cf-connection";
import { useCloudflareConnection } from "~/queries/cloudflare";
import { useCurrentUser } from "~/queries/people";
import { authErrorMessage } from "~/services/auth-api";
import { ReauthPrompt, useCloudflareConnectionFlow } from "./cloudflare-connection-flow";
import {
	ConfirmDialog,
	DANGER_BUTTON_CLASS,
	InlineError,
	Pill,
	PRIMARY_BUTTON_CLASS,
	SECONDARY_BUTTON_CLASS,
	SectionHeading,
	SettingsField,
} from "./settings-ui";


const STATUS_TONE: Record<CfCapability["status"], "success" | "warning" | "muted"> = {
	ok: "success",
	missing: "warning",
	unknown: "muted",
};
const STATUS_LABEL: Record<CfCapability["status"], string> = { ok: "OK", missing: "Missing", unknown: "Unknown" };

function formatDate(ms: number): string {
	return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function CloudflareSettings() {
	const { data: me } = useCurrentUser();
	const { data, isLoading, error: loadError } = useCloudflareConnection();
	const [confirmDisconnect, setConfirmDisconnect] = useState(false);
	const flow = useCloudflareConnectionFlow({ onDisconnectStarted: () => setConfirmDisconnect(false) });
	const { token, setToken, accounts, pending, error, setError, run, confirmReauth, cancelReauth, busy } = flow;

	const canManage = me?.authMethod === "session";
	const fromEnv = data?.source === "env";

	return (
		<section className="space-y-3">
			<SectionHeading icon={Cloud} title="Cloudflare connection" busy={isLoading} />
			<p className="text-sm text-text-secondary">
				One API token lets this app set up your domains, routing and sending, and read analytics.{" "}
				<Link to="/onboarding" className="font-medium text-text-primary underline-offset-2 hover:underline">
					Run guided setup
				</Link>
			</p>

			{loadError ? <InlineError message={authErrorMessage(loadError, "Couldn't load the connection.")} /> : null}

			{data ? (
				<div className="space-y-4 rounded-[8px] bg-card p-5 ring-1 ring-border">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm font-medium text-text-primary">
							{data.connected ? "Connected" : data.state === "reconnect_required" ? "Reconnect needed" : "Not connected"}
						</span>
						{data.connected ? <Pill tone="success">{fromEnv ? "CF_API_TOKEN secret" : "Saved token"}</Pill> : null}
						{data.state === "reconnect_required" ? <Pill tone="warning">Paste the token again</Pill> : null}
					</div>

					{data.connected || data.state === "reconnect_required" ? (
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
							{data.accountName || data.accountId ? (
								<>
									<dt className="text-text-tertiary">Account</dt>
									<dd className="min-w-0 break-words text-text-primary">{data.accountName ?? data.accountId}</dd>
								</>
							) : null}
							{data.last4 ? (
								<>
									<dt className="text-text-tertiary">Token</dt>
									<dd className="font-mono text-text-primary">…{data.last4}</dd>
								</>
							) : null}
							{data.verifiedAt ? (
								<>
									<dt className="text-text-tertiary">Checked</dt>
									<dd className="text-text-primary">{formatDate(data.verifiedAt)}</dd>
								</>
							) : null}
							<dt className="text-text-tertiary">Worker</dt>
							<dd className="min-w-0 break-words font-mono text-text-primary">{data.workerScriptName}</dd>
						</dl>
					) : null}

					{data.state === "reconnect_required" ? (
						<p className="text-sm text-text-secondary">
							The saved token can't be read since AUTH_SECRET changed. Paste a token below.
						</p>
					) : null}

					{fromEnv ? (
						<p className="text-xs text-text-tertiary">
							Set as the CF_API_TOKEN Worker secret, which always wins. Remove that secret to use a token saved here.
						</p>
					) : null}

					{data.capabilities.length > 0 ? (
						<ul className="divide-y divide-border/60 rounded-[6px] ring-1 ring-border" aria-label="What the token can do">
							{data.capabilities.map((cap) => (
								<li key={cap.name} className="flex items-center gap-3 px-3 py-2 text-sm">
									<span className="min-w-0 flex-1 text-text-primary">
										{CF_CAPABILITY_LABELS[cap.name] ?? cap.name}
										{cap.detail ? <span className="ml-2 text-xs text-text-tertiary">{cap.detail}</span> : null}
									</span>
									<Pill tone={STATUS_TONE[cap.status]}>{STATUS_LABEL[cap.status]}</Pill>
								</li>
							))}
						</ul>
					) : null}

					{!fromEnv && !canManage ? (
						<p className="text-xs text-text-tertiary">Changing the connection needs a signed-in browser session.</p>
					) : null}

					{!fromEnv && canManage ? (
						<div className="space-y-3 border-t border-border/60 pt-4">
							<div className="flex flex-wrap items-center gap-2">
								<a href={data.templateUrl} target="_blank" rel="noopener noreferrer" className={SECONDARY_BUTTON_CLASS}>
									<ExternalLink size={13} aria-hidden />
									Create token
								</a>
								{data.connected ? (
									<>
										<button type="button" onClick={() => void run({ kind: "verify" })} disabled={busy} className={SECONDARY_BUTTON_CLASS}>
											{flow.verifyPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
											Verify
										</button>
										<button type="button" onClick={() => setConfirmDisconnect(true)} disabled={busy} className={DANGER_BUTTON_CLASS}>
											Disconnect
										</button>
									</>
								) : null}
							</div>
							<form
								onSubmit={(e) => {
									e.preventDefault();
									if (!token.trim()) return setError("Paste the token first.");
									void run({ kind: "connect", token: token.trim() });
								}}
								className="flex flex-wrap items-end gap-2"
							>
								<SettingsField
									label={data.connected ? "Replace token" : "API token"}
									type="password"
									autoComplete="off"
									spellCheck={false}
									value={token}
									onChange={(e) => setToken(e.target.value)}
									disabled={busy}
									className="w-full max-w-sm"
								/>
								<button type="submit" disabled={busy || !token.trim()} className={PRIMARY_BUTTON_CLASS}>
									{flow.connectPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
									Save and verify
								</button>
							</form>

							{accounts ? (
								<div className="space-y-2">
									<p className="text-sm text-text-secondary">This token reaches more than one account. Choose one:</p>
									<div className="flex flex-wrap gap-2">
										{accounts.map((a) => (
											<button
												key={a.id}
												type="button"
												disabled={busy}
												onClick={() => void run({ kind: "connect", token: token.trim(), accountId: a.id })}
												className={SECONDARY_BUTTON_CLASS}
											>
												{a.name ?? a.id}
											</button>
										))}
									</div>
								</div>
							) : null}
						</div>
					) : null}

					{pending ? (
						<ReauthPrompt
							message="Changing the Cloudflare connection needs your password or a passkey."
							busy={busy}
							pending={flow.reauthPending}
							onConfirm={confirmReauth}
							onCancel={cancelReauth}
							onError={setError}
						/>
					) : null}

					<InlineError message={error} />
				</div>
			) : null}

			<ConfirmDialog
				open={confirmDisconnect}
				onOpenChange={setConfirmDisconnect}
				title="Disconnect Cloudflare?"
				description="The saved token is deleted. Domain setup and Cloudflare analytics stop until you connect again. Nothing in your Cloudflare account changes."
				confirmLabel="Disconnect"
				pending={flow.disconnectPending}
				onConfirm={() => void run({ kind: "disconnect" }).then((ok) => ok && setConfirmDisconnect(false))}
			/>
		</section>
	);
}
