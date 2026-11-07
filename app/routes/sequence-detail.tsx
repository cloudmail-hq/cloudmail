// Sequence Detail Page - View sequence steps and enrollments

import { useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "react-router";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  ListOrdered,
  Loader2,
  Pencil,
  UserPlus,
  Users,
  XCircle,
} from "lucide-react";
import DashboardLayout from "~/components/DashboardLayout";
import EnrollContactDialog from "~/components/EnrollContactDialog";
import {
  useCancelEnrollment,
  useSequence,
  useSequenceEnrollments,
} from "~/queries/sequences";
import { cn } from "~/lib/utils";
import { errorMessage, showToast } from "~/lib/toast";
import type { EnrollmentWithDetails } from "~/services/api";
import { PageContainer } from "~/components/ui/page";

// Types come from the API client rather than being redeclared here: the local
// copies had drifted (`status` was a bare string, so an unknown value type-checked
// against the status badge's union).

/** Round delay-hours into a friendlier string for the step timeline. */
function formatDelay(hours: number): string {
  if (hours <= 0) return "immediately";
  if (hours < 24) return `${hours}h`;
  const days = Math.round((hours / 24) * 10) / 10;
  return days === 1 ? "1 day" : `${days} days`;
}

function totalDelayLabel(steps: { delayHours: number }[]): string {
  const total = steps.reduce((acc, s) => acc + (s.delayHours || 0), 0);
  return formatDelay(total);
}

