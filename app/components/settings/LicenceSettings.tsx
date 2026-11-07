/**
 * Settings → Licence (admin). Status, plan and the date the current token
 * lapses without a refresh, a manage-purchase link, Check now and
 * Deactivate. One-time licences: there is no renewal date.
 */

import { BadgeCheck, Loader2, RefreshCw } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
	BUY_URL,
	LicenceGraceBanner,
	LicenceKeyForm,
	ManageLink,
	PAUSED_WHILE_LOCKED,
	PRODUCT_NAME,
	formatDay,
	statusLabel,
} from "~/components/licence/LicenceParts";
import { cn } from "~/lib/utils";
import { useDeactivateLicence, useLicence, useRefreshLicence } from "~/queries/licence";
import { authErrorMessage } from "~/services/auth-api";
import {
	DANGER_BUTTON_CLASS,
	InlineError,
	Pill,
	SECONDARY_BUTTON_CLASS,
	SectionHeading,
	SettingsField,
} from "./settings-ui";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
			<dt className="w-40 shrink-0 text-xs text-text-tertiary">{label}</dt>
			<dd className="min-w-0 break-words text-sm text-text-primary">{children}</dd>
		</div>
	);
}

export default function LicenceSettings() {
	const { data, isLoading, error: loadError } = useLicence();
	const refresh = useRefreshLicence();
	const deactivate = useDeactivateLicence();
	const [deactivating, setDeactivating] = useState(false);
	const [key, setKey] = useState("");
	const [error, setError] = useState<string | null>(null);

	async function submitDeactivate(e: FormEvent) {
		e.preventDefault();
		setError(null);
		try {
			await deactivate.mutateAsync(key.trim());
			setKey("");
			setDeactivating(false);
		} catch (err) {
			setError(authErrorMessage(err, "Couldn't deactivate."));
		}
	}

	const hasToken = !!data && data.status !== "none" && data.status !== "off";

	return (
		<section className="space-y-3">
			<SectionHeading icon={BadgeCheck} title="Licence" busy={isLoading} />
			<p className="text-sm text-text-secondary">
				{PRODUCT_NAME} is licensed per deployment, as a one-time purchase.
				{data && data.locked ? (
					<>
						{" "}
						<a href={BUY_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-2 hover:text-accent-hover sm:min-h-0">
							Buy a licence
						</a>
					</>
				) : null}
			</p>
			{loadError ? <InlineError message={authErrorMessage(loadError, "Couldn't load the licence.")} /> : null}
			{data ? <LicenceGraceBanner view={data} /> : null}

			{data ? (
				<div className="space-y-4 rounded-[8px] bg-card p-5 ring-1 ring-border">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm font-medium text-text-primary">{statusLabel(data)}</span>
						{data.locked ? <Pill tone="warning">App locked</Pill> : null}
					</div>

					{data.status === "off" ? (
						<p className="text-sm text-text-secondary">Licence enforcement is off on this deployment (LICENCE_ENFORCEMENT).</p>
					) : null}

					{data.locked ? <p className="text-sm text-text-secondary">{PAUSED_WHILE_LOCKED}</p> : null}

					{hasToken ? (
						<dl className="divide-y divide-border/60">
							{data.plan ? <Row label="Edition"><span className="capitalize">{data.plan.replace(/[-_]/g, " ")}</span></Row> : null}
							{data.customerEmail ? <Row label="Licensed to">{data.customerEmail}</Row> : null}
							{data.host ? <Row label="Bound to">{data.host}</Row> : null}
							{data.instances ? <Row label="Deployments allowed">{data.instances}</Row> : null}
							{data.expiresAt ? (
								<Row label="Works offline until">
									{formatDay(data.expiresAt)}
									<span className="block text-xs text-text-secondary">The app checks in daily and moves this date forward. Nothing to renew.</span>
								</Row>
							) : null}
							<Row label="Last checked">
								{formatDay(data.lastRefreshAt) ?? "Never"}
								{data.failureCount ? <span className="block text-xs text-warning-text">{data.failureCount} failed {data.failureCount === 1 ? "check" : "checks"} since.</span> : null}
							</Row>
							{data.serverReason ? <Row label="Licence server said">{data.serverReason}</Row> : null}
						</dl>
					) : null}

					{data.status !== "active" && data.status !== "grace" && data.status !== "off" ? <LicenceKeyForm /> : null}

					{hasToken ? (
						<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
							<button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending} className={cn(SECONDARY_BUTTON_CLASS, "min-h-11 sm:min-h-9")}>
								{refresh.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
								Check now
							</button>
							<ManageLink url={data.manageUrl} />
						</div>
					) : null}
					{hasToken && !deactivating ? (
						<div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
							<p className="text-xs text-text-secondary">Moving to another address or account? Deactivate here to free this deployment's slot first.</p>
							<button type="button" onClick={() => setDeactivating(true)} className={cn(DANGER_BUTTON_CLASS, "min-h-11 shrink-0 justify-center sm:min-h-9")}>
								Deactivate
							</button>
						</div>
					) : null}
					{refresh.error ? <InlineError message={authErrorMessage(refresh.error, "Couldn't check the licence.")} /> : null}

					{deactivating ? (
						<form onSubmit={submitDeactivate} className="space-y-3 rounded-[6px] bg-bg-subtle p-4 ring-1 ring-border">
							<p className="text-sm text-text-secondary">
								Deactivating frees this deployment's slot so you can use the licence elsewhere. This deployment locks straight away. Paste the licence key to confirm; it isn't stored.
							</p>
							<SettingsField label="Licence key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} disabled={deactivate.isPending} inputClassName="min-h-11 sm:min-h-9 font-mono" />
							<div className="flex flex-wrap gap-2">
								<button type="submit" disabled={deactivate.isPending || !key.trim()} className={cn(DANGER_BUTTON_CLASS, "min-h-11 sm:min-h-9")}>
									{deactivate.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
									Deactivate this deployment
								</button>
								<button type="button" onClick={() => { setDeactivating(false); setKey(""); setError(null); }} className={cn(SECONDARY_BUTTON_CLASS, "min-h-11 sm:min-h-9")}>
									Cancel
								</button>
							</div>
							<InlineError message={error} />
						</form>
					) : null}
				</div>
			) : null}
		</section>
	);
}
