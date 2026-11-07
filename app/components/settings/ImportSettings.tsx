// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox settings > Import.
 *
 * Bring old mail in from a file (mbox, Google Takeout's mbox, a zip of .eml,
 * or one .eml) or straight from an IMAP account. Imports run in the
 * background and survive closing the tab; this section shows their progress
 * and can pause, resume or cancel them. Saves nothing through the page's Save
 * button.
 */

import { Pause, Play, Upload, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { isTerminalImportStatus, type ImportJobView } from "shared/mail-import";
import { errorMessage, showToast } from "~/lib/toast";
import { sourceForFile, uploadImportFile, useImportAction, useImports, useStartImapImport } from "~/queries/import";

const INPUT =
	"h-9 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-ring/30 touch:h-11";
const PRIMARY =
	"inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[6px] bg-accent px-3.5 text-[13px] font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50 touch:h-11";
const SECONDARY =
	"inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[6px] border border-border bg-card px-3 text-[13px] font-medium text-text-primary hover:bg-bg-muted disabled:opacity-50 touch:h-11";

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const STATUS_LABEL: Record<ImportJobView["status"], string> = {
	uploading: "Uploading",
	queued: "Waiting to start",
	running: "Importing",
	paused: "Paused",
	completed: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
};

function percent(job: ImportJobView): number | null {
	if (job.status === "completed") return 100;
	if (job.status === "uploading" && job.upload) {
		return job.upload.parts_total ? Math.round((job.upload.parts_uploaded / job.upload.parts_total) * 100) : 0;
	}
	if (job.progress.total) return Math.min(99, Math.round((job.progress.done / job.progress.total) * 100));
	return null;
}

function JobRow({ job, mailboxId }: { job: ImportJobView; mailboxId: string }) {
	const action = useImportAction(mailboxId);
	const pct = percent(job);
	const { imported, duplicates, failed, skipped } = job.counts;
	const run = (a: "pause" | "resume" | "cancel") =>
		action.mutate(
			{ id: job.id, action: a },
			{ onError: (err) => showToast({ kind: "error", message: errorMessage(err, "Could not update the import.") }) },
		);
	const terminal = isTerminalImportStatus(job.status);
	return (
		<li className="py-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<p className="truncate text-sm font-medium text-text-primary" title={job.label}>
						{job.label}
					</p>
					<p className="mt-0.5 text-[12px] text-text-secondary">
						{STATUS_LABEL[job.status]}
						{job.imap?.current_folder && job.status === "running" ? ` · ${job.imap.current_folder}` : ""}
						{" · "}
						{imported.toLocaleString()} imported
						{duplicates > 0 && `, ${duplicates.toLocaleString()} already here`}
						{failed > 0 && `, ${failed.toLocaleString()} failed`}
						{skipped > 0 && `, ${skipped.toLocaleString()} skipped`}
						{job.size_bytes ? ` · ${formatBytes(job.size_bytes)}` : ""}
					</p>
				</div>
				{!terminal && (
					<div className="flex gap-1.5">
						{job.status === "paused" ? (
							<button type="button" className={SECONDARY} onClick={() => run("resume")} disabled={action.isPending}>
								<Play size={13} aria-hidden /> Resume
							</button>
						) : job.status !== "uploading" ? (
							<button type="button" className={SECONDARY} onClick={() => run("pause")} disabled={action.isPending}>
								<Pause size={13} aria-hidden /> Pause
							</button>
						) : null}
						<button
							type="button"
							className={SECONDARY}
							onClick={() => run("cancel")}
							disabled={action.isPending}
							aria-label={`Cancel import of ${job.label}`}
						>
							<X size={13} aria-hidden /> Cancel
						</button>
					</div>
				)}
			</div>
			{!terminal && (
				<div
					className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-muted"
					role="progressbar"
					aria-label={`Progress of ${job.label}`}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={pct ?? undefined}
				>
					<div
						className={`h-full rounded-full bg-accent transition-[width] ${pct === null ? "w-1/3 animate-pulse" : ""}`}
						style={pct === null ? undefined : { width: `${pct}%` }}
					/>
				</div>
			)}
			{job.last_error && (
				<p className={`mt-1.5 text-[12px] ${job.status === "failed" ? "text-destructive" : "text-text-tertiary"}`}>
					{job.last_error}
				</p>
			)}
		</li>
	);
}

function FileImport({ mailboxId, onStarted }: { mailboxId: string; onStarted: () => void }) {
	const id = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<File | null>(null);
	const [folder, setFolder] = useState<"archive" | "inbox">("archive");
	const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const unsupported = file ? sourceForFile(file.name) === null : false;

	const start = async () => {
		if (!file) return;
		const controller = new AbortController();
		abortRef.current = controller;
		setProgress({ sent: 0, total: file.size });
		try {
			await uploadImportFile(mailboxId, file, {
				folder,
				signal: controller.signal,
				onProgress: (sent, total) => setProgress({ sent, total }),
			});
			showToast({ kind: "success", message: `Uploaded ${file.name}. The import runs in the background.` });
			setFile(null);
			if (inputRef.current) inputRef.current.value = "";
		} catch (err) {
			if (!controller.signal.aborted) showToast({ kind: "error", message: errorMessage(err, "The upload failed.") });
		} finally {
			setProgress(null);
			abortRef.current = null;
			onStarted();
		}
	};

	return (
		<div className="space-y-3">
			<div>
				<label htmlFor={`${id}-file`} className="mb-1 block text-xs font-medium text-text-secondary">
					File
				</label>
				<input
					id={`${id}-file`}
					ref={inputRef}
					type="file"
					accept=".mbox,.mbx,.zip,.eml,application/mbox,application/zip,message/rfc822"
					onChange={(e) => setFile(e.target.files?.[0] ?? null)}
					disabled={!!progress}
					aria-describedby={`${id}-file-hint`}
					className="block w-full text-sm text-text-secondary file:mr-3 file:h-9 file:rounded-[6px] file:border file:border-border file:bg-card file:px-3 file:text-[13px] file:font-medium file:text-text-primary hover:file:bg-bg-muted touch:file:h-11"
				/>
				<p id={`${id}-file-hint`} className={`mt-1 text-[11px] ${unsupported ? "text-destructive" : "text-text-tertiary"}`}>
					{unsupported
						? "Choose an .mbox, .zip or .eml file."
						: "An .mbox (Google Takeout's Mail export is one; unzip it first), a .zip of .eml files, or a single .eml. Up to 50 GB."}
				</p>
			</div>
			<fieldset>
				<legend className="mb-1 text-xs font-medium text-text-secondary">Mail without Gmail labels goes to</legend>
				<div className="flex gap-4">
					{(["archive", "inbox"] as const).map((f) => (
						<label key={f} className="inline-flex min-h-11 items-center gap-2 text-sm text-text-primary">
							<input
								type="radio"
								name={`${id}-folder`}
								value={f}
								checked={folder === f}
								onChange={() => setFolder(f)}
								disabled={!!progress}
								className="accent-accent"
							/>
							{f === "archive" ? "Archive" : "Inbox"}
						</label>
					))}
				</div>
			</fieldset>
			{progress ? (
				<div className="space-y-1.5">
					<div
						className="h-1.5 overflow-hidden rounded-full bg-bg-muted"
						role="progressbar"
						aria-label="Upload progress"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round((progress.sent / Math.max(1, progress.total)) * 100)}
					>
						<div className="h-full rounded-full bg-accent" style={{ width: `${(progress.sent / Math.max(1, progress.total)) * 100}%` }} />
					</div>
					<div className="flex items-center justify-between gap-2">
						<p className="text-[12px] text-text-secondary" aria-live="polite">
							Uploading {formatBytes(progress.sent)} of {formatBytes(progress.total)}. Keep this tab open until the upload finishes.
						</p>
						<button type="button" className={SECONDARY} onClick={() => abortRef.current?.abort()}>
							Stop upload
						</button>
					</div>
				</div>
			) : (
				<button type="button" className={PRIMARY} disabled={!file || unsupported} onClick={start}>
					<Upload size={13} aria-hidden /> Upload and import
				</button>
			)}
		</div>
	);
}

