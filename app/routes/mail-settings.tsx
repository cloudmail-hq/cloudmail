/**
 * Per-mailbox settings.
 *
 * Signatures and block rules live in the mailbox Durable Object and save
 * themselves; the rest is one settings blob behind a single Save.
 */

import { useEffect, useState } from "react";
import { useParams } from "react-router";
import {
	Ban,
	Bot,
	Download,
	Forward,
	MailQuestion,
	Plus,
	Save,
	ShieldCheck,
	Signature,
	Trash2,
	UserRound,
} from "lucide-react";
import { LazyEditor } from "~/components/lazy";
import AutoReplySettingsSection from "~/components/settings/AutoReplySettings";
import RemoteImageSettings from "~/components/settings/RemoteImageSettings";
import RulesSettings from "~/components/settings/RulesSettings";
import TriageSettings from "~/components/settings/TriageSettings";
import MailboxDelegates from "~/components/settings/MailboxDelegates";
import MailboxAccessLog from "~/components/settings/MailboxAccessLog";
import MailboxAliases from "~/components/settings/MailboxAliases";
import TrackingSettingsSection from "~/components/settings/TrackingSettings";
import SendLimitsSettings from "~/components/settings/SendLimitsSettings";
import ImportSettingsSection from "~/components/settings/ImportSettings";
import AgentSendSettings, { type AgentSendValue } from "~/components/settings/AgentSendSettings";
import type { AutoReplySettings } from "shared/auto-reply";
import type { FollowupDefault } from "shared/followups";
import { sanitizeInlineHtml } from "~/lib/email-html";
import { errorMessage, showToast } from "~/lib/toast";
import {
	useAllowedSenders,
	useAllowSender,
	useBlockedSenders,
	useBlockSender,
	useDisallowSender,
	useUnblockSender,
} from "~/queries/blocked-senders";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import {
	useCreateSignature,
	useDeleteSignature,
	useSignatures,
	useUpdateSignature,
} from "~/queries/signatures";

function Section({
	title,
	description,
	icon,
	children,
	action,
}: {
	title: string;
	description?: string;
	icon?: React.ReactNode;
	children?: React.ReactNode;
	action?: React.ReactNode;
}) {
	return (
		<section className="rounded-[8px] border border-border bg-card p-5">
			<div className="mb-4 flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
						{icon}
						{title}
					</h2>
					{description && (
						<p className="mt-1 text-sm text-text-secondary">
							{description}
						</p>
					)}
				</div>
				{action}
			</div>
			{children}
		</section>
	);
}

function Toggle({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	label: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			onClick={() => onChange(!checked)}
			className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
				checked ? "bg-violet" : "bg-bg-muted"
			}`}
		>
			<span
				className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
					checked ? "translate-x-[18px]" : "translate-x-0.5"
				}`}
			/>
		</button>
	);
}

