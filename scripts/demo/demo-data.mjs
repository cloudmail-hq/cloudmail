// Demo content for scripts/demo/seed-demo.mjs.
//
// A fictional software company, Northwind, sells status pages and incident
// alerts to engineering teams. Northwind Labs is its developer platform (API,
// SDKs); Harborline is its second product, a changelog widget. Every person,
// company and address below is invented, and every domain is under the
// reserved `.example` TLD (RFC 2606).
//
// Times: `ago` is minutes before the seed runs (for today's mail), or
// `{ d, t }` = d days ago at local time t ("HH:MM") in the demo time zone,
// which seed-demo.mjs picks so that "now" is mid-morning.

export const MAILBOXES = [
	{ email: "maya@northwind.example", name: "Maya Okafor", signature: "Maya Okafor\nCo-founder and CEO, Northwind\n+1 (555) 014-2290" },
	{ email: "support@northwind.example", name: "Northwind Support", signature: "Northwind Support\nMon–Fri, 8am–6pm ET · support@northwind.example" },
	{ email: "sales@northwind.example", name: "Northwind Sales", signature: "Daniel Reyes\nHead of Growth, Northwind" },
	{ email: "team@northwindlabs.example", name: "Northwind Labs", signature: "Northwind Labs" },
	{ email: "hello@harborline.example", name: "Harborline", signature: "Harborline · Changelogs your users read" },
];

const P = (name, email, company) => ({ name, email, ...(company ? { company } : {}) });

// Internal people
export const MAYA = P("Maya Okafor", "maya@northwind.example");
const DANIEL = P("Daniel Reyes", "daniel@northwind.example");
const LENA = P("Lena Fischer", "lena@northwind.example");
const AIKO = P("Aiko Tanaka", "aiko@northwind.example");
const NIA = P("Nia Brooks", "nia@northwind.example");
const ELIF = P("Elif Demir", "elif@northwind.example");
const TOMAS = P("Tomás Varga", "tomas@northwindlabs.example");
const NADIA = P("Nadia Rahman", "nadia@northwindlabs.example");
const SAM = P("Sam Whitfield", "sam@harborline.example");
const SUPPORT = P("Northwind Support", "support@northwind.example");
const SALES = P("Daniel Reyes", "sales@northwind.example");
const LABS = P("Northwind Labs", "team@northwindlabs.example");
const HARBOR = P("Harborline", "hello@harborline.example");

// External people and services (all fictional)
const PRIYA = P("Priya Raman", "priya@brightcup.example", "Brightcup");
const FJORD = P("Fjord Assurance", "reports@fjordassurance.example");
const LEDGERLY = P("Ledgerly Billing", "billing@ledgerly.example");
const HANA = P("Hana Kobayashi", "hana@kobayashi-telecom.example");
const BUILDS = P("Labs CI", "noreply@northwindlabs.example");
const OSKAR = P("Oskar Lind", "oskar@lumenhealth.example", "Lumen Health");
const BRIEF = P("The Reliability Brief", "editor@reliabilitybrief.example");
const GRACE = P("Grace Holt", "grace@holtadvisory.example");
const VICTOR = P("Victor Lang", "victor@langventures.example");
const RUTH = P("Ruth Abara", "ruth.abara@meridianhotels.example", "Meridian Hotels");
const PAYSPROUT = P("PaySprout Payroll", "notifications@paysprout.example");
const MARCUS = P("Marcus Bell", "marcus@stratuscloud.example");
const JORDAN = P("Jordan Pike", "jordan@growthloop.example");
const SUMMIT = P("DevOps North Summit", "events@devopsnorth.example");
const STRATUS = P("Stratus Cloud", "billing@stratuscloud.example");
const PEOPLE = P("Northwind People Team", "people@northwind.example");
const BEA = P("Bea Santos", "bea@morningowl.example", "Morning Owl Games");
const KWAME = P("Kwame Mensah", "kwame@tidewaterlogistics.example", "Tidewater Logistics");
const ELENA = P("Elena Petrova", "elena@petrovalabs.example", "Petrova Labs");
const LUCA = P("Luca Moretti", "luca@morettipay.example", "Moretti Pay");
const NOOR = P("Noor Haddad", "noor@saltandcrumb.example", "Salt & Crumb");
const FINN = P("Finn O'Brien", "finn@copperleaf.example", "Copperleaf");
const ZOE = P("Zoe Chambers", "zoe@oakandolive.example", "Oak & Olive");
const MEI = P("Mei Lin", "mei@devjournal.example");
const ARJUN = P("Arjun Mehta", "arjun@lanternstays.example", "Lantern Stays");
const ISLA = P("Isla Grant", "isla@grantandco.example", "Grant & Co");
const RAFAEL = P("Rafael Duarte", "rafael@duartelabs.example", "Duarte Labs");
const HUGO = P("Hugo Laurent", "hugo@laurentpay.example", "Laurent Pay");
const YUKI = P("Yuki Sato", "yuki@kissa.example", "Kissa");
const AMARA = P("Amara Obi", "amara@sunroomapps.example", "Sunroom Apps");
const PETER = P("Peter Novak", "peter@novakdata.example", "Novak Data");
const SOFIA = P("Sofia Reyes", "sofia@lumaboard.example", "Lumaboard");
const BEN = P("Ben Carter", "ben@carterandsons.example", "Carter & Sons");
const TESS = P("Tess Albright", "tess@fernhillcloud.example", "Fernhill Cloud");
const OMAR = P("Omar Haddad", "omar@quillstack.example", "Quillstack");
const GRETA = P("Greta Lund", "greta@pinecrestapps.example", "Pinecrest Apps");
const INES = P("Ines Ferreira", "ines@quietharbor.example", "Quiet Harbor");
const CALLUM = P("Callum Reid", "callum@brackenworks.example", "Bracken Works");
const DALIA = P("Dalia Aziz", "dalia@harvestdata.example", "Harvest Data");
const MATEO = P("Mateo Silva", "mateo@cobaltforms.example", "Cobalt Forms");
const JONAH = P("Jonah Fields", "jonah@tallgrass.example", "Tallgrass");
const ROSA = P("Rosa Jimenez", "rosa@marlowlabs.example", "Marlow Labs");
const THEO = P("Theo Banks", "theo@banksrobotics.example", "Banks Robotics");
const SIGNE = P("Signe Dahl", "signe@northlightgames.example", "Northlight Games");

const sig = (name, title) => `\n\n${name}${title ? `\n${title}` : ""}`;

// The reasons the spam filter stores on a message (shared/spam.ts).
const SPAM = {
	dmarc: { id: "dmarc-fail", label: "The sending domain's DMARC policy says this message is not authentic." },
	spfDkim: { id: "spf-dkim-fail", label: "Both SPF and DKIM failed, so the sender could not be authenticated." },
	spf: { id: "spf-fail", label: "SPF failed for the sending server." },
	shouting: { id: "shouting-subject", label: "The subject is written entirely in capitals." },
	links: { id: "link-heavy", label: "Almost the entire message is links." },
	replyTo: (to, from) => ({ id: "reply-to-mismatch", label: `Replies would go to ${to} rather than ${from}.` }),
	spoof: (shown, from) => ({ id: "display-name-spoof", label: `The sender's name shows ${shown} but the message was sent from ${from}.` }),
};
const AUTH_FAIL = { spf: "fail", dkim: "fail", dmarc: "fail" };

/**
 * Threads. `mailbox` is the mailbox it lives in; a message with `sent: true` is
 * from that mailbox. `ai` is the AI triage label; `labels` are user labels.
 *
 * `folder` files the conversation somewhere other than the Inbox. Four system
 * folders take a little more:
 *   spam      `spam: { score, signals }`, and `auth` on the message (the
 *             Authentication-Results it arrived with)
 *   trash     `trashedDaysAgo`
 *   snoozed   `snoozeHours` from now
 *   screener  `verdict: { kind, confidence }`, the AI's guess at the sender
 */
