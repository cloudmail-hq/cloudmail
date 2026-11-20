// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The production IMAP transport: a Workers `connect()` socket, TLS from the
 * first byte (implicit TLS on 993, never STARTTLS), with a connect timeout.
 *
 * The host is re-validated here as well as at job creation, so nothing that
 * reaches this function can aim the socket at a private or metadata address
 * by name. (DNS that resolves a public name to a private address is outside
 * what a Worker can see; Cloudflare's egress does not reach private networks.)
 */

import { connect } from "cloudflare:sockets";
import { IMAP_PORT, validateImapHost } from "../../shared/mail-import";
import { ImapError, type ImapTransport } from "./imap";

export const IMAP_CONNECT_TIMEOUT_MS = 15_000;

export async function connectImap(host: string): Promise<ImapTransport> {
	const check = validateImapHost(host);
	if (!check.ok) throw new ImapError(check.error, "protocol");
	const socket = connect({ hostname: check.host, port: IMAP_PORT }, { secureTransport: "on", allowHalfOpen: false });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			socket.opened,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new ImapError(`Could not connect to ${check.host}:${IMAP_PORT}.`, "timeout")),
					IMAP_CONNECT_TIMEOUT_MS,
				);
			}),
		]);
	} catch (e) {
		socket.close().catch(() => {});
		if (e instanceof ImapError) throw e;
		throw new ImapError(`Could not connect to ${check.host}:${IMAP_PORT} over TLS: ${(e as Error).message}`, "closed");
	} finally {
		clearTimeout(timer);
	}

	const reader = socket.readable.getReader();
	const writer = socket.writable.getWriter();
	return {
		async read() {
			const { done, value } = await reader.read();
			return done ? null : (value as Uint8Array);
		},
		async write(bytes) {
			await writer.write(bytes);
		},
		async close() {
			try {
				reader.releaseLock();
				writer.releaseLock();
			} catch {
				// Already released.
			}
			await socket.close().catch(() => {});
		},
	};
}
