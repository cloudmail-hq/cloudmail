// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * App branding: the product name, tagline, accent colour and logo.
 *
 * Backed by the instance-wide branding record in R2 (`workers/lib/branding.ts`),
 * so a save here changes the wordmark, the document title and the favicon for
 * everyone on this deployment. This section previously held local state with
 * `setTimeout` fakes and was labelled "not saved yet"; it is now real.
 */

import { useEffect, useRef, useState } from "react";
import { ImageIcon, Loader2, Paintbrush, Trash2, Upload } from "lucide-react";
import {
	APP_NAME_MAX_LENGTH,
	MAX_LOGO_BYTES,
	TAGLINE_MAX_LENGTH,
	brandingLogoUrl,
	useBranding,
	useDeleteBrandingLogo,
	useResetBranding,
	useUpdateBranding,
	useUploadBrandingLogo,
	validateLogoFile,
} from "~/queries/branding";
import { fileToBase64, formatBytes } from "~/lib/utils";
import { toast } from "~/lib/toast";
import { ApiError } from "~/services/api";
import { contrastRatio, INDIGO_ACCENT, MIN_UI_CONTRAST } from "../../../shared/color-contrast";

// Indigo first: it is the app's own accent. Every preset clears 3:1 on white.
const ACCENT_PRESETS = [
	INDIGO_ACCENT,
	"#7C3AED",
	"#15803D",
	"#0369A1",
	"#BE185D",
	"#C2410C",
];

function messageOf(error: unknown, fallback: string): string {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error && error.message) return error.message;
	return fallback;
}

