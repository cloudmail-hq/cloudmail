// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The composer's "Don't track this message" switch, as it reaches the send
 * routes.
 *
 * Only the off state is sent. `track: true` would add nothing, because the
 * server already follows the mailbox setting when the field is absent, and
 * sending it would make every payload differ from what older clients send.
 * Every composer path (send now, the undo window, scheduled) builds its body
 * through `useComposeForm`'s `buildOutgoing`, which spreads this in.
 */
export function trackFieldFor(dontTrack: boolean): { track?: false } {
	return dontTrack ? { track: false } : {};
}
