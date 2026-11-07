/**
 * Enrol a contact into a sequence.
 *
 * This existed only as an API call before: the sequence detail page told the user
 * to "use the API to enroll contacts into this sequence", which made the whole
 * feature unreachable from the product.
 *
 * Contacts are searched against the people aggregate — mail this deployment has
 * actually handled — rather than a free-text address field, because enrolling
 * needs a `personId` and inventing one would create an enrollment that no contact
 * view could ever find.
 */

import { useMemo, useState } from "react";
import { Loader2, Search, UserPlus, X } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { avatarColor, cn, initials } from "~/lib/utils";
import { errorMessage, showToast } from "~/lib/toast";
import { useMailboxes } from "~/queries/mailboxes";
import { usePeople } from "~/queries/people";
import { useEnrollInSequence } from "~/queries/sequences";
import type { GroupedPerson } from "../../shared/people";

interface EnrollContactDialogProps {
	sequenceId: string;
	sequenceName: string;
	/** Number of steps, so the confirmation can say how much mail this schedules. */
	stepCount: number;
	open: boolean;
	onClose: () => void;
}

export default function EnrollContactDialog({
	sequenceId,
	sequenceName,
	stepCount,
	open,
	onClose,
}: EnrollContactDialogProps) {
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState<GroupedPerson | null>(null);
	const [fromAddress, setFromAddress] = useState("");

	const { data: mailboxes = [] } = useMailboxes();
	const enroll = useEnrollInSequence();

	// Only query once the input looks like a search rather than a keystroke.
	const query = search.trim().length >= 2 ? search.trim() : undefined;
	const { data, isFetching } = usePeople(
		{ search: query, page: 1, pageSize: 8 },
		{ enabled: open && !!query },
	);

	const people = useMemo(() => data?.people ?? [], [data]);

	// Default the sender to the first mailbox rather than leaving it blank: the
	// field is required and one mailbox is the common case.
	const effectiveFrom = fromAddress || mailboxes[0]?.email || "";

	const reset = () => {
		setSearch("");
		setSelected(null);
		setFromAddress("");
	};

	const submit = async () => {
		if (!selected || !effectiveFrom) return;
		try {
			await enroll.mutateAsync({
				sequenceId,
				personId: selected.id,
				personEmail: selected.email,
				personName: selected.name ?? null,
				fromAddress: effectiveFrom,
			});
			showToast({
				kind: "success",
				message: `${selected.name || selected.email} enrolled`,
				description:
					stepCount === 1
						? "One message is scheduled."
						: `${stepCount} messages are scheduled.`,
			});
			reset();
			onClose();
		} catch (err) {
			showToast({
				kind: "error",
				// The server returns 409 with a readable message when the contact is
				// already in an active sequence, which is the common failure.
				message: errorMessage(err, "Could not enrol that contact."),
			});
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					reset();
					onClose();
				}
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Enrol a contact</DialogTitle>
				</DialogHeader>

				<p className="text-xs font-light text-text-secondary">
					Schedules {stepCount === 1 ? "one message" : `${stepCount} messages`}{" "}
					from <span className="font-medium">{sequenceName}</span>. Steps are sent
					on their configured delays and can be cancelled at any point.
				</p>

				{/* Contact search */}
				<div className="space-y-2">
					<label
						htmlFor="enroll-search"
						className="block text-xs font-medium text-text-secondary"
					>
						Contact
					</label>

					{selected ? (
						<div className="flex items-center gap-2 rounded-[8px] border border-border bg-bg-subtle px-2.5 py-2">
							<span
								className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
								style={{
									backgroundColor: avatarColor(selected.email).bg,
									color: avatarColor(selected.email).fg,
								}}
								aria-hidden
							>
								{initials(selected.name, selected.email)}
							</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-xs font-semibold text-text-primary">
									{selected.name || selected.email}
								</span>
								<span className="block truncate text-[11px] font-light text-text-tertiary">
									{selected.email}
								</span>
							</span>
							<button
								type="button"
								onClick={() => setSelected(null)}
								aria-label="Choose a different contact"
								className="rounded-[6px] p-1 text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
							>
								<X size={13} />
							</button>
						</div>
					) : (
						<>
							<div className="relative">
								<Search
									size={13}
									className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
									aria-hidden
								/>
								<input
									id="enroll-search"
									autoFocus
									value={search}
									onChange={(e) => setSearch(e.target.value)}
									placeholder="Search by name or address"
									className="w-full rounded-[6px] border border-border bg-card py-1.5 pl-8 pr-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:ring-2 focus:ring-text-primary/15"
								/>
								{isFetching && (
									<Loader2
										size={13}
										className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-text-tertiary"
										aria-hidden
									/>
								)}
							</div>

							{query && people.length > 0 && (
								<ul className="max-h-52 overflow-y-auto rounded-[8px] border border-border">
									{people.map((person) => {
										const palette = avatarColor(person.email);
										return (
											<li key={person.id}>
												<button
													type="button"
													onClick={() => setSelected(person)}
													className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg-subtle"
												>
													<span
														className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold"
														style={{
															backgroundColor: palette.bg,
															color: palette.fg,
														}}
														aria-hidden
													>
														{initials(person.name, person.email)}
													</span>
													<span className="min-w-0 flex-1">
														<span className="block truncate text-xs font-medium text-text-primary">
															{person.name || person.email}
														</span>
														{person.name && (
															<span className="block truncate text-[10px] font-light text-text-tertiary">
																{person.email}
															</span>
														)}
													</span>
												</button>
											</li>
										);
									})}
								</ul>
							)}

							{query && !isFetching && people.length === 0 && (
								<p className="text-[11px] font-light text-text-tertiary">
									No contact matches “{query}”. Sequences enrol people this
									mailbox has corresponded with.
								</p>
							)}
						</>
					)}
				</div>

				{/* Sender */}
				<div className="space-y-2">
					<label
						htmlFor="enroll-from"
						className="block text-xs font-medium text-text-secondary"
					>
						Send from
					</label>
					<select
						id="enroll-from"
						value={effectiveFrom}
						onChange={(e) => setFromAddress(e.target.value)}
						className="w-full rounded-[6px] border border-border bg-card px-2 py-1.5 text-sm text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15"
					>
						{mailboxes.map((box) => (
							<option key={box.id} value={box.email}>
								{box.email}
							</option>
						))}
					</select>
				</div>

				<div className="flex items-center justify-end gap-2 pt-1">
					<button
						type="button"
						onClick={() => {
							reset();
							onClose();
						}}
						className="rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-muted"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={submit}
						disabled={!selected || !effectiveFrom || enroll.isPending}
						className={cn(
							"inline-flex items-center gap-1.5 rounded-[6px] bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground",
							"disabled:opacity-50",
						)}
					>
						{enroll.isPending ? (
							<Loader2 size={12} className="animate-spin" aria-hidden />
						) : (
							<UserPlus size={12} aria-hidden />
						)}
						{enroll.isPending ? "Enrolling…" : "Enrol"}
					</button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
