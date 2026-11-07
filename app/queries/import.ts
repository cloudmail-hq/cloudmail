// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mail import: jobs, the chunked upload and the IMAP form. Server side in
 * `workers/routes/import.ts`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isTerminalImportStatus, type ImportFileSource, type ImportJobView } from "shared/mail-import";
import { ApiError, request } from "~/services/api";

export const importKeys = {
	list: (mailboxId: string) => ["imports", mailboxId] as const,
};

const mb = (id: string) => `/api/v1/mailboxes/${encodeURIComponent(id)}`;

/** Recent imports. Polls every 3 s while any is unfinished. */
export function useImports(mailboxId: string | undefined) {
	return useQuery({
		queryKey: importKeys.list(mailboxId ?? ""),
		queryFn: ({ signal }) => request<{ imports: ImportJobView[] }>(`${mb(mailboxId!)}/imports`, { signal }),
		enabled: !!mailboxId,
		refetchInterval: (q) =>
			q.state.data?.imports.some((j) => !isTerminalImportStatus(j.status) && j.status !== "paused") ? 3000 : false,
	});
}

export function useImportAction(mailboxId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, action }: { id: string; action: "pause" | "resume" | "cancel" }) =>
			request<ImportJobView>(`${mb(mailboxId)}/imports/${encodeURIComponent(id)}/${action}`, { method: "POST" }),
		onSettled: () => qc.invalidateQueries({ queryKey: importKeys.list(mailboxId) }),
	});
}

export function useStartImapImport(mailboxId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { host: string; username: string; password: string }) =>
			request<ImportJobView>(`${mb(mailboxId)}/imports`, {
				method: "POST",
				headers: { "Idempotency-Key": crypto.randomUUID() },
				body: JSON.stringify({ source: "imap", ...input }),
			}),
		onSettled: () => qc.invalidateQueries({ queryKey: importKeys.list(mailboxId) }),
	});
}

/** Which source a filename is. Null when it is not one this importer reads. */
export function sourceForFile(name: string): ImportFileSource | null {
	const lower = name.toLowerCase();
	if (lower.endsWith(".mbox") || lower.endsWith(".mbx") || !lower.includes(".")) return "mbox";
	if (lower.endsWith(".zip")) return "zip";
	if (lower.endsWith(".eml")) return "eml";
	return null;
}

const PART_TIMEOUT_MS = 5 * 60_000;

/**
 * Upload a file in parts, then queue the import. Parts already on the server
 * (a resumed upload of the same job) are skipped. `onProgress` gets bytes sent.
 */
export async function uploadImportFile(
	mailboxId: string,
	file: File,
	opts: {
		folder: "inbox" | "archive";
		onProgress: (sent: number, total: number) => void;
		signal?: AbortSignal;
		/** Resume an earlier job for the same file. */
		resume?: ImportJobView;
	},
): Promise<ImportJobView> {
	const source = sourceForFile(file.name);
	if (!source) throw new Error("Choose an .mbox, .zip or .eml file.");
	const job =
		opts.resume ??
		(await request<ImportJobView>(`${mb(mailboxId)}/imports`, {
			method: "POST",
			headers: { "Idempotency-Key": crypto.randomUUID() },
			body: JSON.stringify({ source, filename: file.name, size_bytes: file.size, folder: opts.folder }),
			signal: opts.signal,
		}));
	const partSize = job.upload!.part_size;
	const total = job.upload!.parts_total;
	let sent = 0;
	for (let n = 1; n <= total; n++) {
		const start = (n - 1) * partSize;
		const blob = file.slice(start, Math.min(file.size, start + partSize));
		// One retry per part: a dropped connection mid-part is the common failure.
		for (let attempt = 0; ; attempt++) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), PART_TIMEOUT_MS);
			const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
			try {
				const res = await fetch(`${mb(mailboxId)}/imports/${encodeURIComponent(job.id)}/parts/${n}`, {
					method: "PUT",
					body: blob,
					headers: { "Content-Type": "application/octet-stream" },
					signal,
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
					throw new ApiError(res.status, body);
				}
				break;
			} catch (e) {
				if (opts.signal?.aborted || attempt >= 2 || (e instanceof ApiError && e.status < 500)) throw e;
			} finally {
				clearTimeout(timer);
			}
		}
		sent += blob.size;
		opts.onProgress(sent, file.size);
	}
	return request<ImportJobView>(`${mb(mailboxId)}/imports/${encodeURIComponent(job.id)}/complete`, {
		method: "POST",
		signal: opts.signal,
	});
}