export const THREADS = [
	// ───────────────────────────── maya@northwind.example ─────────────────────────────
	{
		key: "brightcup-enterprise", mailbox: MAYA.email, ai: "customers", labels: ["Deals"], unread: true,
		subject: "Enterprise plan: Brightcup (120 seats, annual)",
		summary: {
			line: "Brightcup confirms 120 Enterprise seats on an annual plan; wants to go live before Dec 12 and asks for net-45 terms.",
			bullets: ["Order form attached: 120 seats, annual, with SSO and audit log", "Asks to be live before Dec 12, ahead of their holiday peak", "Wants net-45 instead of net-30; Maya offered net-30 + 2% early-pay"],
		},
		messages: [
			{ from: PRIYA, to: [MAYA], at: { d: 2, t: "16:42" }, attachments: [{ name: "Order-form-Brightcup-Enterprise.pdf", kind: "pdf", kb: 182 }],
				body: `Hi Maya,\n\nAs promised, here's our signed order form for the Enterprise plan: 120 seats on an annual term, with SSO and the audit log.\n\nCould you confirm the rollout timeline? We'd love every team on it before December 12, so on-call gets a week of practice before our holiday peak.${sig("Priya Raman", "Head of Platform, Brightcup")}` },
			{ from: MAYA, to: [PRIYA], sent: true, at: { d: 1, t: "09:18" },
				body: `Hi Priya,\n\nThanks for the order form. We can switch SSO on for your workspace this week and run onboarding for all six teams on Dec 9–11.\n\nOn terms: we can do net-30 with a 2% early-payment discount. Would that work for your finance team?${sig("Maya")}` },
			{ from: PRIYA, to: [MAYA], cc: [DANIEL], ago: 26,
				body: `Hi Maya,\n\nDec 9–11 is perfect. Finance asked whether net-45 is possible given the size of the contract. If not, net-30 with the 2% discount is fine and we'll sign today.\n\nAlso, can Daniel send the SSO setup checklist for our IT team?${sig("Priya")}` },
		],
	},
	{
		key: "fjord-soc2", mailbox: MAYA.email, ai: "vendors", unread: true,
		subject: "Your SOC 2 Type II report is ready",
		summary: { line: "Fjord Assurance issued Northwind's SOC 2 Type II report with no exceptions; the PDF is attached.", bullets: ["Covers May 1 to October 31", "No exceptions noted", "Bridge letter available on request"] },
		messages: [
			{ from: FJORD, to: [MAYA], ago: 71, attachments: [{ name: "Northwind-SOC2-Type-II.pdf", kind: "pdf", kb: 64 }],
				body: `Hello Maya,\n\nYour SOC 2 Type II attestation for the period May 1 to October 31 is complete, with no exceptions noted. The final report is attached.\n\nYou can share it with customers under NDA. If a customer needs cover for the weeks after October 31, reply and we'll issue a bridge letter.\n\nFjord Assurance` },
		],
	},
	{
		key: "launch-plan", mailbox: MAYA.email, labels: ["Launch"], unread: true,
		subject: "Launch plan for Incident Timeline",
		summary: { line: "Daniel's v3 launch page leads with the live demo; he needs Maya's sign-off by tomorrow.", bullets: ["Launch on Tuesday: blog post, changelog, email to all workspaces", "Newsletter slot is booked on Monday", "Aiko will run the live Q&A"] },
		messages: [
			{ from: DANIEL, to: [MAYA], cc: [AIKO], at: { d: 3, t: "11:05" }, attachments: [{ name: "launch-page-v2.png", kind: "png", kb: 846 }],
				body: `Maya, first pass at the Incident Timeline launch page attached. Hero, three feature blocks, a customer quote and pricing at the bottom.\n\nOne question: do we launch it to everyone, or to Team and Enterprise first? Labs says the free tier is "probably fine" under load.\n\nDaniel` },
			{ from: MAYA, to: [DANIEL], cc: [AIKO], sent: true, at: { d: 3, t: "13:32" },
				body: `Love it. Let's launch to Team and Enterprise on Tuesday and open the free tier a week later. "Probably fine" isn't a phrase I want near 4,000 workspaces.\n\nCan we move the live demo to the top so people see it before they scroll?\n\nM` },
			{ from: AIKO, to: [DANIEL, MAYA], at: { d: 2, t: "10:14" },
				body: `+1 to the demo up top. I can run the live Q&A on launch day and take the support queue that afternoon. We should also update the help centre article, people always ask how it differs from the old log.\n\nAiko` },
			{ from: DANIEL, to: [MAYA], cc: [AIKO], ago: 132, attachments: [{ name: "launch-page-v3.png", kind: "png", kb: 912 }],
				body: `v3 attached with the live demo at the top and the free tier marked "coming next week".\n\nI need to book the newsletter slot on Monday, so a thumbs-up by tomorrow would be great.\n\nDaniel` },
		],
	},
	{
		key: "offer-approval", mailbox: MAYA.email, labels: ["Hiring"], unread: true,
		subject: "Offer approval: senior backend engineer",
		summary: { line: "Nia needs Maya's approval by Thursday for an offer to Jonas Weber, senior backend engineer.", bullets: ["Four yes votes and one lean yes from the panel", "Offer at the top of the band, with a March start", "He has another offer that expires Friday"] },
		messages: [
			{ from: NIA, to: [MAYA], cc: [TOMAS], ago: 188, attachments: [{ name: "Interview-feedback-Jonas-Weber.pdf", kind: "pdf", kb: 96 }],
				body: `Hi Maya,\n\nThe panel finished with Jonas Weber for the senior backend role: four yes votes and one lean yes. Feedback is attached. Tomás wants him on the alert pipeline.\n\nI'd like to offer at the top of the band with a March start. He has another offer that expires on Friday, so I need your approval by Thursday.\n\nNia` },
		],
	},
	{
		key: "ledgerly-inv", mailbox: MAYA.email, ai: "billing", unread: false,
		subject: "Invoice INV-20418 is ready",
		summary: { line: "Ledgerly invoice for November, $1,240.00, due Dec 1; auto-pay is on.", bullets: [] },
		messages: [
			{ from: LEDGERLY, to: [MAYA], ago: 214, attachments: [{ name: "INV-20418.pdf", kind: "pdf", kb: 41 }],
				body: `Hi Northwind,\n\nYour invoice INV-20418 for $1,240.00 is ready. Payment will be collected automatically on December 1 from the card ending 4402.\n\nThanks for using Ledgerly.` },
		],
	},
	{
		key: "kobayashi-quote", mailbox: MAYA.email, ai: "vendors", unread: true,
		subject: "Revised quote: SMS and voice alerts (2M credits)",
		summary: { line: "Kobayashi Telecom cut the SMS rate 6% for a 2M-credit commitment; quote valid to Dec 5.", bullets: ["$0.0114 → $0.0107 per SMS", "Voice calls unchanged", "Valid until December 5"] },
		messages: [
			{ from: HANA, to: [MAYA], cc: [TOMAS], at: { d: 1, t: "14:51" }, attachments: [{ name: "Quote-KT-1187-rev2.xlsx", kind: "xlsx", kb: 38 }],
				body: `Dear Maya,\n\nThank you for the call on Monday. With a commitment of 2 million credits a year we can offer $0.0107 per SMS, down from $0.0114. Voice call pricing stays as it is.\n\nThe revised quote is attached and valid until December 5. Tomás, the delivery reports for the new Italian route will follow this week.\n\nKind regards,\nHana Kobayashi\nKobayashi Telecom` },
		],
	},
	{
		key: "labs-build", mailbox: MAYA.email, unread: false,
		subject: "Nightly build report: api 4.12.0-rc3 passed",
		messages: [
			{ from: BUILDS, to: [MAYA], at: { d: 1, t: "06:02" },
				body: `api 4.12.0-rc3\n\nAll 1,412 tests passed. Webhook retry regression fixed. Two flaky tests quarantined (SMS delivery receipts).\n\nNext release candidate: Tuesday.` },
		],
	},
	{
		key: "lumen-alerts", mailbox: MAYA.email, ai: "customers", unread: false, starred: true,
		subject: "Missed alerts during Saturday's outage (Lumen Health)",
		summary: { line: "Lumen Health's on-call got no alerts for 40 minutes; Maya shipped a fix and credited a month, and Oskar wants a written postmortem.", bullets: ["Webhook retries were stuck behind one slow endpoint", "Fix shipped Sunday, one month credited", "Oskar asks for the postmortem by Friday"] },
		messages: [
			{ from: OSKAR, to: [SUPPORT], cc: [MAYA], at: { d: 2, t: "08:37" }, attachments: [{ name: "alert-timeline.jpg", kind: "jpg", kb: 1480 }],
				body: `Hello,\n\nOur API was down for 40 minutes on Saturday night and nobody on call was alerted. The monitor went red at 23:04 but the first page arrived at 23:44. Screenshot of the timeline attached.\n\nWe run patient-facing systems on this. What happened?\n\nOskar Lind\nEngineering Manager, Lumen Health` },
			{ from: MAYA, to: [OSKAR], cc: [SUPPORT], sent: true, at: { d: 2, t: "09:58" },
				body: `Hi Oskar,\n\nI'm sorry. This one is on us. Alert webhooks were queued behind one customer's slow endpoint, so yours waited for retries that should never have blocked them. We shipped a fix on Sunday that gives every workspace its own queue.\n\nWe've credited a month to your account. I'd also like to walk your team through what we changed.\n\nMaya` },
			{ from: OSKAR, to: [MAYA], at: { d: 1, t: "17:20" },
				body: `Thank you Maya, I appreciate the straight answer. A call would help. Could you also send a written postmortem by Friday? Our compliance team needs it for the incident file.\n\nOskar` },
		],
	},
	{
		key: "board-deck", mailbox: MAYA.email, labels: ["Finance"], unread: false, starred: true,
		subject: "Board deck draft for Nov 28",
		summary: { line: "Lena's board deck draft needs the product section (uptime, launch, roadmap) by Monday.", bullets: ["ARR +18% on the quarter, net revenue retention 112%", "Product section: uptime, the launch and the Q1 roadmap", "Due Monday EOD"] },
		messages: [
			{ from: LENA, to: [MAYA], at: { d: 1, t: "11:26" }, attachments: [{ name: "Board-deck-Nov28-DRAFT.pdf", kind: "pdf", kb: 2310 }],
				body: `Hi Maya,\n\nDraft board deck attached. Headline numbers: ARR up 18% on the quarter, net revenue retention 112%, 19 months of runway.\n\nCould you fill in the product section (uptime, the Incident Timeline launch, the Q1 roadmap) by Monday EOD? Two slides max.\n\nLena` },
		],
	},
	{
		key: "reliability-brief", mailbox: MAYA.email, folder: "archive", unread: false,
		subject: "The Reliability Brief: what October's biggest outages had in common",
		messages: [
			{ from: BRIEF, to: [MAYA], at: { d: 2, t: "07:00" },
				body: `This week: four of October's five largest outages started with a config change; why status pages get updated 20 minutes late; and three ways small teams run on-call without burning people out.\n\nRead the full issue online.` },
		],
	},
	{
		key: "meridian-intro", mailbox: MAYA.email, ai: "customers", unread: false,
		subject: "Intro: Ruth Abara (Meridian Hotels platform team)",
		summary: { line: "Grace introduced Ruth from Meridian Hotels, who's reviewing incident tooling for 22 engineering teams.", bullets: ["22 teams, vendor review expected in January", "Maya set a call for Tuesday 2pm"] },
		messages: [
			{ from: GRACE, to: [MAYA, RUTH], at: { d: 3, t: "15:10" },
				body: `Maya, Ruth: as promised, an introduction.\n\nRuth leads platform engineering at Meridian Hotels and is reviewing incident tooling for their 22 engineering teams. Maya runs Northwind and knows on-call better than anyone I know.\n\nI'll let you two take it from here.\n\nGrace` },
			{ from: MAYA, to: [RUTH], cc: [GRACE], sent: true, at: { d: 3, t: "16:02" },
				body: `Thanks Grace (moving you to cc).\n\nRuth, lovely to meet you. Would Tuesday at 2pm work for a 30-minute call? I'd love to hear how incidents run today and where the bottlenecks are.\n\nMaya` },
			{ from: RUTH, to: [MAYA], at: { d: 2, t: "09:41" },
				body: `Hi Maya, Tuesday at 2pm works. I'll send an invite. We're aiming to start a vendor review in January, so the timing is good.\n\nRuth Abara\nDirector of Platform Engineering, Meridian Hotels` },
		],
	},
	{
		key: "harborline-pricing", mailbox: MAYA.email, unread: false,
		subject: "Harborline pricing page (v2)",
		messages: [
			{ from: SAM, to: [MAYA], at: { d: 2, t: "13:15" }, attachments: [{ name: "Harborline-pricing-page-v2.pdf", kind: "pdf", kb: 5120 }],
				body: `Hi Maya,\n\nv2 of the pricing page attached. We moved the Agency plan into the main table and fixed the annual discount in the toggle. I'd like to ship it Wednesday at noon.\n\nSam` },
			{ from: MAYA, to: [SAM], sent: true, at: { d: 2, t: "15:47" },
				body: `Looks great. Signed off. One tiny thing: the Starter column should say "1,000 subscribers", not "1k". Otherwise ship it.\n\nM` },
		],
	},
	{
		key: "payroll", mailbox: MAYA.email, ai: "billing", folder: "Receipts", unread: false,
		subject: "November payroll approved",
		messages: [
			{ from: PAYSPROUT, to: [MAYA], at: { d: 3, t: "10:00" },
				body: `Payroll for Northwind (Nov 1–15) was approved by Lena Fischer. 28 employees will be paid on November 20.` },
		],
	},
	{
		key: "stratus-renewal", mailbox: MAYA.email, ai: "vendors", unread: false,
		subject: "Renewal: Stratus Cloud committed spend",
		summary: { line: "Stratus Cloud proposes a 3-year commitment at 18% off, with migration credits; reply by Dec 15.", bullets: ["3-year term from April 1", "18% off list, against 9% on a one-year term", "$20,000 in credits for the database migration"] },
		messages: [
			{ from: MARCUS, to: [MAYA], at: { d: 4, t: "12:20" }, attachments: [{ name: "Stratus-renewal-terms.pdf", kind: "pdf", kb: 312 }],
				body: `Hi Maya,\n\nAhead of your contract end on March 31, we'd like to offer a three-year commitment at 18% off list, against 9% on a one-year term, with $20,000 in credits if you go ahead with the database migration.\n\nTerms attached. Could you let me know by December 15?\n\nMarcus Bell\nStratus Cloud` },
		],
	},
	{
		key: "nps", mailbox: MAYA.email, unread: false,
		subject: "October NPS: 61 (+7)",
		messages: [
			{ from: AIKO, to: [MAYA], at: { d: 4, t: "16:05" }, attachments: [{ name: "nps-october.csv", kind: "csv", kb: 18 }],
				body: `Hi Maya,\n\nOctober NPS came in at 61, up 7 points. Biggest drivers: faster support replies and the new on-call schedules. Detractors mostly mention late SMS alerts.\n\nRaw responses attached.\n\nAiko` },
		],
	},
	{
		key: "sso-admin", mailbox: MAYA.email, unread: false,
		subject: "SSO for the admin console",
		messages: [
			{ from: TOMAS, to: [MAYA], at: { d: 5, t: "14:44" },
				body: `Maya, quick one: the internal admin console still uses a shared password. I'd like to move it to SSO with passkeys before the launch. It's about a day of work and no cost.\n\nOK to schedule for next Tuesday?\n\nTomás` },
			{ from: MAYA, to: [TOMAS], sent: true, at: { d: 5, t: "15:03" },
				body: `Yes please, and thank you for pushing on this. Tuesday is fine; just give the support team a heads-up.\n\nM` },
		],
	},
	{
		key: "summit", mailbox: MAYA.email, folder: "archive", unread: false,
		subject: "You're invited: DevOps North Summit, Rotterdam, Feb 11–12",
		messages: [
			{ from: SUMMIT, to: [MAYA], at: { d: 6, t: "08:30" },
				body: `Join 900 engineers, SREs and platform leads in Rotterdam on February 11–12. Early-bird passes close December 1.` },
		],
	},
	{
		key: "littlefern", mailbox: MAYA.email, unread: false,
		subject: "Trial extension for Little Fern Studio",
		messages: [
			{ from: DANIEL, to: [MAYA], at: { d: 6, t: "11:48" },
				body: `Little Fern (a 12-person agency in Portland) asked for two more weeks on their trial before they commit to the Team plan. OK to extend, and to offer an onboarding call?\n\nDaniel` },
			{ from: MAYA, to: [DANIEL], sent: true, at: { d: 6, t: "12:10" },
				body: `Yes, and set up a status page for one of their clients on the call. Agencies buy once they've shown a client.\n\nM` },
		],
	},
	{
		key: "stratus", mailbox: MAYA.email, ai: "billing", folder: "Receipts", unread: false,
		subject: "Your October cloud usage: $6,312.48",
		messages: [
			{ from: STRATUS, to: [MAYA], at: { d: 7, t: "05:15" },
				body: `Your Stratus Cloud bill for October is $6,312.48 and has been charged to the card on file.` },
		],
	},
	{
		key: "welcome-elif", mailbox: MAYA.email, unread: false,
		subject: "Please welcome Elif to the support team",
		messages: [
			{ from: PEOPLE, to: [MAYA], at: { d: 8, t: "09:00" },
				body: `Hi all,\n\nPlease welcome Elif Demir, who joins us as a Support Engineer on Monday. Elif spent five years on call at a payments company and writes a very good postmortem.\n\nSay hello if you see her around!\n\nPeople Team` },
		],
	},
	{
		key: "forecast", mailbox: MAYA.email, labels: ["Finance"], unread: false,
		subject: "Q1 revenue forecast",
		messages: [
			{ from: MAYA, to: [LENA], cc: [DANIEL], sent: true, at: { d: 4, t: "10:12" }, attachments: [{ name: "Q1-forecast-v1.xlsx", kind: "xlsx", kb: 76 }],
				body: `Lena, Q1 forecast attached. We're assuming 15% growth in new ARR and on-call scheduling going on sale in March. Daniel, shout if the enterprise pipeline changes the picture.\n\nM` },
			{ from: LENA, to: [MAYA], cc: [DANIEL], at: { d: 4, t: "11:40" },
				body: `Thanks. This lines up with my cash model. I'll pull it into the board deck.\n\nLena` },
		],
	},
	{
		key: "support-weekly", mailbox: MAYA.email, unread: false,
		subject: "Support weekly: 96% answered within 2 hours",
		messages: [
			{ from: ELIF, to: [MAYA], at: { d: 7, t: "16:30" },
				body: `Weekly numbers: 96% of tickets answered within 2 hours, median first reply 14 minutes, 2 escalations (both SMS delivery, filed with Kobayashi). Help centre review next Tuesday.\n\nElif` },
		],
	},
	{
		key: "investor-update", mailbox: MAYA.email, labels: ["Finance"], unread: false,
		subject: "October investor update",
		messages: [
			{ from: MAYA, to: [VICTOR, GRACE], sent: true, at: { d: 6, t: "09:05" },
				body: `Hi both,\n\nOctober in short: ARR up 6% on the month, 41 new paying workspaces, and Brightcup moving to Enterprise. One miss: a 40-minute alert delay for one customer, now fixed.\n\nAsks: introductions to platform leads at companies with 20+ engineering teams.\n\nMaya` },
			{ from: VICTOR, to: [MAYA], at: { d: 5, t: "18:22" },
				body: `Strong month, and thank you for putting the miss in writing. I can introduce you to two portfolio CTOs who are both unhappy with their paging tool. Shall I?\n\nVictor` },
		],
	},

	// Archive: finished business.
	{
		key: "meridian-nda", mailbox: MAYA.email, folder: "archive", unread: false,
		subject: "Completed: mutual NDA with Meridian Hotels",
		messages: [
			{ from: P("SignDesk", "completed@signdesk.example"), to: [MAYA], at: { d: 9, t: "14:12" }, attachments: [{ name: "Mutual-NDA-Meridian-Northwind.pdf", kind: "pdf", kb: 148 }],
				body: `Everyone has signed "Mutual NDA: Meridian Hotels and Northwind". A copy is attached for your records.` },
		],
	},
	{
		key: "postmortem-oct", mailbox: MAYA.email, folder: "archive", unread: false,
		subject: "Postmortem: Oct 14 notification delay (final)",
		messages: [
			{ from: TOMAS, to: [MAYA], cc: [AIKO], at: { d: 12, t: "17:40" },
				body: `Final version is in the doc. Cause: a certificate rotation on the push gateway that our canary did not cover. Three actions, all done: canary now sends a real push, rotation moved to Tuesday mornings, and the status page updates itself when the gateway is degraded.\n\nTomás` },
		],
	},
	{
		key: "offsite", mailbox: MAYA.email, folder: "archive", unread: false,
		subject: "Offsite recap and photos",
		messages: [
			{ from: NIA, to: [MAYA], at: { d: 15, t: "10:25" },
				body: `Thanks for a great two days in Lisbon. Notes from the roadmap session and the photos are in the shared folder. Survey score: 4.7 out of 5, and the top request for next time is a longer hack day.\n\nNia` },
		],
	},

	// Snoozed: comes back to the Inbox at the time shown.
	{
		key: "domain-renewal", mailbox: MAYA.email, folder: "snoozed", snoozeHours: 24 * 5 + 2, unread: false,
		subject: "northwind.example renews in 49 days",
		messages: [
			{ from: P("Namewell Domains", "renewals@namewell.example"), to: [MAYA], at: { d: 2, t: "06:40" },
				body: `Three of your domains renew on January 14. Auto-renew is on and the card on file ends 4402. Review your domains if you want to change anything before then.` },
		],
	},
	{
		key: "summit-cfp", mailbox: MAYA.email, folder: "snoozed", snoozeHours: 24 * 3 - 1, unread: false,
		subject: "Speak at DevOps North Summit? CFP closes Dec 20",
		messages: [
			{ from: P("Anders Holm", "anders@devopsnorth.example"), to: [MAYA], at: { d: 3, t: "12:08" },
				body: `Hi Maya,\n\nYour talk on alert fatigue was the best-rated session last year. Would you speak again in February? The call for proposals closes December 20, and a title and three lines is enough to hold a slot.\n\nAnders Holm\nProgramme chair, DevOps North Summit` },
		],
	},

	// Screener: first-time senders wait here for a Yes or No.
	{
		key: "growthloop", mailbox: MAYA.email, folder: "screener", verdict: { kind: "cold_sales", confidence: "high" }, unread: true,
		subject: "3x your B2B pipeline in 90 days?",
		messages: [
			{ from: JORDAN, to: [MAYA], at: { d: 3, t: "09:12" },
				body: `Hi Maya,\n\nI noticed Northwind is growing fast. We help B2B software companies triple qualified pipeline with AI-personalised outreach.\n\nWorth a 15-minute chat next week?\n\nJordan` },
			{ from: JORDAN, to: [MAYA], at: { d: 1, t: "09:15" },
				body: `Hi Maya, floating this back to the top of your inbox. Is pipeline a priority this quarter, or should I try again in January?\n\nJordan` },
		],
	},
	{
		key: "recruiter", mailbox: MAYA.email, folder: "screener", verdict: { kind: "recruiter", confidence: "high" }, unread: true,
		subject: "Three senior backend engineers available now",
		messages: [
			{ from: P("Talia Reed", "talia@brightpathtalent.example"), to: [MAYA], at: { d: 1, t: "11:30" },
				body: `Hi Maya,\n\nI saw your senior backend opening. I represent three engineers with on-call and queueing experience who are interviewing this month. Our fee is 18% of first-year salary.\n\nCan I send profiles?\n\nTalia Reed\nBrightpath Talent` },
		],
	},
	{
		key: "ridgeline", mailbox: MAYA.email, folder: "screener", verdict: { kind: "investor", confidence: "medium" }, unread: true,
		subject: "Ridgeline Capital: catching up on Northwind",
		messages: [
			{ from: P("Carla Mendes", "carla@ridgelinecapital.example"), to: [MAYA], ago: 164,
				body: `Hi Maya,\n\nI lead developer-tools investing at Ridgeline. Two of our portfolio companies moved to Northwind this year and both raised it with me unprompted. I'd love 20 minutes to hear what you're building, with no agenda beyond that.\n\nCarla Mendes\nPartner, Ridgeline Capital` },
		],
	},
	{
		key: "talk-thanks", mailbox: MAYA.email, folder: "screener", verdict: { kind: "person", confidence: "medium" }, unread: false,
		subject: "Your alert fatigue talk",
		messages: [
			{ from: P("Dev Patel", "dev@patelsystems.example"), to: [MAYA], at: { d: 2, t: "19:48" },
				body: `Hi Maya,\n\nI watched the recording of your alert fatigue talk and we cut our paging rules from 140 to 31 the week after. Nobody has been woken by a disk-space warning since. Thank you.\n\nIf you ever write the talk up, I'd share it with our whole team.\n\nDev` },
		],
	},
	{
		key: "founder-dispatch", mailbox: MAYA.email, folder: "screener", verdict: { kind: "newsletter", confidence: "high" }, unread: false,
		subject: "Founder Dispatch #212: pricing pages that convert",
		messages: [
			{ from: P("Founder Dispatch", "hello@founderdispatch.example"), to: [MAYA], at: { d: 1, t: "07:30" },
				body: `In this issue: five pricing pages taken apart, when to add a fourth plan, and a founder on what changed after she removed the free tier.\n\nYou are receiving this because you were added to our list.` },
		],
	},

	// Trash
	{
		key: "planboard-trial", mailbox: MAYA.email, folder: "trash", trashedDaysAgo: 2, unread: false,
		subject: "Your Planboard trial ends tomorrow",
		messages: [
			{ from: P("Planboard", "hello@planboard.example"), to: [MAYA], at: { d: 3, t: "08:00" },
				body: `Your 14-day trial of Planboard ends tomorrow. Add a card to keep your boards, or do nothing and the workspace is archived.` },
		],
	},
	{
		key: "pricing-webinar", mailbox: MAYA.email, folder: "trash", trashedDaysAgo: 3, unread: false,
		subject: "Tomorrow: 7 pricing page mistakes (live webinar)",
		messages: [
			{ from: P("RevenueCraft Events", "events@revenuecraft.example"), to: [MAYA], at: { d: 4, t: "15:00" },
				body: `Reminder: tomorrow at 11am ET we take apart seven pricing pages live. Seats are limited. Save yours.` },
		],
	},
	{
		key: "qa-pitch", mailbox: MAYA.email, folder: "trash", trashedDaysAgo: 4, unread: false,
		subject: "Re: outsourcing your QA?",
		messages: [
			{ from: P("Milan Kovac", "milan@testforge.example"), to: [MAYA], at: { d: 5, t: "10:20" },
				body: `Hi Maya, bumping this in case it got buried. We run manual and automated QA for 60 software teams from $2,900 a month. Open to a quick call?\n\nMilan` },
		],
	},
	{
		key: "calendar-accept", mailbox: MAYA.email, folder: "trash", trashedDaysAgo: 5, unread: false,
		subject: "Accepted: Pricing review (Thu 3:00 PM)",
		messages: [
			{ from: DANIEL, to: [MAYA], at: { d: 6, t: "09:31" },
				body: `Daniel Reyes has accepted your invitation to "Pricing review" on Thursday at 3:00 PM.` },
		],
	},

	// Spam: each one failed a check the filter explains in the reader.
	{
		key: "spam-mailbox-suspended", mailbox: MAYA.email, folder: "spam", unread: true,
		spam: { score: 8, signals: [SPAM.spfDkim, SPAM.spoof("security@northwind.example", "alerts@account-verify-desk.example")] },
		subject: "Action required: your mailbox will be suspended today",
		messages: [
			{ from: P("security@northwind.example", "alerts@account-verify-desk.example"), to: [MAYA], auth: AUTH_FAIL, ago: 302,
				body: `Dear user,\n\nYour mailbox has reached its storage limit and will be suspended within 12 hours. Confirm your password to keep your account active.\n\nIT Security Team` },
		],
	},
	{
		key: "spam-wire", mailbox: MAYA.email, folder: "spam", unread: true,
		spam: { score: 6.5, signals: [SPAM.dmarc, SPAM.replyTo("quickmailbox.example", "northwind-finance.example")] },
		subject: "Wire transfer needed before 3pm",
		messages: [
			{ from: P("Lena Fischer", "lena.fischer@northwind-finance.example"), to: [MAYA], auth: AUTH_FAIL, replyTo: "lena.cfo@quickmailbox.example", at: { d: 1, t: "13:02" },
				body: `Maya,\n\nI'm in meetings all afternoon and can't talk. A supplier payment of $48,200 has to go out before 3pm today. Reply and I'll send the bank details.\n\nLena` },
		],
	},
	{
		key: "spam-seo", mailbox: MAYA.email, folder: "spam", unread: false,
		spam: { score: 5.5, signals: [SPAM.spf, SPAM.shouting, SPAM.links, SPAM.replyTo("seo-desk-mail.example", "apexrank.example")] },
		subject: "RANK NUMBER ONE ON SEARCH IN 30 DAYS GUARANTEED",
		messages: [
			{ from: P("Apex Rank Team", "team@apexrank.example"), to: [MAYA], auth: { spf: "fail", dkim: "none", dmarc: "none" }, replyTo: "sales@seo-desk-mail.example", at: { d: 2, t: "03:14" },
				body: `Page one or your money back.\n\nhttps://apexrank.example/packages\nhttps://apexrank.example/backlinks\nhttps://apexrank.example/guest-posts\nhttps://apexrank.example/case-studies\nhttps://apexrank.example/pricing\nhttps://apexrank.example/order-now` },
		],
	},
	{
		key: "spam-invoice", mailbox: MAYA.email, folder: "spam", unread: false,
		spam: { score: 5, signals: [SPAM.spfDkim] },
		subject: "Invoice 88213 overdue: final notice",
		messages: [
			{ from: P("Accounts Receivable", "ar@ledgerly-billing-desk.example"), to: [MAYA], auth: AUTH_FAIL, at: { d: 3, t: "22:47" },
				body: `Your account is 30 days overdue. Pay invoice 88213 today to avoid a late fee and suspension of service. Open the secure payment page to settle the balance.` },
		],
	},
	{
		key: "spam-undelivered", mailbox: MAYA.email, folder: "spam", unread: false,
		spam: { score: 5, signals: [SPAM.dmarc] },
		subject: "You have 3 undelivered messages",
		messages: [
			{ from: P("Mail Delivery System", "postmaster@mx-delivery-notice.example"), to: [MAYA], auth: AUTH_FAIL, at: { d: 5, t: "04:20" },
				body: `Three incoming messages are being held because your mailbox could not be verified. Release them within 24 hours or they will be deleted.` },
		],
	},

	// ───────────────────────────── support@northwind.example (shared) ─────────────────────────────
	{
		key: "sms-late", mailbox: SUPPORT.email, ai: "customers", labels: ["Urgent"], unread: true,
		subject: "SMS alerts arriving 10 minutes late",
		summary: { line: "Morning Owl Games gets SMS alerts about 10 minutes late on one carrier; push and email are on time.", bullets: ["Started Sunday, Team plan", "Only SMS is late, and only on one carrier", "Asks whether to switch on-call to voice calls"] },
		messages: [
			{ from: BEA, to: [SUPPORT], ago: 18, attachments: [{ name: "sms-delay.jpg", kind: "jpg", kb: 1236 }],
				body: `Hi there,\n\nSince Sunday our SMS alerts arrive about ten minutes after the incident opens. Push and email are instant. Screenshot attached: incident at 02:11, text at 02:21. Everyone affected is on the same carrier.\n\nShould we switch on-call to voice calls until this is fixed?\n\nBea\nMorning Owl Games` },
		],
	},
	{
		key: "invoice-missing", mailbox: SUPPORT.email, ai: "billing", unread: true,
		subject: "Can't find the October invoice",
		messages: [
			{ from: KWAME, to: [SUPPORT], ago: 54,
				body: `Hello,\n\nOur accountant needs the October invoice for workspace "tidewater" (Team plan, 25 seats) and I can't find it under Billing. Could you resend it?\n\nThanks,\nKwame Mensah\nTidewater Logistics` },
		],
	},
	{
		key: "custom-domain", mailbox: SUPPORT.email, ai: "customers", unread: false,
		subject: "Custom domain for our status page",
		messages: [
			{ from: ELENA, to: [SUPPORT], at: { d: 1, t: "10:03" },
				body: `Hi, we'd like our status page on status.petrovalabs.example instead of the default address. Is that on the Team plan, or do we need Enterprise?\n\nElena` },
			{ from: AIKO, to: [ELENA], sent: true, from_mailbox: true, at: { d: 1, t: "10:41" },
				body: `Hi Elena,\n\nCustom domains are on every paid plan. Add a CNAME for status.petrovalabs.example pointing to pages.northwind.example, then enter the domain under Status page → Settings. The certificate is issued within a few minutes.\n\nReply "done" once the record is in and I'll check it from our side.\n\nAiko, Northwind Support` },
			{ from: ELENA, to: [SUPPORT], at: { d: 1, t: "11:02" }, body: `Done! It's live already. Thank you.\n\nElena` },
		],
	},
	{
		key: "webhook-signature", mailbox: SUPPORT.email, ai: "customers", unread: true,
		subject: "Webhook signature check failing",
		messages: [
			{ from: LUCA, to: [SUPPORT], at: { d: 1, t: "15:22" },
				body: `Buongiorno,\n\nSince yesterday our endpoint rejects about one webhook in five: the signature we compute does not match the X-Northwind-Signature header. Nothing changed on our side. Should we turn the check off for now?\n\nLuca Moretti\nMoretti Pay` },
		],
	},
	{
		key: "duplicate-charge", mailbox: SUPPORT.email, ai: "billing", unread: false,
		subject: "Charged twice for November",
		messages: [
			{ from: NOOR, to: [SUPPORT], at: { d: 2, t: "12:12" }, attachments: [{ name: "card-statement.jpg", kind: "jpg", kb: 1702 }],
				body: `Hi, our card was charged $290 twice on November 1 (statement attached). Can we get one of them refunded?\n\nNoor\nSalt & Crumb` },
			{ from: AIKO, to: [NOOR], sent: true, from_mailbox: true, at: { d: 2, t: "13:05" }, attachments: [{ name: "Credit-note-CN-5521.pdf", kind: "pdf", kb: 22 }],
				body: `Hi Noor,\n\nSo sorry about that. The second charge was a retry that should not have gone through. It's refunded (credit note CN-5521 attached) and should reach your card in three to five working days.\n\nAiko, Northwind Support` },
		],
	},
	{
		key: "thanks", mailbox: SUPPORT.email, ai: "customers", unread: false,
		subject: "Thank you!",
		messages: [
			{ from: ISLA, to: [SUPPORT], at: { d: 3, t: "18:02" },
				body: `Just wanted to say Elif was brilliant on the call. Our status page went live the same afternoon and two customers have already subscribed to updates. Thank you all!\n\nIsla, Grant & Co` },
		],
	},
	{
		key: "docs-link", mailbox: SUPPORT.email, ai: "customers", unread: false,
		subject: "Quickstart link in the welcome email is broken",
		messages: [
			{ from: ARJUN, to: [SUPPORT], at: { d: 4, t: "09:30" },
				body: `Hi, the "Create your first monitor" link in the welcome email gives a 404. Is there a new link?\n\nArjun, Lantern Stays` },
			{ from: AIKO, to: [ARJUN], sent: true, from_mailbox: true, at: { d: 4, t: "10:15" },
				body: `Hi Arjun, thanks for flagging it. We moved the docs last week. Here's the new link: northwind.example/docs/quickstart. We've fixed the welcome email too.\n\nAiko` },
		],
	},
	{
		key: "monitor-limit", mailbox: SUPPORT.email, ai: "customers", unread: false,
		subject: "How many monitors on the Team plan?",
		messages: [
			{ from: ZOE, to: [SUPPORT], at: { d: 5, t: "14:00" },
				body: `We have about 60 services and check each one from three regions. How many monitors does the Team plan include, and does a multi-region check count as one or three?\n\nZoe` },
		],
	},
	{
		key: "support-ooo", mailbox: SUPPORT.email, folder: "trash", trashedDaysAgo: 1, unread: false,
		subject: "Automatic reply: out of the office until Monday",
		messages: [
			{ from: NOOR, to: [SUPPORT], at: { d: 2, t: "13:06" },
				body: `Thanks for your message. I'm out of the office until Monday with limited access to email. For anything urgent, contact accounts@saltandcrumb.example.` },
		],
	},
	{
		key: "support-test", mailbox: SUPPORT.email, folder: "trash", trashedDaysAgo: 3, unread: false,
		subject: "Test from the new contact form (please ignore)",
		messages: [
			{ from: ELIF, to: [SUPPORT], at: { d: 4, t: "16:44" },
				body: `Testing that the contact form on the help centre reaches this mailbox. It does. Please ignore.\n\nElif` },
		],
	},
	{
		key: "support-timezone", mailbox: SUPPORT.email, ai: "customers", folder: "archive", unread: false,
		subject: "Status page shows incident times in UTC",
		messages: [
			{ from: KWAME, to: [SUPPORT], at: { d: 5, t: "08:22" },
				body: `Hello,\n\nOur customers are all in Ghana, but the incident times on our status page are in UTC. Can the page show local time?\n\nKwame Mensah\nTidewater Logistics` },
			{ from: AIKO, to: [KWAME], sent: true, from_mailbox: true, at: { d: 5, t: "08:51" },
				body: `Hi Kwame,\n\nYes. Under Status page → Settings → Time zone, choose "Visitor's local time" or pick Africa/Accra. It applies to past incidents too.\n\nAiko, Northwind Support` },
			{ from: KWAME, to: [SUPPORT], at: { d: 5, t: "09:10" }, body: `That did it, thank you.\n\nKwame` },
		],
	},
	{
		key: "support-export", mailbox: SUPPORT.email, ai: "customers", folder: "archive", unread: false,
		subject: "Export of last year's incidents",
		messages: [
			{ from: LUCA, to: [SUPPORT], at: { d: 6, t: "14:30" },
				body: `Hi, our auditors want every incident from last year with start and end times. Is there an export?\n\nLuca Moretti\nMoretti Pay` },
			{ from: ELIF, to: [LUCA], sent: true, from_mailbox: true, at: { d: 6, t: "14:58" },
				body: `Hi Luca,\n\nIncidents → Export gives you a CSV for any date range, with start, end, duration and the affected components. I've also turned on the monthly export email for your workspace.\n\nElif, Northwind Support` },
			{ from: LUCA, to: [SUPPORT], at: { d: 6, t: "15:20" }, body: `Perfect, that's what they asked for. Thanks Elif.` },
		],
	},
	{
		key: "support-pause", mailbox: SUPPORT.email, ai: "billing", folder: "snoozed", snoozeHours: 24 * 2 + 3, unread: false,
		subject: "Pausing our plan over the holidays",
		messages: [
			{ from: YUKI, to: [SUPPORT], at: { d: 2, t: "11:47" },
				body: `Hi,\n\nOur cafés close from December 24 to January 3. Can we pause the plan for those days, or does it make more sense to leave it running? No rush, I only need to know before the 20th.\n\nYuki Sato\nKissa` },
		],
	},
	{
		key: "support-spam-parcel", mailbox: SUPPORT.email, folder: "spam", unread: true,
		spam: { score: 8, signals: [SPAM.spfDkim, SPAM.spoof("support@parcelpoint.example", "notice@parcel-redelivery-desk.example")] },
		subject: "Your parcel could not be delivered",
		messages: [
			{ from: P("support@parcelpoint.example", "notice@parcel-redelivery-desk.example"), to: [SUPPORT], auth: AUTH_FAIL, at: { d: 1, t: "02:38" },
				body: `We tried to deliver your parcel today but nobody was available. Confirm your address and pay the redelivery fee of $1.99 within 48 hours, or the parcel is returned to the sender.` },
		],
	},
	{
		key: "support-spam-guestpost", mailbox: SUPPORT.email, folder: "spam", unread: false,
		spam: { score: 5.5, signals: [SPAM.spf, SPAM.shouting, SPAM.links, SPAM.replyTo("content-desk-mail.example", "linkboost.example")] },
		subject: "GUEST POST ON YOUR BLOG WITH DOFOLLOW LINK",
		messages: [
			{ from: P("Linkboost Outreach", "outreach@linkboost.example"), to: [SUPPORT], auth: { spf: "fail", dkim: "none", dmarc: "none" }, replyTo: "editor@content-desk-mail.example", at: { d: 3, t: "05:51" },
				body: `We pay for articles on your site.\n\nhttps://linkboost.example/rates\nhttps://linkboost.example/samples\nhttps://linkboost.example/niches\nhttps://linkboost.example/publishers\nhttps://linkboost.example/contact` },
		],
	},

	// ───────────────────────────── sales@northwind.example ─────────────────────────────
	{
		key: "cold-fernhill", mailbox: SALES.email, ai: "customers", labels: ["Leads"], unread: true,
		subject: "How does Fernhill Cloud find out it's down?",
		summary: { line: "Tess at Fernhill Cloud replied to the cold email: their paging contract ends in February and she wants a demo next week.", bullets: ["Two cold emails, three days apart", "Current paging contract ends in February", "Asks for a demo next week with her SRE lead"] },
		messages: [
			{ from: DANIEL, to: [TESS], sent: true, from_mailbox: true, at: { d: 4, t: "09:12" },
				body: `Hi Tess,\n\nYour status page showed an incident on the 9th that was posted 35 minutes after customers started tweeting about it. That gap is the thing we fix: Northwind opens the incident, pages on-call and updates the status page from the same alert.\n\nWorth 15 minutes to see it on your own monitors?\n\nDaniel Reyes\nNorthwind` },
			{ from: DANIEL, to: [TESS], sent: true, from_mailbox: true, at: { d: 1, t: "09:20" },
				body: `Hi Tess,\n\nOne more thought and then I'll leave you alone. Teams your size usually tell us the slow part is not detecting the outage, it's telling customers. Here's a two-minute video of the status page updating itself: northwind.example/demo.\n\nDaniel` },
			{ from: TESS, to: [SALES], ago: 44,
				body: `Hi Daniel,\n\nGood timing, and yes, that incident was a bad day. Our paging contract ends in February and I'm not keen to renew. Could you do a demo next week? I'd like our SRE lead on the call.\n\nTess Albright\nVP Engineering, Fernhill Cloud` },
		],
	},
	{
		key: "copperleaf-demo", mailbox: SALES.email, ai: "customers", labels: ["Leads"], unread: true,
		subject: "Demo request: Copperleaf (12 engineering teams)",
		messages: [
			{ from: FINN, to: [SALES], ago: 97,
				body: `Hi,\n\nWe're replacing our paging tool across 12 engineering teams next spring and would love a demo of on-call scheduling and whatever's coming next. Any chance of something in early December?\n\nFinn O'Brien\nHead of Infrastructure, Copperleaf` },
		],
	},
	{
		key: "trial-pinecrest", mailbox: SALES.email, ai: "customers", unread: true,
		subject: "Welcome to Northwind, Greta",
		summary: { line: "Greta at Pinecrest Apps replied to the welcome email: she wants to import 40 monitors from their current tool before the trial ends.", bullets: ["Signed up two days ago, on a 14-day trial", "Wants to import 40 monitors from a CSV", "Asks whether trial data carries over to a paid plan"] },
		messages: [
			{ from: DANIEL, to: [GRETA], sent: true, from_mailbox: true, at: { d: 2, t: "08:05" },
				body: `Hi Greta,\n\nWelcome to Northwind. Your 14-day trial of the Team plan has started. The fastest way to see what it does is to add one monitor: northwind.example/docs/quickstart takes about two minutes.\n\nIf you tell me what you use today, I'll point you at the right import.\n\nDaniel Reyes\nNorthwind` },
			{ from: GRETA, to: [SALES], at: { d: 1, t: "16:48" },
				body: `Hi Daniel,\n\nThanks. We have about 40 monitors in our current tool. Can we import them from a CSV rather than adding them by hand? And if we upgrade, does everything from the trial carry over?\n\nGreta Lund\nCTO, Pinecrest Apps` },
		],
	},
	{
		key: "meridian-security", mailbox: SALES.email, ai: "customers", labels: ["Leads"], unread: false,
		subject: "Meridian Hotels: security questionnaire",
		messages: [
			{ from: RUTH, to: [SALES], cc: [MAYA], at: { d: 1, t: "13:37" }, attachments: [{ name: "Meridian-security-questionnaire.docx", kind: "docx", kb: 58 }],
				body: `Hello Daniel,\n\nAhead of our January vendor review, could your team complete the attached questionnaire? It covers data residency, SSO, audit logs and your incident response process.\n\nRuth` },
		],
	},
	{
		key: "lantern-pricing", mailbox: SALES.email, ai: "customers", unread: false,
		subject: "Pricing for 60 seats",
		messages: [
			{ from: ARJUN, to: [SALES], at: { d: 2, t: "10:20" },
				body: `Hi Daniel, can you send pricing for 60 seats on the Team plan with annual billing? We'd like to budget before year end.\n\nArjun Mehta\nLantern Stays` },
			{ from: DANIEL, to: [ARJUN], sent: true, from_mailbox: true, at: { d: 2, t: "11:05" }, attachments: [{ name: "Northwind-Quote-Q-7742.pdf", kind: "pdf", kb: 140 }],
				body: `Hi Arjun,\n\nQuote attached: 60 seats on the Team plan, billed annually, with onboarding and a migration from your current tool included. Happy to walk through it on a call.\n\nDaniel` },
		],
	},
	{
		key: "duarte-beta", mailbox: SALES.email, ai: "customers", unread: false,
		subject: "Re: On-call scheduling early access",
		messages: [
			{ from: RAFAEL, to: [SALES], at: { d: 5, t: "16:45" },
				body: `Daniel, we'd love to be on the early-access list for on-call scheduling. We run three rotations across two time zones, so lots of real-world testing.\n\nRafael` },
		],
	},
	{
		key: "cold-optout", mailbox: SALES.email, folder: "archive", unread: false,
		subject: "How does Carter & Sons find out it's down?",
		messages: [
			{ from: DANIEL, to: [BEN], sent: true, from_mailbox: true, at: { d: 6, t: "09:14" },
				body: `Hi Ben,\n\nQuick question: when your booking system goes down at night, who finds out first, your team or your customers? Northwind pages on-call and updates your status page from the same alert.\n\nWorth 15 minutes?\n\nDaniel Reyes\nNorthwind` },
			{ from: BEN, to: [SALES], at: { d: 6, t: "11:40" },
				body: `Not for us, thanks. We're a four-person shop. Please take me off the list.\n\nBen` },
			{ from: DANIEL, to: [BEN], sent: true, from_mailbox: true, at: { d: 6, t: "11:52" },
				body: `Done, you won't hear from us again. Thanks for letting me know, Ben.\n\nDaniel` },
		],
	},
	{
		key: "sales-ooo", mailbox: SALES.email, folder: "trash", trashedDaysAgo: 2, unread: false,
		subject: "Automatic reply: How does Laurent Pay find out it's down?",
		messages: [
			{ from: HUGO, to: [SALES], at: { d: 3, t: "09:16" },
				body: `I'm away until December 2 and will reply when I'm back. For anything urgent, write to platform@laurentpay.example.\n\nHugo Laurent` },
		],
	},
	{
		key: "sales-won", mailbox: SALES.email, ai: "customers", folder: "archive", unread: false,
		subject: "Signed: Sunroom Apps, Team plan, 18 seats",
		messages: [
			{ from: AMARA, to: [SALES], at: { d: 7, t: "10:05" },
				body: `Hi Daniel,\n\nSigned order form attached. We'd like to start on the 1st, and I'll send the list of on-call engineers this week.\n\nAmara Obi\nSunroom Apps`,
				attachments: [{ name: "sunroom-order-form-signed.pdf", kind: "pdf", kb: 212 }] },
			{ from: DANIEL, to: [AMARA], sent: true, from_mailbox: true, at: { d: 7, t: "10:32" },
				body: `Thank you, Amara, and welcome. Your workspace is ready and I've booked the onboarding call for Thursday at 10.\n\nDaniel` },
			{ from: AMARA, to: [SALES], at: { d: 7, t: "10:40" }, body: `Thursday works. See you then.\n\nAmara` },
		],
	},
	{
		key: "sales-january", mailbox: SALES.email, ai: "customers", labels: ["Leads"], folder: "snoozed", snoozeHours: 24 * 6 + 1, unread: false,
		subject: "Budget opens in January",
		messages: [
			{ from: ISLA, to: [SALES], at: { d: 3, t: "15:12" },
				body: `Hi Daniel,\n\nThe demo went down well with the team. Our tooling budget is frozen until January 6, so I can't sign anything before then. Could you write to me in the first week of January with the quote for 30 seats?\n\nIsla Grant\nGrant & Co` },
		],
	},
	{
		key: "sales-spam-leads", mailbox: SALES.email, folder: "spam", unread: true,
		spam: { score: 5.5, signals: [SPAM.spf, SPAM.shouting, SPAM.links, SPAM.replyTo("data-broker-mail.example", "leadvault.example")] },
		subject: "50,000 VERIFIED B2B CONTACTS FOR 199 DOLLARS",
		messages: [
			{ from: P("LeadVault", "offers@leadvault.example"), to: [SALES], auth: { spf: "fail", dkim: "none", dmarc: "none" }, replyTo: "deals@data-broker-mail.example", at: { d: 1, t: "04:07" },
				body: `Fresh contact lists by industry and job title.\n\nhttps://leadvault.example/software\nhttps://leadvault.example/cto-list\nhttps://leadvault.example/samples\nhttps://leadvault.example/pricing\nhttps://leadvault.example/buy-now` },
		],
	},

	// ───────────────────────────── team@northwindlabs.example ─────────────────────────────
	{
		key: "api-notes", mailbox: LABS.email, unread: true,
		subject: "API 4.12 release notes (draft)",
		messages: [
			{ from: TOMAS, to: [LABS], at: { d: 1, t: "18:10" },
				body: `Draft release notes for 4.12 are in the doc. Highlights: per-workspace webhook queues (no more waiting behind a slow endpoint), idempotency keys on the incidents API, and a Go SDK.\n\nComments by Friday please.\n\nTomás` },
		],
	},
	{
		key: "rate-limit", mailbox: LABS.email, ai: "customers", unread: true,
		subject: "Rate limit on the incidents API?",
		messages: [
			{ from: OMAR, to: [LABS], ago: 121,
				body: `Hi,\n\nWe open incidents from our deploy pipeline and hit a 429 during a rollback last night. The docs say 60 requests a minute per token. Is that per workspace or per token, and can it be raised on the Team plan?\n\nOmar Haddad\nQuillstack` },
		],
	},
	{
		key: "load-test", mailbox: LABS.email, unread: false,
		subject: "Load test results: alert pipeline",
		messages: [
			{ from: NADIA, to: [LABS], at: { d: 3, t: "15:55" }, attachments: [{ name: "load-test-run-11.csv", kind: "csv", kb: 9 }],
				body: `Run 11 results attached. 198 of 200 one-minute windows stayed under 2 seconds from alert to page at 5× normal volume. The two slow windows are both during a database failover; I've opened a ticket for it.\n\nNadia` },
		],
	},
	{
		key: "labs-sdk-naming", mailbox: LABS.email, folder: "archive", unread: false,
		subject: "Go SDK: name of the incidents client",
		messages: [
			{ from: NADIA, to: [LABS], at: { d: 6, t: "11:20" },
				body: `Two options for the Go SDK: northwind.Incidents() or northwind.NewIncidentClient(). The Python SDK uses the first. I'd keep them the same unless someone objects by Wednesday.\n\nNadia` },
			{ from: TOMAS, to: [LABS], at: { d: 6, t: "12:02" },
				body: `Keep them the same. It also matches the docs examples.\n\nTomás` },
		],
	},
	{
		key: "labs-v2-webhooks", mailbox: LABS.email, folder: "snoozed", snoozeHours: 24 * 4 + 2, unread: false,
		subject: "Webhooks v2 switch-off: confirm the date",
		messages: [
			{ from: TOMAS, to: [LABS], at: { d: 3, t: "09:48" },
				body: `41 workspaces still send to v2 webhook endpoints. The plan is to switch v2 off on March 1 and email those workspaces on December 2. Please check the list for your customers before the email goes out.\n\nTomás` },
		],
	},
	{
		key: "labs-trash-digest", mailbox: LABS.email, folder: "trash", trashedDaysAgo: 1, unread: false,
		subject: "Dependency digest: 14 updates this week",
		messages: [
			{ from: P("Patchwise", "digest@patchwise.example"), to: [LABS], at: { d: 2, t: "06:00" },
				body: `14 dependency updates are waiting in 3 repositories. 12 are patch releases and 2 are minor releases. None fixes a security advisory.` },
		],
	},
	{
		key: "labs-spam-token", mailbox: LABS.email, folder: "spam", unread: true,
		spam: { score: 5, signals: [SPAM.dmarc] },
		subject: "Your package registry token was exposed",
		messages: [
			{ from: P("Registry Security", "security@registry-alerts-desk.example"), to: [LABS], auth: AUTH_FAIL, at: { d: 2, t: "01:19" },
				body: `We detected one of your publish tokens in a public repository. Sign in within 24 hours to rotate it, or publishing is disabled for your organisation.` },
		],
	},

	// ───────────────────────────── hello@harborline.example ─────────────────────────────
	{
		key: "oakolive", mailbox: HARBOR.email, ai: "customers", unread: true,
		subject: "Agency plan: 14 client changelogs",
		messages: [
			{ from: ZOE, to: [HARBOR], at: { d: 1, t: "12:44" },
				body: `Hello Harborline,\n\nWe're a product studio in Bath and want a changelog for each of our 14 client apps, each on the client's own domain. Does the Agency plan cover that, and can each client have separate billing?\n\nZoe Chambers\nOak & Olive` },
		],
	},
	{
		key: "widget-react", mailbox: HARBOR.email, ai: "customers", unread: true,
		subject: "Embedding the widget in a React app",
		messages: [
			{ from: INES, to: [HARBOR], ago: 83,
				body: `Hi,\n\nThe script tag works on our marketing site, but in our React app the "What's new" badge shows the unread count once and never updates. Is there a package or a hook we should use instead?\n\nInes Ferreira\nQuiet Harbor` },
		],
	},
	{
		key: "devjournal", mailbox: HARBOR.email, unread: false, starred: true,
		subject: "Tools roundup feature: screenshots?",
		messages: [
			{ from: MEI, to: [HARBOR], at: { d: 2, t: "09:05" },
				body: `Hi! We'd like to feature Harborline in our December roundup of tools for small product teams. Could you send two high-res screenshots by Friday?\n\nMei Lin\nDev Journal` },
			{ from: SAM, to: [MEI], sent: true, from_mailbox: true, at: { d: 2, t: "10:30" }, attachments: [{ name: "harborline-widget-01.jpg", kind: "jpg", kb: 3420 }, { name: "harborline-changelog-02.jpg", kind: "jpg", kb: 2985 }],
				body: `Hi Mei, how exciting, thank you! Two screenshots attached. Let me know if you need one of the editor too.\n\nSam` },
		],
	},
	{
		key: "harbor-dark-theme", mailbox: HARBOR.email, ai: "customers", folder: "archive", unread: false,
		subject: "Dark theme for the widget?",
		messages: [
			{ from: ROSA, to: [HARBOR], at: { d: 5, t: "13:15" },
				body: `Hi,\n\nOur app has a dark mode and the changelog widget stays white. Is there a setting for it?\n\nRosa Jimenez\nMarlow Labs` },
			{ from: SAM, to: [ROSA], sent: true, from_mailbox: true, at: { d: 5, t: "13:50" },
				body: `Hi Rosa,\n\nThere is: add data-theme="auto" to the script tag and the widget follows your app's colour scheme. "dark" and "light" force one.\n\nSam` },
			{ from: ROSA, to: [HARBOR], at: { d: 5, t: "14:05" }, body: `Works. Thanks for the quick answer!\n\nRosa` },
		],
	},
	{
		key: "harbor-podcast", mailbox: HARBOR.email, folder: "snoozed", snoozeHours: 24 * 4 + 5, unread: false,
		subject: "Come on Small Bets Radio in January?",
		messages: [
			{ from: P("Carys Vaughn", "carys@smallbetsradio.example"), to: [HARBOR], at: { d: 3, t: "17:26" },
				body: `Hi Sam,\n\nI host a podcast about small software businesses. Would you come on in January and talk about running Harborline with two people? Recording takes 40 minutes and I can work around your calendar.\n\nCarys Vaughn\nSmall Bets Radio` },
		],
	},
	{
		key: "harbor-trash", mailbox: HARBOR.email, folder: "trash", trashedDaysAgo: 2, unread: false,
		subject: "Your listing on ToolShelf is waiting for review",
		messages: [
			{ from: P("ToolShelf", "listings@toolshelf.example"), to: [HARBOR], at: { d: 3, t: "07:45" },
				body: `Thanks for submitting Harborline. Listings are reviewed in order; yours is number 212 in the queue. Upgrade to a featured listing to skip it.` },
		],
	},
	{
		key: "harbor-spam", mailbox: HARBOR.email, folder: "spam", unread: false,
		spam: { score: 5, signals: [SPAM.spfDkim] },
		subject: "Trademark notice: harborline domain names in Asia",
		messages: [
			{ from: P("Registration Office", "notice@domain-registry-office.example"), to: [HARBOR], auth: AUTH_FAIL, at: { d: 4, t: "03:33" },
				body: `A third party has applied to register "harborline" under several country domains. As the brand owner you have seven days to object and register them yourself.` },
		],
	},
];

