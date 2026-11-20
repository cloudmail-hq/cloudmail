// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-user assistant state: AI preferences and the daily brief.
 *
 * One instance per signed-in identity (`idFromName("user:<email>")`), so each
 * person's brief runs on their own clock in their own zone, and nothing here is
 * shared across users. Storage is the Durable Object's key-value API; the data
 * is a handful of small records, not a table's worth.
 *
 * ## The brief alarm
 *
 * When the brief is enabled the alarm is set to the next local run time
 * (`nextBriefAt`, DST-aware). On firing it resolves the user's *current*
 * authority (so a revoked grant drops the mailbox from tomorrow's brief),
 * collects a slice from each readable mailbox, stores the result, optionally
 * emails it, and re-arms for the next local day. Disabling deletes the alarm.
 *
 * Briefs are kept for `BRIEF_HISTORY` days; the newest is the "Today" card.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import {
	DEFAULT_ASSISTANT_PREFS,
	mergeAssistantPrefs,
	normalizeAssistantPrefs,
	type AssistantPrefs,
	type AssistantPrefsPatch,
} from "../../shared/ai-settings";
import { nextBriefAt, type DailyBrief } from "../../shared/daily-brief";
import { buildBriefForIdentity, deliverBriefEmail, type BriefOwner } from "./daily-brief";

const PREFS_KEY = "prefs";
const OWNER_KEY = "owner";
const BRIEF_PREFIX = "brief:";
const DISMISSED_KEY = "dismissed";
export const BRIEF_HISTORY = 7;

export interface BriefState {
	brief: DailyBrief | null;
	dismissed: boolean;
	nextRunAt: string | null;
}

export class AssistantDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;

	async getPrefs(): Promise<AssistantPrefs> {
		return normalizeAssistantPrefs((await this.ctx.storage.get(PREFS_KEY)) ?? DEFAULT_ASSISTANT_PREFS);
	}

	/**
	 * Save a patch and re-arm the brief alarm. `owner` is refreshed on every
	 * write so the alarm, which has no request, knows whose mail to read.
	 */
	async updatePrefs(owner: BriefOwner, patch: AssistantPrefsPatch): Promise<AssistantPrefs> {
		const next = mergeAssistantPrefs(await this.getPrefs(), patch);
		await this.ctx.storage.put(PREFS_KEY, next);
		await this.ctx.storage.put(OWNER_KEY, owner);
		await this.rearm(next);
		return next;
	}

	private async rearm(prefs: AssistantPrefs, now = Date.now()): Promise<void> {
		if (!prefs.brief.enabled) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		await this.ctx.storage.setAlarm(nextBriefAt(now, prefs.brief.time, prefs.brief.timeZone));
	}

	async getBriefState(): Promise<BriefState> {
		const brief = await this.latestBrief();
		const dismissed = brief ? (await this.ctx.storage.get<string>(DISMISSED_KEY)) === brief.id : false;
		const alarm = await this.ctx.storage.getAlarm();
		return { brief, dismissed, nextRunAt: alarm ? new Date(alarm).toISOString() : null };
	}

	async dismissBrief(id: string): Promise<boolean> {
		const brief = await this.latestBrief();
		if (!brief || brief.id !== id) return false;
		await this.ctx.storage.put(DISMISSED_KEY, id);
		return true;
	}

	/**
	 * Build (and store) a brief now, for "Generate now" and for the alarm.
	 * `owner` comes from the request when there is one, else from storage.
	 */
	async generateBrief(owner?: BriefOwner, options: { email?: boolean } = {}): Promise<DailyBrief | null> {
		const who = owner ?? (await this.ctx.storage.get<BriefOwner>(OWNER_KEY));
		if (!who) return null;
		if (owner) await this.ctx.storage.put(OWNER_KEY, owner);
		const prefs = await this.getPrefs();
		const brief = await buildBriefForIdentity(this.env, who, {
			now: Date.now(),
			time: prefs.brief.time,
			timeZone: prefs.brief.timeZone,
			// On demand: include everything up to now, not just to this morning.
			throughNow: !!owner,
		});
		await this.storeBrief(brief);
		if (options.email) {
			try {
				await deliverBriefEmail(this.env, who, brief);
			} catch (e) {
				console.error("brief email failed:", (e as Error).message);
			}
		}
		return brief;
	}

	async alarm(): Promise<void> {
		const prefs = await this.getPrefs();
		if (!prefs.brief.enabled) return;
		try {
			await this.generateBrief(undefined, { email: prefs.brief.email });
		} catch (e) {
			console.error("daily brief failed:", (e as Error).message);
		}
		// Always re-arm from "now", so a late or failed run does not double-fire.
		await this.rearm(prefs, Date.now() + 1000);
	}

	private async storeBrief(brief: DailyBrief): Promise<void> {
		await this.ctx.storage.put(`${BRIEF_PREFIX}${brief.until}`, brief);
		const all = await this.ctx.storage.list<DailyBrief>({ prefix: BRIEF_PREFIX });
		const keys = [...all.keys()].sort();
		const stale = keys.slice(0, Math.max(0, keys.length - BRIEF_HISTORY));
		if (stale.length > 0) await this.ctx.storage.delete(stale);
	}

	private async latestBrief(): Promise<DailyBrief | null> {
		const all = await this.ctx.storage.list<DailyBrief>({ prefix: BRIEF_PREFIX, reverse: true, limit: 1 });
		return [...all.values()][0] ?? null;
	}
}
