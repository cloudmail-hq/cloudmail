#!/usr/bin/env node
/**
 * Records the seeded demo instance as the public demo's starting data.
 *
 *   scripts/demo/run.sh seed && scripts/demo/run.sh serve &
 *   node scripts/demo-site/snapshot.mjs
 *
 * It signs in to the local demo instance (scripts/demo), reads what the app's
 * own API returns, and writes app/demo/data/snapshot.json. Mail is stored as
 * rows; the in-page backend (app/demo) builds lists, threads, counts and
 * search from them. Everything else is stored as the response to one GET.
 *
 * Dates are stored as offsets from the time of the snapshot, so the demo
 * always reads as "today" (see app/demo/time.ts).
 *
 * Never point this at anything but the throwaway local demo instance: the
 * output is committed and published.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_BASE_URL, DEMO_OWNER } from "../demo/demo-constants.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "../../app/demo/data/snapshot.json");
const BASE = process.env.DEMO_BASE_URL ?? DEMO_BASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
	throw new Error(`snapshot.mjs reads the local demo instance only, not ${BASE}`);
}

let cookie = "";
const jar = new Map();
async function call(method, path, body) {
	const res = await fetch(BASE + path, {
		method,
		headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	// Keep cookies by name: a later response may set another one.
	for (const c of res.headers.getSetCookie?.() ?? []) {
		const [pair] = c.split(";");
		jar.set(pair.slice(0, pair.indexOf("=")), pair);
	}
	cookie = [...jar.values()].join("; ");
	return res;
}
/**
 * GET that returns parsed JSON, or `undefined` when the route answers an error.
 * `optional` is for lookups where 404 is the normal answer for most messages
 * (a follow-up reminder, a thread summary): those are not reported as gaps.
 */
async function get(path, { optional = false } = {}) {
	let res = await call("GET", path);
	// The local instance rate-limits; wait and try again rather than record a gap.
	for (let attempt = 0; res.status === 429 && attempt < 6; attempt++) {
		const wait = Number(res.headers.get("retry-after")) || 5;
		await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
		res = await call("GET", path);
	}
	if (!res.ok) {
		if (!(optional && res.status === 404)) skipped.push(`${res.status} ${path}`);
		return undefined;
	}
	const type = res.headers.get("content-type") ?? "";
	return type.includes("json") ? res.json() : undefined;
}
const skipped = [];
const enc = encodeURIComponent;

const login = await call("POST", "/api/auth/login", { email: DEMO_OWNER.email, password: DEMO_OWNER.password });
if (!login.ok) throw new Error(`sign-in failed: ${login.status} ${await login.text()}`);

const now = Date.now();
const mailboxes = await get("/api/v1/mailboxes?include=settings");
if (!Array.isArray(mailboxes) || mailboxes.length === 0) throw new Error("no mailboxes: is the instance seeded?");

/** Responses to GETs that don't depend on mail state, keyed by path. */
const fixed = {};
async function keep(path) {
	const data = await get(path);
	if (data !== undefined) fixed[path] = data;
	return data;
}