/** Mailboxes where the Screener is on (first-time senders wait for a Yes or No). */
export const SCREENER_ON = [MAYA.email];

/** Drafts: [mailbox, {to, subject, body, replyTo?: thread key}] */
export const DRAFTS = [
	{ mailbox: MAYA.email, to: MARCUS.email, subject: "Re: Renewal: Stratus Cloud committed spend", thread: "stratus-renewal",
		body: "<p>Hi Marcus,</p><p>Thanks for the terms. We're keen to stay. Before we commit, could we look at a two-year term at 15% off, keeping the $20,000 in migration credits?</p>" },
	{ mailbox: MAYA.email, to: "everyone@northwind.example", subject: "Holiday on-call rota: Dec 23 – Jan 2",
		body: "<p>Hi all,</p><p>A quick note on the holidays. We stop shipping on December 23 and start again January 2. Support runs a reduced rota (9–1) on the 27th–30th, and on-call is covered in pairs so nobody carries the pager alone.</p>" },
	{ mailbox: SUPPORT.email, to: LUCA.email, subject: "Re: Webhook signature check failing", thread: "webhook-signature",
		body: "<p>Buongiorno Luca,</p><p>Please leave the check on. A mismatch on some requests usually means the body is parsed before it is verified, so the bytes differ. Verify against the raw request body and it should pass every time. If it doesn't, send me one failing request id and I'll trace it.</p>" },
];

