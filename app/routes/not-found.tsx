// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Link, useLocation } from "react-router";
import { Compass } from "lucide-react";
import DashboardLayout from "~/components/DashboardLayout";
import { EmptyState, PageContainer } from "~/components/ui/page";

/**
 * Unknown path. Rendered inside the normal app chrome, so the top bar is still
 * there to get back to work from.
 */
export default function NotFoundRoute() {
	const { pathname } = useLocation();

	return (
		<DashboardLayout>
			<PageContainer>
				<EmptyState
					icon={<Compass />}
					title="Page not found"
					description={
						<>
							There's nothing at{" "}
							<code className="break-all rounded bg-bg-subtle px-1 font-mono text-[12px]">
								{pathname}
							</code>{". Check the link, or head back to your mail."}
						</>
					}
					action={
						<div className="flex flex-wrap justify-center gap-2">
							<Link
								to="/"
								className="inline-flex h-9 items-center rounded-[6px] bg-accent px-4 text-sm font-semibold text-accent-foreground hover:bg-accent-hover touch:h-11"
							>
								Go to inbox
							</Link>
							<Link
								to="/people"
								className="inline-flex h-9 items-center rounded-[6px] px-4 text-sm font-medium text-text-secondary ring-1 ring-border hover:bg-bg-muted hover:text-text-primary touch:h-11"
							>
								People
							</Link>
						</div>
					}
				/>
			</PageContainer>
		</DashboardLayout>
	);
}
