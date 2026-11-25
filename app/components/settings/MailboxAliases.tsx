/**
 * Extra addresses delivered to this mailbox, and sendable from it.
 *
 * Everyone who can open the mailbox sees the list (the composer offers the
 * aliases as From addresses); only administrators can change it, because an
 * alias claims an address on a domain for the whole deployment.
 *
 * Adding or removing an alias saves at once (one PUT, which replaces the
 * list). It used to stage edits behind a separate "Save aliases" button, a
 * second save model on a page that already has "Save changes": an alias typed
 * and "added" was easy to leave unsaved.
 */

import { AtSign, Loader2, Plus, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { errorMessage, showToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { useMailboxAliases, useSetMailboxAliases } from "~/queries/domains";
import { queryKeys } from "~/queries/keys";
import { useCurrentUser } from "~/queries/people";
import api from "~/services/api";
import { checkAlias } from "../../../shared/domains-ui";
import {
	InlineError,
	SECONDARY_BUTTON_CLASS,
	SETTINGS_INPUT_CLASS,
} from "./settings-ui";

const TOUCH = "min-h-11 sm:min-h-9";

export default function MailboxAliases({
	mailboxId,
	mailboxEmail,
}: {
	mailboxId: string;
	mailboxEmail: string;
}) {
	const { data: me } = useCurrentUser();
	const isAdmin = me?.role === "admin";
	const { data: saved = [], isLoading, error: loadError } = useMailboxAliases(mailboxId);
	const setAliases = useSetMailboxAliases();
	const { data: config } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
	});

	const [draft, setDraft] = useState<string[]>(saved);
	const [input, setInput] = useState("");
	const [error, setError] = useState<string | null>(null);

	// Re-seed from the server whenever the stored list changes (load or save).
	const savedKey = saved.join(",");
	useEffect(() => {
		setDraft(saved);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [savedKey]);

	const add = (e: FormEvent) => {
		e.preventDefault();
		const check = checkAlias(input, {
			mailboxEmail,
			existing: draft,
			domains: config?.domains ?? [],
		});
		if (!check.ok) {
			setError(check.error);
			return;
		}
		setError(null);
		save([...draft, check.alias], `Added ${check.alias}`, () => setInput(""));
	};

	const save = (next: string[], done: string, onSaved?: () => void) => {
		const previous = draft;
		setDraft(next);
		setAliases.mutate(
			{ mailboxId, aliases: next },
			{
				onSuccess: () => {
					setError(null);
					onSaved?.();
					showToast({ kind: "success", message: done });
				},
				onError: (err) => {
					setDraft(previous);
					setError(errorMessage(err, "Couldn't save the aliases."));
				},
			},
		);
	};

	return (
		<section className="rounded-[8px] border border-border bg-card p-5">
			<div className="mb-4 min-w-0">
				<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
					<AtSign size={15} className="text-text-tertiary" aria-hidden />
					Addresses
				</h2>
				<p className="mt-1 text-sm text-text-secondary">
					Mail to any of these aliases lands in this mailbox, and you can send from
					them. {isAdmin ? "" : "Only an administrator can change them."}
				</p>
			</div>

			<ul className="space-y-1.5">
				<li className="flex min-h-9 items-center gap-2 rounded-[6px] border border-border bg-bg-subtle/50 px-2.5 py-1.5">
					<span className="min-w-0 flex-1 break-all text-sm text-text-primary">
						{mailboxEmail}
					</span>
					<span className="shrink-0 rounded-full bg-bg-muted px-2 py-0.5 text-[11px] font-medium text-text-secondary">
						Primary
					</span>
				</li>
				{draft.map((alias) => (
					<li
						key={alias}
						className="flex min-h-9 items-center gap-2 rounded-[6px] border border-border bg-bg-subtle/50 px-2.5 py-1"
					>
						<span className="min-w-0 flex-1 break-all text-sm text-text-primary">
							{alias}
						</span>
						{isAdmin ? (
							<button
								type="button"
								onClick={() => save(draft.filter((a) => a !== alias), `Removed ${alias}`)}
								disabled={setAliases.isPending}
								aria-label={`Remove alias ${alias}`}
								className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50 sm:h-7 sm:w-7"
							>
								<X size={14} aria-hidden />
							</button>
						) : null}
					</li>
				))}
				{isLoading ? (
					<li className="flex items-center gap-2 text-sm text-text-tertiary">
						<Loader2 size={13} className="animate-spin" aria-hidden />
						Loading aliases…
					</li>
				) : draft.length === 0 && !loadError ? (
					<li className="text-sm text-text-tertiary">No other addresses yet.</li>
				) : null}
			</ul>

			{isAdmin ? (
				<>
					<form onSubmit={add} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
						<label htmlFor="alias-input" className="sr-only">
							Alias address
						</label>
						<input
							id="alias-input"
							type="email"
							value={input}
							onChange={(e) => {
								setInput(e.target.value);
								if (error) setError(null);
							}}
							placeholder={`New alias, e.g. billing@${mailboxEmail.split("@")[1] ?? "example.com"}`}
							autoCapitalize="none"
							spellCheck={false}
							aria-invalid={error ? true : undefined}
							className={cn(SETTINGS_INPUT_CLASS, TOUCH, "min-w-0 flex-1")}
						/>
						<button
							type="submit"
							disabled={!input.trim() || setAliases.isPending}
							className={cn(SECONDARY_BUTTON_CLASS, TOUCH, "justify-center")}
						>
							{setAliases.isPending ? (
								<Loader2 size={13} className="animate-spin" aria-hidden />
							) : (
								<Plus size={13} aria-hidden />
							)}
							Add alias
						</button>
					</form>
					<div className="mt-2">
						<InlineError message={error} />
					</div>
				</>
			) : null}
			{loadError && !isLoading ? (
				<p className="mt-2 text-xs text-text-tertiary">
					{errorMessage(loadError, "Couldn't load aliases.")}
				</p>
			) : null}
		</section>
	);
}