export default function AppBrandingSettings() {
	const { data: branding, isLoading, isError, refetch } = useBranding();
	const updateBranding = useUpdateBranding();
	const uploadLogo = useUploadBrandingLogo();
	const deleteLogo = useDeleteBrandingLogo();
	const resetBranding = useResetBranding();

	const [appName, setAppName] = useState("");
	const [tagline, setTagline] = useState("");
	const [accentColor, setAccentColor] = useState(INDIGO_ACCENT);
	const [error, setError] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	/*
	 * Seed the form from the stored record, and re-seed whenever it changes.
	 *
	 * Keyed on `updatedAt` rather than the individual fields: that is the one
	 * value that moves on every write, so an in-progress edit is not clobbered by
	 * a background refetch that returned identical data, while a successful save
	 * (or a reset) does refresh the inputs.
	 */
	const seededAt = useRef<number | null>(null);
	useEffect(() => {
		if (!branding) return;
		if (seededAt.current === branding.updatedAt) return;
		seededAt.current = branding.updatedAt;
		setAppName(branding.appName);
		setTagline(branding.tagline ?? "");
		setAccentColor(branding.accentColor);
	}, [branding]);

	const logoUrl = brandingLogoUrl(branding);
	const busy =
		updateBranding.isPending ||
		uploadLogo.isPending ||
		deleteLogo.isPending ||
		resetBranding.isPending;

	const trimmedName = appName.trim();
	const dirty =
		!!branding &&
		(trimmedName !== branding.appName ||
			tagline.trim() !== (branding.tagline ?? "") ||
			accentColor.toLowerCase() !== branding.accentColor.toLowerCase());

	const accentContrast = contrastRatio(accentColor, "#FFFFFF");

	async function onSave() {
		setError(null);
		if (!trimmedName) {
			setError("App name can't be empty.");
			return;
		}
		if (trimmedName.length > APP_NAME_MAX_LENGTH) {
			setError(`App name must be ${APP_NAME_MAX_LENGTH} characters or fewer.`);
			return;
		}
		if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(accentColor)) {
			setError("Accent colour must be a hex value like #4F46E5.");
			return;
		}

		try {
			await updateBranding.mutateAsync({
				appName: trimmedName,
				tagline: tagline.trim() || null,
				accentColor,
			});
			toast.success(`Branding saved. The app is now "${trimmedName}".`);
		} catch (e) {
			setError(messageOf(e, "Couldn't save branding."));
		}
	}

	async function onPickLogo(file: File | undefined) {
		// Clear the input so choosing the same file twice still fires a change.
		if (fileInput.current) fileInput.current.value = "";
		if (!file) return;

		setError(null);
		const check = validateLogoFile(file);
		if (!check.valid) {
			setError(check.error ?? "That image can't be used as a logo.");
			return;
		}

		try {
			await uploadLogo.mutateAsync({
				content: await fileToBase64(file),
				filename: file.name,
				type: file.type,
			});
			toast.success("Logo updated.");
		} catch (e) {
			setError(messageOf(e, "Couldn't upload that logo."));
		}
	}

	async function onRemoveLogo() {
		setError(null);
		try {
			await deleteLogo.mutateAsync();
			toast.info("Logo removed. The default mail glyph is back.");
		} catch (e) {
			setError(messageOf(e, "Couldn't remove the logo."));
		}
	}

	async function onResetAll() {
		setError(null);
		try {
			const next = await resetBranding.mutateAsync();
			toast.info(`Branding reset to "${next.appName}".`);
		} catch (e) {
			setError(messageOf(e, "Couldn't reset branding."));
		}
	}

	return (
		<section className="space-y-3">
			<div className="flex items-center gap-2">
				<Paintbrush size={14} className="text-text-tertiary" />
				<h2 className="text-base font-semibold text-text-primary">
					App branding
				</h2>
			</div>

			<div className="space-y-5 rounded-[8px] bg-card p-5 ring-1 ring-border">
				<p className="text-sm text-text-secondary">
					The name and logo appear in the top-nav wordmark, the browser tab title
					and the favicon. This applies to everyone using this deployment.
				</p>

				{isError ? (
					<div className="flex items-center justify-between gap-3 rounded-[6px] bg-bg-subtle px-3 py-2">
						<p className="text-xs text-text-secondary">
							Couldn't load the current branding.
						</p>
						<button
							type="button"
							onClick={() => refetch()}
							className="text-xs font-medium text-text-primary hover:underline"
						>
							Retry
						</button>
					</div>
				) : null}

				{/* Live preview of the wordmark, so the effect of a change is visible
				    before committing to it. */}
				<div className="flex items-center gap-2 rounded-[6px] bg-[#0a0a0a] px-3 py-2.5">
					{logoUrl ? (
						<img
							src={logoUrl}
							alt=""
							className="h-5 w-auto max-w-[120px] object-contain"
						/>
					) : (
						<span
							className="h-3 w-3 rounded-[3px]"
							style={{ backgroundColor: accentColor }}
							aria-hidden
						/>
					)}
					<span className="text-base font-semibold tracking-tight text-white">
						{trimmedName || "Untitled"}
					</span>
					{tagline.trim() ? (
						<span className="truncate text-xs font-light text-white/50">
							{tagline.trim()}
						</span>
					) : null}
				</div>

				{/* -------------------------------- Name ------------------------------ */}
				<div className="space-y-2">
					<label
						htmlFor="branding-app-name"
						className="block text-xs font-medium uppercase tracking-wider text-text-tertiary"
					>
						App name
					</label>
					<input
						id="branding-app-name"
						type="text"
						value={appName}
						onChange={(e) => setAppName(e.target.value)}
						maxLength={APP_NAME_MAX_LENGTH}
						disabled={isLoading || busy}
						placeholder="cloudmail"
						className="h-10 w-full max-w-sm rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/30 disabled:opacity-60"
					/>
					<p className="text-xs text-text-tertiary">
						{appName.length}/{APP_NAME_MAX_LENGTH}
					</p>
				</div>

				{/* ------------------------------- Tagline ---------------------------- */}
				<div className="space-y-2">
					<label
						htmlFor="branding-tagline"
						className="block text-xs font-medium uppercase tracking-wider text-text-tertiary"
					>
						Tagline <span className="normal-case">(optional)</span>
					</label>
					<input
						id="branding-tagline"
						type="text"
						value={tagline}
						onChange={(e) => setTagline(e.target.value)}
						maxLength={TAGLINE_MAX_LENGTH}
						disabled={isLoading || busy}
						placeholder="Agentic email for your team"
						className="h-10 w-full max-w-lg rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/30 disabled:opacity-60"
					/>
				</div>

				{/* ------------------------------- Accent ----------------------------- */}
				<div className="space-y-2">
					<label
						htmlFor="branding-accent"
						className="block text-xs font-medium uppercase tracking-wider text-text-tertiary"
					>
						Accent colour
					</label>
					<div className="flex flex-wrap items-center gap-2">
						<input
							id="branding-accent"
							type="color"
							value={accentColor}
							onChange={(e) => setAccentColor(e.target.value)}
							disabled={isLoading || busy}
							className="h-10 w-12 cursor-pointer rounded-[6px] border border-border bg-bg-subtle p-1 disabled:opacity-60"
						/>
						<input
							type="text"
							value={accentColor}
							onChange={(e) => setAccentColor(e.target.value.trim())}
							maxLength={7}
							disabled={isLoading || busy}
							aria-label="Accent colour hex value"
							className="h-10 w-28 rounded-[6px] border border-border bg-card px-3 font-mono text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/30 disabled:opacity-60"
						/>
						{ACCENT_PRESETS.map((preset) => (
							<button
								key={preset}
								type="button"
								onClick={() => setAccentColor(preset)}
								disabled={isLoading || busy}
								aria-label={`Use accent colour ${preset}`}
								aria-pressed={accentColor.toLowerCase() === preset.toLowerCase()}
								className={`h-6 w-6 rounded-full ring-offset-2 ring-offset-card transition-shadow disabled:opacity-60 ${
									accentColor.toLowerCase() === preset.toLowerCase()
										? "ring-2 ring-text-primary"
										: "ring-1 ring-border"
								}`}
								style={{ backgroundColor: preset }}
							/>
						))}
					</div>
					<p className="text-xs text-text-tertiary">
						Used for the wordmark glyph when no logo is uploaded, and as the installed
						app's title-bar colour.
					</p>
					{accentContrast !== null && accentContrast < MIN_UI_CONTRAST ? (
						<p
							role="status"
							className="rounded-[6px] bg-warning-bg px-3 py-2 text-xs text-warning-text ring-1 ring-warning-border"
						>
							{accentColor.toUpperCase()} is {accentContrast.toFixed(2)}:1 against white, below the
							3:1 that icons and the logo need to stay visible. Pick a darker colour, or{" "}
							<button
								type="button"
								onClick={() => setAccentColor(INDIGO_ACCENT)}
								className="font-medium underline hover:no-underline"
							>
								use the app's indigo
							</button>
							.
						</p>
					) : null}
				</div>

				{/* -------------------------------- Logo ------------------------------ */}
				<div className="space-y-2">
					<span className="block text-xs font-medium uppercase tracking-wider text-text-tertiary">
						Company logo
					</span>
					<div className="flex flex-wrap items-center gap-3">
						<div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-border bg-bg-subtle">
							{logoUrl ? (
								<img
									src={logoUrl}
									alt="Current company logo"
									className="h-full w-full object-contain p-1"
								/>
							) : (
								<ImageIcon
									size={18}
									className="text-text-tertiary"
									aria-hidden
								/>
							)}
						</div>

						<div className="flex flex-wrap items-center gap-2">
							{/*
								A hidden input driven by a button rather than a styled
								`<input type="file">`: the native control cannot be restyled
								consistently, and the button keeps keyboard focus visible.
							*/}
							{/*
								`hidden` rather than `sr-only`, plus removed from the tab
								order: `sr-only` keeps the input in the accessibility tree, so
								a screen reader announced both it and the button below as two
								separate ways to do the same thing. The button carries the
								label and opens the picker, so the input is presentational.
							*/}
							<input
								ref={fileInput}
								type="file"
								accept="image/png,image/jpeg,image/webp,image/gif"
								className="hidden"
								tabIndex={-1}
								aria-hidden="true"
								onChange={(e) => onPickLogo(e.target.files?.[0])}
							/>
							<button
								type="button"
								onClick={() => fileInput.current?.click()}
								disabled={busy}
								className="inline-flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
							>
								{uploadLogo.isPending ? (
									<Loader2 size={13} className="animate-spin" aria-hidden />
								) : (
									<Upload size={13} aria-hidden />
								)}
								{logoUrl ? "Replace logo" : "Upload logo"}
							</button>

							{logoUrl ? (
								<button
									type="button"
									onClick={onRemoveLogo}
									disabled={busy}
									className="inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-sm text-text-secondary hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-60"
								>
									<Trash2 size={13} aria-hidden />
									Remove
								</button>
							) : null}
						</div>
					</div>
					<p className="text-xs text-text-tertiary">
						PNG, JPEG, WebP or GIF up to {formatBytes(MAX_LOGO_BYTES)}. A wide
						transparent PNG around 120×40 works best.
						{branding?.logoFilename ? ` Current: ${branding.logoFilename}.` : ""}
					</p>
					<p className="text-xs text-text-tertiary">
						SVG isn't accepted: it can carry script, and the logo is served from
						this app's own origin.
					</p>
				</div>

				{error ? (
					<p className="text-xs text-red-600 dark:text-red-400" role="alert">
						{error}
					</p>
				) : null}

				<div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-4">
					<button
						type="button"
						onClick={onSave}
						disabled={busy || isLoading || !dirty}
						className="inline-flex h-9 items-center gap-1.5 rounded-[6px] bg-accent px-3.5 text-[13px] font-semibold text-accent-foreground hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60 touch:h-11"
					>
						{updateBranding.isPending ? (
							<Loader2 size={13} className="animate-spin" aria-hidden />
						) : null}
						{updateBranding.isPending ? "Saving…" : "Save"}
					</button>
					<button
						type="button"
						onClick={onResetAll}
						disabled={busy || isLoading}
						className="text-sm text-text-secondary hover:text-text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-60"
					>
						Reset to default
					</button>
					{dirty ? (
						<span className="text-xs text-text-tertiary">
							Unsaved changes
						</span>
					) : null}
				</div>
			</div>
		</section>
	);
}
