// Email Sequences Service - Stored in R2
// Sequences are drip campaigns that send templated emails on a schedule

// R2Bucket is an ambient global from the generated worker-configuration.d.ts.
// Do not import it from @cloudflare/workers-types - the two declarations are
// structurally incompatible and every call site fails to typecheck.

import { listJsonUnderPrefix } from "./r2";

export interface SequenceStep {
  order: number;
  templateSlug: string;
  delayHours: number;
}

export interface Sequence {
  id: string;
  name: string;
  steps: SequenceStep[];
  createdAt: number;
  updatedAt: number;
}

export interface SequenceEnrollment {
  id: string;
  sequenceId: string;
  personId: string;
  personEmail: string;
  personName: string | null;
  fromAddress: string;
  status: "active" | "completed" | "cancelled";
  variables: Record<string, string>;
  enrolledAt: number;
  cancelledAt: number | null;
}

export interface SequenceEmail {
  id: string;
  enrollmentId: string;
  stepOrder: number;
  templateSlug: string;
  scheduledAt: number;
  status: "pending" | "sent" | "cancelled";
  sentAt: number | null;
  sentEmailId: string | null;
}

const SEQUENCES_PREFIX = "sequences/";
const ENROLLMENTS_PREFIX = "sequence-enrollments/";
const SCHEDULED_EMAILS_PREFIX = "sequence-emails/";

function sequenceKey(id: string): string {
  return `${SEQUENCES_PREFIX}${id}.json`;
}

function enrollmentKey(id: string): string {
  return `${ENROLLMENTS_PREFIX}${id}.json`;
}

function scheduledEmailKey(id: string): string {
  return `${SCHEDULED_EMAILS_PREFIX}${id}.json`;
}

// ==================== Sequences CRUD ====================

