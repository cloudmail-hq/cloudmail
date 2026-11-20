// Per-inbox control for automatic draft replies.
//
// Auto-draft has always been a per-mailbox setting on the backend: the inbound
// handler reads `autoDraft.enabled` from each mailbox's own settings object
// before triggering the agent. This surfaces that faithfully — one switch per
// inbox — rather than implying a single global switch.

import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  AlertCircle,
  Check,
  Loader2,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Switch } from "~/components/ui/switch";
import { Badge } from "~/components/ui/badge";
import { useMailboxesWithSettings, useSetAutoDraft } from "~/queries/mailboxes";
import { initials, avatarColor } from "~/lib/utils";
import { isAutoDraftEnabled } from "../../shared/auto-draft";
import type { Mailbox } from "~/types";

/** Same opt-out rule the inbound email handler applies. */
function isAutoDraftOn(mailbox: Mailbox): boolean {
  return isAutoDraftEnabled(mailbox.settings);
}

function InboxRow({ mailbox }: { mailbox: Mailbox }) {
  const setAutoDraft = useSetAutoDraft();
  const [failed, setFailed] = useState(false);

  const enabled = isAutoDraftOn(mailbox);
  const label = mailbox.settings?.fromName?.trim() || mailbox.name || mailbox.email;
  const color = avatarColor(mailbox.email);
  // `<label htmlFor>` does not associate with a `role="switch"` button, so the
  // name is referenced by id via aria-labelledby instead.
  const labelId = `auto-draft-label-${mailbox.id}`;

  function apply(next: boolean) {
    setFailed(false);
    setAutoDraft.mutate(
      { mailbox, enabled: next },
      { onError: () => setFailed(true) }
    );
  }

  return (
    <div className="flex items-center gap-3 px-5 py-3.5">
      <span
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
        style={{ backgroundColor: color.bg, color: color.fg }}
      >
        {initials(label === mailbox.email ? null : label, mailbox.email)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span
            id={labelId}
            className="truncate text-sm font-medium text-text-primary"
          >
            {label}
          </span>
          {label !== mailbox.email && (
            <span className="truncate text-sm text-text-tertiary">
              {mailbox.email}
            </span>
          )}
        </div>

        <p className="mt-0.5 text-sm text-text-tertiary">
          {failed ? (
            <span className="inline-flex items-center gap-1 text-destructive">
              <AlertCircle size={11} />
              Couldn&apos;t save — the inbox is unchanged.
              <button
                type="button"
                onClick={() => apply(!enabled)}
                className="inline-flex items-center gap-1 font-medium underline hover:no-underline"
              >
                <RotateCcw size={10} />
                Retry
              </button>
            </span>
          ) : setAutoDraft.isPending ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 size={11} className="animate-spin" />
              Saving…
            </span>
          ) : enabled ? (
            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-500">
              <Check size={11} />
              Drafting replies to new mail
            </span>
          ) : (
            "Not drafting — new mail is stored only"
          )}
        </p>
      </div>

      <Link
        to={`/mailbox/${encodeURIComponent(mailbox.id)}/settings`}
        className="hidden shrink-0 items-center gap-1 rounded-[6px] px-2 py-1 text-xs font-medium text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary sm:inline-flex"
        title="Edit this inbox's agent prompt and other settings"
      >
        <Settings2 size={12} />
        Configure
      </Link>

      <Switch
        checked={enabled}
        busy={setAutoDraft.isPending}
        onCheckedChange={apply}
        aria-labelledby={labelId}
      />
    </div>
  );
}

