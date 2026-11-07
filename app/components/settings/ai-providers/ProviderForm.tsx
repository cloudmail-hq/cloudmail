// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Add / edit an AI gateway. The token is write-only: never prefilled, sent
 * once in the save body, and cleared from state as soon as the save lands.
 */

import { ChevronDown, ChevronRight, Loader2, Plus, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { toast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { useCreateAiProvider, useUpdateAiProvider, type ProviderView } from "~/queries/ai-providers";
import { ApiError } from "~/services/api";
import { AUTH_SCHEMES, type AuthScheme } from "../../../../shared/ai-providers";
import { apiBaseFor, defaultAuthScheme, suggestWire, type Wire } from "../../../../shared/ai-gateway";
import { validatePublicHttpsUrl } from "../../../../shared/outbound-url";
import { InlineError, PRIMARY_BUTTON_CLASS, ROW_ICON_ACTION_CLASS, SECONDARY_BUTTON_CLASS, SETTINGS_INPUT_CLASS, SettingsField } from "../settings-ui";
import {
	AUTH_SCHEME_LABELS,
	buildAuth,
	formFieldOf,
	headerRowProblem,
	headerRowsFrom,
	headersPayload,
	MAX_HEADERS,
	tokenField,
	WIRE_LABELS,
	type FormField,
	type HeaderRow,
	type TokenAction,
} from "./logic";
import { DIALOG_TOUCH_CLOSE, RADIO_CLASS, RADIO_ROW_CLASS, SELECT_CLASS, TOUCH } from "./shared";

const WIRES: Wire[] = ["anthropic", "openai"];

export function ProviderForm({ provider, onClose }: { provider: ProviderView | null; onClose: () => void }) {
	const mode = provider ? "edit" : "create";
	const create = useCreateAiProvider();
	const update = useUpdateAiProvider();
	const pending = create.isPending || update.isPending;
	// One key per dialog: a double submit or retry after a dropped response creates one provider.
	const idempotencyKey = useRef(crypto.randomUUID());

	const [label, setLabel] = useState(provider?.label ?? "");
	const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
	const [urlTouched, setUrlTouched] = useState(false);
	const [wire, setWire] = useState<Wire | null>(provider?.wire ?? null);
	const [exact, setExact] = useState(provider?.exactBaseUrl ?? false);
	const [customPorts, setCustomPorts] = useState(provider?.options.allowCustomPorts ?? false);
	const [schemePicked, setSchemePicked] = useState<AuthScheme | null>(provider?.auth.scheme ?? null);
	const [customHeader, setCustomHeader] = useState(provider?.auth.scheme === "custom" ? provider.auth.header : "");
	const [token, setToken] = useState("");
	const [tokenAction, setTokenAction] = useState<TokenAction>(provider?.tokenSet ? "keep" : "replace");
	const [headers, setHeaders] = useState<HeaderRow[]>(() => headerRowsFrom(provider?.headers ?? []));
	const [headersOpen, setHeadersOpen] = useState((provider?.headers.length ?? 0) > 0);
	const [advancedOpen, setAdvancedOpen] = useState(!!(provider?.exactBaseUrl || provider?.options.allowCustomPorts));
	const [fieldErrors, setFieldErrors] = useState<Partial<Record<FormField, string>>>({});
	const [error, setError] = useState<string | null>(null);

	const wireId = useId();
	const authId = useId();
	const headersId = useId();
	const advancedId = useId();

	const urlCheck = baseUrl.trim() ? validatePublicHttpsUrl(baseUrl, { purpose: "ai-gateway", allowCustomPorts: customPorts }) : null;
	const urlError = (urlTouched && urlCheck && !urlCheck.ok ? urlCheck.error : null) ?? fieldErrors.baseUrl ?? null;
	const suggestion = urlCheck?.ok ? suggestWire(baseUrl) : null;
	// The default follows wire and host until the admin picks a scheme.
	const scheme: AuthScheme = schemePicked ?? (wire ? defaultAuthScheme(wire, baseUrl) : "bearer");
	const auth = buildAuth(scheme, customHeader);
	let preview: string | null = null;
	if (urlCheck?.ok && wire) {
		try {
			preview = apiBaseFor(baseUrl.trim(), wire, exact);
		} catch {
			preview = null;
		}
	}
	const headerProblems = headers.map((row) => headerRowProblem(row, auth, headers));

	function setRow(i: number, patch: Partial<HeaderRow>) {
		setHeaders((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setFieldErrors({});
		setUrlTouched(true);
		if (!label.trim()) return setFieldErrors({ label: "Give it a name." });
		if (!urlCheck?.ok) return setFieldErrors({ baseUrl: urlCheck?.error ?? "Enter a URL." });
		if (!wire) return setFieldErrors({ wire: "Pick the API it speaks." });
		if (scheme === "custom" && !customHeader.trim()) return setFieldErrors({ auth: "Name the header." });
		if (headerProblems.some(Boolean)) {
			setHeadersOpen(true);
			return setFieldErrors({ headers: "Fix the headers above." });
		}
		const body = {
			label: label.trim(),
			wire,
			baseUrl: baseUrl.trim(),
			exactBaseUrl: exact,
			auth,
			headers: headersPayload(headers),
			options: { allowCustomPorts: customPorts },
			...tokenField(mode, tokenAction, token),
		};
		try {
			if (provider) await update.mutateAsync({ id: provider.id, patch: body });
			else await create.mutateAsync({ input: body, idempotencyKey: idempotencyKey.current });
			setToken("");
			setHeaders((rows) => rows.map((r) => (r.secret ? { ...r, value: "" } : r)));
			toast.success(provider ? "Provider saved" : "Provider added");
			onClose();
		} catch (err) {
			if (err instanceof ApiError) {
				const field = formFieldOf(err.body.field);
				if (field) {
					setFieldErrors({ [field]: err.message });
					if (field === "headers") setHeadersOpen(true);
				} else setError(err.message);
			} else setError("Couldn't save the provider.");
		}
	}

	return (
		<Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
			<DialogContent
				className={cn("max-h-[90dvh] max-w-lg overflow-y-auto max-sm:max-w-[calc(100vw-1.5rem)] max-sm:p-4", DIALOG_TOUCH_CLOSE)}
			>
				<form onSubmit={submit} className="space-y-4" noValidate autoComplete="off">
					<DialogHeader className="pr-8 text-left">
						<DialogTitle className="text-base">{provider ? "Edit provider" : "Add provider"}</DialogTitle>
						<DialogDescription className="text-xs">An Anthropic- or OpenAI-compatible gateway.</DialogDescription>
					</DialogHeader>

					<SettingsField
						label="Name"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						placeholder="Company gateway"
						maxLength={60}
						error={fieldErrors.label}
						autoFocus
						inputClassName="touch:h-11"
					/>

					<SettingsField
						label="Base URL"
						type="url"
						inputMode="url"
						value={baseUrl}
						onChange={(e) => setBaseUrl(e.target.value)}
						onBlur={() => setUrlTouched(true)}
						placeholder="https://llm.example.com"
						error={urlError}
						spellCheck={false}
						inputClassName="touch:h-11"
						hint={
							preview ? (
								<span>
									API base <span className="break-all font-mono text-text-secondary">{preview}</span>
								</span>
							) : undefined
						}
					/>

					<fieldset className="space-y-2" aria-describedby={fieldErrors.wire ? `${wireId}-err` : undefined}>
						<legend className="text-[11px] font-medium text-text-secondary">API</legend>
						<div className="grid gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="API">
							{WIRES.map((w) => (
								<label
									key={w}
									className={cn(RADIO_ROW_CLASS, "items-center")}
								>
									<input
										type="radio"
										name={wireId}
										className={cn(RADIO_CLASS, "mt-0")}
										checked={wire === w}
										onChange={() => setWire(w)}
									/>
									<span className="text-xs font-medium text-text-primary">{WIRE_LABELS[w]}</span>
								</label>
							))}
						</div>
						{suggestion && suggestion !== wire ? (
							<p className="flex flex-wrap items-center gap-x-2 text-xs text-text-tertiary">
								Suggested from the host: {WIRE_LABELS[suggestion]}
								<button
									type="button"
									onClick={() => setWire(suggestion)}
									className="rounded-[4px] px-1 font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50 touch:min-h-11"
								>
									Use
								</button>
							</p>
						) : null}
						{fieldErrors.wire ? (
							<p id={`${wireId}-err`} className="text-[11px] text-destructive">
								{fieldErrors.wire}
							</p>
						) : null}
					</fieldset>

					<div className="space-y-4">
						<div className="space-y-1.5">
							<label htmlFor={authId} className="block text-[11px] font-medium text-text-secondary">
								Auth
							</label>
							<select
								id={authId}
								value={scheme}
								onChange={(e) => setSchemePicked(e.target.value as AuthScheme)}
								className={cn(SELECT_CLASS, "px-3")}
							>
								{AUTH_SCHEMES.map((s) => (
									<option key={s} value={s}>
										{AUTH_SCHEME_LABELS[s]}
									</option>
								))}
							</select>
						</div>
						{scheme === "custom" ? (
							<SettingsField
								label="Header name"
								value={customHeader}
								onChange={(e) => setCustomHeader(e.target.value)}
								placeholder="X-Gateway-Key"
								spellCheck={false}
								error={fieldErrors.auth}
								inputClassName="touch:h-11"
							/>
						) : null}
					</div>
					{scheme !== "custom" && fieldErrors.auth ? <p className="text-[11px] text-destructive">{fieldErrors.auth}</p> : null}

					{scheme === "none" ? null : provider?.tokenSet && tokenAction !== "replace" ? (
						<div className="space-y-1.5">
							<p className="text-[11px] font-medium text-text-secondary">Token</p>
							<div className="flex flex-wrap items-center gap-2">
								<span className={cn("text-sm", tokenAction === "clear" ? "text-text-tertiary line-through" : "text-text-primary")}>
									Token set ({provider.tokenHint ?? "…"})
								</span>
								<button type="button" onClick={() => setTokenAction("replace")} className={cn(SECONDARY_BUTTON_CLASS, "h-8", TOUCH)}>
									Replace
								</button>
								<button
									type="button"
									onClick={() => setTokenAction(tokenAction === "clear" ? "keep" : "clear")}
									className={cn(SECONDARY_BUTTON_CLASS, "h-8", TOUCH)}
								>
									{tokenAction === "clear" ? "Keep" : "Clear"}
								</button>
							</div>
							{fieldErrors.token ? <p className="text-[11px] text-destructive">{fieldErrors.token}</p> : null}
						</div>
					) : (
						<div className="flex items-end gap-2">
							<SettingsField
								className="min-w-0 flex-1"
								label="Token"
								type="password"
								autoComplete="new-password"
								spellCheck={false}
								value={token}
								onChange={(e) => setToken(e.target.value)}
								placeholder={provider?.tokenSet ? "New token" : "Paste the key"}
								error={fieldErrors.token}
								inputClassName="touch:h-11"
							/>
							{provider?.tokenSet ? (
								<button
									type="button"
									onClick={() => {
										setToken("");
										setTokenAction("keep");
									}}
									className={cn(SECONDARY_BUTTON_CLASS, TOUCH)}
								>
									Cancel
								</button>
							) : null}
						</div>
					)}

					<Disclosure
						id={headersId}
						open={headersOpen}
						onToggle={() => setHeadersOpen((v) => !v)}
						label={`Extra headers${headers.length ? ` (${headers.length})` : ""}`}
					>
						<ul className="space-y-2">
							{headers.map((row, i) => (
								<li key={i} className="space-y-1">
									<div className="flex flex-wrap items-center gap-1.5 sm:flex-nowrap">
										<input
											aria-label={`Header ${i + 1} name`}
											value={row.name}
											onChange={(e) => setRow(i, { name: e.target.value })}
											placeholder="Name"
											spellCheck={false}
											aria-invalid={headerProblems[i] ? true : undefined}
											className={cn(SETTINGS_INPUT_CLASS, "min-w-0 flex-1 basis-[40%] touch:h-11")}
										/>
										<input
											aria-label={`Header ${i + 1} value`}
											type={row.secret ? "password" : "text"}
											autoComplete={row.secret ? "new-password" : "off"}
											value={row.value}
											onChange={(e) => setRow(i, { value: e.target.value })}
											placeholder={row.stored ? "Set. Leave blank to keep" : "Value"}
											spellCheck={false}
											className={cn(SETTINGS_INPUT_CLASS, "min-w-0 flex-1 basis-[40%] touch:h-11")}
										/>
										<label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 px-1 text-xs text-text-secondary touch:min-h-11">
											<input
												type="checkbox"
												className="h-4 w-4 accent-accent"
												checked={row.secret}
												onChange={(e) => setRow(i, { secret: e.target.checked, stored: e.target.checked && row.stored })}
											/>
											Secret
										</label>
										<button
											type="button"
											aria-label={`Remove header ${row.name || i + 1}`}
											onClick={() => setHeaders((rows) => rows.filter((_, j) => j !== i))}
											className={cn(ROW_ICON_ACTION_CLASS, "touch:h-11 touch:w-11")}
										>
											<X size={14} aria-hidden />
										</button>
									</div>
									{headerProblems[i] ? <p className="text-[11px] text-destructive">{headerProblems[i]}</p> : null}
								</li>
							))}
						</ul>
						{headers.length < MAX_HEADERS ? (
							<button
								type="button"
								onClick={() => setHeaders((rows) => [...rows, { name: "", value: "", secret: false, stored: false }])}
								className={cn(SECONDARY_BUTTON_CLASS, "h-8", TOUCH)}
							>
								<Plus size={13} aria-hidden />
								Add header
							</button>
						) : null}
						{fieldErrors.headers ? <p className="text-[11px] text-destructive">{fieldErrors.headers}</p> : null}
					</Disclosure>

					<Disclosure id={advancedId} open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)} label="Advanced">
						<CheckRow checked={exact} onChange={setExact} label="Use base URL exactly as entered" />
						<CheckRow checked={customPorts} onChange={setCustomPorts} label="Allow a port other than 443" />
					</Disclosure>

					<InlineError message={error} />

					<div className="flex justify-end gap-2">
						<button type="button" onClick={onClose} disabled={pending} className={cn(SECONDARY_BUTTON_CLASS, TOUCH)}>
							Cancel
						</button>
						<button type="submit" disabled={pending} className={cn(PRIMARY_BUTTON_CLASS, TOUCH)}>
							{pending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
							Save
						</button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function Disclosure({
	id,
	open,
	onToggle,
	label,
	children,
}: {
	id: string;
	open: boolean;
	onToggle: () => void;
	label: string;
	children: React.ReactNode;
}) {
	return (
		// Flex gap, not space-y: a hidden panel takes no gap, so a closed row is
		// exactly as tall as its button and the rows stay evenly spaced.
		<div className="flex flex-col items-stretch gap-2">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={id}
				onClick={onToggle}
				className="inline-flex self-start items-center gap-1 rounded-[6px] px-1 py-1 text-xs font-medium text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50 touch:h-11"
			>
				{open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
				{label}
			</button>
			<div id={id} hidden={!open} className="space-y-2">
				{children}
			</div>
		</div>
	);
}

function CheckRow({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
	return (
		<label className="flex cursor-pointer items-center gap-2 text-xs text-text-primary touch:min-h-11">
			<input type="checkbox" className="h-4 w-4 accent-accent" checked={checked} onChange={(e) => onChange(e.target.checked)} />
			{label}
		</label>
	);
}
