// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The stored shape of reader warnings, and how to read it back.
 *
 * Separate from `./sender-warnings.ts` so the client bundle can display stored
 * warnings without importing the detector, which carries the public-suffix
 * list.
 */

export type SenderWarningKind =
	| "display_name_spoof"
	| "lookalike_domain"
	| "first_time_sender"
	| "link_mismatch";

export interface SenderWarning {
	kind: SenderWarningKind;
	/** One sentence for the reader. */
	message: string;
	/** Machine-readable specifics for agents and for tests. */
	detail?: Record<string, string>;
}

const KINDS = new Set<SenderWarningKind>([
	"display_name_spoof",
	"lookalike_domain",
	"first_time_sender",
	"link_mismatch",
]);

/** Warnings worth an icon in the message list. First contact alone is not. */
export function isSeriousWarning(kind: SenderWarningKind): boolean {
	return kind !== "first_time_sender";
}

export function serializeSenderWarnings(warnings: SenderWarning[]): string | null {
	return warnings.length > 0 ? JSON.stringify(warnings) : null;
}

/** Read back what `serializeSenderWarnings` stored. Tolerates anything else. */
export function parseSenderWarnings(stored: string | null | undefined): SenderWarning[] {
	if (!stored) return [];
	try {
		const parsed = JSON.parse(stored);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(w): w is SenderWarning =>
					!!w &&
					typeof w === "object" &&
					KINDS.has(w.kind) &&
					typeof w.message === "string",
			)
			.map((w) => ({
				kind: w.kind,
				message: w.message,
				...(w.detail && typeof w.detail === "object" ? { detail: w.detail } : {}),
			}));
	} catch {
		return [];
	}
}
