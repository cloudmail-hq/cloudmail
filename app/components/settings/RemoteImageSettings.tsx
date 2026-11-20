// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The senders whose remote images are allowed to load without asking.
 *
 * The reading pane can add to this list from the blocked-images banner, but a
 * list that can only be added to from a transient banner is a list nobody can
 * audit: the reader has no way to see what they have accumulated, and no way to
 * withdraw a rule once the message that created it has scrolled away. This is
 * that view — add, edit, remove.
 *
 * Saves itself rather than joining the page's Save button, because the store is
 * `localStorage` and not part of the mailbox settings blob.
 */

import { useState } from "react";
import { Check, Image as ImageIcon, Pencil, Trash2, X } from "lucide-react";
import { useRemoteImageStore } from "~/hooks/useRemoteImageStore";
import {
	describePattern,
	normalizeRemoteImagePattern,
} from "~/lib/remote-images";
import { showToast } from "~/lib/toast";

export default function RemoteImageSettings() {
	const trustedSenders = useRemoteImageStore((s) => s.trustedSenders);
	const add = useRemoteImageStore((s) => s.add);
	const remove = useRemoteImageStore((s) => s.remove);
	const replace = useRemoteImageStore((s) => s.replace);
	const clear = useRemoteImageStore((s) => s.clear);

	const [draft, setDraft] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");

	const submitNew = (event: React.FormEvent) => {
		event.preventDefault();
		const normalized = normalizeRemoteImagePattern(draft);
		// Validated here as well as in the store: the store silently ignores bad
		// input, which is the right behaviour for a programmatic call from the
		// banner but reads as a broken form when someone typed it.
		if (!normalized) {
			showToast({
				kind: "error",
				message: "Enter an address like sam@example.com, or @example.com.",
			});
			return;
		}
		if (trustedSenders.includes(normalized)) {
			showToast({ kind: "info", message: `${normalized} is already on the list.` });
			setDraft("");
			return;
		}
		add(normalized);
		setDraft("");
	};

	const commitEdit = (original: string) => {
		const normalized = normalizeRemoteImagePattern(editValue);
		if (!normalized) {
			showToast({
				kind: "error",
				message: "Enter an address like sam@example.com, or @example.com.",
			});
			return;
		}
		replace(original, normalized);
		setEditing(null);
		setEditValue("");
	};

	return (
		<section className="rounded-[10px] border border-border bg-card p-4">
			<div className="mb-3 flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="flex items-center gap-1.5 text-sm font-bold text-text-primary">
						<ImageIcon size={14} className="text-text-tertiary" />
						Remote images
					</h2>
					<p className="mt-1 text-sm text-text-secondary">
						Remote images are blocked by default so senders can’t use them to
						track when you open a message. Images load without asking for the
						senders listed here. Use <code>@example.com</code> to trust a whole
						domain.
					</p>
				</div>
				{trustedSenders.length > 0 && (
					<button
						type="button"
						onClick={() => {
							if (
								!window.confirm(
									"Block remote images from every sender again? You can add senders back at any time.",
								)
							)
								return;
							clear();
						}}
						className="shrink-0 rounded-[6px] border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-muted"
					>
						Clear all
					</button>
				)}
			</div>

			<form className="mb-3 flex items-center gap-1.5" onSubmit={submitNew}>
				<input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="news@example.com or @example.com"
					aria-label="Address or domain to always show images from"
					className="min-w-0 h-9 flex-1 rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15"
				/>
				<button
					type="submit"
					disabled={!draft.trim()}
					className="inline-flex h-9 shrink-0 items-center rounded-[6px] bg-accent px-3.5 text-[13px] font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
				>
					Add
				</button>
			</form>

			<ul className="space-y-1.5">
				{trustedSenders.map((pattern) => (
					<li
						key={pattern}
						className="flex items-center gap-2 rounded-[6px] border border-border bg-bg-subtle/50 px-2.5 py-1.5"
					>
						{editing === pattern ? (
							<>
								<input
									value={editValue}
									onChange={(e) => setEditValue(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											commitEdit(pattern);
										}
										if (e.key === "Escape") setEditing(null);
									}}
									aria-label={`Edit ${pattern}`}
									// Focused on appearance: this input replaces the row the user
									// just clicked Edit on, so it is the thing they asked for.
									// Without it, editing takes a second click to reach the field.
									autoFocus
									className="min-w-0 flex-1 rounded-[6px] border border-border bg-card px-2 py-1 font-mono text-[11px] text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15"
								/>
								<button
									type="button"
									onClick={() => commitEdit(pattern)}
									aria-label={`Save changes to ${pattern}`}
									className="shrink-0 rounded-[6px] p-1 text-text-secondary hover:bg-bg-muted hover:text-text-primary"
								>
									<Check size={13} />
								</button>
								<button
									type="button"
									onClick={() => setEditing(null)}
									aria-label="Cancel editing"
									className="shrink-0 rounded-[6px] p-1 text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
								>
									<X size={13} />
								</button>
							</>
						) : (
							<>
								<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">
									{pattern}
								</span>
								{pattern.startsWith("@") && (
									<span className="shrink-0 rounded-[4px] bg-bg-muted px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary">
										Whole domain
									</span>
								)}
								<button
									type="button"
									onClick={() => {
										setEditing(pattern);
										setEditValue(pattern);
									}}
									aria-label={`Edit ${pattern}`}
									className="shrink-0 rounded-[6px] p-1 text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
								>
									<Pencil size={13} />
								</button>
								<button
									type="button"
									onClick={() => remove(pattern)}
									aria-label={`Stop showing images from ${describePattern(pattern)}`}
									className="shrink-0 rounded-[6px] p-1 text-text-tertiary hover:bg-destructive/10 hover:text-destructive"
								>
									<Trash2 size={13} />
								</button>
							</>
						)}
					</li>
				))}
				{trustedSenders.length === 0 && (
					<li className="text-sm text-text-tertiary">
						No senders trusted yet. Open a message with blocked images and choose
						“Always show images from…”.
					</li>
				)}
			</ul>

			{/*
			  Said plainly rather than left to be discovered: loading a remote image
			  discloses this device's IP and the fact the message was opened here, so
			  the list is per-browser on purpose. A reader who expects it to sync
			  would otherwise read the empty list on their laptop as data loss.
			*/}
			<p className="mt-3 text-xs text-text-tertiary">
				This list is stored in this browser and applies to every mailbox you
				read here. It doesn’t sync to other devices.
			</p>
		</section>
	);
}
