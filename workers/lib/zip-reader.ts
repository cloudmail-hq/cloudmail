// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Read a zip archive by byte range, for importing a zip of `.eml` files.
 *
 * The archive sits in R2 and may be far larger than a Worker can hold, so
 * nothing here loads it whole: the central directory is found from the end of
 * the file, and each entry is fetched with one range read and inflated on its
 * own. Entry index is the resume cursor.
 *
 * Supports STORED and DEFLATE (via `DecompressionStream("deflate-raw")`),
 * Zip64 sizes and offsets, and refuses encrypted entries. Decompression stops
 * at `maxBytes`, so a zip bomb costs one capped buffer, not the isolate.
 */

/** Fetch `length` bytes at `offset`. */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

export interface ZipEntry {
	name: string;
	method: number;
	flags: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
	isDirectory: boolean;
}

export class ZipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ZipError";
	}
}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** EOCD (22) plus the longest comment (65535). */
const TAIL_BYTES = 22 + 0xffff;
/** Largest central directory read; ~200k entries. */
export const MAX_CENTRAL_DIRECTORY_BYTES = 32 * 1024 * 1024;

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
/** Little-endian 64-bit as a Number; exact below 2^53. */
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 0x1_0000_0000;

/**
 * Every entry in the archive, in central-directory order.
 */
export async function readZipDirectory(read: RangeReader, size: number): Promise<ZipEntry[]> {
	if (size < 22) throw new ZipError("That file is not a zip archive.");
	const tailLen = Math.min(size, TAIL_BYTES);
	const tailStart = size - tailLen;
	const tail = await read(tailStart, tailLen);
	let eocd = -1;
	for (let i = tail.length - 22; i >= 0; i--) {
		if (u32(tail, i) === EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd === -1) throw new ZipError("That file is not a zip archive.");

	let count = u16(tail, eocd + 10);
	let cdSize = u32(tail, eocd + 12);
	let cdOffset = u32(tail, eocd + 16);

	// Zip64: the EOCD fields are saturated and a locator sits just before it.
	if ((count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) && eocd >= 20) {
		const loc = eocd - 20;
		if (u32(tail, loc) === EOCD64_LOCATOR_SIG) {
			const eocd64Offset = u64(tail, loc + 8);
			const rec = await read(eocd64Offset, 56);
			if (u32(rec, 0) !== EOCD64_SIG) throw new ZipError("The zip archive's Zip64 directory is damaged.");
			count = u64(rec, 32);
			cdSize = u64(rec, 40);
			cdOffset = u64(rec, 48);
		}
	}
	if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES) throw new ZipError("That zip archive lists too many files.");
	if (cdOffset + cdSize > size) throw new ZipError("The zip archive's directory is damaged.");

	const cd = await read(cdOffset, cdSize);
	const entries: ZipEntry[] = [];
	let p = 0;
	const decoder = new TextDecoder("utf-8", { fatal: false });
	const cp437 = new TextDecoder("latin1");
	for (let n = 0; n < count && p + 46 <= cd.length; n++) {
		if (u32(cd, p) !== CENTRAL_SIG) throw new ZipError("The zip archive's directory is damaged.");
		const flags = u16(cd, p + 8);
		const method = u16(cd, p + 10);
		let compressedSize = u32(cd, p + 20);
		let uncompressedSize = u32(cd, p + 24);
		const nameLen = u16(cd, p + 28);
		const extraLen = u16(cd, p + 30);
		const commentLen = u16(cd, p + 32);
		let localHeaderOffset = u32(cd, p + 42);
		const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
		// Bit 11: the name is UTF-8. Otherwise CP437, read as latin1 (close enough for a filename).
		const name = (flags & 0x0800 ? decoder : cp437).decode(nameBytes);

		// Zip64 extended information: present fields follow in a fixed order.
		let e = p + 46 + nameLen;
		const extraEnd = e + extraLen;
		while (e + 4 <= extraEnd) {
			const id = u16(cd, e);
			const len = u16(cd, e + 2);
			if (id === 0x0001) {
				let q = e + 4;
				if (uncompressedSize === 0xffffffff) {
					uncompressedSize = u64(cd, q);
					q += 8;
				}
				if (compressedSize === 0xffffffff) {
					compressedSize = u64(cd, q);
					q += 8;
				}
				if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(cd, q);
			}
			e += 4 + len;
		}

		entries.push({
			name,
			method,
			flags,
			compressedSize,
			uncompressedSize,
			localHeaderOffset,
			isDirectory: name.endsWith("/"),
		});
		p += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

/**
 * One entry's bytes. Throws `ZipError` for encrypted entries, unsupported
 * methods, and output past `maxBytes`.
 */
export async function readZipEntry(read: RangeReader, entry: ZipEntry, maxBytes: number): Promise<Uint8Array> {
	if (entry.flags & 0x0001) throw new ZipError(`${entry.name} is encrypted.`);
	if (entry.method !== 0 && entry.method !== 8) throw new ZipError(`${entry.name} uses an unsupported compression method.`);
	if (entry.uncompressedSize > maxBytes) throw new ZipError(`${entry.name} is too large to import.`);

	const header = await read(entry.localHeaderOffset, 30);
	if (u32(header, 0) !== LOCAL_SIG) throw new ZipError(`${entry.name}: damaged entry.`);
	const dataStart = entry.localHeaderOffset + 30 + u16(header, 26) + u16(header, 28);
	const data = entry.compressedSize > 0 ? await read(dataStart, entry.compressedSize) : new Uint8Array(0);
	if (entry.method === 0) return data;
	return inflateRaw(data, maxBytes, entry.name);
}

async function inflateRaw(data: Uint8Array, maxBytes: number, name: string): Promise<Uint8Array> {
	const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new ZipError(`${name} is too large to import.`);
			}
			chunks.push(value);
		}
	} catch (e) {
		if (e instanceof ZipError) throw e;
		throw new ZipError(`${name}: could not decompress (${(e as Error).message}).`);
	}
	const out = new Uint8Array(total);
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.byteLength;
	}
	return out;
}

/** Entries an import reads: `.eml` files, skipping directories and macOS resource forks. */
export function isEmlEntry(entry: ZipEntry): boolean {
	if (entry.isDirectory) return false;
	const lower = entry.name.toLowerCase();
	if (lower.startsWith("__macosx/") || lower.split("/").pop()!.startsWith("._")) return false;
	return lower.endsWith(".eml");
}

/** Whether the archive holds an mbox (Google Takeout ships one inside its zip). */
export function isMboxEntry(entry: ZipEntry): boolean {
	return !entry.isDirectory && entry.name.toLowerCase().endsWith(".mbox");
}
