// Sequences Page - Multi-step drip campaigns

import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router";
import { Plus, ListOrdered, Pencil, Trash2, Clock } from "lucide-react";
import DashboardLayout from "~/components/DashboardLayout";
import api from "~/services/api";
import { EmptyState, PageContainer, PageHeader } from "~/components/ui/page";

// Types
interface SequenceStep {
  order: number;
  templateSlug: string;
  delayHours: number;
}

interface Sequence {
  id: string;
  name: string;
  steps: SequenceStep[];
  createdAt: number;
  updatedAt: number;
}

/** Round delay-hours into a friendlier string for the row chip. */
function formatTotalDelay(hours: number): string {
  if (hours <= 0) return "instant";
  if (hours < 24) return `${hours}h`;
  const days = Math.round((hours / 24) * 10) / 10;
  return days === 1 ? "1 day" : `${days} days`;
}

function totalDurationHours(seq: Sequence): number {
  return seq.steps.reduce((acc, s) => acc + (s.delayHours || 0), 0);
}

export default function SequencesPage() {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetchSequences();
  }, []);

  async function fetchSequences() {
    try {
      setLoading(true);
      setSequences(await api.listSequences());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this sequence? All active enrollments will be cancelled.")) return;
    
    try {
      await api.deleteSequence(id);
      setSequences((prev) => prev.filter((s) => s.id !== id));
    } catch (e) {
      alert("Failed to delete sequence: " + (e as Error).message);
    }
  }


  return (
    <DashboardLayout>
      <PageContainer>
        <PageHeader
          icon={ListOrdered}
          title="Sequences"
          description="A series of emails sent on a schedule. Add someone and each step goes out automatically."
          actions={
            (loading || sequences.length > 0) && (
              <button
                onClick={() => navigate("/sequences/new")}
                className="inline-flex h-9 items-center gap-1.5 rounded-[6px] bg-accent px-4 text-sm font-medium text-accent-foreground shadow-sm transition-colors hover:bg-accent-hover touch:h-11"
              >
                <Plus size={14} />
                New sequence
              </button>
            )
          }
        />

        {/* Error state */}
        {error && (
          <div className="mb-4 rounded-[8px] border border-destructive/50 bg-destructive/10 px-4 py-3">
            <p className="text-sm text-destructive">{error}</p>
            <button
              onClick={fetchSequences}
              className="mt-2 text-xs font-medium text-destructive hover:underline"
            >
              Retry
            </button>
          </div>
        )}

        {/* Content */}
        <div>
          {loading ? (
            <p className="text-sm text-text-tertiary">Loading…</p>
          ) : sequences.length === 0 ? (
            <EmptyState
              icon={<ListOrdered />}
              title="No sequences yet"
              description="Send a series of emails on a schedule, like onboarding or follow-ups, without sending each one by hand."
              action={
                <button
                  onClick={() => navigate("/sequences/new")}
                  className="inline-flex h-9 items-center gap-1.5 rounded-[6px] bg-accent px-4 text-sm font-medium text-accent-foreground shadow-sm transition-colors hover:bg-accent-hover"
                >
                  <Plus size={14} />
                  New sequence
                </button>
              }
            />
          ) : (
            <div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
              <ul className="divide-y divide-border/60">
                {sequences.map((seq) => {
                  const total = totalDurationHours(seq);
                  return (
                    <li
                      key={seq.id}
                      data-testid="sequence-row"
                      data-sequence-id={seq.id}
                      className="group flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-text-primary/[0.02]"
                    >
                      <Link
                        to={`/sequences/${seq.id}`}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-bg-muted">
                          <ListOrdered
                            size={14}
                            className="text-text-tertiary"
                          />
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-medium text-text-primary">
                              {seq.name}
                            </p>
                            <span
                              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet/10 px-2 py-0.5 text-[10px] font-medium tabular-nums"
                              style={{ color: "#7c5cfc" }}
                              title={`${seq.steps.length} step${seq.steps.length === 1 ? "" : "s"}`}
                            >
                              {seq.steps.length} step
                              {seq.steps.length === 1 ? "" : "s"}
                            </span>
                          </div>
                          <p className="mt-0.5 inline-flex items-center gap-1 text-xs font-light text-text-tertiary">
                            <Clock size={10} />
                            spans {formatTotalDelay(total)}
                          </p>
                        </div>
                      </Link>
                      <div className="flex shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={() => navigate(`/sequences/${seq.id}/edit`)}
                          className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                        >
                          <Pencil size={12} />
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(seq.id)}
                          aria-label="Delete"
                          className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </PageContainer>
    </DashboardLayout>
  );
}
