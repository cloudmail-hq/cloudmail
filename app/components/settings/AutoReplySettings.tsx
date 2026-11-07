/**
 * Vacation auto-responder.
 *
 * The one thing worth saying in the UI is what the responder will *not* do,
 * because that is where trust in an auto-responder lives: it never answers a
 * mailing list, a bounce, another automated message, or the same person twice
 * in a few days.
 */

import { Plane } from "lucide-react";
import type { AutoReplySettings as AutoReply } from "shared/auto-reply";

interface AutoReplySettingsProps {
	value: AutoReply;
	onChange: (next: AutoReply) => void;
}

/** `datetime-local` wants local wall-clock time, not an ISO instant. */
function toLocalInput(iso: string | null | undefined): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
		date.getDate(),
	)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
	if (!value) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const inputClass =
	"w-full rounded-[6px] border border-border bg-card px-2.5 py-1.5 text-sm text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15";

export default function AutoReplySettings({
	value,
	onChange,
}: AutoReplySettingsProps) {
	const enabled = value.enabled ?? false;
	const windowInvalid =
		!!value.startsAt &&
		!!value.endsAt &&
		Date.parse(value.endsAt) <= Date.parse(value.startsAt);

	return (
		<section className="rounded-[10px] border border-border bg-card p-4">
			<div className="mb-3 flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="flex items-center gap-1.5 text-sm font-bold text-text-primary">
						<Plane size={14} className="text-text-tertiary" />
						Vacation auto-reply
					</h2>
					<p className="mt-1 text-sm text-text-secondary">
						Answers people who write while you are away. Mailing lists, bounces
						and other auto-replies are never answered, and each person hears from
						it at most once every few days.
					</p>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={enabled}
					aria-label="Vacation auto-reply"
					onClick={() => onChange({ ...value, enabled: !enabled })}
					className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
						enabled ? "bg-violet" : "bg-bg-muted"
					}`}
				>
					<span
						className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
							enabled ? "translate-x-[18px]" : "translate-x-0.5"
						}`}
					/>
				</button>
			</div>

			{enabled && (
				<div className="space-y-2.5">
					<label className="block">
						<span className="mb-1 block text-xs font-medium text-text-secondary">
							Subject
						</span>
						<input
							value={value.subject ?? ""}
							onChange={(e) => onChange({ ...value, subject: e.target.value })}
							placeholder="Leave empty to reply with “Automatic reply: <their subject>”"
							className={inputClass}
						/>
					</label>

					<label className="block">
						<span className="mb-1 block text-xs font-medium text-text-secondary">
							Message
						</span>
						<textarea
							value={value.message ?? ""}
							onChange={(e) => onChange({ ...value, message: e.target.value })}
							rows={5}
							placeholder={"Thanks for your note — I'm away until Monday and will reply when I'm back."}
							className={`${inputClass} resize-y`}
						/>
						{!(value.message ?? "").trim() && (
							<p className="mt-1 text-[11px] text-warning-text">
								The responder stays off until there is a message to send.
							</p>
						)}
					</label>

					<div className="grid gap-2.5 sm:grid-cols-2">
						<label className="block">
							<span className="mb-1 block text-xs font-medium text-text-secondary">
								Starts (optional)
							</span>
							<input
								type="datetime-local"
								value={toLocalInput(value.startsAt)}
								onChange={(e) =>
									onChange({ ...value, startsAt: fromLocalInput(e.target.value) })
								}
								className={inputClass}
							/>
						</label>
						<label className="block">
							<span className="mb-1 block text-xs font-medium text-text-secondary">
								Ends (optional)
							</span>
							<input
								type="datetime-local"
								value={toLocalInput(value.endsAt)}
								onChange={(e) =>
									onChange({ ...value, endsAt: fromLocalInput(e.target.value) })
								}
								aria-invalid={windowInvalid || undefined}
								className={inputClass}
							/>
						</label>
					</div>

					{windowInvalid ? (
						<p className="text-[11px] text-destructive">
							The end of the window is before its start, so nothing would be sent.
						</p>
					) : (
						<p className="text-xs text-text-tertiary">
							Leave both empty to reply for as long as this is switched on.
						</p>
					)}
				</div>
			)}
		</section>
	);
}