// ── instance-wide ───────────────────────────────────────────────────
for (const path of [
	"/api/auth/state",
	"/api/v1/me",
	"/api/v1/config",
	"/api/v1/branding",
	"/api/v1/preferences",
	"/api/v1/licence",
	"/api/v1/privacy",
	"/api/v1/products",
	"/api/v1/templates",
	"/api/v1/sequences",
	"/api/v1/domains",
	"/api/v1/access",
	"/api/v1/access/audit",
	"/api/v1/groups",
	"/api/v1/suppressions",
	"/api/v1/sending-health",
	"/api/v1/usage",
	"/api/v1/webhooks",
	"/api/v1/system/status",
	"/api/v1/cloudflare",
	"/api/v1/cloudflare/connection",
	"/api/v1/ai/settings",
	"/api/v1/ai/semantic",
	"/api/v1/ai/providers",
	"/api/v1/ai/routing",
	"/api/v1/me/assistant",
	"/api/v1/me/brief",
	"/api/v1/push/preferences",
	"/api/v1/push/subscriptions",
	"/api/v1/account/exports",
	"/api/v1/agent-inboxes",
	"/api/auth/sessions",
	"/api/auth/tokens",
	"/api/auth/passkeys",
	"/api/auth/2fa",
	"/api/auth/oauth-grants",
	"/api/auth/trusted-browsers",
	"/api/auth/admin/users",
	"/api/auth/admin/invites",
	"/api/auth/admin/security-policy",
	"/api/v1/people",
	"/api/v1/analytics/sent?days=7",
	"/api/v1/analytics/sent?days=30",
	"/api/v1/analytics/sent?days=90",
]) {
	await keep(path);
}
for (const days of [7, 30, 90]) {
	for (const scope of ["all", "mine"]) await keep(`/api/v1/analytics/overview?days=${days}&scope=${scope}`);
	await keep(`/api/v1/analytics/engagement?days=${days}`);
	await keep(`/api/v1/analytics/inbound?days=${days}`);
	await keep(`/api/v1/analytics/dmarc?days=${days}`);
}
for (const d of fixed["/api/v1/domains"]?.domains ?? []) {
	await keep(`/api/v1/domains/${enc(d.id)}`);
	await keep(`/api/v1/domains/${enc(d.id)}/sending`);
}
for (const t of fixed["/api/v1/templates"] ?? []) await keep(`/api/v1/templates/${enc(t.slug)}`);
for (const s of fixed["/api/v1/sequences"] ?? []) {
	await keep(`/api/v1/sequences/${enc(s.id)}`);
	await keep(`/api/v1/sequences/${enc(s.id)}/enrollments`);
}
for (const p of fixed["/api/v1/people"]?.people ?? []) {
	for (const address of p.emails ?? [p.email].filter(Boolean)) await keep(`/api/v1/people/${enc(address)}/emails`);
}

// ── per mailbox ─────────────────────────────────────────────────────
const boxes = {};
for (const mb of mailboxes) {
	const base = `/api/v1/mailboxes/${enc(mb.id)}`;
	const folders = await get(`${base}/folders`);
	const labels = await get(`${base}/labels`);
	if (!Array.isArray(folders) || !Array.isArray(labels)) {
		throw new Error(`could not read ${mb.id}. Failed so far:\n  ${skipped.join("\n  ")}`);
	}

	// Every message once, from each folder's flat list.
	const rows = new Map();
	for (const f of folders) {
		for (let page = 1; ; page++) {
			const data = await get(`${base}/emails?folder=${enc(f.id)}&page=${page}&limit=100`);
			const list = Array.isArray(data) ? data : (data?.emails ?? []);
			for (const row of list) rows.set(row.id, row);
			if (list.length < 100) break;
		}
	}
	// The detail read adds the body, attachments and reader warnings.
	const emails = [];
	const emailLabels = {};
	const deliveryEvents = {};
	const followups = {};
	const summaries = {};
	for (const id of rows.keys()) {
		const full = await get(`${base}/emails/${enc(id)}`);
		if (!full) continue;
		// Proxy paths are signed for the local instance and mean nothing elsewhere.
		delete full.image_proxy;
		emails.push(full);
		const l = await get(`${base}/emails/${enc(id)}/labels`);
		if (l?.length) emailLabels[id] = l;
		if (full.folder_id === "sent") {
			const ev = await get(`${base}/emails/${enc(id)}/delivery-events`);
			if (ev?.events?.length) deliveryEvents[id] = ev.events;
			const fu = await get(`${base}/emails/${enc(id)}/followup`, { optional: true });
			if (fu) followups[id] = fu;
		}
	}
	// One-line summaries ride on threaded list rows; the full summary has its own route.
	const summaryLines = {};
	for (const f of folders) {
		const data = await get(`${base}/emails?folder=${enc(f.id)}&threaded=true&page=1&limit=100`);
		for (const row of data?.emails ?? []) {
			const tid = row.thread_id ?? row.id;
			if (row.summary_line) summaryLines[tid] = { line: row.summary_line, status: row.summary_status ?? null };
		}
	}
	for (const tid of new Set(emails.map((e) => e.thread_id ?? e.id))) {
		const s = await get(`${base}/threads/${enc(tid)}/summary`, { optional: true });
		if (s?.summary) summaries[tid] = s.summary;
	}

	const extra = {};
	for (const path of [
		"signatures",
		"rules",
		"blocked-senders",
		"allowed-senders",
		"muted-threads",
		"label-prompts",
		"inbox-tabs",
		"screener",
		"scheduled-sends",
		"followups",
		"approvals?status=pending",
		"approvals?status=all",
		"approvals/count",
		"aliases",
		"delegates",
		"audit",
		"send-limits",
		"semantic",
		"webhooks",
		"settings/tracking",
	]) {
		const data = await get(`${base}/${path}`);
		if (data !== undefined) extra[path] = data;
	}
	for (const a of extra["approvals?status=all"]?.approvals ?? []) {
		const one = await get(`${base}/approvals/${enc(a.id)}`);
		if (one) extra[`approvals/${a.id}`] = one;
	}

	boxes[mb.id] = {
		mailbox: mb,
		folders: folders.map((f) => ({ id: f.id, name: f.name })),
		labels: labels.map(({ email_count, unread_count, ...l }) => l),
		emails,
		emailLabels,
		deliveryEvents,
		followups,
		summaries,
		summaryLines,
		extra,
	};
}

