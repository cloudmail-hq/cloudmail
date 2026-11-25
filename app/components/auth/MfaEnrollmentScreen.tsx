/**
 * Shown in place of the app when the deployment requires two-factor and this
 * account has none (`mfaEnrollmentRequired` on /api/v1/me). The API refuses
 * everything but account security until then, so this is the one screen that
 * works. Either factor counts: an authenticator app or a passkey.
 */

import { LogOut, ShieldCheck } from "lucide-react";
import PasskeySettings from "~/components/settings/PasskeySettings";
import TwoFactorSettings from "~/components/settings/TwoFactorSettings";

export default function MfaEnrollmentScreen({ onSignOut }: { onSignOut?: () => void }) {
	return (
		<main className="flex min-h-[calc(100dvh-var(--app-topbar-h))] items-start justify-center px-4 py-10 sm:py-16">
			<div className="w-full max-w-xl space-y-5 rounded-[10px] bg-card p-5 ring-1 ring-border sm:p-6">
				<div className="flex items-start gap-3">
					<span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent-subtle-fg">
						<ShieldCheck size={18} aria-hidden />
					</span>
					<div className="min-w-0">
						<h1 className="text-lg font-semibold text-text-primary">Set up two-factor sign-in</h1>
						<p className="mt-1 text-sm text-text-secondary">
							Your organization requires a second step when you sign in. Add a passkey (your fingerprint, face or device
							PIN) or an authenticator app, and you'll go straight to your mail.
						</p>
					</div>
				</div>
				<section className="rounded-[8px] ring-1 ring-border">
					<PasskeySettings totpEnabled={false} canManage />
				</section>
				<section className="rounded-[8px] ring-1 ring-border">
					<TwoFactorSettings enabled={false} />
				</section>
				{onSignOut ? (
					<div className="border-t border-border pt-3">
						<button
							type="button"
							onClick={onSignOut}
							className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary sm:min-h-9"
						>
							<LogOut size={14} aria-hidden /> Sign out
						</button>
					</div>
				) : null}
			</div>
		</main>
	);
}