/** Scheduled sends. `in` = minutes from now. */
export const SCHEDULED = [
	{ mailbox: MAYA.email, to: [DANIEL.email, AIKO.email, LENA.email], subject: "Monday leadership sync: agenda", inMinutes: 60 * 24 * 3 + 37,
		html: "<p>Agenda for Monday:</p><ol><li>Brightcup rollout (Dec 9–11)</li><li>Incident Timeline launch sign-off</li><li>Q1 forecast and on-call scheduling timeline</li><li>Holiday rota</li></ol>" },
	{ mailbox: MAYA.email, to: [RUTH.email], subject: "Following up on incident tooling", inMinutes: 60 * 18 + 12,
		html: "<p>Hi Ruth,</p><p>Thanks again for Tuesday's call. As promised, attached is a short overview of how two companies with 20+ engineering teams rolled Northwind out, with their time-to-acknowledge before and after.</p><p>Maya</p>" },
	{ mailbox: SALES.email, to: [FINN.email], subject: "Copperleaf demo: Dec 4 at 10am", inMinutes: 60 * 20 + 3,
		html: "<p>Hi Finn,</p><p>We'd love to show you around on December 4 at 10am. We'll have on-call scheduling and an early look at Incident Timeline set up on a copy of your own monitors.</p><p>Daniel</p>" },
];

