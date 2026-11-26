/**
 * Files the demo makes in the page: attachments to download or preview, and
 * the drawn faces beside senders.
 *
 * The recorded data lists each attachment's name, type and size but not its
 * bytes, so a small real file of the right type is built on first use (the
 * same stand-ins the local seed writes, see scripts/demo/seed-demo.mjs).
 * Files a visitor attaches to a draft are kept here too, in memory.
 */

import { createAvatar } from "@dicebear/core";
import * as lorelei from "@dicebear/lorelei";
import { crc32Update } from "../../shared/zip";

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

function seeded(name: string): () => number {
	let seed = [...name].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
	return () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
}

/** A soft two-tone picture, the same every time for the same name, as a PNG. */
export function makePng(name: string, w = 480, h = 320): Uint8Array {
	const rnd = seeded(name);
	const base = [200 + rnd() * 40, 190 + rnd() * 50, 170 + rnd() * 60];
	const accent = [60 + rnd() * 80, 80 + rnd() * 60, 120 + rnd() * 80];
	const cx = w * (0.3 + rnd() * 0.4);
	const cy = h * (0.35 + rnd() * 0.3);
	const r = Math.min(w, h) * (0.22 + rnd() * 0.1);
	const stride = w * 3 + 1;
	const raw = new Uint8Array(stride * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const t = y / h;
			let px = base.map((v) => v * (1 - 0.18 * t));
			const dist = Math.hypot(x - cx, y - cy);
			if (dist < r) px = accent.map((v, i) => v * 0.85 + px[i] * 0.15);
			else if (dist < r + 10) px = px.map((v) => v * 0.92);
			if (y > h * 0.8) px = px.map((v) => v * 0.9);
			const o = y * stride + 1 + x * 3;
			raw[o] = px[0];
			raw[o + 1] = px[1];
			raw[o + 2] = px[2];
		}
	}
	const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
	const chunk = (type: string, data: Uint8Array) => {
		const body = concat([encoder.encode(type), data]);
		return concat([u32(data.length), body, u32(crc32Update(0, body))]);
	};
	// zlib stream of stored (uncompressed) blocks: no compressor needed.
	const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
	for (let at = 0; at < raw.length; at += 0xffff) {
		const len = Math.min(0xffff, raw.length - at);
		blocks.push(new Uint8Array([at + len >= raw.length ? 1 : 0, len & 255, len >>> 8, ~len & 255, (~len >>> 8) & 255]));
		blocks.push(raw.subarray(at, at + len));
	}
	let a = 1;
	let b = 0;
	for (let i = 0; i < raw.length; i++) {
		a = (a + raw[i]) % 65521;
		b = (b + a) % 65521;
	}
	blocks.push(u32(((b << 16) | a) >>> 0));
	const ihdr = concat([u32(w), u32(h), new Uint8Array([8, 2, 0, 0, 0])]);
	return concat([
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", concat(blocks)),
		chunk("IEND", new Uint8Array(0)),
	]);
}

/** A one-page PDF with a title line. */
export function makePdf(title: string): Uint8Array {
	const text = title.replace(/[()\\]/g, "").replace(/[^\x20-\x7e]/g, " ");
	const content = `BT /F1 20 Tf 72 720 Td (${text}) Tj ET\nBT /F1 11 Tf 72 694 Td (Sample file from the cloudmail demo.) Tj ET`;
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return encoder.encode(out);
}

export function makeCsv(name: string): Uint8Array {
	if (name.includes("nps")) {
		const rows = ["respondent,company,score,comment"];
		const cos = ["Brightcup Roasters", "Café Lumen", "Morning Owl", "Tidewater Coffee", "Salt & Crumb", "Lantern Stays", "Moretti Café"];
		const comments = ["Fast technician visit", "Great descaling guide", "Delivery window too wide", "Love the S2", ""];
		for (let i = 0; i < 60; i++) rows.push(`${1000 + i},${cos[i % cos.length]},${[10, 9, 9, 8, 10, 7, 6, 9, 10, 4][i % 10]},"${comments[i % 5]}"`);
		return encoder.encode(rows.join("\n"));
	}
	const rows = ["sensor_id,reference_bar,measured_bar,delta"];
	for (let i = 0; i < 200; i++) {
		const d = ((i * 37) % 9) / 100 - 0.04;
		rows.push(`PS-11-${String(i).padStart(3, "0")},9.00,${(9 + d).toFixed(3)},${d.toFixed(3)}`);
	}
	return encoder.encode(rows.join("\n"));
}

