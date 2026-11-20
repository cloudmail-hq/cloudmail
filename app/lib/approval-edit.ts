// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Pure helpers behind editing a held send on the Pending approval screen
 * (app/routes/mail-approvals.tsx): turning a stored message into an editable
 * draft, and a draft back into the PATCH body with only what changed.
 */

import type { HeldMessage, SendApprovalEdits } from "~/services/api";

export interface ApprovalDraft {
	to: string;
	cc: string;
	subject: string;
	html: string;
}

export function parseAddressList(value: string): string[] {
	return value
		.split(/[,;\s]+/)
		.map((v) => v.trim())
		.filter(Boolean);
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** A plain-text body as paragraphs: blank lines split paragraphs, single newlines become <br>. */
export function textToHtml(text: string | null | undefined): string {
	const trimmed = (text ?? "").replace(/\r\n?/g, "\n").trim();
	if (!trimmed) return "";
	return trimmed
		.split(/\n{2,}/)
		.map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
		.join("");
}

/**
 * Whether the visual editor would change this HTML just by loading it. It keeps
 * paragraphs, lists, links, headings and simple tables, and drops inline styles,
 * layout divs, images and <style> blocks. Bodies like that open in HTML mode so
 * a one-word fix does not strip the formatting.
 */
export function needsHtmlMode(html: string): boolean {
	return /<(style|div|img|font|center|table[^>]*\bstyle=)|\sstyle\s*=|\sbgcolor\s*=|\salign\s*=/i.test(html);
}

export function draftFromMessage(m: HeldMessage): ApprovalDraft {
	return {
		to: m.to.join(", "),
		cc: m.cc.join(", "),
		subject: m.subject,
		html: m.html ?? textToHtml(m.text),
	};
}

/**
 * The edit body: only fields that changed. `baselines` are the forms the body
 * had before the user typed (the stored HTML, and the editor's own rendering of
 * it), so loading the body into the editor does not count as an edit.
 */
export function editsFromDraft(m: HeldMessage, d: ApprovalDraft, baselines: readonly string[]): SendApprovalEdits | null {
	const out: SendApprovalEdits = {};
	const to = parseAddressList(d.to);
	const cc = parseAddressList(d.cc);
	if (to.join(",") !== m.to.join(",")) out.to = to;
	if (cc.join(",") !== m.cc.join(",")) out.cc = cc;
	if (d.subject !== m.subject) out.subject = d.subject;
	if (!baselines.includes(d.html)) out.html = d.html;
	return Object.keys(out).length ? out : null;
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** A problem to show before saving, or null. The server checks again. */
export function draftProblem(d: ApprovalDraft): string | null {
	const to = parseAddressList(d.to);
	if (to.length === 0) return "Add at least one recipient in To.";
	const bad = [...to, ...parseAddressList(d.cc)].filter((a) => !EMAIL.test(a));
	if (bad.length) return `Not an email address: ${bad.join(", ")}`;
	if (!d.subject.trim()) return "Add a subject.";
	const hasMedia = /<(img|table|hr)\b/i.test(d.html);
	if (!hasMedia && !d.html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim()) return "The message body is empty.";
	return null;
}

/** The tab a deep-linked approval lives under. */
export function tabForStatus(status: string): "pending" | "sent" | "sent_unconfirmed" | "rejected" | "failed" | "all" {
	return status === "pending" || status === "sent" || status === "sent_unconfirmed" || status === "rejected" || status === "failed"
		? status
		: "all";
}
