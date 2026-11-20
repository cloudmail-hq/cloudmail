// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Which mailbox an inbound message is delivered into.
 *
 * ## One target address
 *
 * Exactly one recipient address is routed on, chosen the way the handler always
 * chose it: the first recipient on a served domain. Recipients arrive envelope
 * first (see `resolveInboundRecipients`), so when the envelope recipient is on
 * a served domain it is the only address considered. `To:` header addresses
 * are a fallback only when the envelope recipient is missing or on a domain
 * this deployment does not serve.
 *
 * Routing on the envelope alone matters once aliases and catch-alls exist. The
 * envelope says where Cloudflare delivered the message; the header says whom
 * the sender addressed, which can name any other mailbox here. Falling through
 * to header addresses would let mail for an unknown or alias address land in a
 * different real mailbox merely because it was also listed in `To:`.
 *
 * ## Resolving the target
 *
 *   1. a mailbox with exactly that address (R2 only, no AuthDO),
 *   2. else the mailbox listing it as an alias,
 *   3. else the catch-all mailbox of its domain, if one is set,
 *   4. else nothing: the message is dropped and logged, as before.
 *
 * Steps 2 and 3 read the AuthDO. If that read fails or times out, routing
 * throws so Cloudflare retries or bounces the message, rather than guessing.
 *
 * ## EMAIL_ADDRESSES
 *
 * When set, behaviour is unchanged from before aliases: the first recipient on
 * that allowlist is the target, delivered only to its exact mailbox. Aliases
 * and catch-alls do not apply in that mode.
 *
 * `resolveInboundMailbox` is pure apart from the injected lookups, which is
 * what the unit tests drive; `routeInbound` wires it to R2 and the AuthDO.
 */

import type { Env } from "../types";
import { domainOfAddress, isDomainAllowed, refreshStoredDomains } from "./zones";

export type InboundRoute = {
	/** Mailbox (its address) the message is stored in. */
	mailboxId: string;
	/** The recipient address that matched. */
	deliveredTo: string;
	via: "direct" | "alias" | "catch_all";
};

export interface RoutingLookup {
	/** Alias address → mailbox. */
	aliases: Record<string, string>;
	/** Domain → catch-all mailbox. */
	catchAll: Record<string, string>;
}

export interface InboundRoutingDeps {
	/** Whether a mailbox with this exact address exists. */
	mailboxExists: (address: string) => Promise<boolean>;
	/**
	 * Alias and catch-all lookup for the target address. Only called when the
	 * target is not itself a mailbox. May throw; the error propagates.
	 */
	lookup: (address: string) => Promise<RoutingLookup>;
	/** Whether this deployment serves the domain. */
	isServed: (domain: string) => boolean;
	/** When non-empty, the only mailbox addresses that may receive mail. */
	allowedAddresses?: string[];
}

/** The single address a message is routed on, or null if none qualifies. */
export function selectTargetAddress(
	recipients: string[],
	isServed: (domain: string) => boolean,
	allowedAddresses: string[] = [],
): string | null {
	const normalized = recipients.map((r) => r.trim().toLowerCase()).filter(Boolean);
	const allowed = allowedAddresses.map((a) => a.toLowerCase());
	if (allowed.length > 0) return normalized.find((a) => allowed.includes(a)) ?? null;
	return normalized.find((a) => {
		const domain = domainOfAddress(a);
		return domain !== "" && isServed(domain);
	}) ?? null;
}

export async function resolveInboundMailbox(
	recipients: string[],
	deps: InboundRoutingDeps,
): Promise<InboundRoute | null> {
	const allowed = (deps.allowedAddresses ?? []).map((a) => a.toLowerCase());
	const target = selectTargetAddress(recipients, deps.isServed, allowed);
	if (!target) return null;
	if (!deps.isServed(domainOfAddress(target))) return null;

	if (await deps.mailboxExists(target)) {
		return { mailboxId: target, deliveredTo: target, via: "direct" };
	}
	// The allowlist names exact mailboxes; aliases and catch-alls do not widen it.
	if (allowed.length > 0) return null;

	const { aliases, catchAll } = await deps.lookup(target);

	const aliasOf = aliases[target];
	if (aliasOf && (await deps.mailboxExists(aliasOf))) {
		return { mailboxId: aliasOf, deliveredTo: target, via: "alias" };
	}

	const fallback = catchAll[domainOfAddress(target)];
	if (fallback && (await deps.mailboxExists(fallback))) {
		return { mailboxId: fallback, deliveredTo: target, via: "catch_all" };
	}
	return null;
}

/** How long an AuthDO read on the inbound path may take before it fails. */
export const ROUTING_LOOKUP_TIMEOUT_MS = 5_000;

/** Reject `promise` if it has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Shape of the AuthDO calls inbound routing makes; narrowed for injection. */
interface RoutingStore {
	routingLookup(addresses: string[]): Promise<RoutingLookup>;
	listDomains(): Promise<{ hostname: string; displayName: string; zoneId: string | null }[]>;
}

/**
 * Resolve against live storage.
 *
 * Throws when the AuthDO cannot answer (unreachable or slower than
 * `ROUTING_LOOKUP_TIMEOUT_MS`), both for the domain list (without it a DB
 * domain looks unserved and a header address could be chosen instead) and for
 * the alias/catch-all lookup. The email handler rethrows, so Cloudflare
 * retries or bounces instead of the message being misrouted.
 */
export async function routeInbound(env: Env, recipients: string[]): Promise<InboundRoute | null> {
	// The namespace directly, not `authStore()`: importing `auth/store.ts` pulls
	// in `cloudflare:workers`, which would keep this module out of unit tests.
	const ns = env.AUTH_STORE as unknown as DurableObjectNamespace | undefined;
	const store = ns ? (ns.get(ns.idFromName("global")) as unknown as RoutingStore) : null;

	if (store) {
		await refreshStoredDomains(
			env,
			() => withTimeout(store.listDomains(), ROUTING_LOOKUP_TIMEOUT_MS, "Domain list"),
			Date.now(),
			{ strict: true },
		);
	}

	return resolveInboundMailbox(recipients, {
		mailboxExists: async (address) => (await env.BUCKET.head(`mailboxes/${address}.json`)) !== null,
		lookup: async (address) => {
			if (!store) return { aliases: {}, catchAll: {} };
			return withTimeout(store.routingLookup([address]), ROUTING_LOOKUP_TIMEOUT_MS, "Alias/catch-all lookup");
		},
		isServed: (domain) => isDomainAllowed(env, domain),
		allowedAddresses: (env.EMAIL_ADDRESSES ?? []) as string[],
	});
}
