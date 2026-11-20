#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Fills a local demo instance with believable, entirely fictional mail.
 * See scripts/demo/README.md for the full recipe. Two phases:
 *
 *   node scripts/demo/seed-demo.mjs api   # dev server running
 *   node scripts/demo/seed-demo.mjs db    # dev server STOPPED
 *
 * `api` goes through the app's own HTTP surface: creates the owner, the
 * mailboxes, labels, templates and sequences, delivers every message through
 * the local inbound-email handler (so parsing, threading, attachments and
 * search indexing are the real code paths), and creates drafts, scheduled
 * sends and a send held for approval.
 *
 * `db` then edits the local Durable Object SQLite files for what has no API
 * because it normally comes from the outside world or a model: which messages
 * were sent by us (they were delivered inbound), read/starred state, AI triage
 * labels, thread summaries, and delivery/open/click events. Never point this
 * at anything but a throwaway local state directory.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { DEMO_BASE_URL, DEMO_OWNER, DEMO_SETUP_TOKEN } from "./demo-constants.mjs";
import * as D from "./demo-data.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const MANIFEST = join(here, ".generated/seed-manifest.json");
const STATE_DIR = process.env.DEMO_STATE_DIR ?? join(root, ".wrangler/demo-state");
const BASE = DEMO_BASE_URL;
const phase = process.argv[2];

// ───────────────────────────────────────────── time

/**
 * The demo's time zone: a whole-hour fixed offset chosen so that "now" is
 * mid-morning, whenever the seed runs. Otherwise today's mail would show
 * times like 2:53 AM. capture.mjs reads it from the manifest.
 */
