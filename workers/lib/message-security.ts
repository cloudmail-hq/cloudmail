// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Security fields added to messages on the way out of the read endpoints.
 *
 * - `warnings`: the stored reader warnings, parsed, so API and MCP clients get
 *   an array rather than a JSON string. Always present on received mail.
 * - `image_proxy`: raw `<img src>` → signed `/img/` path for every remote image
 *   in the body, which the reading pane substitutes once the reader allows
 *   images. Signed here because only the Worker holds the secret.
 */

import { Folders } from "../../shared/folders";
import { buildImageProxyMap } from "../../shared/image-proxy";
import { sameOrganization } from "../../shared/domain-safety";
import { parseSenderWarnings, type SenderWarning } from "../../shared/sender-warning-types";
import { getImageProxySecret } from "./image-proxy";
import type { Env } from "../types";

const OUTBOUND = new Set<string>([Folders.SENT, Folders.DRAFT, Folders.SCHEDULED]);

interface MessageLike {
	body?: string | null;
	folder_id?: string | null;
	security_warnings?: string | null;
}

const domainOf = (address: unknown) =>
	typeof address === "string" && address.includes("@") ? address.slice(address.lastIndexOf("@") + 1) : "";

/**
 * A display-name warning stored before same-organisation senders were
 * exempt (shared/sender-warnings.ts). Warnings are computed at delivery, so
 * mail already in the box keeps the old verdict unless it is dropped here.
 */
function isSameOrgNameWarning(w: SenderWarning): boolean {
	if (w.kind !== "display_name_spoof") return false;
	const usual = domainOf(w.detail?.usual);
	const actual = domainOf(w.detail?.actual);
	return !!usual && !!actual && sameOrganization(usual, actual);
}

/** The parsed warnings, or [] for our own mail. */
export function warningsFor(row: MessageLike): SenderWarning[] {
	if (row.folder_id && OUTBOUND.has(row.folder_id)) return [];
	return parseSenderWarnings(row.security_warnings).filter((w) => !isSameOrgNameWarning(w));
}

/** Add `warnings` and `image_proxy` to each message. Never throws. */
export async function withMessageSecurity<T extends MessageLike>(
	env: Env,
	rows: T[],
): Promise<(T & { warnings: SenderWarning[]; image_proxy: Record<string, string> })[]> {
	let secret: string | null = null;
	try {
		if (rows.some((r) => r.body && /<img\b/i.test(r.body))) secret = await getImageProxySecret(env);
	} catch (e) {
		// No secret means no proxy URLs; the reader then keeps images blocked.
		console.error("Image proxy secret unavailable:", (e as Error).message);
	}
	return Promise.all(
		rows.map(async (row) => ({
			...row,
			warnings: warningsFor(row),
			image_proxy: secret ? await buildImageProxyMap(secret, row.body).catch(() => ({})) : {},
		})),
	);
}
