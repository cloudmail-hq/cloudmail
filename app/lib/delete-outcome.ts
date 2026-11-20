// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Reading what a delete actually did.
 *
 * `DELETE /emails/:id` is two-stage: a message anywhere else moves to Trash and
 * the route answers `{ status: "trashed" }`, while one already in Trash or Spam is
 * destroyed and the route answers 204 with no body. Only the first is
 * recoverable, so the distinction decides both the wording and whether Undo is
 * offered at all.
 *
 * This exists because the two callers disagreed. The message toolbar checked the
 * response; discarding a draft did not, and announced "Draft moved to Trash" with
 * an Undo button every time — so on the destroy path it promised a recovery that
 * could not happen, and the Undo it offered failed its 404 in silence. One
 * function means a third caller cannot invent a third reading.
 */

/**
 * Whether the message was binned rather than destroyed.
 *
 * Deliberately tolerant of the shape: a 204 surfaces as `undefined` or `null`
 * depending on the client path, and anything without a `status` field is not a
 * bin. Erring towards "destroyed" is the safe default — it withholds an Undo that
 * would not have worked, rather than offering one that cannot.
 */
export function wasTrashed(result: unknown): boolean {
	return !!result && typeof result === "object" && "status" in result;
}