function demoZone() {
	const now = new Date();
	const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
	let off = Math.round(10.75 - utcH);
	if (off > 12) off -= 24;
	if (off < -11) off += 24;
	return off === 0 ? "Etc/GMT" : off > 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`;
}
const ZONE = phase === "api" ? demoZone() : null;

/** Wall-clock time `t` ("HH:MM") `d` days ago in the demo zone, as a Date. */
function localTime(d, t) {
	const [hh, mm] = t.split(":").map(Number);
	const now = new Date();
	// The calendar date d days ago in the demo time zone.
	const day = new Date(now.getTime() - d * 86400000);
	const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(day);
	// Offset of the zone at that moment (handles DST).
	const probe = new Date(`${ymd}T12:00:00Z`);
	const tzName = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "longOffset" }).formatToParts(probe).find((p) => p.type === "timeZoneName").value;
	const off = tzName.replace("GMT", "") || "+00:00";
	// Seconds vary a little so nothing looks stamped in the same second.
	const ss = String((hh * 7 + mm * 13) % 60).padStart(2, "0");
	return new Date(`${ymd}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${ss}${off}`);
}

function messageDate(m) {
	if (m.ago !== undefined) return new Date(Date.now() - m.ago * 60000 - ((m.ago * 17) % 50) * 1000);
	return localTime(m.at.d, m.at.t);
}

// ───────────────────────────────────────────── HTTP

let cookie = "";
async function api(method, path, body, { token, raw, contentType } = {}) {
	const headers = {};
	if (token) headers.authorization = `Bearer ${token}`;
	else if (cookie) headers.cookie = cookie;
	let payload;
	if (raw !== undefined) {
		payload = raw;
		headers["content-type"] = contentType ?? "message/rfc822";
	} else if (body !== undefined) {
		payload = JSON.stringify(body);
		headers["content-type"] = "application/json";
	}
	const res = await fetch(BASE + path, { method, headers, body: payload, redirect: "manual" });
	const set = res.headers.getSetCookie?.() ?? [];
	if (set.length && !token) {
		const jar = new Map(cookie.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c]));
		for (const c of set) {
			const kv = c.split(";")[0];
			jar.set(kv.split("=")[0], kv);
		}
		cookie = [...jar.values()].join("; ");
	}
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {}
	if (!res.ok && res.status !== 409) {
		throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
	}
	return { status: res.status, json, text };
}

// ───────────────────────────────────────────── attachments

function crc32(buf) {
	let c, crc = 0xffffffff;
	for (let n = 0; n < buf.length; n++) {
		c = (crc ^ buf[n]) & 0xff;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crc = (crc >>> 8) ^ c;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** A soft two-tone illustration (deterministic per name) as a real PNG. */
function makePng(name, w = 640, h = 420) {
	let seed = [...name].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
	const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
	const base = [200 + rnd() * 40, 190 + rnd() * 50, 170 + rnd() * 60];
	const accent = [60 + rnd() * 80, 80 + rnd() * 60, 120 + rnd() * 80];
	const cx = w * (0.3 + rnd() * 0.4), cy = h * (0.35 + rnd() * 0.3), r = Math.min(w, h) * (0.22 + rnd() * 0.1);
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 3 + 1)] = 0;
		for (let x = 0; x < w; x++) {
			const t = y / h;
			let px = base.map((v) => v * (1 - 0.18 * t));
			const dist = Math.hypot(x - cx, y - cy);
			if (dist < r) px = accent.map((v, i) => v * 0.85 + px[i] * 0.15);
			else if (dist < r + 10) px = px.map((v) => v * 0.92);
			if (y > h * 0.8) px = px.map((v) => v * 0.9);
			const o = y * (w * 3 + 1) + 1 + x * 3;
			raw[o] = px[0];
			raw[o + 1] = px[1];
			raw[o + 2] = px[2];
		}
	}
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(td));
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** A one-page PDF with a title line, padded to roughly `kb` kilobytes. */
function makePdf(title, kb = 60) {
	const text = title.replace(/[()\\]/g, "");
	const content = `BT /F1 20 Tf 72 720 Td (${text}) Tj ET`;
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets = [];
	objs.forEach((o, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	const pad = Math.max(0, kb * 1024 - out.length);
	return Buffer.concat([Buffer.from(out), Buffer.from(`%${"0".repeat(78)}\n`.repeat(Math.ceil(pad / 80)))]);
}

function makeCsv(name) {
	if (name.includes("nps")) {
		const rows = ["respondent,company,score,comment"];
		const cos = ["Brightcup Roasters", "Café Lumen", "Morning Owl", "Tidewater Coffee", "Salt & Crumb", "Lantern Stays", "Moretti Café"];
		for (let i = 0; i < 60; i++) rows.push(`${1000 + i},${cos[i % cos.length]},${[10, 9, 9, 8, 10, 7, 6, 9, 10, 4][i % 10]},"${["Fast technician visit", "Great descaling guide", "Delivery window too wide", "Love the S2", ""][i % 5]}"`);
		return Buffer.from(rows.join("\n"));
	}
	const rows = ["sensor_id,reference_bar,measured_bar,delta"];
	for (let i = 0; i < 200; i++) {
		const d = ((i * 37) % 9) / 100 - 0.04;
		rows.push(`PS-11-${String(i).padStart(3, "0")},9.00,${(9 + d).toFixed(3)},${d.toFixed(3)}`);
	}
	return Buffer.from(rows.join("\n"));
}

const MIME = {
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/png",
	csv: "text/csv",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function makeAttachment(a) {
	let data;
	// The local inbound handler caps a message at 1 MiB, so big files are
	// truncated here and their listed size is set in the `db` phase.
	if (a.kind === "pdf") data = makePdf(a.name.replace(/\.pdf$/, "").replace(/-/g, " "), Math.min(a.kb ?? 60, 200));
	else if (a.kind === "png" || a.kind === "jpg") data = makePng(a.name);
	else if (a.kind === "csv") data = makeCsv(a.name);
	else {
		// Office files: a zip local-file header then filler, so the size is plausible.
		data = Buffer.alloc(Math.min(a.kb ?? 40, 200) * 1024);
		data.write("PK\u0003\u0004", 0, "binary");
		for (let i = 4; i < data.length; i++) data[i] = (i * 2654435761) >>> 24;
	}
	return { filename: a.name, mime: MIME[a.kind] ?? "application/octet-stream", data };
}

// ───────────────────────────────────────────── RFC 822

const fmt = (p) => (p.name ? `"${p.name.replace(/"/g, "")}" <${p.email}>` : `<${p.email}>`);
const domainOf = (e) => e.split("@")[1];
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);
const wrap76 = (b64) => b64.replace(/.{76}/g, "$&\r\n");
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function toHtml(text) {
	return text
		.split(/\n{2,}/)
		.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
		.join("\n");
}