export async function listSequences(bucket: R2Bucket): Promise<Sequence[]> {
  const sequences = await listJsonUnderPrefix<Sequence>(
    bucket,
    SEQUENCES_PREFIX
  );

  // Sort by updatedAt descending
  return sequences.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getSequence(
  bucket: R2Bucket,
  id: string
): Promise<Sequence | null> {
  const obj = await bucket.get(sequenceKey(id));
  if (!obj) return null;
  return obj.json<Sequence>();
}

export async function createSequence(
  bucket: R2Bucket,
  data: { name: string; steps: SequenceStep[] }
): Promise<Sequence> {
  const { name, steps } = data;
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  
  // Ensure steps are properly ordered
  const orderedSteps = steps.map((step, idx) => ({
    ...step,
    order: idx + 1,
  }));
  
  const sequence: Sequence = {
    id,
    name,
    steps: orderedSteps,
    createdAt: now,
    updatedAt: now,
  };
  
  await bucket.put(sequenceKey(id), JSON.stringify(sequence));
  return sequence;
}

export async function updateSequence(
  bucket: R2Bucket,
  id: string,
  data: { name?: string; steps?: SequenceStep[] }
): Promise<Sequence | null> {
  const existing = await getSequence(bucket, id);
  if (!existing) return null;
  
  let steps = existing.steps;
  if (data.steps !== undefined) {
    // Ensure steps are properly ordered
    steps = data.steps.map((step, idx) => ({
      ...step,
      order: idx + 1,
    }));
  }
  
  const updated: Sequence = {
    ...existing,
    ...(data.name !== undefined && { name: data.name }),
    steps,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  
  await bucket.put(sequenceKey(id), JSON.stringify(updated));
  return updated;
}

export async function deleteSequence(
  bucket: R2Bucket,
  id: string
): Promise<boolean> {
  const existing = await bucket.head(sequenceKey(id));
  if (!existing) return false;
  
  // Also cancel all active enrollments for this sequence
  const enrollments = await listEnrollments(bucket, id);
  for (const enrollment of enrollments) {
    if (enrollment.status === "active") {
      await cancelEnrollment(bucket, enrollment.id);
    }
  }
  
  await bucket.delete(sequenceKey(id));
  return true;
}

// ==================== Enrollments ====================

export async function listEnrollments(
  bucket: R2Bucket,
  sequenceId?: string
): Promise<SequenceEnrollment[]> {
  const all = await listJsonUnderPrefix<SequenceEnrollment>(
    bucket,
    ENROLLMENTS_PREFIX
  );

  const enrollments = sequenceId
    ? all.filter((enrollment) => enrollment.sequenceId === sequenceId)
    : all;
  
  // Sort by enrolledAt descending
  return enrollments.sort((a, b) => b.enrolledAt - a.enrolledAt);
}

export async function getEnrollment(
  bucket: R2Bucket,
  id: string
): Promise<SequenceEnrollment | null> {
  const obj = await bucket.get(enrollmentKey(id));
  if (!obj) return null;
  return obj.json<SequenceEnrollment>();
}

export async function getPersonEnrollment(
  bucket: R2Bucket,
  personId: string
): Promise<SequenceEnrollment | null> {
  const all = await listJsonUnderPrefix<SequenceEnrollment>(
    bucket,
    ENROLLMENTS_PREFIX
  );

  return (
    all.find(
      (enrollment) =>
        enrollment.personId === personId && enrollment.status === "active"
    ) ?? null
  );
}

export async function enrollPerson(
  bucket: R2Bucket,
  data: {
    sequenceId: string;
    personId: string;
    personEmail: string;
    personName: string | null;
    fromAddress: string;
    variables?: Record<string, string>;
    skipSteps?: number[];
    delayOverrides?: Record<string, number>;
  }
): Promise<{ enrollment: SequenceEnrollment; scheduledEmails: SequenceEmail[] }> {
  const {
    sequenceId,
    personId,
    personEmail,
    personName,
    fromAddress,
    variables = {},
    skipSteps = [],
    delayOverrides = {},
  } = data;
  
  // Check if person is already enrolled in an active sequence
  const existingEnrollment = await getPersonEnrollment(bucket, personId);
  if (existingEnrollment) {
    throw new Error("Person is already enrolled in an active sequence");
  }
  
  // Get the sequence
  const sequence = await getSequence(bucket, sequenceId);
  if (!sequence) {
    throw new Error("Sequence not found");
  }
  
  const now = Math.floor(Date.now() / 1000);
  const enrollmentId = crypto.randomUUID();
  
  // Create enrollment
  const enrollment: SequenceEnrollment = {
    id: enrollmentId,
    sequenceId,
    personId,
    personEmail,
    personName,
    fromAddress,
    status: "active",
    variables,
    enrolledAt: now,
    cancelledAt: null,
  };
  
  // Create scheduled emails for each step
  const scheduledEmails: SequenceEmail[] = [];
  let cumulativeDelay = 0;
  
  for (const step of sequence.steps) {
    if (skipSteps.includes(step.order)) continue;
    
    // Check for delay override
    const delayHours = delayOverrides[step.order.toString()] ?? step.delayHours;
    cumulativeDelay += delayHours;
    
    const scheduledEmail: SequenceEmail = {
      id: crypto.randomUUID(),
      enrollmentId,
      stepOrder: step.order,
      templateSlug: step.templateSlug,
      scheduledAt: now + cumulativeDelay * 3600, // Convert hours to seconds
      status: "pending",
      sentAt: null,
      sentEmailId: null,
    };
    
    scheduledEmails.push(scheduledEmail);
    await bucket.put(scheduledEmailKey(scheduledEmail.id), JSON.stringify(scheduledEmail));
  }
  
  await bucket.put(enrollmentKey(enrollmentId), JSON.stringify(enrollment));
  
  return { enrollment, scheduledEmails };
}

export async function cancelEnrollment(
  bucket: R2Bucket,
  enrollmentId: string
): Promise<boolean> {
  const enrollment = await getEnrollment(bucket, enrollmentId);
  if (!enrollment) return false;
  
  // Update enrollment status
  const updated: SequenceEnrollment = {
    ...enrollment,
    status: "cancelled",
    cancelledAt: Math.floor(Date.now() / 1000),
  };
  await bucket.put(enrollmentKey(enrollmentId), JSON.stringify(updated));
  
  // Cancel all pending scheduled emails
  const emails = await listScheduledEmails(bucket, enrollmentId);
  for (const email of emails) {
    if (email.status === "pending") {
      const updatedEmail: SequenceEmail = {
        ...email,
        status: "cancelled",
      };
      await bucket.put(scheduledEmailKey(email.id), JSON.stringify(updatedEmail));
    }
  }
  
  return true;
}

// ==================== Scheduled Emails ====================

/**
 * Cancel one scheduled step without touching the rest of the enrollment.
 *
 * The dispatcher uses this for a step it can never send — a deleted template, or
 * a step belonging to an enrollment that was cancelled without its steps being
 * updated. Leaving such a row pending would make it a permanent retry: every
 * tick would pick it up, fail the same way, and log the same error.
 *
 * Returns false when the id is unknown or the step is no longer pending, so a
 * sent message can't be walked back.
 */
export async function cancelScheduledEmail(
  bucket: R2Bucket,
  emailId: string
): Promise<boolean> {
  const obj = await bucket.get(scheduledEmailKey(emailId));
  if (!obj) return false;

  const email = await obj.json<SequenceEmail>();
  if (email.status !== "pending") return false;

  const updated: SequenceEmail = { ...email, status: "cancelled" };
  await bucket.put(scheduledEmailKey(emailId), JSON.stringify(updated));
  return true;
}

export async function listScheduledEmails(
  bucket: R2Bucket,
  enrollmentId?: string
): Promise<SequenceEmail[]> {
  const all = await listJsonUnderPrefix<SequenceEmail>(
    bucket,
    SCHEDULED_EMAILS_PREFIX
  );

  const emails = enrollmentId
    ? all.filter((email) => email.enrollmentId === enrollmentId)
    : all;
  
  // Sort by scheduledAt ascending
  return emails.sort((a, b) => a.scheduledAt - b.scheduledAt);
}

export async function getPendingEmails(
  bucket: R2Bucket
): Promise<SequenceEmail[]> {
  const now = Math.floor(Date.now() / 1000);
  const all = await listJsonUnderPrefix<SequenceEmail>(
    bucket,
    SCHEDULED_EMAILS_PREFIX
  );

  const pending = all.filter(
    (email) => email.status === "pending" && email.scheduledAt <= now
  );
  
  return pending.sort((a, b) => a.scheduledAt - b.scheduledAt);
}

export async function markEmailSent(
  bucket: R2Bucket,
  emailId: string,
  sentEmailId: string
): Promise<SequenceEmail | null> {
  const obj = await bucket.get(scheduledEmailKey(emailId));
  if (!obj) return null;
  
  const email = await obj.json<SequenceEmail>();
  const updated: SequenceEmail = {
    ...email,
    status: "sent",
    sentAt: Math.floor(Date.now() / 1000),
    sentEmailId,
  };
  
  await bucket.put(scheduledEmailKey(emailId), JSON.stringify(updated));
  
  // Check if this was the last email in the sequence
  const enrollment = await getEnrollment(bucket, email.enrollmentId);
  if (enrollment && enrollment.status === "active") {
    const allEmails = await listScheduledEmails(bucket, email.enrollmentId);
    const allSentOrCancelled = allEmails.every(
      (e) => e.status === "sent" || e.status === "cancelled"
    );
    
    if (allSentOrCancelled) {
      // Mark enrollment as completed
      const completedEnrollment: SequenceEnrollment = {
        ...enrollment,
        status: "completed",
      };
      await bucket.put(enrollmentKey(enrollment.id), JSON.stringify(completedEnrollment));
    }
  }
  
  return updated;
}

// ==================== Helpers ====================

export interface EnrollmentWithDetails extends SequenceEnrollment {
  totalSteps: number;
  sentSteps: number;
}

export async function getEnrollmentWithDetails(
  bucket: R2Bucket,
  enrollmentId: string
): Promise<EnrollmentWithDetails | null> {
  const enrollment = await getEnrollment(bucket, enrollmentId);
  if (!enrollment) return null;
  
  const emails = await listScheduledEmails(bucket, enrollmentId);
  const totalSteps = emails.length;
  const sentSteps = emails.filter((e) => e.status === "sent").length;
  
  return {
    ...enrollment,
    totalSteps,
    sentSteps,
  };
}

export async function listEnrollmentsWithDetails(
  bucket: R2Bucket,
  sequenceId: string
): Promise<EnrollmentWithDetails[]> {
  const enrollments = await listEnrollments(bucket, sequenceId);
  const results: EnrollmentWithDetails[] = [];
  
  for (const enrollment of enrollments) {
    const emails = await listScheduledEmails(bucket, enrollment.id);
    const totalSteps = emails.length;
    const sentSteps = emails.filter((e) => e.status === "sent").length;
    
    results.push({
      ...enrollment,
      totalSteps,
      sentSteps,
    });
  }
  
  return results;
}
