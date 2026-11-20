/**
 * Gmail-style "•••" control that reveals the quote chain a sender appended to
 * their reply.
 *
 * Collapsed by default so a thread reads as a timeline. Without it every
 * message carries a copy of the whole conversation, so the same text appears
 * once per message and a long thread looks like it is repeating itself.
 *
 * This replaces the earlier `email-panel/QuotedContentToggle`, which was built
 * on `@cloudflare/kumo`. That package is no longer a dependency, so the control
 * is rebuilt here against the same design tokens the rest of the reading pane
 * uses.
 */

import { useState } from "react";
import EmailIframe from "~/components/EmailIframe";
import { cn } from "~/lib/utils";

interface QuotedTextProps {
	/** The trailing quote chain, already sanitised for rendering. */
	quotedBody: string;
	/** Used for the accessible label, e.g. "Show quoted text included by You". */
	senderLabel?: string;
	/** Passed through so the quote honours the reader's remote-image choice. */
	allowRemoteImages?: boolean;
}

export default function QuotedText({
	quotedBody,
	senderLabel,
	allowRemoteImages,
}: QuotedTextProps) {
	const [isOpen, setIsOpen] = useState(false);

	return (
		<div className="mt-3">
			<button
				type="button"
				onClick={() => setIsOpen((open) => !open)}
				aria-expanded={isOpen}
				title={isOpen ? "Hide quoted text" : "Show quoted text"}
				aria-label={
					isOpen
						? "Hide quoted text"
						: `Show quoted text${senderLabel ? ` included by ${senderLabel}` : ""}`
				}
				className={cn(
					"flex h-[18px] items-center rounded-[6px] px-2 text-xs leading-none tracking-widest transition-colors",
					isOpen
						? "bg-violet/15 text-violet"
						: "bg-bg-muted text-text-tertiary hover:bg-bg-subtle hover:text-text-secondary",
				)}
			>
				•••
			</button>

			{isOpen && (
				<div className="mt-2 overflow-hidden rounded-r-[8px] border-l-2 border-border bg-bg-subtle/40">
					<EmailIframe
						body={quotedBody}
						autoSize
						allowRemoteImages={allowRemoteImages}
						padding="12px 16px"
					/>
				</div>
			)}
		</div>
	);
}
