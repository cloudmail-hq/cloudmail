/**
 * The demo's AI features: thread summaries, the daily brief, "Ask your
 * inbox" and the agent panel. Nothing here calls a model. Summaries and
 * answers are written by hand from the seeded mail (scripts/demo/demo-data.mjs)
 * and looked up; anything else is assembled from the mail in memory.
 */

import { type BriefThreadRow, briefRange, buildDailyBrief, type DailyBrief, type MailboxBriefData } from "../../shared/daily-brief";
import { messageHref } from "../../shared/semantic";
import { isRoleAddress } from "../lib/sender-display";
import { type DemoStore, htmlToText, type Row } from "./store";

// ── thread summaries ────────────────────────────────────────────────

/**
 * Summaries for the conversations the recorded data has none for, keyed by
 * mailbox and a piece of the subject. Each line states only what the mail says.
 */
const SUMMARIES: Record<string, [subject: string, line: string, bullets: string[]][]> = {
	"hello@harborline.example": [
		[
			"Wholesale enquiry: stoneware sets",
			"Oak & Olive, two homeware shops in Bath, asks for wholesale terms and the minimum order on stoneware.",
			["Zoe Chambers runs two shops in Bath", "Wants wholesale terms", "Asks for the minimum order"],
		],
		[
			"Gift guide feature",
			"Home Journal wants the pour-over kettle in its December gift guide; Sam sent two product shots.",
			["Mei Lin asked for two high-res shots by Friday", "Sam sent both", "Sam offered a lifestyle image too"],
		],
	],
	"maya@northwind.example": [
		[
			"The Supply Chain Brief",
			"Newsletter: trans-Pacific container rates fell for a fourth week and Rotterdam congestion is easing.",
			["Spot rates down four weeks running", "Rotterdam congestion easing", "Three ways small importers hedge January surcharges"],
		],
		[
			"Port Coffee Summit",
			"Invitation to the Port Coffee Summit in Rotterdam on Feb 11–12; early-bird passes close Dec 1.",
			["900 roasters, importers and equipment makers", "February 11–12, Rotterdam", "Early-bird closes December 1"],
		],
		[
			"Weekly firmware build report",
			"Firmware 2.4.0-rc3 passed all 412 tests; the next release candidate is due Tuesday.",
			["Boiler PID tuning regression fixed", "Two flaky grinder dose-timing tests quarantined", "Next release candidate: Tuesday"],
		],
		[
			"Holiday catalogue proofs",
			"Sam sent v2 catalogue proofs; Maya signed off with one fix on page 9.",
			["Cover swapped to the stoneware set, pricing fixed on page 6", "Printer needed sign-off by Wednesday noon", "Kettle on p. 9 should read \"1.0 L\""],
		],
		[
			"October NPS",
			"October NPS is 61, up 7 points; delivery windows are the main complaint.",
			["Drivers: faster technician visits and the new descaling guide", "Detractors mention delivery windows", "Raw responses attached"],
		],
		[
			"Q1 demand forecast",
			"Maya's Q1 forecast assumes 15% growth on S2 units; Lena will pull it into the board pack.",
			["15% growth on S2 units", "Soft launch of the S3 in March", "Lena says it lines up with her cash model"],
		],
		[
			"SSO for the warehouse tablets",
			"Tomás will move the warehouse tablets to SSO with passkeys next Tuesday; Maya approved.",
			["Tablets still share one password", "About a day of work, no cost", "Maya asked for a heads-up to the night shift"],
		],
		[
			"3x your B2B pipeline",
			"Cold outreach from Jordan Pike offering AI-personalised sales outreach; asks for a 15-minute call.",
			["Unsolicited sales pitch", "Asks for a call next week"],
		],
		[
			"Sample kit for Little Fern Bakery",
			"Little Fern, three bakeries in Portland, wants a sample kit before buying grinders; Maya approved it.",
			["Standard kit plus the decaf burrs", "Maya: add a printed dial-in guide", "Bakeries usually run lighter roasts"],
		],
		[
			"Warehouse weekly",
			"Warehouse weekly: 98.2% on-time, no mis-picks, two damage claims filed with Fjord.",
			["98.2% on-time, 0 mis-picks", "2 damaged-in-transit claims, both Fjord", "Cycle count on aisle C next Tuesday"],
		],
		[
			"Please welcome Elif",
			"Elif Demir joins the Newark warehouse as Inventory Coordinator on Monday.",
			["Five years at a regional food distributor", "Starts Monday"],
		],
		[
			"November payroll approved",
			"Payroll for Nov 1–15 was approved by Lena; 34 employees are paid on November 20.",
			["Approved by Lena Fischer", "34 employees", "Paid November 20"],
		],
		[
			"October cloud usage",
			"Stratus Cloud billed $312.48 for October to the card on file.",
			["$312.48 for October", "Already charged"],
		],
	],
	"sales@northwind.example": [
		[
			"Demo request: Copperleaf Coffee",
			"Copperleaf Coffee is replacing espresso machines at 12 locations next spring and wants a demo in early December.",
			["12 locations, next spring", "Wants to see the S2 and what comes next", "Asks for early December"],
		],
		[
			"Meridian Hotels: breakfast program",
			"Meridian Hotels sent a pre-RFP questionnaire ahead of its January RFP.",
			["Covers service SLAs, training and spare parts", "RFP planned for January", "Questionnaire attached"],
		],
		[
			"Pricing for 6 boutique hotels",
			"Lantern Stays asked for pricing on six S2s with a 3-year service plan; Daniel sent the quote.",
			["Six S2s with the 3-year Care plan", "Installation and barista training included", "They want to budget before year end"],
		],
		[
			"S3 early access",
			"Rafael Duarte wants to join the S3 early-access list; he has two shops and a roastery.",
			["Two shops and a roastery", "Offers real-world testing"],
		],
	],
	"support@northwind.example": [
		[
			"Grinder making a clicking noise",
			"Moretti Café's G1 grinder clicks at the finest settings; a reply is drafted but not sent.",
			["Grinder is 8 months old", "Draft: back the grind off two steps", "Draft: technician to recalibrate this week"],
		],
		[
			"invoice for order NW-30122",
			"Tidewater Coffee needs the invoice for order NW-30122 resent; it is missing from the portal.",
			["Two grinders, delivered Nov 4", "Their accountant needs it", "Not yet answered"],
		],
		[
			"Replacement portafilter gasket",
			"Elena ordered two group-head gaskets (SKU NW-GG58, $9 each) and confirmed the order.",
			["Can be ordered from Northwind directly", "Aiko added two to a draft order", "Elena replied yes"],
		],
		[
			"Return label for damaged milk jugs",
			"Three of twelve milk jugs arrived dented at Salt & Crumb; Aiko sent a return label and replacements.",
			["Return label RMA-5521", "Three new jugs ship today", "No need to wait for the return"],
		],
		[
			"Thank you!",
			"Café Lumen thanks the team: the technician fixed the machine and it is back to 9 bar.",
			["Machine back to 9 bar", "No reply needed"],
		],
		[
			"Training video link not working",
			"The \"Dialing in the S2\" video link was broken; Aiko sent the new one and fixed the welcome email.",
			["Videos moved last week", "New link: northwind.example/learn/dial-in", "Welcome email corrected"],
		],
		[
			"How often should we descale",
			"Isla Grant asks how often to descale an S2 in a hard-water area at about 300 shots a day.",
			["Hard-water area", "About 300 shots a day", "Not yet answered"],
		],
	],
	"team@northwindlabs.example": [
		[
			"Firmware 2.4 release notes",
			"Tomás shared draft release notes for firmware 2.4; comments are due Friday.",
			["Smarter boiler warm-up saves about 11 minutes each morning", "Dose-by-weight for the G1", "Quieter pump start"],
		],
		[
			"Pressure sensor calibration results",
			"Batch 11: 198 of 200 pressure sensors are within ±0.05 bar; two outliers come from one reel.",
			["198/200 within ±0.05 bar", "Both outliers from the same reel", "Nadia flagged it with the supplier"],
		],
	],
};

