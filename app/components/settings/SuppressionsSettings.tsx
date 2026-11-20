// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → Suppressions.
 *
 * The deployment-wide list of addresses that sequences, template sends and
 * non-transactional API sends skip. Unsubscribe links and hard bounces fill it
 * automatically; this panel is for looking someone up, adding an address by
 * hand, importing a list from another provider, and undoing a mistake.
 *
 * Administrator-only: it decides who the whole deployment may mail.
 */

import { Ban, Loader2, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
	SUPPRESSION_REASONS,
	describeSuppressionReason,
	type Suppression,
	type SuppressionReason,
} from "shared/suppressions";
import { formatRelativeTime, looksLikeEmail } from "~/lib/auth-helpers";
import { toast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import {
	useAddSuppression,
	useDeleteSuppression,
	useImportSuppressions,
	useSuppressions,
} from "~/queries/suppressions";
import {
	ConfirmDialog,
	InlineError,
	ListRow,
	Pill,
	PRIMARY_BUTTON_CLASS,
	ROW_ICON_ACTION_CLASS,
	SECONDARY_BUTTON_CLASS,
	SectionHeading,
	SETTINGS_INPUT_CLASS,
} from "./settings-ui";

const PAGE_SIZE = 25;

/**
 * Inputs get their 44px on touch here. Buttons and selects get it from the
 * global `touch:` floor in `app/index.css`.
 */
const TOUCH_INPUT = "touch:h-11";

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : "Something went wrong";
}

function reasonTone(reason: string): "warning" | "muted" | "violet" {
	if (reason === "hard_bounce" || reason === "complaint") return "warning";
	if (reason === "unsubscribed") return "violet";
	return "muted";
}

export default function SuppressionsSettings() {
	const [query, setQuery] = useState("");
	const [debounced, setDebounced] = useState("");
	const [reason, setReason] = useState<string>("");
	const [offset, setOffset] = useState(0);
	const [pendingDelete, setPendingDelete] = useState<Suppression | null>(null);

	useEffect(() => {
		const t = setTimeout(() => {
			setDebounced(query.trim());
			setOffset(0);
		}, 250);
		return () => clearTimeout(t);
	}, [query]);

	const { data, isLoading, isFetching, error } = useSuppressions({
		q: debounced || undefined,
		reason: reason || undefined,
		limit: PAGE_SIZE,
		offset,
	});
	const remove = useDeleteSuppression();

	const total = data?.total ?? 0;
	const items = data?.items ?? [];
	const searchId = useId();
	const reasonId = useId();

	return (
		<section className="space-y-3">
			<SectionHeading icon={Ban} title="Suppressions" busy={isFetching && !isLoading} />
			<p className="text-sm text-text-secondary">
				Sequences, template sends and API sends marked non-transactional skip these
				addresses. Unsubscribe links and hard bounces add to it automatically.
				Replies you write yourself are never blocked; the composer warns instead.
			</p>

			<AddSuppressionForm />
			<ImportSuppressions />

			<div className="rounded-[8px] bg-card ring-1 ring-border">
				<div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row sm:items-center">
					<label htmlFor={searchId} className="sr-only">
						Search suppressed addresses
					</label>
					<div className="relative min-w-0 flex-1">
						<Search
							size={14}
							className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
							aria-hidden
						/>
						<input
							id={searchId}
							type="search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search addresses"
							className={cn(SETTINGS_INPUT_CLASS, TOUCH_INPUT, "pl-8")}
						/>
					</div>
					<label htmlFor={reasonId} className="sr-only">
						Filter by reason
					</label>
					<select
						id={reasonId}
						value={reason}
						onChange={(e) => {
							setReason(e.target.value);
							setOffset(0);
						}}
						className={cn(SETTINGS_INPUT_CLASS, "sm:w-44")}
					>
						<option value="">All reasons</option>
						{SUPPRESSION_REASONS.map((r) => (
							<option key={r} value={r}>
								{describeSuppressionReason(r)}
							</option>
						))}
					</select>
				</div>

				{error ? (
					<p role="alert" className="p-4 text-sm text-destructive">
						{errorText(error)}
					</p>
				) : isLoading ? (
					<div className="space-y-2 p-4" aria-busy="true" aria-label="Loading suppressions">
						{[0, 1, 2].map((i) => (
							<div key={i} className="h-10 animate-pulse rounded-[6px] bg-bg-muted" />
						))}
					</div>
				) : items.length === 0 ? (
					<p className="p-6 text-center text-sm text-text-secondary">
						{debounced || reason ? "No suppressed addresses match." : "Nobody is suppressed yet."}
					</p>
				) : (
					<ul className="space-y-1.5 p-2 sm:p-3">
						{items.map((item) => (
							<ListRow
								key={item.id}
								title={item.address}
								badges={
									<Pill tone={reasonTone(item.reason)}>
										{describeSuppressionReason(item.reason as SuppressionReason)}
									</Pill>
								}
								details={[
									item.scope === "global" ? "All domains" : item.scope,
									`added ${formatRelativeTime(item.created_at)}`,
									item.source,
								]}
								actions={
									<button
										type="button"
										onClick={() => setPendingDelete(item)}
										className={cn(ROW_ICON_ACTION_CLASS, "hover:text-destructive")}
										aria-label={`Remove ${item.address} from suppressions`}
										title="Remove"
									>
										<Trash2 size={14} aria-hidden />
									</button>
								}
							/>
						))}
					</ul>
				)}

				{total > PAGE_SIZE ? (
					<div className="flex items-center justify-between gap-2 border-t border-border p-3 text-xs text-text-secondary">
						<span aria-live="polite">
							{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
						</span>
						<div className="flex gap-2">
							<button
								type="button"
								className={SECONDARY_BUTTON_CLASS}
								disabled={offset === 0}
								onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
							>
								Previous
							</button>
							<button
								type="button"
								className={SECONDARY_BUTTON_CLASS}
								disabled={offset + PAGE_SIZE >= total}
								onClick={() => setOffset(offset + PAGE_SIZE)}
							>
								Next
							</button>
						</div>
					</div>
				) : null}
			</div>

			<ConfirmDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => !open && setPendingDelete(null)}
				title="Remove from suppressions?"
				description={
					pendingDelete
						? `${pendingDelete.address} will receive sequence and bulk mail${pendingDelete.scope === "global" ? "" : ` from ${pendingDelete.scope}`} again.${pendingDelete.reason === "unsubscribed" ? " They asked to be unsubscribed; only remove this if they asked to come back." : ""}`
						: ""
				}
				confirmLabel="Remove"
				pending={remove.isPending}
				onConfirm={() => {
					if (!pendingDelete) return;
					remove.mutate(pendingDelete.id, {
						onSuccess: () => {
							toast.success(`Removed ${pendingDelete.address}`);
							setPendingDelete(null);
						},
						onError: (e) => toast.error(errorText(e)),
					});
				}}
			/>
		</section>
	);
}

