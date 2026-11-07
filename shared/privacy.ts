// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The operator's privacy settings: the public notice at `/privacy` and the
 * retention periods the purge job enforces.
 *
 * One record for the deployment, stored in R2 at `privacy/settings.json` (see
 * `workers/lib/privacy.ts`). Lives in `shared/` because the Settings page edits
 * it, the public page renders it and the Worker validates it; one declaration
 * of the shape keeps the three in step.
 *
 * Nothing here is legal advice. The defaults describe what the software does;
 * whether that text satisfies the operator's obligations (DPDP Act 2023 and
 * Rules 2025, GDPR, or anything else) is for the operator and their counsel.
 */

import { z } from "zod";

// ── Retention ─────────────────────────────────────────────────────

/**
 * Retention periods, in days. Each is enforced by the purge job.
 *
 * - `trackingEventsDays`: open/click/download events (13 months, the CNIL's
 *   ceiling for audience-measurement data).
 * - `deliveryEventsDays`: sent/delivered/bounced ledger rows (13 months).
 * - `agentChatDays`: the AI side panel's conversation (90 days).
 * - `auditLogDays`: who-did-what entries (1 year, the DPDP Rule 6 minimum for
 *   access logs, so the floor below is 365).
 * - `trashDays`: how long Trash keeps a message (30 days).
 */
export interface RetentionPolicy {
	trackingEventsDays: number;
	deliveryEventsDays: number;
	agentChatDays: number;
	auditLogDays: number;
	trashDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
	trackingEventsDays: 395,
	deliveryEventsDays: 395,
	agentChatDays: 90,
	auditLogDays: 365,
	trashDays: 30,
};

/** Bounds per field. Audit logs may not drop below a year (DPDP Rule 6). */
export const RETENTION_BOUNDS: Record<keyof RetentionPolicy, { min: number; max: number }> = {
	trackingEventsDays: { min: 1, max: 3650 },
	deliveryEventsDays: { min: 1, max: 3650 },
	agentChatDays: { min: 1, max: 3650 },
	auditLogDays: { min: 365, max: 3650 },
	trashDays: { min: 1, max: 365 },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant before which a record is past retention. Strictly older rows
 * go; a row stamped exactly at the cutoff stays, so a period of N days keeps
 * N full days.
 */
export function retentionCutoff(nowMs: number, days: number): Date {
	return new Date(nowMs - days * DAY_MS);
}

function clampDays(value: unknown, field: keyof RetentionPolicy): number {
	const { min, max } = RETENTION_BOUNDS[field];
	const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_RETENTION[field];
	return Math.min(max, Math.max(min, n));
}

/** A stored policy with every field present and inside its bounds. */
export function normalizeRetention(raw: unknown): RetentionPolicy {
	const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		trackingEventsDays: clampDays(value.trackingEventsDays, "trackingEventsDays"),
		deliveryEventsDays: clampDays(value.deliveryEventsDays, "deliveryEventsDays"),
		agentChatDays: clampDays(value.agentChatDays, "agentChatDays"),
		auditLogDays: clampDays(value.auditLogDays, "auditLogDays"),
		trashDays: clampDays(value.trashDays, "trashDays"),
	};
}

// ── The notice ────────────────────────────────────────────────────

export const PRIVACY_TEXT_MAX = 4000;
const line = (max = 200) => z.string().trim().max(max);

/** What the admin may write. Every field optional: a patch over the stored record. */
export const PrivacySettingsInputSchema = z
	.object({
		controllerName: line(),
		controllerContact: line(320),
		grievanceOfficerName: line(),
		grievanceOfficerEmail: line(320),
		dataLocation: line(400),
		/** Extra operator text appended to the generated notice. */
		additionalText: z.string().max(PRIVACY_TEXT_MAX),
		/** Whether NEW mailboxes start with open/click tracking on. */
		trackingDefault: z.boolean(),
		retention: z
			.object({
				trackingEventsDays: z.number().int(),
				deliveryEventsDays: z.number().int(),
				agentChatDays: z.number().int(),
				auditLogDays: z.number().int(),
				trashDays: z.number().int(),
			})
			.partial()
			.strict(),
	})
	.partial()
	.strict();

