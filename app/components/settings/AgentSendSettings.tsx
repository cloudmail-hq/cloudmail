// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Who may send from this mailbox without asking: the agent send policy.
 * See `shared/agent-send-policy.ts`. Saved with the rest of mailbox settings.
 */

import { useId, useState } from "react";
import { ShieldCheck, X } from "lucide-react";
import {
	AGENT_SEND_MODE_DESCRIPTIONS,
	AGENT_SEND_MODE_LABELS,
	AGENT_SEND_MODES,
	normalizeAllowlistEntry,
	type AgentSendMode,
} from "shared/agent-send-policy";

export interface AgentSendValue {
	mode: AgentSendMode;
	allowlist: string[];
}

export default function AgentSendSettings({
	value,
	onChange,
}: {
	value: AgentSendValue;
	onChange: (next: AgentSendValue) => void;
}) {
	const id = useId();
	const [entry, setEntry] = useState("");
	const [error, setError] = useState<string | null>(null);

	const add = () => {
		const normalized = normalizeAllowlistEntry(entry);
		if (!normalized) {
			setError("Enter an email address, or a domain like example.com.");
			return;
		}
		setError(null);
		setEntry("");
		if (!value.allowlist.includes(normalized)) onChange({ ...value, allowlist: [...value.allowlist, normalized] });
	};

	return (
		<section id="agent-sends" className="scroll-mt-20 rounded-[8px] border border-border bg-card p-5">
			<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
				<ShieldCheck size={16} className="text-accent" aria-hidden />
				Agent and MCP sends
			</h2>
			<p className="mt-1 text-sm text-text-secondary">
				Whether the assistant and MCP clients (Claude, Cursor, your own bots) can send mail from this mailbox. Mail you send
				yourself is never affected.
			</p>

			<fieldset className="mt-4 space-y-2">
				<legend className="sr-only">Send mode</legend>
				{AGENT_SEND_MODES.map((mode) => (
					<label
						key={mode}
						className="flex cursor-pointer items-start gap-3 rounded-[6px] px-2 py-2 ring-1 ring-transparent hover:bg-bg-muted has-[:checked]:bg-accent-subtle has-[:checked]:ring-accent/40 max-sm:min-h-11"
					>
						<input
							type="radio"
							name={`${id}-mode`}
							value={mode}
							checked={value.mode === mode}
							onChange={() => onChange({ ...value, mode })}
							className="mt-1 size-4 shrink-0 accent-accent"
						/>
						<span className="min-w-0">
							<span className="block text-sm font-medium text-text-primary">
								{AGENT_SEND_MODE_LABELS[mode]}
								{mode === "approve" ? <span className="ml-1.5 text-xs font-normal text-text-tertiary">(default)</span> : null}
							</span>
							<span className="block text-xs text-text-secondary">{AGENT_SEND_MODE_DESCRIPTIONS[mode]}</span>
						</span>
					</label>
				))}
			</fieldset>

			{value.mode !== "draft_only" ? (
				<div className="mt-5 space-y-2">
					<label htmlFor={`${id}-allow`} className="block text-sm font-medium text-text-primary">
						Send without approval to
					</label>
					<p className="text-xs text-text-secondary">
						Agent sends where every recipient is on this list go straight out. Use full addresses, or a domain for anyone
						there. Subdomains are not included.
					</p>
					<div className="flex gap-2">
						<input
							id={`${id}-allow`}
							value={entry}
							onChange={(e) => setEntry(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									add();
								}
							}}
							placeholder="team@example.com or example.com"
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? `${id}-allow-error` : undefined}
							className="h-11 min-w-0 flex-1 rounded-[6px] bg-card px-3 text-sm ring-1 ring-border focus:outline-none focus:ring-2 focus:ring-accent md:h-9"
						/>
						<button
							type="button"
							onClick={add}
							className="h-11 shrink-0 rounded-[6px] bg-card px-3 text-sm font-medium text-text-primary ring-1 ring-border hover:bg-bg-muted md:h-9"
						>
							Add
						</button>
					</div>
					{error ? (
						<p id={`${id}-allow-error`} className="text-xs text-destructive">
							{error}
						</p>
					) : null}
					{value.allowlist.length > 0 ? (
						<ul className="flex flex-wrap gap-1.5" aria-label="Allowed recipients">
							{value.allowlist.map((item) => (
								<li
									key={item}
									className="inline-flex items-center gap-1 rounded-full bg-bg-muted py-0.5 pl-2.5 pr-1 font-mono text-xs text-text-primary"
								>
									{item.startsWith("@") ? `anyone at ${item.slice(1)}` : item}
									<button
										type="button"
										onClick={() => onChange({ ...value, allowlist: value.allowlist.filter((a) => a !== item) })}
										aria-label={`Remove ${item}`}
										className="inline-flex size-6 items-center justify-center rounded-full text-text-tertiary hover:bg-bg-subtle hover:text-text-primary max-sm:size-9"
									>
										<X size={12} aria-hidden />
									</button>
								</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}
		</section>
	);
}
