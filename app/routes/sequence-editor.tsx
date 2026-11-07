// Sequence Editor Page - Create/Edit multi-step drip campaigns

import { useEffect, useId, useState } from "react";
import { useNavigate, useParams, Link } from "react-router";
import {
  ArrowLeft,
  GripVertical,
  ListOrdered,
  Plus,
  Sparkles,
  Trash2,
  Loader2,
} from "lucide-react";
import DashboardLayout from "~/components/DashboardLayout";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import { PageContainer } from "~/components/ui/page";
import CreateTemplateDialog from "~/components/templates/CreateTemplateDialog";
import { sequenceBlockers, stepsSummary } from "~/lib/sequence-form";

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

interface EmailTemplate {
  id: string;
  slug: string;
  name: string;
  subject: string;
}

/** Cumulative offset from the enrollment start */
function formatCumulative(steps: SequenceStep[], idx: number): string {
  const total = steps
    .slice(0, idx + 1)
    .reduce(
      (acc, s) => acc + (Number.isFinite(s.delayHours) ? s.delayHours : 0),
      0,
    );
  if (total === 0) return "Day 0 · sends right away";
  if (total < 24) return `+${total}h after enrollment`;
  const days = Math.round((total / 24) * 10) / 10;
  return `Day ${days}`;
}

const FORM_INPUT_CLASS =
  "h-10 w-full rounded-[6px] border border-border bg-bg-subtle px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/30";

