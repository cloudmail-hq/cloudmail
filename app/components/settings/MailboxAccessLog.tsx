// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * What has been done *in this mailbox*, and by whom.
 *
 * The deployment-wide log in **Settings → Access log** covers grants and mailbox
 * lifecycle. This covers the mailbox's own activity — sends, deletions, settings
 * changes — which is where the question that motivates the whole log actually
 * lands: a delegated send carries the *mailbox's* address in `From:`, so "who sent
 * that as us" is not answerable from the mail itself.
 *
 * `actorRole` leads each row rather than being a detail, because it is the thing
 * worth scanning for. An owner acting in their own mailbox is unremarkable; a
 * delegate or an administrator acting in someone else's is the entry an operator is
 * looking for, and spotting it should not require reading an address and
 * remembering whose mailbox this is.
 *
 * Renders nothing at all for a caller who lacks `manageSettings` here. The Worker
 * refuses them with a 403 regardless — the gate is the boundary, this is only
 * courtesy — but an error panel on a page they can otherwise use would read as a
 * fault rather than as "not your business".
 */

import { useState } from "react";
import { History, Loader2 } from "lucide-react";
import AuditFilterBar from "~/components/settings/AuditFilterBar";
import { AUDIT_ACTION_LABELS, describeAuditDetail } from "~/lib/audit-display";
import { useMailboxAudit } from "~/queries/access";
import { ApiError, type AuditFilter } from "~/services/api";

/**
 * How the actor stood to this mailbox.
 *
 * `owner` is deliberately unstyled: it is the ordinary case, and colouring every
 * row would leave nothing standing out. The other three mean somebody reached into
 * a mailbox that was not theirs.
 */
const ACTOR_ROLE_STYLES: Record<string, string> = {
	owner: "bg-bg-muted text-text-tertiary",
	delegate: "bg-warning-bg text-warning-text",
	admin: "bg-destructive-subtle text-destructive",
	system: "bg-bg-muted text-text-tertiary",
};

export default function MailboxAccessLog({ mailboxId }: { mailboxId: string }) {
	const [filter, setFilter] = useState<AuditFilter>({});
	const { data, isLoading, error } = useMailboxAudit(mailboxId, { filter });

	// Not permitted to see it: say nothing rather than showing a failure.
	if (error instanceof ApiError && error.status === 403) return null;

	return (
		<section className="rounded-[10px] border border-border bg-card p-4">
			<div className="mb-3 flex items-start gap-2">
				<History size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
				<div>
					<h2 className="text-sm font-semibold text-text-primary">Access log</h2>
					<p className="text-xs text-text-secondary">
						Sends, deletions, settings changes, and every agent or MCP action in this mailbox,
						with the token or app that did it. Sign-ins and grants are in Settings → Access log.
					</p>
				</div>
			</div>
			<div className="mb-3">
				<AuditFilterBar value={filter} onChange={setFilter} />
			</div>

			{isLoading ? (
				<div className="flex items-center gap-2 text-sm text-text-secondary">
					<Loader2 size={13} className="animate-spin" aria-hidden />
					Loading…
				</div>
			) : null}

			{error && !(error instanceof ApiError && error.status === 403) ? (
				<p className="text-xs text-destructive">Couldn't load the access log.</p>
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
								{detail ? (
									<span className="text-xs text-text-tertiary">
										{detail}
									</span>
								) : null}
								<time
									dateTime={new Date(entry.at * 1000).toISOString()}
									className="ml-auto shrink-0 text-xs text-text-tertiary"
								>
									{new Date(entry.at * 1000).toLocaleString()}
								</time>
							</li>
						);
					})}
				</ul>
			) : null}
		</section>
	);
}