/** Sends held for approval: API tokens acting for one mailbox each. */
export const APPROVALS = [
	{
		tokenName: "Renewals assistant", mailbox: SALES.email, fromName: "Northwind Sales", to: OSKAR.email,
		subject: "Your annual plan renews on December 1",
		html: "<p>Hi Oskar,</p><p>Your Northwind Team plan (25 seats) renews on December 1 for another year at $5,700. It includes unlimited status pages, SMS and voice alerts, and priority support.</p><p>As an apology for last week's delayed alerts, we've added a second month of credit to your renewal.</p><p>Reply to this email if you'd like to change anything.</p><p>Northwind Sales</p>",
	},
	{
		tokenName: "Renewals assistant", mailbox: SALES.email, fromName: "Northwind Sales", to: ARJUN.email,
		subject: "Re: Pricing for 60 seats",
		html: "<p>Hi Arjun,</p><p>Following up on the quote for 60 seats on the Team plan. If you confirm before December 15, we can hold this year's pricing and start onboarding in January.</p><p>Daniel</p>",
	},
	{
		tokenName: "Sales assistant", mailbox: SALES.email, fromName: "Northwind Sales", to: RAFAEL.email,
		subject: "On-call scheduling early access: you're on the list",
		html: "<p>Hi Rafael,</p><p>Thanks for your interest in on-call scheduling. You're on the early-access list; we'll be in touch in February with dates for the first workspaces.</p><p>Northwind Sales</p>",
	},
];