const OWN_FOLDERS = new Set(["sent", "draft", "scheduled"]);

/** Give every seeded conversation with inbound mail its stored summary. */
export function seedSummaries(store: DemoStore): void {
	for (const [mailboxId, entries] of Object.entries(SUMMARIES)) {
		if (!store.has(mailboxId)) continue;
		const conversations = store.conversations(mailboxId);
		for (const [subject, line, bullets] of entries) {
			const needle = subject.toLowerCase();
			const thread = conversations.find(
				(list) =>
					list.some((e) => !OWN_FOLDERS.has(e.folder_id)) &&
					list.some((e) => String(e.subject ?? "").toLowerCase().includes(needle)),
			);
			if (!thread) continue;
			const id = thread[0].thread_id ?? thread[0].id;
			if (!store.summary(mailboxId, id)) store.setSummary(mailboxId, id, line, bullets);
		}
	}
}

function firstSentence(text: string, max = 140): string {
	const clean = text.replace(/\s+/g, " ").trim();
	const cut = clean.match(/^.{20,}?[.!?](?=\s|$)/)?.[0] ?? clean;
	return cut.length > max ? `${cut.slice(0, max - 1).trimEnd()}…` : cut;
}

/** A summary for a conversation that has none stored, cut from its own text. */
export function extractSummary(store: DemoStore, mailboxId: string, threadId: string) {
	const existing = store.summary(mailboxId, threadId);
	if (existing?.line) return existing;
	const messages = store.getThread(mailboxId, threadId);
	if (messages.length === 0) return null;
	const texts = messages.map((m) => htmlToText(String(m.body ?? ""))).filter(Boolean);
	if (texts.length === 0) return null;
	const line = firstSentence(texts[texts.length - 1]);
	const bullets = texts.slice(-3).map((t) => firstSentence(t, 90));
	return store.setSummary(mailboxId, threadId, line, bullets);
}

