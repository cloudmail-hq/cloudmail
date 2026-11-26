/**
 * The demo's stand-in for the Worker API. It answers the paths the app calls
 * (`/api/v1/*`, `/api/auth/*`, `/agents/*`) from the data in memory, so no
 * request leaves the page.
 *
 * Three kinds of answer:
 *   - mail reads and local changes go to the store (store.ts);
 *   - anything that would send mail is refused with SENDING_OFF;
 *   - settings that reach outside the mailbox (Cloudflare, domains, accounts,
 *     tokens, passwords, two-factor, licence) are readable and refuse writes.
 */

import { agentHistory, ask, buildBrief, extractSummary, keywords, relatedHits } from "./ai";
import type { DemoFiles } from "./files";
import { DemoError, type DemoStore, demoId, type Row } from "./store";

export const SENDING_OFF = "Sending is turned off in the demo.";
export const READ_ONLY = "This is read-only in the demo. Nothing here is saved.";

export interface DemoResponse {
	status: number;
	body?: unknown;
	blob?: Blob;
}

const ok = (body: unknown, status = 200): DemoResponse => ({ status, body });
const noContent = (): DemoResponse => ({ status: 204 });
const refuse = (error: string): DemoResponse => ({ status: 403, body: { error, code: "demo_read_only" } });
const notFound = (error = "Not available in the demo."): DemoResponse => ({ status: 404, body: { error } });

const bool = (v: string | null): boolean | undefined => (v === null ? undefined : v === "true" || v === "1");
const int = (v: string | null): number | undefined => (v === null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));

function isObject(v: unknown): v is Row {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Apply a settings patch the way the API does: objects merge, everything else replaces. */
function merge(target: Row, patch: unknown): Row {
	if (!isObject(patch)) return target;
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		if (isObject(v) && isObject(target[k])) merge(target[k], v);
		else target[k] = v;
	}
	return target;
}

