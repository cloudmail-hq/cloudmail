/**
 * Passkeys: add, rename and remove the passkeys that sign in to this account.
 * A passkey turns two-factor on: password sign-ins then ask for one. The
 * first passkey comes with recovery codes, shown here once.
 *
 * Adding or removing one changes how the account signs in, so the Worker asks
 * for a recent proof (`factorChangeGuard`): a passkey or an app code in the
 * last 5 minutes once the account has either, else a sign-in or password in
 * the last 15. Past that, this panel asks the user to confirm first
 * (`StepUpPrompt`), then carries on with what they were doing.
 */

import { Fingerprint, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatRelativeTime } from "~/lib/auth-helpers";
import RecoveryCodesBox from "./RecoveryCodesBox";
import StepUpPrompt, { type StepUpInput } from "./StepUpPrompt";
import { describePasskeyError, isPasskeyCancel, passkeysSupported } from "~/lib/passkeys";
import { toast } from "~/lib/toast";
import {
	useDeletePasskey,
	usePasskeys,
	useReauth,
	useRefreshAccount,
	useRegisterPasskey,
	useRenamePasskey,
} from "~/queries/auth";
import { authErrorCode, authErrorMessage, needsSecondFactorStepUp, type PasskeyInfo } from "~/services/auth-api";
import {
	ConfirmDialog,
	InlineError,
	ListRow,
	Pill,
	PRIMARY_BUTTON_CLASS,
	ROW_ICON_ACTION_CLASS,
	SECONDARY_BUTTON_CLASS,
	SettingsField,
} from "./settings-ui";
import { cn } from "~/lib/utils";
import { passkeyProviderName } from "../../../shared/passkey-providers";

type Mode =
	| { kind: "idle" }
	/** Confirm with a factor first, then carry on with `then`. */
	| {
			kind: "reauth";
			then: { kind: "add" } | { kind: "delete"; passkey: PasskeyInfo };
			/** The Worker wants a passkey or app code, not the password. */
			secondFactor: boolean;
	  }
	| { kind: "rename"; passkey: PasskeyInfo; refreshAfter?: boolean }
	/** A first passkey's recovery codes, then naming that passkey. */
	| { kind: "codes"; codes: string[]; passkey: PasskeyInfo };

/** The provider ("in 1Password") when the AAGUID names one the passkey's own name doesn't. */
function providerDetail(p: PasskeyInfo): string | null {
	const provider = passkeyProviderName(p.aaguid);
	if (!provider || p.name.toLowerCase().includes(provider.toLowerCase())) return null;
	return `in ${provider}`;
}

/** "Synced" passkeys survive losing the device; device-bound ones do not. */
function describeKind(p: PasskeyInfo): string {
	if (p.deviceType === "multiDevice") return p.backedUp ? "Synced passkey" : "Syncable passkey";
	return "This device only";
}

