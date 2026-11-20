// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox settings > Tracking & privacy.
 *
 * Open, click and attachment tracking, plus the optional disclosure line.
 * Saves each change as it is made (PATCH .../settings/tracking), like aliases
 * and signatures, so it sits outside the page's Save button.
 */

import { Eye } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { DEFAULT_TRACKING_DISCLOSURE } from "shared/privacy";
import { errorMessage, showToast } from "~/lib/toast";
import { useTrackingSettings, useUpdateTrackingSettings, type TrackingSettings } from "~/queries/privacy";

function Switch({
	checked,
	onChange,
	labelledBy,
	describedBy,
	disabled,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	labelledBy: string;
	describedBy?: string;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-labelledby={labelledBy}
			aria-describedby={describedBy}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			// The base layer gives buttons a 44px floor on touch; the track stays compact.
			className="relative inline-flex shrink-0 items-center justify-center rounded-full disabled:opacity-50"
		>
			<span
				aria-hidden
				className={`relative block h-5 w-9 rounded-full transition-colors ${checked ? "bg-accent" : "bg-bg-muted"}`}
			>
				<span
					className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
						checked ? "translate-x-[18px]" : "translate-x-0.5"
					}`}
				/>
			</span>
		</button>
	);
}

function Row({
	title,
	hint,
	checked,
	onChange,
	disabled,
}: {
	title: string;
	hint: string;
	checked: boolean;
	onChange: (next: boolean) => void;
	disabled?: boolean;
}) {
	const id = useId();
	return (
		<div className="flex items-start justify-between gap-3 py-2.5">
			<div className="min-w-0">
				<p id={`${id}-label`} className="text-sm font-medium text-text-primary">
					{title}
				</p>
				<p id={`${id}-hint`} className="mt-0.5 text-[12px] text-text-secondary">
					{hint}
				</p>
			</div>
			<Switch
				checked={checked}
				onChange={onChange}
				labelledBy={`${id}-label`}
				describedBy={`${id}-hint`}
				disabled={disabled}
			/>
		</div>
	);
}

export default function TrackingSettingsSection({ mailboxId }: { mailboxId: string }) {
	const { data, isPending } = useTrackingSettings(mailboxId);
	const update = useUpdateTrackingSettings(mailboxId);
	const [text, setText] = useState("");

	useEffect(() => {
		setText(data?.disclosureText ?? "");
	}, [data?.disclosureText]);

	const save = (patch: Partial<TrackingSettings>) =>
		update.mutate(patch, {
			onError: (err) =>
				showToast({ kind: "error", message: errorMessage(err, "Could not save tracking settings.") }),
		});

	const anyTracking = !!data && (data.openTracking || data.clickTracking);

	return (
		<section className="rounded-[8px] border border-border bg-card p-5" aria-busy={isPending}>
			<div className="mb-2">
				<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
					<Eye size={15} className="text-text-tertiary" aria-hidden />
					Tracking & privacy
				</h2>
				<p className="mt-1 text-sm text-text-secondary">
					Measures whether recipients open your mail or click its links. Your own Sent copy is never
					instrumented. Recipients who opt out on the unsubscribe page are never tracked, and you can switch it
					off for a single message in the composer.
				</p>
			</div>

			{isPending || !data ? (
				<div className="h-28 animate-pulse rounded-[6px] bg-bg-muted" />
			) : (
				<div className="divide-y divide-border/60">
					<Row
						title="Open tracking"
						hint="Adds an invisible image. Privacy proxies (Apple Mail, Gmail) can report opens that never happened."
						checked={data.openTracking}
						onChange={(openTracking) => save({ openTracking })}
						disabled={update.isPending}
					/>
					<Row
						title="Click tracking"
						hint="Links go through this server first, then on to where you pointed them."
						checked={data.clickTracking}
						onChange={(clickTracking) => save({ clickTracking })}
						disabled={update.isPending}
					/>
					<Row
						title="Attachment tracking"
						hint="Records downloads of attachments shared by link."
						checked={data.attachmentTracking}
						onChange={(attachmentTracking) => save({ attachmentTracking })}
						disabled={update.isPending}
					/>
					<div className="py-2.5">
						<Row
							title="Add a tracking disclosure"
							hint="A small line at the end of tracked messages, telling recipients that opens and clicks may be measured."
							checked={data.disclosureEnabled}
							onChange={(disclosureEnabled) => save({ disclosureEnabled })}
							disabled={update.isPending}
						/>
						{data.disclosureEnabled && (
							<form
								className="mt-1 flex flex-wrap items-end gap-2"
								onSubmit={(e) => {
									e.preventDefault();
									save({ disclosureText: text.trim() || null });
								}}
							>
								<label className="min-w-0 flex-1">
									<span className="mb-1 block text-xs font-medium text-text-secondary">Disclosure text</span>
									<input
										value={text}
										onChange={(e) => setText(e.target.value)}
										maxLength={300}
										placeholder={DEFAULT_TRACKING_DISCLOSURE}
										className="h-9 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-ring/30 touch:h-11"
									/>
								</label>
								<button
									type="submit"
									disabled={update.isPending || (text.trim() || null) === (data.disclosureText ?? null)}
									className="inline-flex h-9 shrink-0 items-center rounded-[6px] bg-accent px-3.5 text-[13px] font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50 touch:h-11"
								>
									Save text
								</button>
								{!anyTracking && (
									<p className="w-full text-[11px] text-text-tertiary">
										Only added while open or click tracking is on.
									</p>
								)}
							</form>
						)}
					</div>
				</div>
			)}
		</section>
	);
}
