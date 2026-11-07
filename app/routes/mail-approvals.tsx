// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Pending approval: sends by API tokens, connected (OAuth/MCP) apps and the
 * in-app agent that wait for the user before anything leaves.
 *
 * Each item shows who asked (the user, plus which API token or connected app)
 * and the message exactly as stored at hold time: templates rendered, the
 * agent draft already verified. Approving sends those bytes, once; only
 * tracking is added at send, and the preview says so. Editing saves first
 * (PATCH, re-verified) and the preview then shows the new stored message.
 *
 * The preview renders through `EmailIframe` with remote images off, so a held
 * message cannot phone home just by being looked at.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { AlertTriangle, Bot, Check, ChevronLeft, KeyRound, Plug, RotateCcw, ShieldCheck, X } from "lucide-react";
import EmailIframe from "~/components/EmailIframe";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/page";
import { cn } from "~/lib/utils";
import { errorMessage, showToast } from "~/lib/toast";
import { useApprovals, useApproveSend, useEditSend, useRejectSend, useRetrySend } from "~/queries/approvals";
import type { HeldMessage, SendApproval, SendApprovalEdits, SendApprovalStatus } from "~/services/api";

const KIND_LABELS: Record<SendApproval["kind"], string> = {
	send_email: "New email",
	send_reply: "Reply",
	forward_email: "Forward",
	send_template: "Template send",
	schedule_send: "Scheduled send",
	rest_send: "New email (API)",
	rest_reply: "Reply (API)",
	rest_forward: "Forward (API)",
	rest_schedule: "Scheduled send (API)",
	rest_template: "Template send (API)",
	sequence_enroll: "Sequence enrollment",
};

const STATUS_TABS: { id: SendApprovalStatus | "all"; label: string }[] = [
	{ id: "pending", label: "Waiting" },
	{ id: "sent", label: "Approved" },
	{ id: "sent_unconfirmed", label: "Not confirmed" },
	{ id: "rejected", label: "Rejected" },
	{ id: "failed", label: "Failed" },
	{ id: "all", label: "All" },
];

/** Who asked, in words: "Hermes (connected app)" or "ci-bot (API token)". */
export function requesterLabel(a: SendApproval["requested_by"]): { name: string; via: string; Icon: typeof Bot } {
	if (a.via === "agent") return { name: "In-app assistant", via: "agent", Icon: Bot };
	if (a.method === "oauth") return { name: a.oauthClientName || a.oauthClientId || "Connected app", via: "connected app", Icon: Plug };
	if (a.method === "token") return { name: a.tokenName || a.tokenId || "API token", via: a.via === "api" ? "API token, REST" : "API token", Icon: KeyRound };
	return { name: "MCP client", via: a.method ?? "MCP", Icon: Plug };
}

function parseList(value: string): string[] {
	return value
		.split(/[,\s]+/)
		.map((v) => v.trim())
		.filter(Boolean);
}

function when(iso: string | null): string {
	return iso ? new Date(iso).toLocaleString() : "";
}