function ImapImport({ mailboxId }: { mailboxId: string }) {
	const id = useId();
	const startImap = useStartImapImport(mailboxId);
	const [host, setHost] = useState("");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault();
				startImap.mutate(
					{ host: host.trim(), username: username.trim(), password },
					{
						onSuccess: () => {
							setPassword("");
							showToast({ kind: "success", message: "Import started. It runs in the background." });
						},
						onError: (err) => showToast({ kind: "error", message: errorMessage(err, "Could not start the import.") }),
					},
				);
			}}
		>
			<div className="grid gap-3 sm:grid-cols-3">
				<label className="block">
					<span className="mb-1 block text-xs font-medium text-text-secondary">IMAP server</span>
					<input className={INPUT} value={host} onChange={(e) => setHost(e.target.value)} placeholder="imap.example.com" autoComplete="off" required />
				</label>
				<label className="block">
					<span className="mb-1 block text-xs font-medium text-text-secondary">Username</span>
					<input className={INPUT} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
				</label>
				<label className="block">
					<span className="mb-1 block text-xs font-medium text-text-secondary">App password</span>
					<input
						className={INPUT}
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						autoComplete="new-password"
						aria-describedby={`${id}-imap-hint`}
						required
					/>
				</label>
			</div>
			<p id={`${id}-imap-hint`} className="text-[11px] text-text-tertiary">
				Connects over TLS on port 993 and only reads: nothing on the old account is changed or deleted. Use an app
				password (Gmail, iCloud and Outlook require one). It is stored encrypted while the import runs and deleted when it
				ends. Folders become labels; Inbox, Sent, Spam and Trash keep their place. Drafts are not imported.
			</p>
			<button type="submit" className={PRIMARY} disabled={startImap.isPending || !host || !username || !password}>
				Start IMAP import
			</button>
		</form>
	);
}

