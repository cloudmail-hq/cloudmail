// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** A dismissible pointer to guided setup while an admin has no active domain. */

import { Cloud, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useDomains } from "~/queries/domains";
import { useDashboardUser } from "~/queries/people";
import { ONBOARDING_DISMISS_KEY, shouldShowOnboardingBanner } from "./logic";

function readDismissed(): boolean {
	try {
		return localStorage.getItem(ONBOARDING_DISMISS_KEY) === "1";
	} catch {
		return false;
	}
}

export default function OnboardingBanner() {
	const isAdmin = useDashboardUser()?.role === "admin";
	const { data } = useDomains({ enabled: isAdmin });
	const [dismissed, setDismissed] = useState(() => typeof window !== "undefined" && readDismissed());
	if (!shouldShowOnboardingBanner({ isAdmin, dismissed, domains: data?.domains })) return null;
	return (
		<div className="mb-4 flex items-center gap-3 rounded-[8px] bg-accent-subtle px-3 py-2.5 text-sm text-accent-subtle-fg ring-1 ring-border">
			<Cloud size={16} className="shrink-0" aria-hidden />
			<p className="min-w-0 flex-1">
				Set up mail on your domain.{" "}
				<Link to="/onboarding" className="whitespace-nowrap font-semibold underline underline-offset-2">Start guided setup</Link>
			</p>
			<button
				type="button"
				onClick={() => {
					setDismissed(true);
					try {
						localStorage.setItem(ONBOARDING_DISMISS_KEY, "1");
					} catch {
						/* private mode: hide for this page only */
					}
				}}
				className="-m-2 inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
				aria-label="Dismiss guided setup"
			>
				<X size={15} aria-hidden />
			</button>
		</div>
	);
}