export default function MailSettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailbox = useUpdateMailbox();

	const { data: signatures = [], isPending: signaturesPending } =
		useSignatures(mailboxId);
	const createSignature = useCreateSignature();
	const updateSignature = useUpdateSignature();
	const deleteSignature = useDeleteSignature();

	const { data: blocked = [] } = useBlockedSenders(mailboxId);
	const blockSender = useBlockSender();
	const unblockSender = useUnblockSender();

	const { data: allowed = [] } = useAllowedSenders(mailboxId);
	const allowSender = useAllowSender();
	const disallowSender = useDisallowSender();

	const [displayName, setDisplayName] = useState("");
	const [autoDraft, setAutoDraft] = useState(true);
	const [autoReply, setAutoReply] = useState<AutoReplySettings>({
		enabled: false,
		subject: "",
		message: "",
	});
	const [forwardingEnabled, setForwardingEnabled] = useState(false);
	const [forwardingEmail, setForwardingEmail] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [followupDefault, setFollowupDefault] = useState<FollowupDefault>("off");
	const [followupNudge, setFollowupNudge] = useState(false);
	const [agentSend, setAgentSend] = useState<AgentSendValue>({ mode: "approve", allowlist: [] });
	const [saving, setSaving] = useState(false);

	const [newSignatureName, setNewSignatureName] = useState("");
	const [newSignatureHtml, setNewSignatureHtml] = useState("");
	const [addingSignature, setAddingSignature] = useState(false);

	const [blockPattern, setBlockPattern] = useState("");
	const [allowPattern, setAllowPattern] = useState("");

	useEffect(() => {
		if (!mailbox) return;
		setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
		setAutoDraft(mailbox.settings?.autoDraft?.enabled ?? true);
		setAutoReply({
			enabled: false,
			subject: "",
			message: "",
			...(mailbox.settings?.autoReply ?? {}),
		});
		setForwardingEnabled(mailbox.settings?.forwarding?.enabled ?? false);
		setForwardingEmail(mailbox.settings?.forwarding?.email || "");
		setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
		setFollowupDefault(mailbox.settings?.followups?.default ?? "off");
		setFollowupNudge(mailbox.settings?.followups?.draftNudge ?? false);
		setAgentSend({
			mode: mailbox.settings?.agentSend?.mode ?? "approve",
			allowlist: mailbox.settings?.agentSend?.allowlist ?? [],
		});
	}, [mailbox]);

	if (!mailboxId) return null;

	const forwardingTarget = forwardingEmail.trim().toLowerCase();
	const forwardsToSelf =
		forwardingTarget.length > 0 &&
		forwardingTarget === mailbox?.email?.toLowerCase();
	const forwardingError = forwardsToSelf
		? "A mailbox can't forward to itself."
		: forwardingEnabled && forwardingTarget.length === 0
			? "Enter an address to forward to, or turn forwarding off."
			: null;

	const save = async () => {
		if (!mailbox) return;
		if (forwardingError) {
			showToast({ kind: "error", message: forwardingError });
			return;
		}
		setSaving(true);
		try {
			await updateMailbox.mutateAsync({
				mailboxId,
				// Only the fields this screen owns. The route merges the patch into
				// the stored blob, so spreading `mailbox.settings` back in is no
				// longer needed to protect the signature — and would now fail,
				// because the route rejects unknown keys and a blob written before
				// the schema existed may carry some.
				settings: {
					fromName: displayName,
					// Empty string, not `undefined`: clearing the textarea has to clear
					// the stored prompt, and an absent key means "leave it alone".
					agentSystemPrompt: agentPrompt.trim(),
					agentSend,
					autoDraft: { enabled: autoDraft },
					autoReply,
					forwarding: { enabled: forwardingEnabled, email: forwardingTarget },
					followups: { default: followupDefault, draftNudge: followupNudge },
				},
			});
			showToast({ kind: "success", message: "Settings saved" });
		} catch (err) {
			showToast({
				kind: "error",
				message: errorMessage(err, "Could not save settings."),
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="h-full overflow-y-auto bg-bg-subtle">
			{/*
			  Sticky, so Save is reachable from the bottom of a long page. It sat
			  at the top and scrolled away, which on this page is twelve sections.
			*/}
			<div className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur">
				<div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-6 py-3">
					<div className="min-w-0">
						<h1 className="text-lg font-semibold tracking-tight text-text-primary">
							Mailbox settings
						</h1>
						<p className="truncate text-xs text-text-secondary">{mailboxId}</p>
					</div>
					<button
						type="button"
						onClick={save}
						disabled={saving}
						className="inline-flex h-9 items-center gap-1.5 rounded-[6px] bg-accent px-4 text-sm font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
					>
						<Save size={14} />
						{saving ? "Saving…" : "Save changes"}
					</button>
				</div>
			</div>
			<div className="mx-auto max-w-3xl space-y-5 px-6 py-6">

				<Section
					title="Identity"
					icon={<UserRound size={15} className="text-text-tertiary" />}
				>
					<div className="space-y-2.5">
						<label className="block">
							<span className="mb-1 block text-xs font-medium text-text-secondary">
								Display name
							</span>
							<input
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								className="h-9 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-ring/30"
							/>
						</label>
						<label className="block">
							<span className="mb-1 block text-xs font-medium text-text-secondary">
								Address
							</span>
							<input
								value={mailbox?.email ?? mailboxId}
								readOnly
								// Read-only, not disabled: the address is real data the reader
								// may want to copy, and a disabled field's grey text read as
								// an empty placeholder.
								className="w-full cursor-default rounded-[6px] border border-border bg-bg-subtle px-2.5 py-1.5 text-sm text-text-secondary outline-none"
							/>
						</label>
					</div>
				</Section>

				{/*
				  Aliases save themselves (one PUT replaces the list), so they sit
				  outside the Save form like signatures and sender rules.
				*/}
				<MailboxAliases
					mailboxId={mailboxId}
					mailboxEmail={mailbox?.email ?? mailboxId}
				/>

				{/* Signatures */}
				<Section
					title="Signatures"
					icon={<Signature size={15} className="text-text-tertiary" />}
					description="The default signature is added to new messages. Any signature can be inserted from the composer."
					action={
						<button
							type="button"
							onClick={() => setAddingSignature((v) => !v)}
							className="inline-flex items-center gap-1 rounded-[6px] border border-border px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-muted"
						>
							<Plus size={12} />
							New
						</button>
					}
				>
					<ul className="space-y-2">
						{signatures.map((sig) => (
							<li
								key={sig.id}
								className="flex items-center gap-2 rounded-[8px] border border-border bg-bg-subtle/50 px-2.5 py-2"
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-xs font-semibold text-text-primary">
										{sig.name}
									</span>
									<span
										className="block max-h-8 overflow-hidden text-xs text-text-tertiary"
										// Signature previews are authored by the mailbox owner and
										// stored as HTML; rendering the markup is the point.
										//
										// Sanitised anyway: this renders inline rather than in the
										// sandboxed message iframe, and `PUT /signatures/:id` is
										// reachable by anything holding a session, so "the owner
										// wrote it" is an assumption rather than a guarantee.
										dangerouslySetInnerHTML={{
											__html: sanitizeInlineHtml(sig.body_html),
										}}
									/>
								</span>
								{!sig.is_default && (
									<button
										type="button"
										onClick={() =>
											updateSignature.mutate({
												mailboxId,
												signatureId: sig.id,
												patch: { is_default: true },
											})
										}
										className="shrink-0 rounded-[6px] border border-border bg-card px-2 py-1 text-[10px] font-medium text-text-secondary hover:bg-bg-muted"
									>
										Make default
									</button>
								)}
								{sig.is_default && (
									<span className="shrink-0 rounded-[4px] bg-accent-subtle px-1.5 py-0.5 text-[11px] font-semibold text-accent-subtle-fg">
										Default
									</span>
								)}
								<button
									type="button"
									onClick={() => {
										if (!window.confirm(`Delete the signature "${sig.name}"?`))
											return;
										deleteSignature.mutate({ mailboxId, signatureId: sig.id });
									}}
									aria-label={`Delete ${sig.name}`}
									className="shrink-0 rounded-[6px] p-1 text-text-tertiary hover:bg-destructive/10 hover:text-destructive"
								>
									<Trash2 size={13} />
								</button>
							</li>
						))}
						{signatures.length === 0 && !addingSignature && signaturesPending && (
							<li aria-busy="true" className="h-9 animate-pulse rounded-[6px] bg-bg-muted" />
						)}
						{signatures.length === 0 && !addingSignature && !signaturesPending && (
							<li className="text-sm text-text-tertiary">
								No signatures yet.
							</li>
						)}
					</ul>

					{addingSignature && (
						<form
							className="mt-3 space-y-2"
							onSubmit={(e) => {
								e.preventDefault();
								if (!newSignatureName.trim()) return;
								createSignature.mutate(
									{
										mailboxId,
										name: newSignatureName.trim(),
										body_html: newSignatureHtml,
										is_default: signatures.length === 0,
									},
									{
										onSuccess: () => {
											setNewSignatureName("");
											setNewSignatureHtml("");
											setAddingSignature(false);
										},
										onError: (err) =>
											showToast({
												kind: "error",
												message: errorMessage(
													err,
													"Could not save that signature.",
												),
											}),
									},
								);
							}}
						>
							<input
								value={newSignatureName}
								onChange={(e) => setNewSignatureName(e.target.value)}
								placeholder="Signature name"
								aria-label="Signature name"
								className="h-9 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-ring/30"
							/>
							<LazyEditor value={newSignatureHtml} onChange={setNewSignatureHtml} />
							<div className="flex justify-end gap-2">
								<button
									type="button"
									onClick={() => setAddingSignature(false)}
									className="inline-flex h-9 items-center rounded-[6px] border border-border bg-card px-3.5 text-[13px] font-medium text-text-secondary hover:bg-bg-muted"
								>
									Cancel
								</button>
								<button
									type="submit"
									disabled={!newSignatureName.trim()}
									className="inline-flex h-9 shrink-0 items-center rounded-[6px] bg-accent px-3.5 text-[13px] font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
								>
									Save signature
								</button>
							</div>
						</form>
					)}
				</Section>

				{/* Blocked senders */}
				<Section
					title="Blocked senders"
					icon={<Ban size={15} className="text-text-tertiary" />}
					description="Mail from these addresses or domains is filed to Spam on arrival, and never forwarded. Use @example.com to block a whole domain."
				>
					<form
						className="mb-3 flex items-center gap-1.5"
						onSubmit={(e) => {
							e.preventDefault();
							const pattern = blockPattern.trim();
							if (!pattern) return;
							blockSender.mutate(
								{ mailboxId, pattern },
								{
									onSuccess: () => setBlockPattern(""),
									onError: (err) =>
										showToast({
											kind: "error",
											message: errorMessage(err, "Could not block that sender."),
										}),
								},
							);
						}}
					>
						<input
							value={blockPattern}
							onChange={(e) => setBlockPattern(e.target.value)}
							placeholder="spam@example.com or @example.com"
							aria-label="Address or domain to block"
							className="min-w-0 h-9 flex-1 rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-ring/30"
						/>
						<button
							type="submit"
							disabled={!blockPattern.trim()}
							className="inline-flex h-9 shrink-0 items-center rounded-[6px] bg-accent px-3.5 text-[13px] font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
						>
							Block
						</button>
					</form>
					<ul className="space-y-1.5">
						{blocked.map((rule) => (
							<li
								key={rule.id}
								className="flex items-center gap-2 rounded-[6px] border border-border bg-bg-subtle/50 px-2.5 py-1.5"
							>
								<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">
									{rule.pattern}
								</span>
								<button
									type="button"
									onClick={() =>
										unblockSender.mutate({ mailboxId, blockId: rule.id })
									}
									className="shrink-0 rounded-[6px] border border-border bg-card px-2 py-0.5 text-[10px] font-medium text-text-secondary hover:bg-bg-muted"
								>
									Unblock
								</button>
							</li>
						))}
						{blocked.length === 0 && (
							<li className="text-sm text-text-tertiary">
								No block rules.
							</li>
						)}
					</ul>
				</Section>

				{/*
				  Allowed senders. Mostly populated by "Not spam" rather than typed in
				  here, but it needs to be visible and editable: an accidental "Not
				  spam" would otherwise permanently exempt a sender from filtering with
				  nothing in the UI to show it or undo it.
				*/}
				<Section
					title="Allowed senders"
					icon={<ShieldCheck size={15} className="text-text-tertiary" />}
					description="Mail from these addresses or domains is never filed as spam by the automatic filter. Marking a message “Not spam” adds its sender here. Blocking a sender still wins."
				>
					<form
						className="mb-3 flex items-center gap-1.5"
						onSubmit={(e) => {
							e.preventDefault();
							const pattern = allowPattern.trim();
							if (!pattern) return;
							allowSender.mutate(
								{ mailboxId, pattern },
								{
									onSuccess: () => setAllowPattern(""),
									onError: (err) =>
										showToast({
											kind: "error",
											message: errorMessage(err, "Could not allow that sender."),
										}),
								},
							);
						}}
					>
						<input
							value={allowPattern}
							onChange={(e) => setAllowPattern(e.target.value)}
							placeholder="sam@example.com or @example.com"
							aria-label="Address or domain to allow"
							className="min-w-0 h-9 flex-1 rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-ring/30"
						/>
						<button
							type="submit"
							disabled={!allowPattern.trim()}
							className="inline-flex h-9 shrink-0 items-center rounded-[6px] bg-accent px-3.5 text-[13px] font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
						>
							Allow
						</button>
					</form>
					<ul className="space-y-1.5">
						{allowed.map((rule) => (
							<li
								key={rule.id}
								className="flex items-center gap-2 rounded-[6px] border border-border bg-bg-subtle/50 px-2.5 py-1.5"
							>
								<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">
									{rule.pattern}
								</span>
								<button
									type="button"
									onClick={() =>
										disallowSender.mutate({ mailboxId, allowId: rule.id })
									}
									className="shrink-0 rounded-[6px] border border-border bg-card px-2 py-0.5 text-[10px] font-medium text-text-secondary hover:bg-bg-muted"
								>
									Remove
								</button>
							</li>
						))}
						{allowed.length === 0 && (
							<li className="text-sm text-text-tertiary">
								No allow rules.
							</li>
						)}
					</ul>
				</Section>

				{/*
				  Rules sit next to the block list because they are the same kind of
				  thing — decisions made about mail before the user sees it — and
				  because a block rule is the degenerate case of a filter rule.
				  They save themselves, so they live outside the Save form.
				*/}
				<RulesSettings mailboxId={mailboxId} />

				{/* AI labels, inbox tabs and the Screener. Saves itself, after rules because rules win. */}
				<TriageSettings mailboxId={mailboxId} />

				{/*
				  Grouped with the sender lists above because it is the same shape of
				  decision — a per-sender exception to a default — and uses the same
				  address/@domain grammar. It saves itself: unlike the rest of this
				  page it lives in the browser, not the mailbox.
				*/}
				<RemoteImageSettings />

				{/* Automation */}
				<AutoReplySettingsSection value={autoReply} onChange={setAutoReply} />

				<Section
					title="Automatic draft replies"
					icon={<Bot size={15} className="text-text-tertiary" />}
					description="When mail arrives, the agent reads the thread and prepares a draft reply. Drafts are never sent automatically."
					action={
						<Toggle
							checked={autoDraft}
							onChange={setAutoDraft}
							label="Automatic draft replies"
						/>
					}
				/>

				<Section
					title="Follow-up reminders"
					icon={<MailQuestion size={15} className="text-text-tertiary" />}
					description="If nobody replies to something you sent, the thread comes back to the top of your inbox, unread, with a Follow up label. A reply cancels it; replying again restarts the clock."
				>
					<fieldset>
						<legend className="mb-2 text-xs font-medium text-text-secondary">
							Default for new messages
						</legend>
						<div className="grid gap-2 sm:grid-cols-3">
							{(
								[
									["off", "Off", "Only when you pick a time in the composer."],
									["3d", "3 days", "Every message gets a 3-day reminder."],
									[
										"auto",
										"Auto",
										"AI checks whether the message asks a question or requests something, and reminds you after 3 days only then.",
									],
								] as const
							).map(([value, label, hint]) => (
								<label
									key={value}
									className={`flex cursor-pointer flex-col gap-0.5 rounded-[6px] border px-3 py-2 text-sm touch:min-h-11 ${
										followupDefault === value
											? "border-accent bg-accent-subtle text-accent-subtle-fg"
											: "border-border text-text-primary hover:bg-bg-muted"
									}`}
								>
									<span className="flex items-center gap-2 font-medium">
										<input
											type="radio"
											name="followup-default"
											value={value}
											checked={followupDefault === value}
											onChange={() => setFollowupDefault(value)}
											className="accent-[var(--color-accent)]"
										/>
										{label}
									</span>
									<span className="text-[11px] text-text-secondary">{hint}</span>
								</label>
							))}
						</div>
					</fieldset>
					<div className="mt-4 flex items-start justify-between gap-3">
						<div className="min-w-0">
							<p id="followup-nudge-label" className="text-sm font-medium text-text-primary">
								Draft a nudge when a reminder fires
							</p>
							<p className="mt-0.5 text-[11px] text-text-secondary">
								The agent writes a short follow-up into Drafts for you to review. It is never sent
								automatically. Needs automatic draft replies on.
							</p>
						</div>
						<Toggle
							checked={followupNudge}
							onChange={setFollowupNudge}
							label="Draft a nudge when a reminder fires"
						/>
					</div>
				</Section>

				<Section
					title="Forward incoming mail"
					icon={<Forward size={15} className="text-text-tertiary" />}
					description="Every message this mailbox receives is re-sent to another address, with the original sender named in the display name so replies reach them."
					action={
						<Toggle
							checked={forwardingEnabled}
							onChange={setForwardingEnabled}
							label="Forward incoming mail"
						/>
					}
				>
					{forwardingEnabled && (
						<div>
							<input
								type="email"
								value={forwardingEmail}
								onChange={(e) => setForwardingEmail(e.target.value)}
								placeholder="ops@example.com"
								aria-label="Forward to"
								aria-invalid={forwardingError ? true : undefined}
								className="h-9 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-ring/30"
							/>
							<p
								className={`mt-1.5 text-[11px] ${
									forwardingError ? "text-destructive" : "text-text-tertiary"
								}`}
							>
								{forwardingError ??
									"Blocked senders are never forwarded. Attachments are included up to the 5 MiB message limit; anything larger is named in the forwarded copy instead."}
							</p>
						</div>
					)}
				</Section>

				<Section
					title="Agent prompt"
					icon={<Bot size={15} className="text-text-tertiary" />}
					description="Adds to how the AI agent behaves for this mailbox. Leave empty to use the built-in default. Fixed security rules always come first and can't be changed here."
				>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						rows={10}
						placeholder="You are an email assistant that helps manage this inbox…"
						className="w-full resize-y rounded-[6px] border border-border bg-card px-2.5 py-2 font-mono text-[11px] leading-relaxed text-text-primary outline-none focus:ring-2 focus:ring-ring/30"
					/>
				</Section>

				<TrackingSettingsSection mailboxId={mailboxId!} />
				<AgentSendSettings value={agentSend} onChange={setAgentSend} />

				<Section
					title="Export"
					icon={<Download size={15} className="text-text-tertiary" />}
					description="Download every message in this mailbox as a single mbox file — the format Gmail's own export produces, and the one Thunderbird, Apple Mail and migration tools read."
				>
					{/*
					  A plain link, not a fetch.

					  The response is a stream that can run to hundreds of megabytes, so
					  the browser has to own it: `fetch` would buffer the whole archive
					  into a Blob in the tab before the reader saw a file, which is the
					  one thing the streaming endpoint exists to avoid. A download the
					  browser manages also gets a progress indicator and resumability for
					  free, and cannot be lost by navigating away.
					*/}
					<a
						href={`/api/v1/mailboxes/${encodeURIComponent(mailboxId!)}/export`}
						download
						className="inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-muted"
					>
						<Download size={13} aria-hidden />
						Download mbox
					</a>
					<p className="mt-1.5 text-[11px] text-text-tertiary">
						Message bodies, headers, folders and read state are included.
						Attachments are named in each message rather than embedded, so the
						file stays a reasonable size — download those individually if you
						need them.
					</p>
				</Section>

				<ImportSettingsSection mailboxId={mailboxId!} />
				<SendLimitsSettings mailboxId={mailboxId!} />
				<MailboxDelegates mailboxId={mailboxId!} />
				<MailboxAccessLog mailboxId={mailboxId!} />
			</div>
		</div>
	);
}
