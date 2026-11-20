/**
 * The one full-page screen a locked deployment shows: the key field for
 * admins, "Ask your admin" for everyone else. Rendered by the app shell in
 * place of every page except onboarding and Settings → Licence.
 */

import { KeyRound, LogOut } from "lucide-react";
import { LicenceKeyForm, PAUSED_WHILE_LOCKED, PRODUCT_NAME } from "./LicenceParts";
import type { LicenceResponse } from "~/queries/licence";

export function lockHeadline(view: Pick<LicenceResponse, "status">): string {
	switch (view.status) {
		case "revoked":
			return "This licence was revoked";
		case "expired":
			return "This licence has expired";
		case "invalid":
			return "This licence isn't valid here";
		default:
			return "Activate your licence";
	}
}

export default function LicenceLockScreen({ view, isAdmin, onSignOut }: { view: LicenceResponse; isAdmin: boolean; onSignOut?: () => void }) {
	return (
		<main className="flex min-h-[calc(100dvh-var(--app-topbar-h))] items-start justify-center px-4 py-10 sm:items-center sm:py-16">
			<div className="w-full max-w-md space-y-5 rounded-[10px] bg-card p-5 ring-1 ring-border sm:p-6">
				<div className="flex items-start gap-3">
					<span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent-subtle-fg">
						<KeyRound size={18} aria-hidden />
					</span>
					<div className="min-w-0">
						<h1 className="text-lg font-semibold text-text-primary">{lockHeadline(view)}</h1>
						<p className="mt-1 text-sm text-text-secondary">
							{isAdmin
								? `Paste the licence key from your ${PRODUCT_NAME} purchase email to unlock this deployment.`
								: `${PRODUCT_NAME} needs an active licence. Ask your admin to activate it.`}
						</p>
					</div>
				</div>
				<p className="rounded-[6px] bg-bg-subtle p-3 text-sm text-text-secondary ring-1 ring-border">{PAUSED_WHILE_LOCKED}</p>
				{isAdmin ? <LicenceKeyForm submitLabel="Activate licence" /> : null}
				{onSignOut ? (
					<div className="border-t border-border pt-3">
						<button type="button" onClick={onSignOut} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary sm:min-h-9">
							<LogOut size={14} aria-hidden /> Sign out
						</button>
					</div>
				) : null}
			</div>
		</main>
	);
}
