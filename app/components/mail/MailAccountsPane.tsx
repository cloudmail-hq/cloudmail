import { Link, useNavigate } from "react-router";
import { Layers, Mail, PenSquare, Settings2 } from "lucide-react";
import { composerPreloadProps } from "~/components/lazy";
import { ModulePane } from "~/components/ModuleBar";
import { useLastMailboxStore } from "~/hooks/useLastMailboxStore";
import { useMailboxVisibilityStore } from "~/hooks/useMailboxVisibilityStore";
import { useUIStore } from "~/hooks/useUIStore";
import { useZoneStore } from "~/hooks/useZoneStore";
import { mailHref, mailTarget, totalUnread } from "~/lib/app-nav";
import { visibleMailboxes } from "~/lib/mailbox-visibility";
import { useMailboxes } from "~/queries/mailboxes";
import { useInboxUnread } from "~/queries/products";

/**
 * Mail's pane on the pages that span mailboxes (the mailbox list, All inboxes,
 * search across inboxes): every inbox at the top, the list of mailboxes, then
 * each mailbox with its unread count. Outlook's account list at the head of the
 * folder pane, in the same 208px slot as a mailbox's own folder pane.
 *
 * Its head matches `MailSidebar`'s: an account card, then Compose, at the same
 * size and position, so moving between a mailbox and these pages changes the
 * list in the pane and nothing else.
 */
export default function MailAccountsPane({ active }: { active: "all" | "manage" | "search" }) {
	const navigate = useNavigate();
	const { selectedZone } = useZoneStore();
	const { data: mailboxes = [] } = useMailboxes(selectedZone?.domain);
	const hidden = useMailboxVisibilityStore((s) => s.hiddenMailboxIds);
	const lastMailboxId = useLastMailboxStore((s) => s.lastMailboxId);
	const startCompose = useUIStore((s) => s.startCompose);
	const { data: unreadByMailbox } = useInboxUnread();
	const visible = visibleMailboxes(mailboxes, hidden);
	const target = mailTarget(lastMailboxId, mailboxes);

	const header = (
		<>
			{/* Same box as the mailbox switcher in `MailSidebar`. */}
			<div className="shrink-0 px-2.5 pt-2.5">
				<div className="flex w-full items-center gap-2 rounded-[8px] border border-border bg-card px-2.5 py-2">
					<Layers size={14} className="shrink-0 text-violet" aria-hidden />
					<span className="min-w-0 flex-1">
						<span className="block truncate text-xs font-semibold text-text-primary">All mailboxes</span>
						<span className="block truncate text-[11px] font-light text-text-tertiary">
							{visible.length} mailbox{visible.length === 1 ? "" : "es"}
						</span>
					</span>
				</div>
			</div>
			<div className="shrink-0 px-2.5 py-2.5">
				<button
					type="button"
					disabled={!target}
					onClick={() => {
						if (!target) return;
						navigate(mailHref(target));
						startCompose();
					}}
					{...composerPreloadProps}
					className="flex h-10 w-full items-center justify-center gap-2 rounded-[8px] bg-accent px-3 text-[13px] font-semibold text-accent-foreground shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-60"
				>
					<PenSquare size={14} />
					Compose
				</button>
			</div>
		</>
	);

	return (
		<ModulePane
			title="Mail"
			navLabel="Mailboxes"
			header={header}
			links={[
				{
					id: "all",
					label: "All inboxes",
					to: "/mail/all/inbox",
					icon: Layers,
					count: totalUnread(unreadByMailbox, hidden),
					active: active === "all",
				},
				...visible.map((m) => ({
					id: m.id,
					label: m.email,
					to: `/mail/${encodeURIComponent(m.id)}/inbox`,
					icon: Mail,
					count: unreadByMailbox?.[m.id.toLowerCase()] ?? 0,
				})),
			]}
			footer={
				<ModulePaneFooterLink />
			}
		/>
	);
}

/** Mailbox management at the foot, where a mailbox's own pane has its settings. */
function ModulePaneFooterLink() {
	return (
		<Link
			to="/"
			// Plain, like "Mailbox settings" in a mailbox's pane: a way out, not a place.
			className="flex h-8 w-full items-center gap-3 rounded-[6px] px-2.5 text-[13px] text-text-secondary hover:bg-bg-muted hover:text-text-primary"
		>
			<Settings2 size={15} className="shrink-0" aria-hidden />
			Manage mailboxes
		</Link>
	);
}
