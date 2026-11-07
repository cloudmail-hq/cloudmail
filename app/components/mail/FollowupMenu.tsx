// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * "Remind me if no reply" picker for the composer, beside Schedule.
 *
 * Holds a choice rather than acting: the reminder is set when the message
 * goes out, by the `followup` field on the send body. The menu starts from the
 * mailbox's default (Settings, Follow-up reminders), and "Auto" lets the
 * server's classifier decide whether this message expects an answer.
 */

import { useState } from "react";
import { BellRing, Check } from "lucide-react";
import { FOLLOWUP_PRESETS, type FollowupDefault, type FollowupRequest } from "shared/followups";
import { cn } from "~/lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

export type FollowupChoice =
	| { kind: "off" }
	| { kind: "auto" }
	| { kind: "preset"; id: (typeof FOLLOWUP_PRESETS)[number]["id"] }
	| { kind: "custom"; at: string };

/** The composer's starting point for a mailbox default. */
export function choiceForDefault(value: FollowupDefault | undefined): FollowupChoice {
	if (value === "3d") return { kind: "preset", id: "3d" };
	if (value === "auto") return { kind: "auto" };
	return { kind: "off" };
}

/**
 * The `followup` field to send. Always explicit, so an "Off" choice is
 * honoured even when the mailbox default would set one.
 */
export function followupRequestFor(choice: FollowupChoice): FollowupRequest {
	switch (choice.kind) {
		case "off":
			return { mode: "off" };
		case "auto":
			return { mode: "auto" };
		case "preset": {
			const preset = FOLLOWUP_PRESETS.find((p) => p.id === choice.id)!;
			return { mode: "manual", delay_seconds: preset.seconds };
		}
		case "custom":
			return { mode: "manual", at: new Date(choice.at).toISOString() };
	}
}

/** Short text for the trigger, so the choice is visible without opening it. */
export function choiceLabel(choice: FollowupChoice): string | null {
	switch (choice.kind) {
		case "off":
			return null;
		case "auto":
			return "Auto";
		case "preset":
			return FOLLOWUP_PRESETS.find((p) => p.id === choice.id)!.label;
		case "custom":
			return new Date(choice.at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
	}
}

function toLocalInputValue(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
		date.getHours(),
	)}:${pad(date.getMinutes())}`;
}

interface FollowupMenuProps {
	value: FollowupChoice;
	onChange: (next: FollowupChoice) => void;
	disabled?: boolean;
}

export default function FollowupMenu({ value, onChange, disabled }: FollowupMenuProps) {
	const [custom, setCustom] = useState(() =>
		toLocalInputValue(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)),
	);
	const label = choiceLabel(value);
	const active = value.kind !== "off";
	const isSelected = (candidate: FollowupChoice) =>
		candidate.kind === value.kind &&
		(candidate.kind !== "preset" || (value.kind === "preset" && value.id === candidate.id));

	const item = (candidate: FollowupChoice, text: string, hint?: string) => (
		<DropdownMenuItem
			className="cursor-pointer"
			onClick={() => onChange(candidate)}
			aria-checked={isSelected(candidate)}
			role="menuitemradio"
		>
			<span className="flex w-4 shrink-0 justify-center">
				{isSelected(candidate) && <Check size={13} aria-hidden />}
			</span>
			<span className="flex-1">{text}</span>
			{hint && <span className="text-[10px] font-light text-text-tertiary">{hint}</span>}
		</DropdownMenuItem>
	);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					disabled={disabled}
					title="Remind me if no reply"
					aria-label={
						label ? `Remind me if no reply: ${label}` : "Remind me if no reply: off"
					}
					className={cn(
						"inline-flex h-7 items-center gap-1 rounded-[6px] px-1.5 text-xs font-medium transition-colors disabled:opacity-40 touch:h-11 touch:min-w-11 touch:justify-center",
						active
							? "bg-accent-subtle text-accent-subtle-fg hover:bg-accent-subtle/80"
							: "text-text-tertiary hover:bg-bg-muted hover:text-text-primary",
					)}
				>
					<BellRing size={15} aria-hidden />
					{label && <span className="whitespace-nowrap">{label}</span>}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuLabel>Remind me if no reply</DropdownMenuLabel>
				{FOLLOWUP_PRESETS.map((preset) =>
					item({ kind: "preset", id: preset.id }, `In ${preset.label}`),
				)}
				{item({ kind: "auto" }, "Auto", "if it asks for a reply")}
				{item({ kind: "off" }, "Off")}
				<DropdownMenuSeparator />
				<div className="px-2 py-1.5">
					<label
						htmlFor="followup-custom"
						className="mb-1 block text-xs font-medium text-text-secondary"
					>
						Pick a time
					</label>
					<div className="flex items-center gap-1.5">
						<input
							id="followup-custom"
							type="datetime-local"
							value={custom}
							min={toLocalInputValue(new Date())}
							onChange={(e) => setCustom(e.target.value)}
							className="min-w-0 flex-1 rounded-[6px] border border-border bg-card px-1.5 py-1 text-[11px] text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15"
						/>
						<button
							type="button"
							onClick={() => {
								const parsed = new Date(custom);
								if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) return;
								onChange({ kind: "custom", at: parsed.toISOString() });
							}}
							className="shrink-0 rounded-[6px] bg-accent px-2 py-1 text-[11px] font-semibold text-accent-foreground"
						>
							Set
						</button>
					</div>
				</div>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
