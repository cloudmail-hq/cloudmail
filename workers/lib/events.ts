// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Helpers shared by the event stream's Worker route, its Durable Object and
 * the fan-out in MailboxDO. No `cloudflare:workers` import.
 */

import type { Env } from "../types";
import type { EnqueueInput } from "./webhooks-store";
import { canAccessMailbox, canDo, normalizeAddress, type Principal } from "./authz";
import { MAX_CONNECTION_LIFETIME_MS, type ConnectionGrant } from "./events-hub";

/** Set by the Worker on the request it forwards to the object; never by a client. */
export const EVENTS_GRANT_HEADER = "x-tapetide-events-grant";

/** The slice of the EventsDO stub the fan-out uses. */
export interface EventsSink {
	publish(events: EnqueueInput[]): Promise<{ published: number }>;
}

export interface EventsNamespace {
	idFromName(name: string): DurableObjectId;
	get(id: DurableObjectId): { fetch(request: Request): Promise<Response> } & EventsSink;
}

/** The global EventsDO stub, or null when the deployment has no `EVENTS` binding. */
export function eventsStub(env: Env): ({ fetch(request: Request): Promise<Response> } & EventsSink) | null {
	const ns = (env as { EVENTS?: EventsNamespace }).EVENTS;
	if (!ns) return null;
	return ns.get(ns.idFromName("global"));
}

/**
 * The mailboxes `principal` may read, from the known mailbox list; null when
 * it may read every mailbox (an unrestricted admin, or enforcement off).
 */
export function readableMailboxes(principal: Principal, all: string[]): string[] | null {
	// Unrestricted (admin session, enforcement off): every mailbox, including
	// ones created after the connection opened.
	if (principal.access === null && !principal.token) return null;
	// `canDo` intersects the user's grant, the token's mailboxes and its scopes,
	// so a grant with `read` revoked, or a token without `mail:read`, sees nothing.
	return [...new Set(all.map(normalizeAddress))].filter((m) => canAccessMailbox(principal, m) && canDo(principal, m, "read"));
}

/** One key per principal, for the connection cap. */
export function connectionKey(principal: Principal): string {
	const who = principal.identity?.id ?? (principal.developmentBypass ? "dev" : "anonymous");
	return `p:${who.toLowerCase()}`;
}

export function buildGrant(principal: Principal, readable: string[] | null, now: number, tokenExpiresAt: number | null = null): ConnectionGrant {
	const lifetime = now + MAX_CONNECTION_LIFETIME_MS;
	return {
		key: connectionKey(principal),
		readable,
		expiresAt: tokenExpiresAt !== null ? Math.min(lifetime, tokenExpiresAt) : lifetime,
	};
}

export function encodeGrant(grant: ConnectionGrant): string {
	return encodeURIComponent(JSON.stringify(grant));
}

export function decodeGrant(raw: string | null): ConnectionGrant | null {
	if (!raw) return null;
	try {
		const g = JSON.parse(decodeURIComponent(raw)) as ConnectionGrant;
		if (typeof g.key !== "string" || typeof g.expiresAt !== "number") return null;
		if (g.readable !== null && (!Array.isArray(g.readable) || g.readable.some((m) => typeof m !== "string"))) return null;
		return g;
	} catch {
		return null;
	}
}

/**
 * Hand events to the stream object. Never throws: the stream is best-effort
 * delivery on top of the webhook log, and must not fail the caller.
 */
export async function publishToStream(env: Env, events: EnqueueInput[]): Promise<void> {
	if (events.length === 0) return;
	const stub = eventsStub(env);
	if (!stub) return;
	try {
		await stub.publish(events);
	} catch (e) {
		console.error("event stream publish failed:", (e as Error).message);
	}
}
