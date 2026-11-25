/**
 * Reader warnings for a received message: lookalike domains, display-name
 * spoofing, links whose text and destination disagree, and first contact.
 *
 * The serious three get a `role="alert"` banner, because they describe the
 * moment someone is being deceived. First contact on its own is not alarming
 * (most first messages are legitimate), so it is a quiet note, and it joins
 * the banner when something else is also wrong, which is when it matters.
 *
 * The detection is server-side (`shared/sender-warnings.ts`), computed at
 * delivery and stored with the message; this only presents it.
 */

import { AlertTriangle, Info, ShieldAlert } from "lucide-react";
import {
	isSeriousWarning,
	parseSenderWarnings,
	type SenderWarning,
} from "shared/sender-warning-types";
import { Folders } from "shared/folders";
import { cn } from "~/lib/utils";

const OUTBOUND = new Set<string>([Folders.SENT, Folders.DRAFT, Folders.SCHEDULED]);

const TITLES: Record<SenderWarning["kind"], string> = {
	lookalike_domain: "Look-alike domain",
	display_name_spoof: "Name does not match the address",
	link_mismatch: "Link goes somewhere else",
	first_time_sender: "First message from this sender",
};

/** Warnings for a row, from the parsed field or the stored JSON. */
export function emailWarnings(email: {
	folder_id?: string | null;
	warnings?: SenderWarning[];
	security_warnings?: string | null;
}): SenderWarning[] {
	if (email.folder_id && OUTBOUND.has(email.folder_id)) return [];
	return email.warnings ?? parseSenderWarnings(email.security_warnings);
}

export default function SecurityWarnings({
	warnings,
	className,
}: {
	warnings: SenderWarning[];
	className?: string;
}) {
	if (warnings.length === 0) return null;
	const serious = warnings.filter((w) => isSeriousWarning(w.kind));

	if (serious.length === 0) {
		return (
			<p
				className={cn(
					"flex items-center gap-1.5 text-xs font-light text-text-secondary",
					className,
				)}
			>
				<Info size={13} className="shrink-0 text-text-tertiary" aria-hidden />
				{warnings[0]!.message}
			</p>
		);
	}

	return (
		<div
			role="alert"
			className={cn(
				"flex items-start gap-2 rounded-[8px] border border-warning-border bg-warning-bg px-3 py-2",
				className,
			)}
		>
			<ShieldAlert size={15} className="mt-0.5 shrink-0 text-warning-text" aria-hidden />
			<div className="min-w-0 space-y-1">
				<p className="text-xs font-semibold text-text-primary">
					Be careful with this message
				</p>
				<ul className="space-y-0.5">
					{warnings.map((w) => (
						<li key={w.kind} className="text-xs text-text-primary">
							<span className="font-medium text-text-primary">{TITLES[w.kind]}:</span>{" "}
							{w.message}
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

/** The list-row marker: only for the serious kinds. */
export function SecurityWarningIcon({
	email,
	className,
}: {
	email: Parameters<typeof emailWarnings>[0];
	className?: string;
}) {
	const serious = emailWarnings(email).filter((w) => isSeriousWarning(w.kind));
	if (serious.length === 0) return null;
	const label = `Warning: ${serious.map((w) => TITLES[w.kind].toLowerCase()).join(", ")}`;
	return (
		<span title={serious.map((w) => w.message).join("\n")} className={cn("inline-flex shrink-0", className)}>
			<AlertTriangle size={13} className="text-warning-text" aria-hidden />
			<span className="sr-only">{label}</span>
		</span>
	);
}