function base64ToBytes(content: string): Uint8Array {
	const binary = atob(content.replace(/^data:[^,]*,/, "").replace(/\s+/g, ""));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/** Paths whose writes reach outside the mailbox: readable, never changed. */
const PROTECTED = [
	/^\/api\/auth\//,
	/^\/api\/v1\/(cloudflare|domains|licence|access|account|webhooks|agent-inboxes|products|branding|groups|sending-health|usage|templates|sequences|suppressions)(\/|$)/,
	/^\/api\/v1\/ai\/(providers|routing)(\/|$)/,
	/^\/api\/v1\/push\/(subscriptions|test)$/,
];

/** Mailbox sub-resources that are plain lists of rows with an `id`. */
const ROW_LISTS = new Set(["signatures", "rules", "blocked-senders", "allowed-senders"]);

export class DemoBackend {
	private briefDismissed = false;
	private tracking = new Map<string, Row>();

	constructor(
		readonly store: DemoStore,
		readonly files: DemoFiles,
		private timeZone = "UTC",
	) {
		const assistant = this.store.fixed["/api/v1/me/assistant"];
		if (isObject(assistant?.brief)) merge(assistant.brief, { enabled: true, timeZone: this.timeZone });
	}

	/** Answer one request. Never throws: a failure becomes an error response. */
	handle(method: string, url: URL, body: unknown): DemoResponse {
		try {
			return this.route(method.toUpperCase(), url, body);
		} catch (e) {
			if (e instanceof DemoError) return { status: e.status, body: { error: e.message, ...(e.code ? { code: e.code } : {}) } };
			console.error("demo backend:", e);
			return { status: 500, body: { error: "The demo could not answer that." } };
		}
	}

	private route(method: string, url: URL, body: unknown): DemoResponse {
		const path = url.pathname.replace(/\/+$/, "");
		const q = url.searchParams;
		const read = method === "GET" || method === "HEAD";

		if (path.startsWith("/agents/")) return this.agents(path, read);

		const mailbox = path.match(/^\/api\/v1\/mailboxes\/([^/]+)(?:\/(.*))?$/);
		if (mailbox) {
			const id = decodeURIComponent(mailbox[1]);
			const rest = (mailbox[2] ?? "").split("/").filter(Boolean).map(decodeURIComponent);
			return this.mailbox(method, id, rest, q, isObject(body) ? body : {});
		}

		if (!read && PROTECTED.some((p) => p.test(path))) {
			// Starting a sequence sends mail; say that rather than "read-only".
			if (/^\/api\/v1\/(sequences\/[^/]+\/enroll|push\/test|domains\/[^/]+\/sending\/test)$/.test(path)) return refuse(SENDING_OFF);
			// The composer asks which recipients are suppressed before it sends.
			if (path === "/api/v1/suppressions/check") return ok({ items: [] });
			return refuse(READ_ONLY);
		}

		switch (path) {
			case "/api/v1/mailboxes":
				return read ? ok(this.store.mailboxes(q.get("include") === "settings")) : refuse(READ_ONLY);
			case "/api/v1/me":
				// "dev" is the app's own no-session method: it hides sign-out and the
				// forms that need a signed-in browser (passkeys, export, deletion).
				return ok({ ...this.store.fixed[path], authMethod: "dev" });
			case "/api/v1/licence":
				return ok(this.licence());
			case "/api/v1/system/status":
				return ok(this.systemStatus());
			case "/api/v1/ai/semantic":
				return ok({ available: true, bound: true, enabled: true });
			case "/api/v1/push/vapid-key":
				return refuse("Notifications are turned off in the demo.");
			case "/api/v1/account/deletion":
				return ok({ pending: false });
			case "/api/v1/ask":
				return ok(ask(this.store, isObject(body) ? body : {}));
			case "/api/v1/search": {
				const query = q.get("q") ?? "";
				const found = this.store.searchAll(query, int(q.get("limit")));
				if (found.results.length > 0) return ok(found);
				return ok(this.store.relatedAll(relatedHits(this.store, query, undefined, 10), keywords(query), int(q.get("limit"))));
			}
			case "/api/v1/inbox":
				return ok(
					this.store.unifiedInbox({
						folder: q.get("folder") ?? undefined,
						limit: int(q.get("limit")),
						cursor: q.get("cursor") ?? undefined,
						product: q.getAll("product").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean),
						unread: bool(q.get("unread")),
					}),
				);
			case "/api/v1/me/brief":
				return ok(this.brief());
			case "/api/v1/me/brief/generate":
				this.briefDismissed = false;
				return ok(this.brief());
			case "/api/v1/people":
				return ok(this.people(q.get("search")));
			// Preferences a visitor can flip for the length of the visit.
			case "/api/v1/preferences":
			case "/api/v1/me/assistant":
			case "/api/v1/ai/settings":
			case "/api/v1/privacy":
			case "/api/v1/push/preferences": {
				const current = this.store.fixed[path];
				if (!isObject(current)) return notFound();
				return ok(read ? current : merge(current, body));
			}
		}

		if (/^\/api\/v1\/me\/brief\/[^/]+\/dismiss$/.test(path)) {
			this.briefDismissed = true;
			return ok({ status: "dismissed" });
		}
		if (path.startsWith("/api/v1/analytics/")) return this.analytics(path, q);
		if (/^\/api\/v1\/people\/[^/]+\/emails$/.test(path)) return ok(this.store.fixed[path] ?? { emails: [], total: 0 });

		if (read) {
			const fixed = this.store.fixed[path + url.search] ?? this.store.fixed[path];
			return fixed === undefined ? notFound() : ok(fixed);
		}
		return refuse(READ_ONLY);
	}

	// ── instance-wide ───────────────────────────────────────────────

	/** What Settings shows on a licensed deployment. The demo has no licence check to pass. */
	private licence(): Row {
		const now = Math.round(Date.parse(this.store.now()) / 1000);
		const domains: string[] = this.store.fixed["/api/v1/config"]?.domains ?? [];
		return {
			...this.store.fixed["/api/v1/licence"],
			status: "active",
			locked: false,
			plan: "cloudmail",
			planName: "unlimited",
			expiresAt: now + 30 * 86_400,
			lastRefreshAt: now - 3 * 3600,
			failureCount: 0,
			graceDaysLeft: null,
			serverReason: null,
			customerEmail: this.store.owner,
			instances: 1,
			maxDomains: null,
			maxDeployments: 1,
			upgradeAvailable: false,
			manageUrl: "https://trycloudmail.com/pricing",
			host: "demo",
			movedFrom: null,
			domains: { configured: domains, notCovered: [] },
		};
	}

	private systemStatus(): Row {
		const status = this.store.fixed["/api/v1/system/status"] ?? { ok: true, checks: [] };
		// The recording comes from an offline instance with no AI bindings.
		return { ...status, ok: true, checks: (status.checks ?? []).map((c: Row) => ({ ...c, ok: true, detail: null })) };
	}

	private brief(): Row {
		const prefs = this.store.fixed["/api/v1/me/assistant"]?.brief ?? {};
		if (prefs.enabled === false) return { brief: null, dismissed: false, nextRunAt: null };
		const now = Date.parse(this.store.now());
		return {
			brief: buildBrief(this.store, now, prefs.timeZone || this.timeZone, prefs.time || "07:00"),
			dismissed: this.briefDismissed,
			nextRunAt: null,
		};
	}

	private people(search: string | null): unknown {
		const recorded = this.store.fixed["/api/v1/people"];
		const needle = search?.trim().toLowerCase();
		if (!needle || !Array.isArray(recorded?.people)) return recorded ?? { people: [], total: 0 };
		const people = recorded.people.filter((p: Row) => JSON.stringify([p.name, p.email, p.emails]).toLowerCase().includes(needle));
		return { ...recorded, people, total: people.length };
	}

	private analytics(path: string, q: URLSearchParams): DemoResponse {
		const days = ["7", "30", "90"].includes(q.get("days") ?? "") ? q.get("days") : "30";
		const scope = q.get("scope") === "mine" ? "mine" : "all";
		const key = path.endsWith("/overview") ? `${path}?days=${days}&scope=${scope}` : `${path}?days=${days}`;
		const data = this.store.fixed[key];
		return data === undefined ? notFound() : ok(data);
	}

	private agents(path: string, read: boolean): DemoResponse {
		const m = path.match(/^\/agents\/email-agent\/([^/]+)\/get-messages$/);
		if (m && read) return ok(agentHistory(this.store, decodeURIComponent(m[1])));
		return notFound();
	}

	// ── one mailbox ─────────────────────────────────────────────────

	private mailbox(method: string, id: string, rest: string[], q: URLSearchParams, body: Row): DemoResponse {
		const s = this.store;
		const box = s.box(id);
		const read = method === "GET" || method === "HEAD";
		const [a, b, c, d] = rest;

		if (!a) {
			if (read) return ok(box.mailbox);
			if (method === "PUT") {
				box.mailbox.settings = merge(box.mailbox.settings ?? {}, body.settings);
				return ok(box.mailbox);
			}
			return refuse(READ_ONLY);
		}

		const listQuery = () => ({
			folder: q.get("folder") ?? undefined,
			threaded: bool(q.get("threaded")),
			page: int(q.get("page")),
			limit: int(q.get("limit")),
			sortColumn: q.get("sortColumn") ?? undefined,
			sortDirection: q.get("sortDirection") ?? undefined,
			unread: bool(q.get("unread")),
			starred: bool(q.get("starred")),
			has_attachment: bool(q.get("has_attachment")),
		});

		switch (a) {
			case "emails": {
				if (!b) return read ? ok(s.listEmails(id, listQuery())) : refuse(SENDING_OFF);
				if (b === "bulk" && method === "POST") return ok(s.bulk(id, body));
				return this.email(method, id, b, c, d, q, body);
			}
			case "drafts": {
				if (method !== "POST") return notFound();
				const replace = body.replace_attachments === true && Array.isArray(body.attachments);
				const attachments = replace
					? (body.attachments as Row[]).map((att) => {
							const bytes = base64ToBytes(String(att.content ?? ""));
							const attId = demoId("att");
							const mimetype = String(att.type || "application/octet-stream");
							this.files.put(attId, bytes, mimetype);
							return {
								id: attId,
								filename: String(att.filename || "file"),
								mimetype,
								size: bytes.length,
								content_id: att.contentId ?? null,
								disposition: att.disposition === "inline" ? "inline" : "attachment",
							};
						})
					: undefined;
				const { row, created } = s.saveDraft(id, body, attachments);
				return ok({ id: row.id, status: "draft", subject: row.subject, recipient: row.recipient, date: row.date }, created ? 201 : 200);
			}
			case "threads": {
				if (!b) return notFound();
				if (!c) return read ? ok(s.getThread(id, b, q.get("folder") ?? undefined)) : notFound();
				if (c === "read") {
					s.markThreadRead(id, b);
					return ok({ status: "ok" });
				}
				if (c === "mute") return ok(s.mute(id, b, method !== "DELETE"));
				if (c === "summary") {
					if (!d) return ok({ summary: s.summary(id, b) });
					if (d === "refresh") return ok({ queued: false });
					if (d === "generate") return ok({ summary: extractSummary(s, id, b) });
				}
				return notFound();
			}
			case "folders": {
				if (!b) return read ? ok(s.listFolders(id)) : ok(s.createFolder(id, String(body.name ?? "")), 201);
				if (method === "PUT") return ok(s.renameFolder(id, b, String(body.name ?? "")));
				if (method === "DELETE") return ok(s.deleteFolder(id, b));
				return notFound();
			}
			case "labels": {
				if (!b) return read ? ok(s.listLabels(id)) : ok(s.createLabel(id, body), 201);
				if (c === "emails") return ok(s.labelEmails(id, b, listQuery()));
				if (c === "prompt") {
					const label = (box.extra["label-prompts"]?.labels ?? []).find((l: Row) => l.id === b);
					if (label) merge(label, body);
					return ok(label ?? {});
				}
				if (method === "PUT") return ok(s.updateLabel(id, b, body));
				if (method === "DELETE") {
					s.deleteLabel(id, b);
					return noContent();
				}
				return notFound();
			}
			case "search": {
				const query = q.get("query") ?? q.get("q") ?? "";
				const found = s.search(id, query, int(q.get("page")), int(q.get("limit")));
				if (found.totalCount > 0 || (int(q.get("page")) ?? 1) > 1) return ok(found);
				// A question rarely matches word for word: show the mail it is about.
				return ok(s.related(id, relatedHits(s, query, id, 10), keywords(query)));
			}
			case "state":
				return ok(s.state(id));
			case "mark-all-read":
				return ok({ affected: s.markAllRead(id, body) });
			case "trash":
				return b === "empty" && method === "POST" ? ok({ deleted: s.emptyTrash(id) }) : notFound();
			case "muted-threads":
				return ok(s.mutedThreads(id));
			case "scheduled-sends": {
				if (!b) return read ? ok(s.scheduledSends(id)) : refuse(SENDING_OFF);
				if (method === "DELETE") return ok(s.cancelScheduled(id, b));
				return refuse(SENDING_OFF);
			}
			case "followups":
				return ok({ followups: Object.values(box.followups).filter((f) => f.status === "pending") });
			case "approvals": {
				if (!read) return refuse(c === "approve" || c === "retry" ? SENDING_OFF : READ_ONLY);
				if (!b) return ok(box.extra[`approvals?status=${q.get("status") === "all" ? "all" : "pending"}`] ?? { approvals: [] });
				const one = box.extra[`approvals/${b}`];
				return one === undefined ? notFound("Approval not found") : ok(one);
			}
			case "settings": {
				if (b !== "tracking") return notFound();
				const current =
					this.tracking.get(box.id) ??
					({ ...(box.extra["settings/tracking"] ?? { openTracking: true, clickTracking: true, attachmentTracking: false, disclosureEnabled: false, disclosureText: null }) } as Row);
				this.tracking.set(box.id, current);
				return ok(read ? current : merge(current, body));
			}
			case "send-limits": {
				const limits = box.extra["send-limits"];
				if (!read && isObject(limits?.caps)) merge(limits.caps, body);
				return limits === undefined ? notFound() : ok(limits);
			}
			case "screener": {
				if (!b) return read ? ok({ senders: s.screenerSenders(id) }) : notFound();
				if (method !== "POST") return notFound();
				if (body.decision !== "allow" && body.decision !== "block") throw new DemoError(400, "Choose yes or no.");
				return ok(s.screen(id, b, body.decision, body.target === "trash" ? "trash" : "spam"));
			}
			case "imports":
				return read ? ok({ imports: [] }) : refuse(READ_ONLY);
			case "export":
				return refuse(READ_ONLY);
		}

		if (ROW_LISTS.has(a)) return this.rows(method, box.extra, a, b, c, body);

		// Everything else was recorded as the answer to one GET.
		if (read) {
			const key = rest.join("/");
			const data = box.extra[key];
			return data === undefined ? notFound() : ok(data);
		}
		return refuse(READ_ONLY);
	}

	/** Signatures, rules and sender lists: small lists a visitor can edit for the visit. */
	private rows(method: string, extra: Record<string, any>, key: string, id: string | undefined, sub: string | undefined, body: Row): DemoResponse {
		const list: Row[] = Array.isArray(extra[key]) ? extra[key] : [];
		extra[key] = list;
		if (method === "GET") return ok(list);
		if (!id && method === "POST") {
			const row: Row = { ...body, id: demoId(key.slice(0, 3)), created_at: this.store.now() };
			if (key === "signatures" && row.is_default) for (const r of list) r.is_default = false;
			if (key === "rules") row.sort_order = list.length;
			list.push(row);
			return ok(row, 201);
		}
		if (id === "reorder" && method === "POST") {
			const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
			list.sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id));
			list.forEach((r, i) => {
				r.sort_order = i;
			});
			return ok({ updated: list.length });
		}
		const at = list.findIndex((r) => r.id === id);
		if (at < 0 || sub) return notFound("Not found");
		if (method === "PUT" || method === "PATCH") {
			if (key === "signatures" && body.is_default) for (const r of list) r.is_default = false;
			return ok(merge(list[at], body));
		}
		if (method === "DELETE") {
			list.splice(at, 1);
			return noContent();
		}
		return notFound();
	}

	private email(method: string, mailboxId: string, id: string, sub: string | undefined, leaf: string | undefined, q: URLSearchParams, body: Row): DemoResponse {
		const s = this.store;
		const read = method === "GET" || method === "HEAD";
		if (!sub) {
			if (read) return ok(s.getEmail(mailboxId, id));
			if (method === "PUT") return ok(s.updateEmail(mailboxId, id, body));
			if (method === "DELETE") return ok({ status: s.deleteEmail(mailboxId, id, q.get("permanent") === "1") });
			return notFound();
		}
		switch (sub) {
			case "restore":
				s.restoreEmail(mailboxId, id);
				return ok({ status: "restored" });
			case "move":
				s.moveEmail(mailboxId, id, String(body.folderId ?? ""));
				return ok({ status: "moved" });
			case "labels":
				return ok(read ? s.emailLabels(mailboxId, id) : s.setEmailLabels(mailboxId, id, Array.isArray(body.label_ids) ? body.label_ids : []));
			case "snooze":
				return ok(method === "DELETE" ? s.unsnooze(mailboxId, id) : s.snooze(mailboxId, id, body));
			case "priority":
				return ok(s.setPriority(mailboxId, id, body.priority ?? null));
			case "not-spam":
				return ok(s.notSpam(mailboxId, id));
			case "delivery-events":
				return ok({ events: s.deliveryEvents(mailboxId, id) });
			case "followup":
				return this.followup(method, mailboxId, id, leaf, body);
			case "attachments": {
				const attachment = (s.getEmail(mailboxId, id).attachments ?? []).find((x: Row) => x.id === leaf);
				if (!attachment) return notFound("Attachment not found");
				return { status: 200, blob: this.files.blob(attachment) };
			}
			// Reply and forward are sends under another name.
			case "reply":
			case "forward":
				return refuse(SENDING_OFF);
		}
		return notFound();
	}

	private followup(method: string, mailboxId: string, emailId: string, leaf: string | undefined, body: Row): DemoResponse {
		const box = this.store.box(mailboxId);
		const existing = box.followups[emailId];
		if (method === "GET") return existing ? ok(existing) : notFound("No follow-up reminder");
		if (leaf === "cancel") {
			if (!existing) return notFound("No follow-up reminder");
			delete box.followups[emailId];
			return ok({ ...existing, status: "cancelled", resolved_at: this.store.now() });
		}
		const email = this.store.getEmail(mailboxId, emailId);
		const now = Date.parse(this.store.now());
		const at = typeof body.at === "string" ? Date.parse(body.at) : now + Math.max(60, Number(body.delay_seconds) || 86_400) * 1000;
		if (!Number.isFinite(at) || at <= now) throw new DemoError(400, "Pick a time in the future.");
		const view = {
			email_id: emailId,
			thread_id: email.thread_id ?? emailId,
			followup_at: new Date(at).toISOString(),
			followup_mode: "manual",
			status: "pending",
			duration_seconds: Math.round((at - now) / 1000),
			created_at: this.store.now(),
			fired_at: null,
			resolved_at: null,
			surfaced_email_id: null,
			subject: email.subject ?? null,
			recipient: email.recipient ?? null,
			sent_at: email.date ?? null,
		};
		box.followups[emailId] = view;
		return ok(view);
	}
}