function AddSuppressionForm() {
	const [address, setAddress] = useState("");
	const [scope, setScope] = useState("");
	const [error, setError] = useState<string | null>(null);
	const add = useAddSuppression();
	const addressId = useId();
	const scopeId = useId();

	const onSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const value = address.trim();
		if (!looksLikeEmail(value)) {
			setError("Enter an email address.");
			return;
		}
		setError(null);
		add.mutate(
			{ address: value, scope: scope.trim() || undefined, reason: "manual" },
			{
				onSuccess: (result) => {
					toast.success(result.added > 0 ? `Suppressed ${value}` : `${value} was already suppressed`);
					setAddress("");
				},
				onError: (err) => setError(errorText(err)),
			},
		);
	};

	return (
		<form
			onSubmit={onSubmit}
			className="space-y-2 rounded-[8px] bg-card p-3 ring-1 ring-border sm:p-4"
			aria-label="Add a suppressed address"
		>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
				<div className="min-w-0 flex-1 space-y-1.5">
					<label htmlFor={addressId} className="block text-[11px] font-medium text-text-secondary">
						Address
					</label>
					<input
						id={addressId}
						type="email"
						inputMode="email"
						autoComplete="off"
						value={address}
						onChange={(e) => setAddress(e.target.value)}
						placeholder="someone@example.com"
						aria-invalid={error ? true : undefined}
						className={cn(SETTINGS_INPUT_CLASS, TOUCH_INPUT)}
					/>
				</div>
				<div className="space-y-1.5 sm:w-48">
					<label htmlFor={scopeId} className="block text-[11px] font-medium text-text-secondary">
						Sending domain (blank for all)
					</label>
					<input
						id={scopeId}
						value={scope}
						onChange={(e) => setScope(e.target.value)}
						placeholder="All domains"
						className={cn(SETTINGS_INPUT_CLASS, TOUCH_INPUT)}
					/>
				</div>
				<button type="submit" className={cn(PRIMARY_BUTTON_CLASS, "justify-center")} disabled={add.isPending}>
					{add.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
					Suppress
				</button>
			</div>
			<InlineError message={error} />
		</form>
	);
}

function ImportSuppressions() {
	const fileRef = useRef<HTMLInputElement>(null);
	const importer = useImportSuppressions();
	const [summary, setSummary] = useState<string | null>(null);

	const onFile = async (file: File) => {
		setSummary(null);
		if (file.size > 5_000_000) {
			toast.error("That file is over 5 MB. Split it and import the parts.");
			return;
		}
		const csv = await file.text();
		importer.mutate(
			{ csv },
			{
				onSuccess: (result) => {
					const parts = [`${result.added} added`];
					if (result.existing) parts.push(`${result.existing} already listed`);
					if (result.errorCount) {
						const first = result.errors
							.slice(0, 3)
							.map((e) => `line ${e.line}: ${e.error}`)
							.join("; ");
						parts.push(`${result.errorCount} skipped (${first}${result.errorCount > 3 ? "; …" : ""})`);
					}
					setSummary(parts.join(", "));
				},
				onError: (e) => setSummary(errorText(e)),
			},
		);
	};

	return (
		<div className="flex flex-col gap-2 rounded-[8px] bg-card p-3 ring-1 ring-border sm:flex-row sm:items-center sm:p-4">
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium text-text-primary">Import a CSV</p>
				<p className="text-xs text-text-tertiary">
					One address per line, or columns <code>address,scope,reason</code>. Exports with an{" "}
					<code>email</code> column work too.
				</p>
				{summary ? (
					<p className="mt-1 text-xs text-text-secondary" aria-live="polite">
						{summary}
					</p>
				) : null}
			</div>
			<input
				ref={fileRef}
				type="file"
				accept=".csv,.txt,text/csv,text/plain"
				className="sr-only"
				aria-label="CSV file to import"
				onChange={(e) => {
					const file = e.target.files?.[0];
					if (file) void onFile(file);
					e.target.value = "";
				}}
			/>
			<button
				type="button"
				className={cn(SECONDARY_BUTTON_CLASS, "justify-center")}
				onClick={() => fileRef.current?.click()}
				disabled={importer.isPending}
			>
				{importer.isPending ? (
					<Loader2 size={13} className="animate-spin" aria-hidden />
				) : (
					<Upload size={13} aria-hidden />
				)}
				Choose file
			</button>
		</div>
	);
}
