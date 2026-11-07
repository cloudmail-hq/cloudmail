/**
 * Pure helpers for the sequence editor's summary line and save gating.
 */

export interface SequenceStepDraft {
	templateSlug: string;
	delayHours: number;
}

/** Round delay-hours into a friendlier string for the summary line. */
export function formatDelay(hours: number): string {
	if (hours <= 0) return "immediately";
	if (hours < 24) return `${hours}h`;
	const days = Math.round((hours / 24) * 10) / 10;
	return days === 1 ? "1 day" : `${days} days`;
}

/** Steps that count: only those with a template picked. */
export function configuredSteps<T extends SequenceStepDraft>(steps: T[]): T[] {
	return steps.filter((s) => s.templateSlug);
}

/**
 * "2 steps · spans 3 days end-to-end", counting only steps with a template.
 * With none it says so, instead of "1 step · spans immediately".
 */
export function stepsSummary(steps: SequenceStepDraft[]): string {
	const ready = configuredSteps(steps);
	if (ready.length === 0) return "0 steps yet. Pick a template for the first step.";
	const hours = ready.reduce((acc, s) => acc + (Number.isFinite(s.delayHours) ? s.delayHours : 0), 0);
	const span = hours <= 0 ? "sends immediately" : `spans ${formatDelay(hours)} end-to-end`;
	return `${ready.length} step${ready.length === 1 ? "" : "s"} · ${span}.`;
}

/** Why the sequence can't be saved yet, in display order. Empty means ready. */
export function sequenceBlockers(name: string, steps: SequenceStepDraft[]): string[] {
	const out: string[] = [];
	if (!name.trim()) out.push("Name required");
	if (steps.length === 0) out.push("Add at least one step");
	else if (steps.some((s) => !s.templateSlug)) {
		out.push(steps.length === 1 ? "Pick a template for the step" : "Pick a template for every step");
	}
	return out;
}
