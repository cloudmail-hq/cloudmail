/**
 * The `;` snippet picker: a listbox anchored at the caret.
 *
 * Focus never leaves the editor. Arrow keys and Enter arrive through the
 * suggestion plugin's key handler, and the editor element carries
 * `aria-activedescendant` pointing at the highlighted option, which is the
 * pattern ARIA describes for a combobox whose text field keeps focus.
 */

import { createPortal } from "react-dom";
import { FileText } from "lucide-react";
import { cn } from "~/lib/utils";
import type { SnippetTemplate } from "~/lib/snippets";

export const SNIPPET_LISTBOX_ID = "composer-snippet-listbox";
export const snippetOptionId = (index: number) => `composer-snippet-option-${index}`;

/** Strip tags for a one-line preview. Display only; React escapes it. */
function previewText(html: string): string {
	return html
		.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 90);
}

export default function SnippetMenu({
	items,
	activeIndex,
	query,
	rect,
	onHover,
	onPick,
}: {
	items: SnippetTemplate[];
	activeIndex: number;
	query: string;
	rect: DOMRect | null;
	onHover: (index: number) => void;
	onPick: (template: SnippetTemplate) => void;
}) {
	if (typeof document === "undefined" || !rect) return null;

	// Below the caret, flipped above when there isn't room; clamped sideways.
	// Full width (less a margin) on a phone, where the caret can be anywhere.
	const narrow = window.innerWidth < 640;
	const width = narrow ? window.innerWidth - 16 : Math.min(320, window.innerWidth - 16);
	const left = narrow ? 8 : Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
	const spaceBelow = window.innerHeight - rect.bottom;
	const above = spaceBelow < 240 && rect.top > spaceBelow;
	const style: React.CSSProperties = above
		? { left, width, bottom: window.innerHeight - rect.top + 6 }
		: { left, width, top: rect.bottom + 6 };

	return createPortal(
		<div
			// Above the composer window (z-50) and its fullscreen scrim.
			className="fixed z-[70] overflow-hidden rounded-[10px] border border-border bg-card shadow-lg ring-1 ring-black/5"
			style={style}
			// Clicking an option must not blur the editor.
			onMouseDown={(event) => event.preventDefault()}
		>
			<div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-text-secondary">
				<span>Templates{query ? ` matching “${query}”` : ""}</span>
				<span aria-hidden className="touch:hidden">↑↓ · Enter</span>
			</div>
			{items.length === 0 ? (
				<p className="px-3 py-3 text-xs text-text-secondary">
					No template matches. Keep typing, or press Escape.
				</p>
			) : (
				<ul
					id={SNIPPET_LISTBOX_ID}
					role="listbox"
					aria-label="Templates"
					className="max-h-64 overflow-y-auto py-1"
				>
					{items.map((template, index) => (
						<li
							key={template.slug}
							id={snippetOptionId(index)}
							role="option"
							aria-selected={index === activeIndex}
							onMouseEnter={() => onHover(index)}
							onClick={() => onPick(template)}
							className={cn(
								"flex cursor-pointer items-start gap-2 px-3 py-2 touch:min-h-11",
								index === activeIndex
									? "bg-accent-subtle shadow-[inset_3px_0_0_var(--color-accent)]"
									: "hover:bg-bg-muted",
							)}
						>
							<FileText
								size={14}
								className="mt-0.5 shrink-0 text-text-tertiary"
								aria-hidden
							/>
							<span className="min-w-0 flex-1">
								<span
									className={cn(
										"block truncate text-[13px] font-medium",
										index === activeIndex ? "text-accent-subtle-fg" : "text-text-primary",
									)}
								>
									{template.name}
									<span className="ml-1.5 font-mono text-[11px] font-normal text-text-secondary">
										;{template.slug}
									</span>
								</span>
								<span className="block truncate text-xs text-text-secondary">
									{previewText(template.bodyHtml) || template.subject}
								</span>
							</span>
						</li>
					))}
				</ul>
			)}
		</div>,
		document.body,
	);
}
