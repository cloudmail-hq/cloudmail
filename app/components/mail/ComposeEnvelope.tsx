/**
 * The From / To / Cc / Bcc / Subject block.
 *
 * Cc and Bcc are revealed independently and can be put away again while empty —
 * the single one-way "Cc/Bcc" link this replaces opened both rows for good, so
 * adding one Cc left a permanently visible Bcc row eating vertical space.
 */

import { useMemo } from "react";
import { cn } from "~/lib/utils";
import RecipientInput from "~/components/mail/RecipientInput";
import { ComposeMetaRow } from "~/components/mail/ComposeWindow";

export interface RecipientFieldErrors {
	to?: string;
	cc?: string;
	bcc?: string;
}

interface ComposeEnvelopeProps {
	fromLabel: string;
	/** Display name shown with each From choice. */
	fromName?: string;
	/** The selected From address. */
	fromEmail?: string;
	/** Mailbox address plus aliases. A picker appears only with two or more. */
	fromOptions?: string[];
	onFromChange?: (email: string) => void;
	/** Display name per From option; an address's product can rename it. */
	fromNameOf?: (email: string) => string | undefined;
	to: string;
	onToChange: (next: string) => void;
	cc: string;
	onCcChange: (next: string) => void;
	bcc: string;
	onBccChange: (next: string) => void;
	showCc: boolean;
	showBcc: boolean;
	onToggleCc: () => void;
	onToggleBcc: () => void;
	subject: string;
	onSubjectChange: (next: string) => void;
	/** Half-typed tokens, so the composer can commit them on send. */
	onPendingChange: (field: "to" | "cc" | "bcc", pending: string) => void;
	ownDomains: string[];
	errors?: RecipientFieldErrors;
	disabled?: boolean;
	/** Off when the composer opens with recipients already set and wants the body. */
	autoFocusTo?: boolean;
}

function FieldToggle({
	label,
	active,
	onClick,
}: {
	label: string;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={cn(
				"rounded-[6px] px-2 py-1 text-[13px] font-medium transition-colors",
				active
					? "bg-bg-muted text-text-primary"
					: "text-text-secondary hover:bg-bg-muted hover:text-text-primary",
			)}
		>
			{label}
		</button>
	);
}

function FieldError({ id, message }: { id: string; message?: string }) {
	if (!message) return null;
	return (
		<p id={id} role="alert" className="px-0.5 pb-1.5 text-xs text-destructive">
			{message}
		</p>
	);
}

export default function ComposeEnvelope({
	fromLabel,
	fromName,
	fromEmail,
	fromOptions = [],
	onFromChange,
	fromNameOf,
	to,
	onToChange,
	cc,
	onCcChange,
	bcc,
	onBccChange,
	showCc,
	showBcc,
	onToggleCc,
	onToggleBcc,
	subject,
	onSubjectChange,
	onPendingChange,
	ownDomains,
	errors,
	disabled,
	autoFocusTo,
}: ComposeEnvelopeProps) {
	// Stable callbacks: RecipientInput reports its pending token from an effect,
	// so a fresh function each render would loop.
	const pendingHandlers = useMemo(
		() => ({
			to: (pending: string) => onPendingChange("to", pending),
			cc: (pending: string) => onPendingChange("cc", pending),
			bcc: (pending: string) => onPendingChange("bcc", pending),
		}),
		[onPendingChange],
	);

	return (
		<div className="shrink-0 border-b border-border bg-card">
			{fromOptions.length > 1 && onFromChange ? (
				<ComposeMetaRow label="From" htmlFor="compose-from">
					<select
						id="compose-from"
						value={fromEmail}
						disabled={disabled}
						onChange={(e) => onFromChange(e.target.value)}
						className="min-h-11 w-full truncate bg-transparent py-2 text-sm text-text-primary outline-none sm:min-h-0"
					>
						{fromOptions.map((address) => {
							const name = fromNameOf ? fromNameOf(address) : fromName;
							return (
								<option key={address} value={address}>
									{name ? `${name} <${address}>` : address}
								</option>
							);
						})}
					</select>
				</ComposeMetaRow>
			) : (
				<ComposeMetaRow label="From">
					<span className="block truncate py-2 text-sm text-text-secondary">
						{fromLabel}
					</span>
				</ComposeMetaRow>
			)}

			<ComposeMetaRow
				label="To"
				htmlFor="compose-to"
				align="start"
				trailing={
					<div className="flex items-center gap-0.5 pt-1.5">
						<FieldToggle label="Cc" active={showCc} onClick={onToggleCc} />
						<FieldToggle label="Bcc" active={showBcc} onClick={onToggleBcc} />
					</div>
				}
			>
				<RecipientInput
					id="compose-to"
					label="To"
					value={to}
					onChange={onToChange}
					onPendingChange={pendingHandlers.to}
					ownDomains={ownDomains}
					invalid={!!errors?.to}
					describedBy={errors?.to ? "compose-to-error" : undefined}
					disabled={disabled}
					autoFocus={autoFocusTo}
				/>
				<FieldError id="compose-to-error" message={errors?.to} />
			</ComposeMetaRow>

			{showCc && (
				<ComposeMetaRow label="Cc" htmlFor="compose-cc" align="start">
					<RecipientInput
						id="compose-cc"
						label="Cc"
						value={cc}
						onChange={onCcChange}
						onPendingChange={pendingHandlers.cc}
						ownDomains={ownDomains}
						invalid={!!errors?.cc}
						describedBy={errors?.cc ? "compose-cc-error" : undefined}
						disabled={disabled}
						autoFocus
					/>
					<FieldError id="compose-cc-error" message={errors?.cc} />
				</ComposeMetaRow>
			)}

			{showBcc && (
				<ComposeMetaRow label="Bcc" htmlFor="compose-bcc" align="start">
					<RecipientInput
						id="compose-bcc"
						label="Bcc"
						value={bcc}
						onChange={onBccChange}
						onPendingChange={pendingHandlers.bcc}
						ownDomains={ownDomains}
						invalid={!!errors?.bcc}
						describedBy={errors?.bcc ? "compose-bcc-error" : undefined}
						disabled={disabled}
						placeholder="Hidden from other recipients"
						autoFocus
					/>
					<FieldError id="compose-bcc-error" message={errors?.bcc} />
				</ComposeMetaRow>
			)}

			<ComposeMetaRow label="Subject" htmlFor="compose-subject">
				<input
					id="compose-subject"
					value={subject}
					disabled={disabled}
					onChange={(e) => onSubjectChange(e.target.value)}
					placeholder="What's it about?"
					className="w-full bg-transparent px-0.5 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary/75"
				/>
			</ComposeMetaRow>
		</div>
	);
}
