// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Recipient tracking opt-outs: people who asked, on the `/u/:token` page, to
 * stop open and click tracking of mail from a sending domain.
 *
 * Stored in the global AuthDO (`0013_privacy_controls`), beside the
 * suppression list. An opt-out never blocks a send. It only means the send
 * path (`trackOutgoingHtml`) delivers that recipient's mail uninstrumented.
 */

import type { AuthDO } from "../auth/store";
import type { PrivacyStoreApi } from "../auth/types";
import type { Env } from "../types";
import type { TrackingOptOutLookup } from "./tracking-send";

/** The AuthDO stub, typed to the privacy surface. Null without the binding. */
export function privacyStore(env: Pick<Env, "AUTH_STORE">): PrivacyStoreApi | null {
	const ns = env.AUTH_STORE as unknown as DurableObjectNamespace<AuthDO> | undefined;
	if (!ns) return null;
	return ns.get(ns.idFromName("global")) as unknown as PrivacyStoreApi;
}

/**
 * The lookup the send path needs, or null when there is no AuthDO (hand-built
 * test environments). With the binding present, a lookup error fails closed
 * in `recipientsOptedOut`: the mail goes untracked.
 */
export function trackingOptOutStore(env: Pick<Env, "AUTH_STORE">): TrackingOptOutLookup | null {
	return privacyStore(env);
}