// ── the daily brief ─────────────────────────────────────────────────

const HOUR = 3_600_000;

/** Today's brief, built from the mail in memory when it is asked for. */
export function buildBrief(store: DemoStore, now: number, timeZone: string, time: string): DailyBrief {
	// "New" is what arrived in the window the card says it covers.
	const { since } = briefRange(now, time, timeZone, true);
	const data: MailboxBriefData[] = store.order.map((mailboxId) => {
		const conversations = store.conversations(mailboxId);
		const lineOf = (threadId: string) => store.summary(mailboxId, threadId)?.line ?? null;
		const newMessages = conversations
			.flat()
			.filter((e) => e.folder_id === "inbox" && Date.parse(e.date) >= since)
			.map((e) => ({
				id: e.id,
				thread_id: e.thread_id ?? null,
				subject: e.subject ?? null,
				sender: e.sender ?? null,
				sender_name: e.sender_name ?? null,
				date: e.date,
				read: !!e.read,
				starred: !!e.starred,
				priority: e.priority ?? null,
				bulk: isRoleAddress(String(e.sender ?? "")),
				summary_line: lineOf(e.thread_id ?? e.id),
			}));
		const needsReply: BriefThreadRow[] = [];
		const waitingOn: BriefThreadRow[] = [];
		for (const list of conversations) {
			const live = list.filter((e) => e.folder_id !== "draft" && e.folder_id !== "scheduled");
			const latest = live[live.length - 1];
			if (!latest) continue;
			const threadId = latest.thread_id ?? latest.id;
			// Recent mail from a person that has been opened and not answered.
			if (latest.folder_id === "inbox" && latest.read && !isRoleAddress(String(latest.sender ?? "")) && Date.parse(latest.date) > now - 4 * 24 * HOUR) {
				needsReply.push({
					id: latest.id,
					thread_id: threadId,
					subject: latest.subject ?? null,
					who: latest.sender ?? null,
					who_name: latest.sender_name ?? null,
					date: latest.date,
					summary_line: lineOf(threadId),
				});
			} else if (latest.folder_id === "sent" && live.length > 1 && Date.parse(latest.date) > now - 7 * 24 * HOUR) {
				// A reply of ours that nobody has answered yet.
				waitingOn.push({
					id: latest.id,
					thread_id: threadId,
					subject: latest.subject ?? null,
					who: String(latest.recipient ?? "").split(",")[0]?.trim() || null,
					who_name: null,
					date: latest.date,
					summary_line: lineOf(threadId),
				});
			}
		}
		return { mailbox: mailboxId, newMessages, newTruncated: false, needsReply, waitingOn, waitingSource: "derived" };
	});
	return buildDailyBrief({ data, now, time, timeZone, id: "brief_demo", throughNow: true });
}

