/**
 * The public demo's in-page backend (app/demo): the mail rules it mirrors, the
 * guarantees the demo makes (nothing is sent, protected settings cannot be
 * changed, a fresh page starts over) and the stored AI answers.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentHistory, agentReply, AGENT_DRAFT_ID } from "../app/demo/ai";
import { READ_ONLY, SENDING_OFF } from "../app/demo/backend";
import { makeFile } from "../app/demo/files";
import { createDemo } from "../app/demo/runtime";
import type { DemoSnapshot, Row } from "../app/demo/store";
import { revive } from "../app/demo/time";

const text = readFileSync(fileURLToPath(new URL("../app/demo/data/snapshot.json", import.meta.url)), "utf8");
const snapshot = JSON.parse(text) as DemoSnapshot;
const NOW = Date.UTC(2026, 10, 26, 9, 0, 0);
const MAYA = "maya@northwind.example";
const mb = (id = MAYA) => `/api/v1/mailboxes/${encodeURIComponent(id)}`;

function start() {
	const rt = createDemo(snapshot, { clock: () => NOW, timeZone: "UTC" });
	const call = (method: string, path: string, body?: unknown) => rt.backend.handle(method, new URL(path, "https://demo.example"), body);
	const get = (path: string) => call("GET", path).body as any;
	return { ...rt, call, get };
}

const inbox = (d: ReturnType<typeof start>, id = MAYA) => d.get(`${mb(id)}/emails?folder=inbox&threaded=true&limit=100`) as { emails: Row[]; totalCount: number };

describe("demo data", () => {
	it("names nothing but fictional people and the product", () => {
		// Addresses: every one is on a reserved .example domain.
		const domains = new Set([...text.matchAll(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()));
		expect([...domains].filter((d) => !d.endsWith(".example"))).toEqual([]);
		// Nothing about the machine that recorded it, and none of the wording the public copy avoids.
		expect(text).not.toMatch(/127\.0\.0\.1|localhost|tapetide|open[ -]source|\bimap\b|\bfork(ed)?\b/i);
	});

	it("stores dates as offsets, so the demo always reads as today", () => {
		const revived = revive<DemoSnapshot>(snapshot, NOW);
		const dates = Object.values(revived.boxes).flatMap((b) => (b.emails as Row[]).map((e) => Date.parse(e.date)));
		expect(dates.every(Number.isFinite)).toBe(true);
		// The newest received mail is at most a few hours old, whenever the page loads.
		const received = Object.values(revived.boxes).flatMap((b) => (b.emails as Row[]).filter((e) => e.folder_id === "inbox").map((e) => Date.parse(e.date)));
		expect(NOW - Math.max(...received)).toBeLessThan(6 * 3_600_000);
		expect(Math.max(...received)).toBeLessThanOrEqual(NOW);
		expect(revive({ $d: -1 }, NOW)).toBe("2026-11-25");
		expect(revive({ $q: -60_000 }, NOW)).toBe("2026-11-26 08:59:00");
	});
});

describe("demo mail", () => {
	it("opens on the owner's inbox with unread mail and summaries", () => {
		const d = start();
		expect(d.get("/api/v1/me")).toMatchObject({ email: MAYA, authenticated: true, authMethod: "dev" });
		const list = inbox(d);
		expect(list.totalCount).toBeGreaterThan(10);
		expect(list.emails.some((e) => e.thread_unread_count > 0)).toBe(true);
		// Every conversation in every inbox has a one-line AI summary.
		for (const id of d.store.order) {
			const missing = inbox(d, id).emails.filter((e) => !e.summary_line).map((e) => e.subject);
			expect(missing, id).toEqual([]);
		}
		expect(d.get(`${mb()}/state`)).toMatchObject({ inboxUnread: d.get(`${mb()}/folders`).find((f: Row) => f.id === "inbox").unreadCount });
	});

	it("returns a thread with its full summary", () => {
		const d = start();
		const row = inbox(d).emails.find((e) => /Brightcup/.test(e.subject))!;
		const thread = d.get(`${mb()}/threads/${row.thread_id}`) as Row[];
		// Three messages and the reply the agent drafted.
		expect(thread.map((m) => m.folder_id)).toEqual(["inbox", "sent", "inbox", "draft"]);
		expect(thread.every((m) => typeof m.body === "string" && m.body.length > 0)).toBe(true);
		const { summary } = d.get(`${mb()}/threads/${row.thread_id}/summary`);
		expect(summary).toMatchObject({ status: "ok", stale: false });
		expect(summary.bullets.length).toBeGreaterThan(1);
	});

	it("applies read, star, archive, label, snooze and delete in memory", () => {
		const d = start();
		const before = inbox(d);
		const row = before.emails.find((e) => e.thread_unread_count > 0 && e.thread_count === 1)!;

		d.call("PUT", `${mb()}/emails/${row.id}`, { read: true, starred: true });
		expect(d.get(`${mb()}/emails/${row.id}`)).toMatchObject({ read: true, starred: true });
		expect(d.get(`${mb()}/emails?folder=inbox&threaded=true&starred=true`).emails.map((e: Row) => e.id)).toContain(row.id);

		const label = d.get(`${mb()}/labels`)[0];
		expect(d.call("PUT", `${mb()}/emails/${row.id}/labels`, { label_ids: [label.id] }).status).toBe(200);
		expect(d.get(`${mb()}/labels/${label.id}/emails`).emails.map((e: Row) => e.id)).toContain(row.id);
		expect(d.get(`${mb()}/labels`)[0].email_count).toBe(label.email_count + (d.store.box(MAYA).emailLabels.get(row.id)?.size === 1 ? 1 : 0));

		expect(d.call("POST", `${mb()}/emails/${row.id}/move`, { folderId: "archive" }).body).toEqual({ status: "moved" });
		expect(inbox(d).totalCount).toBe(before.totalCount - 1);
		expect(d.get(`${mb()}/emails?folder=archive&threaded=true`).emails.map((e: Row) => e.id)).toContain(row.id);

		const other = inbox(d).emails.find((e) => e.thread_count === 1)!;
		expect(d.call("POST", `${mb()}/emails/${other.id}/snooze`, { delay_seconds: 3600 }).status).toBe(200);
		expect(d.get(`${mb()}/emails/${other.id}`).folder_id).toBe("snoozed");

		// Delete is trash first, then gone.
		expect(d.call("DELETE", `${mb()}/emails/${row.id}`).body).toEqual({ status: "trashed" });
		expect(d.get(`${mb()}/emails/${row.id}`).folder_id).toBe("trash");
		expect(d.call("DELETE", `${mb()}/emails/${row.id}`).body).toEqual({ status: "deleted" });
		expect(d.call("GET", `${mb()}/emails/${row.id}`).status).toBe(404);

		// The version the client polls moved, so open lists refresh.
		expect(d.get(`${mb()}/state`).version).toBeGreaterThan(1);
	});

	it("saves and updates a draft with an attachment", () => {
		const d = start();
		const created = d.call("POST", `${mb()}/drafts`, {
			to: "priya@brightcup.example",
			subject: "Install checklist",
			body: "<p>Attached.</p>",
			replace_attachments: true,
			attachments: [{ content: btoa("hello"), filename: "note.txt", type: "text/plain", disposition: "attachment" }],
		});
		expect(created.status).toBe(201);
		const id = (created.body as Row).id;
		expect(d.call("POST", `${mb()}/drafts`, { draft_id: id, to: "priya@brightcup.example", subject: "Install checklist v2", body: "<p>Attached again.</p>" }).status).toBe(200);
		const draft = d.get(`${mb()}/emails/${id}`);
		expect(draft).toMatchObject({ folder_id: "draft", subject: "Install checklist v2" });
		// An autosave without `replace_attachments` keeps the file.
		expect(draft.attachments).toHaveLength(1);
		const file = d.call("GET", `${mb()}/emails/${id}/attachments/${draft.attachments[0].id}`);
		expect(file.blob?.size).toBe(5);
		expect(d.get(`${mb()}/emails?folder=draft&threaded=true`).emails.map((e: Row) => e.id)).toContain(id);
	});

	it("searches one mailbox and all of them", () => {
		const d = start();
		expect(d.get(`${mb()}/search?query=attestation`).emails.map((e: Row) => e.subject)).toEqual([expect.stringMatching(/SOC 2 Type II/)]);
		expect(d.get(`${mb()}/search?query=${encodeURIComponent("from:priya is:unread")}`).totalCount).toBe(1);
		// A question matches no message word for word; the related mail is listed instead.
		const question = d.get(`${mb()}/search?query=${encodeURIComponent("What did Brightcup say about payment terms?")}`);
		// The same three messages the stored answer cites.
		expect(question.emails.map((e: Row) => e.subject)).toEqual([expect.stringMatching(/Brightcup/), expect.stringMatching(/Brightcup/), expect.stringMatching(/Brightcup/)]);
		expect(d.get(`${mb()}/search?query=${encodeURIComponent("from:nobody zzz")}`).totalCount).toBe(0);
		expect(d.get(`${mb()}/search?query=qqqqzzzz`).totalCount).toBe(0);
		const all = d.get("/api/v1/search?q=webhook");
		expect(new Set(all.results.map((r: Row) => r.mailboxId)).size).toBeGreaterThan(0);
		expect(all.results[0]).toHaveProperty("snippet");
	});

	it("has mail in every folder, with what each folder records", () => {
		const d = start();
		const counts = Object.fromEntries(d.get(`${mb()}/folders`).map((f: Row) => [f.id, f.totalCount]));
		for (const id of ["inbox", "sent", "draft", "scheduled", "archive", "snoozed", "screener", "spam", "trash", "receipts"]) {
			expect(counts[id], id).toBeGreaterThan(0);
		}
		// Every mailbox has something in Spam, for the reader's "why is this here".
		for (const id of d.store.order) {
			const spam = d.get(`${mb(id)}/emails?folder=spam&limit=50`).emails as Row[];
			expect(spam.length, id).toBeGreaterThan(0);
			for (const e of spam) {
				expect(e.spam_score, e.subject).toBeGreaterThanOrEqual(5);
				expect(JSON.parse(e.spam_signals)[0], e.subject).toMatchObject({ id: expect.any(String), label: expect.any(String) });
			}
		}
		for (const e of d.get(`${mb()}/emails?folder=trash&limit=50`).emails as Row[]) {
			expect(e.trashed_from, e.subject).toBe("inbox");
			expect(Date.parse(e.trashed_at), e.subject).toBeLessThan(NOW);
		}
		for (const e of d.get(`${mb()}/emails?folder=snoozed&limit=50`).emails as Row[]) {
			expect(Date.parse(e.snoozed_until), e.subject).toBeGreaterThan(NOW);
			expect(e.snooze_return_folder).toBe("inbox");
		}
		// Spam and Trash never show a summary.
		expect(d.get(`${mb()}/emails?folder=spam&threaded=true`).emails.filter((e: Row) => e.summary_line)).toEqual([]);
	});

	it("has no empty Archive, Snoozed, Spam or Trash in any mailbox", () => {
		const d = start();
		for (const id of d.store.order) {
			const counts = Object.fromEntries(d.get(`${mb(id)}/folders`).map((f: Row) => [f.id, f.totalCount]));
			for (const folder of ["archive", "snoozed", "spam", "trash"]) expect(counts[folder], `${id} ${folder}`).toBeGreaterThan(0);
			for (const e of d.get(`${mb(id)}/emails?folder=snoozed&limit=50`).emails as Row[]) {
				expect(Date.parse(e.snoozed_until), e.subject).toBeGreaterThan(NOW);
			}
			// Archived and snoozed conversations carry a summary, like the inbox.
			for (const folder of ["archive", "snoozed"]) {
				const missing = (d.get(`${mb(id)}/emails?folder=${folder}&threaded=true&limit=50`).emails as Row[]).filter((e) => !e.summary_line).map((e) => e.subject);
				expect(missing, `${id} ${folder}`).toEqual([]);
			}
		}
	});

	it("lists the Screener and applies Yes and No for the visit", () => {
		const d = start();
		expect(d.get(mb()).settings.screener).toBe("unknown_only");
		const { senders } = d.get(`${mb()}/screener`);
		expect(senders.length).toBeGreaterThan(3);
		expect(senders.every((s: Row) => /^Looks like /.test(s.verdict))).toBe(true);
		expect(senders.map((s: Row) => s.latest_date)).toEqual([...senders.map((s: Row) => s.latest_date)].sort().reverse());
		const twice = senders.find((s: Row) => s.count === 2);
		const inboxBefore = inbox(d).totalCount;

		const yes = d.call("POST", `${mb()}/screener/${encodeURIComponent(senders[0].sender)}`, { decision: "allow" });
		expect(yes.body).toMatchObject({ decision: "allow", folder: "inbox", moved: senders[0].count, listed: true });
		expect(inbox(d).totalCount).toBe(inboxBefore + 1);
		expect(d.get(`${mb()}/allowed-senders`).map((r: Row) => r.pattern)).toContain(senders[0].sender);

		const no = d.call("POST", `${mb()}/screener/${encodeURIComponent(twice.sender)}`, { decision: "block", target: "trash" });
		expect(no.body).toMatchObject({ decision: "block", folder: "trash", moved: 2 });
		expect(d.get(`${mb()}/emails/${twice.latest_id}`)).toMatchObject({ folder_id: "trash", trashed_from: "screener" });
		expect(d.get(`${mb()}/blocked-senders`).map((r: Row) => r.pattern)).toContain(twice.sender);
		expect(d.get(`${mb()}/screener`).senders).toHaveLength(senders.length - 2);
		expect(d.call("POST", `${mb()}/screener/not-an-address`, { decision: "allow" }).status).toBe(400);
	});

	it("keeps a domain-wide allow on a Screener No, and clears a domain-wide block on a Yes", () => {
		const d = start();
		const [first, second] = d.get(`${mb()}/screener`).senders as Row[];
		const domainOf = (address: string) => address.slice(address.lastIndexOf("@"));
		const patterns = (list: string) => (d.get(`${mb()}/${list}`) as Row[]).map((r) => r.pattern);

		// One No about one sender is narrower than a rule for the whole domain.
		d.call("POST", `${mb()}/allowed-senders`, { pattern: domainOf(first.sender) });
		d.call("POST", `${mb()}/allowed-senders`, { pattern: first.sender });
		expect(patterns("allowed-senders")).toEqual(expect.arrayContaining([domainOf(first.sender), first.sender]));
		d.call("POST", `${mb()}/screener/${encodeURIComponent(first.sender)}`, { decision: "block" });
		expect(patterns("allowed-senders")).toContain(domainOf(first.sender));
		expect(patterns("allowed-senders")).not.toContain(first.sender);

		// A Yes clears a block on the address and on its domain.
		d.call("POST", `${mb()}/blocked-senders`, { pattern: domainOf(second.sender) });
		expect(patterns("blocked-senders")).toContain(domainOf(second.sender));
		d.call("POST", `${mb()}/screener/${encodeURIComponent(second.sender)}`, { decision: "allow" });
		expect(patterns("blocked-senders")).not.toContain(domainOf(second.sender));
	});

	it("ships templates and sequences a software company would run", () => {
		const d = start();
		const templates = d.get("/api/v1/templates") as Row[];
		expect(templates.map((t) => t.slug)).toEqual(expect.arrayContaining(["signup-welcome", "signup-trial-ending", "cold-intro", "cold-breakup", "demo-thanks", "winback-feedback"]));
		const sequences = d.get("/api/v1/sequences") as Row[];
		expect(sequences.map((s) => s.name)).toEqual(expect.arrayContaining(["New signup onboarding", "Cold outreach: engineering leaders", "Demo follow-up", "Trial ended: win-back"]));
		// A step's delay is the wait after the step before it. The onboarding
		// emails must land inside the 14-day trial their text describes.
		const onboarding = sequences.find((s) => s.name === "New signup onboarding")!;
		let hours = 0;
		const days = (onboarding.steps as Row[]).map((step) => (hours += step.delayHours) / 24);
		expect(days).toEqual([0, 1, 3, 7, 11]);
		const cold = sequences.find((s) => s.name.startsWith("Cold outreach"))!;
		expect(d.get(`/api/v1/sequences/${cold.id}/enrollments`).length ?? d.get(`/api/v1/sequences/${cold.id}/enrollments`).enrollments.length).toBeGreaterThan(3);
	});

	it("lists the unified inbox with unread counts per mailbox", () => {
		const d = start();
		const all = d.get("/api/v1/inbox?folder=inbox&limit=5");
		expect(all.emails).toHaveLength(5);
		expect(all.nextCursor).toBe("5");
		expect(Object.keys(all.unreadByMailbox).sort()).toEqual([...d.store.order].sort());
		expect(all.unread).toBe(Object.values<number>(all.unreadByMailbox).reduce((a, b) => a + b, 0));
	});

	it("makes real files for the recorded attachments", () => {
		const d = start();
		const withFile = (d.get(`${mb()}/emails?folder=inbox&limit=100`).emails as Row[]).map((e) => d.get(`${mb()}/emails/${e.id}`)).find((e) => e.attachments?.some((a: Row) => a.mimetype === "application/pdf"))!;
		const att = withFile.attachments.find((a: Row) => a.mimetype === "application/pdf");
		const res = d.call("GET", `${mb()}/emails/${withFile.id}/attachments/${att.id}`);
		expect(res.blob?.type).toBe("application/pdf");
		expect(new TextDecoder().decode(makeFile("x.pdf", "application/pdf").subarray(0, 5))).toBe("%PDF-");
		expect([...makeFile("x.png", "image/png").subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
		expect(new TextDecoder().decode(makeFile("x.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").subarray(0, 2))).toBe("PK");
		expect(d.files.face("priya@brightcup.example")).toMatch(/^data:image\/svg\+xml/);
		expect(d.files.face("priya@brightcup.example")).toBe(d.files.face(" Priya@Brightcup.example"));
	});
});

describe("demo guarantees", () => {
	it("refuses every way of sending, with a plain message", () => {
		const d = start();
		const draft = d.get(`${mb()}/emails?folder=draft`).emails[0];
		const queued = d.get(`${mb()}/scheduled-sends`)[0];
		const sequence = d.get("/api/v1/sequences")[0];
		const attempts: [string, string][] = [
			["POST", `${mb()}/emails`],
			["POST", `${mb()}/scheduled-sends`],
			["POST", `${mb()}/scheduled-sends/${queued.email_id}/send-now`],
			["POST", `${mb()}/emails/${draft.id}/reply`],
			["POST", `${mb()}/emails/${draft.id}/forward`],
			["POST", `${mb()}/approvals/any/approve`],
			["POST", `/api/v1/sequences/${sequence.id}/enroll`],
			["POST", "/api/v1/push/test"],
		];
		const sentBefore = d.get(`${mb()}/folders`).find((f: Row) => f.id === "sent").totalCount;
		for (const [method, path] of attempts) {
			const res = d.call(method, path, { to: "someone@anywhere.example", subject: "x", html: "<p>x</p>", delay_seconds: 30 });
			expect(res.status, path).toBe(403);
			expect(res.body, path).toEqual({ error: SENDING_OFF, code: "demo_read_only" });
		}
		const folders = d.get(`${mb()}/folders`);
		expect(folders.find((f: Row) => f.id === "sent").totalCount).toBe(sentBefore);
		// A queued message can still be pulled back to Drafts; it was never going out.
		expect(d.call("DELETE", `${mb()}/scheduled-sends/${queued.email_id}`).body).toEqual({ status: "cancelled" });
	});

	it("keeps Cloudflare, domains, accounts, tokens and the licence read-only", () => {
		const d = start();
		const domain = d.get("/api/v1/domains").domains[0];
		const writes: [string, string][] = [
			["POST", "/api/v1/cloudflare/connection"],
			["DELETE", "/api/v1/cloudflare/connection"],
			["POST", "/api/v1/domains"],
			["DELETE", `/api/v1/domains/${domain.id}`],
			["PUT", `/api/v1/domains/${domain.id}/sending`],
			["POST", "/api/v1/licence/activate"],
			["POST", "/api/v1/licence/deactivate"],
			["POST", "/api/auth/tokens"],
			["PUT", "/api/auth/password"],
			["POST", "/api/auth/2fa/setup"],
			["POST", "/api/auth/passkeys/register/options"],
			["POST", "/api/auth/admin/invites"],
			["POST", "/api/auth/login"],
			["POST", "/api/auth/logout"],
			["PUT", "/api/v1/access"],
			["POST", "/api/v1/account/exports"],
			["DELETE", "/api/v1/account"],
			["POST", "/api/v1/webhooks"],
			["POST", "/api/v1/mailboxes"],
			["DELETE", mb()],
			["POST", `${mb()}/imports`],
			["POST", "/api/v1/anything-new"],
		];
		for (const [method, path] of writes) {
			const res = d.call(method, path, { key: "CM-TEST", password: "hunter2" });
			expect(res.status, path).toBe(403);
			expect((res.body as Row).error, path).toBe(READ_ONLY);
		}
		// Reads still work, and nothing a write carried was kept.
		expect(d.get("/api/auth/tokens").tokens.length).toBeGreaterThan(0);
		expect(JSON.stringify(d.get("/api/v1/licence"))).not.toMatch(/CM-TEST|tapetide/);
		expect(d.get("/api/v1/licence")).toMatchObject({ status: "active", locked: false });
	});

	it("starts over on every page load", () => {
		const first = start();
		const before = JSON.stringify(inbox(first));
		for (const e of inbox(first).emails.slice(0, 5)) first.call("DELETE", `${mb()}/emails/${e.id}`);
		first.call("POST", `${mb()}/drafts`, { subject: "scratch", body: "x" });
		first.call("PUT", "/api/v1/preferences", { sending: { undoWindowEnabled: false } });
		expect(JSON.stringify(inbox(first))).not.toBe(before);

		// A reload builds the state again from the same snapshot.
		const second = start();
		expect(JSON.stringify(inbox(second))).toBe(before);
		expect(second.get("/api/v1/preferences").sending.undoWindowEnabled).toBe(true);
		expect(second.get(`${mb()}/emails?folder=draft`).emails.map((e: Row) => e.subject)).not.toContain("scratch");
	});

	it("answers unknown paths without throwing", () => {
		const d = start();
		expect(d.call("GET", "/api/v1/nope").status).toBe(404);
		expect(d.call("GET", "/api/v1/mailboxes/nobody%40nowhere.example/emails").status).toBe(404);
		expect(d.call("GET", `${mb()}/emails/missing`).status).toBe(404);
	});
});

describe("demo AI", () => {
	it("builds today's brief for the mailbox on screen", () => {
		const d = start();
		expect(d.get("/api/v1/me/assistant").brief.enabled).toBe(true);
		const { brief, dismissed } = d.get("/api/v1/me/brief");
		expect(dismissed).toBe(false);
		const mine = brief.mailboxes.find((m: Row) => m.mailbox === MAYA);
		expect(mine.newCount).toBeGreaterThan(0);
		expect(mine.needsReplyCount).toBeGreaterThan(0);
		d.call("POST", `/api/v1/me/brief/${brief.id}/dismiss`);
		expect(d.get("/api/v1/me/brief").dismissed).toBe(true);
	});

	it("answers questions from the mail, with sources that exist", () => {
		const d = start();
		const res = d.call("POST", "/api/v1/ask", { question: "What did Brightcup say about payment terms?" }).body as Row;
		expect(res.insufficient).toBe(false);
		expect(res.answer).toMatch(/net-30/);
		expect(res.citations).toHaveLength(3);
		for (const c of res.citations) {
			expect(d.get(`${mb(c.mailbox)}/emails/${c.email_id}`).subject).toBe(c.subject);
			expect(c.href).toBe(`/mail/${encodeURIComponent(c.mailbox)}/${c.folder}?m=${c.email_id}`);
		}
		// Every [n] in the answer has a source.
		const marks = [...res.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
		expect(Math.max(...marks)).toBeLessThanOrEqual(res.citations.length);

		const other = d.call("POST", "/api/v1/ask", { question: "custom domain status page", mailbox: "support@northwind.example" }).body as Row;
		expect(other.citations.length).toBeGreaterThan(0);
		expect(other.citations.every((c: Row) => c.mailbox === "support@northwind.example")).toBe(true);

		const none = d.call("POST", "/api/v1/ask", { question: "zzzz qqqq" }).body as Row;
		expect(none).toMatchObject({ insufficient: true, citations: [] });

		// A question gets its own thread's answer, not a neighbouring topic's.
		const topics: [string, RegExp][] = [
			["How much are SMS credits from Kobayashi?", /SMS and voice alerts/],
			["What happened in the Lumen Health outage?", /Missed alerts/],
			["Is the SOC 2 report ready?", /SOC 2/],
			["When does the Stratus renewal need an answer?", /Stratus/],
		];
		for (const [question, subject] of topics) {
			const got = d.call("POST", "/api/v1/ask", { question }).body as Row;
			expect(got.citations.length, question).toBeGreaterThan(0);
			expect(got.citations.every((c: Row) => subject.test(c.subject)), question).toBe(true);
		}
	});

	it("does not give a stored answer to a question about other mail", () => {
		const d = start();
		// Each question shares a word with a stored topic but is about another message.
		const others: [string, RegExp][] = [
			["How much was the Stratus cloud usage in October?", /October cloud usage/],
			["When do the domains come up for renewal?", /renews in 49 days/],
			["What did the Reliability Brief say about outages?", /Reliability Brief/],
			["Is the mutual NDA with Meridian signed?", /mutual NDA/],
			["What did Victor offer in the investor update?", /October investor update/],
			["What did Nia say about the offsite?", /Offsite recap/],
			// One word of a stored topic does not outweigh the mail the question names.
			["What did Nia say about hiring at the offsite?", /Offsite recap/],
			["What did the offsite recap say about the board meeting?", /Offsite recap/],
		];
		for (const [question, subject] of others) {
			const got = d.call("POST", "/api/v1/ask", { question }).body as Row;
			expect(got.semantic, question).toBe(false);
			expect(got.citations.some((c: Row) => subject.test(c.subject)), `${question} -> ${got.citations.map((c: Row) => c.subject).join(" / ")}`).toBe(true);
		}
		// These words are in several threads, so no single stored answer claims them.
		const noStoredAnswer = [
			"How much did ARR grow in October?",
			"When does on-call scheduling launch?",
			// Invoices from other senders, including the fake one in Spam.
			"Is the Stratus invoice paid?",
			"Is the overdue invoice real?",
			"Is the overdue invoice due this week?",
			"Who sent the phishing invoice?",
			"Is the invoice in spam a scam?",
		];
		for (const question of noStoredAnswer) {
			expect((d.call("POST", "/api/v1/ask", { question }).body as Row).semantic, question).toBe(false);
		}
		// The questions the stored answers are for still get them.
		const stored: [string, RegExp][] = [
			["What needs my attention this week?", /Launch plan/],
			["When does Incident Timeline launch?", /Launch plan/],
			["What is in the board deck?", /Board deck/],
			["Who is Ruth Abara?", /Intro: Ruth Abara/],
			["Should we make the offer to Jonas?", /Offer approval/],
			["Is the Ledgerly invoice paid?", /INV-20418/],
			["When is the invoice due?", /INV-20418/],
			["Do I need to pay the invoice this week?", /INV-20418/],
			["Is the invoice overdue?", /INV-20418/],
			["Is our invoice overdue this week?", /INV-20418/],
			["What is overdue?", /Launch plan/],
			["Are we hiring?", /Offer approval/],
			["What did Marcus offer for the Stratus renewal?", /Renewal: Stratus/],
		];
		for (const [question, subject] of stored) {
			const got = d.call("POST", "/api/v1/ask", { question }).body as Row;
			expect(got.semantic, question).toBe(true);
			expect(subject.test(got.citations[0].subject), question).toBe(true);
		}
	});

	it("opens the agent panel with a stored conversation whose draft exists", () => {
		const d = start();
		const history = d.get(`/agents/email-agent/${encodeURIComponent(MAYA)}/get-messages`);
		expect(history).toHaveLength(4);
		expect(d.get(`${mb()}/emails/${AGENT_DRAFT_ID}`)).toMatchObject({ folder_id: "draft", recipient: "priya@brightcup.example" });
		expect(agentHistory(d.store, "support@northwind.example")).toEqual([]);
	});

	it("answers agent prompts from the mailbox and only ever drafts", () => {
		const d = start();
		const unread = agentReply(d.store, MAYA, "Any unread emails?");
		expect(unread.some((p) => p.type === "tool-list_emails")).toBe(true);
		expect(unread.at(-1)?.text).toMatch(/unread/);

		const sentBefore = d.get(`${mb()}/folders`).find((f: Row) => f.id === "sent").totalCount;
		const reply = agentReply(d.store, MAYA, "Draft a response to the latest email");
		const tool = reply.find((p) => p.type === "tool-draft_reply")!;
		const draftId = (tool.output as Row).draftId;
		expect(d.get(`${mb()}/emails/${draftId}`).folder_id).toBe("draft");
		expect(d.get(`${mb()}/folders`).find((f: Row) => f.id === "sent").totalCount).toBe(sentBefore);
	});
});

describe("demo response headers", () => {
	/** `_headers` as path block -> the lines under it, in file order. */
	const blocks: [string, string[]][] = [];
	for (const line of readFileSync(fileURLToPath(new URL("../scripts/demo-site/static/_headers", import.meta.url)), "utf8").split("\n")) {
		if (!line.trim() || line.startsWith("#")) continue;
		if (!/^\s/.test(line)) blocks.push([line.trim(), []]);
		else blocks[blocks.length - 1][1].push(line.trim());
	}
	const block = (path: string) => blocks.find(([p]) => p === path)?.[1] ?? [];

	it("tells the proxy not to rewrite pages, so nothing can be added to them on the way out", () => {
		const cache = block("/*").filter((l) => l.startsWith("Cache-Control:"));
		expect(cache).toHaveLength(1);
		expect(cache[0]).toContain("no-transform");
	});

	it("gives hashed assets their own cache rule, not one joined onto the pages' rule", () => {
		// Rules apply in file order and a repeated header is joined with a comma,
		// so the assets block has to come after `/*` and drop its value first.
		expect(blocks.map(([p]) => p)).toEqual(["/*", "/assets/*"]);
		expect(block("/assets/*")).toEqual(["! Cache-Control", "Cache-Control: public, max-age=31536000, immutable"]);
	});

	it("lets the page load scripts and data only from itself", () => {
		const csp = block("/*").find((l) => l.startsWith("Content-Security-Policy:")) ?? "";
		expect(csp).toContain("script-src 'self' 'unsafe-inline';");
		expect(csp).toContain("connect-src 'self' blob: data:;");
		expect(csp).not.toMatch(/cloudflareinsights|google-analytics|googletagmanager|clarity/);
	});
});
