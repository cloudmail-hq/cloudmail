// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings > Privacy & retention (admin).
 *
 * What the public `/privacy` notice says about the operator, and how long each
 * kind of record is kept. The notice text itself is generated from these
 * fields (`shared/privacy.ts`), so the retention periods it prints are the ones
 * the purge job enforces. One explicit Save: the fields need validating
 * together.
 */

import { ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
	DEFAULT_RETENTION,
	PRIVACY_TEXT_MAX,
	RETENTION_BOUNDS,
	type PrivacySettings,
	type RetentionPolicy,
} from "shared/privacy";
import { toast } from "~/lib/toast";
import { usePrivacySettings, useUpdatePrivacySettings } from "~/queries/privacy";
import { authErrorMessage } from "~/services/auth-api";
import {
	InlineError,
	PRIMARY_BUTTON_CLASS,
	SECONDARY_BUTTON_CLASS,
	SectionHeading,
	SETTINGS_INPUT_CLASS,
	SettingsField,
} from "./settings-ui";

const RETENTION_FIELDS: { key: keyof RetentionPolicy; label: string; hint: string }[] = [
	{ key: "trackingEventsDays", label: "Open and click events", hint: "Default 395 days (13 months)." },
	{ key: "deliveryEventsDays", label: "Delivery events", hint: "Sent, delivered, bounced. Default 395 days." },
	{ key: "agentChatDays", label: "AI assistant chat", hint: "Default 90 days." },
	{ key: "auditLogDays", label: "Audit log", hint: "At least 365 days (DPDP Rule 6)." },
	{ key: "trashDays", label: "Trash", hint: "Default 30 days." },
];

type Draft = Omit<PrivacySettings, "updatedAt">;

function toDraft(s: PrivacySettings): Draft {
	const { updatedAt: _ignored, ...rest } = s;
	return { ...rest, retention: { ...rest.retention } };
}

export default function PrivacySettingsSection() {
	const { data, isPending } = usePrivacySettings();
	const update = useUpdatePrivacySettings();
	const [draft, setDraft] = useState<Draft | null>(null);
	const [error, setError] = useState<string | null>(null);
	const textId = useId();

	useEffect(() => {
		if (data) setDraft(toDraft(data));
	}, [data]);

	if (isPending || !draft || !data) {
		return (
			<section className="space-y-3">
				<SectionHeading icon={ShieldCheck} title="Privacy & retention" busy />
				<div className="h-64 animate-pulse rounded-[8px] bg-bg-muted/60" />
			</section>
		);
	}

	const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value });
	const setDays = (key: keyof RetentionPolicy, raw: string) =>
		setDraft({ ...draft, retention: { ...draft.retention, [key]: raw === "" ? Number.NaN : Number(raw) } });

	const invalid = RETENTION_FIELDS.find(({ key }) => {
		const v = draft.retention[key];
		const { min, max } = RETENTION_BOUNDS[key];
		return !Number.isInteger(v) || v < min || v > max;
	});
	const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(data));

	async function save(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (invalid) {
			const { min, max } = RETENTION_BOUNDS[invalid.key];
			setError(`${invalid.label}: enter a whole number of days from ${min} to ${max}.`);
			return;
		}
		try {
			await update.mutateAsync(draft!);
			toast.success("Privacy settings saved");
		} catch (err) {
			setError(authErrorMessage(err, "Couldn't save the privacy settings."));
		}
	}

	return (
		<section className="space-y-3">
			<SectionHeading icon={ShieldCheck} title="Privacy & retention">
				<a href="/privacy" target="_blank" rel="noreferrer" className={SECONDARY_BUTTON_CLASS}>
					<ExternalLink size={13} aria-hidden />
					View notice
				</a>
			</SectionHeading>

			<form onSubmit={save} className="divide-y divide-border/60 rounded-[8px] bg-card ring-1 ring-border">
				<div className="space-y-4 p-5">
					<div>
						<h3 className="text-sm font-medium text-text-primary">Who runs this service</h3>
						<p className="mt-1 text-sm text-text-secondary">
							Shown on the public privacy notice. Have your notice reviewed by your own counsel; this text is a
							starting point, not legal advice.
						</p>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<SettingsField
							label="Controller (organisation or person)"
							value={draft.controllerName}
							maxLength={200}
							onChange={(e) => set("controllerName", e.target.value)}
						/>
						<SettingsField
							label="Contact (email or address)"
							value={draft.controllerContact}
							maxLength={320}
							onChange={(e) => set("controllerContact", e.target.value)}
						/>
						<SettingsField
							label="Grievance Officer name"
							value={draft.grievanceOfficerName}
							maxLength={200}
							onChange={(e) => set("grievanceOfficerName", e.target.value)}
						/>
						<SettingsField
							label="Grievance Officer email"
							type="email"
							value={draft.grievanceOfficerEmail}
							maxLength={320}
							hint="Required under India's DPDP Act."
							onChange={(e) => set("grievanceOfficerEmail", e.target.value)}
						/>
					</div>
					<SettingsField
						label="Where data is stored"
						value={draft.dataLocation}
						maxLength={400}
						onChange={(e) => set("dataLocation", e.target.value)}
					/>
					<div className="space-y-1.5">
						<label htmlFor={textId} className="block text-[11px] font-medium text-text-secondary">
							Additional text (optional)
						</label>
						<textarea
							id={textId}
							rows={4}
							maxLength={PRIVACY_TEXT_MAX}
							value={draft.additionalText}
							onChange={(e) => set("additionalText", e.target.value)}
							className={`${SETTINGS_INPUT_CLASS} h-auto py-2`}
						/>
						<p className="text-xs text-text-tertiary">Added at the end of the notice. Blank lines start new paragraphs.</p>
					</div>
				</div>

				<div className="space-y-4 p-5">
					<div>
						<h3 className="text-sm font-medium text-text-primary">Retention</h3>
						<p className="mt-1 text-sm text-text-secondary">
							A daily job deletes records older than these periods, in small batches per mailbox.
						</p>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						{RETENTION_FIELDS.map(({ key, label, hint }) => (
							<SettingsField
								key={key}
								label={`${label} (days)`}
								type="number"
								inputMode="numeric"
								min={RETENTION_BOUNDS[key].min}
								max={RETENTION_BOUNDS[key].max}
								value={Number.isNaN(draft.retention[key]) ? "" : String(draft.retention[key])}
								placeholder={String(DEFAULT_RETENTION[key])}
								hint={hint}
								onChange={(e) => setDays(key, e.target.value)}
							/>
						))}
					</div>
				</div>

				<div className="space-y-3 p-5">
					<label className="flex cursor-pointer items-start justify-between gap-3 touch:min-h-11">
						<span className="min-w-0">
							<span className="block text-sm font-medium text-text-primary">
								Track opens and clicks in new mailboxes
							</span>
							<span className="mt-0.5 block text-xs text-text-secondary">
								Existing mailboxes keep their own setting. Each mailbox can change it under Mailbox settings.
							</span>
						</span>
						<input
							type="checkbox"
							checked={draft.trackingDefault}
							onChange={(e) => set("trackingDefault", e.target.checked)}
							className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
						/>
					</label>
				</div>

				<div className="flex flex-wrap items-center gap-3 p-5">
					<button type="submit" disabled={update.isPending || !dirty} className={PRIMARY_BUTTON_CLASS}>
						{update.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
						Save
					</button>
					{data.updatedAt ? (
						<span className="text-xs text-text-tertiary">
							Last updated {new Date(data.updatedAt).toLocaleDateString()}
						</span>
					) : null}
					<InlineError message={error} />
				</div>
			</form>
		</section>
	);
}