export const TEMPLATES = [
	// After signup: the trial onboarding series.
	{ slug: "signup-welcome", name: "Signup: welcome", subject: "Welcome to Northwind, {{firstName}}",
		bodyHtml: "<p>Hi {{firstName}},</p><p>Welcome to Northwind. Your 14-day trial of the Team plan has started, with nothing to install and no card needed.</p><p>The fastest way to see what it does is to add one monitor. It takes about two minutes: northwind.example/docs/quickstart.</p><p>Reply to this email if you get stuck. A person reads every reply.</p><p>Daniel</p>" },
	{ slug: "signup-first-monitor", name: "Signup: your first monitor", subject: "Your first monitor in 2 minutes",
		bodyHtml: "<p>Hi {{firstName}},</p><p>Most teams start with one check on the page customers hit first: the login page or the API health endpoint.</p><p>Add its address, pick how you want to be told (push, SMS or a call), and you're covered tonight.</p>" },
	{ slug: "signup-invite-team", name: "Signup: invite your team", subject: "Who else is on call with you?",
		bodyHtml: "<p>Hi {{firstName}},</p><p>An alert that only reaches one person is a single point of failure. Invite the people who share on-call with you, and set who is paged second if the first person doesn't answer within five minutes.</p>" },
	{ slug: "signup-trial-midpoint", name: "Signup: halfway through the trial", subject: "Halfway through your trial: what {{company}} has set up",
		bodyHtml: "<p>Hi {{firstName}},</p><p>You're a week into your trial. Teams that keep Northwind usually have three things in place by now: a monitor, a second person on call, and a public status page.</p><p>Want a 15-minute call to set up whichever is missing?</p>" },
	{ slug: "signup-trial-ending", name: "Signup: trial ends in 3 days", subject: "Your trial ends in 3 days",
		bodyHtml: "<p>Hi {{firstName}},</p><p>Your trial ends in three days. Everything you set up stays as it is when you choose a plan, and nothing is charged until you do.</p><p>If the timing is wrong, reply and I'll extend it.</p>" },
	// Cold outreach to engineering leaders.
	{ slug: "cold-intro", name: "Cold outreach: first email", subject: "How does {{company}} find out it's down?",
		bodyHtml: "<p>Hi {{firstName}},</p><p>Quick question: when something breaks at night at {{company}}, who finds out first, your team or your customers?</p><p>Northwind pages on-call and updates your status page from the same alert, so customers hear it from you. Worth 15 minutes to see it on your own monitors?</p><p>Daniel Reyes<br>Northwind</p>" },
	{ slug: "cold-follow-up", name: "Cold outreach: follow-up", subject: "Re: How does {{company}} find out it's down?",
		bodyHtml: "<p>Hi {{firstName}},</p><p>One more thought and then I'll leave you alone. Teams your size usually tell us the slow part is not detecting the outage, it's telling customers.</p><p>Here's a two-minute video of the status page updating itself: northwind.example/demo.</p>" },
	{ slug: "cold-proof", name: "Cold outreach: customer story", subject: "How Brightcup cut time-to-acknowledge by 40%",
		bodyHtml: "<p>Hi {{firstName}},</p><p>Brightcup moved six teams onto Northwind in a week. Their median time to acknowledge an alert went from 11 minutes to under 7, mostly because the second person is paged automatically.</p><p>Happy to show you how they set it up.</p>" },
	{ slug: "cold-breakup", name: "Cold outreach: last email", subject: "Should I close your file?",
		bodyHtml: "<p>Hi {{firstName}},</p><p>I haven't heard back, so I'll assume incident tooling isn't a priority at {{company}} right now and stop writing.</p><p>If that changes, reply to this email any time and it comes straight to me.</p>" },
	// After a demo.
	{ slug: "demo-thanks", name: "Demo: thanks and recording", subject: "Thanks for today, {{firstName}}",
		bodyHtml: "<p>Hi {{firstName}},</p><p>Thanks for the time today. As promised: the recording, the pricing for your team size, and the migration guide from your current tool.</p>" },
	{ slug: "demo-security", name: "Demo: security answers", subject: "Security and SSO answers for {{company}}",
		bodyHtml: "<p>Hi {{firstName}},</p><p>The questions your security team will ask, answered in one place: our SOC 2 Type II report (under NDA), SSO and SCIM setup, data residency and audit logs.</p>" },
	{ slug: "demo-next-step", name: "Demo: next step", subject: "A pilot with one team?",
		bodyHtml: "<p>Hi {{firstName}},</p><p>The lowest-risk way to decide is a two-week pilot with one team. We set it up with you and you keep your current tool running alongside.</p>" },
	// Customers who left, and renewals.
	{ slug: "winback-changes", name: "Win-back: what changed", subject: "What's changed since your trial",
		bodyHtml: "<p>Hi {{firstName}},</p><p>Since your trial ended we've shipped on-call schedules, voice calls and per-workspace webhook queues. If one of those was the gap, I'd be glad to reopen your workspace for two weeks.</p>" },
	{ slug: "winback-feedback", name: "Win-back: one question", subject: "One question, {{firstName}}",
		bodyHtml: "<p>Hi {{firstName}},</p><p>What was the main reason Northwind wasn't right for {{company}}? A one-line reply helps more than you'd think.</p>" },
	{ slug: "renewal-reminder", name: "Renewal: 30-day notice", subject: "Your annual plan renews next month",
		bodyHtml: "<p>Hi {{firstName}},</p><p>Your Northwind plan renews next month at the same price. Reply if you'd like to change seats or plan before then.</p>" },
];

