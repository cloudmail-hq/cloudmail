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
			"Dark theme for the widget?",
			"Marlow Labs asked for a dark widget; Sam explained the data-theme setting and Rosa confirmed it works.",
			["The widget stayed white in their dark mode", "Fix: data-theme=\"auto\" on the script tag", "Rosa confirmed it works"],
		],
		[
			"Come on Small Bets Radio",
			"Carys Vaughn invites Sam onto the Small Bets Radio podcast in January.",
			["A podcast about small software businesses", "Recording takes 40 minutes", "Not yet answered"],
		],
		[
			"Agency plan: 14 client changelogs",
			"Oak & Olive, a product studio in Bath, asks whether the Agency plan covers 14 client changelogs on the clients' own domains.",
			["14 client apps, each on the client's domain", "Asks whether the Agency plan covers it", "Wants separate billing per client"],
		],
		[
			"Embedding the widget in a React app",
			"Quiet Harbor's unread badge never updates inside their React app; Ines asks for a package or a hook.",
			["The script tag works on their marketing site", "In React the count shows once and never updates", "Not yet answered"],
		],
		[
			"Tools roundup feature",
			"Dev Journal wants Harborline in its December tools roundup; Sam sent two screenshots.",
			["Mei Lin asked for two high-res screenshots by Friday", "Sam sent both", "Sam offered one of the editor too"],
		],
	],
	"maya@northwind.example": [
		[
			"The Reliability Brief",
			"Newsletter: four of October's five largest outages started with a config change.",
			["Four of five big outages began with a config change", "Status pages get updated about 20 minutes late", "Three ways small teams run on-call without burnout"],
		],
		[
			"You're invited: DevOps North Summit",
			"Invitation to the DevOps North Summit in Rotterdam on Feb 11–12; early-bird passes close Dec 1.",
			["900 engineers, SREs and platform leads", "February 11–12, Rotterdam", "Early-bird closes December 1"],
		],
		[
			"Speak at DevOps North Summit",
			"Anders Holm asks Maya to speak again at DevOps North Summit; the call for proposals closes Dec 20.",
			["Last year's alert fatigue talk was the best-rated session", "A title and three lines holds a slot", "Snoozed until later this week"],
		],
		[
			"Nightly build report",
			"api 4.12.0-rc3 passed all 1,412 tests; the next release candidate is due Tuesday.",
			["Webhook retry regression fixed", "Two flaky SMS delivery-receipt tests quarantined", "Next release candidate: Tuesday"],
		],
		[
			"Harborline pricing page",
			"Sam sent v2 of the Harborline pricing page; Maya signed off with one fix to the Starter column.",
			["Agency plan moved into the main table, annual discount fixed", "Sam ships it Wednesday at noon", "Starter should read \"1,000 subscribers\""],
		],
		[
			"October NPS",
			"October NPS is 61, up 7 points; late SMS alerts are the main complaint.",
			["Drivers: faster support replies and the new on-call schedules", "Detractors mention late SMS alerts", "Raw responses attached"],
		],
		[
			"Q1 revenue forecast",
			"Maya's Q1 forecast assumes 15% growth in new ARR; Lena will pull it into the board deck.",
			["15% growth in new ARR", "On-call scheduling goes on sale in March", "Lena says it lines up with her cash model"],
		],
		[
			"SSO for the admin console",
			"Tomás will move the internal admin console to SSO with passkeys next Tuesday; Maya approved.",
			["The console still shares one password", "About a day of work, no cost", "Maya asked for a heads-up to the support team"],
		],
		[
			"Trial extension for Little Fern Studio",
			"Little Fern, a 12-person agency in Portland, wants two more trial weeks before buying; Maya approved it.",
			["Two more weeks plus an onboarding call", "Maya: set up a status page for one of their clients", "They are weighing the Team plan"],
		],
		[
			"Support weekly",
			"Support weekly: 96% of tickets answered within 2 hours, two escalations filed with Kobayashi.",
			["Median first reply 14 minutes", "2 escalations, both SMS delivery", "Help centre review next Tuesday"],
		],
		[
			"Please welcome Elif",
			"Elif Demir joins the support team as a Support Engineer on Monday.",
			["Five years on call at a payments company", "Starts Monday"],
		],
		[
			"October investor update",
			"Maya's October update: ARR up 6% and 41 new workspaces; Victor offers two CTO introductions.",
			["ARR up 6% on the month, 41 new paying workspaces", "One miss: a 40-minute alert delay, now fixed", "Victor can introduce two portfolio CTOs"],
		],
		[
			"November payroll approved",
			"Payroll for Nov 1–15 was approved by Lena; 28 employees are paid on November 20.",
			["Approved by Lena Fischer", "28 employees", "Paid November 20"],
		],
		[
			"October cloud usage",
			"Stratus Cloud billed $6,312.48 for October to the card on file.",
			["$6,312.48 for October", "Already charged"],
		],
		[
			"Completed: mutual NDA",
			"The mutual NDA with Meridian Hotels is signed by everyone; a copy is attached.",
			["Signed by both sides", "Copy attached"],
		],
		[
			"Postmortem: Oct 14",
			"Final postmortem for the Oct 14 notification delay: a certificate rotation the canary did not cover.",
			["Cause: certificate rotation on the push gateway", "Canary now sends a real push", "Rotation moved to Tuesday mornings"],
		],
		[
			"Offsite recap",
			"Nia shared notes and photos from the Lisbon offsite; the survey scored 4.7 out of 5.",
			["Roadmap notes and photos are in the shared folder", "Survey score 4.7 out of 5", "Top request: a longer hack day"],
		],
		[
			"renews in 49 days",
			"Three domains renew on January 14; auto-renew is on.",
			["Renewal date January 14", "Card on file ends 4402", "Nothing to do unless something should change"],
		],
	],
	"sales@northwind.example": [
		[
			"Signed: Sunroom Apps",
			"Sunroom Apps signed for 18 seats on the Team plan; onboarding is booked for Thursday at 10.",
			["Signed order form attached", "Starts on the 1st", "Onboarding call Thursday at 10"],
		],
		[
			"Budget opens in January",
			"Grant & Co liked the demo, but its budget is frozen until January 6; Isla asked for the 30-seat quote in the first week of January.",
			["Budget frozen until January 6", "Wants a quote for 30 seats", "Write again in the first week of January"],
		],
		[
			"Demo request: Copperleaf",
			"Copperleaf is replacing its paging tool across 12 engineering teams next spring and wants a demo in early December.",
			["12 engineering teams, next spring", "Wants to see on-call scheduling and what comes next", "Asks for early December"],
		],
		[
			"Meridian Hotels: security questionnaire",
			"Meridian Hotels sent a security questionnaire ahead of its January vendor review.",
			["Covers data residency, SSO, audit logs and incident response", "Vendor review planned for January", "Questionnaire attached"],
		],
		[
			"Pricing for 60 seats",
			"Lantern Stays asked for pricing on 60 Team seats with annual billing; Daniel sent the quote.",
			["60 seats, billed annually", "Onboarding and migration included", "They want to budget before year end"],
		],
		[
			"On-call scheduling early access",
			"Rafael Duarte wants early access to on-call scheduling; his team runs three rotations in two time zones.",
			["Three rotations across two time zones", "Offers real-world testing"],
		],
		[
			"How does Carter & Sons",
			"Ben Carter declined the cold email and asked to be removed; Daniel confirmed he was taken off the list.",
			["A four-person shop, not a fit", "Asked to be taken off the list", "Daniel removed him the same morning"],
		],
	],
	"support@northwind.example": [
		[
			"Status page shows incident times in UTC",
			"Tidewater Logistics wanted incident times in local time; Aiko pointed Kwame to the time zone setting and it worked.",
			["Customers are in Ghana, the page showed UTC", "Setting: Status page → Settings → Time zone", "Kwame confirmed it works"],
		],
		[
			"Export of last year's incidents",
			"Moretti Pay's auditors need last year's incidents; Elif pointed Luca to the CSV export and turned on the monthly export email.",
			["Incidents → Export gives a CSV for any date range", "Monthly export email turned on", "Luca confirmed it is what the auditors asked for"],
		],
		[
			"Pausing our plan over the holidays",
			"Kissa asks whether to pause the plan while its cafés are closed from December 24 to January 3.",
			["Closed December 24 to January 3", "Yuki needs an answer before the 20th", "Not yet answered"],
		],
		[
			"Webhook signature check failing",
			"Moretti Pay's endpoint rejects about one webhook in five on a signature mismatch; a reply is drafted but not sent.",
			["Started yesterday, nothing changed on their side", "Draft: keep the check on", "Draft: verify against the raw request body"],
		],
		[
			"Can't find the October invoice",
			"Tidewater Logistics needs the October invoice resent; it is missing under Billing.",
			["Workspace \"tidewater\", Team plan, 25 seats", "Their accountant needs it", "Not yet answered"],
		],
		[
			"Custom domain for our status page",
			"Elena set up a custom domain for the Petrova Labs status page with a CNAME; it is live.",
			["Custom domains are on every paid plan", "CNAME to pages.northwind.example", "Elena confirmed it works"],
		],
		[
			"Charged twice for November",
			"Salt & Crumb was charged $290 twice on November 1; Aiko refunded the second charge.",
			["The second charge was a retry", "Credit note CN-5521", "Refund reaches the card in three to five working days"],
		],
		[
			"Thank you!",
			"Grant & Co thanks the team: their status page went live the same afternoon.",
			["Elif ran the onboarding call", "Two customers already subscribed", "No reply needed"],
		],
		[
			"Quickstart link in the welcome email",
			"The quickstart link in the welcome email was broken; Aiko sent the new one and fixed the email.",
			["Docs moved last week", "New link: northwind.example/docs/quickstart", "Welcome email corrected"],
		],
		[
			"How many monitors on the Team plan",
			"Zoe asks how many monitors the Team plan includes and whether a three-region check counts once.",
			["About 60 services", "Each checked from three regions", "Not yet answered"],
		],
	],
	"team@northwindlabs.example": [
		[
			"Go SDK: name of the incidents client",
			"Nadia proposed naming the Go SDK client like the Python one; Tomás agreed.",
			["Options: Incidents() or NewIncidentClient()", "Decision: keep it the same as the Python SDK"],
		],
		[
			"Webhooks v2 switch-off",
			"Tomás plans to switch v2 webhooks off on March 1 and email the 41 workspaces still using them on December 2.",
			["41 workspaces still send to v2 endpoints", "Switch-off planned for March 1", "Check the list before the December 2 email"],
		],
		[
			"API 4.12 release notes",
			"Tomás shared draft release notes for API 4.12; comments are due Friday.",
			["Per-workspace webhook queues", "Idempotency keys on the incidents API", "A Go SDK"],
		],
		[
			"Rate limit on the incidents API",
			"Quillstack hit a 429 opening incidents from its deploy pipeline and asks how the rate limit is counted.",
			["60 requests a minute per token in the docs", "Asks whether it is per workspace or per token", "Wants it raised on the Team plan"],
		],
		[
			"Load test results",
			"Run 11: 198 of 200 windows stayed under 2 seconds from alert to page at 5× volume.",
			["198/200 windows under 2 seconds", "Both slow windows are during a database failover", "Nadia opened a ticket"],
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
	/** Covers many threads, so it is not checked against the mail a question names. */
	broad?: true;
}

/**
 * Answers written from the owner's seeded mail. `[n]` points at `cite[n - 1]`.
 * The first topic that fits a question answers it, so each pattern uses words
 * that belong to its own thread, and the one broad topic comes last.
 */
const TOPICS: Topic[] = [
	{
		match: /brightcup|priya|enterprise plan|net.?45|net.?30|payment terms|120 seats/i,
		answer:
			"Brightcup signed an order form for 120 Enterprise seats on an annual term, with SSO and the audit log [1]. " +
			"You offered onboarding for all six teams on December 9–11 and net-30 with a 2% early-payment discount [2]. " +
			"Priya accepted the dates. Her finance team asked for net-45, but she will sign today on net-30 with the discount, and she asked for Daniel to send the SSO setup checklist [3].",
		cite: [
			["Enterprise plan: Brightcup", 0],
			["Enterprise plan: Brightcup", 1],
			["Enterprise plan: Brightcup", "last"],
		],
	},
	{
		match: /soc ?2|fjord|attestation|audit report|bridge letter/i,
		answer:
			"Fjord Assurance finished the SOC 2 Type II attestation for May 1 to October 31 with no exceptions, and the report is attached. You can share it with customers under NDA, and Fjord will issue a bridge letter on request [1].",
		cite: [["SOC 2 Type II report", "last"]],
	},
	{
		match: /incident timeline|launch (page|plan)|newsletter slot|free tier/i,
		answer:
			"Daniel's launch page for Incident Timeline has a hero, three feature blocks, a customer quote and pricing [1]. " +
			"You decided to launch to Team and Enterprise on Tuesday and open the free tier a week later. Version 3 puts the live demo at the top. Daniel needs a thumbs-up by tomorrow, because he books the newsletter slot on Monday [2].",
		cite: [
			["Launch plan for Incident Timeline", "first"],
			["Launch plan for Incident Timeline", "last"],
		],
	},
	{
		match: /stratus (cloud )?(renewal|contract|commit|offer)|renewal (with|from|of) stratus|committed spend|cloud contract|marcus/i,
		answer:
			"Stratus Cloud offered a three-year commitment at 18% off list, against 9% on a one-year term, with $20,000 in credits if you go ahead with the database migration. The current contract ends March 31 and Marcus asked for an answer by December 15 [1]. A reply asking about a two-year term at 15% off is in Drafts and has not been sent.",
		cite: [["Renewal: Stratus Cloud", "first"]],
	},
	{
		// "The invoice" is this one, unless the question names another sender's.
		match: /ledgerly|inv-?20418|^(?!.*\b(stratus|october|88213|overdue invoice|final notice|spam|scam|phishing)\b).*\binvoice\b/i,
		answer:
			"Ledgerly invoice INV-20418 is for $1,240.00. It will be collected automatically on December 1 from the card ending 4402, so nothing needs doing [1].",
		cite: [["Invoice INV-20418", "last"]],
	},
	{
		match: /lumen|oskar|missed alerts/i,
		answer:
			"Lumen Health's API was down for 40 minutes on Saturday night and the first page reached on-call 40 minutes late [1]. " +
			"You told Oskar that alert webhooks had queued behind another customer's slow endpoint, that a fix shipped on Sunday, and that a month was credited [2]. " +
			"Oskar accepted a call and asked for a written postmortem by Friday for their compliance team [3].",
		cite: [
			["Missed alerts during Saturday", 0],
			["Missed alerts during Saturday", 1],
			["Missed alerts during Saturday", "last"],
		],
	},
	{
		match: /kobayashi|\bhana\b|sms (quote|credits?|pric)|voice alerts/i,
		answer:
			"Kobayashi Telecom offered $0.0107 per SMS for a commitment of 2 million credits a year, down from $0.0114. Voice call pricing stays as it is and the quote is valid until December 5. Delivery reports for the new Italian route follow this week [1].",
		cite: [["Revised quote: SMS and voice", "last"]],
	},
	{
		match: /board (deck|meeting)|product section|runway|net revenue retention/i,
		answer:
			"Lena's draft board deck shows ARR up 18% on the quarter, net revenue retention of 112% and 19 months of runway. She needs the product section from you by Monday end of day: uptime, the Incident Timeline launch and the Q1 roadmap, two slides at most [1].",
		cite: [["Board deck draft", "last"]],
	},
	{
		match: /\bruth\b|abara|grace holt|vendor review/i,
		answer:
			"Grace Holt introduced you to Ruth Abara, who leads platform engineering at Meridian Hotels and is reviewing incident tooling for 22 engineering teams [1]. " +
			"Ruth agreed to a call on Tuesday at 2pm and said they aim to start a vendor review in January [2].",
		cite: [
			["Intro: Ruth Abara", "first"],
			["Intro: Ruth Abara", "last"],
		],
	},
	{
		match: /offer approval|offer (to|for) jonas|jonas|weber|hiring|senior backend role/i,
		answer:
			"Nia wants to make an offer to Jonas Weber for the senior backend role. The panel gave four yes votes and one lean yes, and Tomás wants him on the alert pipeline. The offer is at the top of the band with a March start, and Nia needs your approval by Thursday because his other offer expires on Friday [1].",
		cite: [["Offer approval: senior backend", "last"]],
	},
	{
		broad: true,
		// Not a question about an invoice: those have their own answer, or none.
		match: /^(?!.*\binvoice\b).*(deadline|due\b|this week|attention|urgent|to.?do|priorit|what.*(need|should).*(do|reply|answer))/i,
		answer:
			"These have a date on them. Daniel needs your sign-off on the Incident Timeline launch page by tomorrow, so he can book the newsletter slot on Monday [1]. " +
			"Nia needs your approval by Thursday for the offer to Jonas Weber [2]. " +
			"Lena needs the product section of the board deck by Monday end of day [3]. " +
			"Oskar at Lumen Health asked for a written postmortem by Friday [4]. " +
			"Kobayashi Telecom's SMS quote is valid until December 5 [5]. " +
			"Brightcup will sign today once you confirm the payment terms [6].",
		cite: [
			["Launch plan for Incident Timeline", "last"],
			["Offer approval: senior backend", "last"],
			["Board deck draft", "last"],
			["Missed alerts during Saturday", "last"],
			["Revised quote: SMS and voice", "last"],
			["Enterprise plan: Brightcup", "last"],
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

/**
 * The stored answer for a question, with the messages it cites. A topic is
 * passed over when a visitor has deleted mail it rests on, or when the question
 * names other mail more closely than the mail the topic cites.
 */
function topicHits(store: DemoStore, question: string, mailbox: string | undefined) {
	const owner = store.owner.toLowerCase();
	// The stored answers are about the owner's mail.
	if (mailbox && mailbox.toLowerCase() !== owner) return null;
	const threadOf = (e: Row) => String(e.thread_id ?? e.id);
	let named: ReturnType<typeof keywordHits> | undefined;
	for (const topic of TOPICS) {
		if (!topic.match.test(question)) continue;
		const found = topic.cite.map(([subject, which]) => {
			const list = store.bySubject(subject).filter((h) => h.mailboxId.toLowerCase() === owner && h.email.folder_id !== "draft");
			return which === "first" ? list[0] : which === "last" ? list[list.length - 1] : list[which];
		});
		if (!found.every(Boolean)) continue;
		const hits = found as { mailboxId: string; email: Row }[];
		if (!topic.broad) {
			named ??= keywordHits(store, question, mailbox, 10_000);
			const cited = new Set(hits.map((h) => threadOf(h.email)));
			const best = (mine: boolean) => Math.max(0, ...named!.filter((h) => cited.has(threadOf(h.email)) === mine).map((h) => h.score));
			if (best(false) > best(true)) continue;
		}
		return { topic, hits };
	}
	return null;
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
			"Nothing in this mail answers that. The demo answers from the mail it ships with, so try asking about the Brightcup contract, the Incident Timeline launch, the SOC 2 report or the Stratus renewal.",
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
					"1. **Brightcup, 120 seats**: Priya will sign today on net-30 with 2% early-pay if net-45 is a no.\n" +
					"2. **Incident Timeline launch**: Daniel needs your OK on page v3 by **tomorrow**.\n" +
					"3. **Offer for Jonas Weber**: Nia needs your approval by **Thursday**.\n\n" +
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
			{ type: "tool-get_thread", toolCallId: "call_demo_3", state: "output-available", input: { subject: "Enterprise plan: Brightcup" }, output: { messages: 3 } },
			{ type: "tool-draft_reply", toolCallId: "call_demo_4", state: "output-available", input: { to: "priya@brightcup.example" }, output: { draftId: AGENT_DRAFT_ID, status: "draft_saved" } },
			{ type: "step-start" },
			{
				type: "text",
				text:
					"Saved to **Drafts**. Nothing was sent.\n\n" +
					"> Hi Priya, Dec 9–11 is confirmed. We'll stay at net-30, with 2% off if paid within 10 days. Daniel will send the SSO setup checklist today.",
			},
		],
	},
];

/** Put the draft the stored conversation refers to into the owner's Drafts. */
export function seedAgentDraft(store: DemoStore): void {
	const thread = store.bySubject("Enterprise plan: Brightcup").filter((h) => h.mailboxId === store.owner && h.email.folder_id === "inbox");
	const last = thread[thread.length - 1]?.email;
	if (!last) return;
	store.saveDraft(store.owner, {
		draft_id: AGENT_DRAFT_ID,
		to: last.sender,
		subject: `Re: ${String(last.subject ?? "").replace(/^re:\s*/i, "")}`,
		body: "<p>Hi Priya,</p><p>Dec 9–11 is confirmed. We'll stay at net-30, with 2% off if paid within 10 days. Daniel will send the SSO setup checklist today.</p><p>Maya</p>",
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
