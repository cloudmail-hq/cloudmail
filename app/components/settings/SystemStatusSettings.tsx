/** Settings → System status: the app version and the deployment checklist. */

import { useQuery } from "@tanstack/react-query";
import { Activity, CheckCircle2, CircleAlert, TriangleAlert } from "lucide-react";
import { request } from "~/services/api";
import { InlineError, SectionHeading } from "./settings-ui";

interface StatusCheck {
	id: string;
	label: string;
	ok: boolean;
	detail: string | null;
	required: boolean;
}

export default function SystemStatusSettings() {
	const status = useQuery({
		queryKey: ["system-status"],
		queryFn: ({ signal }) =>
			request<{ version: string; ok: boolean; checks: StatusCheck[] }>("/api/v1/system/status", { method: "GET", signal }),
		staleTime: 30_000,
	});

	return (
		<section className="space-y-3">
			<SectionHeading icon={Activity} title="System status" busy={status.isFetching} />
			<div className="space-y-4 rounded-[8px] bg-card p-5 ring-1 ring-border">
				{status.isError ? (
					<InlineError message="Couldn't load the status." />
				) : !status.data ? (
					<p className="text-sm text-text-tertiary">Checking…</p>
				) : (
					<>
						<p className="text-sm text-text-secondary">
							Version <span className="font-mono font-medium text-text-primary">{status.data.version}</span>
							{" · "}
							{status.data.ok ? "Everything required is working." : "Something required isn't working; see below."}
						</p>
						<ul className="divide-y divide-border/60 rounded-[6px] ring-1 ring-border">
							{status.data.checks.map((c) => (
								<li key={c.id} className="flex items-start gap-3 px-3 py-2.5 text-sm">
									{c.ok ? (
										<CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" aria-label="OK" />
									) : c.required ? (
										<CircleAlert size={16} className="mt-0.5 shrink-0 text-destructive" aria-label="Failing" />
									) : (
										<TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning-text" aria-label="Recommended" />
									)}
									<div className="min-w-0">
										<p className="font-medium text-text-primary">{c.label}</p>
										{c.detail ? <p className="mt-0.5 text-xs text-text-secondary">{c.detail}</p> : null}
									</div>
								</li>
							))}
						</ul>
						<p className="text-xs text-text-tertiary">
							Uptime monitors can poll <span className="font-mono">/api/v1/health</span>; it needs no sign-in and
							returns only the version.
						</p>
					</>
				)}
			</div>
		</section>
	);
}
