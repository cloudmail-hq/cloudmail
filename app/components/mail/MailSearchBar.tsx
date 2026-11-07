/**
 * The mailbox search field, and the panel that builds a query for you.
 *
 * Search lives in the top bar rather than above the message list. It used to sit
 * in a workspace toolbar of its own, which cost every folder view a 40px strip
 * for a control that is used occasionally — and put the search box below the
 * application chrome, which is the one place no other mail client puts it.
 *
 * The panel writes the same `from:` / `is:` / `has:` syntax that can be typed by
 * hand and that `shared/search-query.ts` already parses, rather than a parallel
 * set of query parameters. That is deliberate: the operators are the API, so
 * anything the panel can express is also something the reader can type, edit in
 * the field afterwards, or keep in a bookmark.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { looksLikeQuestion, questionText } from "shared/semantic";
import { cn } from "~/lib/utils";
import type { Folder } from "~/types";

interface MailSearchBarProps {
	/** Current query, so the field survives a reload of the results page. */
	value: string;
	onChange: (value: string) => void;
	onSubmit: (query: string) => void;
	/** Folders offered in the "Search in" list, plus the two built-in scopes. */
	folders?: Folder[];
	inputRef?: React.RefObject<HTMLInputElement | null>;
	className?: string;
	/**
	 * "Ask my inbox". When set, text that reads as a question (or starts with
	 * `?`) offers "Ask: …" under the field; a `?`-prefixed query asks on Enter.
	 */
	onAsk?: (question: string) => void;
	/** What the field searches, for the placeholder and the accessible name. */
	placeholder?: string;
	/** Opens the command palette from the ⌘K hint at the end of the field. */
	onOpenPalette?: () => void;
	/**
	 * A short scope label shown inside the field ("This mailbox"). With it the
	 * placeholder is a plain "Search", which never truncates on a phone.
	 */
	scopeChip?: string;
	/**
	 * Makes the scope chip a selector over these scopes. A disabled option is
	 * listed but cannot be chosen (outside a mailbox there is no "this" one).
	 */
	scopes?: { value: string; label: string; disabled?: boolean }[];
	scopeValue?: string;
	onScopeChange?: (value: string) => void;
}

/** The panel's fields, before they become a query string. */
interface AdvancedForm {
	from: string;
	to: string;
	subject: string;
	includes: string;
	excludes: string;
	folder: string;
	size: string;
	age: string;
	hasAttachment: boolean;
	unreadOnly: boolean;
	starredOnly: boolean;
}

const EMPTY_FORM: AdvancedForm = {
	from: "",
	to: "",
	subject: "",
	includes: "",
	excludes: "",
	folder: "",
	size: "",
	age: "",
	hasAttachment: false,
	unreadOnly: false,
	starredOnly: false,
};

/**
 * Quote a value that would otherwise be read as several terms.
 *
 * `from:John Doe` parses as `from:John` AND the word `Doe`, which is a different
 * and much broader search than the one that was asked for. The tokenizer accepts
 * a quoted value straight after the colon, so anything with whitespace gets
 * quotes; an embedded quote is dropped rather than escaped, because the grammar
 * has no escape sequence and a stray one would swallow the rest of the query.
 */
