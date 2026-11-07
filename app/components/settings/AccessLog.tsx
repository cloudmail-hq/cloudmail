// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * What has been done, and by whom.
 *
 * Delegated access is only half a feature without this: once someone other than
 * the owner can send from a mailbox, the message itself carries the mailbox's
 * address, so "who sent that as us" is not answerable from the mail. The log is.
 *
 * The actor's *relationship* to the mailbox leads each row rather than being a
 * detail, because that is the thing worth scanning for. An owner acting in their
 * own mailbox is unremarkable; a delegate or an administrator acting in someone
 * else's is the entry an operator is looking for, and it should not require
 * reading an address and remembering whose mailbox it is.
 */

import { useState } from "react";
import { History, Loader2 } from "lucide-react";
import AuditFilterBar from "~/components/settings/AuditFilterBar";
import { AUDIT_ACTION_LABELS, describeAuditDetail } from "~/lib/audit-display";
import { useAccessAudit } from "~/queries/access";
import type { AuditFilter } from "~/services/api";

/**
 * How the actor stood to the mailbox.
 *
 * `owner` is deliberately unstyled: it is the ordinary case, and colouring every
 * row would leave nothing standing out. The other three are the ones that mean
 * somebody reached into a mailbox that was not theirs.
 */
const ACTOR_ROLE_STYLES: Record<string, string> = {
	owner: "bg-bg-muted text-text-tertiary",
	delegate: "bg-warning-bg text-warning-text",
	admin: "bg-destructive-subtle text-destructive",
	system: "bg-bg-muted text-text-tertiary",
};

function formatWhen(at: number): string {
	// Local time, since the reader is an operator looking at their own deployment.
	return new Date(at * 1000).toLocaleString();
}

export default function AccessLog({ enabled = true }: { enabled?: boolean }) {
	const [filter, setFilter] = useState<AuditFilter>({});
	const { data, isLoading, isError, refetch } = useAccessAudit({ enabled, filter });

	return (
		<section className="space-y-3">
			<div className="flex items-center gap-2">
				<History size={14} className="text-text-tertiary" />
				<h2 className="text-base font-semibold text-text-primary">Access log</h2>
			</div>

			<div className="space-y-4 rounded-[8px] bg-card p-5 ring-1 ring-border">
				<p className="text-sm text-text-secondary">
					Sign-ins, security changes, tokens and connected apps, grants, and mailboxes created or
					deleted. Each mailbox's own activity (sends, agent actions, approvals) is on its settings page.
				</p>
				<AuditFilterBar value={filter} onChange={setFilter} />

				{isLoading ? (
					<div className="flex items-center gap-2 text-sm text-text-secondary">
						<Loader2 size={13} className="animate-spin" aria-hidden />
						Loading the log…
					</div>
				) : null}

				{isError ? (
					<div className="space-y-2">
						<p className="text-xs text-destructive">Couldn't load the access log.</p>
						<button
							type="button"
							onClick={() => refetch()}
							className="rounded-[6px] bg-bg-muted px-2.5 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-subtle"
						>
							Try again
						</button>
					</div>
				) : null}

				{data && data.length === 0 ? (
					<p className="rounded-[6px] bg-bg-subtle px-3 py-2.5 text-sm text-text-secondary">
						Nothing recorded yet.
					</p>
				) : null}

				{data && data.length > 0 ? (
					<ul className="space-y-1.5">
						{data.map((entry) => {
							const detail = describeAuditDetail(entry);
							return (
								<li
									key={entry.id}
									className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 rounded-[6px] bg-bg-subtle px-3 py-2"
								>
									<span
										className={`shrink-0 rounded-[4px] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
											ACTOR_ROLE_STYLES[entry.actorRole] ?? ACTOR_ROLE_STYLES.system
										}`}
									>
										{entry.actorRole}
									</span>
									<span className="truncate font-mono text-xs text-text-primary">
										{entry.actor ?? "system"}
									</span>
									<span className="text-sm text-text-secondary">
										{AUDIT_ACTION_LABELS[entry.action] ?? entry.action}
									</span>
									{entry.target ? (
										<span className="truncate font-mono text-[11px] text-text-secondary">
											{entry.target}
										</span>
									) : null}
									{entry.mailboxId ? (
										<span className="truncate font-mono text-[11px] text-text-tertiary">
											in {entry.mailboxId}
										</span>
									) : null}
									{detail ? (
										<span className="text-xs text-text-tertiary">
											{detail}
										</span>
									) : null}
									<time
										dateTime={new Date(entry.at * 1000).toISOString()}
										className="ml-auto shrink-0 text-xs text-text-tertiary"
									>
										{formatWhen(entry.at)}
									</time>
								</li>
							);
						})}
					</ul>
				) : null}
			</div>
		</section>
	);
}
