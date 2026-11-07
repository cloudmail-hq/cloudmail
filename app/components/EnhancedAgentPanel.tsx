// Enhanced Agent Panel with SaaSMail styling
// Preserves all the agentic features from the original AgentPanel

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import SafeMarkdown from "~/components/SafeMarkdown";
import {
  Sparkles,
  Send,
  Trash2,
  User,
  Bot,
  Mail,
  Search,
  Eye,
  CornerUpLeft,
  CheckCircle,
  Wrench,
  X,
  Square,
  Edit3,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { useUIStore } from "~/hooks/useUIStore";
import {
  getDraftIdFromMessage,
  getToolNameFromPart,
  hasEditableDraft,
} from "~/lib/agent-draft";
import { showToast } from "~/lib/toast";
import { queryKeys } from "~/queries/keys";
import api, { ApiError } from "~/services/api";
import type { Email } from "~/types";
import { useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { ConfirmDialog } from "~/components/settings/settings-ui";
import {
  autoSummaryLabel,
  groupAgentLog,
  type AutoRun,
} from "../../shared/agent-log";

/** Items rendered before "Show earlier"; long logs were most of the open cost. */
const VISIBLE_ITEMS = 30;

/**
 * History prefetch, keyed by mailbox.
 *
 * `useAgentChat` suspends on a `get-messages` fetch that it only starts once
 * the agent modules have loaded and the hook has mounted, so opening the panel
 * paid for the chunk download and the history round trip one after the other.
 * The panel starts this fetch alongside the module import and hands the
 * promise to `getInitialMessages`, so the two overlap.
 */
const historyPrefetch = new Map<string, Promise<UIMessage[]>>();

function historyUrl(mailboxId: string): string {
  return `${window.location.origin}/agents/email-agent/${encodeURIComponent(mailboxId)}/get-messages`;
}

async function fetchHistory(url: string): Promise<UIMessage[]> {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) return [];
    const text = await res.text();
    return text.trim() ? (JSON.parse(text) as UIMessage[]) : [];
  } catch {
    return [];
  }
}

function prefetchHistory(mailboxId: string): Promise<UIMessage[]> {
  let p = historyPrefetch.get(mailboxId);
  if (!p) {
    p = fetchHistory(historyUrl(mailboxId));
    historyPrefetch.set(mailboxId, p);
  }
  return p;
}

const TOOL_LABELS: Record<string, { label: string; icon: React.ReactNode }> = {
  list_emails: {
    label: "Fetching emails",
    icon: <Mail size={14} />,
  },
  get_email: {
    label: "Reading email",
    icon: <Eye size={14} />,
  },
  get_thread: {
    label: "Loading thread",
    icon: <CornerUpLeft size={14} />,
  },
  search_emails: {
    label: "Searching",
    icon: <Search size={14} />,
  },
  draft_email: {
    label: "Drafting email",
    icon: <Send size={14} />,
  },
  draft_reply: {
    label: "Drafting reply",
    icon: <Send size={14} />,
  },
  discard_draft: {
    label: "Discarding draft",
    icon: <Trash2 size={14} />,
  },
  mark_email_read: {
    label: "Updating status",
    icon: <CheckCircle size={14} />,
  },
  move_email: {
    label: "Moving email",
    icon: <Mail size={14} />,
  },
};

function ToolCallBadge({
  toolName,
  state,
}: {
  toolName: string;
  state: string;
}) {
  const info = TOOL_LABELS[toolName] || {
    label: toolName,
    icon: <Wrench size={14} />,
  };
  const isDone =
    state === "output-available" ||
    state === "result" ||
    state === "output-error";

  return (
    <div className="flex items-center gap-1.5 rounded-md bg-bg-subtle px-2 py-1 text-xs">
      <span className="text-accent">{info.icon}</span>
      <span className="text-text-primary">{info.label}</span>
      {isDone ? (
        <CheckCircle size={12} className="ml-auto text-success" />
      ) : (
        <div className="ml-auto h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      )}
    </div>
  );
}

function DraftActions({
  onEdit,
  disabled,
}: {
  onEdit: () => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-2 flex gap-1.5">
      <Button
        size="sm"
        onClick={onEdit}
        disabled={disabled}
        className="gap-1.5"
      >
        <Edit3 size={14} />
        Edit & send in composer
      </Button>
    </div>
  );
}

function MessageBubble({
  message,
  onAction,
  isStreaming,
}: {
  message: UIMessage;
  onAction?: (action: string) => void;
  isStreaming: boolean;
}) {
  const isUser = message.role === "user";

  return (
    <div
      className={cn("flex gap-2", isUser ? "flex-row-reverse" : "flex-row")}
    >
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          isUser
            ? "bg-accent text-accent-foreground"
            : "bg-violet/10 text-violet"
        )}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div
        className={cn(
          "flex min-w-0 max-w-[85%] flex-col gap-1",
          isUser ? "items-end" : "items-start"
        )}
      >
        {message.parts.map((part, i) => {
          const key = `${message.id}-part-${i}`;
          if (part.type === "text" && part.text.trim()) {
            return (
              <div
                key={key}
                className={cn(
                  "overflow-hidden break-words rounded-xl px-3 py-2 text-sm leading-relaxed",
                  isUser
                    ? "rounded-br-sm bg-accent text-accent-foreground"
                    : "rounded-bl-sm border border-border bg-card text-text-primary"
                )}
              >
                {isUser ? (
                  part.text
                ) : (
                  <SafeMarkdown>{part.text}</SafeMarkdown>
                )}
              </div>
            );
          }
          const toolName = getToolNameFromPart(part);
          if (toolName) {
            return (
              <ToolCallBadge
                key={key}
                toolName={toolName}
                state={(part as any).state ?? "running"}
              />
            );
          }
          return null;
        })}
        {/* Show action buttons for draft replies */}
        {!isUser && hasEditableDraft(message) && onAction && (
          <DraftActions onEdit={() => onAction("edit")} disabled={isStreaming} />
        )}
      </div>
    </div>
  );
}

