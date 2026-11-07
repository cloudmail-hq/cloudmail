// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → Agent inboxes.
 *
 * Mailboxes minted for automated agents through `POST /api/v1/agent-inboxes`
 * (or the CLI / MCP). Lists them with purpose, send policy and time left, and
 * ends one early. Creating one happens from the API, CLI or MCP, because the
 * response carries the agent's token, which belongs with the agent.
 */

import { Bot, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "~/lib/toast";
import { useAgentInboxes, useEndAgentInbox } from "~/queries/agent-inboxes";
import { ApiError } from "~/services/api";
import { AGENT_SEND_MODE_LABELS, formatCountdown, type AgentInboxView } from "shared/agent-inboxes";
import { ConfirmDialog, ListRow, Pill, ROW_ICON_ACTION_CLASS, SECONDARY_BUTTON_CLASS, SectionHeading } from "./settings-ui";

/** Re-render every 30 s so the countdown moves without refetching. */
function useNow(intervalMs = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
	return now;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function remaining(inbox: AgentInboxView, now: number): number | null {
	return inbox.expires_at === null ? null : inbox.expires_at - now;
}

export default function AgentInboxesSettings() {
	const inboxes = useAgentInboxes();
	const end = useEndAgentInbox();
	const now = useNow();
	const [confirm, setConfirm] = useState<AgentInboxView | null>(null);

	const unavailable = inboxes.error instanceof ApiError && inboxes.error.status === 403;
	const list = inboxes.data ?? [];

	return (
		<section className="space-y-3">
			<SectionHeading icon={Bot} title="Agent inboxes" busy={inboxes.isFetching && !inboxes.isLoading} />

			<div className="space-y-4 rounded-[8px] bg-card p-4 ring-1 ring-border sm:p-5">
				<p className="text-sm text-text-secondary">
					Mailboxes created for automated agents, each with its own API token limited to that mailbox. When one
					expires or is revoked, its token stops working, its mail is archived to storage as an mbox file and
					the mailbox is deleted. Create them with <code className="font-mono text-xs">cloudmail agent-inbox create</code>,
					the API or the MCP <code className="font-mono text-xs">create_agent_inbox</code> tool.
				</p>

				{inboxes.isLoading ? (
					<div className="space-y-2" aria-busy="true" aria-label="Loading agent inboxes">
						{[0, 1].map((i) => (
							<div key={i} className="h-14 animate-pulse rounded-[6px] bg-bg-muted" />
						))}
					</div>
				) : unavailable ? (
					<p className="text-sm text-text-secondary">{(inboxes.error as ApiError).message}</p>
				) : inboxes.isError ? (
					<div className="flex items-center gap-3 text-sm text-text-secondary">
						Couldn't load agent inboxes.
						<button type="button" onClick={() => inboxes.refetch()} className={SECONDARY_BUTTON_CLASS}>
							Retry
						</button>
					</div>
				) : list.length === 0 ? (
					<p className="text-sm text-text-secondary">No agent inboxes yet.</p>
				) : (
					<ul className="space-y-2" aria-label="Agent inboxes">
						{list.map((inbox) => {
							const left = remaining(inbox, now);
							const expiring = left !== null && left < 60 * 60 * 1000;
							return (
								<ListRow
									key={inbox.address}
									icon={<Bot size={14} />}
									title={<span className="font-mono text-[13px]">{inbox.address}</span>}
									badges={
										<>
											<Pill tone={inbox.send_mode === "auto" ? "warning" : "muted"}>
												{AGENT_SEND_MODE_LABELS[inbox.send_mode]}
											</Pill>
											<Pill tone={expiring ? "warning" : "muted"}>
												<span aria-label={left === null ? "No expiry" : `Expires in ${formatCountdown(left)}`}>
													{left === null ? "No expiry" : left <= 0 ? "Expiring now" : `${formatCountdown(left)} left`}
												</span>
											</Pill>
										</>
									}
									details={[
										inbox.purpose,
										inbox.allowed_recipients ? `may send only to ${inbox.allowed_recipients.join(", ")}` : "may send to anyone",
										inbox.webhook_url ? `webhook ${hostOf(inbox.webhook_url)}` : null,
									]}
									actions={
										<button
											type="button"
											onClick={() => setConfirm(inbox)}
											className={ROW_ICON_ACTION_CLASS}
											aria-label={`Revoke ${inbox.address}`}
											title="Revoke and delete"
										>
											{end.isPending && end.variables === inbox.address ? (
												<Loader2 size={14} className="animate-spin" aria-hidden />
											) : (
												<Trash2 size={14} aria-hidden />
											)}
										</button>
									}
								/>
							);
						})}
					</ul>
				)}
			</div>

			<ConfirmDialog
				open={confirm !== null}
				onOpenChange={(o) => !o && setConfirm(null)}
				title={confirm ? `Revoke ${confirm.address}?` : "Revoke agent inbox?"}
				description="Its token stops working now, its webhook is removed, its mail is archived as an mbox file in storage, and the mailbox is deleted."
				confirmLabel="Revoke and delete"
				pending={end.isPending}
				onConfirm={async () => {
					if (!confirm) return;
					try {
						const ended = await end.mutateAsync(confirm.address);
						toast.success(
							ended.archive
								? `Ended ${ended.address}. ${ended.archive.messages} message(s) archived.`
								: `Ended ${ended.address}.`,
						);
						setConfirm(null);
					} catch (e) {
						toast.error(e instanceof ApiError ? e.message : "Couldn't end that agent inbox.");
					}
				}}
			/>
		</section>
	);
}