function escape(text: string): string {
	return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Exactly the stored body: what approve sends, minus tracking. */
function messageHtml(m: HeldMessage): string {
	if (m.html) return m.html;
	return m.text ? `<pre style="white-space:pre-wrap;font:inherit">${escape(m.text)}</pre>` : "<p><em>(empty body)</em></p>";
}

function fromLabel(from: HeldMessage["from"]): string {
	return typeof from === "string" ? from : `${from.name} <${from.email}>`;
}

const inputClass =
	"h-11 w-full rounded-[6px] bg-card px-3 text-sm ring-1 ring-border focus:outline-none focus:ring-2 focus:ring-accent md:h-9";

interface Draft {
	to: string;
	cc: string;
	subject: string;
	html: string;
}

function draftFrom(m: HeldMessage): Draft {
	return { to: m.to.join(", "), cc: m.cc.join(", "), subject: m.subject, html: m.html ?? "" };
}

function editsFrom(m: HeldMessage, d: Draft): SendApprovalEdits | null {
	const out: SendApprovalEdits = {};
	if (d.to !== m.to.join(", ")) out.to = parseList(d.to);
	if (d.cc !== m.cc.join(", ")) out.cc = parseList(d.cc);
	if (d.subject !== m.subject) out.subject = d.subject;
	if (d.html !== (m.html ?? "")) out.html = d.html;
	return Object.keys(out).length ? out : null;
}

/** One stored message: header fields and a sandboxed preview of its exact body. */
function MessagePreview({ message, index, total }: { message: HeldMessage; index: number; total: number }) {
	return (
		<section aria-label={total > 1 ? `Message ${index + 1} of ${total}` : "Message"} className="space-y-2">
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
				<dt className="text-text-tertiary">From</dt>
				<dd className="min-w-0 break-all text-text-primary">{fromLabel(message.from)}</dd>
				<dt className="text-text-tertiary">To</dt>
				<dd className="min-w-0 break-all text-text-primary">{message.to.join(", ") || "(none)"}</dd>
				{message.cc.length ? (
					<>
						<dt className="text-text-tertiary">Cc</dt>
						<dd className="min-w-0 break-all text-text-primary">{message.cc.join(", ")}</dd>
					</>
				) : null}
				{message.bcc.length ? (
					<>
						<dt className="text-text-tertiary">Bcc</dt>
						<dd className="min-w-0 break-all text-text-primary">{message.bcc.join(", ")}</dd>
					</>
				) : null}
				{total > 1 ? (
					<>
						<dt className="text-text-tertiary">Subject</dt>
						<dd className="min-w-0 break-words text-text-primary">{message.subject || "(no subject)"}</dd>
					</>
				) : null}
				{message.send_at ? (
					<>
						<dt className="text-text-tertiary">Sends at</dt>
						<dd className="text-text-primary">{when(message.send_at)}</dd>
					</>
				) : null}
				{message.attachments.length ? (
					<>
						<dt className="text-text-tertiary">Attached</dt>
						<dd className="min-w-0 break-all text-text-primary">{message.attachments.map((a) => a.filename).join(", ")}</dd>
					</>
				) : null}
			</dl>
			<div className="overflow-hidden rounded-[6px] ring-1 ring-border">
				{/* Fixed height with its own scroll: a reviewer always sees the start of the body, and the frame does not depend on a height message arriving. */}
				<div className="h-72 md:h-80">
					<EmailIframe body={messageHtml(message)} allowRemoteImages={false} />
				</div>
			</div>
		</section>
	);
}

function EnrollmentPreview({ enrollment }: { enrollment: NonNullable<SendApproval["enrollment"]> }) {
	return (
		<section aria-label="Sequence" className="space-y-3">
			<p className="text-sm text-text-secondary">
				Enrolls <strong className="font-medium text-text-primary">{enrollment.person}</strong> in{" "}
				<strong className="font-medium text-text-primary">{enrollment.sequence_name}</strong>, sent from {enrollment.from}. Each step is
				sent on its own schedule after approval.
			</p>
			<ol className="space-y-3">
				{enrollment.steps.map((step) => (
					<li key={step.order} className="space-y-1">
						<p className="text-xs text-text-tertiary">
							Step {step.order} · {step.delayHours === 0 ? "right away" : `after ${step.delayHours} h`}
						</p>
						<p className="text-sm font-medium text-text-primary">{step.subject || "(no subject)"}</p>
						<div className="h-48 overflow-hidden rounded-[6px] ring-1 ring-border">
							<EmailIframe body={step.bodyHtml || "<p><em>(empty)</em></p>"} allowRemoteImages={false} />
						</div>
					</li>
				))}
			</ol>
		</section>
	);
}

function Detail({ mailboxId, approval, onDone }: { mailboxId: string; approval: SendApproval; onDone: () => void }) {
	const approve = useApproveSend(mailboxId);
	const edit = useEditSend(mailboxId);
	const reject = useRejectSend(mailboxId);
	const retry = useRetrySend(mailboxId);
	const first = approval.messages[0];
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<Draft | null>(null);
	useEffect(() => {
		setEditing(false);
		setDraft(null);
	}, [approval.id]);

	const who = requesterLabel(approval.requested_by);
	const pending = approval.status === "pending";
	const busy = approve.isPending || reject.isPending || retry.isPending || edit.isPending;
	const unsaved = editing && first && draft ? editsFrom(first, draft) : null;

	const onApprove = async () => {
		try {
			await approve.mutateAsync({ id: approval.id, revision: approval.revision });
			showToast({
				kind: "success",
				message:
					approval.kind === "sequence_enroll"
						? "Approved and enrolled."
						: first?.send_at
							? "Approved and scheduled."
							: "Approved and sent.",
			});
			onDone();
		} catch (e) {
			showToast({ kind: "error", message: errorMessage(e, "Could not send it.") });
		}
	};
	const onSave = async () => {
		if (!unsaved) {
			setEditing(false);
			return;
		}
		try {
			await edit.mutateAsync({ id: approval.id, edits: unsaved });
			// The preview now shows the stored, re-verified result.
			setEditing(false);
			setDraft(null);
			showToast({ kind: "success", message: "Saved. Review the preview, then approve." });
		} catch (e) {
			showToast({ kind: "error", message: errorMessage(e, "Could not save the edit.") });
		}
	};
	const onReject = async () => {
		try {
			await reject.mutateAsync({ id: approval.id });
			showToast({ kind: "success", message: "Rejected. Nothing was sent." });
			onDone();
		} catch (e) {
			showToast({ kind: "error", message: errorMessage(e, "Could not reject it.") });
		}
	};

	return (
		<article aria-labelledby="approval-subject" className="space-y-4 rounded-[8px] border border-border bg-card p-4 md:p-5">
			<header className="space-y-2">
				<div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
					<span className="rounded-[4px] bg-bg-muted px-1.5 py-0.5 font-medium text-text-primary">{KIND_LABELS[approval.kind] ?? approval.kind}</span>
					<span className="inline-flex items-center gap-1">
						<who.Icon size={12} aria-hidden />
						<span>
							Requested by <strong className="font-medium text-text-primary">{who.name}</strong> ({who.via})
							{approval.requested_by.user ? ` for ${approval.requested_by.user}` : ""}
						</span>
					</span>
					<time dateTime={approval.created_at}>{when(approval.created_at)}</time>
				</div>
				<h2 id="approval-subject" className="break-words text-base font-semibold text-text-primary">
					{approval.subject || "(no subject)"}
				</h2>
				{approval.messages.length > 1 ? (
					<p className="text-xs text-text-secondary">
						{approval.messages.length} messages, one per recipient. {approval.note ?? ""}
					</p>
				) : null}
				{approval.reason === "injection_suspected" ? (
					<p role="alert" className="flex items-start gap-2 rounded-[6px] bg-warning-bg px-3 py-2 text-xs text-warning-text">
						<AlertTriangle size={14} className="mt-px shrink-0" aria-hidden />
						Held because the agent had just read an email that looked like it contained instructions for an AI. Check the
						recipients and text carefully.
					</p>
				) : null}
				{approval.revision > 1 && approval.revised_by ? (
					<p className="text-xs text-text-secondary">
						{approval.revised_by === "requester" ? `Revised by ${who.name}` : "Edited"}
						{approval.revised_at ? ` ${when(approval.revised_at)}` : ""} · version {approval.revision}. This is the latest version.
					</p>
				) : null}
				{approval.status === "sent_unconfirmed" ? (
					<p role="alert" className="flex items-start gap-2 rounded-[6px] bg-warning-bg px-3 py-2 text-xs text-warning-text">
						<AlertTriangle size={14} className="mt-px shrink-0" aria-hidden />
						Not confirmed: the provider may have delivered this. It will not be sent again. Check Sent or the recipient's reply
						before sending anything similar.
					</p>
				) : null}
				{approval.error && approval.status !== "rejected" ? (
					<p role="alert" className="rounded-[6px] bg-destructive-subtle px-3 py-2 text-xs text-destructive">
						{approval.error}
					</p>
				) : null}
			</header>

			{editing && first && draft ? (
				<div className="space-y-3">
					<label className="block space-y-1">
						<span className="text-xs text-text-tertiary">To</span>
						<input aria-label="To" className={inputClass} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
					</label>
					<label className="block space-y-1">
						<span className="text-xs text-text-tertiary">Cc</span>
						<input aria-label="Cc" className={inputClass} value={draft.cc} onChange={(e) => setDraft({ ...draft, cc: e.target.value })} />
					</label>
					<label className="block space-y-1">
						<span className="text-xs text-text-tertiary">Subject</span>
						<input aria-label="Subject" className={inputClass} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
					</label>
					<label className="block space-y-1">
						<span className="text-xs text-text-tertiary">Body (HTML). Saving runs it through the same check an agent's body gets.</span>
						<textarea
							className="min-h-[200px] w-full rounded-[6px] bg-card p-3 font-mono text-xs ring-1 ring-border focus:outline-none focus:ring-2 focus:ring-accent"
							value={draft.html}
							onChange={(e) => setDraft({ ...draft, html: e.target.value })}
						/>
					</label>
				</div>
			) : approval.enrollment ? (
				<EnrollmentPreview enrollment={approval.enrollment} />
			) : (
				<div className="space-y-5">
					{approval.messages.map((m, i) => (
						<MessagePreview key={i} message={m} index={i} total={approval.messages.length} />
					))}
				</div>
			)}

			{approval.tracking_added_at_send && !approval.enrollment ? (
				<p className="text-xs text-text-tertiary">
					This is exactly what will be sent. Open and click tracking will be added when it is sent, if the mailbox has it on.
				</p>
			) : null}

			{pending ? (
				<div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:flex-wrap sm:items-center">
					{editing ? (
						<>
							<Button onClick={onSave} disabled={busy} className="max-sm:h-11 max-sm:w-full">
								<Check aria-hidden />
								{edit.isPending ? "Saving…" : unsaved ? "Save changes" : "Done"}
							</Button>
							<Button
								variant="outline"
								onClick={() => {
									setEditing(false);
									setDraft(null);
								}}
								disabled={busy}
								className="max-sm:h-11 max-sm:w-full"
							>
								Cancel
							</Button>
						</>
					) : (
						<>
							<Button onClick={onApprove} disabled={busy} className="max-sm:h-11 max-sm:w-full">
								<Check aria-hidden />
								{approve.isPending ? "Sending…" : approval.kind === "sequence_enroll" ? "Approve and enroll" : "Approve and send"}
							</Button>
							<Button variant="outline" onClick={onReject} disabled={busy} className="max-sm:h-11 max-sm:w-full">
								<X aria-hidden />
								Reject
							</Button>
							{approval.editable && first ? (
								<Button
									variant="outline"
									onClick={() => {
										setDraft(draftFrom(first));
										setEditing(true);
									}}
									disabled={busy}
									className="max-sm:h-11 max-sm:w-full"
								>
									Edit
								</Button>
							) : null}
						</>
					)}
					<span className="text-xs text-text-tertiary sm:ml-auto">Expires {when(approval.expires_at)}</span>
				</div>
			) : approval.status === "failed" ? (
				<div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
					<p className="w-full text-xs text-text-secondary">The provider refused it before accepting, so it was not sent.</p>
					<Button variant="outline" disabled={busy} className="max-sm:h-11" onClick={() => retry.mutate(approval.id)}>
						<RotateCcw aria-hidden />
						Put back in the queue
					</Button>
					<Button variant="ghost" disabled={busy} className="max-sm:h-11" onClick={onReject}>
						Dismiss
					</Button>
				</div>
			) : (
				<p className="border-t border-border pt-4 text-xs text-text-secondary">
					{approval.status === "sent"
						? "Approved"
						: approval.status === "rejected"
							? "Rejected"
							: approval.status === "sent_unconfirmed"
								? "Approved, delivery not confirmed"
								: "Sending"}
					{approval.decided_by ? ` by ${approval.decided_by}` : ""} {approval.decided_at ? `· ${when(approval.decided_at)}` : ""}
				</p>
			)}
		</article>
	);
}

export default function MailApprovalsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [params, setParams] = useSearchParams();
	const [status, setStatus] = useState<SendApprovalStatus | "all">("pending");
	const { data, isLoading, isError, refetch } = useApprovals(mailboxId, status);
	const approvals = useMemo(() => data?.approvals ?? [], [data]);
	const selectedId = params.get("id");
	const selected = approvals.find((a) => a.id === selectedId) ?? null;

	if (!mailboxId) return null;
	const select = (id: string | null) =>
		setParams((p) => {
			const next = new URLSearchParams(p);
			if (id) next.set("id", id);
			else next.delete("id");
			return next;
		});

	return (
		<div className="h-full overflow-y-auto bg-bg-subtle">
			<div className="mx-auto max-w-5xl space-y-4 px-4 py-5 md:px-6 md:py-6">
				<header className="space-y-1">
					<h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-text-primary">
						<ShieldCheck size={18} className="text-accent" aria-hidden />
						Pending approval
					</h1>
					<p className="text-sm text-text-secondary">
						Messages that API tokens, connected apps and the assistant asked to send from {mailboxId}. Nothing here has left yet. Change
						who needs approval in{" "}
						<Link className="text-accent underline" to={`/mail/${encodeURIComponent(mailboxId)}/settings#agent-sends`}>
							mailbox settings
						</Link>
						.
					</p>
				</header>

				<div role="tablist" aria-label="Filter approvals" className="flex flex-wrap gap-2">
					{STATUS_TABS.map((tab) => (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={status === tab.id}
							onClick={() => {
								setStatus(tab.id);
								select(null);
							}}
							className={cn(
								"h-9 shrink-0 rounded-full px-3 text-[13px] font-medium ring-1 transition-colors max-sm:h-11",
								status === tab.id
									? "bg-accent-subtle text-accent-subtle-fg ring-accent/40"
									: "bg-card text-text-secondary ring-border hover:bg-bg-muted",
							)}
						>
							{tab.label}
						</button>
					))}
				</div>

				{isLoading ? (
					<div className="space-y-2" aria-busy="true" aria-label="Loading">
						{[0, 1, 2].map((i) => (
							<div key={i} className="h-16 animate-pulse rounded-[8px] bg-card ring-1 ring-border" />
						))}
					</div>
				) : isError ? (
					<div className="space-y-2 rounded-[8px] bg-card p-4 ring-1 ring-border">
						<p className="text-sm text-destructive">Couldn't load the queue.</p>
						<Button variant="outline" size="sm" onClick={() => refetch()}>
							Try again
						</Button>
					</div>
				) : approvals.length === 0 ? (
					<EmptyState
						icon={<ShieldCheck />}
						title={status === "pending" ? "Nothing waiting" : "Nothing here"}
						description={
							status === "pending"
								? "When an API token, connected app or the assistant asks to send from this mailbox, the message waits here for you."
								: "No approvals with this status."
						}
					/>
				) : (
					<div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
						<ul className={cn("min-w-0 space-y-3", selected && "max-lg:hidden")} aria-label="Approvals">
							{approvals.map((a) => {
								const who = requesterLabel(a.requested_by);
								const active = a.id === selected?.id;
								return (
									<li key={a.id}>
										<button
											type="button"
											onClick={() => select(a.id)}
											aria-current={active ? "true" : undefined}
											className={cn(
												"w-full space-y-1 rounded-[8px] bg-card px-3 py-2.5 text-left ring-1 transition-colors",
												active ? "ring-2 ring-accent" : "ring-border hover:bg-bg-muted",
											)}
										>
											<span className="flex items-center gap-2 text-[11px] text-text-tertiary">
												<span className="font-medium text-text-secondary">{KIND_LABELS[a.kind] ?? a.kind}</span>
												<span className="truncate">· {who.name}</span>
												{a.reason === "injection_suspected" ? (
													<AlertTriangle size={12} className="ml-auto shrink-0 text-warning-text" aria-label="Flagged" />
												) : null}
											</span>
											<span className="block truncate text-sm font-medium text-text-primary">{a.subject || "(no subject)"}</span>
											<span className="block truncate text-xs text-text-secondary">to {a.recipients.join(", ")}</span>
										</button>
									</li>
								);
							})}
						</ul>
						<div className={cn("min-w-0", !selected && "max-lg:hidden")}>
							{selected ? (
								<div className="space-y-2">
									<button
										type="button"
										onClick={() => select(null)}
										className="inline-flex h-11 items-center gap-1 text-sm text-text-secondary lg:hidden"
									>
										<ChevronLeft size={16} aria-hidden />
										All approvals
									</button>
									<Detail mailboxId={mailboxId} approval={selected} onDone={() => select(null)} />
								</div>
							) : (
								<p className="rounded-[8px] bg-card px-4 py-10 text-center text-sm text-text-secondary ring-1 ring-border">
									Select a message to review it.
								</p>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