function buildRaw({ from, to, cc, subject, date, messageId, inReplyTo, references, text, attachments }) {
	const b = (n) => `----=_demo_${n}_${messageId.replace(/\W/g, "").slice(0, 16)}`;
	const outer = b("mixed"), alt = b("alt");
	const h = [
		`From: ${fmt(from)}`,
		`To: ${to.map(fmt).join(", ")}`,
		...(cc?.length ? [`Cc: ${cc.map(fmt).join(", ")}`] : []),
		`Subject: ${encodeHeader(subject)}`,
		`Date: ${date.toUTCString().replace("GMT", "+0000")}`,
		`Message-ID: ${messageId}`,
		...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${references.join(" ")}`] : []),
		`MIME-Version: 1.0`,
		`Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${domainOf(from.email)} header.s=mail; spf=pass smtp.mailfrom=${from.email}; dmarc=pass header.from=${domainOf(from.email)}`,
		`Content-Type: multipart/mixed; boundary="${outer}"`,
	];
	const parts = [];
	parts.push(
		`--${outer}\r\nContent-Type: multipart/alternative; boundary="${alt}"\r\n\r\n` +
			`--${alt}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(Buffer.from(text).toString("base64"))}\r\n` +
			`--${alt}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(Buffer.from(`<div>${toHtml(text)}</div>`).toString("base64"))}\r\n` +
			`--${alt}--\r\n`,
	);
	for (const a of attachments ?? []) {
		parts.push(
			`--${outer}\r\nContent-Type: ${a.mime}; name="${a.filename}"\r\nContent-Disposition: attachment; filename="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(a.data.toString("base64"))}\r\n`,
		);
	}
	return `${h.join("\r\n")}\r\n\r\n${parts.join("")}--${outer}--\r\n`;
}

// ───────────────────────────────────────────── phase: api

