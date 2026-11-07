/**
 * ⌘K / Ctrl+K / `/` command palette.
 *
 * Built on the Radix dialog the rest of the app uses rather than `cmdk`: the
 * dialog already gives the focus trap, Escape, inert background and focus
 * return, and the matching and ordering live in `~/lib/command-palette` where
 * they're unit tested. What this file adds is the ARIA combobox: focus stays in
 * the input, arrow keys move `aria-activedescendant` through a listbox, and a
 * live region reads out how many results there are.
 *
 * Mounted once, by `DashboardLayout`, so it is available on every page. Mail
 * actions only appear inside the mail workspace, where `useKeyboardShortcuts`
 * publishes what is selected; see `useShortcutContextStore`.
 */

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { CornerDownLeft, Search } from "lucide-react";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { useCommandPaletteStore } from "~/hooks/useCommandPaletteStore";
import {
	runShortcutAction,
	useShortcutContextStore,
} from "~/hooks/useKeyboardShortcuts";
import { useUIStore } from "~/hooks/useUIStore";
import {
	buildPaletteItems,
	isPaletteShortcut,
	rankPaletteItems,
	templateItems,
	type PaletteItem,
} from "~/lib/command-palette";
import { searchHref, searchScope } from "~/lib/app-nav";
import { cn } from "~/lib/utils";
import { useFolders } from "~/queries/folders";
import { useLabels } from "~/queries/labels";
import { useMailboxes } from "~/queries/mailboxes";
import { useCurrentUser, usePeople } from "~/queries/people";
import { useTemplates } from "~/queries/templates";

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** `⌘` on Apple platforms, `Ctrl` elsewhere. Decided after hydration. */
export function useModKeyLabel(): string {
	const [label, setLabel] = useState("⌘");
	useEffect(() => {
		const platform =
			(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
				?.platform ?? navigator.platform;
		if (!/mac|iphone|ipad|ipod/i.test(platform)) setLabel("Ctrl ");
	}, []);
	return label;
}

/** One key cap. */
function Kbd({ children }: { children: React.ReactNode }) {
	return (
		<kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-border bg-card px-1 font-mono text-[11px] font-medium leading-none text-text-primary shadow-[0_1px_0_var(--color-border)]">
			{children}
		</kbd>
	);
}

function ShortcutKeys({
	sequence,
	className,
}: {
	sequence: readonly string[];
	className?: string;
}) {
	return (
		<span className={cn("flex shrink-0 items-center gap-1", className)} aria-hidden>
			{sequence.map((key, i) => (
				<Fragment key={`${key}-${i}`}>
					{i > 0 && <span className="text-[11px] text-text-secondary">then</span>}
					<Kbd>{key === "Enter" ? "↵" : key}</Kbd>
				</Fragment>
			))}
		</span>
	);
}

/** "g then i", for the accessible name, so the shortcut is read out too. */
function spokenShortcut(sequence: readonly string[]): string {
	const names: Record<string, string> = {
		"#": "hash",
		"!": "exclamation mark",
		"+": "plus",
		"-": "minus",
		".": "period",
		";": "semicolon",
		":": "colon",
		"*": "asterisk",
		"?": "question mark",
	};
	return sequence
		.map((key) => names[key] ?? (key.length === 1 && key !== key.toLowerCase() ? `shift ${key}` : key))
		.join(" then ");
}

export default function CommandPalette() {
	const { isOpen, mode, open, close, recentCommands, noteCommand, recentThreads, insertTemplate } =
		useCommandPaletteStore();
	const shortcutContext = useShortcutContextStore((state) => state.context);
	const startCompose = useUIStore((state) => state.startCompose);
	const navigate = useNavigate();
	const location = useLocation();
	const { mailboxId } = useParams<{ mailboxId?: string }>();

	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const [listMode, setListMode] = useState(mode);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const baseId = useId();
	const listboxId = `${baseId}-listbox`;
	const optionId = (index: number) => `${baseId}-option-${index}`;

	// Global open shortcut. Capture phase, so it runs before the mail hook and
	// before a Radix menu's own handler; `/` still yields to text fields.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				!isPaletteShortcut({
					key: event.key,
					metaKey: event.metaKey,
					ctrlKey: event.ctrlKey,
					altKey: event.altKey,
					shiftKey: event.shiftKey,
					typing: isTypingTarget(event.target),
					defaultPrevented: event.defaultPrevented,
				})
			) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			const store = useCommandPaletteStore.getState();
			if (store.isOpen) store.close();
			else store.open();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, []);

	/*
	  Where focus goes back to on close. Radix returns it to a Dialog.Trigger,
	  and the palette usually has none (⌘K, `/`), so it would land on <body>
	  even when it came from a button. Recorded at open time; skipped when the
	  chosen command moves focus itself (a menu, the composer).
	*/
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const commandRanRef = useRef(false);

	// Fresh state on every open.
	useEffect(() => {
		if (!isOpen) return;
		const previous = document.activeElement;
		returnFocusRef.current =
			previous instanceof HTMLElement && previous !== document.body ? previous : null;
		commandRanRef.current = false;
		setQuery("");
		setActiveIndex(0);
		setListMode(mode);
	}, [isOpen, mode]);

	// Data. Everything is cached by the pages that own it, so opening the
	// palette usually costs nothing; people are fetched as the user types.
	const { data: me } = useCurrentUser();
	const { data: mailboxes = [] } = useMailboxes();
	const { data: folders = [] } = useFolders(isOpen ? mailboxId : undefined);
	const { data: labels = [] } = useLabels(isOpen ? mailboxId : undefined);
	const { data: templates = [] } = useTemplates();
	const trimmed = query.trim();
	const { data: peopleData } = usePeople(
		{ search: trimmed, pageSize: 6 },
		{ enabled: isOpen && listMode === "all" && trimmed.length >= 2 },
	);
	const people = trimmed.length >= 2 ? (peopleData?.people ?? []) : [];

	const items = useMemo<PaletteItem[]>(() => {
		if (!isOpen) return [];
		if (listMode === "templates") {
			return rankPaletteItems(templateItems(templates), query, recentCommands);
		}
		const all = buildPaletteItems({
			mailboxId,
			shortcutContext,
			mailboxes,
			folders,
			labels,
			people,
			templates,
			recentThreads,
			canInsertTemplate: !!insertTemplate,
			viewer: {
				isAdmin: me?.role === "admin",
				passwordMode: me?.authMode === "password",
				managesSomeMailbox:
					me?.capabilities === null ||
					(me?.capabilities ?? []).some((entry) =>
						entry.capabilities.includes("manageSettings"),
					),
			},
			query,
		});
		return rankPaletteItems(all, query, recentCommands);
	}, [
		isOpen,
		listMode,
		templates,
		query,
		recentCommands,
		mailboxId,
		shortcutContext,
		mailboxes,
		folders,
		labels,
		people,
		recentThreads,
		insertTemplate,
		me?.role,
		me?.authMode,
		me?.capabilities,
	]);

	const active = Math.min(activeIndex, Math.max(0, items.length - 1));

	// Keep the active row in view.
	useEffect(() => {
		if (!isOpen) return;
		document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active, isOpen, items]);

	const run = useCallback(
		(item: PaletteItem) => {
			const r = item.run;
			if (r.kind === "templates-mode") {
				noteCommand(item.id);
				setListMode("templates");
				setQuery("");
				setActiveIndex(0);
				inputRef.current?.focus();
				return;
			}
			if (r.kind !== "insert-template") noteCommand(item.id);
			commandRanRef.current = true;
			close();
			// After the dialog has returned focus, so whatever runs next (a menu,
			// the composer) gets focus and keeps it.
			requestAnimationFrame(() => {
				switch (r.kind) {
					case "shortcut":
						if (r.action.type === "compose") {
							if (shortcutContext || location.pathname.startsWith("/people")) {
								startCompose();
							} else {
								const target = mailboxId ?? mailboxes[0]?.id;
								if (target) {
									navigate(`/mail/${encodeURIComponent(target)}/inbox`);
									startCompose();
								}
							}
							return;
						}
						runShortcutAction(r.action);
						return;
					case "navigate":
						navigate(r.to);
						return;
					case "search":
						navigate(searchHref(searchScope(location.pathname), r.query));
						return;
					case "open-thread":
						if (r.mailboxId !== mailboxId) {
							navigate(`/mail/${encodeURIComponent(r.mailboxId)}/inbox`);
						}
						// Selecting after navigation: the folder route clears the
						// selection when its collection changes.
						setTimeout(() => useUIStore.getState().selectEmail(r.id), 0);
						return;
					case "insert-template": {
						const template = templates.find((t) => t.slug === r.slug);
						if (template) insertTemplate?.(template);
						return;
					}
				}
			});
		},
		[
			close,
			insertTemplate,
			location.pathname,
			mailboxId,
			mailboxes,
			navigate,
			noteCommand,
			shortcutContext,
			startCompose,
			templates,
		],
	);

	const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.nativeEvent.isComposing) return;
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				setActiveIndex(items.length ? (active + 1) % items.length : 0);
				return;
			case "ArrowUp":
				event.preventDefault();
				setActiveIndex(items.length ? (active - 1 + items.length) % items.length : 0);
				return;
			case "Home":
				if (!query) {
					event.preventDefault();
					setActiveIndex(0);
				}
				return;
			case "End":
				if (!query) {
					event.preventDefault();
					setActiveIndex(Math.max(0, items.length - 1));
				}
				return;
			case "PageDown":
				event.preventDefault();
				setActiveIndex(Math.min(items.length - 1, active + 8));
				return;
			case "PageUp":
				event.preventDefault();
				setActiveIndex(Math.max(0, active - 8));
				return;
			case "Enter":
				event.preventDefault();
				if (items[active]) run(items[active]);
				return;
			case "Backspace":
				// Back out of "Insert template…" to the full list.
				if (!query && listMode === "templates" && mode === "all") {
					event.preventDefault();
					setListMode("all");
					setActiveIndex(0);
				}
				return;
		}
	};

	const resultsLabel =
		items.length === 0
			? "No results"
			: `${items.length} result${items.length === 1 ? "" : "s"}`;

	const modKey = useModKeyLabel();
	const [isNarrow, setIsNarrow] = useState(false);
	useEffect(() => {
		if (!isOpen) return;
		setIsNarrow(window.matchMedia("(max-width: 639px)").matches);
	}, [isOpen]);
	const placeholder =
		listMode === "templates"
			? "Search templates…"
			: shortcutContext
				? "Type a command, folder, person or search…"
				: "Type a command, page or person…";
	// The phone sheet's field is about 250px wide.
	const shortPlaceholder = listMode === "templates" ? "Search templates…" : "Search commands…";

	return (
		<DialogPrimitive.Root
			open={isOpen}
			onOpenChange={(next) => (next ? open() : close())}
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-slate-900/40 data-[state=open]:animate-in data-[state=open]:fade-in-0 dark:bg-black/60" />
				<DialogPrimitive.Content
					aria-describedby={undefined}
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						inputRef.current?.focus();
					}}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						if (commandRanRef.current) return;
						const target = returnFocusRef.current;
						if (target?.isConnected) target.focus();
					}}
					className={cn(
						"fixed z-[60] flex flex-col overflow-hidden bg-card text-text-primary shadow-2xl ring-1 ring-border dark:ring-white/15",
						// Full-screen sheet on a phone, with safe areas.
						"inset-0 pt-safe pb-safe",
						// A centred panel from `sm`, a third of the way down like Spotlight.
						"sm:inset-auto sm:left-1/2 sm:top-[12vh] sm:max-h-[min(560px,76vh)] sm:w-[min(640px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:rounded-xl sm:pt-0 sm:pb-0",
					)}
				>
					<DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>

					<div className="flex items-center gap-2 border-b border-border px-3 sm:px-4">
						<Search size={16} className="shrink-0 text-text-tertiary" aria-hidden />
						{listMode === "templates" && (
							<span className="shrink-0 rounded-[4px] bg-accent-subtle px-1.5 py-0.5 text-[11px] font-medium text-accent-subtle-fg">
								Templates
							</span>
						)}
						<input
							ref={inputRef}
							value={query}
							onChange={(event) => {
								setQuery(event.target.value);
								setActiveIndex(0);
							}}
							onKeyDown={onInputKeyDown}
							role="combobox"
							aria-expanded="true"
							aria-controls={listboxId}
							aria-activedescendant={items.length ? optionId(active) : undefined}
							aria-autocomplete="list"
							aria-label="Command palette"
							placeholder={isNarrow ? shortPlaceholder : placeholder}
							autoComplete="off"
							autoCorrect="off"
							spellCheck={false}
							enterKeyHint="go"
							className="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-tertiary touch:h-14 touch:text-base"
						/>
						<DialogPrimitive.Close
							className="inline-flex h-8 shrink-0 items-center rounded-[6px] px-2 text-xs font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary touch:h-11"
						>
							<span className="sm:hidden">Cancel</span>
							<span className="hidden sm:inline">
								<Kbd>Esc</Kbd>
								<span className="sr-only">Close</span>
							</span>
						</DialogPrimitive.Close>
					</div>

					<div
						ref={listRef}
						id={listboxId}
						role="listbox"
						aria-label={listMode === "templates" ? "Templates" : "Commands"}
						className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3 pt-1.5"
					>
						{items.length === 0 ? (
							<p className="px-4 py-8 text-center text-sm text-text-secondary">
								{listMode === "templates" && templates.length === 0
									? "No templates yet. Create one under Templates."
									: "Nothing matches. Try another word."}
							</p>
						) : (
							items.map((item, index) => {
								const showHeading = index === 0 || items[index - 1].section !== item.section;
								const isActive = index === active;
								return (
									<Fragment key={`${item.section}:${item.id}`}>
										{showHeading && (
											<div
												role="presentation"
												className="px-4 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary"
											>
												{item.section}
											</div>
										)}
										<div
											id={optionId(index)}
											role="option"
											aria-selected={isActive}
											aria-label={[
												item.title,
												item.subtitle,
												item.shortcut ? `shortcut ${spokenShortcut(item.shortcut)}` : null,
											]
												.filter(Boolean)
												.join(", ")}
											onPointerMove={() => {
												if (!isActive) setActiveIndex(index);
											}}
											onMouseDown={(event) => event.preventDefault()}
											onClick={() => run(item)}
											className={cn(
												"mx-1.5 flex cursor-pointer items-center gap-3 rounded-[8px] px-2.5 py-2 text-sm touch:min-h-12",
												// A bar as well as the tint, so the active row doesn't rely on colour alone.
												isActive ? "bg-accent-subtle shadow-[inset_3px_0_0_var(--color-accent)]" : "",
											)}
										>
											<span className="min-w-0 flex-1">
												<span
													className={cn(
														"block truncate",
														isActive ? "font-medium text-accent-subtle-fg" : "text-text-primary",
													)}
												>
													{item.title}
												</span>
												{item.subtitle && (
													<span className="block truncate text-xs text-text-secondary">
														{item.subtitle}
													</span>
												)}
											</span>
											{item.shortcut && (
												<ShortcutKeys
													sequence={item.shortcut}
													className={item.subtitle ? "self-start pt-0.5" : undefined}
												/>
											)}
											{/* Always laid out, so key caps line up whether or not the row is active. */}
											<CornerDownLeft
												size={14}
												className={cn(
													"hidden shrink-0 text-text-secondary sm:block",
													!isActive && "invisible",
												)}
												aria-hidden
											/>
										</div>
									</Fragment>
								);
							})
						)}
					</div>

					<div className="hidden items-center gap-3 border-t border-border px-4 py-2 text-xs text-text-secondary sm:flex">
						<span className="flex items-center gap-1">
							<Kbd>↑</Kbd>
							<Kbd>↓</Kbd> to move
						</span>
						<span className="flex items-center gap-1">
							<Kbd>↵</Kbd> to run
						</span>
						{listMode === "templates" && mode === "all" && (
							<span className="flex items-center gap-1">
								<Kbd>⌫</Kbd> back
							</span>
						)}
						<span className="ml-auto flex items-center gap-1">
							<Kbd>{modKey.trim()}</Kbd>
							<Kbd>K</Kbd> anywhere
						</span>
					</div>

					{/* Result count, read out as the list changes. */}
					<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
						{isOpen ? resultsLabel : ""}
					</div>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}
