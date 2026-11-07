// Person timeline: every message exchanged with one correspondent, across all
// mailboxes. Expanding a message loads its full conversation through the
// existing per-mailbox thread endpoint.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Loader2,
  Paperclip,
  ChevronDown,
  ChevronRight,
  Inbox,
  Send,
  AlertCircle,
} from "lucide-react";
import EmailIframe from "~/components/EmailIframe";
import QuotedText from "~/components/mail/QuotedText";
import { useRemoteImageStore } from "~/hooks/useRemoteImageStore";
import { prepareEmailHtml } from "~/lib/email-html";
import { allowsRemoteImages } from "~/lib/remote-images";
import { usePersonEmails } from "~/queries/people";
import { queryKeys } from "~/queries/keys";
import api, { type PersonEmail } from "~/services/api";
import type { Email } from "~/types";
import type { GroupedPerson } from "../../shared/people";
import { splitQuotedBody } from "../../shared/quoted-text";
import { Folders, getFolderDisplayName } from "../../shared/folders";
import { cn, initials, avatarColor, getSnippetText } from "~/lib/utils";
import { formatDetailDate } from "../../shared/dates";
import { redactSecrets } from "../../shared/redact-secrets";

interface PersonDetailProps {
  person: GroupedPerson;
  onBack: () => void;
}

/**
 * One message inside an expanded conversation. Only the text the sender
 * wrote is shown; the quote chain they appended is already visible as the
 * earlier messages in this same list.
 */
function ThreadBubble({
  message,
  mailboxId,
}: {
  message: Email;
  mailboxId: string;
}) {
  // Saved trust rules are honoured here too. The timeline has no banner of its
  // own, so a reader who has already said "always show images from this sender"
  // in the reading pane would otherwise see the same messages stripped here,
  // with nothing on screen explaining why or offering to fix it.
  const trustedSenders = useRemoteImageStore((s) => s.trustedSenders);
  const allowRemoteImages = allowsRemoteImages(trustedSenders, message.sender);

  // Split before sanitising, then prepare each half: `prepareEmailHtml`
  // resolves `cid:` references to inline attachments and re-balances any tag
  // the cut left open.
  const { body, quotedHtml, hasQuote } = useMemo(() => {
    const split = splitQuotedBody(message.body);
    const options = {
      mailboxId,
      emailId: message.id,
      attachments: message.attachments,
      allowRemoteImages,
      imageProxy: message.image_proxy,
    };
    const prepared = prepareEmailHtml(split.visible, options);
    const quote = split.hasQuote
      ? prepareEmailHtml(split.quoted, options)
      : null;
    return {
      body: prepared.html,
      quotedHtml: quote?.html ?? "",
      hasQuote: split.hasQuote && !!quote?.html.trim(),
    };
  }, [
    message.body,
    message.attachments,
    message.id,
    mailboxId,
    allowRemoteImages,
    message.image_proxy,
  ]);

  return (
    <li className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium text-text-primary">{message.sender}</span>
        <span className="font-light text-text-tertiary">
          {message.date ? formatDetailDate(message.date) : ""}
        </span>
      </div>
      <div className="overflow-hidden rounded-[6px] border border-border bg-card">
        <EmailIframe body={body} autoSize allowRemoteImages={allowRemoteImages} />
      </div>
      {hasQuote && (
        <QuotedText
          quotedBody={quotedHtml}
          senderLabel={message.sender}
          allowRemoteImages={allowRemoteImages}
        />
      )}
    </li>
  );
}

/**
 * One message row. Collapsed it shows a snippet; expanded it loads the whole
 * thread so replies read in context rather than as isolated messages.
 */
