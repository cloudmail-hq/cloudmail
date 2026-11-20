// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * What an outbound message's status indicator says, from the fields the list
 * projection carries: `delivery_status` plus the engagement cache (migration
 * 28). Shared by the mail list, the reading pane, and the MCP `engagement`
 * object, so all three tell the same story.
 *
 * ## "Opened", never "Read"
 *
 * An open is a tracking image loading. Privacy proxies (Apple MPP above all)
 * load it without anyone reading, and clients that block images never load it
 * though the person read every word. So the wording is "Opened", with a note
 * saying what that means, and nothing here claims a message was read.
 */

export interface EngagementFields {
	delivery_status?: string | null;
	opened_at?: string | null;
	last_opened_at?: string | null;
	open_count?: number | null;
	open_proxy_count?: number | null;
	clicked_at?: string | null;
	click_count?: number | null;
}

/** The single state the row indicator draws, most advanced first. */
export type OutboundState =
	| "queued"
	| "sent"
	| "delivered"
	| "opened"
	| "clicked"
	| "failed"
	| "bounced";

/** Shown wherever an "Opened" signal is, so nobody reads it as proof of reading. */
export const OPENED_CAVEAT =
	"Opened means the tracking image loaded; privacy proxies can trigger it.";

/**
 * The indicator state.
 *
 * Failure wins over everything (a bounced message that was somehow "opened" is
 * still a failure worth seeing). Then engagement, because a click or open
 * implies delivery whether or not the reconciler has confirmed it yet. Then
 * the delivery lifecycle. `null` delivery status on a row with no engagement
 * reads as `sent`: the legacy rows that predate the cache, and anything the
 * caller has already decided is outbound.
 */
export function outboundState(row: EngagementFields): OutboundState {
	const status = row.delivery_status ?? null;
	if (status === "failed" || status === "bounced") return status;
	if ((row.click_count ?? 0) > 0) return "clicked";
	if ((row.open_count ?? 0) > 0) return "opened";
	if (status === "delivered") return "delivered";
	if (status === "queued") return "queued";
	return "sent";
}

/** True when every recorded open came through a known privacy proxy. */
export function opensLikelyProxied(row: EngagementFields): boolean {
	const opens = row.open_count ?? 0;
	return opens > 0 && (row.open_proxy_count ?? 0) >= opens;
}

/** "just now", "5m ago", "2h ago", "3d ago". Coarse on purpose. */
export function relativeAgo(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return "";
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	return `${days}d ago`;
}

const STATE_LABEL: Record<OutboundState, string> = {
	queued: "Sending",
	sent: "Sent",
	delivered: "Delivered",
	opened: "Opened",
	clicked: "Clicked",
	failed: "Couldn't be sent",
	bounced: "Bounced",
};

export function outboundStateLabel(state: OutboundState): string {
	return STATE_LABEL[state];
}

/** "Opened 3×, last 2h ago" or null when never opened. */
export function opensSummary(row: EngagementFields, now: number = Date.now()): string | null {
	const opens = row.open_count ?? 0;
	if (opens <= 0) return null;
	const last = relativeAgo(row.last_opened_at ?? row.opened_at, now);
	const count = opens === 1 ? "Opened once" : `Opened ${opens}×`;
	const proxy = opensLikelyProxied(row) ? " (likely via a mail-privacy proxy)" : "";
	return `${count}${last ? `, last ${last}` : ""}${proxy}`;
}

/**
 * The accessible label (and tooltip) for the row indicator, e.g.
 * "Delivered. Opened 3×, last 2h ago. Clicked 1 link."
 */
export function outboundStatusDescription(row: EngagementFields, now: number = Date.now()): string {
	const state = outboundState(row);
	if (state === "failed" || state === "bounced") return STATE_LABEL[state];
	const base =
		state === "opened" || state === "clicked"
			? row.delivery_status === "delivered"
				? "Delivered"
				: "Sent"
			: STATE_LABEL[state];
	const parts = [base];
	const opens = opensSummary(row, now);
	if (opens) parts.push(opens);
	const clicks = row.click_count ?? 0;
	if (clicks > 0) parts.push(`Clicked ${clicks === 1 ? "1 link" : `${clicks} times`}`);
	return `${parts.join(". ")}.`;
}

/**
 * The status line under a sent message's header:
 * "Delivered · Opened 2× · clicked 1 link · last opened 10:42".
 * `formatTime` is injected so the reading pane can use the viewer's locale.
 */
export function outboundStatusLine(
	row: EngagementFields,
	formatTime: (iso: string) => string,
): string {
	const state = outboundState(row);
	if (state === "failed" || state === "bounced") return STATE_LABEL[state];
	const parts: string[] = [
		row.delivery_status === "delivered"
			? "Delivered"
			: row.delivery_status === "queued"
				? "Sending"
				: "Sent",
	];
	// Facts before timestamps: on a narrow screen the line truncates from the
	// end, and "clicked 1 link" matters more than when the last open was.
	const opens = row.open_count ?? 0;
	const clicks = row.click_count ?? 0;
	if (opens > 0) parts.push(opens === 1 ? "Opened" : `Opened ${opens}×`);
	if (clicks > 0) parts.push(`clicked ${clicks === 1 ? "1 link" : `${clicks} times`}`);
	if (opens > 0) {
		if (opensLikelyProxied(row)) parts.push("likely via privacy proxy");
		const last = row.last_opened_at ?? row.opened_at;
		if (last) parts.push(`last opened ${formatTime(last)}`);
	}
	return parts.join(" · ");
}

/** The MCP / API `engagement` object for an outbound message. */
export interface EngagementSummary {
	status: OutboundState;
	opened: boolean;
	open_count: number;
	first_opened_at: string | null;
	last_opened_at: string | null;
	/** True when every open came through a known mail-privacy proxy. */
	opens_likely_proxied: boolean;
	clicked: boolean;
	click_count: number;
	first_clicked_at: string | null;
	/** Always present, so a model never reports an open as a confirmed read. */
	note: string;
}

export function engagementSummary(row: EngagementFields): EngagementSummary {
	const opens = Number(row.open_count ?? 0);
	const clicks = Number(row.click_count ?? 0);
	return {
		status: outboundState(row),
		opened: opens > 0,
		open_count: opens,
		first_opened_at: row.opened_at ?? null,
		last_opened_at: row.last_opened_at ?? null,
		opens_likely_proxied: opensLikelyProxied(row),
		clicked: clicks > 0,
		click_count: clicks,
		first_clicked_at: row.clicked_at ?? null,
		note: OPENED_CAVEAT,
	};
}
