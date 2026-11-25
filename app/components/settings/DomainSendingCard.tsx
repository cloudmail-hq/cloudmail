/**
 * Settings → Domains → (domain) → Sending: which provider this domain's
 * outgoing mail leaves through.
 *
 * Cloudflare Email Service is the default. Amazon SES needs a region, an IAM
 * access key ID and its secret, and (for bounces and complaints) a
 * configuration set publishing to an SNS topic. Resend needs an API key and,
 * for events, its webhook signing secret. Secrets are write-only: the server
 * only says whether one is stored, so the field is empty with a "Stored" badge
 * and a "Replace" button. A domain set to SES or Resend never falls back to
 * Cloudflare, which the card says before saving.
 *
 * Save model: an explicit Save (credentials should not autosave half-typed).
 * Switching to SES or Resend takes effect only once Test connection passes for
 * the saved settings (SES: DKIM verified; Resend: domain verified); until then
 * Save keeps the settings and the domain keeps sending through Cloudflare.
 */

import { CheckCircle2, Loader2, PlugZap, RotateCcw, XCircle } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { errorMessage, showToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import {
	useDomainSending,
	useResetDomainSending,
	useSetDomainSending,
	useTestDomainSending,
} from "~/queries/domains";
import type {
	DomainSendingInput,
	DomainSendingTestInput,
	DomainSendingView,
	ResendTestResult,
	SendingTestResult,
	SesTestResult,
} from "~/services/api";
import {
	RESEND_API_KEY_RE,
	RESEND_WEBHOOK_SECRET_RE,
	SES_ACCESS_KEY_ID_RE,
	SES_CONFIGURATION_SET_RE,
	SES_REGIONS,
	SES_SECRET_ACCESS_KEY_RE,
	accountIdOfTopicArn,
	isSnsTopicArn,
	sesIamPolicy,
	type SendingProvider,
	type SesDnsRecord,
} from "../../../shared/ses-sending";
import {
	ConfirmDialog,
	CopyButton,
	InlineError,
	PRIMARY_BUTTON_CLASS,
	SECONDARY_BUTTON_CLASS,
	SETTINGS_INPUT_CLASS,
} from "./settings-ui";

/** 44px tall on phones, the settings-standard 36px from `sm` up. */
const TOUCH = "min-h-11 sm:min-h-9";
const LABEL = "block text-[11px] font-medium text-text-secondary";

interface Draft {
	provider: SendingProvider;
	region: string;
	accessKeyId: string;
	/** Empty means "keep the stored secret". */
	secret: string;
	configurationSet: string;
	snsTopicArn: string;
	replacingSecret: boolean;
	apiKey: string;
	webhookSecret: string;
}

function draftFrom(view: DomainSendingView | undefined): Draft {
	return {
		provider: view?.provider ?? "cloudflare",
		region: view?.ses?.region ?? "us-east-1",
		// The full key ID is never returned; the user retypes it to change it.
		accessKeyId: "",
		secret: "",
		configurationSet: view?.ses?.configurationSet ?? "cloudmail",
		snsTopicArn: view?.ses?.snsTopicArn ?? "",
		replacingSecret: !view?.ses?.secretStored,
		apiKey: "",
		webhookSecret: "",
	};
}

/** Client-side checks mirroring the server's, so mistakes show at the field. */
function problems(d: Draft, view: DomainSendingView | undefined): Partial<Record<keyof Draft, string>> {
	const out: Partial<Record<keyof Draft, string>> = {};
	if (d.provider === "resend") {
		if (!d.apiKey.trim() && !view?.resend?.apiKeyStored) out.apiKey = "Enter the Resend API key.";
		else if (d.apiKey.trim() && !RESEND_API_KEY_RE.test(d.apiKey.trim())) out.apiKey = "A Resend API key starts with re_.";
		if (d.webhookSecret.trim() && !RESEND_WEBHOOK_SECRET_RE.test(d.webhookSecret.trim()))
			out.webhookSecret = "The signing secret starts with whsec_.";
		return out;
	}
	if (d.provider !== "ses") return out;
	const key = d.accessKeyId.trim();
	const last4 = view?.ses?.accessKeyIdLast4 ?? null;
	// The full key ID is never returned, so every SES save carries it again.
	if (!key) out.accessKeyId = last4 ? `Enter the access key ID ending in ${last4} to save.` : "Enter the access key ID.";
	else if (!SES_ACCESS_KEY_ID_RE.test(key)) out.accessKeyId = "An IAM access key ID is AKIA followed by 16 letters and digits.";
	// The stored secret pairs only with the stored key ID.
	const keyChanged = !!key && !!last4 && !key.endsWith(last4);
	const needSecret = !view?.ses?.secretStored || keyChanged;
	if (!d.secret.trim()) {
		if (needSecret) out.secret = keyChanged ? "A new access key ID needs its secret too." : "Enter the secret access key.";
	} else if (!SES_SECRET_ACCESS_KEY_RE.test(d.secret.trim())) out.secret = "A secret access key is 40 characters.";
	if (d.configurationSet.trim() && !SES_CONFIGURATION_SET_RE.test(d.configurationSet.trim()))
		out.configurationSet = "Letters, digits, - and _ only (up to 64).";
	const arn = d.snsTopicArn.trim();
	if (arn && !isSnsTopicArn(arn)) out.snsTopicArn = "An SNS topic ARN looks like arn:aws:sns:us-east-1:123456789012:cloudmail.";
	else if (arn && arn.split(":")[3] !== d.region) out.snsTopicArn = "The topic must be in the same region as SES.";
	return out;
}

const PROVIDER_NAME: Record<SendingProvider, string> = {
	cloudflare: "Cloudflare",
	ses: "Amazon SES",
	resend: "Resend",
};

export function DomainSendingCard({ domainId, hostname }: { domainId: string; hostname: string }) {
	const { data: view, isLoading, error } = useDomainSending(domainId);
	const save = useSetDomainSending();
	const reset = useResetDomainSending();
	const test = useTestDomainSending();
	const [draft, setDraft] = useState<Draft>(() => draftFrom(undefined));
	const [submitted, setSubmitted] = useState(false);
	const [confirmReset, setConfirmReset] = useState(false);
	const [lastTest, setLastTest] = useState<SendingTestResult | null>(null);
	const [blocked, setBlocked] = useState<string | null>(null);
	const ids = {
		group: useId(),
		region: useId(),
		key: useId(),
		keyHint: useId(),
		secret: useId(),
		secretHint: useId(),
		cs: useId(),
		topic: useId(),
		apiKey: useId(),
		whsec: useId(),
		warn: useId(),
	};

	// Reload the form when the domain or the stored settings change.
	useEffect(() => {
		setDraft(draftFrom(view));
		setSubmitted(false);
	}, [domainId, view?.updatedAt, view?.provider]);
	useEffect(() => {
		setLastTest(null);
		setBlocked(null);
	}, [domainId]);

	const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
	const errs = submitted ? problems(draft, view) : {};
	const storedTest = lastTest ?? view?.lastTest ?? null;
	const policy = useMemo(
		() =>
			JSON.stringify(
				sesIamPolicy(hostname, draft.region, draft.configurationSet.trim() || null, accountIdOfTopicArn(draft.snsTopicArn.trim())),
				null,
				2,
			),
		[hostname, draft.region, draft.configurationSet, draft.snsTopicArn],
	);

	if (isLoading) {
		return <div aria-busy="true" aria-label="Loading sending settings" className="h-24 animate-pulse rounded bg-bg-muted/50" />;
	}
	if (error || !view) return <InlineError message={errorMessage(error, "Couldn't load the sending settings.")} />;

	const ses = draft.provider === "ses";
	const resend = draft.provider === "resend";
	const dirty =
		draft.provider !== view.provider ||
		(ses &&
			(!!draft.accessKeyId.trim() ||
				!!draft.secret.trim() ||
				draft.region !== (view.ses?.region ?? "us-east-1") ||
				draft.configurationSet.trim() !== (view.ses?.configurationSet ?? "") ||
				draft.snsTopicArn.trim() !== (view.ses?.snsTopicArn ?? ""))) ||
		(resend && (!!draft.apiKey.trim() || !!draft.webhookSecret.trim()));

	const onSubmit = (e: FormEvent) => {
		e.preventDefault();
		setSubmitted(true);
		if (Object.keys(problems(draft, view)).length > 0) return;
		let input: DomainSendingInput;
		if (draft.provider === "cloudflare") input = { provider: "cloudflare" };
		else if (draft.provider === "ses") {
			input = {
				provider: "ses",
				region: draft.region,
				accessKeyId: draft.accessKeyId.trim(),
				...(draft.secret.trim() ? { secretAccessKey: draft.secret.trim() } : {}),
				configurationSet: draft.configurationSet.trim() || null,
				snsTopicArn: draft.snsTopicArn.trim() || null,
			};
		} else {
			input = {
				provider: "resend",
				...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
				...(draft.webhookSecret.trim() ? { webhookSecret: draft.webhookSecret.trim() } : {}),
			};
		}
		save.mutate(
			{ id: domainId, input },
			{
				onSuccess: (v) => {
					setLastTest(null);
					setBlocked(v.blockedReason ?? null);
					// Saved: the next Test must check the stored settings (which records
					// the result the switch needs), not re-send the typed secret.
					setDraft((d) => ({ ...d, secret: "", apiKey: "", webhookSecret: "", replacingSecret: false }));
					showToast(
						v.blockedReason
							? { kind: "warning", message: `Saved. ${hostname} keeps sending through Cloudflare until the test passes.` }
							: { kind: "success", message: `${hostname} now sends through ${PROVIDER_NAME[v.provider]}` },
					);
				},
				onError: (err) => showToast({ kind: "error", message: errorMessage(err, "Couldn't save the sending settings.") }),
			},
		);
	};

	const runTest = (sendTest: boolean) => {
		// With a new secret typed, test what is on screen; otherwise the saved settings.
		let input: DomainSendingTestInput = { provider: ses ? "ses" : "resend", sendTest };
		if (ses && draft.secret.trim() && draft.accessKeyId.trim()) {
			input = {
				...input,
				region: draft.region,
				accessKeyId: draft.accessKeyId.trim(),
				secretAccessKey: draft.secret.trim(),
				configurationSet: draft.configurationSet.trim() || null,
			};
		}
		if (resend && draft.apiKey.trim()) input = { ...input, apiKey: draft.apiKey.trim() };
		test.mutate(
			{ id: domainId, input },
			{
				onSuccess: ({ test: result }) => {
					setLastTest(result);
					showToast({
						kind: result.ok ? "success" : "warning",
						message: result.ok
							? `${PROVIDER_NAME[draft.provider]} connection works. Save to start sending through it.`
							: "The connection test found problems",
					});
				},
				onError: (err) => showToast({ kind: "error", message: errorMessage(err, "Couldn't test the connection.") }),
			},
		);
	};

	const doReset = () =>
		reset.mutate(domainId, {
			onSuccess: () => {
				setConfirmReset(false);
				setLastTest(null);
				setBlocked(null);
				showToast({ kind: "success", message: `${hostname} sends through Cloudflare; provider settings deleted` });
			},
			onError: (err) => {
				setConfirmReset(false);
				showToast({ kind: "error", message: errorMessage(err, "Couldn't reset the sending settings.") });
			},
		});

	const canTest = ses
		? !!view.ses?.secretStored || (!!draft.secret.trim() && !!draft.accessKeyId.trim())
		: resend
			? !!view.resend?.apiKeyStored || !!draft.apiKey.trim()
			: false;
	const testForProvider =
		storedTest && (storedTest.provider ?? "ses") === draft.provider ? storedTest : null;
	const hasProviderSettings = !!view.ses || !!view.resend;

	return (
		<form onSubmit={onSubmit} noValidate className="space-y-4" aria-labelledby={ids.group}>
			<fieldset className="space-y-2">
				<legend id={ids.group} className="text-[11px] font-medium text-text-secondary">
					Send this domain's mail through
				</legend>
				<div className="flex flex-col gap-2 sm:flex-row">
					{(
						[
							["cloudflare", "Cloudflare Email Service", "Default. Nothing to set up here."],
							["ses", "Amazon SES", "Your own AWS account and IAM key."],
							["resend", "Resend", "Your own Resend account and API key."],
						] as const
					).map(([value, label, hint]) => (
						<label
							key={value}
							className={cn(
								"flex min-h-11 flex-1 cursor-pointer items-start gap-2 rounded-[6px] px-3 py-2 ring-1 ring-border",
								draft.provider === value && "ring-2 ring-violet/60",
							)}
						>
							<input
								type="radio"
								name={`${ids.group}-provider`}
								value={value}
								checked={draft.provider === value}
								onChange={() => set("provider", value)}
								className="mt-1 size-4 accent-accent"
							/>
							<span>
								<span className="block text-sm font-medium text-text-primary">{label}</span>
								<span className="block text-xs text-text-tertiary">{hint}</span>
							</span>
						</label>
					))}
				</div>
				<p className="text-xs text-text-tertiary">
					Currently sending through <strong className="font-medium text-text-secondary">{PROVIDER_NAME[view.provider]}</strong>.
					Changes apply to new mail within 10 seconds.
				</p>
			</fieldset>

			{ses || resend ? (
				<p id={ids.warn} className="rounded-[6px] bg-warning-bg px-3 py-2 text-xs text-warning-text">
					There is no fallback: if {PROVIDER_NAME[draft.provider]} can't send (bad key, unverified domain
					{ses ? ", sandbox" : ", quota"}), mail from {hostname} fails with a reason instead of going out through Cloudflare.
					Sending switches over only after Test connection passes for the saved settings.
				</p>
			) : null}

			{ses ? (
				<div className="space-y-3">
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1.5">
							<label htmlFor={ids.region} className={LABEL}>
								Region
							</label>
							<select
								id={ids.region}
								value={draft.region}
								onChange={(e) => set("region", e.target.value)}
								className={cn(SETTINGS_INPUT_CLASS, TOUCH)}
							>
								{SES_REGIONS.map((r) => (
									<option key={r.id} value={r.id}>
										{r.label} ({r.id})
									</option>
								))}
							</select>
						</div>
						<div className="space-y-1.5">
							<label htmlFor={ids.key} className={LABEL}>
								Access key ID
							</label>
							<input
								id={ids.key}
								value={draft.accessKeyId}
								onChange={(e) => set("accessKeyId", e.target.value)}
								autoComplete="off"
								spellCheck={false}
								placeholder={view.ses?.accessKeyIdLast4 ? `Stored: …${view.ses.accessKeyIdLast4}` : "AKIA…"}
								aria-invalid={!!errs.accessKeyId}
								aria-describedby={ids.keyHint}
								className={cn(SETTINGS_INPUT_CLASS, TOUCH, "font-mono")}
							/>
							<p id={ids.keyHint} className={cn("text-xs", errs.accessKeyId ? "text-destructive" : "text-text-tertiary")}>
								{errs.accessKeyId ??
									(view.ses?.accessKeyIdLast4
										? `Stored key ends in ${view.ses.accessKeyIdLast4}. Enter it in full to save changes.`
										: "From the IAM user that has the policy below.")}
							</p>
						</div>
					</div>

					<SecretField
						id={ids.secret}
						hintId={ids.secretHint}
						label="Secret access key"
						stored={!!view.ses?.secretStored}
						replacing={draft.replacingSecret}
						onReplace={() => set("replacingSecret", true)}
						value={draft.secret}
						onChange={(v) => set("secret", v)}
						error={errs.secret}
						hint="Stored encrypted and never shown again. Leave it to keep the stored one (same access key ID only)."
					/>

					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1.5">
							<label htmlFor={ids.cs} className={LABEL}>
								Configuration set
							</label>
							<input
								id={ids.cs}
								value={draft.configurationSet}
								onChange={(e) => set("configurationSet", e.target.value)}
								autoComplete="off"
								aria-invalid={!!errs.configurationSet}
								className={cn(SETTINGS_INPUT_CLASS, TOUCH)}
							/>
							<p className={cn("text-xs", errs.configurationSet ? "text-destructive" : "text-text-tertiary")}>
								{errs.configurationSet ?? "Needed for bounces and complaints. Every send uses it."}
							</p>
						</div>
						<div className="space-y-1.5">
							<label htmlFor={ids.topic} className={LABEL}>
								SNS topic ARN
							</label>
							<input
								id={ids.topic}
								value={draft.snsTopicArn}
								onChange={(e) => set("snsTopicArn", e.target.value)}
								autoComplete="off"
								spellCheck={false}
								placeholder={`arn:aws:sns:${draft.region}:123456789012:cloudmail`}
								aria-invalid={!!errs.snsTopicArn}
								className={cn(SETTINGS_INPUT_CLASS, TOUCH, "font-mono")}
							/>
							<p className={cn("text-xs", errs.snsTopicArn ? "text-destructive" : "text-text-tertiary")}>
								{errs.snsTopicArn ?? "Events from any other topic are refused."}
							</p>
						</div>
					</div>
				</div>
			) : null}

			{resend ? (
				<div className="space-y-3">
					<div className="space-y-1.5">
						<label htmlFor={ids.apiKey} className="flex items-center gap-2 text-[11px] font-medium text-text-secondary">
							API key
							{view.resend?.apiKeyStored ? <StoredBadge last4={view.resend.apiKeyLast4} /> : null}
						</label>
						<input
							id={ids.apiKey}
							type="password"
							value={draft.apiKey}
							onChange={(e) => set("apiKey", e.target.value)}
							autoComplete="new-password"
							spellCheck={false}
							placeholder={view.resend?.apiKeyStored ? "Leave empty to keep the stored key" : "re_…"}
							aria-invalid={!!errs.apiKey}
							className={cn(SETTINGS_INPUT_CLASS, TOUCH, "font-mono")}
						/>
						<p className={cn("text-xs", errs.apiKey ? "text-destructive" : "text-text-tertiary")}>
							{errs.apiKey ??
								"A sending-only key restricted to this domain is enough; a full-access key also lets the test check the domain's DNS and tracking."}
						</p>
					</div>
					<div className="space-y-1.5">
						<label htmlFor={ids.whsec} className="flex items-center gap-2 text-[11px] font-medium text-text-secondary">
							Webhook signing secret
							{view.resend?.webhookSecretStored ? <StoredBadge last4={null} /> : null}
						</label>
						<input
							id={ids.whsec}
							type="password"
							value={draft.webhookSecret}
							onChange={(e) => set("webhookSecret", e.target.value)}
							autoComplete="new-password"
							spellCheck={false}
							placeholder={view.resend?.webhookSecretStored ? "Leave empty to keep the stored secret" : "whsec_…"}
							aria-invalid={!!errs.webhookSecret}
							className={cn(SETTINGS_INPUT_CLASS, TOUCH, "font-mono")}
						/>
						<p className={cn("text-xs", errs.webhookSecret ? "text-destructive" : "text-text-tertiary")}>
							{errs.webhookSecret ?? "From the webhook you create in Resend (below). Stored encrypted, never shown again."}
						</p>
					</div>
				</div>
			) : null}

			{!ses && !resend && hasProviderSettings ? (
				<p className="text-xs text-text-tertiary">
					{view.ses ? `SES settings are kept (key ending ${view.ses.accessKeyIdLast4 ?? "?"}). ` : ""}
					{view.resend ? `Resend settings are kept (key ending ${view.resend.apiKeyLast4 ?? "?"}). ` : ""}
					You can switch back without re-entering them. Delete them with Reset.
				</p>
			) : null}

			<div className="flex flex-wrap items-center gap-2">
				<button type="submit" disabled={!dirty || save.isPending} className={cn(PRIMARY_BUTTON_CLASS, TOUCH)}>
					{save.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
					Save
				</button>
				{ses || resend ? (
					<>
						<button
							type="button"
							onClick={() => runTest(false)}
							disabled={!canTest || test.isPending}
							className={cn(SECONDARY_BUTTON_CLASS, TOUCH)}
						>
							{test.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <PlugZap size={13} aria-hidden />}
							{test.isPending ? "Testing…" : "Test connection"}
						</button>
						<button
							type="button"
							onClick={() => runTest(true)}
							disabled={!canTest || test.isPending}
							className={cn(SECONDARY_BUTTON_CLASS, TOUCH)}
							title={ses ? "Also sends one message to the SES mailbox simulator" : "Also sends one message to delivered@resend.dev"}
						>
							Test and send one
						</button>
					</>
				) : null}
				{hasProviderSettings || view.provider !== "cloudflare" ? (
					<button type="button" onClick={() => setConfirmReset(true)} className={cn(SECONDARY_BUTTON_CLASS, TOUCH)}>
						<RotateCcw size={13} aria-hidden />
						Reset to Cloudflare
					</button>
				) : null}
			</div>

			{blocked && draft.provider !== "cloudflare" && view.provider === "cloudflare" ? (
				<p role="status" className="rounded-[6px] bg-warning-bg px-3 py-2 text-xs text-warning-text">
					Saved, but still sending through Cloudflare: {blocked}
				</p>
			) : null}

			{(ses || resend) && view.lastEvent ? <LastEvent view={view} /> : null}

			{ses && testForProvider ? <SesTestView result={testForProvider as SesTestResult} /> : null}
			{resend && testForProvider ? <ResendTestView result={testForProvider as ResendTestResult} /> : null}

			{(ses || resend) && view.webhook && view.webhook.provider === draft.provider ? (
				<WebhookSetup view={view} provider={draft.provider} hostname={hostname} region={draft.region} configurationSet={draft.configurationSet.trim() || "cloudmail"} />
			) : (ses || resend) ? (
				<p className="text-xs text-text-tertiary">Save the settings once to get the webhook URL for bounces and complaints.</p>
			) : null}

			{ses ? (
				<details className="rounded-[6px] bg-bg-subtle/60 px-3 py-2 ring-1 ring-border">
					<summary className="flex min-h-11 cursor-pointer items-center text-xs font-semibold text-text-primary sm:min-h-0">
						Least-privilege IAM policy for {hostname}
					</summary>
					<p className="mt-2 text-xs text-text-secondary">
						Attach this to the IAM user whose key you enter above. It can only send as {hostname} in {draft.region}
						through the configuration set, over TLS, and read the account, this identity and the configuration set.
						{accountIdOfTopicArn(draft.snsTopicArn.trim()) ? "" : " Replace ACCOUNT_ID with your 12-digit AWS account ID."}
					</p>
					<pre className="mt-2 max-h-72 overflow-auto rounded bg-card p-3 font-mono text-[11px] text-text-primary ring-1 ring-border">
						{policy}
					</pre>
					<CopyButton text={policy} label="Copy policy" what="IAM policy" className={TOUCH} />
				</details>
			) : null}

			<ConfirmDialog
				open={confirmReset}
				onOpenChange={setConfirmReset}
				title={`Reset ${hostname} to Cloudflare?`}
				description="Mail from this domain goes out through Cloudflare Email Service again, and the stored SES and Resend keys and secrets are deleted."
				confirmLabel="Reset and delete"
				onConfirm={doReset}
				pending={reset.isPending}
			/>
		</form>
	);
}

function StoredBadge({ last4 }: { last4: string | null }) {
	return (
		<span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
			<CheckCircle2 size={11} aria-hidden /> Stored{last4 ? ` (…${last4})` : ""}
		</span>
	);
}

function SecretField(props: {
	id: string;
	hintId: string;
	label: string;
	stored: boolean;
	replacing: boolean;
	onReplace: () => void;
	value: string;
	onChange: (v: string) => void;
	error?: string;
	hint: string;
}) {
	return (
		<div className="space-y-1.5">
			<label htmlFor={props.id} className="flex items-center gap-2 text-[11px] font-medium text-text-secondary">
				{props.label}
				{props.stored ? <StoredBadge last4={null} /> : null}
			</label>
			{props.stored && !props.replacing ? (
				<div className="flex flex-wrap items-center gap-2">
					<input
						id={props.id}
						value="••••••••••••••••"
						readOnly
						aria-describedby={props.hintId}
						className={cn(SETTINGS_INPUT_CLASS, TOUCH, "max-w-xs text-text-tertiary")}
					/>
					<button type="button" onClick={props.onReplace} className={cn(SECONDARY_BUTTON_CLASS, TOUCH)}>
						Replace
					</button>
				</div>
			) : (
				<input
					id={props.id}
					type="password"
					value={props.value}
					onChange={(e) => props.onChange(e.target.value)}
					autoComplete="new-password"
					spellCheck={false}
					aria-invalid={!!props.error}
					aria-describedby={props.hintId}
					className={cn(SETTINGS_INPUT_CLASS, TOUCH, "font-mono")}
				/>
			)}
			<p id={props.hintId} className={cn("text-xs", props.error ? "text-destructive" : "text-text-tertiary")}>
				{props.error ?? props.hint}
			</p>
		</div>
	);
}

function LastEvent({ view }: { view: DomainSendingView }) {
	const e = view.lastEvent!;
	const sub =
		e.subscription === "confirmed"
			? "SNS subscription confirmed"
			: e.subscription === "unsubscribed"
				? "SNS subscription removed: events have stopped. Subscribe the URL again."
				: e.subscription === "confirm_failed"
					? "SNS subscription confirmation was refused (unexpected host)."
					: null;
	return (
		<p className="text-xs text-text-tertiary" aria-live="polite">
			Last provider event: <span className="font-medium text-text-secondary">{sub ?? e.type}</span>,{" "}
			{new Date(e.at).toLocaleString()}
		</p>
	);
}

function WebhookSetup({
	view,
	provider,
	hostname,
	region,
	configurationSet,
}: {
	view: DomainSendingView;
	provider: SendingProvider;
	hostname: string;
	region: string;
	configurationSet: string;
}) {
	const url = view.webhook?.url ?? view.webhook?.path ?? "";
	return (
		<details className="rounded-[6px] bg-bg-subtle/60 px-3 py-2 ring-1 ring-border" open={!view.lastEvent}>
			<summary className="flex min-h-11 cursor-pointer items-center text-xs font-semibold text-text-primary sm:min-h-0">
				Bounces and complaints: event webhook
			</summary>
			<div className="mt-2 space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<code className="min-w-0 flex-1 break-all rounded bg-card px-2 py-1.5 font-mono text-xs text-text-primary ring-1 ring-border">
						{url}
					</code>
					<CopyButton text={url} label="Copy URL" what="Webhook URL" className={TOUCH} />
				</div>
				{provider === "ses" ? (
					<ol className="list-decimal space-y-1 pl-5 text-xs text-text-secondary">
						<li>
							In SES ({region}), create the configuration set <code className="font-mono">{configurationSet}</code>.
						</li>
						<li>
							In SNS ({region}), create a Standard topic. Set its <code className="font-mono">SignatureVersion</code> to 2
							(Edit → Message signing), and paste the topic ARN above.
						</li>
						<li>Add an HTTPS subscription to the topic with the URL above. cloudmail confirms it automatically.</li>
						<li>
							In the configuration set, add an SNS event destination for Bounce, Complaint, Delivery and Reject (and Send)
							to that topic. Leave Open and Click off: cloudmail tracks those itself.
						</li>
						<li>Run Test connection, then Save.</li>
					</ol>
				) : (
					<ol className="list-decimal space-y-1 pl-5 text-xs text-text-secondary">
						<li>In Resend → Webhooks, add an endpoint with the URL above.</li>
						<li>
							Select email.sent, email.delivered, email.delivery_delayed, email.bounced, email.complained, email.failed and
							email.suppressed.
						</li>
						<li>Copy its signing secret (whsec_…) into the field above and Save.</li>
						<li>In Resend → Domains → {hostname}, turn off open and click tracking: cloudmail tracks those itself.</li>
					</ol>
				)}
			</div>
		</details>
	);
}

function Check({ ok, warn, children }: { ok: boolean; warn?: boolean; children: React.ReactNode }) {
	return (
		<li className="flex items-start gap-2 text-sm">
			{ok ? (
				<CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" aria-label="Pass" />
			) : (
				<XCircle size={14} className={cn("mt-0.5 shrink-0", warn ? "text-warning-text" : "text-destructive")} aria-label="Problem" />
			)}
			<span className="min-w-0 break-words text-text-secondary">{children}</span>
		</li>
	);
}

function GateLine({ result }: { result: SendingTestResult }) {
	if (result.sendingAllowed === undefined) return null;
	return (
		<Check ok={result.sendingAllowed}>
			{result.sendingAllowed ? "Ready to send. Save to switch this domain over." : `Can't send yet: ${result.blockedReason}`}
		</Check>
	);
}

function Warnings({ result }: { result: SendingTestResult }) {
	if (!result.warnings?.length) return null;
	return (
		<ul className="space-y-1">
			{result.warnings.map((w) => (
				<li key={w} className="rounded-[6px] bg-warning-bg px-2 py-1.5 text-xs text-warning-text">
					{w}
				</li>
			))}
		</ul>
	);
}

function SendTestLine({ result }: { result: SendingTestResult }) {
	const s = result.sendTest;
	if (!s) return null;
	return (
		<Check ok={s.ok}>
			{s.ok ? `Test message accepted for ${s.to}` : `Test message to ${s.to} failed: ${s.error}`}
		</Check>
	);
}

function SesTestView({ result }: { result: SesTestResult }) {
	const { account, identity } = result;
	const records: SesDnsRecord[] = [...(identity.ok ? identity.dkim.records : []), ...(result.mailFrom?.records ?? [])];
	return (
		<div className="space-y-3 rounded-[6px] px-3 py-3 ring-1 ring-border" aria-live="polite">
			<p className="text-xs text-text-tertiary">
				Tested {new Date(result.testedAt).toLocaleString()} in {result.region}
			</p>
			<ul className="space-y-1.5">
				<GateLine result={result} />
				{account.ok ? (
					<>
						<Check ok={account.sendingEnabled}>
							Sending {account.sendingEnabled ? "enabled" : "disabled"} on the AWS account
							{account.enforcementStatus ? ` (${account.enforcementStatus.toLowerCase()})` : ""}
						</Check>
						<Check ok={!account.sandbox} warn>
							{account.sandbox
								? "In the SES sandbox: only verified recipients, low quota. Request production access in the SES console."
								: "Production access"}
						</Check>
						<Check ok>
							Quota: {account.quota.max24HourSend ?? "?"} per 24 hours, {account.quota.maxSendRate ?? "?"} per second
							{account.quota.sentLast24Hours !== null ? ` (${account.quota.sentLast24Hours} sent today)` : ""}
						</Check>
					</>
				) : (
					<Check ok={false}>Account: {account.error}</Check>
				)}
				{identity.ok ? (
					<>
						<Check ok={identity.verifiedForSending}>
							Domain {identity.verifiedForSending ? "verified for sending" : `not verified (${identity.verificationStatus ?? "unknown"})`}
						</Check>
						<Check ok={identity.dkim.status === "SUCCESS" && identity.dkim.signingEnabled}>
							DKIM {identity.dkim.status?.toLowerCase() ?? "not set up"}
							{identity.dkim.signingEnabled ? ", signing on" : ", signing off"}
						</Check>
					</>
				) : (
					<Check ok={false}>Identity: {identity.error}</Check>
				)}
				{result.mailFrom ? (
					<Check ok={result.mailFrom.status === "SUCCESS"} warn>
						Custom MAIL FROM {result.mailFrom.domain ?? "not set up"}
						{result.mailFrom.status ? ` (${result.mailFrom.status.toLowerCase()})` : ""}. Recommended, not required.
					</Check>
				) : null}
				{result.configurationSet ? (
					result.configurationSet.ok ? (
						<Check ok={!result.configurationSet.openTracking && !result.configurationSet.clickTracking} warn>
							Configuration set {result.configurationSet.name} found
						</Check>
					) : (
						<Check ok={false}>Configuration set {result.configurationSet.name}: {result.configurationSet.error}</Check>
					)
				) : null}
				<SendTestLine result={result} />
			</ul>
			<Warnings result={result} />
			<DnsRecords records={records} unverified={result.mailFrom?.unverifiedEndpoint ?? false} />
		</div>
	);
}

function ResendTestView({ result }: { result: ResendTestResult }) {
	const d = result.domain;
	return (
		<div className="space-y-3 rounded-[6px] px-3 py-3 ring-1 ring-border" aria-live="polite">
			<p className="text-xs text-text-tertiary">Tested {new Date(result.testedAt).toLocaleString()}</p>
			<ul className="space-y-1.5">
				<GateLine result={result} />
				{!result.fullAccess ? <Check ok warn>Sending-only key: domain checks skipped</Check> : null}
				{d ? (
					d.ok ? (
						<>
							<Check ok={d.status === "verified"}>
								Domain {d.status === "verified" ? "verified" : `not verified (${d.status ?? "unknown"})`}
								{d.region ? ` in ${d.region}` : ""}
							</Check>
							<Check ok={!d.openTracking && !d.clickTracking} warn>
								Resend tracking {d.openTracking || d.clickTracking ? "on (turn it off)" : "off"}
							</Check>
						</>
					) : (
						<Check ok={false}>Domain: {d.error}</Check>
					)
				) : null}
				<SendTestLine result={result} />
			</ul>
			<Warnings result={result} />
			{d && d.ok ? <DnsRecords records={d.records} unverified={false} /> : null}
		</div>
	);
}

function DnsRecords({ records, unverified }: { records: SesDnsRecord[]; unverified: boolean }) {
	if (records.length === 0) return null;
	return (
		<div className="space-y-1.5">
			<h5 className="text-xs font-semibold text-text-primary">DNS records</h5>
			<p className="text-xs text-text-tertiary">
				DKIM CNAMEs must be DNS only (not proxied). The apex MX and SPF stay as they are.
				{unverified ? " AWS doesn't list a feedback endpoint for this region; the MX follows the usual pattern." : ""}
			</p>
			<ul className="space-y-1.5">
				{records.map((r) => (
					<li key={`${r.type}:${r.name}:${r.value}`} className="flex flex-wrap items-center gap-2 rounded-[6px] px-2 py-1.5 ring-1 ring-border">
						<span className="text-[11px] font-medium text-text-tertiary">
							{r.type}
							{r.priority !== undefined ? ` ${r.priority}` : ""}
							{r.status ? ` · ${r.status}` : ""}
						</span>
						<code className="min-w-0 flex-1 break-all font-mono text-xs text-text-primary">{r.name}</code>
						<CopyButton text={r.name} label="Name" what="Record name" className={TOUCH} />
						<code className="min-w-0 basis-full break-all font-mono text-xs text-text-secondary sm:basis-auto">{r.value}</code>
						<CopyButton text={r.value} label="Value" what="Record value" className={TOUCH} />
					</li>
				))}
			</ul>
		</div>
	);
}