// ── dates become offsets from "now" ─────────────────────────────────
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** Epoch numbers near the snapshot time, in seconds or milliseconds. */
function epochKind(n) {
	if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
	const year = 365 * 86_400_000;
	if (Math.abs(n - now) < 3 * year) return "ms";
	if (Math.abs(n * 1000 - now) < 3 * year) return "s";
	return null;
}
const EPOCH_KEY = /(At|_at|Time|expires|Seen|Used|Login|Changed|until|date)$/i;
/** A calendar day (analytics buckets) and the timestamp form SQLite writes. Both UTC. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const today = Date.parse(new Date(now).toISOString().slice(0, 10));
function relativise(value, key) {
	if (typeof value === "string") {
		if (ISO.test(value)) return { $t: Date.parse(value) - now };
		if (DAY.test(value)) return { $d: Math.round((Date.parse(value) - today) / 86_400_000) };
		if (SQL_TIME.test(value)) return { $q: Date.parse(`${value.replace(" ", "T")}Z`) - now };
		return value;
	}
	if (typeof value === "number" && key && EPOCH_KEY.test(key)) {
		const kind = epochKind(value);
		if (kind === "ms") return { $ms: value - now };
		if (kind === "s") return { $s: value - Math.round(now / 1000) };
		return value;
	}
	if (Array.isArray(value)) return value.map((v) => relativise(v, key));
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = relativise(v, k);
		return out;
	}
	return value;
}

// ── nothing about the machine that recorded it ──────────────────────
// The recording comes from a local instance driven by scripts: its addresses,
// user agents and passkey domain are replaced with neutral values. The IP is
// from a range reserved for documentation (RFC 5737).
const DEMO_IP = "203.0.113.24";
const DEMO_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
function scrub(value, key) {
	if (typeof value === "string") {
		if (/^(127\.0\.0\.1|::1|localhost)$/.test(value)) return key === "rpId" ? "demo.cloudmail.example" : DEMO_IP;
		if (/user.?agent/i.test(key ?? "")) return DEMO_UA;
		return value;
	}
	if (Array.isArray(value)) return value.map((v) => scrub(v, key));
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k);
		return out;
	}
	return value;
}
// One signed-in browser, not the list of scripted sign-ins that seeded the instance.
const sessions = fixed["/api/auth/sessions"]?.sessions;
if (Array.isArray(sessions)) fixed["/api/auth/sessions"].sessions = sessions.filter((x) => x.current).slice(0, 1);
// A local build reports the licence check as off; the page shows its own view (app/demo/backend.ts).
if (fixed["/api/v1/licence"]) fixed["/api/v1/licence"].manageUrl = "https://trycloudmail.com/pricing";

const snapshot = relativise(scrub({ owner: DEMO_OWNER.email, mailboxOrder: mailboxes.map((m) => m.id), fixed, boxes }));
mkdirSync(dirname(OUT), { recursive: true });
const text = JSON.stringify(snapshot);
if (/localhost|127\.0\.0\.1/.test(text.replaceAll("http://127.0.0.1:5173", ""))) {
	console.warn("warning: the snapshot still names a local address somewhere");
}
writeFileSync(OUT, text.replaceAll("http://127.0.0.1:5173", "https://demo.cloudmail.example"));

const count = Object.values(boxes).reduce((n, b) => n + b.emails.length, 0);
console.log(`wrote ${OUT}`);
console.log(`${mailboxes.length} mailboxes, ${count} messages, ${Object.keys(fixed).length} fixed responses, ${(text.length / 1024).toFixed(0)} KB`);
if (skipped.length) console.log(`not recorded (${skipped.length}):\n  ${skipped.join("\n  ")}`);
