/**
 * Address field with chips and contact autocomplete.
 *
 * Suggestions come from the people aggregate, which is derived from mail this
 * deployment has actually handled — so the addresses offered are ones that
 * exist, rather than a separate address book nobody maintains.
 *
 * The half-typed token is reported upward via `onPendingChange`. Committing only
 * happened on Enter/comma/blur, so sending with ⌘↵ while the caret was still in
 * the field dropped whatever had been typed without saying so.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import { usePeople } from "~/queries/people";
import {
	avatarColor,
	cn,
	extractEmailAddress,
	initials,
	splitEmailList,
} from "~/lib/utils";

interface RecipientInputProps {
	/** Used for the accessible name; the visible label lives in the envelope row. */
	label: string;
	/** Comma-separated list, matching the shape the send API expects. */
	value: string;
	onChange: (next: string) => void;
	/**
	 * Reports the token still being typed, so the composer can commit it when the
	 * message is sent from the keyboard.
	 */
	onPendingChange?: (pending: string) => void;
	placeholder?: string;
	autoFocus?: boolean;
	/** Addresses on these domains read as internal and get the lime chip. */
	ownDomains?: string[];
	/** Marks the field as rejected by validation. */
	invalid?: boolean;
	describedBy?: string;
	disabled?: boolean;
	id?: string;
}

function domainOf(address: string): string {
	const at = address.lastIndexOf("@");
	return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}