function operand(value: string): string {
	const trimmed = value.trim().replace(/"/g, "");
	return /\s/.test(trimmed) ? `"${trimmed}"` : trimmed;
}

/** Turn the panel's fields into the query a person would have typed. */
export function buildAdvancedQuery(form: AdvancedForm): string {
	const parts: string[] = [];

	if (form.from.trim()) parts.push(`from:${operand(form.from)}`);
	if (form.to.trim()) parts.push(`to:${operand(form.to)}`);
	if (form.subject.trim()) parts.push(`subject:${operand(form.subject)}`);
	if (form.folder) parts.push(`in:${form.folder}`);
	if (form.hasAttachment) parts.push("has:attachment");
	if (form.unreadOnly) parts.push("is:unread");
	if (form.starredOnly) parts.push("is:starred");
	if (form.age) parts.push(`newer_than:${form.age}`);
	if (form.size) parts.push(`larger:${form.size}`);

	// Free text last, so the operators read first when the query lands back in
	// the field. A phrase stays a phrase; single words are left bare so the
	// reader can still edit them without deleting quotes.
	if (form.includes.trim()) parts.push(operand(form.includes));

	/*
	 * Every excluded word is negated on its own. `-"a b"` excludes the phrase
	 * "a b" and would still return a message containing only `a`, which is not
	 * what "doesn't have" means to anyone typing two words into that box.
	 */
	for (const word of form.excludes.trim().split(/\s+/).filter(Boolean)) {
		parts.push(`-${operand(word)}`);
	}

	return parts.join(" ");
}

const AGE_OPTIONS: { value: string; label: string }[] = [
	{ value: "", label: "any time" },
	{ value: "1d", label: "past day" },
	{ value: "7d", label: "past week" },
	{ value: "1m", label: "past month" },
	{ value: "6m", label: "past 6 months" },
	{ value: "1y", label: "past year" },
];

const SIZE_OPTIONS: { value: string; label: string }[] = [
	{ value: "", label: "any size" },
	{ value: "1m", label: "over 1 MB" },
	{ value: "5m", label: "over 5 MB" },
	{ value: "10m", label: "over 10 MB" },
];

function fieldLabel(text: string) {
	return (
		<span className="text-[11px] font-semibold text-text-tertiary">{text}</span>
	);
}

const INPUT_CLASS =
	"h-7 w-full rounded-[6px] border border-border bg-card px-2 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:ring-2 focus:ring-text-primary/15";

export default function MailSearchBar({
	value,
	onChange,
	onSubmit,
	folders = [],
	inputRef,
	className,
	onAsk,
	placeholder = "Search mail",
	onOpenPalette,
	scopeChip,
	scopes,
	scopeValue,
	onScopeChange,
}: MailSearchBarProps) {
	const [open, setOpen] = useState(false);
	const [focused, setFocused] = useState(false);
	const askId = useId();
	const offerAsk = !!onAsk && !open && focused && looksLikeQuestion(value);
	const [emptyHint, setEmptyHint] = useState(false);
	const firstFieldRef = useRef<HTMLInputElement>(null);
	const [form, setForm] = useState<AdvancedForm>(EMPTY_FORM);
	const panelId = useId();
	const wrapperRef = useRef<HTMLDivElement>(null);
	const localInputRef = useRef<HTMLInputElement>(null);
	const field = inputRef ?? localInputRef;

	/*
	 * Dismissal, for a panel that is not a menu.
	 *
	 * Radix's dropdown is the wrong primitive here — it owns the keyboard so its
	 * items can be typed at, which is exactly what a form full of text inputs
	 * cannot have. So this is a plain popover, and it owes the reader the two
	 * behaviours they expect from one: Escape closes it, and so does a click
	 * outside. `pointerdown` rather than `click`, so a press that starts outside
	 * cannot be swallowed by a re-render before the click lands.
	 */
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false);
				field.current?.focus();
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open, field]);

	const set = <K extends keyof AdvancedForm>(key: K, next: AdvancedForm[K]) =>
		setForm((current) => ({ ...current, [key]: next }));

	const submitTyped = (event: React.FormEvent) => {
		event.preventDefault();
		const trimmed = value.trim();
		if (!trimmed) return;
		// An explicit `?` prefix is a question, not a query.
		if (onAsk && trimmed.startsWith("?") && questionText(trimmed)) {
			onAsk(questionText(trimmed));
			return;
		}
		onSubmit(trimmed);
	};

	const ask = () => {
		const q = questionText(value);
		if (!q || !onAsk) return;
		setFocused(false);
		onAsk(q);
	};

	const submitAdvanced = (event: React.FormEvent) => {
		event.preventDefault();
		const query = buildAdvancedQuery(form);
		if (!query) {
			// Enabled-but-empty rather than greyed out: say what is missing.
			setEmptyHint(true);
			firstFieldRef.current?.focus();
			return;
		}
		// The built query goes into the field as well as into the URL. It is the
		// answer to "what did that panel actually search for", and it is what the
		// reader edits when the answer is nearly right.
		onChange(query);
		setOpen(false);
		onSubmit(query);
	};

	return (
		<div ref={wrapperRef} className={cn("relative min-w-0", className)}>
			<form onSubmit={submitTyped} role="search" className="flex min-w-0 items-center">
				<span id={`${panelId}-scope`} className="sr-only">
					{placeholder}
				</span>
				<Search
					size={14}
					className="pointer-events-none absolute left-2.5 text-text-tertiary"
					aria-hidden
				/>
				{/*
				  The scope, visible: Outlook shows it as a selector at the left of the
				  field. Mouse widths only; a phone has no room and says it in the
				  accessible description instead.
				*/}
				{scopes && onScopeChange ? (
					<select
						value={scopeValue}
						onChange={(event) => onScopeChange(event.target.value)}
						aria-label="Search scope"
						title="Search this mailbox or all inboxes"
						// Same box as the static chip, so the field never reflows.
						className="absolute left-8 h-5 w-[5.5rem] cursor-pointer appearance-none rounded-[4px] bg-bg-muted text-center text-[11px] font-medium text-text-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-text-primary/15 touch:hidden"
					>
						{scopes.map((option) => (
							<option key={option.value} value={option.value} disabled={option.disabled}>
								{option.label}
							</option>
						))}
					</select>
				) : scopeChip && (
					<span
						aria-hidden
						// Fixed width, so the field's text never moves between scopes.
						className="pointer-events-none absolute left-8 w-[5.5rem] rounded-[4px] bg-bg-muted py-0.5 text-center text-[11px] font-medium text-text-secondary touch:hidden"
					>
						{scopeChip}
					</span>
				)}
				<input
					ref={field}
					type="search"
					value={value}
					onChange={(event) => onChange(event.target.value)}
					onFocus={() => setFocused(true)}
					// Delayed so a click on the suggestion lands before it unmounts.
					onBlur={() => setTimeout(() => setFocused(false), 150)}
					onKeyDown={(event) => {
						if (offerAsk && event.key === "ArrowDown") {
							event.preventDefault();
							document.getElementById(askId)?.focus();
						}
					}}
					// "Search" with a scope chip; otherwise the scope, plus the Ask hint.
					placeholder={scopeChip ? (onAsk ? "Search or ask" : "Search") : onAsk ? `${placeholder}, or ask a question` : placeholder}
					// A constant name, so the control is the same one on every page;
					// the scope it searches is its description.
					aria-label="Search mail"
					aria-describedby={`${panelId}-scope`}
					aria-controls={offerAsk ? askId : undefined}
					// 44px on touch, so the two buttons inside it can be 44px squares
					// without spilling out of the field. Room on the right for clear,
					// advanced and (with a mouse) the ⌘K hint. On touch, Clear's 44px
					// is reserved only while there is text to clear: the placeholder
					// shows only when the field is empty, and at 360px it needs that
					// room to be read whole.
					className={cn(
						"h-8 w-full rounded-[6px] border border-border bg-bg-subtle text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent/50 focus:bg-card touch:h-11 touch:pl-8",
						value ? "touch:pr-[5.5rem]" : "touch:pr-11",
						onOpenPalette ? "pr-[6.5rem]" : "pr-16",
						// Room for the scope chip: fixed so the field never reflows by page.
						scopeChip ? "pl-[8.25rem]" : "pl-8",
					)}
				/>
				{value && (
					<button
						type="button"
						onClick={() => {
							onChange("");
							field.current?.focus();
						}}
						aria-label="Clear search"
						className={cn(
							"absolute inline-flex items-center justify-center rounded-[4px] p-1 text-text-tertiary hover:text-text-primary touch:right-11",
							onOpenPalette ? "right-[4.5rem]" : "right-8",
						)}
					>
						<X size={13} />
					</button>
				)}
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					aria-label="Advanced search"
					aria-expanded={open}
					aria-controls={open ? panelId : undefined}
					title="Advanced search"
					className={cn(
						"absolute right-0.5 inline-flex h-7 w-7 items-center justify-center rounded-[4px] transition-colors touch:right-0",
						open ? "bg-bg-muted text-text-primary" : "text-text-tertiary hover:text-text-primary",
					)}
				>
					<SlidersHorizontal size={14} />
				</button>
				{/*
				  The palette's shortcut, advertised where people look for search.
				  Mouse widths only: a phone has no ⌘ key and reaches the palette
				  from the account menu.
				*/}
				{onOpenPalette && (
					<button
						type="button"
						onClick={onOpenPalette}
						aria-label="Command palette"
						aria-keyshortcuts="Meta+K Control+K"
						title="Command palette (⌘K)"
						className="absolute right-8 inline-flex h-6 items-center rounded-[4px] border border-border bg-card px-1.5 font-mono text-[11px] text-text-tertiary hover:text-text-primary touch:hidden"
					>
						⌘K
					</button>
				)}
			</form>

			{offerAsk && (
				<div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 rounded-[8px] border border-border bg-card p-1 shadow-lg">
					<button
						id={askId}
						type="button"
						onMouseDown={(event) => event.preventDefault()}
						onClick={ask}
						onKeyDown={(event) => {
							if (event.key === "ArrowUp" || event.key === "Escape") {
								event.preventDefault();
								field.current?.focus();
							}
						}}
						className="flex w-full min-w-0 items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] text-text-primary hover:bg-bg-muted focus:bg-bg-muted focus:outline-none touch:min-h-11"
					>
						<Sparkles size={13} className="shrink-0 text-accent" aria-hidden />
						<span className="shrink-0 font-semibold">Ask:</span>
						<span className="min-w-0 truncate">{questionText(value)}</span>
					</button>
				</div>
			)}

			{open && (
				<div
					id={panelId}
					role="dialog"
					aria-label="Advanced search"
					/*
					  Anchored to the field and wider than it, because the fields inside
					  are addresses. `max-w-[calc(100vw-1.5rem)]` so it cannot hang off the
					  edge of a small window, since the bar itself now runs edge to edge.
					*/
					className="absolute right-0 top-[calc(100%+6px)] z-50 w-[380px] max-w-[calc(100vw-1.5rem)] rounded-[10px] border border-border bg-card p-3 text-text-primary shadow-2xl"
				>
					<form onSubmit={submitAdvanced} className="space-y-2.5">
						<div className="flex items-center justify-between">
							<h2 className="text-xs font-semibold text-text-primary">
								Advanced search
							</h2>
							<button
								type="button"
								onClick={() => setOpen(false)}
								aria-label="Close advanced search"
								className="-mr-1 inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-tertiary hover:bg-bg-muted hover:text-text-primary touch:h-11 touch:w-11"
							>
								<X size={14} />
							</button>
						</div>
						<label className="block space-y-1">
							{fieldLabel("From")}
							<input
								ref={firstFieldRef}
								className={INPUT_CLASS}
								value={form.from}
								onChange={(e) => set("from", e.target.value)}
								placeholder="name or address"
							/>
						</label>

						<label className="block space-y-1">
							{fieldLabel("To")}
							<input
								className={INPUT_CLASS}
								value={form.to}
								onChange={(e) => set("to", e.target.value)}
								placeholder="name or address"
							/>
						</label>

						<label className="block space-y-1">
							{fieldLabel("Subject")}
							<input
								className={INPUT_CLASS}
								value={form.subject}
								onChange={(e) => set("subject", e.target.value)}
							/>
						</label>

						<div className="grid grid-cols-2 gap-2">
							<label className="block space-y-1">
								{fieldLabel("Has the words")}
								<input
									className={INPUT_CLASS}
									value={form.includes}
									onChange={(e) => set("includes", e.target.value)}
								/>
							</label>
							<label className="block space-y-1">
								{fieldLabel("Doesn't have")}
								<input
									className={INPUT_CLASS}
									value={form.excludes}
									onChange={(e) => set("excludes", e.target.value)}
								/>
							</label>
						</div>

						<div className="grid grid-cols-3 gap-2">
							<label className="block space-y-1">
								{fieldLabel("Search in")}
								<select
									className={INPUT_CLASS}
									value={form.folder}
									onChange={(e) => set("folder", e.target.value)}
								>
									{/*
									  "Mail" is the default scope the worker applies on its own —
									  everything except Trash and Spam. `anywhere` is the only way
									  to reach those two, so it is named rather than left to a
									  reader who would have to know the operator exists.
									*/}
									<option value="">Mail</option>
									<option value="anywhere">Anywhere, incl. Trash</option>
									{folders.map((folder) => (
										<option key={folder.id} value={folder.id}>
											{folder.name}
										</option>
									))}
								</select>
							</label>
							<label className="block space-y-1">
								{fieldLabel("Date within")}
								<select
									className={INPUT_CLASS}
									value={form.age}
									onChange={(e) => set("age", e.target.value)}
								>
									{AGE_OPTIONS.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
							</label>
							<label className="block space-y-1">
								{fieldLabel("Size")}
								<select
									className={INPUT_CLASS}
									value={form.size}
									onChange={(e) => set("size", e.target.value)}
								>
									{SIZE_OPTIONS.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
							</label>
						</div>

						<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0.5">
							{(
								[
									["hasAttachment", "Has attachment"],
									["unreadOnly", "Unread only"],
									["starredOnly", "Starred only"],
								] as const
							).map(([key, label]) => (
								<label
									key={key}
									className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-text-secondary"
								>
									<input
										type="checkbox"
										checked={form[key]}
										onChange={(e) => set(key, e.target.checked)}
										className="h-3.5 w-3.5 accent-violet"
									/>
									{label}
								</label>
							))}
						</div>

						{/*
						  The query as it will be sent, shown before it is sent.

						  The panel's whole purpose is to teach the syntax to a reader who
						  did not know it existed; hiding what it produced would waste that.
						*/}
						<div className="rounded-[6px] bg-bg-subtle px-2 py-1.5">
							<code className="block break-words font-mono text-[10.5px] leading-relaxed text-text-secondary">
								{buildAdvancedQuery(form) || "—"}
							</code>
						</div>

						<div className="flex items-center justify-end gap-1.5">
							{emptyHint && !buildAdvancedQuery(form) && (
								<p role="status" className="mr-auto text-[11px] text-text-tertiary">
									Fill in at least one field.
								</p>
							)}
							<button
								type="button"
								onClick={() => setForm(EMPTY_FORM)}
								className="rounded-[6px] px-2 py-1.5 text-[11px] font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary"
							>
								Clear
							</button>
							<button
								type="submit"
								className="rounded-[6px] bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground hover:bg-accent-hover touch:min-h-11"
							>
								Search
							</button>
						</div>
					</form>
				</div>
			)}
		</div>
	);
}