// ── Ask your inbox ──────────────────────────────────────────────────

type Pick = [subject: string, which: "first" | "last" | number];

interface Topic {
	match: RegExp;
	answer: string;
	cite: Pick[];
}

/** Answers written from the owner's seeded mail. `[n]` points at `cite[n - 1]`. */
const TOPICS: Topic[] = [
	{
		match: /deadline|due\b|this week|attention|urgent|to.?do|priorit|what.*(need|should).*(do|reply|answer)/i,
		answer:
			"Five things have a date on them. Daniel needs your sign-off on the HostEx booth plan by tomorrow so he can place the power order on Monday [1]. " +
			"Lena needs the operations section of the board pack by Monday end of day [2]. " +
			"Kobayashi Steel's burr quote is valid until December 5 [3]. " +
			"The landlord wants an answer on the lease renewal by December 15 [4]. " +
			"Brightcup will sign today once you confirm the payment terms [5].",
		cite: [
			["Booth layout for HostEx", "last"],
			["Board pack draft", "last"],
			["Revised quote: conical burr", "last"],
			["Lease renewal: Unit 4B", "first"],
			["Q4 wholesale order", "last"],
		],
	},
	{
		match: /brightcup|priya|wholesale|net.?45|net.?30|payment terms|48 (units|machines)/i,
		answer:
			"Brightcup Roasters ordered 48 Model S2 machines and 12 grinder bundles for six cafés [1]. " +
			"You offered a December 9–11 install window and net-30 with a 2% early-payment discount [2]. " +
			"Priya accepted the dates. Her finance team asked for net-45, but she will sign today on net-30 with the discount, and she asked for Daniel to send the install checklist [3].",
		cite: [
			["Q4 wholesale order", 0],
			["Q4 wholesale order", 1],
			["Q4 wholesale order", "last"],
		],
	},
	{
		match: /fjord|pickup|pick-up|pallet|truck|bill of lading|freight/i,
		answer:
			"Fjord Freight confirmed the pickup for Monday at 7:30 AM at the Newark distribution centre, dock 3. Two trucks are coming for the 14 pallets, and the bill of lading is attached. The driver's name and number follow the evening before [1].",
		cite: [["Pickup confirmed", "last"]],
	},
	{
		match: /hostex|booth|chicago|trade show|expo/i,
		answer:
			"The HostEx booth is a 20×20 corner spot with two demo stations and a meeting area at the back [1]. " +
			"Version 3 moves the espresso bar to the front and puts the S3 in a display case. Daniel needs a thumbs-up by tomorrow, because he places the power order on Monday [2].",
		cite: [
			["Booth layout for HostEx", "first"],
			["Booth layout for HostEx", "last"],
		],
	},
	{
		match: /lease|rent\b|landlord|unit 4b|riverside|marcus/i,
		answer:
			"Riverside Trade Park offered a three-year renewal on Unit 4B at a 4% increase, with two months rent-free if you go ahead with the mezzanine fit-out. The current lease expires March 31 and Marcus asked for an answer by December 15 [1]. A reply asking about a five-year option at +3% is in Drafts and has not been sent.",
		cite: [["Lease renewal: Unit 4B", "first"]],
	},
	{
		match: /invoice|ledgerly|owe|bill\b|billing|\bpay(ment)?\b/i,
		answer:
			"Ledgerly invoice INV-20418 is for $1,240.00. It will be collected automatically on December 1 from the card ending 4402, so nothing needs doing [1].",
		cite: [["Invoice INV-20418", "last"]],
	},
	{
		match: /warranty|lumen|oskar|pump|pressure drop|loaner/i,
		answer:
			"Café Lumen's S2 (serial S2-04417) drops from 9 bar to about 6 halfway through every shot [1]. " +
			"It is under warranty until March. You shipped a replacement pump and booked a technician for Friday, and said you would look for a loaner for the weekend [2]. " +
			"Oskar replied that a loaner would save them, since Saturday is their busiest day [3].",
		cite: [
			["Warranty claim: Model S2", 0],
			["Warranty claim: Model S2", 1],
			["Warranty claim: Model S2", "last"],
		],
	},
	{
		match: /burr|kobayashi|hana|quote|supplier price/i,
		answer:
			"Kobayashi Steel offered $10.72 per conical burr set for a 2,000-unit commitment, down from $11.40. Lead time is eight weeks from deposit and the quote is valid until December 5. Hardness certificates for the new alloy follow this week [1].",
		cite: [["Revised quote: conical burr", "last"]],
	},
	{
		match: /board|lena|inventory turns|ops section|operations section/i,
		answer:
			"Lena's draft board pack shows revenue up 18% year on year and a 41% gross margin. She needs the operations section from you by Monday end of day: inventory turns, on-time delivery and warranty rate, two slides at most [1].",
		cite: [["Board pack draft", "last"]],
	},
	{
		match: /meridian|ruth|hotel|breakfast|rfp|grace/i,
		answer:
			"Grace Holt introduced you to Ruth Abara, who leads equipment procurement at Meridian Hotels and is reviewing breakfast-service coffee for 22 properties [1]. " +
			"Ruth agreed to a call on Tuesday at 2pm and said they aim to issue an RFP in January [2].",
		cite: [
			["Intro: Ruth Abara", "first"],
			["Intro: Ruth Abara", "last"],
		],
	},
];