function AgentChatConnected({
  mailboxId,
  useAgent,
  useAgentChat,
  onClose,
}: {
  mailboxId: string;
  useAgent: typeof import("agents/react").useAgent;
  useAgentChat: typeof import("@cloudflare/ai-chat/react").useAgentChat;
  onClose?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [inputValue, setInputValue] = useState("");
  const { startCompose } = useUIStore();
  const queryClient = useQueryClient();

  const [confirmClear, setConfirmClear] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const agent = useAgent({ agent: "EmailAgent", name: mailboxId });
  const { messages, sendMessage, status, clearHistory, stop } = useAgentChat({
    agent,
    // Reuse the fetch the panel started alongside the module import.
    getInitialMessages: ({ url }) =>
      historyPrefetch.get(mailboxId) ?? fetchHistory(`${url}/get-messages`),
  });
  const isStreaming = status === "streaming" || status === "submitted";

  const items = useMemo(() => groupAgentLog(messages), [messages]);
  const hidden = showAll ? 0 : Math.max(0, items.length - VISIBLE_ITEMS);
  const visibleItems = hidden > 0 ? items.slice(hidden) : items;

  /*
    `clearHistory`, not `setMessages([])`: the latter only upserts what it is
    given, so the old rows survived on the server and came back on reload.
    The prefetch is dropped too, or the next open would serve the old log.
  */
  const doClear = () => {
    clearHistory();
    historyPrefetch.delete(mailboxId);
    setConfirmClear(false);
    setShowAll(false);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = () => {
    const text = inputValue.trim();
    if (!text || isStreaming) return;
    setInputValue("");
    sendMessage({ text });
    if (inputRef.current) inputRef.current.style.height = "auto";
  };

  /**
   * Open an agent-written draft in the composer.
   *
   * The draft row is fetched rather than reconstructed from the tool output.
   * The tool returns only the text it was given, so rebuilding an Email from it
   * dropped the quoted reply block, `in_reply_to` and `thread_id` — the
   * composer would then autosave a second, unthreaded draft over the top of the
   * first. Fetching gives the composer the same object the Drafts folder hands
   * it, so this path and the one in MessageView behave identically.
   */
  const handleEditDraft = async (message: UIMessage) => {
    const draftId = getDraftIdFromMessage(message);
    // The button is only rendered when there is a draft, so this is a guard
    // against a race with a still-streaming message rather than a real case.
    if (!draftId) return;

    let draft: Email;
    try {
      draft = await queryClient.fetchQuery({
        queryKey: queryKeys.emails.detail(mailboxId, draftId),
        queryFn: () => api.getEmail(mailboxId, draftId) as Promise<Email>,
      });
    } catch (error) {
      // Always logged: a draft that will not open is otherwise invisible to
      // anyone debugging it, because the toast below deliberately says nothing
      // about the cause.
      console.error(`Failed to open draft ${draftId}:`, error);

      // A 404 is the expected case — the operator deleted the draft from the
      // Drafts folder before clicking through. Anything else (a timeout, an
      // expired Access session, a 500) is not the draft's fault, and telling
      // someone it is gone would send them looking for the wrong problem.
      const isMissing = error instanceof ApiError && error.status === 404;

      showToast({
        kind: "error",
        message: isMissing
          ? "That draft is no longer available."
          : "Could not open that draft. Please try again.",
      });
      return;
    }

    // Mirrors MessageView's draft handling: a reply keeps its parent so the
    // composer can thread it, a standalone draft opens as a new message.
    if (draft.in_reply_to) {
      startCompose({ mode: "reply", draftEmail: draft });
    } else {
      startCompose({ mode: "new", draftEmail: draft });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const suggestedPrompts = [
    "Show me the latest inbox emails",
    "Any unread emails?",
    "Draft a response to the latest email",
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-bg-subtle/70 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet/10">
            <Sparkles size={16} className="text-violet" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              AI Email Agent
            </h3>
            <p className="text-xs text-text-tertiary">
              {/* Which mailbox it works in: off Mail, that is not obvious. */}
              {isStreaming ? "Thinking..." : `Working in ${mailboxId}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setConfirmClear(true)}
              title="Clear chat history"
              aria-label="Clear chat history"
              className="h-8 w-8 touch:h-11 touch:w-11"
            >
              <Trash2 size={14} aria-hidden />
            </Button>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              title="Close agent panel"
              aria-label="Close agent panel"
              className="h-8 w-8 touch:h-11 touch:w-11"
            >
              <X size={14} aria-hidden />
            </Button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="smooth-scroll flex-1 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-violet/10">
              <Bot size={32} className="text-violet" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-text-primary">
                Email Agent
              </p>
              <p className="mt-1 text-xs text-text-secondary">
                I can read emails, search conversations, and draft replies.
              </p>
            </div>
            <div className="flex w-full flex-col gap-2">
              {suggestedPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => sendMessage({ text: prompt })}
                  className="rounded-lg border border-border bg-card px-3 py-2.5 text-left text-xs text-text-primary transition-colors hover:bg-bg-subtle"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4" role="log" aria-label="Agent conversation">
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="self-center rounded-full px-3 py-1.5 text-xs font-medium text-text-secondary ring-1 ring-border hover:bg-bg-subtle hover:text-text-primary touch:min-h-11"
              >
                Show {hidden} earlier {hidden === 1 ? "item" : "items"}
              </button>
            )}
            {visibleItems.map((item) =>
              item.kind === "auto" ? (
                <AutoRunSummary
                  key={item.id}
                  runs={item.runs}
                  mailboxId={mailboxId}
                />
              ) : (
                <MessageBubble
                  key={item.message.id}
                  message={item.message}
                  isStreaming={isStreaming}
                  onAction={(action) => {
                    if (action === "edit") void handleEditDraft(item.message);
                  }}
                />
              ),
            )}
            {isStreaming && (
              <div className="flex gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet/10">
                  <Bot size={14} className="text-violet" />
                </div>
                <div className="flex items-center gap-2 rounded-xl rounded-bl-sm border border-border bg-card px-3 py-2">
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-violet border-t-transparent" />
                  <span className="text-xs text-text-secondary">
                    Thinking...
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border bg-bg-subtle/70 px-4 py-3">
        {isStreaming ? (
          <div className="flex justify-center">
            <Button variant="secondary" size="sm" onClick={() => stop()}>
              <Square size={14} className="mr-1.5" aria-hidden />
              Stop generating
            </Button>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <label htmlFor={`agent-input-${mailboxId}`} className="sr-only">
              Message the email agent
            </label>
            <Textarea
              id={`agent-input-${mailboxId}`}
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask your email agent..."
              rows={1}
              className="min-h-[40px] max-h-[100px] flex-1 resize-none text-sm"
              style={{ height: "auto", overflow: "hidden" }}
              onInput={(e) => {
                const t = e.target as HTMLTextAreaElement;
                t.style.height = "auto";
                t.style.height = `${Math.min(t.scrollHeight, 100)}px`;
                t.style.overflow = t.scrollHeight > 100 ? "auto" : "hidden";
              }}
            />
            <Button
              size="icon"
              disabled={!inputValue.trim()}
              onClick={handleSend}
              aria-label="Send message"
              title="Send message"
              className="h-10 w-10 touch:h-11 touch:w-11"
            >
              <Send size={16} aria-hidden />
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear chat history?"
        description="Removes this mailbox's conversation with the agent. Drafts it already wrote stay in Drafts."
        confirmLabel="Clear history"
        onConfirm={doClear}
      />
    </div>
  );
}

/**
 * One quiet row for a run of auto-triggered emails, in place of a user bubble
 * and an agent reply per email. Expands to the per-email outcomes.
 */
function AutoRunSummary({
  runs,
  mailboxId,
}: {
  runs: AutoRun<UIMessage>[];
  mailboxId: string;
}) {
  const [open, setOpen] = useState(false);
  const label = autoSummaryLabel(runs);
  const drafted = runs.some((r) => r.outcome === "drafted");
  const listId = `auto-${runs[0]?.trigger.id ?? "run"}`;
  return (
    <div className="rounded-lg bg-bg-subtle/60 px-3 py-2 text-xs text-text-secondary ring-1 ring-border/60">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={listId}
          className="-ml-1 inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50 touch:min-h-11"
        >
          {open ? (
            <ChevronDown size={13} aria-hidden />
          ) : (
            <ChevronRight size={13} aria-hidden />
          )}
          <Sparkles size={12} className="text-violet" aria-hidden />
          <span className="font-medium">{label}</span>
        </button>
        {drafted && (
          <Link
            to={`/mail/${encodeURIComponent(mailboxId)}/draft`}
            className="ml-auto font-medium text-accent hover:underline touch:inline-flex touch:min-h-11 touch:items-center"
          >
            Open Drafts
          </Link>
        )}
      </div>
      {open && (
        <ul id={listId} className="mt-1.5 space-y-1 border-t border-border/60 pt-1.5">
          {runs.map((run) => (
            <li key={run.trigger.id} className="flex gap-2">
              <span
                className={cn(
                  "shrink-0 font-medium",
                  run.outcome === "drafted" && "text-success",
                  run.outcome === "blocked" && "text-warning-text",
                )}
              >
                {run.outcome === "drafted"
                  ? "Drafted"
                  : run.outcome === "blocked"
                    ? "Blocked"
                    : "No draft"}
              </span>
              <span className="min-w-0 truncate">
                {run.subject ? `"${run.subject}"` : "New email"}
                {run.sender ? ` from ${run.sender}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** History-shaped placeholder while `useAgentChat` waits on `get-messages`. */
function AgentPanelSkeleton({ onClose }: { onClose?: () => void }) {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading agent conversation">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-bg-subtle/70 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet/10">
            <Sparkles size={16} className="text-violet" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">AI Email Agent</h3>
            <p className="text-xs text-text-tertiary">Loading…</p>
          </div>
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            title="Close agent panel"
            aria-label="Close agent panel"
            className="h-8 w-8 touch:h-11 touch:w-11"
          >
            <X size={14} aria-hidden />
          </Button>
        )}
      </div>
      <div className="flex-1 space-y-4 overflow-hidden px-4 py-4">
        {[60, 80, 45, 70].map((w, i) => (
          <div key={i} className={cn("flex gap-2", i % 2 === 1 && "flex-row-reverse")}>
            <span className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-bg-muted" />
            <span
              className="h-10 animate-pulse rounded-xl bg-bg-muted"
              style={{ width: `${w}%` }}
            />
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t border-border bg-bg-subtle/70 px-4 py-3">
        <div className="h-10 animate-pulse rounded-md bg-bg-muted" />
      </div>
    </div>
  );
}

interface EnhancedAgentPanelProps {
  onClose?: () => void;
  /**
   * The mailbox the agent works in. The app shell passes the open mailbox, or
   * on pages outside one, the last mailbox opened (else the first readable),
   * so the panel works on every page. Defaults to the route's `:mailboxId`.
   */
  mailboxId?: string;
}

export default function EnhancedAgentPanel({ onClose, mailboxId: mailboxProp }: EnhancedAgentPanelProps) {
  const params = useParams<{ mailboxId: string }>();
  const mailboxId = mailboxProp ?? params.mailboxId;
  const [hooks, setHooks] = useState<{
    useAgent: typeof import("agents/react").useAgent;
    useAgentChat: typeof import("@cloudflare/ai-chat/react").useAgentChat;
  } | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    // Overlaps the history round trip with the chunk download.
    if (mailboxId) void prefetchHistory(mailboxId);
    Promise.all([
      import("agents/react"),
      import("@cloudflare/ai-chat/react"),
    ])
      .then(([a, c]) =>
        setHooks({
          useAgent: a.useAgent,
          useAgentChat: c.useAgentChat,
        })
      )
      .catch((err) => {
        console.error("Failed to load agent modules:", err);
        setLoadError("Failed to connect to agent. Reload to retry.");
      });
  }, [mailboxId]);

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10">
          <X size={24} className="text-destructive" />
        </div>
        <span className="text-sm text-destructive">{loadError}</span>
      </div>
    );
  }

  if (!hooks) return <AgentPanelSkeleton onClose={onClose} />;

  return (
    // `useAgentChat` suspends until the history arrives.
    <Suspense fallback={<AgentPanelSkeleton onClose={onClose} />}>
      <AgentChatConnected
        mailboxId={mailboxId ?? "default"}
        useAgent={hooks.useAgent}
        useAgentChat={hooks.useAgentChat}
        onClose={onClose}
      />
    </Suspense>
  );
}