export default function SequenceEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEditing = Boolean(id) && id !== "new";

  const [name, setName] = useState("");
  const [steps, setSteps] = useState<SequenceStep[]>([
    { order: 1, templateSlug: "", delayHours: 0 },
  ]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /** The step a "Create a template" dialog will fill, or null when closed. */
  const [creatingFor, setCreatingFor] = useState<number | null>(null);
  const nameId = useId();
  const blockersId = useId();

  useEffect(() => {
    loadData();
  }, [id]);

  async function loadData() {
    try {
      setLoading(true);

      setTemplates(await api.listTemplates());

      if (isEditing && id) {
        const sequence = await api.getSequence(id);
        setName(sequence.name);
        setSteps(
          sequence.steps.length > 0
            ? sequence.steps
            : [{ order: 1, templateSlug: "", delayHours: 0 }],
        );
      }

      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function addStep() {
    const maxOrder =
      steps.length > 0 ? Math.max(...steps.map((s) => s.order)) : 0;
    setSteps([
      ...steps,
      { order: maxOrder + 1, templateSlug: "", delayHours: 24 },
    ]);
  }

  function removeStep(order: number) {
    if (steps.length <= 1) return;
    setSteps(steps.filter((s) => s.order !== order));
  }

  function updateStep(
    order: number,
    field: keyof SequenceStep,
    value: SequenceStep[keyof SequenceStep],
  ) {
    setSteps(
      steps.map((s) => (s.order === order ? { ...s, [field]: value } : s)),
    );
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (blockers.length > 0) return;
    
    setSaving(true);
    setError("");
    
    try {
      if (isEditing && id) {
        await api.updateSequence(id, { name, steps });
      } else {
        await api.createSequence({ name, steps });
      }

      navigate("/sequences");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const blockers = sequenceBlockers(name, steps);
  const summary = stepsSummary(steps);


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
              {isEditing ? name || "Edit sequence" : "New sequence"}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {isEditing
                ? summary
                : "Build a multi-step drip. Emails are scheduled automatically."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Why Create is disabled, read with the button (aria-describedby). */}
            {blockers.length > 0 ? (
              <p id={blockersId} className="w-full text-xs text-text-secondary sm:order-none sm:w-auto">
                {blockers.join(" · ")}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => navigate("/sequences")}
              className="min-h-11 rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary sm:min-h-8 transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => handleSubmit()}
              disabled={saving || blockers.length > 0}
              aria-describedby={blockers.length > 0 ? blockersId : undefined}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-[6px] bg-accent px-3 py-1.5 sm:min-h-8 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving && <Loader2 size={12} className="animate-spin" />}
              {saving
                ? "Saving…"
                : isEditing
                  ? "Save changes"
                  : "Create sequence"}
            </button>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-[8px] border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="max-w-4xl space-y-5">
          {/* --- Details card --- */}
          <section className="rounded-[8px] bg-card p-5 ring-1 ring-border">
            <div className="flex items-start gap-2 mb-4">
              <Sparkles size={14} className="mt-0.5 text-text-tertiary" />
              <div>
                <h2 className="text-sm font-semibold text-text-primary">Details</h2>
                <p className="text-xs font-light text-text-secondary">
                  Give the sequence a clear name — it shows up in the enroll picker.
                </p>
              </div>
            </div>

            <div>
              <label
                htmlFor={nameId}
                className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-text-tertiary"
              >
                Sequence name
              </label>
              <input
                id={nameId}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Welcome onboarding"
                required
                className={FORM_INPUT_CLASS}
              />
              <p className="mt-1 text-xs font-light text-text-tertiary">
                Visible to admins only.
              </p>
            </div>
          </section>

          {/* --- Steps card --- */}
          <section className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="flex items-start gap-2">
                <ListOrdered size={14} className="mt-0.5 text-text-tertiary" />
                <div>
                  <h2 className="text-sm font-semibold text-text-primary">Steps</h2>
                  <p className="text-xs font-light text-text-secondary">
                    {summary} Delay is measured from the previous step.
                  </p>
                </div>
              </div>
            </div>

            {templates.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-5 py-8 text-center">
                <p className="text-sm text-text-secondary">
                  Every step sends a template, and there aren't any yet.
                </p>
                <button
                  type="button"
                  onClick={() => setCreatingFor(steps[0]?.order ?? 1)}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-[6px] bg-accent px-3.5 text-[13px] font-semibold text-accent-foreground hover:bg-accent-hover sm:min-h-9"
                >
                  <Plus size={14} aria-hidden />
                  Create a template
                </button>
              </div>
            ) : (
              <>
                <ul
                  data-testid="sequence-steps"
                  className="divide-y divide-border/60"
                >
                  {steps.map((step, idx) => (
                    <li
                      key={step.order}
                      data-testid="sequence-step-row"
                      data-step-index={idx}
                      className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center"
                    >
                      <div className="flex shrink-0 items-center gap-2">
                        <GripVertical
                          size={14}
                          className="text-text-tertiary/60"
                          aria-hidden
                        />
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet/10 text-[11px] font-semibold tabular-nums">
                          <span style={{ color: "#7c5cfc" }}>{idx + 1}</span>
                        </span>
                      </div>

                      <div className="grid min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
                        <div className="min-w-0">
                          <div className="mb-1.5 flex items-center justify-between gap-2">
                            <label
                              htmlFor={`step-template-${step.order}`}
                              className="block text-xs font-medium uppercase tracking-wider text-text-tertiary"
                            >
                              Template
                            </label>
                            <button
                              type="button"
                              onClick={() => setCreatingFor(step.order)}
                              className="-my-2 inline-flex min-h-11 items-center gap-1 rounded-[6px] px-1.5 text-xs font-medium text-accent hover:underline sm:min-h-0 sm:py-1"
                            >
                              <Plus size={12} aria-hidden />
                              New template
                            </button>
                          </div>
                          <select
                            id={`step-template-${step.order}`}
                            value={step.templateSlug}
                            onChange={(e) =>
                              updateStep(step.order, "templateSlug", e.target.value)
                            }
                            required
                            className={cn(FORM_INPUT_CLASS, "appearance-none pr-8")}
                          >
                            <option value="" disabled>
                              Select a template…
                            </option>
                            {templates.map((t) => (
                              <option key={t.slug} value={t.slug}>
                                {t.name} · {t.slug}
                              </option>
                            ))}
                          </select>
                          <p className="mt-1 text-xs text-text-tertiary/80">
                            {formatCumulative(steps, idx)}
                          </p>
                        </div>

                        <div className="sm:w-40">
                          <label
                            htmlFor={`step-delay-${step.order}`}
                            className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-text-tertiary"
                          >
                            Delay
                          </label>
                          <div className="relative">
                            <input
                              id={`step-delay-${step.order}`}
                              type="number"
                              min={0}
                              value={step.delayHours}
                              onChange={(e) =>
                                updateStep(
                                  step.order,
                                  "delayHours",
                                  parseInt(e.target.value, 10) || 0,
                                )
                              }
                              className={cn(FORM_INPUT_CLASS, "pr-12 tabular-nums")}
                            />
                            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-text-secondary">
                              hrs
                            </span>
                          </div>
                          <p className="mt-1 text-xs font-light text-text-tertiary">
                            {idx === 0
                              ? "Set 0 so step 1 fires on enrollment."
                              : "Hours after the previous step."}
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => removeStep(step.order)}
                        disabled={steps.length <= 1}
                        aria-label={`Remove step ${idx + 1}`}
                        className="inline-flex h-11 sm:h-8 shrink-0 items-center gap-1.5 self-end rounded-[6px] px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 sm:self-auto"
                      >
                        <Trash2 size={12} />
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="border-t border-border bg-bg-subtle/40 px-5 py-3">
                  <button
                    type="button"
                    onClick={addStep}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-[6px] border border-dashed sm:min-h-8 border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-text-primary/30 hover:bg-bg-muted hover:text-text-primary"
                  >
                    <Plus size={12} />
                    Add step
                  </button>
                </div>
              </>
            )}
          </section>
        </form>

        <CreateTemplateDialog
          open={creatingFor !== null}
          onOpenChange={(open) => {
            if (!open) setCreatingFor(null);
          }}
          onCreated={(template) => {
            setTemplates((prev) => [...prev.filter((t) => t.slug !== template.slug), template]);
            const target = creatingFor;
            setSteps((prev) =>
              prev.map((s) => (s.order === target ? { ...s, templateSlug: template.slug } : s)),
            );
          }}
        />
      </PageContainer>
    </DashboardLayout>
  );
}
