// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The pieces of a ZIP archive with STORED (uncompressed) entries, written in
 * order so an archive can be produced incrementally: local header, data,
 * data descriptor, ..., central directory, end record.
 *
 * Local headers set general-purpose bit 3, so CRC and sizes follow the data in
 * a descriptor and nothing has to be known up front. That is what lets the
 * account export stream a mailbox of any length into R2 across several cron
 * ticks, carrying only the running CRC and byte count between them.
 *
 * Limits: no ZIP64, so each entry and the whole archive must stay under
 * 4 GiB, and at most 65,535 entries. The exporter checks `ZIP_MAX_BYTES`.
 * Names are UTF-8 (bit 11).
 */

export const ZIP_MAX_BYTES = 0xffff_ffff;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

/** Continue a CRC-32 over `bytes`. Start from 0; the result is final as-is. */
export function crc32Update(crc: number, bytes: Uint8Array): number {
	let c = (crc ^ 0xffffffff) >>> 0;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntryRecord {
	name: string;
	crc: number;
	size: number;
	/** Offset of the entry's local header from the start of the archive. */
	offset: number;
}

const FLAGS = 0x0808; // bit 3: data descriptor; bit 11: UTF-8 names
const VERSION = 20;
const encoder = new TextEncoder();

/** MS-DOS date and time for `date` (UTC; ZIP has no zone). */
function dosDateTime(date: Date): { time: number; date: number } {
	const year = Math.max(1980, date.getUTCFullYear());
	return {
		time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
		date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
	};
}

export function zipLocalHeader(name: string, modified: Date): Uint8Array {
	const nameBytes = encoder.encode(name);
	const out = new Uint8Array(30 + nameBytes.length);
	const v = new DataView(out.buffer);
	const dt = dosDateTime(modified);
	v.setUint32(0, 0x04034b50, true);
	v.setUint16(4, VERSION, true);
	v.setUint16(6, FLAGS, true);
	v.setUint16(8, 0, true); // stored
	v.setUint16(10, dt.time, true);
	v.setUint16(12, dt.date, true);
	// CRC and sizes are zero here; the descriptor carries them.
	v.setUint16(26, nameBytes.length, true);
	out.set(nameBytes, 30);
	return out;
}

export function zipDataDescriptor(crc: number, size: number): Uint8Array {
	const out = new Uint8Array(16);
	const v = new DataView(out.buffer);
	v.setUint32(0, 0x08074b50, true);
	v.setUint32(4, crc >>> 0, true);
	v.setUint32(8, size, true);
	v.setUint32(12, size, true);
	return out;
}

/** Central directory plus end record, for an archive whose entries end at `cdOffset`. */
export function zipCentralDirectory(entries: ZipEntryRecord[], cdOffset: number, modified: Date): Uint8Array {
	const dt = dosDateTime(modified);
	const records = entries.map((entry) => {
		const nameBytes = encoder.encode(entry.name);
		const out = new Uint8Array(46 + nameBytes.length);
		const v = new DataView(out.buffer);
		v.setUint32(0, 0x02014b50, true);
		v.setUint16(4, VERSION, true);
		v.setUint16(6, VERSION, true);
		v.setUint16(8, FLAGS, true);
		v.setUint16(10, 0, true);
		v.setUint16(12, dt.time, true);
		v.setUint16(14, dt.date, true);
		v.setUint32(16, entry.crc >>> 0, true);
		v.setUint32(20, entry.size, true);
		v.setUint32(24, entry.size, true);
		v.setUint16(28, nameBytes.length, true);
		v.setUint32(42, entry.offset, true);
		out.set(nameBytes, 46);
		return out;
	});
	const cdSize = records.reduce((n, r) => n + r.length, 0);
	const end = new Uint8Array(22);
	const v = new DataView(end.buffer);
	v.setUint32(0, 0x06054b50, true);
	v.setUint16(8, entries.length, true);
	v.setUint16(10, entries.length, true);
	v.setUint32(12, cdSize, true);
	v.setUint32(16, cdOffset, true);
	return concatBytes([...records, end]);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** A filename that is safe inside an archive: no separators, no traversal. */
export function zipSafeName(name: string): string {
	const cleaned = name.replace(/[^\w.@+-]+/g, "_").replace(/^\.+/, "_");
	return cleaned.slice(0, 200) || "file";
}