function TimelineMessage({
  email,
  personEmail,
}: {
  email: PersonEmail;
  personEmail: string;
}) {
  const [expanded, setExpanded] = useState(false);

  // Outbound mail is anything we sent: the person is the recipient, not the
  // sender. Drives the "You"/person labelling and the direction icon.
  const outbound = email.sender.trim().toLowerCase() !== personEmail;

  const {
    data: thread,
    isLoading: threadLoading,
    error: threadError,
  } = useQuery({
    queryKey: queryKeys.emails.thread(email.mailboxId, email.thread_id ?? email.id),
    queryFn: ({ signal }) =>
      api.getThread(email.mailboxId, email.thread_id!, { signal }),
    // Only fetch once opened, and only when there is a thread to fetch.
    enabled: expanded && !!email.thread_id,
  });

  const folderLabel = email.folder_id
    ? getFolderDisplayName(email.folder_id)
    : null;

  return (
    <li
      className={cn(
        "rounded-[8px] border border-border bg-card transition-colors",
        !email.read && !outbound && "border-l-2 border-l-violet"
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-bg-muted/50"
      >
        <span className="mt-0.5 shrink-0 text-text-tertiary">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>

        <span className="mt-0.5 shrink-0 text-text-tertiary" aria-hidden>
          {outbound ? <Send size={13} /> : <Inbox size={13} />}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span
              className={cn(
                "truncate text-sm text-text-primary",
                email.read || outbound ? "font-medium" : "font-bold"
              )}
            >
              {email.subject?.trim() || "(no subject)"}
            </span>
            {folderLabel && folderLabel.toLowerCase() !== Folders.INBOX && (
              <span className="rounded-full bg-bg-muted px-1.5 py-0.5 text-xs font-medium text-text-secondary">
                {folderLabel}
              </span>
            )}
          </span>

          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs font-light text-text-tertiary">
            <span>{outbound ? "You" : personEmail}</span>
            <span aria-hidden>·</span>
            <span>{email.mailboxId}</span>
            {email.date && (
              <>
                <span aria-hidden>·</span>
                <span>{formatDetailDate(email.date)}</span>
              </>
            )}
            {email.attachmentCount > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <Paperclip size={10} />
                {email.attachmentCount}
              </span>
            )}
          </span>

          {!expanded && email.snippet && (
            <span className="mt-1 block truncate text-xs font-light text-text-secondary">
              {redactSecrets(getSnippetText(email.snippet, 160))}
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-3">
          {!email.thread_id ? (
            <p className="text-xs text-text-tertiary">
              This message has no conversation history.
            </p>
          ) : threadLoading ? (
            <div className="flex items-center gap-2 py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-text-tertiary" />
              <span className="text-xs text-text-tertiary">
                Loading conversation…
              </span>
            </div>
          ) : threadError ? (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertCircle size={12} />
              Could not load this conversation.
            </p>
          ) : (
            <ol className="space-y-3">
              {(thread ?? []).map((message) => (
                <ThreadBubble
                  key={message.id}
                  message={message}
                  mailboxId={email.mailboxId}
                />
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}

export default function PersonDetail({ person, onBack }: PersonDetailProps) {
  const { data, isLoading, error } = usePersonEmails(person.email);
  const emails = data?.emails ?? [];
  const personEmail = person.email.trim().toLowerCase();

  return (
    <div className="flex h-full flex-col">
      {/* Person header */}
      <div className="shrink-0 border-b border-border bg-card px-4 pb-2.5 pt-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary md:hidden"
          >
            <ArrowLeft size={13} />
            Back
          </button>

          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            style={{
              backgroundColor: avatarColor(person.email).bg,
              color: avatarColor(person.email).fg,
            }}
            aria-hidden
          >
            {initials(person.name, person.email)}
          </span>

          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 className="truncate text-lg font-semibold tracking-tight text-text-primary">
              {person.name || person.email}
            </h2>
            {person.name && (
              <span className="truncate text-xs font-light text-text-tertiary">
                {person.email}
              </span>
            )}
            <span className="text-[11px] text-text-tertiary">
              · {person.totalCount} message
              {person.totalCount !== 1 ? "s" : ""}
              {person.unreadCount > 0 && ` · ${person.unreadCount} unread`}
            </span>
          </div>
        </div>
      </div>

      {/* Timeline */}
      <div className="smooth-scroll flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16">
            <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
            <span className="text-sm text-text-tertiary">Loading messages…</span>
          </div>
        ) : error ? (
          <div className="rounded-[8px] border border-destructive/50 bg-destructive/10 px-4 py-3">
            <p className="text-sm text-destructive">
              {error instanceof Error
                ? error.message
                : "Could not load this person's messages."}
            </p>
          </div>
        ) : emails.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <span className="text-3xl" style={{ color: "#7c5cfc" }} aria-hidden>
              ✦
            </span>
            <p className="max-w-[280px] text-sm font-light text-text-tertiary">
              No messages found for{" "}
              <span className="font-medium">{person.email}</span>.
            </p>
          </div>
        ) : (
          <ol className="space-y-2">
            {emails.map((email) => (
              <TimelineMessage
                key={`${email.mailboxId}:${email.id}`}
                email={email}
                personEmail={personEmail}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