const STOP = new Set(
	"about after again also been before being could does from have just know like made make many more most much need only other over said same should some such tell than that their them then there these they this those very want what when where which while will with would your mail email emails message messages inbox anyone anything".split(
		" ",
	),
);

function citation(n: number, mailboxId: string, e: Row) {
	return {
		n,
		mailbox: mailboxId,
		email_id: e.id,
		thread_id: e.thread_id ?? null,
		folder: e.folder_id ?? null,
		subject: e.subject || "(no subject)",
		from: e.sender ?? null,
		date: e.date ?? null,
		href: messageHref(mailboxId, e.folder_id ?? null, e.id),
	};
}

function respond(question: string, answer: string, hits: { mailboxId: string; email: Row }[], mailboxes: string[], semantic: boolean) {
	const citations = hits.map((h, i) => citation(i + 1, h.mailboxId, h.email));
	return {
		question,
		answer,
		insufficient: hits.length === 0,
		semantic,
		citations,
		sources: citations.map((c) => ({ n: c.n, mailboxId: c.mailbox, email_id: c.email_id, subject: c.subject, from: c.from, date: c.date })),
		mailboxes,
	};
}

/** The words of a plain-language question worth looking for. */
export function keywords(text: string): string[] {
	return [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [])].filter((w) => w.length > 3 && !STOP.has(w)).slice(0, 8);
}

