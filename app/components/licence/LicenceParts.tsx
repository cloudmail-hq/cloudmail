/**
 * The licence UI shared by the onboarding licence step, Settings → Licence,
 * the full-page locked screen and the grace banner. Server side in
 * workers/routes/licence.ts; copy uses the product name, cloudmail.
 *
 * Licences are one-time purchases: there is no renewal date to show.
 */

import { AlertTriangle, ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { PRIMARY_BUTTON_CLASS, SettingsField } from "~/components/settings/settings-ui";
import { cn } from "~/lib/utils";
import type { LicenceInUse } from "../../../shared/licence";
import { type LicenceResponse, useActivateLicence } from "~/queries/licence";
import { ApiError } from "~/services/api";
import { authErrorMessage } from "~/services/auth-api";

export const PRODUCT_NAME = "cloudmail";
/** Where someone without a key can buy one: the storefront, Solo and Unlimited. */
export const BUY_URL = "https://licence.trycloudmail.com/cloudmail";

export function planLabel(plan: LicenceResponse["planName"]): string | null {
	return plan === "solo" ? "Solo" : plan === "unlimited" ? "Unlimited" : null;
}

/** What stops while the app is locked, so nobody is surprised. */
export const PAUSED_WHILE_LOCKED =
	"Incoming mail is still received and stored. Sending, forwarding, auto-replies and webhooks are paused until the licence is active.";

export function statusLabel(view: Pick<LicenceResponse, "status">): string {
	switch (view.status) {
		case "active":
			return "One-time licence: active";
		case "grace":
			return "One-time licence: check failing";
		case "expired":
			return "Expired";
		case "revoked":
			return "Revoked";
		case "invalid":
			return "Not valid for this deployment";
		case "none":
			return "Not activated";
		case "off":
			return "Development build";
	}
}

export function formatDay(seconds: number | null | undefined): string | null {
	if (!seconds) return null;
	return new Date(seconds * 1000).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** The key form. Never keeps the key after submit. */
export function LicenceKeyForm({ onActivated, submitLabel = "Activate" }: { onActivated?: () => void; submitLabel?: string }) {
	const activate = useActivateLicence();
	const [key, setKey] = useState("");
	const [error, setError] = useState<string | null>(null);
	/** The licence is active on another deployment: offer to move it here. */
	const [inUse, setInUse] = useState<LicenceInUse | null>(null);

	async function run(takeover: boolean) {
		const value = key.trim();
		if (!value) return setError("Paste the licence key from your purchase email.");
		setError(null);
		try {
			await activate.mutateAsync({ licenceKey: value, takeover });
			setKey("");
			setInUse(null);
			onActivated?.();
		} catch (err) {
			if (err instanceof ApiError && err.body.code === "activation_limit_reached" && Array.isArray(err.body.active)) {
				setInUse(err.body as unknown as LicenceInUse);
				return;
			}
			setInUse(null);
			setError(authErrorMessage(err, "Activation failed."));
		}
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		void run(false);
	}

	return (
		<form onSubmit={submit} className="space-y-3">
			<SettingsField
				label="Licence key"
				type="text"
				autoComplete="off"
				autoCapitalize="none"
				spellCheck={false}
				value={key}
				onChange={(e) => {
					setKey(e.target.value);
					if (error) setError(null);
					if (inUse) setInUse(null);
				}}
				disabled={activate.isPending}
				error={error}
				inputClassName="min-h-11 sm:min-h-9 font-mono"
				hint={
					<>
						Don't have a key?{" "}
						<a href={BUY_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-2 hover:text-accent-hover sm:min-h-0">
							Buy {PRODUCT_NAME}
						</a>
					</>
				}
			/>
			<button type="submit" disabled={activate.isPending || !key.trim()} className={cn(PRIMARY_BUTTON_CLASS, "min-h-11 w-full justify-center sm:min-h-9 sm:w-auto")}>
				{activate.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <KeyRound size={14} aria-hidden />}
				{submitLabel}
			</button>
			{inUse ? (
				<div role="status" className="space-y-2 rounded-[6px] bg-warning-bg p-3 text-sm text-warning-text ring-1 ring-border">
					<p>
						This licence is active on {inUse.active.length ? inUse.active.map((a) => a.hostHint).join(", ") : "another deployment"}
						{inUse.active[0]?.lastSeenAt ? `, last seen ${formatDay(inUse.active[0].lastSeenAt)}` : ""}. A licence runs one deployment at a time.
					</p>
					<p>Moving it here stops it on the other deployment within a day. Its incoming mail is still received there.</p>
					<button type="button" onClick={() => void run(true)} disabled={activate.isPending || !key.trim()} className={cn(PRIMARY_BUTTON_CLASS, "min-h-11 w-full justify-center sm:min-h-9 sm:w-auto")}>
						{activate.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
						Move licence here
					</button>
				</div>
			) : null}
			{/* The field shows the error; this announces it. */}
			<p role="alert" className="sr-only">{error ?? ""}</p>
		</form>
	);
}

/** Admin banner while refresh is failing but the app still works. */
export function LicenceGraceBanner({ view, strip = false }: { view: LicenceResponse; strip?: boolean }) {
	if (view.status !== "grace") return null;
	const days = view.graceDaysLeft ?? 0;
	return (
		<div
			role="status"
			className={cn(
				"flex items-start gap-3 bg-warning-bg text-sm text-warning-text",
				strip ? "border-b border-warning-border px-4 py-2" : "rounded-[8px] px-3 py-2.5 ring-1 ring-border",
			)}
		>
			<AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
			<p className="min-w-0 flex-1">
				<span className="font-medium">
					Licence couldn't be renewed, {days} {days === 1 ? "day" : "days"} left.
				</span>{" "}
				If it can't reach the licence server by then, sending, forwarding and auto-replies pause. Mail is still received.{" "}
				<a href="/settings/licence" className="whitespace-nowrap font-semibold underline underline-offset-2">
					Check licence
				</a>
			</p>
		</div>
	);
}

/** The deployment moved to another address; the licence still names the old one. */
export function LicenceMovedBanner({ view, strip = false }: { view: LicenceResponse; strip?: boolean }) {
	if (!view.movedFrom || view.locked) return null;
	return (
		<div
			role="status"
			className={cn(
				"flex items-start gap-3 bg-warning-bg text-sm text-warning-text",
				strip ? "border-b border-warning-border px-4 py-2" : "rounded-[8px] px-3 py-2.5 ring-1 ring-border",
			)}
		>
			<AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
			<p className="min-w-0 flex-1">
				<span className="font-medium">Your licence is still registered to {view.movedFrom}.</span>{" "}
				Everything keeps working. Enter your licence key again to move it to {view.host ?? "this address"}; it doesn't use
				another deployment.{" "}
				<a href="/settings/licence" className="whitespace-nowrap font-semibold underline underline-offset-2">
					Move licence
				</a>
			</p>
		</div>
	);
}

/** "Purchase details" link: the receipt and this licence's deployments, in the vendor's portal. */
export function ManageLink({ url }: { url?: string }) {
	if (!url) return null;
	return (
		<a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-text-primary underline-offset-2 hover:underline sm:min-h-0">
			<ExternalLink size={13} aria-hidden /> Purchase details
		</a>
	);
}