// `delayHours` is the wait after the step before it, not after enrolment: the
// onboarding emails go out on days 0, 1, 3, 7 and 11 of a 14-day trial.
export const SEQUENCES = [
	{ name: "New signup onboarding", steps: [
		{ order: 1, templateSlug: "signup-welcome", delayHours: 0 },
		{ order: 2, templateSlug: "signup-first-monitor", delayHours: 24 },
		{ order: 3, templateSlug: "signup-invite-team", delayHours: 24 * 2 },
		{ order: 4, templateSlug: "signup-trial-midpoint", delayHours: 24 * 4 },
		{ order: 5, templateSlug: "signup-trial-ending", delayHours: 24 * 4 },
	], enroll: [GRETA, JONAH, YUKI, AMARA, PETER, SOFIA] },
	{ name: "Cold outreach: engineering leaders", steps: [
		{ order: 1, templateSlug: "cold-intro", delayHours: 0 },
		{ order: 2, templateSlug: "cold-follow-up", delayHours: 24 * 3 },
		{ order: 3, templateSlug: "cold-proof", delayHours: 24 * 4 },
		{ order: 4, templateSlug: "cold-breakup", delayHours: 24 * 5 },
	], enroll: [TESS, HUGO, CALLUM, DALIA, MATEO] },
	{ name: "Demo follow-up", steps: [
		{ order: 1, templateSlug: "demo-thanks", delayHours: 2 },
		{ order: 2, templateSlug: "demo-security", delayHours: 46 },
		{ order: 3, templateSlug: "demo-next-step", delayHours: 24 * 4 },
	], enroll: [ARJUN, RUTH, SIGNE] },
	{ name: "Trial ended: win-back", steps: [
		{ order: 1, templateSlug: "winback-changes", delayHours: 0 },
		{ order: 2, templateSlug: "winback-feedback", delayHours: 24 * 7 },
	], enroll: [ROSA, THEO] },
	{ name: "Annual renewal reminders", steps: [
		{ order: 1, templateSlug: "renewal-reminder", delayHours: 0 },
	], enroll: [] },
];

