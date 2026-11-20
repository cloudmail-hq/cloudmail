// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Reading tool calls back off an agent chat message.
 *
 * Lives here rather than in the panel component so it can be unit tested in a
 * plain Node environment, which is what caught the bug this module exists to
 * fix: the panel inspected AI SDK v4 field names (`part.toolName`,
 * `part.result`) against v6 messages, found nothing, and silently disabled
 * "Edit & send in composer" — with `as any` casts hiding the mismatch from
 * `tsc`.
 */

/**
 * The shape of a UI message part, as far as this module cares.
 *
 * Declared structurally instead of importing `UIMessage` from `ai` so the
 * helpers stay free of the React/SDK runtime. The fields are deliberately
 * `unknown`: they come off a streamed wire format, and narrowing them here is
 * the point.
 */
export interface InspectableToolPart {
	type: string;
	toolName?: unknown;
	state?: unknown;
	output?: unknown;
}

export interface InspectableMessage {
	parts: readonly InspectableToolPart[];
}

/**
 * Tools whose output the composer can pick up.
 *
 * Both `draft_reply` and `draft_email` persist a row to the Drafts folder and
 * return its id under `draftId`, so a handoff works identically for either.
 */
const DRAFT_TOOL_NAMES: ReadonlySet<string> = new Set([
	"draft_reply",
	"draft_email",
]);

/**
 * AI SDK v6 marks a tool part finished by setting `state` to this. Any earlier
 * state means the call is still streaming and `output` is absent or partial, so
 * acting on it would hand the composer an id that does not exist yet.
 */
const OUTPUT_AVAILABLE = "output-available";

/**
 * The tool a part belongs to, or null when the part is not a tool call.
 *
 * v6 encodes the name in the part type for statically-known tools
 * (`tool-draft_reply`) and carries it in a `toolName` field for dynamic ones.
 */
export function getToolNameFromPart(part: InspectableToolPart): string | null {
	if (part.type === "dynamic-tool") {
		return typeof part.toolName === "string" ? part.toolName : null;
	}
	// `slice` rather than `replace`: a tool whose own name contains "tool-"
	// would otherwise have the wrong substring removed from the middle.
	if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
	return null;
}

/**
 * Id of the draft this message's tool calls saved, or null if it saved none.
 *
 * Returns the *last* completed draft in the message. A single agent turn can
 * call `draft_reply` more than once — redrafting after a failed verification,
 * for instance — and the newest row is the one the operator means to edit.
 *
 * A tool that returned `{ error }` has no `draftId` and is skipped, so a failed
 * draft does not offer an edit button pointing at nothing.
 */
export function getDraftIdFromMessage(
	message: InspectableMessage,
): string | null {
	let draftId: string | null = null;

	for (const part of message.parts) {
		const toolName = getToolNameFromPart(part);
		if (!toolName || !DRAFT_TOOL_NAMES.has(toolName)) continue;
		if (part.state !== OUTPUT_AVAILABLE) continue;

		const output = part.output;
		if (!output || typeof output !== "object") continue;

		const candidate = (output as { draftId?: unknown }).draftId;
		if (typeof candidate === "string" && candidate) draftId = candidate;
	}

	return draftId;
}

/** True when the message saved a draft the composer can open. */
export function hasEditableDraft(message: InspectableMessage): boolean {
	return getDraftIdFromMessage(message) !== null;
}
