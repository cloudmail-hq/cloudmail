/**
 * Send-later picker.
 *
 * Presets cover the cases people actually use; the custom row exists because
 * "next Tuesday 09:00" is not expressible any other way. Everything resolves to
 * an absolute instant before it leaves the component, so the server never has
 * to guess a timezone.
 */

import { useId, useState } from "react";
import { CalendarClock, ChevronDown } from "lucide-react";
import { snoozePresets } from "shared/dates";
import { cn } from "~/lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

interface ScheduleMenuProps {
	onSchedule: (sendAt: Date) => void;
	disabled?: boolean;
	/**
	 * "split" renders the trigger as the caret half of a Send button; "standalone"
	 * as its own bordered control. The composer pairs it with Send so send-later
	 * reads as a variant of sending rather than an unrelated tool.
	 */
	variant?: "standalone" | "split";
	/** Why scheduling is unavailable, shown as the tooltip and described to AT. */
	disabledReason?: string;
}

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" in local time. */
function toLocalInputValue(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
		date.getDate(),
	)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function ScheduleMenu({
	onSchedule,
	disabled,
	variant = "standalone",
	disabledReason,
}: ScheduleMenuProps) {
	const hintId = useId();
	const hint = disabled && disabledReason ? disabledReason : null;
	const [custom, setCustom] = useState(() =>
		toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)),
	);

	// Reuses the snooze presets: "tomorrow morning" means the same thing whether
	// you are deferring a message or delaying one.
	const presets = snoozePresets();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					disabled={disabled}
					title={hint ? `Schedule send: ${hint}` : "Schedule send"}
					aria-label="Schedule send"
					aria-describedby={hint ? hintId : undefined}
					className={cn(
						"inline-flex items-center gap-0.5 transition-colors disabled:opacity-40",
						variant === "split"
							? "h-9 rounded-r-full bg-accent pl-1.5 pr-2.5 text-accent-foreground hover:bg-accent-hover"
							: "h-7 rounded-[6px] border border-border bg-card px-2 text-xs font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary",
					)}
				>
					{variant === "split" ? null : <CalendarClock size={13} />}
					<ChevronDown size={10} />
				</button>
			</DropdownMenuTrigger>
			{hint ? (
				<span id={hintId} className="sr-only">
					{hint}
				</span>
			) : null}
			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuLabel>Send later</DropdownMenuLabel>
				{presets.map((preset) => (
					<DropdownMenuItem
						key={preset.id}
						className="cursor-pointer"
						onClick={() => onSchedule(preset.at)}
					>
						<span className="flex-1">{preset.label}</span>
						<span className="text-[10px] font-light text-text-tertiary">
							{preset.at.toLocaleString(undefined, {
								weekday: "short",
								hour: "numeric",
								minute: "2-digit",
							})}
						</span>
					</DropdownMenuItem>
				))}

				<DropdownMenuSeparator />

				<div className="px-2 py-1.5">
					<label
						htmlFor="schedule-custom"
						className="mb-1 block text-xs font-medium text-text-secondary"
					>
						Pick a time
					</label>
					<div className="flex items-center gap-1.5">
						<input
							id="schedule-custom"
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
								if (Number.isNaN(parsed.getTime())) return;
								onSchedule(parsed);
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
