// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Telling a bin from a destroy.
 *
 * `DELETE /emails/:id` is two-stage: a message anywhere else moves to Trash and
 * the route answers `{ status: "trashed" }`, while one already in Trash or Spam is
 * destroyed and the route answers 204 with no body. Only the first can be undone.
 *
 * Four call sites read that response — the reading pane's toolbar, discarding a
 * draft, the list's row delete, and the `#` keyboard shortcut — and they did not
 * agree. Discarding a draft never checked at all: it announced "Draft moved to
 * Trash" and offered an Undo every time, so deleting a draft that was already in
 * Trash promised a recovery that could not happen, and the Undo then failed its
 * 404 in silence.
 *
 * The predicate is now one function. These tests pin the shape it accepts,
 * because the 204 case is the one that arrives as a value nobody wrote a literal
 * for.
 */

import { describe, expect, it } from "vitest";
import { wasTrashed } from "../app/lib/delete-outcome";

describe("wasTrashed", () => {
	it("recognises the binned response", () => {
		expect(wasTrashed({ status: "trashed" })).toBe(true);
	});

	it("treats an empty 204 body as destroyed", () => {
		// What the route actually returns for a destroy, via whichever of these the
		// client layer produces. This is the case the draft path got wrong.
		expect(wasTrashed(undefined)).toBe(false);
		expect(wasTrashed(null)).toBe(false);
		expect(wasTrashed("")).toBe(false);
	});

	it("treats a body with no status as destroyed", () => {
		// Erring towards "destroyed" withholds an Undo that would not have worked,
		// rather than offering one that cannot.
		expect(wasTrashed({})).toBe(false);
		expect(wasTrashed({ deleted: 1 })).toBe(false);
	});

	it("does not mistake a non-object for a response", () => {
		expect(wasTrashed(0)).toBe(false);
		expect(wasTrashed(1)).toBe(false);
		expect(wasTrashed(true)).toBe(false);
		expect(wasTrashed("trashed")).toBe(false);
	});

	it("reads any status value as binned, not just the current wording", () => {
		// The field's presence is the signal; its text is for people. A test keyed to
		// the exact string would break on a copy change and hide nothing.
		expect(wasTrashed({ status: "moved" })).toBe(true);
	});
});