/** Custom folders per mailbox. */
export const FOLDERS = { [MAYA.email]: ["Receipts"] };

/** Labels per mailbox (user labels). Colours are the app's palette. */
export const LABEL_COLORS = {
	Deals: "#4f46e5", Launch: "#d946ef", Hiring: "#f97316", Finance: "#10b981", Leads: "#8b5cf6", Urgent: "#dc2626",
};

/** AI triage presets enabled per mailbox (fewer on Maya's, whose sidebar also lists her own labels). */
export const TRIAGE_PRESETS_ON = {
	default: ["customers", "billing", "vendors"],
	[MAYA.email]: ["customers", "vendors"],
};

/** Links in sent mail that recipients "clicked" (seed-demo.mjs, engagement events). */
export const CLICK_LINKS = [
	"https://northwind.example/docs/quickstart",
	"https://northwind.example/pricing",
	"https://northwind.example/demo",
	"https://northwind.example/security",
	"https://northwind.example/changelog",
];

/**
 * A month of earlier outbound mail from the shared mailboxes, so Sent and the
 * analytics charts have history. Single messages, already answered.
 */
const HISTORY_CUSTOMERS = [BEA, KWAME, ELENA, LUCA, NOOR, FINN, ZOE, ARJUN, ISLA, RAFAEL, OSKAR, PRIYA,
	HUGO, AMARA, PETER, SOFIA, YUKI, CALLUM, DALIA, MATEO, JONAH, SIGNE];
const HISTORY_SUBJECTS = [
	["support@northwind.example", "Re: Alerts for scheduled maintenance", "Hi {first},\n\nSet a maintenance window under Monitors → Schedule and alerts are held for that period. Your status page shows the window automatically. Our guide is at northwind.example/docs/maintenance.\n\nNorthwind Support"],
	["support@northwind.example", "Re: Check interval on the Team plan", "Hi {first},\n\nThe Team plan checks every 30 seconds from three regions by default. You can change the interval per monitor under Settings → Checks.\n\nNorthwind Support"],
	["support@northwind.example", "Your onboarding call is booked", "Hi {first},\n\nYour onboarding call is booked for {day} at 10am. We'll set up monitors, on-call and your status page together; bring whoever shares on-call with you.\n\nNorthwind Support"],
	["support@northwind.example", "Re: Status page subscribers", "Hi {first},\n\nYes, customers can subscribe by email, SMS or RSS, and you can import an existing list from a CSV. No charge for subscribers on any plan.\n\nNorthwind Support"],
	["support@northwind.example", "Re: 502 from the monitors API", "Hi {first},\n\nThat 502 was a deploy on our side between 14:02 and 14:06 UTC. Requests are safe to retry; if you see it again, reply with the request id and we'll trace it.\n\nNorthwind Support"],
	["sales@northwind.example", "Your Northwind quote", "Hi {first},\n\nThanks for your interest. Your quote is attached, including onboarding and migration from your current tool. It's valid for 30 days.\n\nDaniel Reyes"],
	["sales@northwind.example", "Thanks for today, {first}", "Hi {first},\n\nThanks for the time today. Any questions from the team? Happy to set up a two-week pilot with one team at {company}.\n\nDaniel Reyes"],
	["sales@northwind.example", "How does {company} find out it's down?", "Hi {first},\n\nQuick question: when something breaks at night at {company}, who finds out first, your team or your customers? Northwind pages on-call and updates your status page from the same alert.\n\nWorth 15 minutes?\n\nDaniel Reyes"],
	["support@northwind.example", "Re: Slack and Teams notifications", "Hi {first},\n\nBoth are built in. Connect either under Integrations and choose which monitors post to which channel.\n\nNorthwind Support"],
	["support@northwind.example", "Re: Exporting incident history", "Hi {first},\n\nYou can export incidents as CSV from Incidents → Export, or pull them from the API. History is kept for the life of the workspace.\n\nNorthwind Support"],
	["support@northwind.example", "Your refund has been issued", "Hi {first},\n\nGood news: the refund is on its way and should reach your card by {day}. The credit note is under Billing.\n\nNorthwind Support"],
	["sales@northwind.example", "Welcome to Northwind, {first}", "Hi {first},\n\nWelcome to Northwind. Your 14-day trial of the Team plan has started. The fastest way to see what it does is to add one monitor: northwind.example/docs/quickstart.\n\nDaniel Reyes"],
	["sales@northwind.example", "Your trial ends in 3 days", "Hi {first},\n\nYour trial ends on {day}. Everything you set up stays as it is when you choose a plan. If the timing is wrong, reply and I'll extend it.\n\nDaniel Reyes"],
	["sales@northwind.example", "Order confirmed", "Hi {first},\n\nYour order is confirmed and your workspace moves to the annual plan on {day}. The invoice follows by email.\n\nDaniel Reyes"],
];
const HISTORY_TIMES = ["08:52", "09:17", "09:41", "10:06", "10:38", "11:12", "11:47", "13:24", "14:03", "14:36", "15:19", "15:58", "16:27", "17:11"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
for (let d = 3, i = 0; d <= 29; d++) {
	const perDay = [3, 5, 2, 6, 4, 5, 3][d % 7];
	for (let k = 0; k < perDay; k++, i++) {
		const [mailbox, subject, body] = HISTORY_SUBJECTS[(i * 5 + d) % HISTORY_SUBJECTS.length];
		const who = HISTORY_CUSTOMERS[(i * 7 + k) % HISTORY_CUSTOMERS.length];
		const fill = (s) => s.replaceAll("{first}", who.name.split(" ")[0]).replaceAll("{company}", who.company ?? "your team").replaceAll("{day}", WEEKDAYS[(i + d) % 5]);
		THREADS.push({
			key: `history-${d}-${k}`, mailbox, history: true, unread: false,
			subject: fill(subject),
			messages: [{
				from: { name: mailbox.startsWith("sales") ? "Daniel Reyes" : "Aiko Tanaka", email: mailbox }, to: [who], sent: true, from_mailbox: true,
				...(i % 4 === 1 ? { cc: [HISTORY_CUSTOMERS[(i * 11 + 3) % HISTORY_CUSTOMERS.length]] } : {}),
				at: { d, t: HISTORY_TIMES[(i * 3 + k) % HISTORY_TIMES.length] },
				body: fill(body),
			}],
		});
	}
}
