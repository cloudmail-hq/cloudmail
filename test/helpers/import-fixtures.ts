// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Synthetic mail for the import tests: RFC 5322 messages, mbox files, zip
 * archives (STORED and DEFLATE) and an in-memory R2 bucket. No real mail.
 */

import { deflateRawSync } from "node:zlib";
import { crc32Update } from "../../shared/zip";

const enc = new TextEncoder();

export interface SyntheticMessage {
	from?: string;
	to?: string;
	subject?: string;
	date?: string;
	messageId?: string | null;
	inReplyTo?: string;
	references?: string;
	gmailLabels?: string;
	body?: string;
	extraHeaders?: string[];
	attachment?: { filename: string; content: string; type?: string };
	eol?: "\n" | "\r\n";
}

/** One RFC 5322 message. */
export function message(m: SyntheticMessage = {}): string {
	const eol = m.eol ?? "\n";
	const h: string[] = [
		`From: ${m.from ?? "Alice Example <alice@example.com>"}`,
		`To: ${m.to ?? "me@example.com"}`,
		`Subject: ${m.subject ?? "Hello"}`,
		`Date: ${m.date ?? "Tue, 14 Jan 2014 10:00:00 +0000"}`,
	];
	if (m.messageId !== null) h.push(`Message-ID: <${m.messageId ?? `${Math.random().toString(36).slice(2)}@example.com`}>`);
	if (m.inReplyTo) h.push(`In-Reply-To: <${m.inReplyTo}>`);
	if (m.references) h.push(`References: ${m.references}`);
	if (m.gmailLabels !== undefined) h.push(`X-Gmail-Labels: ${m.gmailLabels}`);
	h.push(...(m.extraHeaders ?? []));
	h.push("MIME-Version: 1.0");
	if (m.attachment) {
		const b = "BOUNDARY42";
		h.push(`Content-Type: multipart/mixed; boundary="${b}"`);
		return [
			...h,
			"",
			`--${b}`,
			"Content-Type: text/plain; charset=utf-8",
			"",
			m.body ?? "Body text.",
			`--${b}`,
			`Content-Type: ${m.attachment.type ?? "application/octet-stream"}; name="${m.attachment.filename}"`,
			`Content-Disposition: attachment; filename="${m.attachment.filename}"`,
			"Content-Transfer-Encoding: base64",
			"",
			Buffer.from(m.attachment.content).toString("base64"),
			`--${b}--`,
			"",
		].join(eol);
	}
	h.push("Content-Type: text/plain; charset=utf-8");
	return [...h, "", m.body ?? "Body text.", ""].join(eol);
}

/** An mbox (mboxrd quoting) of the given messages. */
export function mbox(messages: string[], opts: { eol?: "\n" | "\r\n"; trailingNewline?: boolean } = {}): string {
	const eol = opts.eol ?? "\n";
	const parts = messages.map((raw, i) => {
		const quoted = raw.replace(/^(>*From )/gm, ">$1");
		return `From sender${i}@example.com Tue Jan 14 10:00:00 2014${eol}${quoted}`;
	});
	let out = parts.map((p) => (p.endsWith(eol) ? p : p + eol)).join(eol);
	if (opts.trailingNewline === false) out = out.replace(/(\r?\n)+$/, "");
	return out;
}

/** A zip archive. `deflate` compresses entries; names are UTF-8. */
export function zip(entries: { name: string; data: string | Uint8Array }[], opts: { deflate?: boolean } = {}): Uint8Array {
	const chunks: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = enc.encode(e.name);
		const raw = typeof e.data === "string" ? enc.encode(e.data) : e.data;
		const data = opts.deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
		const crc = (crc32Update(0xffffffff, raw) ^ 0xffffffff) >>> 0;
		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(6, 0x0800, true);
		lv.setUint16(8, opts.deflate ? 8 : 0, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, data.length, true);
		lv.setUint32(22, raw.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		const cd = new Uint8Array(46 + name.length);
		const cv = new DataView(cd.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, opts.deflate ? 8 : 0, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, data.length, true);
		cv.setUint32(24, raw.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		cd.set(name, 46);
		chunks.push(local, data);
		central.push(cd);
		offset += local.length + data.length;
	}
	const cdSize = central.reduce((n, c) => n + c.length, 0);
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, offset, true);
	const all = [...chunks, ...central, eocd];
	const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
	let o = 0;
	for (const c of all) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}

/** In-memory R2 with range reads and a call log. */
export function memoryBucket() {
	const objects = new Map<string, Uint8Array>();
	const reads: { key: string; offset?: number; length?: number }[] = [];
	return {
		objects,
		reads,
		async get(key: string, options?: { range?: { offset: number; length: number } }) {
			const data = objects.get(key);
			if (!data) return null;
			reads.push({ key, ...options?.range });
			const slice = options?.range ? data.subarray(options.range.offset, options.range.offset + options.range.length) : data;
			const copy = slice.slice();
			return { arrayBuffer: async () => copy.buffer };
		},
		async put(key: string, value: ArrayBuffer | Uint8Array | string) {
			objects.set(key, typeof value === "string" ? enc.encode(value) : new Uint8Array(value as ArrayBuffer));
		},
		async delete(keys: string | string[]) {
			for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
		},
	};
}

export const bytes = (s: string) => enc.encode(s);