async function phaseApi() {
	const state = (await api("GET", "/api/auth/state")).json;
	if (state.setupRequired) {
		await api("POST", "/api/auth/setup", {
			setupToken: DEMO_SETUP_TOKEN,
			name: DEMO_OWNER.name,
			email: DEMO_OWNER.email,
			password: DEMO_OWNER.password,
			trackingDefault: true,
		});
		console.log("owner created");
	} else {
		await api("POST", "/api/auth/login", { email: DEMO_OWNER.email, password: DEMO_OWNER.password });
		console.log("signed in");
	}

	// Mailboxes. Auto-draft and triage stay off while mail is delivered, so the
	// offline model stand-in does not write drafts or labels of its own.
	for (const mb of D.MAILBOXES) {
		const settings = {
			fromName: mb.name,
			autoDraft: { enabled: false },
			triage: { enabled: false },
			signature: { enabled: true, text: mb.signature, html: toHtml(mb.signature) },
		};
		const r = await api("POST", "/api/v1/mailboxes", { email: mb.email, name: mb.name, settings });
		console.log(`mailbox ${mb.email}: ${r.status}`);
	}

	// Labels: user labels per mailbox, then the AI triage presets.
	for (const mb of D.MAILBOXES) {
		const names = [...new Set(D.THREADS.filter((t) => t.mailbox === mb.email).flatMap((t) => t.labels ?? []))];
		for (const [i, name] of names.entries()) {
			await api("POST", `/api/v1/mailboxes/${encodeURIComponent(mb.email)}/labels`, { name, color: D.LABEL_COLORS[name], sort_order: i });
		}
		for (const key of D.TRIAGE_PRESETS_ON[mb.email] ?? D.TRIAGE_PRESETS_ON.default) {
			await api("PUT", `/api/v1/mailboxes/${encodeURIComponent(mb.email)}/triage/presets/${key}`, { enabled: true });
		}
	}

	// Custom folders.
	for (const [mailbox, names] of Object.entries(D.FOLDERS ?? {})) {
		for (const name of names) await api("POST", `/api/v1/mailboxes/${encodeURIComponent(mailbox)}/folders`, { name });
	}

	// Templates and sequences.
	for (const t of D.TEMPLATES) await api("POST", "/api/v1/templates", t);
	const seqIds = {};
	const existingSeqs = (await api("GET", "/api/v1/sequences")).json ?? [];
	for (const s of D.SEQUENCES) {
		const found = (Array.isArray(existingSeqs) ? existingSeqs : existingSeqs.sequences ?? []).find((x) => x.name === s.name);
		seqIds[s.name] = found?.id ?? (await api("POST", "/api/v1/sequences", { name: s.name, steps: s.steps })).json.id;
	}

	// Messages, oldest first so arrival order matches the dates.
	const manifest = { timeZone: ZONE, threads: {}, sentMessageIds: [], attachmentSizes: {} };
	const all = [];
	for (const t of D.THREADS) {
		const ids = t.messages.map((_, i) => `<demo.${t.key}.${i + 1}@${domainOf(t.messages[i].from.email)}>`);
		manifest.threads[t.key] = { mailbox: t.mailbox, messageIds: ids };
		t.messages.forEach((m, i) => all.push({ t, m, i, ids, date: messageDate(m) }));
	}
	all.sort((a, b) => a.date - b.date);
	let n = 0;
	for (const { t, m, i, ids, date } of all) {
		const from = m.sent && m.from_mailbox ? { name: m.from.name, email: t.mailbox } : m.from;
		const raw = buildRaw({
			from,
			to: m.to,
			cc: m.cc,
			subject: i === 0 ? t.subject : `Re: ${t.subject}`,
			date,
			messageId: ids[i],
			inReplyTo: i > 0 ? ids[i - 1] : null,
			references: ids.slice(0, i),
			text: m.body,
			attachments: (m.attachments ?? []).map(makeAttachment),
		});
		const q = new URLSearchParams({ from: from.email, to: t.mailbox });
		await api("POST", `/cdn-cgi/handler/email?${q}`, undefined, { raw, contentType: "message/rfc822" });
		if (m.sent) manifest.sentMessageIds.push(ids[i]);
		for (const a of m.attachments ?? []) {
			if (a.kb) (manifest.attachmentSizes[ids[i]] ??= {})[a.name] = a.kb * 1024 + ((a.kb * 37) % 1000);
		}
		n++;
	}
	console.log(`delivered ${n} messages`);

	// Drafts. A reply draft is threaded onto its conversation.
	for (const d of D.DRAFTS) {
		const mb = encodeURIComponent(d.mailbox);
		let threadFields = {};
		if (d.thread) {
			const lastId = manifest.threads[d.thread].messageIds.at(-1);
			const list = (await api("GET", `/api/v1/mailboxes/${mb}/emails?folder=inbox&limit=100`)).json;
			const rows = Array.isArray(list) ? list : list?.emails ?? list?.items ?? [];
			const hit = rows.find((e) => e.message_id === lastId) ?? rows.find((e) => (e.subject ?? "").endsWith(d.subject.replace(/^Re: /, "")));
			if (hit) threadFields = { in_reply_to: hit.message_id ?? lastId, thread_id: hit.thread_id };
		}
		await api("POST", `/api/v1/mailboxes/${mb}/drafts`, { to: d.to, subject: d.subject, body: d.body, ...threadFields });
	}
	console.log(`drafts: ${D.DRAFTS.length}`);

	// Scheduled sends.
	for (const s of D.SCHEDULED) {
		const mbx = D.MAILBOXES.find((m) => m.email === s.mailbox);
		await api("POST", `/api/v1/mailboxes/${encodeURIComponent(s.mailbox)}/scheduled-sends`, {
			from: { email: s.mailbox, name: s.mailbox === D.MAYA.email ? D.MAYA.name : mbx.name },
			to: s.to,
			subject: s.subject,
			html: s.html,
			send_at: new Date(Date.now() + s.inMinutes * 60000).toISOString(),
		});
	}
	console.log(`scheduled: ${D.SCHEDULED.length}`);

	// Sends held for approval: API tokens acting for one mailbox each.
	const tokens = {};
	for (const a of D.APPROVALS) {
		if (!tokens[a.tokenName]) {
			const tok = await api("POST", "/api/auth/tokens", { name: a.tokenName, mailboxes: [a.mailbox] });
			tokens[a.tokenName] = tok.json?.secret;
			if (!tokens[a.tokenName]) throw new Error(`no token in ${tok.text}`);
		}
		const held = await api(
			"POST",
			`/api/v1/mailboxes/${encodeURIComponent(a.mailbox)}/emails`,
			{ from: { email: a.mailbox, name: a.fromName }, to: a.to, subject: a.subject, html: a.html },
			{ token: tokens[a.tokenName] },
		);
		console.log(`held for approval: ${held.status} ${a.subject}`);
	}

	// Sequence enrollments from sales@.
	for (const s of D.SEQUENCES) {
		for (const p of s.enroll) {
			const r = await api("POST", `/api/v1/sequences/${seqIds[s.name]}/enroll`, {
				personId: p.email,
				personEmail: p.email,
				personName: p.name,
				fromAddress: "sales@northwind.example",
				variables: { firstName: p.name.split(" ")[0] },
			}).catch((e) => ({ status: "error", text: e.message }));
			if (r.status !== 200 && r.status !== 201) console.log(`enroll ${p.email}: ${r.status} ${String(r.text).slice(0, 160)}`);
		}
	}
	console.log("sequences enrolled");

	// Now that the mail is in, turn the per-mailbox AI features on as a real
	// deployment would have them.
	for (const mb of D.MAILBOXES) {
		await api("PUT", `/api/v1/mailboxes/${encodeURIComponent(mb.email)}`, {
			settings: { autoDraft: { enabled: true }, triage: { enabled: true } },
		});
	}

	mkdirSync(dirname(MANIFEST), { recursive: true });
	writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
	console.log(`manifest: ${MANIFEST}`);
}

