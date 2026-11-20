// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → Account & security → API tokens.
 *
 * Create a token with a name, an expiry, scopes (with presets) and optionally a
 * mailbox allowlist; see it once; list and revoke. A token's effective access is
 * the intersection of the user's own grants, its scopes and its mailboxes, which
 * the Worker enforces. This screen only describes it.
 */

import { Check, Loader2, Plus, Terminal, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import {
	TOKEN_SCOPE_DESCRIPTIONS,
	TOKEN_SCOPE_LABELS,
	TOKEN_SCOPE_PRESETS,
	TOKEN_SCOPES,
	type TokenScope,
} from "../../../shared/token-scopes";
import { formatRelativeTime } from "~/lib/auth-helpers";
import { toast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { useApiTokens, useCreateApiToken, useRevokeApiToken } from "~/queries/auth";
import { useMailboxes } from "~/queries/mailboxes";
import type { ApiTokenInfo } from "~/services/auth-api";
import { authErrorMessage } from "~/services/auth-api";
import {
	ConfirmDialog,
	InlineError,
	ListRow,
	Pill,
	PRIMARY_BUTTON_CLASS,
	ROW_ICON_ACTION_CLASS,
	SecretBox,
	SECONDARY_BUTTON_CLASS,
	SETTINGS_INPUT_CLASS,
	SettingsField,
} from "./settings-ui";

const EXPIRY_OPTIONS: { value: string; label: string; days: number | null }[] = [
	{ value: "30", label: "30 days", days: 30 },
	{ value: "90", label: "90 days", days: 90 },
	{ value: "365", label: "1 year", days: 365 },
	{ value: "never", label: "No expiry", days: null },
];

/** 44px on touch screens, the compact settings size from `sm` up. */
const TOUCH = "max-sm:min-h-11";

function sameSet(a: readonly string[], b: readonly string[]) {
	return a.length === b.length && a.every((x) => b.includes(x));
}

/** One-line description of a token's reach, for the list. */
export function describeTokenScopes(token: Pick<ApiTokenInfo, "scopes" | "mailboxes">): string {
	if (token.scopes === null) {
		// A mailbox allowlist alone means mail scopes only, never admin.
		return token.mailboxes === null ? "Full access (legacy)" : "Mail only";
	}
	if (token.scopes.length === 0) return "No scopes";
	const preset = TOKEN_SCOPE_PRESETS.find((p) => sameSet(p.scopes, token.scopes!));
	if (preset) return preset.label;
	return token.scopes.map((s) => TOKEN_SCOPE_LABELS[s] ?? s).join(", ");
}

export default function ApiTokensPanel({ canCreate }: { canCreate: boolean }) {
	const { data: tokens, isLoading, isError, refetch } = useApiTokens();
	const revoke = useRevokeApiToken();

	// `/settings/account#api-tokens` (the command palette's "API tokens") lands
	// here. Routed settings pages don't scroll to a hash on their own.
	useEffect(() => {
		if (window.location.hash !== "#api-tokens") return;
		document.getElementById("api-tokens")?.scrollIntoView({ block: "start" });
	}, []);

	const [creating, setCreating] = useState(false);
	const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
	const [confirmRevoke, setConfirmRevoke] = useState<ApiTokenInfo | null>(null);

	async function onRevoke() {
		if (!confirmRevoke) return;
		try {
			await revoke.mutateAsync(confirmRevoke.id);
			toast.success(`Revoked “${confirmRevoke.name}”`);
			setConfirmRevoke(null);
		} catch (err) {
			toast.error(authErrorMessage(err, "Couldn't revoke that token."));
		}
	}

	const now = Date.now();
	const childCount = confirmRevoke
		? (tokens ?? []).filter((t) => t.parentId === confirmRevoke.id).length
		: 0;

	return (
		<div
			id="api-tokens"
			className="scroll-mt-20 space-y-3 rounded-[8px] bg-card p-4 ring-1 ring-border max-sm:scroll-mt-36 sm:p-5"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
						<Terminal size={13} className="text-text-tertiary" aria-hidden />
						API tokens
					</h3>
					<p className="mt-1 text-sm text-text-secondary">
						For scripts, the <code className="font-mono">cloudmail</code> CLI and AI clients over MCP.
						A token can only do what you can do, narrowed further by its scopes and mailboxes.{" "}
						<a href="/api/docs" className="font-medium text-accent hover:underline">
							API reference
						</a>
					</p>
				</div>
				{!creating && canCreate ? (
					<button
						type="button"
						onClick={() => {
							setCreating(true);
							setSecret(null);
						}}
						className={cn(SECONDARY_BUTTON_CLASS, TOUCH)}
					>
						<Plus size={13} aria-hidden />
						New token
					</button>
				) : null}
			</div>

			{!canCreate ? (
				<p className="text-xs text-text-tertiary">
					New tokens can only be created from a signed-in browser session.
				</p>
			) : null}

			{secret ? (
				<SecretBox
					label={`Your new token “${secret.name}”`}
					value={secret.value}
					what="Token copied"
					note="Copy it now. It won't be shown again; if you lose it, revoke it and create another."
				>
					<div className="space-y-1.5 pt-1">
						<p className="text-[11px] font-medium text-text-secondary">Use it</p>
						<pre className="overflow-x-auto rounded-[6px] bg-[#0a0a0a] p-3 font-mono text-[11px] leading-relaxed text-white/85">
							{`# HTTP
curl -H "Authorization: Bearer ${secret.value}" \\
  ${typeof window === "undefined" ? "" : window.location.origin}/api/v1/me

# cloudmail CLI
export CLOUDMAIL_TOKEN=${secret.value}`}
						</pre>
						<div className="flex justify-end">
							<button
								type="button"
								onClick={() => setSecret(null)}
								className={cn(PRIMARY_BUTTON_CLASS, "h-8", TOUCH)}
							>
								<Check size={13} aria-hidden />
								Done
							</button>
						</div>
					</div>
				</SecretBox>
			) : null}

			{creating ? (
				<CreateTokenForm
					onCancel={() => setCreating(false)}
					onCreated={(created) => {
						setSecret(created);
						setCreating(false);
					}}
				/>
			) : null}

			{isLoading ? (
				<p className="flex items-center gap-2 text-xs text-text-secondary">
					<Loader2 size={12} className="animate-spin" aria-hidden /> Loading
				</p>
			) : isError ? (
				<p className="text-xs text-text-secondary">
					Couldn't load your tokens.{" "}
					<button type="button" onClick={() => refetch()} className="font-medium text-text-primary hover:underline">
						Retry
					</button>
				</p>
			) : (tokens ?? []).length === 0 ? (
				<p className="rounded-[6px] bg-bg-subtle px-3 py-2.5 text-sm text-text-secondary">No tokens yet.</p>
			) : (
				<ul className="space-y-1.5" aria-label="Your API tokens">
					{(tokens ?? []).map((token) => {
						const expired = token.expiresAt != null && token.expiresAt < now;
						return (
							<ListRow
								key={token.id}
								title={<span className="break-all">{token.name}</span>}
								badges={
									<>
										<code className="font-mono text-[11px] text-text-tertiary">ttk_{token.id}_…</code>
										{expired ? <Pill tone="warning">Expired</Pill> : null}
										{token.parentId ? <Pill>Created by a token</Pill> : null}
										<Pill tone={token.scopes === null && token.mailboxes === null ? "admin" : "violet"}>
											{describeTokenScopes(token)}
										</Pill>
										<Pill>
											{token.mailboxes === null
												? "All your mailboxes"
												: token.mailboxes.length === 1
													? token.mailboxes[0]
													: `${token.mailboxes.length} mailboxes`}
										</Pill>
									</>
								}
								details={[
									token.lastUsedAt
										? `used ${formatRelativeTime(token.lastUsedAt)}${token.lastUsedIp ? ` from ${token.lastUsedIp}` : ""}`
										: "never used",
									token.expiresAt
										? `${expired ? "expired" : "expires"} ${formatRelativeTime(token.expiresAt)}`
										: "no expiry",
								]}
								actions={
									<button
										type="button"
										onClick={() => setConfirmRevoke(token)}
										aria-label={`Revoke token ${token.name}`}
										className={cn(ROW_ICON_ACTION_CLASS, "hover:text-destructive")}
									>
										<Trash2 size={14} aria-hidden />
									</button>
								}
							/>
						);
					})}
				</ul>
			)}

			<ConfirmDialog
				open={confirmRevoke !== null}
				onOpenChange={(open) => !open && setConfirmRevoke(null)}
				title="Revoke this token?"
				description={
					<>
						Anything using “{confirmRevoke?.name}” will stop working immediately
						{childCount > 0 ? `, along with ${childCount} token${childCount === 1 ? "" : "s"} it created` : ""}.
						This can't be undone.
					</>
				}
				confirmLabel="Revoke token"
				onConfirm={onRevoke}
				pending={revoke.isPending}
			/>
		</div>
	);
}

function CreateTokenForm({
	onCancel,
	onCreated,
}: {
	onCancel: () => void;
	onCreated: (secret: { name: string; value: string }) => void;
}) {
	const create = useCreateApiToken();
	const { data: mailboxes } = useMailboxes();
	const idBase = useId();

	const [name, setName] = useState("");
	const [expiry, setExpiry] = useState("90");
	const [scopes, setScopes] = useState<TokenScope[]>(["mail:read"]);
	const [limitMailboxes, setLimitMailboxes] = useState(false);
	const [selectedMailboxes, setSelectedMailboxes] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);

	const activePreset = useMemo(
		() => TOKEN_SCOPE_PRESETS.find((p) => sameSet(p.scopes, scopes))?.id ?? null,
		[scopes],
	);

	function toggleScope(scope: TokenScope) {
		setScopes((current) => {
			if (current.includes(scope)) {
				// Without Send mail, "send without approval" means nothing; drop both.
				const drop = scope === "mail:send" ? ["mail:send", "mail:send:auto"] : [scope];
				return current.filter((s) => !drop.includes(s));
			}
			// Ticking "send without approval" implies Send mail.
			const add = scope === "mail:send:auto" ? ["mail:send", scope] : [scope];
			return TOKEN_SCOPES.filter((s) => add.includes(s) || current.includes(s));
		});
	}

	function toggleMailbox(address: string) {
		setSelectedMailboxes((current) =>
			current.includes(address) ? current.filter((m) => m !== address) : [...current, address],
		);
	}

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!name.trim()) return setError("Give the token a name, like “laptop CLI” or “CI”.");
		if (scopes.length === 0) return setError("Pick at least one scope.");
		if (limitMailboxes && selectedMailboxes.length === 0) return setError("Pick at least one mailbox, or allow all.");
		const days = EXPIRY_OPTIONS.find((o) => o.value === expiry)?.days ?? null;
		try {
			const result = await create.mutateAsync({
				name: name.trim(),
				expiresInDays: days,
				scopes,
				mailboxes: limitMailboxes ? selectedMailboxes : null,
			});
			onCreated({ name: result.token.name, value: result.secret });
		} catch (err) {
			setError(authErrorMessage(err, "Couldn't create the token."));
		}
	}

	const pending = create.isPending;

	return (
		<form onSubmit={onSubmit} className="space-y-4 rounded-[6px] bg-bg-subtle/60 p-3 ring-1 ring-border sm:p-4">
			<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
				<SettingsField
					label="Name"
					placeholder="Laptop CLI"
					maxLength={80}
					// biome-ignore lint/a11y/noAutofocus: opened by an explicit click.
					autoFocus
					value={name}
					onChange={(e) => setName(e.target.value)}
					disabled={pending}
					inputClassName={TOUCH}
				/>
				<div className="space-y-1.5">
					<label htmlFor={`${idBase}-expiry`} className="block text-[11px] font-medium text-text-secondary">
						Expires
					</label>
					<select
						id={`${idBase}-expiry`}
						value={expiry}
						onChange={(e) => setExpiry(e.target.value)}
						disabled={pending}
						className={cn(SETTINGS_INPUT_CLASS, TOUCH)}
					>
						{EXPIRY_OPTIONS.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
				</div>
			</div>

			<fieldset className="space-y-2" disabled={pending}>
				<legend className="text-[11px] font-medium text-text-secondary">Scopes</legend>
				<div role="group" aria-label="Scope presets" className="flex flex-wrap gap-1.5">
					{TOKEN_SCOPE_PRESETS.map((preset) => (
						<button
							key={preset.id}
							type="button"
							aria-pressed={activePreset === preset.id}
							onClick={() => setScopes([...preset.scopes])}
							className={cn(
								"h-8 rounded-full px-3 text-[13px] font-medium ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/60",
								TOUCH,
								activePreset === preset.id
									? "bg-accent-subtle text-accent-subtle-fg ring-accent/40"
									: "bg-card text-text-secondary ring-border hover:bg-bg-muted",
							)}
						>
							{preset.label}
						</button>
					))}
				</div>
				<ul className="grid gap-1 sm:grid-cols-2">
					{TOKEN_SCOPES.map((scope) => {
						const id = `${idBase}-scope-${scope}`;
						return (
							<li key={scope}>
								<label
									htmlFor={id}
									className="flex cursor-pointer items-start gap-2.5 rounded-[6px] px-2 py-2 hover:bg-bg-muted max-sm:min-h-11"
								>
									<input
										id={id}
										type="checkbox"
										checked={scopes.includes(scope)}
										onChange={() => toggleScope(scope)}
										className="mt-0.5 size-4 shrink-0 accent-accent"
									/>
									<span className="min-w-0">
										<span className="block text-[13px] font-medium text-text-primary">
											{TOKEN_SCOPE_LABELS[scope]}{" "}
											<code className="font-mono text-[11px] font-normal text-text-tertiary">{scope}</code>
										</span>
										<span className="block text-xs text-text-secondary">{TOKEN_SCOPE_DESCRIPTIONS[scope]}</span>
									</span>
								</label>
							</li>
						);
					})}
				</ul>
			</fieldset>

			<fieldset className="space-y-2" disabled={pending}>
				<legend className="text-[11px] font-medium text-text-secondary">Mailboxes</legend>
				<div role="radiogroup" aria-label="Mailbox access" className="flex flex-wrap gap-x-4 gap-y-1">
					<label className="flex cursor-pointer items-center gap-2 text-[13px] text-text-primary max-sm:min-h-11">
						<input
							type="radio"
							name={`${idBase}-mailbox-mode`}
							checked={!limitMailboxes}
							onChange={() => setLimitMailboxes(false)}
							className="size-4"
						/>
						All mailboxes you can reach
					</label>
					<label className="flex cursor-pointer items-center gap-2 text-[13px] text-text-primary max-sm:min-h-11">
						<input
							type="radio"
							name={`${idBase}-mailbox-mode`}
							checked={limitMailboxes}
							onChange={() => setLimitMailboxes(true)}
							className="size-4"
						/>
						Only these
					</label>
				</div>
				{limitMailboxes ? (
					(mailboxes ?? []).length === 0 ? (
						<p className="text-xs text-text-tertiary">You don't have access to any mailboxes yet.</p>
					) : (
						<ul
							aria-label="Mailboxes this token may use"
							className="max-h-56 space-y-0.5 overflow-y-auto rounded-[6px] bg-card p-1 ring-1 ring-border"
						>
							{(mailboxes ?? []).map((mailbox) => {
								const address = mailbox.email.toLowerCase();
								const id = `${idBase}-mb-${address}`;
								return (
									<li key={address}>
										<label
											htmlFor={id}
											className="flex cursor-pointer items-center gap-2.5 rounded-[4px] px-2 py-1.5 hover:bg-bg-muted max-sm:min-h-11"
										>
											<input
												id={id}
												type="checkbox"
												checked={selectedMailboxes.includes(address)}
												onChange={() => toggleMailbox(address)}
												className="size-4 shrink-0"
											/>
											<span className="min-w-0 truncate text-[13px] text-text-primary">{mailbox.email}</span>
										</label>
									</li>
								);
							})}
						</ul>
					)
				) : null}
			</fieldset>

			<InlineError message={error} />
			<div className="flex flex-wrap gap-2">
				<button type="submit" disabled={pending} className={cn(PRIMARY_BUTTON_CLASS, TOUCH)}>
					{pending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
					Create token
				</button>
				<button type="button" onClick={onCancel} className={cn(SECONDARY_BUTTON_CLASS, TOUCH)}>
					Cancel
				</button>
			</div>
		</form>
	);
}
