// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Category and actor filters for the access logs. */

import { useEffect, useId, useState } from "react";
import { AUDIT_CATEGORY_OPTIONS } from "~/lib/audit-display";
import type { AuditFilter } from "~/services/api";

export default function AuditFilterBar({
	value,
	onChange,
}: {
	value: AuditFilter;
	onChange: (next: AuditFilter) => void;
}) {
	const id = useId();
	const [actor, setActor] = useState(value.actor ?? "");

	// Debounced, so typing does not fire a request per keystroke.
	useEffect(() => {
		const t = setTimeout(() => {
			const next = actor.trim() || undefined;
			if (next !== value.actor) onChange({ ...value, actor: next });
		}, 300);
		return () => clearTimeout(t);
	}, [actor]); // eslint-disable-line react-hooks/exhaustive-deps

	return (
		<div className="flex flex-wrap items-end gap-2">
			<label className="flex min-w-[10rem] flex-col gap-1 text-[11px] font-medium text-text-secondary" htmlFor={`${id}-cat`}>
				Show
				<select
					id={`${id}-cat`}
					value={value.category ?? ""}
					onChange={(e) =>
						onChange({ ...value, category: (e.target.value || undefined) as AuditFilter["category"] })
					}
					className="h-11 rounded-[6px] bg-card px-2 text-sm text-text-primary ring-1 ring-border focus:outline-none focus:ring-2 focus:ring-accent md:h-9"
				>
					{AUDIT_CATEGORY_OPTIONS.map((o) => (
						<option key={o.id} value={o.id}>
							{o.label}
						</option>
					))}
				</select>
			</label>
			<label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-[11px] font-medium text-text-secondary" htmlFor={`${id}-actor`}>
				Who or what
				<input
					id={`${id}-actor`}
					type="search"
					value={actor}
					onChange={(e) => setActor(e.target.value)}
					placeholder="Address, token or app"
					className="h-11 rounded-[6px] bg-card px-3 text-sm text-text-primary ring-1 ring-border focus:outline-none focus:ring-2 focus:ring-accent md:h-9"
				/>
			</label>
		</div>
	);
}