export default function AutoDraftSettings() {
  const { data: mailboxes = [], isLoading, error } = useMailboxesWithSettings();
  const setAutoDraft = useSetAutoDraft();

  const enabledCount = useMemo(
    () => mailboxes.filter(isAutoDraftOn).length,
    [mailboxes]
  );

  /** Group by domain, but only surface the grouping when there is more than one. */
  const groups = useMemo(() => {
    const byDomain = new Map<string, Mailbox[]>();
    for (const m of mailboxes) {
      const domain = m.domain || m.email.split("@")[1] || "";
      const list = byDomain.get(domain) ?? [];
      list.push(m);
      byDomain.set(domain, list);
    }
    for (const list of byDomain.values()) {
      list.sort((a, b) => a.email.localeCompare(b.email));
    }
    return [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [mailboxes]);

  function applyAll(enabled: boolean) {
    for (const mailbox of mailboxes) {
      if (isAutoDraftOn(mailbox) === enabled) continue;
      setAutoDraft.mutate({ mailbox, enabled });
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={14} style={{ color: "#7c5cfc" }} />
        <h2 className="text-base font-semibold text-text-primary">
          Automatic draft replies
        </h2>
        {!isLoading && !error && mailboxes.length > 0 && (
          <Badge variant={enabledCount > 0 ? "success" : "secondary"}>
            On for {enabledCount} of {mailboxes.length}{" "}
            {mailboxes.length === 1 ? "inbox" : "inboxes"}
          </Badge>
        )}
      </div>

      <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
        {/* Explanation */}
        <div className="border-b border-border px-5 py-4">
          <p className="text-xs font-light leading-relaxed text-text-secondary">
            When mail arrives, the agent reads the thread and leaves a reply
            waiting in that inbox&apos;s Drafts folder.{" "}
            <span className="font-medium text-text-primary">
              Nothing is ever sent automatically
            </span>{" "}
            — you review and send every draft yourself.
          </p>
          <p className="mt-2 flex items-start gap-1.5 text-sm text-text-tertiary">
            <ShieldCheck size={12} className="mt-0.5 shrink-0" />
            <span>
              Incoming mail is always screened for prompt injection first, and
              drafting is skipped when anything suspicious is found. That check
              cannot be turned off.
            </span>
          </p>
          <p className="mt-2 text-sm text-text-tertiary">
            This is set per inbox, so you can let the agent draft for support
            while leaving another address untouched.
          </p>
        </div>

        {/* Bulk actions */}
        {!isLoading && !error && mailboxes.length > 1 && (
          <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle/40 px-5 py-2">
            <span className="text-xs font-medium text-text-secondary">
              {mailboxes.length} inboxes
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => applyAll(true)}
                disabled={enabledCount === mailboxes.length}
                className="rounded-[6px] px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Enable all
              </button>
              <button
                type="button"
                onClick={() => applyAll(false)}
                disabled={enabledCount === 0}
                className="rounded-[6px] px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Disable all
              </button>
            </div>
          </div>
        )}

        {/* Rows */}
        {isLoading ? (
          <ul className="divide-y divide-border/60">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-3 px-5 py-3.5">
                <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-bg-muted" />
                <span className="flex-1 space-y-1.5">
                  <span className="block h-3 w-40 animate-pulse rounded bg-bg-muted" />
                  <span className="block h-2.5 w-56 animate-pulse rounded bg-bg-muted" />
                </span>
                <span className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-bg-muted" />
              </li>
            ))}
          </ul>
        ) : error ? (
          <div className="px-5 py-4">
            <p className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertCircle size={13} />
              {error instanceof Error
                ? error.message
                : "Could not load your inboxes."}
            </p>
          </div>
        ) : mailboxes.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-medium text-text-primary">No inboxes yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-text-tertiary">
              Once Email Routing delivers mail to an address, its inbox appears
              here with its own auto-draft switch.
            </p>
          </div>
        ) : (
          groups.map(([domain, list]) => (
            <div key={domain}>
              {groups.length > 1 && (
                <div className="bg-bg-subtle/40 px-5 py-1.5">
                  <h3 className="text-xs font-medium text-text-secondary">
                    {domain}
                  </h3>
                </div>
              )}
              <div className="divide-y divide-border/60">
                {list.map((mailbox) => (
                  <InboxRow key={mailbox.id} mailbox={mailbox} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