export default function ImportSettingsSection({ mailboxId }: { mailboxId: string }) {
	const { data, isPending, refetch } = useImports(mailboxId);
	const [tab, setTab] = useState<"file" | "imap">("file");
	const jobs = data?.imports ?? [];
	const tabId = useId();
	return (
		<section className="rounded-[8px] border border-border bg-card p-5" aria-labelledby={`${tabId}-title`}>
			<div className="mb-3">
				<h2 id={`${tabId}-title`} className="flex items-center gap-2 text-base font-semibold text-text-primary">
					<Upload size={15} className="text-text-tertiary" aria-hidden />
					Import
				</h2>
				<p className="mt-1 text-sm text-text-secondary">
					Bring in old mail. Dates, threads, read and starred state, and Gmail labels are kept, and messages already here are
					skipped. Imported mail never sends auto-replies, forwards, webhooks or notifications.
				</p>
			</div>

			<div role="tablist" aria-label="Import source" className="mb-3 inline-flex rounded-[6px] border border-border p-0.5">
				{(
					[
						["file", "From a file"],
						["imap", "From IMAP"],
					] as const
				).map(([key, label]) => (
					<button
						key={key}
						type="button"
						role="tab"
						id={`${tabId}-${key}`}
						aria-selected={tab === key}
						aria-controls={`${tabId}-${key}-panel`}
						onClick={() => setTab(key)}
						className={`min-h-9 rounded-[4px] px-3 text-[13px] font-medium touch:min-h-11 ${
							tab === key ? "bg-accent text-accent-foreground" : "text-text-secondary hover:bg-bg-muted"
						}`}
					>
						{label}
					</button>
				))}
			</div>

			<div role="tabpanel" id={`${tabId}-${tab}-panel`} aria-labelledby={`${tabId}-${tab}`}>
				{tab === "file" ? <FileImport mailboxId={mailboxId} onStarted={() => refetch()} /> : <ImapImport mailboxId={mailboxId} />}
			</div>

			{isPending ? (
				<div className="mt-4 h-12 animate-pulse rounded-[6px] bg-bg-muted" />
			) : jobs.length > 0 ? (
				<div className="mt-4 border-t border-border/60 pt-1">
					<h3 className="sr-only">Recent imports</h3>
					<ul className="divide-y divide-border/60">
						{jobs.map((job) => (
							<JobRow key={job.id} job={job} mailboxId={mailboxId} />
						))}
					</ul>
				</div>
			) : null}
		</section>
	);
}