export type PrivacySettingsInput = z.infer<typeof PrivacySettingsInputSchema>;

export interface PrivacySettings {
	controllerName: string;
	controllerContact: string;
	grievanceOfficerName: string;
	grievanceOfficerEmail: string;
	dataLocation: string;
	additionalText: string;
	/**
	 * Whether a newly created mailbox starts with open and click tracking on.
	 * Chosen at setup; existing mailboxes keep their own setting.
	 */
	trackingDefault: boolean;
	retention: RetentionPolicy;
	/** Epoch ms of the last edit; 0 when never saved. Shown as "last updated". */
	updatedAt: number;
}

export function defaultPrivacySettings(): PrivacySettings {
	return {
		controllerName: "",
		controllerContact: "",
		grievanceOfficerName: "",
		grievanceOfficerEmail: "",
		dataLocation: "Cloudflare's global network (Workers, Durable Objects and R2).",
		additionalText: "",
		trackingDefault: true,
		retention: { ...DEFAULT_RETENTION },
		updatedAt: 0,
	};
}

function str(value: unknown, fallback: string, max: number): string {
	return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

/** A stored record with every field present. Never throws. */
export function normalizePrivacySettings(raw: unknown): PrivacySettings {
	const base = defaultPrivacySettings();
	if (!raw || typeof raw !== "object") return base;
	const v = raw as Record<string, unknown>;
	return {
		controllerName: str(v.controllerName, base.controllerName, 200),
		controllerContact: str(v.controllerContact, base.controllerContact, 320),
		grievanceOfficerName: str(v.grievanceOfficerName, base.grievanceOfficerName, 200),
		grievanceOfficerEmail: str(v.grievanceOfficerEmail, base.grievanceOfficerEmail, 320),
		dataLocation: str(v.dataLocation, base.dataLocation, 400) || base.dataLocation,
		additionalText: typeof v.additionalText === "string" ? v.additionalText.slice(0, PRIVACY_TEXT_MAX) : "",
		trackingDefault: typeof v.trackingDefault === "boolean" ? v.trackingDefault : base.trackingDefault,
		retention: normalizeRetention(v.retention),
		updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
	};
}

/** Apply a validated patch. */
export function mergePrivacySettings(
	current: PrivacySettings,
	patch: PrivacySettingsInput,
	now: number,
): PrivacySettings {
	const { retention, ...rest } = patch;
	return normalizePrivacySettings({
		...current,
		...rest,
		retention: { ...current.retention, ...(retention ?? {}) },
		updatedAt: now,
	});
}

// ── Rendering ─────────────────────────────────────────────────────

/** One section of the public notice. Plain text; the renderer escapes it. */
export interface NoticeSection {
	heading: string;
	paragraphs: string[];
	bullets?: string[];
}

/** Whole years, the 13-month default, or exact days: never a rounded figure. */
function months(days: number): string {
	if (days % 365 === 0) return days === 365 ? "1 year" : `${days / 365} years`;
	if (days === 395) return "13 months";
	return days === 1 ? "1 day" : `${days} days`;
}

/**
 * The notice, as sections. Built from the settings so the retention periods
 * printed are the ones the purge job enforces, not a second copy that drifts.
 */
export function buildPrivacyNotice(
	settings: PrivacySettings,
	context: {
		appName: string;
		aiModel?: string;
		/** The active bring-your-own AI gateway's host, when one is configured. */
		aiGatewayHost?: string | null;
	},
): NoticeSection[] {
	const controller = settings.controllerName || `The operator of ${context.appName}`;
	const contact = settings.controllerContact || "the address the operator publishes for this service";
	const grievance = settings.grievanceOfficerEmail
		? `${settings.grievanceOfficerName || "Grievance Officer"}, ${settings.grievanceOfficerEmail}`
		: `Not yet published. Contact ${contact}.`;
	const r = settings.retention;
	const model = context.aiModel ?? "Cloudflare Workers AI";

	const sections: NoticeSection[] = [
		{
			heading: "Who is responsible",
			paragraphs: [
				`${controller} runs this mail service and decides how the data in it is used. Contact: ${contact}.`,
				`Grievance Officer: ${grievance}`,
			],
		},
		{
			heading: "What is processed",
			paragraphs: [],
			bullets: [
				"Account data: email address, name, password hash, passkeys and two-factor secrets.",
				"Mail content and metadata for the mailboxes you use: messages, attachments, folders and labels.",
				"Security records: IP addresses and browser details for sign-in sessions, plus an audit log of sends, deletions and settings changes.",
				"Assistant conversations from the AI side panel.",
				"Engagement events about people you email, when open and click tracking is on for a mailbox: whether a message was opened or a link clicked, with the time, browser and an approximate privacy-proxy flag.",
			],
		},
		{
			heading: "Why",
			paragraphs: [],
			bullets: [
				"To provide the mailbox: receiving, storing, sending and searching mail.",
				"Security and abuse prevention: sign-in protection, rate limits and audit logs.",
				"AI assistance, when you use it: drafting replies and summarising threads.",
				"Optional measurement: open and click tracking, which each mailbox can turn off.",
			],
		},
		{
			heading: "AI processing",
			paragraphs: context.aiGatewayHost
				? [
						`AI features run on an AI provider the operator chose, at ${context.aiGatewayHost}. Mail is sent there only to answer the request in front of it. Screening for prompt injection runs on Cloudflare Workers AI.`,
					]
				: [
						`AI features run on ${model}, inside Cloudflare's network. Mail is sent to the model only to answer the request in front of it. It is not used to train models.`,
					],
		},
		{
			heading: "Where data is stored and who processes it",
			paragraphs: [
				`Data is stored on ${settings.dataLocation}`,
				"Processor: Cloudflare, Inc. (Workers, Durable Objects, R2, Email Service and Workers AI).",
			],
		},
		{
			heading: "How long it is kept",
			paragraphs: [],
			bullets: [
				`Open, click and download events: ${months(r.trackingEventsDays)}.`,
				`Delivery events (sent, delivered, bounced): ${months(r.deliveryEventsDays)}.`,
				`AI assistant conversations: ${months(r.agentChatDays)}.`,
				`Audit log: ${months(r.auditLogDays)}.`,
				`Trash: ${months(r.trashDays)}, then the message is deleted.`,
				"Mail and account data: until you delete it or your account. A deleted account is purged after a 7-day grace period.",
			],
		},
		{
			heading: "Your rights",
			paragraphs: [
				"You can ask to access, correct or erase your data, raise a grievance, and nominate someone to act for you (DPDP Act 2023). Under the GDPR you can also object, restrict processing and take your data elsewhere.",
				"In the app: Settings > Account & security has Export my data (a download of your mailboxes and account) and Delete my account.",
				"If you are not satisfied with the answer, you can complain to the Data Protection Board of India or your local data protection authority.",
			],
		},
		{
			heading: "Withdrawing consent and tracking",
			paragraphs: [
				"If you received mail from this service, the unsubscribe page lets you stop open and click tracking of your mail from that sender. Account holders can turn tracking off per mailbox, or for a single message.",
			],
		},
		{
			heading: "Cookies",
			paragraphs: [
				"One strictly necessary cookie keeps you signed in (__Host-tt_session). There are no advertising or analytics cookies, so there is no cookie banner.",
			],
		},
		{
			heading: "Breaches",
			paragraphs: [
				"If a personal data breach happens, affected users and the Data Protection Board of India will be told without delay, with a detailed report within 72 hours.",
			],
		},
	];

	if (settings.additionalText.trim()) {
		sections.push({
			heading: "More from the operator",
			paragraphs: settings.additionalText
				.split(/\n{2,}/)
				.map((p) => p.trim())
				.filter(Boolean),
		});
	}
	return sections;
}

// ── Tracking disclosure ───────────────────────────────────────────

export const DEFAULT_TRACKING_DISCLOSURE = "This message may track opens and clicks.";