// ───────────────────────────────────────────── phase: db

function findSqlite(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) findSqlite(p, out);
		else if (e.name.endsWith(".sqlite")) out.push(p);
	}
	return out;
}

async function phaseDb() {
	const { DatabaseSync } = await import("node:sqlite");
	const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
	const bare = (m) => m.replace(/^<|>$/g, "");
	const sent = new Set(manifest.sentMessageIds.map(bare));
	const files = findSqlite(join(STATE_DIR, "v3/do"));
	const iso = (d) => d.toISOString();
	let touched = 0;

	for (const file of files) {
		const db = new DatabaseSync(file);
		const hasEmails = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='emails'").get();
		if (!hasEmails) {
			db.close();
			continue;
		}
		const byMid = new Map(db.prepare("SELECT id, message_id, thread_id, date, recipient FROM emails").all().map((r) => [bare(r.message_id ?? ""), r]));
		const threads = D.THREADS.filter((t) => manifest.threads[t.key].messageIds.some((m) => byMid.has(bare(m))));
		if (!threads.length) {
			db.close();
			continue;
		}
		const labelId = (name) => db.prepare("SELECT id FROM labels WHERE name = ?").get(name)?.id;
		const presetId = (key) => db.prepare("SELECT id FROM labels WHERE preset_key = ?").get(key)?.id;
		const summaryV = db.prepare("SELECT MAX(summary_v) AS v FROM thread_summaries").get()?.v ?? 3;

		db.exec("BEGIN");
		for (const t of threads) {
			const ids = manifest.threads[t.key].messageIds.map(bare);
			const rows = ids.map((m) => byMid.get(m)).filter(Boolean);
			rows.forEach((row, i) => {
				const isSent = sent.has(ids[i]);
				const isLast = i === rows.length - 1;
				const read = isSent ? 1 : t.unread && isLast ? 0 : 1;
				// Where a person (or a rule) filed it.
				const folder = isSent ? "sent" : t.folder ? t.folder.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "inbox";
				db.prepare("UPDATE emails SET folder_id = ?, read = ?, starred = ? WHERE id = ?").run(
					folder,
					read,
					t.starred && isLast ? 1 : 0,
					row.id,
				);
				// Labels: the AI triage label on inbound mail, user labels on all.
				if (t.ai && !isSent) {
					const lid = presetId(t.ai);
					if (lid) db.prepare("INSERT OR IGNORE INTO email_labels (email_id, label_id, source) VALUES (?, ?, 'ai')").run(row.id, lid);
				}
				for (const name of t.labels ?? []) {
					const lid = labelId(name);
					if (lid) db.prepare("INSERT OR IGNORE INTO email_labels (email_id, label_id, source) VALUES (?, ?, 'user')").run(row.id, lid);
				}
				// Delivery and engagement for what we sent.
				if (isSent) {
					const at = new Date(row.date);
					// Delivered inbound, the row lists our own address too: keep
					// only the people it went to.
					const others = (row.recipient ?? "").split(",").map((x) => x.trim()).filter((x) => x && x !== t.mailbox);
					db.prepare("UPDATE emails SET recipient = ? WHERE id = ?").run(others.join(", "), row.id);
					const to = others[0] ?? null;
					const ev = db.prepare(
						"INSERT INTO delivery_events (email_id, recipient, event_type, source, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					);
					ev.run(row.id, to, "sent", "send", iso(at), iso(at));
					ev.run(row.id, to, "delivered", "graphql", iso(new Date(at.getTime() + 4000)), iso(at));
					const h = [...ids[i]].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5);
					const rnd = (k) => {
						// mulberry32 on (message, k): integer-exact, unlike a float multiply.
						let x = (h + Math.imul(k + 1, 0x6d2b79f5)) | 0;
						x = Math.imul(x ^ (x >>> 15), x | 1);
						x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
						return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32;
					};
					const opens = rnd(1) < 0.18 ? 0 : 1 + Math.floor(rnd(2) * rnd(3) * 7);
					let when = at.getTime() + (2 + Math.floor(rnd(4) ** 2 * 900)) * 60000;
					for (let k = 0; k < opens && when < Date.now() - 60000; k++) {
						ev.run(row.id, to, "opened", "pixel", iso(new Date(when)), iso(new Date(when)));
						when += (5 + Math.floor(rnd(10 + k) * 1400)) * 60000;
					}
					const links = [
						"https://northwind.example/learn/dial-in",
						"https://northwind.example/care-plans",
						"https://northwind.example/s2/spec-sheet",
						"https://northwind.example/financing",
						"https://northwind.example/book-a-demo",
					];
					const clicks = opens && rnd(5) < 0.45 ? 1 + Math.floor(rnd(8) * 3) : 0;
					for (let k = 0; k < clicks; k++) {
						const c = new Date(Math.min(Date.now() - 30000, at.getTime() + (6 + Math.floor(rnd(6 + k) * 300) + k * 47) * 60000));
						db.prepare(
							"INSERT INTO delivery_events (email_id, recipient, event_type, source, metadata, occurred_at, created_at) VALUES (?, ?, 'clicked', 'redirect', ?, ?, ?)",
						).run(row.id, to, JSON.stringify({ url: links[Math.floor(rnd(7 + k) * links.length)] }), iso(c), iso(c));
					}
					db.prepare("UPDATE emails SET delivery_status = 'delivered', engagement_v = 0 WHERE id = ?").run(row.id);
				}
				for (const [name, size] of Object.entries(manifest.attachmentSizes?.[`<${ids[i]}>`] ?? {})) {
					db.prepare("UPDATE attachments SET size = ? WHERE email_id = ? AND filename = ?").run(size, row.id, name);
				}
				touched++;
			});
			// Thread summary, as the model would have written it.
			if (t.summary && rows.length) {
				const tid = rows[0].thread_id ?? rows[0].id;
				db.prepare(
					`INSERT INTO thread_summaries (thread_id, summary_line, summary_bullets, summary_msg_count, summary_v, status, generated_at)
					 VALUES (?, ?, ?, ?, ?, 'ok', ?)
					 ON CONFLICT(thread_id) DO UPDATE SET summary_line = excluded.summary_line, summary_bullets = excluded.summary_bullets,
					   summary_msg_count = excluded.summary_msg_count, summary_v = excluded.summary_v, status = 'ok', generated_at = excluded.generated_at`,
				).run(tid, t.summary.line, JSON.stringify(t.summary.bullets ?? []), rows.length, summaryV, new Date().toISOString().replace("T", " ").slice(0, 19));
			}
		}
		// Mock summaries for threads we did not write one for would read as
		// placeholder text: drop them, and the queue that would regenerate them.
		const keep = new Set(threads.filter((t) => t.summary).map((t) => {
			const r = byMid.get(bare(manifest.threads[t.key].messageIds[0]));
			return r?.thread_id ?? r?.id;
		}));
		for (const r of db.prepare("SELECT thread_id FROM thread_summaries").all()) {
			if (!keep.has(r.thread_id)) db.prepare("DELETE FROM thread_summaries WHERE thread_id = ?").run(r.thread_id);
		}
		db.exec("DELETE FROM summary_queue");
		// One threaded inbox, no category tabs.
		db.exec("UPDATE labels SET show_tab = 0");
		db.exec("COMMIT");
		db.close();
		console.log(`${file.split("/").slice(-2).join("/")}: ${threads.length} threads`);
	}
	console.log(`updated ${touched} messages`);

	// Domains: what a finished setup and a passing DNS check leave behind
	// (offline, the app cannot reach Cloudflare's API or DNS to find out).
	for (const file of files) {
		const db = new DatabaseSync(file);
		const has = (t) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
		if (!has("domains")) {
			db.close();
			continue;
		}
		const now = Date.now();
		const delivered = { "northwind.example": 1840, "northwindlabs.example": 212, "harborline.example": 655 };
		for (const d of db.prepare("SELECT id, hostname FROM domains").all()) {
			const h = d.hostname;
			const check = (id, label, type, name, expected) => ({ id, label, type, name, status: "pass", expected, found: [expected], message: "Matches" });
			const audit = {
				checkedAt: now - 47 * 60000,
				summary: "pass",
				checks: [
					check("mx", "MX", "MX", h, "route1.mx.cloudflare.net"),
					check("spf", "SPF", "TXT", h, "v=spf1 include:_spf.mx.cloudflare.net ~all"),
					check("dkim", "DKIM (routing)", "TXT", `cf2024-1._domainkey.${h}`, "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqh…"),
					check("bounce_mx", "Bounce MX", "MX", `cf-bounce.${h}`, "route1.mx.cloudflare.net"),
					check("bounce_spf", "Return-path SPF", "TXT", `cf-bounce.${h}`, "v=spf1 include:_spf.mx.cloudflare.net ~all"),
					check("sending_dkim", "DKIM (sending)", "TXT", `cf-bounce._domainkey.${h}`, "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqh…"),
					check("dmarc", "DMARC", "TXT", `_dmarc.${h}`, "v=DMARC1; p=quarantine; rua=mailto:dmarc@" + h),
				],
			};
			db.prepare(
				"UPDATE domains SET status = 'active', routing_status = 'ready', sending_status = 'enabled', last_error = NULL, last_audit = ?, last_checked_at = ?, updated_at = ? WHERE id = ?",
			).run(JSON.stringify(audit), now - 47 * 60000, now, d.id);
			if (has("sending_health")) {
				const n = delivered[h] ?? 300;
				db.prepare(
					`INSERT INTO sending_health (domain, level, spam_rate, complaints, delivered, source, evaluated_at)
					 VALUES (?, 'ok', ?, ?, ?, 'local', ?)
					 ON CONFLICT(domain) DO UPDATE SET level = 'ok', spam_rate = excluded.spam_rate, complaints = excluded.complaints,
					   delivered = excluded.delivered, source = 'local', evaluated_at = excluded.evaluated_at`,
				).run(h, Math.round((n > 1000 ? 1 : 0) / n * 1e6) / 1e6, n > 1000 ? 1 : 0, n, now - 23 * 60000);
			}
		}
		db.close();
		console.log("domains marked set up");
	}

	await backdateSequences(DatabaseSync);
}

