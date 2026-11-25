/**
 * SPF/DKIM/DMARC verdict marker.
 *
 * Silent for verified and unknown senders on purpose: a badge on the
 * overwhelming majority of legitimate mail trains people to ignore it, which is
 * what would make the failure case useless when it actually matters.
 */

import { ShieldAlert, ShieldQuestion } from "lucide-react";
import {
	assessSenderTrust,
	extractAuthenticationResults,
	type SenderTrustLevel,
} from "../../../shared/auth-results";
import { Folders } from "../../../shared/folders";
import { cn } from "~/lib/utils";

/** Mail this app produced itself carries no receiving-MTA verdict. */
const OUTBOUND_FOLDERS = new Set<string>([Folders.SENT, Folders.DRAFT]);

interface SenderTrustBadgeProps {
	rawHeaders?: string | null;
	folderId?: string | null;
	variant?: "inline" | "banner";
	className?: string;
}

function isSilent(level: SenderTrustLevel): boolean {
	return level === "verified" || level === "unknown";
}

export default function SenderTrustBadge({
	rawHeaders,
	folderId,
	variant = "inline",
	className,
}: SenderTrustBadgeProps) {
	if (folderId && OUTBOUND_FOLDERS.has(folderId)) return null;

	const trust = assessSenderTrust(extractAuthenticationResults(rawHeaders));
	if (isSilent(trust.level)) return null;

	const isFailure = trust.level === "failed";

	if (variant === "banner") {
		if (!isFailure) return null;
		return (
			<div
				role="alert"
				className={cn(
					"flex items-start gap-2 rounded-[8px] border border-destructive/40 bg-destructive/[0.06] px-3 py-2",
					className,
				)}
			>
				<ShieldAlert
					size={15}
					className="mt-0.5 shrink-0 text-destructive"
					aria-hidden
				/>
				<div className="min-w-0">
					<p className="text-xs font-semibold text-destructive">
						This sender could not be verified
					</p>
					<p className="mt-0.5 text-xs font-light text-text-secondary">
						{trust.summary}
					</p>
				</div>
			</div>
		);
	}

	const Icon = isFailure ? ShieldAlert : ShieldQuestion;

	return (
		<span
			title={trust.summary}
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px] font-semibold",
				isFailure
					? "bg-destructive/10 text-destructive"
					: "bg-bg-muted text-text-secondary",
				className,
			)}
		>
			<Icon size={10} aria-hidden />
			{isFailure ? "Unverified" : "Unconfirmed"}
		</span>
	);
}
