/**
 * Settings → Groups: addresses like team@ that deliver a copy into each
 * member's own mailbox. For one shared inbox several people answer from
 * (support@), a shared mailbox is the better fit; the help text says so.
 */

import { Check, Plus, Trash2, UsersRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { errorMessage, toast } from "~/lib/toast";
import { confirmAction } from "~/lib/confirm";
import { useMailboxes } from "~/queries/mailboxes";
import { type MailGroup, useDeleteGroup, useGroups, useSaveGroup } from "~/queries/groups";
import {
	InlineError,
	PRIMARY_BUTTON_CLASS,
	SECONDARY_BUTTON_CLASS,
	SETTINGS_INPUT_CLASS,
	SectionHeading,
} from "./settings-ui";

const CHIP_ON = "bg-bg-muted text-text-primary ring-primary/50";
const CHIP_OFF = "bg-bg-subtle text-text-secondary ring-border";

export default function GroupsSettings() {
	const groups = useGroups();
	const [editing, setEditing] = useState<MailGroup | "new" | null>(null);

	return (
		<section className="space-y-3">
			<SectionHeading icon={UsersRound} title="Groups" busy={groups.isFetching} />
			<div className="space-y-4 rounded-[8px] bg-card p-5 ring-1 ring-border">
				<p className="text-sm text-text-secondary">
					A group address, like team@ or founders@, delivers a copy of each message into every member's own inbox.
					Members reply from their own address. For one inbox that several people work from, like support@, create a
					mailbox and share it in Mailbox access instead.
				</p>

				{groups.isLoading ? (
					<p className="text-sm text-text-tertiary">Loading…</p>
				) : groups.isError ? (
					<InlineError message="Couldn't load groups." />
				) : (groups.data ?? []).length === 0 && editing === null ? (
					<p className="text-sm text-text-tertiary">No groups yet.</p>
				) : (
					<ul className="space-y-1.5">
						{(groups.data ?? []).map((g) => (
							<GroupRow key={g.address} group={g} onEdit={() => setEditing(g)} />
						))}
					</ul>
				)}

				{editing ? (
					<GroupForm
						initial={editing === "new" ? null : editing}
						existing={(groups.data ?? []).map((g) => g.address)}
						onDone={() => setEditing(null)}
					/>
				) : (
					<button type="button" onClick={() => setEditing("new")} className={`${SECONDARY_BUTTON_CLASS} h-8`}>
						<Plus size={13} aria-hidden /> New group
					</button>
				)}
			</div>
		</section>
	);
}

function GroupRow({ group, onEdit }: { group: MailGroup; onEdit: () => void }) {
	const remove = useDeleteGroup();
	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[6px] bg-bg-subtle px-3 py-2 text-xs">
			<button type="button" onClick={onEdit} className="min-w-0 truncate text-left font-mono font-medium text-text-primary hover:underline">
				{group.address}
			</button>
			{group.name ? <span className="text-text-secondary">{group.name}</span> : null}
			<span className="min-w-0 flex-1 truncate text-text-tertiary">
				{group.members.length} {group.members.length === 1 ? "member" : "members"}: {group.members.join(", ")}
			</span>
			<button
				type="button"
				aria-label={`Delete group ${group.address}`}
				disabled={remove.isPending}
				onClick={async () => {
					const ok = await confirmAction({
						title: `Delete ${group.address}?`,
						description: "Mail to it will no longer be delivered.",
						confirmLabel: "Delete group",
					});
					if (!ok) return;
					try {
						await remove.mutateAsync(group.address);
						toast.success(`Deleted ${group.address}`);
					} catch (e) {
						toast.error(errorMessage(e, "Couldn't delete the group."));
					}
				}}
				className="rounded-[4px] p-1.5 text-text-tertiary hover:bg-bg-muted hover:text-destructive disabled:opacity-50"
			>
				<Trash2 size={13} />
			</button>
		</li>
	);
}

function GroupForm({ initial, existing, onDone }: { initial: MailGroup | null; existing: string[]; onDone: () => void }) {
	const { data: mailboxes = [] } = useMailboxes();
	const save = useSaveGroup();
	const [address, setAddress] = useState(initial?.address ?? "");
	const [name, setName] = useState(initial?.name ?? "");
	const [members, setMembers] = useState<string[]>(initial?.members ?? []);
	const [error, setError] = useState<string | null>(null);
	const addresses = mailboxes.map((m) => m.email).filter((a) => a !== address.trim().toLowerCase());

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		setError(null);
		const addr = address.trim().toLowerCase();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return setError("Enter the group's full address, e.g. team@example.com.");
		if (!initial && existing.includes(addr)) return setError(`${addr} is already a group.`);
		if (members.length === 0) return setError("Pick at least one member.");
		try {
			await save.mutateAsync({ address: addr, name, members });
			toast.success(initial ? `Saved ${addr}` : `Created ${addr}`);
			onDone();
		} catch (err) {
			setError(errorMessage(err, "Couldn't save the group."));
		}
	}

	return (
		<form onSubmit={onSubmit} className="space-y-3 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
			<div className="flex flex-wrap gap-3">
				<label className="space-y-1.5 text-[11px] font-medium text-text-secondary">
					Address
					<input
						type="email"
						value={address}
						onChange={(e) => setAddress(e.target.value)}
						disabled={!!initial || save.isPending}
						placeholder="team@example.com"
						className={`${SETTINGS_INPUT_CLASS} block w-64`}
					/>
				</label>
				<label className="space-y-1.5 text-[11px] font-medium text-text-secondary">
					Name (optional)
					<input
						value={name}
						onChange={(e) => setName(e.target.value)}
						disabled={save.isPending}
						placeholder="Everyone"
						className={`${SETTINGS_INPUT_CLASS} block w-48`}
					/>
				</label>
			</div>
			<fieldset className="space-y-2">
				<legend className="text-[11px] font-medium text-text-secondary">Members</legend>
				{addresses.length === 0 ? (
					<p className="text-sm text-text-tertiary">No mailboxes yet. Create one first.</p>
				) : (
					<div className="flex flex-wrap gap-1.5">
						{addresses.map((a) => {
							const on = members.includes(a);
							return (
								<label
									key={a}
									className={`flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-2 text-xs ring-1 focus-within:ring-2 focus-within:ring-violet/50 ${on ? CHIP_ON : CHIP_OFF}`}
								>
									<input
										type="checkbox"
										checked={on}
										onChange={() => setMembers((cur) => (on ? cur.filter((m) => m !== a) : [...cur, a]))}
										disabled={save.isPending}
										className="sr-only"
									/>
									{on ? <Check size={12} aria-hidden /> : <Plus size={12} aria-hidden />}
									{a}
								</label>
							);
						})}
					</div>
				)}
			</fieldset>
			<InlineError message={error} />
			<div className="flex gap-2">
				<button type="submit" disabled={save.isPending} className={`${PRIMARY_BUTTON_CLASS} h-8`}>
					{initial ? "Save group" : "Create group"}
				</button>
				<button type="button" onClick={onDone} disabled={save.isPending} className={`${SECONDARY_BUTTON_CLASS} h-8`}>
					Cancel
				</button>
			</div>
		</form>
	);
}