/** A ZIP archive of stored entries, enough for a small Office file. */
export function zipStore(files: { name: string; text: string }[]): Uint8Array {
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const f of files) {
		const name = encoder.encode(f.name);
		const data = encoder.encode(f.text);
		const crc = crc32Update(0, data);
		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(12, 0x21, true); // 1980-01-01
		lv.setUint32(14, crc, true);
		lv.setUint32(18, data.length, true);
		lv.setUint32(22, data.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		const dir = new Uint8Array(46 + name.length);
		const dv = new DataView(dir.buffer);
		dv.setUint32(0, 0x02014b50, true);
		dv.setUint16(4, 20, true);
		dv.setUint16(6, 20, true);
		dv.setUint16(14, 0x21, true);
		dv.setUint32(16, crc, true);
		dv.setUint32(20, data.length, true);
		dv.setUint32(24, data.length, true);
		dv.setUint16(28, name.length, true);
		dv.setUint32(42, offset, true);
		dir.set(name, 46);
		parts.push(local, data);
		central.push(dir);
		offset += local.length + data.length;
	}
	const cd = concat(central);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, files.length, true);
	ev.setUint16(10, files.length, true);
	ev.setUint32(12, cd.length, true);
	ev.setUint32(16, offset, true);
	return concat([...parts, cd, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const RELS = (target: string, type: string) =>
	`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`;

export function makeDocx(title: string): Uint8Array {
	const p = (t: string) => `<w:p><w:r><w:t>${esc(t)}</w:t></w:r></w:p>`;
	return zipStore([
		{
			name: "[Content_Types].xml",
			text: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		},
		{ name: "_rels/.rels", text: RELS("word/document.xml", "officeDocument") },
		{
			name: "word/document.xml",
			text: `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p(title)}${p("Sample file from the cloudmail demo.")}</w:body></w:document>`,
		},
	]);
}

export function makeXlsx(title: string): Uint8Array {
	const cell = (ref: string, t: string) => `<c r="${ref}" t="inlineStr"><is><t>${esc(t)}</t></is></c>`;
	return zipStore([
		{
			name: "[Content_Types].xml",
			text: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
		},
		{ name: "_rels/.rels", text: RELS("xl/workbook.xml", "officeDocument") },
		{
			name: "xl/workbook.xml",
			text: `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		},
		{ name: "xl/_rels/workbook.xml.rels", text: RELS("worksheets/sheet1.xml", "worksheet") },
		{
			name: "xl/worksheets/sheet1.xml",
			text: `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${cell("A1", title)}</row><row r="2">${cell("A2", "Sample file from the cloudmail demo.")}</row></sheetData></worksheet>`,
		},
	]);
}

/** Bytes for a recorded attachment, by its type. */
export function makeFile(filename: string, mimetype: string): Uint8Array {
	const title = filename.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ");
	if (mimetype === "application/pdf") return makePdf(title);
	if (mimetype.startsWith("image/")) return makePng(filename);
	if (mimetype === "text/csv") return makeCsv(filename);
	if (mimetype.includes("spreadsheetml")) return makeXlsx(title);
	if (mimetype.includes("wordprocessingml")) return makeDocx(title);
	return encoder.encode(`${title}\n\nSample file from the cloudmail demo.\n`);
}

/** Attachment bytes by id, and the `blob:` URL each is served from. */
export class DemoFiles {
	private blobs = new Map<string, Blob>();
	private urls = new Map<string, string>();
	private byUrl = new Map<string, Blob>();
	private faces = new Map<string, string>();

	/** Keep bytes a visitor attached to a draft. */
	put(id: string, bytes: Uint8Array, mimetype: string): void {
		this.blobs.set(id, new Blob([bytes as BlobPart], { type: mimetype || "application/octet-stream" }));
	}

	blob(attachment: { id: string; filename: string; mimetype: string }): Blob {
		let blob = this.blobs.get(attachment.id);
		if (!blob) {
			const type = attachment.mimetype || "application/octet-stream";
			blob = new Blob([makeFile(attachment.filename, type) as BlobPart], { type });
			this.blobs.set(attachment.id, blob);
		}
		return blob;
	}

	url(attachment: { id: string; filename: string; mimetype: string }): string {
		let url = this.urls.get(attachment.id);
		if (!url) {
			const blob = this.blob(attachment);
			url = URL.createObjectURL(blob);
			this.urls.set(attachment.id, url);
			this.byUrl.set(url, blob);
		}
		return url;
	}

	/** The file behind one of our `blob:` URLs, so `fetch(url)` needs no network rule. */
	fromUrl(url: string): Blob | undefined {
		return this.byUrl.get(url);
	}

	/** A drawn face as a `data:` URL: the same one every time for an address. */
	face(address: string): string {
		const key = address.trim().toLowerCase();
		let url = this.faces.get(key);
		if (!url) {
			// A plain hash, not the address, is the seed, as on a real deployment.
			let h = 0x811c9dc5;
			for (const ch of `sender-picture:${key}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
			const seed = h.toString(16).padStart(8, "0");
			const svg = createAvatar(lorelei, {
				seed,
				size: 96,
				backgroundColor: [FACE_BACKGROUNDS[h % FACE_BACKGROUNDS.length]],
			})
				.toString()
				.replace(/<metadata[\s\S]*?<\/metadata>/, "");
			url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
			this.faces.set(key, url);
		}
		return url;
	}
}

const FACE_BACKGROUNDS = ["b6e3f4", "c0aede", "d1d4f9", "ffd5dc", "ffdfbf", "bbf7d0", "fde68a", "a5f3fc"];