/**
 * Messages related to a plain-language query that matched nothing word for
 * word: the ones that mention at least two of its words (one, for a short
 * query). Empty for a query that uses search operators.
 */
export function relatedHits(store: DemoStore, query: string, mailbox: string | undefined, limit: number) {
	if (/[a-z]:\S|"/i.test(query)) return [];
	// A question with a stored answer lists the messages that answer cites.
	const cited = topicHits(store, query, mailbox);
	if (cited) return cited.hits.map((h) => ({ ...h, score: 1 }));
	const words = keywords(query);
	const need = words.length >= 3 ? 2 : 1;
	return keywordHits(store, query, mailbox, limit).filter((h) => h.score >= need);
}

/** The messages that mention the most words of a plain-language question. */
export function keywordHits(store: DemoStore, text: string, mailbox: string | undefined, limit: number) {
	const words = keywords(text);
	const scores = new Map<string, { mailboxId: string; email: Row; score: number }>();
	for (const word of words) {
		for (const hit of store.find(word, 1000)) {
			if (mailbox && hit.mailboxId.toLowerCase() !== mailbox.toLowerCase()) continue;
			const key = `${hit.mailboxId}/${hit.email.id}`;
			const entry = scores.get(key) ?? { ...hit, score: 0 };
			entry.score += 1;
			scores.set(key, entry);
		}
	}
	return [...scores.values()]
		.sort((a, b) => b.score - a.score || Date.parse(b.email.date) - Date.parse(a.email.date))
		.slice(0, limit);
}

/** The stored answer a question matches, with the messages it cites, if they are all still there. */
function topicHits(store: DemoStore, question: string, mailbox: string | undefined) {
	const owner = store.owner.toLowerCase();
	// The stored answers are about the owner's mail.
	if (mailbox && mailbox.toLowerCase() !== owner) return null;
	const topic = TOPICS.find((t) => t.match.test(question));
	if (!topic) return null;
	const hits = topic.cite.map(([subject, which]) => {
		const found = store.bySubject(subject).filter((h) => h.mailboxId.toLowerCase() === owner && h.email.folder_id !== "draft");
		return which === "first" ? found[0] : which === "last" ? found[found.length - 1] : found[which];
	});
	// A visitor may have deleted the mail an answer rests on: then there is no stored answer.
	return hits.every(Boolean) ? { topic, hits: hits as { mailboxId: string; email: Row }[] } : null;
}

export function ask(store: DemoStore, body: { question?: unknown; mailbox?: unknown }) {
	const question = String(body.question ?? "").trim();
	const mailbox = typeof body.mailbox === "string" && store.has(body.mailbox) ? body.mailbox : undefined;
	const mailboxes = mailbox ? [mailbox] : store.order;

	const stored = topicHits(store, question, mailbox);
	if (stored) return respond(question, stored.topic.answer, stored.hits, mailboxes, true);

	const hits = keywordHits(store, question, mailbox, 3);
	if (hits.length === 0) {
		return respond(
			question,
			"Nothing in this mail answers that. The demo answers from the mail it ships with, so try asking about the Brightcup order, the HostEx booth, the Fjord pickup or the lease renewal.",
			[],
			mailboxes,
			false,
		);
	}
	const lines = hits.map((h, i) => {
		const line = store.summary(h.mailboxId, h.email.thread_id ?? h.email.id)?.line ?? firstSentence(htmlToText(String(h.email.body ?? "")));
		return `${line} [${i + 1}]`;
	});
	return respond(question, `These messages mention it. ${lines.join(" ")}`, hits, mailboxes, false);
}

// ── the agent panel ─────────────────────────────────────────────────

export interface AgentPart {
	type: string;
	text?: string;
	toolCallId?: string;
	state?: string;
	input?: unknown;
	output?: unknown;
}

export interface AgentMessage {
	id: string;
	role: "user" | "assistant";
	parts: AgentPart[];
}

/** The draft the stored conversation below ends with. */
export const AGENT_DRAFT_ID = "demo-draft-brightcup";

/**
 * The conversation the owner's panel opens with. The same one the README
 * screenshot uses (scripts/demo/agent-conversation.mjs).
 */
const STORED_CONVERSATION: AgentMessage[] = [
	{ id: "demo-u1", role: "user", parts: [{ type: "text", text: "What needs my attention this week?" }] },
	{
		id: "demo-a1",
		role: "assistant",
		parts: [
			{ type: "step-start" },
			{ type: "tool-list_emails", toolCallId: "call_demo_1", state: "output-available", input: { folder: "inbox", unread: true, limit: 25 }, output: { count: 6 } },
			{ type: "tool-search_emails", toolCallId: "call_demo_2", state: "output-available", input: { query: "deadline OR due OR by Friday" }, output: { count: 4 } },
			{ type: "step-start" },
			{
				type: "text",
				text:
					"Three things:\n\n" +
					"1. **Brightcup, 48 units**: Priya will sign today on net-30 with 2% early-pay if net-45 is a no.\n" +
					"2. **HostEx booth**: Daniel needs your OK on plan v3 by **tomorrow**.\n" +
					"3. **Board pack**: two ops slides for Lena by **Monday**.\n\n" +
					"Draft the reply to Priya?",
			},
		],
	},
	{ id: "demo-u2", role: "user", parts: [{ type: "text", text: "Yes. Net-30 with the 2% discount; Daniel sends the checklist." }] },
	{
		id: "demo-a2",
		role: "assistant",
		parts: [
			{ type: "step-start" },
			{ type: "tool-get_thread", toolCallId: "call_demo_3", state: "output-available", input: { subject: "Q4 wholesale order" }, output: { messages: 3 } },
			{ type: "tool-draft_reply", toolCallId: "call_demo_4", state: "output-available", input: { to: "priya@brightcup.example" }, output: { draftId: AGENT_DRAFT_ID, status: "draft_saved" } },
			{ type: "step-start" },
			{
				type: "text",
				text:
					"Saved to **Drafts**. Nothing was sent.\n\n" +
					"> Hi Priya, Dec 9–11 is confirmed. We'll stay at net-30, with 2% off if paid within 10 days. Daniel will send the install checklist today.",
			},
		],
	},
];

/** Put the draft the stored conversation refers to into the owner's Drafts. */
export function seedAgentDraft(store: DemoStore): void {
	const thread = store.bySubject("Q4 wholesale order").filter((h) => h.mailboxId === store.owner && h.email.folder_id === "inbox");
	const last = thread[thread.length - 1]?.email;
	if (!last) return;
	store.saveDraft(store.owner, {
		draft_id: AGENT_DRAFT_ID,
		to: last.sender,
		subject: `Re: ${String(last.subject ?? "").replace(/^re:\s*/i, "")}`,
		body: "<p>Hi Priya,</p><p>Dec 9–11 is confirmed. We'll stay at net-30, with 2% off if paid within 10 days. Daniel will send the install checklist today.</p><p>Maya</p>",
		in_reply_to: last.message_id ?? null,
		thread_id: last.thread_id ?? last.id,
	});
}

const histories = new Map<string, AgentMessage[]>();

/** A mailbox's conversation so far. Kept in memory, so a reload starts it over. */
export function agentHistory(store: DemoStore, mailboxId: string): AgentMessage[] {
	const key = mailboxId.toLowerCase();
	let list = histories.get(key);
	if (!list) {
		list = key === store.owner.toLowerCase() ? STORED_CONVERSATION.map((m) => ({ ...m })) : [];
		histories.set(key, list);
	}
	return list;
}

export function setAgentHistory(mailboxId: string, messages: AgentMessage[]): void {
	histories.set(mailboxId.toLowerCase(), messages);
}

let calls = 0;
const tool = (name: string, input: unknown, output: unknown): AgentPart => ({
	type: `tool-${name}`,
	toolCallId: `call_demo_live_${++calls}`,
	state: "output-available",
	input,
	output,
});

const who = (e: Row) => e.sender_name || String(e.sender ?? "").split("@")[0];

/** What the agent says to `text`: looked up in the mailbox, never generated. */
export function agentReply(store: DemoStore, mailboxId: string, text: string): AgentPart[] {
	const inbox = (store.listEmails(mailboxId, { folder: "inbox", threaded: true, limit: 50 }) as { emails: Row[] }).emails;
	const describe = (e: Row) => `- **${who(e)}**: ${e.summary_line ?? e.subject}`;

	if (/\b(draft|reply|respond|answer|write)\b/i.test(text)) {
		const named = keywordHits(store, text.replace(/\b(draft|reply|respond|response|answer|write|latest|email)\b/gi, ""), mailboxId, 1)[0]?.email;
		const target = named && named.folder_id === "inbox" ? named : inbox.find((e) => !isRoleAddress(String(e.sender ?? "")));
		if (target) {
			const first = String(who(target)).split(" ")[0];
			const quote = `Hi ${first}, thanks for your message. I've read it and will come back to you with a full answer today.`;
			const { row } = store.saveDraft(mailboxId, {
				to: target.sender,
				subject: `Re: ${String(target.subject ?? "").replace(/^re:\s*/i, "")}`,
				body: `<p>Hi ${first},</p><p>Thanks for your message. I've read it and will come back to you with a full answer today.</p>`,
				in_reply_to: target.message_id ?? null,
				thread_id: target.thread_id ?? target.id,
			});
			return [
				{ type: "step-start" },
				tool("get_thread", { subject: target.subject }, { messages: target.thread_count ?? 1 }),
				tool("draft_reply", { to: target.sender }, { draftId: row.id, status: "draft_saved" }),
				{ type: "step-start" },
				{
					type: "text",
					text: `Saved a reply to **${who(target)}** in **Drafts**. Nothing was sent, and sending is turned off in this demo.\n\n> ${quote}`,
				},
			];
		}
	}

	if (/\b(unread|new|latest|recent|inbox|attention|today|summar|catch me up|what'?s up)\b/i.test(text)) {
		const unreadOnly = /unread|new\b/i.test(text);
		const rows = (unreadOnly ? inbox.filter((e) => (e.thread_unread_count ?? 0) > 0) : inbox).slice(0, 5);
		const lead = rows.length === 0 ? "Nothing unread in this inbox." : unreadOnly ? `${rows.length} unread:` : "The latest in this inbox:";
		return [
			{ type: "step-start" },
			tool("list_emails", { folder: "inbox", unread: unreadOnly, limit: 25 }, { count: rows.length }),
			{ type: "step-start" },
			{ type: "text", text: [lead, "", ...rows.map(describe)].join("\n").trim() },
		];
	}

	const hits = keywordHits(store, text, mailboxId, 4);
	if (hits.length > 0) {
		return [
			{ type: "step-start" },
			tool("search_emails", { query: text }, { count: hits.length }),
			{ type: "step-start" },
			{
				type: "text",
				text: ["Here is what this mailbox has on that:", "", ...hits.map((h) => `- **${h.email.subject}**: ${store.summary(mailboxId, h.email.thread_id ?? h.email.id)?.line ?? firstSentence(htmlToText(String(h.email.body ?? "")))}`)].join("\n"),
			},
		];
	}

	return [
		{ type: "step-start" },
		{
			type: "text",
			text: "This demo agent works from the mail it ships with and does not call a model, so it can only do a few things. Try \"Any unread emails?\", \"Draft a response to the latest email\", or ask about a sender or a subject.",
		},
	];
}
