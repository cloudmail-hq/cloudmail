/**
 * Template body editing: the composer's rich editor, an HTML source view and a
 * preview with sample variables, plus chips that insert `{{variables}}`.
 *
 * Shared by the template editor page and the sequence editor's inline
 * "Create a template" dialog so both edit bodies the same way.
 */

import { Code, Eye, PenLine } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";
import EmailIframe from "~/components/EmailIframe";
import LazyEditor, { type EditorHandle } from "~/components/mail/LazyEditor";
import { insertVariableAt, needsHtmlMode, renderPreview, variableChips } from "~/lib/template-preview";
import { cn } from "~/lib/utils";

export type BodyMode = "rich" | "html" | "preview";

const TABS: { id: BodyMode; label: string; icon: typeof Code }[] = [
	{ id: "rich", label: "Rich text", icon: PenLine },
	{ id: "html", label: "HTML", icon: Code },
	{ id: "preview", label: "Preview", icon: Eye },
];

export default function TemplateBodyEditor({
	value,
	onChange,
	subject,
	variables,
	initialMode,
	minHeightClass = "min-h-[320px]",
}: {
	value: string;
	onChange: (html: string) => void;
	/** Shown above the preview with sample values filled in. */
	subject?: string;
	/** Variables used by the template so far (subject and body). */
	variables: string[];
	initialMode?: BodyMode;
	minHeightClass?: string;
}) {
	const [mode, setMode] = useState<BodyMode>(
		() => initialMode ?? (needsHtmlMode(value) ? "html" : "rich"),
	);
	const editorRef = useRef<EditorHandle | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const baseId = useId();
	const panelId = `${baseId}-panel`;
	const chips = variableChips(variables);

	const onReady = useCallback((handle: EditorHandle) => {
		editorRef.current = handle;
	}, []);

	const insertVariable = (name: string) => {
		if (mode === "rich") {
			editorRef.current?.insertText(`{{${name}}}`);
			return;
		}
		const el = textareaRef.current;
		const start = el?.selectionStart ?? value.length;
		const end = el?.selectionEnd ?? start;
		const next = insertVariableAt(value, name, start, end);
		onChange(next.text);
		requestAnimationFrame(() => {
			if (!el) return;
			el.focus();
			el.setSelectionRange(next.caret, next.caret);
		});
	};

	const onTabKey = (e: React.KeyboardEvent, index: number) => {
		if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
		e.preventDefault();
		const next = TABS[(index + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
		setMode(next.id);
		document.getElementById(`${baseId}-tab-${next.id}`)?.focus();
	};

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div role="tablist" aria-label="Body view" className="flex rounded-[6px] bg-bg-subtle p-0.5">
					{TABS.map((tab, i) => {
						const Icon = tab.icon;
						const active = mode === tab.id;
						return (
							<button
								key={tab.id}
								id={`${baseId}-tab-${tab.id}`}
								type="button"
								role="tab"
								aria-selected={active}
								aria-controls={panelId}
								tabIndex={active ? 0 : -1}
								onClick={() => setMode(tab.id)}
								onKeyDown={(e) => onTabKey(e, i)}
								className={cn(
									"flex min-h-11 items-center gap-1.5 rounded px-3 text-xs font-medium transition-colors sm:min-h-8",
									"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50",
									active ? "bg-card text-text-primary shadow-sm" : "text-text-secondary hover:text-text-primary",
								)}
							>
								<Icon size={14} aria-hidden />
								{tab.label}
							</button>
						);
					})}
				</div>
				{mode === "html" ? (
					<p className="text-xs text-text-tertiary">
						Switching to rich text may simplify custom HTML.
					</p>
				) : null}
			</div>

			{mode !== "preview" ? (
				<div className="flex flex-wrap items-center gap-1.5" aria-label="Insert a variable" role="group">
					<span className="text-xs text-text-tertiary">Insert</span>
					{chips.map((name) => (
						<button
							key={name}
							type="button"
							onClick={() => insertVariable(name)}
							aria-label={`Insert variable ${name}`}
							className="inline-flex min-h-11 items-center rounded-full bg-accent-subtle px-2.5 font-mono text-[11px] font-medium text-accent-subtle-fg hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50 sm:min-h-7"
						>
							{`{{${name}}}`}
						</button>
					))}
				</div>
			) : null}

			<div id={panelId} role="tabpanel" aria-labelledby={`${baseId}-tab-${mode}`}>
				{mode === "rich" ? (
					<LazyEditor
						value={value}
						onChange={onChange}
						onReady={onReady}
						ariaLabel="Template body"
						placeholder="Write the message. Use the chips above to add variables."
						className={minHeightClass}
					/>
				) : mode === "html" ? (
					<textarea
						ref={textareaRef}
						aria-label="Template body HTML"
						value={value}
						onChange={(e) => onChange(e.target.value)}
						spellCheck={false}
						placeholder="<p>Hi {{first_name}},</p>"
						className={cn(
							"w-full rounded-[8px] border border-border bg-card px-3 py-2 font-mono text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-violet/40",
							minHeightClass,
						)}
					/>
				) : (
					<div className={cn("overflow-hidden rounded-[8px] border border-border bg-card", minHeightClass)}>
						<div className="border-b border-border bg-bg-subtle/60 px-4 py-2.5">
							<p className="text-[11px] text-text-tertiary">Preview with sample values</p>
							{subject !== undefined ? (
								<p className="mt-0.5 text-sm font-semibold text-text-primary">
									{renderPreview(subject) || <span className="text-text-tertiary">(no subject)</span>}
								</p>
							) : null}
						</div>
						{/*
						  Template HTML is untrusted. EmailIframe sanitises it and
						  renders it in an opaque-origin sandbox.
						*/}
						<EmailIframe body={renderPreview(value, { html: true })} autoSize />
					</div>
				)}
			</div>
		</div>
	);
}