/**
 * Sequence enrollments live in R2 as JSON. Freshly seeded, every contact was
 * "enrolled just now" with nothing sent. Spread the enrollments over the past
 * five weeks and mark the steps whose time has passed as sent, by rewriting
 * the objects in the local R2 store (miniflare: a metadata SQLite file plus
 * one blob file per object).
 */
async function backdateSequences(DatabaseSync) {
	const { createHash } = await import("node:crypto");
	const r2 = join(STATE_DIR, "v3/r2");
	const metaFile = findSqlite(join(r2, "miniflare-R2BucketObject"))[0];
	const bucketDir = readdirSync(r2).find((d) => d !== "miniflare-R2BucketObject");
	if (!metaFile || !bucketDir) return;
	const db = new DatabaseSync(metaFile);
	const blobPath = (id) => join(r2, bucketDir, "blobs", id);
	const read = (row) => JSON.parse(readFileSync(blobPath(row.blob_id), "utf8"));
	const write = (row, obj) => {
		const buf = Buffer.from(JSON.stringify(obj));
		writeFileSync(blobPath(row.blob_id), buf);
		db.prepare("UPDATE _mf_objects SET size = ?, etag = ? WHERE key = ?").run(buf.length, createHash("md5").update(buf).digest("hex"), row.key);
	};
	const enrollments = db.prepare("SELECT key, blob_id FROM _mf_objects WHERE key LIKE 'sequence-enrollments/%'").all();
	const emails = db.prepare("SELECT key, blob_id FROM _mf_objects WHERE key LIKE 'sequence-emails/%'").all().map((row) => ({ row, obj: read(row) }));
	// The sequence store keeps Unix seconds.
	const nowS = Math.floor(Date.now() / 1000);
	const daysAgo = [33, 16, 9, 4, 1.2, 0.3, 21, 6];
	enrollments.forEach((row, i) => {
		const e = read(row);
		const enrolledAt = Math.round(nowS - daysAgo[i % daysAgo.length] * 86400 - ((i * 7919) % 3600));
		const mine = emails.filter((m) => m.obj.enrollmentId === e.id);
		let pending = 0;
		for (const m of mine) {
			m.obj.scheduledAt = enrolledAt + (m.obj.scheduledAt - e.enrolledAt);
			if (m.obj.scheduledAt < nowS - 60) {
				m.obj.status = "sent";
				m.obj.sentAt = m.obj.scheduledAt + 3 + ((i * 131) % 50);
			} else {
				m.obj.status = "pending";
				m.obj.sentAt = null;
				pending++;
			}
			write(m.row, m.obj);
		}
		e.enrolledAt = enrolledAt;
		e.status = mine.length && pending === 0 ? "completed" : "active";
		write(row, e);
	});
	db.close();
	console.log(`sequences: ${enrollments.length} enrollments backdated`);
}

if (phase === "api") await phaseApi();
else if (phase === "db") await phaseDb();
else {
	console.error("usage: seed-demo.mjs api|db");
	process.exit(2);
}