export default function RecipientInput({
	label,
	value,
	onChange,
	onPendingChange,
	placeholder = "name@example.com",
	autoFocus,
	ownDomains = [],
	invalid,
	describedBy,
	disabled,
	id,
}: RecipientInputProps) {
	const [draft, setDraft] = useState("");
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const chips = useMemo(() => splitEmailList(value), [value]);

	// Only query once the draft looks like a search rather than a keystroke.
	const search = draft.trim().length >= 2 ? draft.trim() : undefined;
	const { data } = usePeople(
		{ search, page: 1, pageSize: 6 },
		{ enabled: !!search },
	);

	const suggestions = useMemo(() => {
		if (!search) return [];
		const taken = new Set(chips.map((c) => c.toLowerCase()));
		return (data?.people ?? [])
			.filter((person) => !taken.has(person.email.toLowerCase()))
			.slice(0, 6);
	}, [data?.people, chips, search]);

	// Names for chips whose address the people aggregate already knows about, so
	// a committed recipient reads "Ada Lovelace" rather than a raw address.
	const knownNames = useMemo(() => {
		const map = new Map<string, string>();
		for (const person of data?.people ?? []) {
			if (person.name) map.set(person.email.toLowerCase(), person.name);
		}
		return map;
	}, [data?.people]);

	/** Text left in the box that isn't a usable address yet. */
	const pendingIsInvalid =
		draft.trim().length > 0 && extractEmailAddress(draft) === null;

	useEffect(() => {
		setHighlight(0);
		setOpen(suggestions.length > 0);
	}, [suggestions.length]);

	useEffect(() => {
		onPendingChange?.(draft);
	}, [draft, onPendingChange]);

	// The composer commits the pending token itself when the message is sent from
	// the keyboard. Clear the box once that lands as a chip, or the address sits
	// in the field afterwards looking like it still needs adding. Keyed on the
	// value changing so a user typing a duplicate isn't interrupted mid-word.
	const lastValueRef = useRef(value);
	useEffect(() => {
		if (value === lastValueRef.current) return;
		lastValueRef.current = value;
		const address = extractEmailAddress(draft);
		if (!address) return;
		if (
			splitEmailList(value).some((c) => c.toLowerCase() === address.toLowerCase())
		) {
			setDraft("");
		}
	}, [value, draft]);

	// Clicking away closes the list; the draft itself is committed on blur.
	useEffect(() => {
		function onPointerDown(event: MouseEvent) {
			if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
		}
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, []);

	const setChips = (next: string[]) => {
		const seen = new Set<string>();
		const unique = next.filter((address) => {
			const key = address.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		onChange(unique.join(", "));
	};

	const commit = (raw: string) => {
		const tokens = raw.split(/[,;]+/);
		const valid: string[] = [];
		let leftover = "";

		for (const token of tokens) {
			const address = extractEmailAddress(token);
			if (address) valid.push(address);
			else if (token.trim()) leftover = token.trim();
		}

		if (valid.length > 0) setChips([...chips, ...valid]);
		setDraft(leftover);
		return valid.length > 0;
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		// ⌘↵ belongs to the composer, not the suggestion list.
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return;

		if (open && suggestions.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setHighlight((h) => (h + 1) % suggestions.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
				return;
			}
			if (e.key === "Escape") {
				setOpen(false);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const picked = suggestions[highlight];
				if (picked) {
					setChips([...chips, picked.email]);
					setDraft("");
					setOpen(false);
				}
				return;
			}
		}

		if (e.key === "Enter" || e.key === "," || e.key === ";") {
			if (draft.trim()) {
				e.preventDefault();
				commit(draft);
			}
			return;
		}

		if (e.key === "Backspace" && draft === "" && chips.length > 0) {
			// Backspacing into an empty field edits the last chip rather than
			// silently deleting it, which is what people expect from mail clients.
			setChips(chips.slice(0, -1));
			setDraft(chips[chips.length - 1]);
		}
	};

	return (
		<div ref={containerRef} className="relative min-w-0">
			<div
				className={cn(
					// No box of its own: the envelope row draws the focus cue, so To,
					// Cc and Subject look like one stack of lines, as in Gmail.
					"flex min-h-[36px] flex-wrap items-center gap-1 rounded-[6px] px-0.5 py-1",
					(invalid || pendingIsInvalid) &&
						"border-destructive/40 bg-destructive/[0.04]",
					disabled && "opacity-60",
				)}
				onClick={() => inputRef.current?.focus()}
			>
				{chips.map((address) => {
					const palette = avatarColor(address);
					const internal = ownDomains.includes(domainOf(address));
					const name = knownNames.get(address.toLowerCase());
					return (
						<span
							key={address}
							title={address}
							className={cn(
								"inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium leading-none",
								internal
									? "border-primary/30 bg-accent-subtle text-accent-subtle-fg"
									: "border-border bg-bg-subtle text-text-secondary",
							)}
						>
							<span
								className="flex h-3.5 w-3.5 items-center justify-center rounded-full text-[8px] font-bold"
								style={{ backgroundColor: palette.bg, color: palette.fg }}
								aria-hidden
							>
								{initials(name ?? null, address)}
							</span>
							<span className="truncate">{name ?? address}</span>
							<button
								type="button"
								disabled={disabled}
								onClick={(e) => {
									e.stopPropagation();
									setChips(chips.filter((c) => c !== address));
								}}
								aria-label={`Remove ${address}`}
								// Inside a chip: exempt from the 44px floor (it would make every chip
								// 44px tall), held to the 24px WCAG 2.5.8 minimum instead.
								className="touch-exempt inline-flex items-center justify-center rounded-full p-0.5 hover:bg-black/10 disabled:opacity-40 touch:min-h-6 touch:min-w-6"
							>
								<X size={9} />
							</button>
						</span>
					);
				})}

				<input
					ref={inputRef}
					id={id}
					type="text"
					value={draft}
					autoFocus={autoFocus}
					disabled={disabled}
					aria-label={label}
					aria-invalid={invalid || pendingIsInvalid || undefined}
					aria-describedby={describedBy}
					autoComplete="off"
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={handleKeyDown}
					onBlur={() => {
						if (draft.trim()) commit(draft);
					}}
					placeholder={chips.length === 0 ? placeholder : ""}
					className="min-w-[140px] flex-1 border-0 bg-transparent py-1 text-sm text-text-primary outline-none placeholder:text-text-tertiary/75 disabled:cursor-not-allowed"
				/>
			</div>

			{pendingIsInvalid && (
				<p className="flex items-center gap-1 px-1.5 pb-1 text-[10px] text-destructive">
					<AlertCircle size={10} aria-hidden />
					<span>“{draft.trim()}” isn’t a valid address yet.</span>
				</p>
			)}

			{open && suggestions.length > 0 && (
				<ul
					role="listbox"
					aria-label={`${label} suggestions`}
					className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-[8px] border border-border bg-card py-1 shadow-lg"
				>
					{suggestions.map((person, index) => {
						const palette = avatarColor(person.email);
						return (
							<li key={person.id}>
								<button
									type="button"
									role="option"
									aria-selected={index === highlight}
									onMouseEnter={() => setHighlight(index)}
									onClick={() => {
										setChips([...chips, person.email]);
										setDraft("");
										setOpen(false);
										inputRef.current?.focus();
									}}
									className={cn(
										"flex w-full items-center gap-2 px-2.5 py-1.5 text-left",
										index === highlight ? "bg-bg-muted" : "hover:bg-bg-subtle",
									)}
								>
									<span
										className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold"
										style={{ backgroundColor: palette.bg, color: palette.fg }}
										aria-hidden
									>
										{initials(person.name, person.email)}
									</span>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-xs font-medium text-text-primary">
											{person.name || person.email}
										</span>
										{person.name && (
											<span className="block truncate text-[10px] font-light text-text-tertiary">
												{person.email}
											</span>
										)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