export default function PasskeySettings({ totpEnabled, canManage }: { totpEnabled: boolean; canManage: boolean }) {
	const { data: passkeys, isLoading, isError, refetch } = usePasskeys();
	const register = useRegisterPasskey();
	const reauth = useReauth();
	const rename = useRenamePasskey();
	const remove = useDeletePasskey();
	const refreshAccount = useRefreshAccount();
	// A first passkey holds back the `/me` refresh until its codes are saved and
	// it is named. If the panel goes away first, refresh then (see TwoFactorSettings).
	const refreshPending = useRef(false);
	const refreshRef = useRef(refreshAccount);
	refreshRef.current = refreshAccount;
	useEffect(
		() => () => {
			if (refreshPending.current) refreshRef.current();
		},
		[],
	);

	const [mode, setMode] = useState<Mode>({ kind: "idle" });
	const [error, setError] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [confirmDelete, setConfirmDelete] = useState<PasskeyInfo | null>(null);
	const [supported, setSupported] = useState(true);

	// Decided after hydration: the server render cannot know.
	useEffect(() => setSupported(passkeysSupported()), []);
	// The "Add a passkey" prompt links to `#passkeys`; routed pages don't scroll to a hash.
	useEffect(() => {
		if (window.location.hash !== "#passkeys") return;
		document.getElementById("passkeys")?.scrollIntoView({ block: "start" });
	}, []);

	refreshPending.current = mode.kind === "codes" || (mode.kind === "rename" && mode.refreshAfter === true);

	const list = passkeys ?? [];

	function reset() {
		setMode({ kind: "idle" });
		setName("");
		setError(null);
	}

	async function add() {
		setError(null);
		try {
			const { passkey, recoveryCodes } = await register.mutateAsync(undefined);
			toast.success(`Added “${passkey.name}”`, { description: "Give it a name you'll recognise." });
			// A first passkey brings recovery codes. They come first, since they
			// are shown only once; naming the passkey can wait.
			if (recoveryCodes?.length) {
				setMode({ kind: "codes", codes: recoveryCodes, passkey });
				return;
			}
			// Straight into naming it: "Passkey 2" tells nobody which device it is.
			setMode({ kind: "rename", passkey });
			setName(passkey.name);
		} catch (err) {
			if (authErrorCode(err) === "reauth_required") {
				setMode({ kind: "reauth", then: { kind: "add" }, secondFactor: needsSecondFactorStepUp(err) });
				return;
			}
			if (isPasskeyCancel(err)) return;
			setError(
				authErrorCode(err)
					? authErrorMessage(err, "Couldn't add the passkey.")
					: describePasskeyError(err, "Couldn't add the passkey."),
			);
		}
	}

	async function confirm(input: StepUpInput) {
		if (mode.kind !== "reauth") return;
		const next = mode.then;
		setError(null);
		try {
			await reauth.mutateAsync(input);
		} catch (err) {
			if (isPasskeyCancel(err)) return;
			setError(
				authErrorCode(err)
					? authErrorMessage(err, "Couldn't confirm it's you.")
					: describePasskeyError(err, "Couldn't confirm it's you."),
			);
			return;
		}
		if (next.kind === "delete") {
			reset();
			await removePasskey(next.passkey);
			return;
		}
		setMode({ kind: "idle" });
		await add();
	}

	/** Remove, or ask to confirm first; the confirm step calls this again. */
	async function removePasskey(passkey: PasskeyInfo): Promise<boolean> {
		try {
			await remove.mutateAsync(passkey.id);
			toast.success(`Removed “${passkey.name}”`);
			return true;
		} catch (err) {
			if (authErrorCode(err) === "reauth_required") {
				setError(null);
				setMode({ kind: "reauth", then: { kind: "delete", passkey }, secondFactor: needsSecondFactorStepUp(err) });
				return true;
			}
			toast.error(authErrorMessage(err, "Couldn't remove that passkey."));
			return false;
		}
	}

	async function onRename(e: React.FormEvent) {
		e.preventDefault();
		if (mode.kind !== "rename") return;
		setError(null);
		if (!name.trim()) return setError("Give the passkey a name.");
		try {
			await rename.mutateAsync({ id: mode.passkey.id, name: name.trim() });
			afterRename();
		} catch (err) {
			setError(authErrorMessage(err, "Couldn't rename the passkey."));
		}
	}

	/**
	 * Leave naming. After a first passkey, refresh the account only now: on the
	 * two-factor enrolment screen that refresh leaves the screen.
	 */
	function afterRename() {
		const refresh = mode.kind === "rename" && mode.refreshAfter;
		reset();
		if (refresh) refreshAccount();
	}

	async function onDelete() {
		if (!confirmDelete) return;
		// On `reauth_required` the dialog closes and the confirm step takes over.
		if (await removePasskey(confirmDelete)) setConfirmDelete(null);
	}

	const busy = register.isPending || reauth.isPending || remove.isPending;

	return (
		<div id="passkeys" className="scroll-mt-24 space-y-4 p-5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="flex items-center gap-2 text-sm font-medium text-text-primary">
						Passkeys
						{list.length > 0 ? <Pill tone="success">{list.length}</Pill> : null}
					</h3>
					<p className="mt-1 text-sm text-text-secondary">
						Sign in with your fingerprint, face or device PIN instead of a password. Having a
						passkey also turns on two-factor: signing in with your password then asks for one.
					</p>
				</div>
				{mode.kind === "idle" && canManage && supported ? (
					<button type="button" onClick={add} disabled={busy} className={SECONDARY_BUTTON_CLASS}>
						{busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Plus size={13} aria-hidden />}
						Add a passkey
					</button>
				) : null}
			</div>

			{!supported ? (
				<p className="text-xs text-text-tertiary">This browser doesn't support passkeys.</p>
			) : null}
			{!canManage ? (
				<p className="text-xs text-text-tertiary">
					Passkeys can only be managed from a signed-in browser session.
				</p>
			) : null}

			{mode.kind === "reauth" ? (
				<StepUpPrompt
					message={
						mode.then.kind === "delete"
							? `Removing “${mode.then.passkey.name}” changes how you sign in.`
							: mode.secondFactor || list.length > 0 || totpEnabled
								? "Adding a passkey changes how you sign in. Confirm with a passkey or code you already have."
								: "You signed in a while ago. Confirm before adding a new way to sign in."
					}
					passkeys={list.length > 0}
					totp={totpEnabled}
					secondFactorRequired={mode.secondFactor}
					busy={busy}
					error={error}
					onConfirm={confirm}
					onCancel={reset}
				/>
			) : null}

			{mode.kind === "rename" ? (
				<form onSubmit={onRename} className="flex flex-wrap items-end gap-2 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
					<SettingsField
						label="Passkey name"
						placeholder="MacBook Touch ID"
						maxLength={64}
						// biome-ignore lint/a11y/noAutofocus: opened by an explicit action.
						autoFocus
						value={name}
						onChange={(e) => setName(e.target.value)}
						disabled={rename.isPending}
						className="w-full max-w-xs"
					/>
					<button type="submit" disabled={rename.isPending} className={PRIMARY_BUTTON_CLASS}>
						{rename.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
						Save
					</button>
					<button type="button" onClick={afterRename} className={SECONDARY_BUTTON_CLASS}>
						{mode.refreshAfter ? "Skip" : "Cancel"}
					</button>
				</form>
			) : null}

			{mode.kind === "codes" ? (
				<div className="rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
					<RecoveryCodesBox
						codes={mode.codes}
						intro="Two-factor sign-in is now on: signing in with your password also asks for a passkey. If you lose your passkeys, each of these codes signs you in once."
						onDone={() => {
							const { passkey } = mode;
							reset();
							setMode({ kind: "rename", passkey, refreshAfter: true });
							setName(passkey.name);
						}}
					/>
				</div>
			) : null}

			{/* The confirm step shows its own errors. */}
			<InlineError message={mode.kind === "reauth" ? null : error} />

			{isLoading ? (
				<p className="flex items-center gap-2 text-xs text-text-secondary">
					<Loader2 size={12} className="animate-spin" aria-hidden /> Loading
				</p>
			) : isError ? (
				<p className="text-xs text-text-secondary">
					Couldn't load your passkeys.{" "}
					<button type="button" onClick={() => refetch()} className="font-medium text-text-primary hover:underline">
						Retry
					</button>
				</p>
			) : list.length > 0 ? (
				<ul className="space-y-1.5">
					{list.map((p) => (
						<ListRow
							key={p.id}
							icon={<Fingerprint size={14} />}
							title={p.name}
							badges={
								<Pill tone={p.deviceType === "multiDevice" ? "violet" : "muted"}>{describeKind(p)}</Pill>
							}
							details={[
								// Where it is kept, unless the name already says so.
								providerDetail(p),
								`added ${formatRelativeTime(p.createdAt)}`,
								p.lastUsedAt ? `used ${formatRelativeTime(p.lastUsedAt)}` : "never used",
							]}
							actions={
								canManage ? (
									<>
										<button
											type="button"
											onClick={() => {
												setError(null);
												setName(p.name);
												setMode({ kind: "rename", passkey: p });
											}}
											aria-label={`Rename passkey ${p.name}`}
											className={ROW_ICON_ACTION_CLASS}
										>
											<Pencil size={13} aria-hidden />
										</button>
										<button
											type="button"
											onClick={() => setConfirmDelete(p)}
											aria-label={`Remove passkey ${p.name}`}
											className={cn(ROW_ICON_ACTION_CLASS, "hover:text-destructive")}
										>
											<Trash2 size={14} aria-hidden />
										</button>
									</>
								) : null
							}
						/>
					))}
				</ul>
			) : null}

			<ConfirmDialog
				open={confirmDelete !== null}
				onOpenChange={(open) => !open && setConfirmDelete(null)}
				title="Remove this passkey?"
				description={
					<>
						“{confirmDelete?.name}” will no longer sign in to this account. Remove it from the device
						or password manager too.
					</>
				}
				confirmLabel="Remove passkey"
				onConfirm={onDelete}
				pending={remove.isPending}
			/>
		</div>
	);
}