function relativeTime(ts: number): string {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  const days = Math.floor(diff / 86400);
  if (days < 30) return `${days}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

type Status = "active" | "completed" | "cancelled";

const STATUS_META: Record<
  Status,
  { label: string; chipClass: string; color: string; Icon: React.ElementType }
> = {
  active: {
    label: "Active",
    chipClass: "bg-emerald-50 ring-emerald-200/60 dark:bg-emerald-500/10",
    color: "#047857",
    Icon: Clock,
  },
  completed: {
    label: "Completed",
    chipClass: "bg-violet/10 ring-violet/20",
    color: "#7c5cfc",
    Icon: CheckCircle2,
  },
  cancelled: {
    label: "Cancelled",
    chipClass: "bg-bg-muted ring-border",
    color: "#6b7280",
    Icon: XCircle,
  },
};

function StatusBadge({ status }: { status: string }) {
  const key: Status =
    status === "active" || status === "completed" || status === "cancelled"
      ? status
      : "cancelled";
  const meta = STATUS_META[key];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
        meta.chipClass,
      )}
      style={{ color: meta.color }}
    >
      <meta.Icon size={10} />
      {meta.label}
    </span>
  );
}

export default function SequenceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [enrolling, setEnrolling] = useState(false);

  // Through the query cache rather than useState + useEffect, so enrolling a
  // contact refreshes this list instead of leaving it stale until a reload.
  const {
    data: sequence,
    isLoading: sequenceLoading,
    error: sequenceError,
  } = useSequence(id);
  const { data: enrollments = [], isLoading: enrollmentsLoading } =
    useSequenceEnrollments(id);
  const cancelEnrollment = useCancelEnrollment();

  const loading = sequenceLoading || enrollmentsLoading;
  const error = sequenceError ? errorMessage(sequenceError, "Failed to load") : null;

  async function handleCancel(enrollmentId: string) {
    if (!id) return;
    if (!confirm("Cancel this enrollment? Pending steps won't be sent.")) {
      return;
    }

    try {
      await cancelEnrollment.mutateAsync({ enrollmentId, sequenceId: id });
      showToast({ kind: "success", message: "Enrollment cancelled" });
    } catch (e) {
      showToast({
        kind: "error",
        message: errorMessage(e, "Failed to cancel that enrollment."),
      });
    }
  }

  // Bucket enrollments by status
  const grouped = useMemo(() => {
    const buckets: Record<string, EnrollmentWithDetails[]> = {
      active: [],
      completed: [],
      cancelled: [],
    };
    for (const e of enrollments) {
      const k = (buckets[e.status] ? e.status : "cancelled") as string;
      buckets[k].push(e);
    }
    return buckets;
  }, [enrollments]);


  if (loading) {
    return (
      <DashboardLayout>
        <PageContainer>
          <div className="flex items-center gap-2 pt-10">
            <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
            <span className="text-sm text-text-tertiary">Loading…</span>
          </div>
        </PageContainer>
      </DashboardLayout>
    );
  }

  if (error || !sequence) {
    return (
      <DashboardLayout>
        <PageContainer>
          <Link
            to="/sequences"
            className="-mt-1 mb-3 inline-flex items-center gap-1 text-xs font-medium text-text-tertiary transition-colors hover:text-text-primary"
          >
            <ArrowLeft size={12} />
            Sequences
          </Link>
          <div className="rounded-[8px] border border-destructive/50 bg-destructive/10 px-4 py-3">
            <p className="text-sm text-destructive">{error || "Sequence not found"}</p>
          </div>
        </PageContainer>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <PageContainer>
        {/* Back link */}
        <Link
          to="/sequences"
          className="-mt-1 mb-3 inline-flex items-center gap-1 text-xs font-medium text-text-tertiary transition-colors hover:text-text-primary"
        >
          <ArrowLeft size={12} />
          Sequences
        </Link>

        {/* Header */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
              {sequence.name}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {sequence.steps.length} step
              {sequence.steps.length === 1 ? "" : "s"} · spans{" "}
              {totalDelayLabel(sequence.steps)} · {enrollments.length} enrollment
              {enrollments.length === 1 ? "" : "s"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/sequences/${sequence.id}/edit`)}
            className="inline-flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
          >
            <Pencil size={12} />
            Edit sequence
          </button>
        </div>

        <div className="max-w-4xl space-y-5">
          {/* Steps timeline */}
          <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
            <div className="border-b border-border px-5 py-4">
              <div className="flex items-start gap-2">
                <ListOrdered size={14} className="mt-0.5 text-text-tertiary" />
                <div>
                  <h2 className="text-sm font-semibold text-text-primary">Steps</h2>
                  <p className="text-xs font-light text-text-secondary">
                    The journey every enrollment follows. Delays are measured from the previous step.
                  </p>
                </div>
              </div>
            </div>

            <ol className="relative space-y-0">
              {sequence.steps.map((step, idx) => {
                const isLast = idx === sequence.steps.length - 1;
                return (
                  <li
                    key={step.order}
                    className="relative flex items-start gap-3 px-5 py-4"
                  >
                    {!isLast && (
                      <span
                        aria-hidden
                        className="absolute left-[34px] top-12 h-[calc(100%-2.5rem)] w-px bg-border"
                      />
                    )}
                    <span className="relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet/10 text-[11px] font-semibold tabular-nums">
                      <span style={{ color: "#7c5cfc" }}>{idx + 1}</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">
                        <code className="font-mono">{step.templateSlug}</code>
                      </p>
                      <p className="mt-0.5 text-xs font-light text-text-tertiary">
                        {idx === 0
                          ? "Sends right when someone is enrolled."
                          : `Sends ${formatDelay(step.delayHours)} after step ${idx}.`}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          {/* Enrollments */}
          <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
            <div className="border-b border-border px-5 py-4">
              <div className="flex items-start gap-2">
                <Users size={14} className="mt-0.5 text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-semibold text-text-primary">
                    Enrollments ({enrollments.length})
                  </h2>
                  <p className="text-xs font-light text-text-secondary">
                    Every contact who has been enrolled into this sequence.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEnrolling(true)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-[6px] bg-accent px-2.5 py-1.5 text-xs font-semibold text-accent-foreground hover:bg-accent-hover"
                >
                  <UserPlus size={12} aria-hidden />
                  Enrol contact
                </button>
              </div>
            </div>

            {enrollments.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-violet/10">
                  <Users size={16} style={{ color: "#7c5cfc" }} />
                </span>
                <p className="text-sm font-medium text-text-primary">
                  No enrollments yet
                </p>
                <p className="mt-1 text-xs font-light text-text-tertiary">
                  Enrol a contact to schedule this sequence for them.
                </p>
                <button
                  type="button"
                  onClick={() => setEnrolling(true)}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-[6px] bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground hover:bg-accent-hover"
                >
                  <UserPlus size={12} aria-hidden />
                  Enrol contact
                </button>
              </div>
            ) : (
              <div className="divide-y divide-border/60">
                {(["active", "completed", "cancelled"] as Status[]).map((statusKey) => {
                  const rows = grouped[statusKey] ?? [];
                  if (rows.length === 0) return null;
                  return (
                    <EnrollmentGroup
                      key={statusKey}
                      status={statusKey}
                      rows={rows}
                      onCancel={handleCancel}
                    />
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </PageContainer>

      {id && sequence && (
        <EnrollContactDialog
          sequenceId={id}
          sequenceName={sequence.name}
          stepCount={sequence.steps.length}
          open={enrolling}
          onClose={() => setEnrolling(false)}
        />
      )}
    </DashboardLayout>
  );
}

function EnrollmentGroup({
  status,
  rows,
  onCancel,
}: {
  status: Status;
  rows: EnrollmentWithDetails[];
  onCancel: (id: string) => void;
}) {
  const meta = STATUS_META[status];
  return (
    <div>
      <div className="flex items-center gap-2 bg-bg-subtle/40 px-5 py-2">
        <meta.Icon size={11} style={{ color: meta.color }} />
        <h3 className="text-xs font-medium text-text-secondary">
          {meta.label} · {rows.length}
        </h3>
      </div>
      <ul className="divide-y divide-border/60">
        {rows.map((enr) => {
          const progress =
            enr.totalSteps > 0 ? enr.sentSteps / enr.totalSteps : 0;
          const initial = (enr.personName ?? enr.personEmail)
            .trim()
            .charAt(0)
            .toUpperCase();
          return (
            <li
              key={enr.id}
              data-testid="enrollment-row"
              className="flex items-center gap-3 px-5 py-3"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted text-xs font-semibold text-text-secondary">
                {initial || "?"}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-text-primary">
                    {enr.personName ?? enr.personEmail}
                  </p>
                  <StatusBadge status={enr.status} />
                </div>
                <p className="truncate text-xs font-light text-text-tertiary">
                  {enr.personEmail} · enrolled {relativeTime(enr.enrolledAt)}
                </p>
              </div>

              <div className="hidden shrink-0 items-center gap-3 sm:flex">
                <div className="w-32">
                  <div className="flex items-center justify-between text-[11px] tabular-nums">
                    <span className="text-text-tertiary">
                      {enr.sentSteps}/{enr.totalSteps}
                    </span>
                    <span className="text-text-tertiary">
                      {Math.round(progress * 100)}%
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg-muted">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.max(progress * 100, 2)}%`,
                        backgroundColor: STATUS_META[status].color,
                      }}
                    />
                  </div>
                </div>
              </div>

              {enr.status === "active" && (
                <button
                  type="button"
                  onClick={() => onCancel(enr.id)}
                  aria-label="Cancel"
                  className="shrink-0 rounded-[6px] border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  Cancel
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
