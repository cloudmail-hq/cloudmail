// Demo content for scripts/demo/seed-demo.mjs.
//
// A fictional company, Northwind Supply Co., sells commercial coffee equipment
// to cafés and hotels. Northwind Labs builds its firmware; Harborline Goods is
// its retail brand. Every person, company and address below is invented, and
// every domain is under the reserved `.example` TLD (RFC 2606).
//
// Times: `ago` is minutes before the seed runs (for today's mail), or
// `{ d, t }` = d days ago at local time t ("HH:MM") in the demo time zone,
// which seed-demo.mjs picks so that "now" is mid-morning.

export const MAILBOXES = [
	{ email: "maya@northwind.example", name: "Maya Okafor", signature: "Maya Okafor\nHead of Operations, Northwind Supply Co.\n+1 (555) 014-2290" },
	{ email: "support@northwind.example", name: "Northwind Support", signature: "Northwind Support\nMon–Fri, 8am–6pm ET · support@northwind.example" },
	{ email: "sales@northwind.example", name: "Northwind Sales", signature: "Daniel Reyes\nWholesale, Northwind Supply Co." },
	{ email: "team@northwindlabs.example", name: "Northwind Labs", signature: "Northwind Labs" },
	{ email: "hello@harborline.example", name: "Harborline Goods", signature: "Harborline Goods · Small-batch homewares" },
];

const P = (name, email) => ({ name, email });

// Internal people
export const MAYA = P("Maya Okafor", "maya@northwind.example");
const DANIEL = P("Daniel Reyes", "daniel@northwind.example");
const LENA = P("Lena Fischer", "lena@northwind.example");
const AIKO = P("Aiko Tanaka", "aiko@northwind.example");
const TOMAS = P("Tomás Varga", "tomas@northwindlabs.example");
const SAM = P("Sam Whitfield", "sam@harborline.example");
const SUPPORT = P("Northwind Support", "support@northwind.example");
const SALES = P("Daniel Reyes", "sales@northwind.example");
const LABS = P("Northwind Labs", "team@northwindlabs.example");
const HARBOR = P("Harborline Goods", "hello@harborline.example");

// External people and services (all fictional)
const PRIYA = P("Priya Raman", "priya@brightcup.example");
const FJORD = P("Fjord Freight Dispatch", "dispatch@fjordfreight.example");
const LEDGERLY = P("Ledgerly Billing", "billing@ledgerly.example");
const HANA = P("Hana Kobayashi", "hana@kobayashi-steel.example");
const BUILDS = P("Labs CI", "builds@northwindlabs.example");
const OSKAR = P("Oskar Lind", "oskar@cafelumen.example");
const BRIEF = P("The Supply Chain Brief", "editor@supplybrief.example");
const GRACE = P("Grace Holt", "grace@holtadvisory.example");
const RUTH = P("Ruth Abara", "ruth.abara@meridianhotels.example");
const PAYSPROUT = P("PaySprout Payroll", "notifications@paysprout.example");
const MARCUS = P("Marcus Bell", "marcus@riversidetradepark.example");
const JORDAN = P("Jordan Pike", "jordan@growthloop.example");
const SUMMIT = P("Port Coffee Summit", "events@portcoffeesummit.example");
const STRATUS = P("Stratus Cloud", "billing@stratuscloud.example");
const PEOPLE = P("Northwind People Team", "people@northwind.example");
const BEA = P("Bea Santos", "bea@morningowl.example");
const KWAME = P("Kwame Mensah", "kwame@tidewatercoffee.example");
const ELENA = P("Elena Petrova", "elena@petrovabakehouse.example");
const LUCA = P("Luca Moretti", "luca@moretticafe.example");
const NOOR = P("Noor Haddad", "noor@saltandcrumb.example");
const FINN = P("Finn O'Brien", "finn@copperleafcoffee.example");
const ZOE = P("Zoe Chambers", "zoe@oakandolive.example");
const MEI = P("Mei Lin", "mei@homejournal.example");
const ARJUN = P("Arjun Mehta", "arjun@lanternstays.example");
const ISLA = P("Isla Grant", "isla@grantandco.example");
const BETA = P("Rafael Duarte", "rafael@duartecoffee.example");

const sig = (name, title) => `\n\n${name}${title ? `\n${title}` : ""}`;

/**
 * Threads. `mailbox` is the mailbox it lives in; a message with `sent: true` is
 * from that mailbox. `ai` is the AI triage label; `labels` are user labels.
 */
export const THREADS = [
	// ───────────────────────────── maya@northwind.example ─────────────────────────────
	{
		key: "brightcup-q4", mailbox: MAYA.email, ai: "customers", labels: ["Orders"], unread: true,
		subject: "Q4 wholesale order: Brightcup Roasters (48 units)",
		summary: {
			line: "Brightcup confirms 48 S2 machines across 6 sites; needs delivery before Dec 12 and net-45 terms.",
			bullets: ["PO-2291 attached: 48 × Model S2, 12 × grinder bundles", "Asks for delivery to all six cafés before Dec 12", "Wants net-45 instead of net-30; Maya offered net-30 + 2% early-pay"],
		},
		messages: [
			{ from: PRIYA, to: [MAYA], at: { d: 2, t: "16:42" }, attachments: [{ name: "PO-2291-Brightcup.pdf", kind: "pdf", kb: 182 }],
				body: `Hi Maya,\n\nAs promised, here's our purchase order for the holiday rollout: 48 Model S2 machines and 12 grinder bundles, split across our six cafés.\n\nCould you confirm lead times? We'd love everything installed before December 12 so the baristas get a week of practice before the rush.${sig("Priya Raman", "Operations Director, Brightcup Roasters")}` },
			{ from: MAYA, to: [PRIYA], sent: true, at: { d: 1, t: "09:18" },
				body: `Hi Priya,\n\nThanks for the PO. We have 40 units in the Newark warehouse today and the remaining 8 land on Dec 3, so a Dec 9–11 install window works.\n\nOn terms: we can do net-30 with a 2% early-payment discount. Would that work for your finance team?${sig("Maya")}` },
			{ from: PRIYA, to: [MAYA], cc: [DANIEL], ago: 26,
				body: `Hi Maya,\n\nDec 9–11 is perfect. Finance asked whether net-45 is possible given the size of the order. If not, net-30 with the 2% discount is fine and we'll sign today.\n\nAlso, can Daniel send the install checklist for the site managers?${sig("Priya")}` },
		],
	},
	{
		key: "fjord-pickup", mailbox: MAYA.email, ai: "vendors", unread: true,
		subject: "Pickup confirmed: Monday 7:30 AM, Newark DC",
		summary: { line: "Fjord Freight will collect 14 pallets Monday 7:30 AM; bill of lading attached.", bullets: ["14 pallets, 2 trucks, dock 3", "Driver contact shared the evening before"] },
		messages: [
			{ from: FJORD, to: [MAYA], ago: 71, attachments: [{ name: "BOL-88213.pdf", kind: "pdf", kb: 64 }],
				body: `Hello Maya,\n\nYour pickup is confirmed for Monday at 7:30 AM at the Newark distribution centre, dock 3. We're sending two trucks for the 14 pallets.\n\nThe bill of lading is attached. Your driver's name and number will follow the evening before.\n\nFjord Freight Dispatch` },
		],
	},
	{
		key: "hostex-booth", mailbox: MAYA.email, labels: ["Events"], unread: true,
		subject: "Booth layout for HostEx Chicago",
		summary: { line: "Daniel's v3 booth plan moves the espresso bar forward; he needs Maya's sign-off by tomorrow.", bullets: ["Two live demo stations, one quiet meeting corner", "Power order goes in Monday", "Aiko will staff Saturday"] },
		messages: [
			{ from: DANIEL, to: [MAYA], cc: [AIKO], at: { d: 3, t: "11:05" }, attachments: [{ name: "booth-plan-v2.png", kind: "png", kb: 846 }],
				body: `Maya, first pass at the HostEx booth attached. 20×20 corner spot, two demo stations, a small meeting area at the back.\n\nOne question: do we bring the S2 or the new S3 prototype? Labs says the S3 is "probably fine" for a weekend.\n\nDaniel` },
			{ from: MAYA, to: [DANIEL], cc: [AIKO], sent: true, at: { d: 3, t: "13:32" },
				body: `Love it. Let's bring two S2s for the demos and keep the S3 under glass as a teaser. "Probably fine" isn't a phrase I want near 4,000 café owners.\n\nCan we move the espresso bar to the front so people can see it from the aisle?\n\nM` },
			{ from: AIKO, to: [DANIEL, MAYA], at: { d: 2, t: "10:14" },
				body: `+1 to the bar up front. I can staff Saturday and run the milk-texturing demos. We should also print the warranty cards, people always ask.\n\nAiko` },
			{ from: DANIEL, to: [MAYA], cc: [AIKO], ago: 132, attachments: [{ name: "booth-plan-v3.png", kind: "png", kb: 912 }],
				body: `v3 attached with the bar moved forward and the S3 in a display case.\n\nI need to place the power order on Monday, so a thumbs-up by tomorrow would be great.\n\nDaniel` },
		],
	},
	{
		key: "ledgerly-inv", mailbox: MAYA.email, ai: "billing", unread: false,
		subject: "Invoice INV-20418 is ready",
		summary: { line: "Ledgerly invoice for November, $1,240.00, due Dec 1; auto-pay is on.", bullets: [] },
		messages: [
			{ from: LEDGERLY, to: [MAYA], ago: 214, attachments: [{ name: "INV-20418.pdf", kind: "pdf", kb: 41 }],
				body: `Hi Northwind Supply Co.,\n\nYour invoice INV-20418 for $1,240.00 is ready. Payment will be collected automatically on December 1 from the card ending 4402.\n\nThanks for using Ledgerly.` },
		],
	},
	{
		key: "kobayashi-quote", mailbox: MAYA.email, ai: "vendors", unread: true,
		subject: "Revised quote: conical burr sets (2,000 units)",
		summary: { line: "Kobayashi Steel cut the burr price 6% for a 2,000-unit commitment; quote valid to Dec 5.", bullets: ["$11.40 → $10.72 per set", "8-week lead time from deposit", "Valid until December 5"] },
		messages: [
			{ from: HANA, to: [MAYA], cc: [TOMAS], at: { d: 1, t: "14:51" }, attachments: [{ name: "Quote-KS-1187-rev2.xlsx", kind: "xlsx", kb: 38 }],
				body: `Dear Maya,\n\nThank you for the call on Monday. With a 2,000-unit commitment we can offer $10.72 per conical burr set, down from $11.40. Lead time is eight weeks from deposit.\n\nThe revised quote is attached and valid until December 5. Tomás, the hardness certificates for the new alloy will follow this week.\n\nKind regards,\nHana Kobayashi\nKobayashi Steel Works` },
		],
	},
	{
		key: "labs-build", mailbox: MAYA.email, unread: false,
		subject: "Weekly firmware build report: 2.4.0-rc3 passed",
		messages: [
			{ from: BUILDS, to: [MAYA], at: { d: 1, t: "06:02" },
				body: `Firmware 2.4.0-rc3\n\nAll 412 tests passed. Boiler PID tuning regression fixed. Two flaky tests quarantined (grinder dose timing).\n\nNext release candidate: Tuesday.` },
		],
	},
	{
		key: "lumen-warranty", mailbox: MAYA.email, ai: "customers", unread: false, starred: true,
		subject: "Warranty claim: Model S2 pressure drop (serial S2-04417)",
		summary: { line: "Café Lumen's S2 loses pressure mid-shot; support shipped a replacement pump, technician visit Friday.", bullets: ["Under warranty until March", "Replacement pump shipped yesterday", "Oskar wants a loaner machine for the weekend"] },
		messages: [
			{ from: OSKAR, to: [SUPPORT], cc: [MAYA], at: { d: 2, t: "08:37" }, attachments: [{ name: "pressure-gauge.jpg", kind: "jpg", kb: 1480 }],
				body: `Hello,\n\nOur S2 (serial S2-04417) drops from 9 bar to about 6 halfway through every shot since Saturday. Photo of the gauge attached. We descaled on schedule.\n\nWe're a small café and this is our only machine. What are our options?\n\nOskar Lind\nCafé Lumen` },
			{ from: MAYA, to: [OSKAR], cc: [SUPPORT], sent: true, at: { d: 2, t: "09:58" },
				body: `Hi Oskar,\n\nSorry about this. That pattern usually means a failing pump, and you're covered under warranty until March. We've shipped a replacement pump today and a technician will fit it on Friday.\n\nIn the meantime I'll see if we can get a loaner to you for the weekend.\n\nMaya` },
			{ from: OSKAR, to: [MAYA], at: { d: 1, t: "17:20" },
				body: `Thank you Maya, that's a relief. A loaner for the weekend would really save us. Saturday is our busiest day.\n\nOskar` },
		],
	},
	{
		key: "board-pack", mailbox: MAYA.email, labels: ["Finance"], unread: false, starred: true,
		subject: "Board pack draft for Nov 28",
		summary: { line: "Lena's board pack draft needs the ops section (inventory turns, on-time delivery) by Monday.", bullets: ["Revenue +18% YoY, gross margin 41%", "Ops section: inventory turns and OTD", "Due Monday EOD"] },
		messages: [
			{ from: LENA, to: [MAYA], at: { d: 1, t: "11:26" }, attachments: [{ name: "Board-pack-Nov28-DRAFT.pdf", kind: "pdf", kb: 2310 }],
				body: `Hi Maya,\n\nDraft board pack attached. Headline numbers: revenue +18% year on year, gross margin 41%, cash runway comfortable.\n\nCould you fill in the operations section (inventory turns, on-time delivery, warranty rate) by Monday EOD? Two slides max.\n\nLena` },
		],
	},
	{
		key: "supply-brief", mailbox: MAYA.email, folder: "archive", unread: false,
		subject: "The Supply Chain Brief: container rates ease ahead of the holidays",
		messages: [
			{ from: BRIEF, to: [MAYA], at: { d: 2, t: "07:00" },
				body: `This week: spot container rates on the trans-Pacific lane fell for the fourth week running; Rotterdam congestion is easing; and three ways small importers are hedging against January surcharges.\n\nRead the full issue online.` },
		],
	},
	{
		key: "meridian-intro", mailbox: MAYA.email, ai: "customers", unread: false,
		subject: "Intro: Ruth Abara (Meridian Hotels procurement)",
		summary: { line: "Grace introduced Ruth from Meridian Hotels, who's reviewing breakfast-service equipment for 22 properties.", bullets: ["22 hotels, RFP expected in January", "Maya set a call for Tuesday 2pm"] },
		messages: [
			{ from: GRACE, to: [MAYA, RUTH], at: { d: 3, t: "15:10" },
				body: `Maya, Ruth: as promised, an introduction.\n\nRuth leads equipment procurement for Meridian Hotels and is reviewing breakfast-service coffee for their 22 properties. Maya runs operations at Northwind and knows commercial espresso better than anyone I know.\n\nI'll let you two take it from here.\n\nGrace` },
			{ from: MAYA, to: [RUTH], cc: [GRACE], sent: true, at: { d: 3, t: "16:02" },
				body: `Thanks Grace (moving you to cc).\n\nRuth, lovely to meet you. Would Tuesday at 2pm work for a 30-minute call? I'd love to hear how breakfast service runs today and where the bottlenecks are.\n\nMaya` },
			{ from: RUTH, to: [MAYA], at: { d: 2, t: "09:41" },
				body: `Hi Maya, Tuesday at 2pm works. I'll send an invite. We're aiming to issue an RFP in January, so the timing is good.\n\nRuth Abara\nProcurement Lead, Meridian Hotels` },
		],
	},
	{
		key: "harborline-catalogue", mailbox: MAYA.email, unread: false,
		subject: "Holiday catalogue proofs (v2)",
		messages: [
			{ from: SAM, to: [MAYA], at: { d: 2, t: "13:15" }, attachments: [{ name: "Harborline-Holiday-Proof-v2.pdf", kind: "pdf", kb: 5120 }],
				body: `Hi Maya,\n\nv2 proofs attached. We swapped the cover to the stoneware set and fixed the pricing on page 6. Printer needs final sign-off by Wednesday noon.\n\nSam` },
			{ from: MAYA, to: [SAM], sent: true, at: { d: 2, t: "15:47" },
				body: `Looks great. Signed off. One tiny thing: the pour-over kettle on p. 9 should say "1.0 L", not "1 L". Otherwise ship it.\n\nM` },
		],
	},
	{
		key: "payroll", mailbox: MAYA.email, ai: "billing", folder: "Receipts", unread: false,
		subject: "November payroll approved",
		messages: [
			{ from: PAYSPROUT, to: [MAYA], at: { d: 3, t: "10:00" },
				body: `Payroll for Northwind Supply Co. (Nov 1–15) was approved by Lena Fischer. 34 employees will be paid on November 20.` },
		],
	},
	{
		key: "lease", mailbox: MAYA.email, ai: "vendors", unread: false,
		subject: "Lease renewal: Unit 4B, Riverside Trade Park",
		summary: { line: "Landlord proposes a 3-year renewal at +4% with two months' rent-free fit-out; reply by Dec 15.", bullets: ["3-year term from April 1", "+4% on current rent", "Two months rent-free for fit-out"] },
		messages: [
			{ from: MARCUS, to: [MAYA], at: { d: 4, t: "12:20" }, attachments: [{ name: "Unit-4B-renewal-terms.pdf", kind: "pdf", kb: 312 }],
				body: `Hi Maya,\n\nAhead of your lease expiry on March 31, we'd like to offer a three-year renewal on Unit 4B at a 4% increase, with two months rent-free if you go ahead with the mezzanine fit-out.\n\nTerms attached. Could you let me know by December 15?\n\nMarcus Bell\nRiverside Trade Park` },
		],
	},
	{
		key: "nps", mailbox: MAYA.email, unread: false,
		subject: "October NPS: 61 (+7)",
		messages: [
			{ from: AIKO, to: [MAYA], at: { d: 4, t: "16:05" }, attachments: [{ name: "nps-october.csv", kind: "csv", kb: 18 }],
				body: `Hi Maya,\n\nOctober NPS came in at 61, up 7 points. Biggest drivers: faster technician visits and the new descaling guide. Detractors mostly mention delivery windows.\n\nRaw responses attached.\n\nAiko` },
		],
	},
	{
		key: "growthloop", mailbox: MAYA.email, unread: false,
		subject: "3x your B2B pipeline in 90 days?",
		messages: [
			{ from: JORDAN, to: [MAYA], at: { d: 5, t: "09:12" },
				body: `Hi Maya,\n\nI noticed Northwind is growing fast. We help wholesale brands triple qualified pipeline with AI-personalised outreach.\n\nWorth a 15-minute chat next week?\n\nJordan` },
		],
	},
	{
		key: "sso-tablets", mailbox: MAYA.email, unread: false,
		subject: "SSO for the warehouse tablets",
		messages: [
			{ from: TOMAS, to: [MAYA], at: { d: 5, t: "14:44" },
				body: `Maya, quick one: the warehouse tablets still use a shared password. I'd like to move them to SSO with passkeys before peak season. It's about a day of work and no cost.\n\nOK to schedule for next Tuesday?\n\nTomás` },
			{ from: MAYA, to: [TOMAS], sent: true, at: { d: 5, t: "15:03" },
				body: `Yes please, and thank you for pushing on this. Tuesday is fine; just give the night shift a heads-up.\n\nM` },
		],
	},
	{
		key: "summit", mailbox: MAYA.email, folder: "archive", unread: false,
		subject: "You're invited: Port Coffee Summit, Rotterdam, Feb 11–12",
		messages: [
			{ from: SUMMIT, to: [MAYA], at: { d: 6, t: "08:30" },
				body: `Join 900 roasters, importers and equipment makers in Rotterdam on February 11–12. Early-bird passes close December 1.` },
		],
	},
	{
		key: "littlefern", mailbox: MAYA.email, unread: false,
		subject: "Sample kit for Little Fern Bakery",
		messages: [
			{ from: DANIEL, to: [MAYA], at: { d: 6, t: "11:48" },
				body: `Little Fern (3 bakeries in Portland) asked for a sample kit before committing to grinders. OK to send the standard kit plus the decaf burrs?\n\nDaniel` },
			{ from: MAYA, to: [DANIEL], sent: true, at: { d: 6, t: "12:10" },
				body: `Yes, and add a printed dial-in guide. Bakeries usually run lighter roasts.\n\nM` },
		],
	},
	{
		key: "stratus", mailbox: MAYA.email, ai: "billing", folder: "Receipts", unread: false,
		subject: "Your October cloud usage: $312.48",
		messages: [
			{ from: STRATUS, to: [MAYA], at: { d: 7, t: "05:15" },
				body: `Your Stratus Cloud bill for October is $312.48 and has been charged to the card on file.` },
		],
	},
	{
		key: "welcome-elif", mailbox: MAYA.email, unread: false,
		subject: "Please welcome Elif to the warehouse team",
		messages: [
			{ from: PEOPLE, to: [MAYA], at: { d: 8, t: "09:00" },
				body: `Hi all,\n\nPlease welcome Elif Demir, who joins the Newark warehouse as Inventory Coordinator on Monday. Elif spent five years at a regional food distributor and is a serious latte-art competitor.\n\nSay hello if you see her around!\n\nPeople Team` },
		],
	},
	{
		key: "forecast", mailbox: MAYA.email, labels: ["Finance"], unread: false,
		subject: "Q1 demand forecast",
		messages: [
			{ from: MAYA, to: [LENA], cc: [DANIEL], sent: true, at: { d: 4, t: "10:12" }, attachments: [{ name: "Q1-forecast-v1.xlsx", kind: "xlsx", kb: 76 }],
				body: `Lena, Q1 forecast attached. We're assuming 15% growth on S2 units and a soft launch of the S3 in March. Daniel, shout if the hotel pipeline changes the picture.\n\nM` },
			{ from: LENA, to: [MAYA], cc: [DANIEL], at: { d: 4, t: "11:40" },
				body: `Thanks. This lines up with my cash model. I'll pull it into the board pack.\n\nLena` },
		],
	},
	{
		key: "ops-weekly", mailbox: MAYA.email, unread: false,
		subject: "Warehouse weekly: 98.2% on-time",
		messages: [
			{ from: P("Elif Demir", "elif@northwind.example"), to: [MAYA], at: { d: 7, t: "16:30" },
				body: `Weekly numbers: 98.2% on-time, 0 mis-picks, 2 damaged-in-transit claims (both Fjord, filed). Cycle count on aisle C next Tuesday.\n\nElif` },
		],
	},

	// ───────────────────────────── support@northwind.example (shared) ─────────────────────────────
	{
		key: "steam-wand", mailbox: SUPPORT.email, ai: "customers", labels: ["Urgent"], unread: true,
		subject: "Steam wand leaking after descaling",
		summary: { line: "Morning Owl's steam wand drips after descaling; likely a worn valve seal, kit SKU NW-VS2.", bullets: ["Model S2, bought June", "Leak started after descaling", "Suggested seal kit NW-VS2"] },
		messages: [
			{ from: BEA, to: [SUPPORT], ago: 18, attachments: [{ name: "wand-leak.jpg", kind: "jpg", kb: 1236 }],
				body: `Hi there,\n\nSince we descaled on Sunday the steam wand drips constantly, even when it's closed. Photo attached. It's an S2 we bought in June.\n\nIs this something we can fix ourselves?\n\nBea\nMorning Owl Café` },
		],
	},
	{
		key: "invoice-missing", mailbox: SUPPORT.email, ai: "billing", unread: true,
		subject: "Can't find the invoice for order NW-30122",
		messages: [
			{ from: KWAME, to: [SUPPORT], ago: 54,
				body: `Hello,\n\nOur accountant needs the invoice for order NW-30122 (two grinders, delivered Nov 4) and I can't find it in the portal. Could you resend it?\n\nThanks,\nKwame Mensah\nTidewater Coffee` },
		],
	},
	{
		key: "gasket", mailbox: SUPPORT.email, ai: "customers", unread: false,
		subject: "Replacement portafilter gasket",
		messages: [
			{ from: ELENA, to: [SUPPORT], at: { d: 1, t: "10:03" },
				body: `Hi, we need two replacement group-head gaskets for our S2. Can we order them through you, or do we go via the distributor?\n\nElena` },
			{ from: AIKO, to: [ELENA], sent: true, from_mailbox: true, at: { d: 1, t: "10:41" },
				body: `Hi Elena,\n\nYou can order them from us directly: SKU NW-GG58, $9 each. I've added two to a draft order for you. Reply "yes" and we'll ship today.\n\nAiko, Northwind Support` },
			{ from: ELENA, to: [SUPPORT], at: { d: 1, t: "11:02" }, body: `Yes please! Thank you.\n\nElena` },
		],
	},
	{
		key: "grinder-click", mailbox: SUPPORT.email, ai: "customers", unread: true,
		subject: "Grinder making a clicking noise",
		messages: [
			{ from: LUCA, to: [SUPPORT], at: { d: 1, t: "15:22" },
				body: `Buongiorno,\n\nOur G1 grinder started clicking at the finest settings. Should we stop using it? It's 8 months old.\n\nLuca Moretti\nMoretti Café` },
		],
	},
	{
		key: "return-label", mailbox: SUPPORT.email, ai: "customers", unread: false,
		subject: "Return label for damaged milk jugs",
		messages: [
			{ from: NOOR, to: [SUPPORT], at: { d: 2, t: "12:12" }, attachments: [{ name: "damaged-box.jpg", kind: "jpg", kb: 1702 }],
				body: `Hi, three of the 12 milk jugs arrived dented (photo attached). Can we get a return label?\n\nNoor\nSalt & Crumb` },
			{ from: AIKO, to: [NOOR], sent: true, from_mailbox: true, at: { d: 2, t: "13:05" }, attachments: [{ name: "Return-label-RMA-5521.pdf", kind: "pdf", kb: 22 }],
				body: `Hi Noor,\n\nSo sorry about that. Return label attached (RMA-5521), and three new jugs ship today, no need to wait for the return.\n\nAiko, Northwind Support` },
		],
	},
	{
		key: "thanks", mailbox: SUPPORT.email, ai: "customers", unread: false,
		subject: "Thank you!",
		messages: [
			{ from: OSKAR, to: [SUPPORT], at: { d: 3, t: "18:02" },
				body: `Just wanted to say the technician was brilliant. Machine is back to 9 bar and the regulars didn't notice a thing. Thank you all!\n\nOskar, Café Lumen` },
		],
	},
	{
		key: "training-link", mailbox: SUPPORT.email, ai: "customers", unread: false,
		subject: "Training video link not working",
		messages: [
			{ from: ARJUN, to: [SUPPORT], at: { d: 4, t: "09:30" },
				body: `Hi, the "Dialing in the S2" video link in the welcome email gives a 404. Is there a new link?\n\nArjun, Lantern Stays` },
			{ from: AIKO, to: [ARJUN], sent: true, from_mailbox: true, at: { d: 4, t: "10:15" },
				body: `Hi Arjun, thanks for flagging it. We moved the videos last week. Here's the new link: northwind.example/learn/dial-in. We've fixed the welcome email too.\n\nAiko` },
		],
	},
	{
		key: "descale-schedule", mailbox: SUPPORT.email, ai: "customers", unread: false,
		subject: "How often should we descale?",
		messages: [
			{ from: ISLA, to: [SUPPORT], at: { d: 5, t: "14:00" },
				body: `We're in a hard-water area and go through about 300 shots a day. How often should we descale the S2?\n\nIsla` },
		],
	},

	// ───────────────────────────── sales@northwind.example ─────────────────────────────
	{
		key: "copperleaf-demo", mailbox: SALES.email, ai: "customers", labels: ["Leads"], unread: true,
		subject: "Demo request: Copperleaf Coffee (12 locations)",
		messages: [
			{ from: FINN, to: [SALES], ago: 97,
				body: `Hi,\n\nWe're replacing espresso machines at 12 locations next spring and would love a demo of the S2 and whatever's coming next. Any chance of something in early December?\n\nFinn O'Brien\nHead of Coffee, Copperleaf` },
		],
	},
	{
		key: "meridian-rfp", mailbox: SALES.email, ai: "customers", labels: ["Leads"], unread: false,
		subject: "Meridian Hotels: breakfast program pre-RFP questions",
		messages: [
			{ from: RUTH, to: [SALES], cc: [MAYA], at: { d: 1, t: "13:37" }, attachments: [{ name: "Meridian-pre-RFP-questionnaire.docx", kind: "docx", kb: 58 }],
				body: `Hello Daniel,\n\nAhead of our January RFP, could your team complete the attached questionnaire? It covers service SLAs, training and spare-parts availability.\n\nRuth` },
		],
	},
	{
		key: "lantern-pricing", mailbox: SALES.email, ai: "customers", unread: false,
		subject: "Pricing for 6 boutique hotels",
		messages: [
			{ from: ARJUN, to: [SALES], at: { d: 2, t: "10:20" },
				body: `Hi Daniel, can you send pricing for six S2s with a 3-year service plan? We'd like to budget before year end.\n\nArjun Mehta\nLantern Stays` },
			{ from: DANIEL, to: [ARJUN], sent: true, from_mailbox: true, at: { d: 2, t: "11:05" }, attachments: [{ name: "Northwind-Quote-Q-7742.pdf", kind: "pdf", kb: 140 }],
				body: `Hi Arjun,\n\nQuote attached: six S2s with the 3-year Care plan, installation and barista training included. Happy to walk through it on a call.\n\nDaniel` },
		],
	},
	{
		key: "duarte-beta", mailbox: SALES.email, ai: "customers", unread: false,
		subject: "Re: S3 early access",
		messages: [
			{ from: BETA, to: [SALES], at: { d: 5, t: "16:45" },
				body: `Daniel, we'd love to be on the S3 early-access list. We have two shops and a roastery, so lots of real-world testing.\n\nRafael` },
		],
	},

	// ───────────────────────────── team@northwindlabs.example ─────────────────────────────
	{
		key: "fw-notes", mailbox: LABS.email, unread: true,
		subject: "Firmware 2.4 release notes (draft)",
		messages: [
			{ from: TOMAS, to: [LABS], at: { d: 1, t: "18:10" },
				body: `Draft release notes for 2.4 are in the doc. Highlights: smarter boiler warm-up (saves ~11 minutes each morning), dose-by-weight for the G1, and quieter pump start.\n\nComments by Friday please.\n\nTomás` },
		],
	},
	{
		key: "calibration", mailbox: LABS.email, unread: false,
		subject: "Pressure sensor calibration results",
		messages: [
			{ from: P("Nadia Rahman", "nadia@northwindlabs.example"), to: [LABS], at: { d: 3, t: "15:55" }, attachments: [{ name: "calibration-batch-11.csv", kind: "csv", kb: 9 }],
				body: `Batch 11 results attached. 198/200 sensors within ±0.05 bar. The two outliers are from the same reel; I've flagged it with the supplier.\n\nNadia` },
		],
	},

	// ───────────────────────────── hello@harborline.example ─────────────────────────────
	{
		key: "oakolive", mailbox: HARBOR.email, ai: "customers", unread: true,
		subject: "Wholesale enquiry: stoneware sets",
		messages: [
			{ from: ZOE, to: [HARBOR], at: { d: 1, t: "12:44" },
				body: `Hello Harborline,\n\nWe run two homeware shops in Bath and love your stoneware. Do you offer wholesale terms, and what's the minimum order?\n\nZoe Chambers\nOak & Olive` },
		],
	},
	{
		key: "homejournal", mailbox: HARBOR.email, unread: false, starred: true,
		subject: "Gift guide feature: high-res images?",
		messages: [
			{ from: MEI, to: [HARBOR], at: { d: 2, t: "09:05" },
				body: `Hi! We'd like to feature the Harborline pour-over kettle in our December gift guide. Could you send two high-res product shots by Friday?\n\nMei Lin\nHome Journal` },
			{ from: SAM, to: [MEI], sent: true, from_mailbox: true, at: { d: 2, t: "10:30" }, attachments: [{ name: "harborline-kettle-01.jpg", kind: "jpg", kb: 3420 }, { name: "harborline-kettle-02.jpg", kind: "jpg", kb: 2985 }],
				body: `Hi Mei, how exciting, thank you! Two shots attached. Let me know if you need a lifestyle image too.\n\nSam` },
		],
	},
];

/** Drafts: [mailbox, {to, subject, body, replyTo?: thread key}] */
export const DRAFTS = [
	{ mailbox: MAYA.email, to: MARCUS.email, subject: "Re: Lease renewal: Unit 4B, Riverside Trade Park", thread: "lease",
		body: "<p>Hi Marcus,</p><p>Thanks for the terms. We're keen to stay. Before we commit, could we look at a 5-year option at +3%, keeping the two rent-free months for the mezzanine?</p>" },
	{ mailbox: MAYA.email, to: "everyone@northwind.example", subject: "Holiday hours: Dec 23 – Jan 2",
		body: "<p>Hi all,</p><p>A quick note on holiday hours. The warehouse closes at 2pm on December 23 and reopens January 2. Support will run a reduced rota (9–1) on the 27th–30th.</p>" },
	{ mailbox: SUPPORT.email, to: LUCA.email, subject: "Re: Grinder making a clicking noise", thread: "grinder-click",
		body: "<p>Buongiorno Luca,</p><p>Clicking at the finest settings usually means the burrs are touching. Please back the grind off two steps and keep using it. We'll send a technician to recalibrate this week.</p>" },
];

/** Scheduled sends. `in` = minutes from now. */
export const SCHEDULED = [
	{ mailbox: MAYA.email, to: [DANIEL.email, AIKO.email, LENA.email], subject: "Monday ops sync: agenda", inMinutes: 60 * 24 * 3 + 37,
		html: "<p>Agenda for Monday:</p><ol><li>Brightcup install plan (Dec 9–11)</li><li>HostEx booth sign-off</li><li>Q1 forecast and S3 timeline</li><li>Holiday rota</li></ol>" },
	{ mailbox: MAYA.email, to: [RUTH.email], subject: "Following up on breakfast service", inMinutes: 60 * 18 + 12,
		html: "<p>Hi Ruth,</p><p>Thanks again for Tuesday's call. As promised, attached is a short overview of how we've rolled out the S2 for hotel breakfast service, with uptime figures from two hotel groups.</p><p>Maya</p>" },
	{ mailbox: SALES.email, to: [FINN.email], subject: "Copperleaf demo: Dec 4 at our Newark showroom", inMinutes: 60 * 20 + 3,
		html: "<p>Hi Finn,</p><p>We'd love to host you at our Newark showroom on December 4 at 10am. We'll have the S2 and an early look at the S3 set up side by side.</p><p>Daniel</p>" },
];

/** Sends held for approval: API tokens acting for one mailbox each. */
export const APPROVALS = [
	{
		tokenName: "Renewals assistant", mailbox: SALES.email, fromName: "Northwind Sales", to: OSKAR.email,
		subject: "Your Care plan renews on December 1",
		html: "<p>Hi Oskar,</p><p>Your Northwind Care plan for the S2 (serial S2-04417) renews on December 1 for another year at $480. It includes two preventive visits, parts and next-day technician callouts.</p><p>As a thank-you for your patience with last week's pump replacement, we've added a free descaling kit to your renewal.</p><p>Reply to this email if you'd like to change anything.</p><p>Northwind Sales</p>",
	},
	{
		tokenName: "Renewals assistant", mailbox: SALES.email, fromName: "Northwind Sales", to: ARJUN.email,
		subject: "Re: Pricing for 6 boutique hotels",
		html: "<p>Hi Arjun,</p><p>Following up on the quote for six S2s with the 3-year Care plan. If you confirm before December 15, we can hold this year's pricing and install in January.</p><p>Daniel</p>",
	},
	{
		tokenName: "Sales assistant", mailbox: SALES.email, fromName: "Northwind Sales", to: BETA.email,
		subject: "S3 early access: you're on the list",
		html: "<p>Hi Rafael,</p><p>Thanks for your interest in the S3. You're on the early-access list; we'll be in touch in February with dates for the first field units.</p><p>Northwind Sales</p>",
	},
];

export const TEMPLATES = [
	{ slug: "cafe-welcome", name: "Café onboarding: welcome", subject: "Welcome to Northwind, {{firstName}}",
		bodyHtml: "<p>Hi {{firstName}},</p><p>Welcome aboard! Your machines ship this week. Here's what happens next: delivery, installation and a two-hour training session for your baristas.</p><p>Daniel</p>" },
	{ slug: "cafe-setup-checklist", name: "Café onboarding: site checklist", subject: "Before install day: a 5-minute checklist",
		bodyHtml: "<p>Hi {{firstName}},</p><p>To make install day smooth, please check: a dedicated 30A circuit, a water line with a shut-off valve within 1.5 m, and a drain.</p>" },
	{ slug: "cafe-training", name: "Café onboarding: training invite", subject: "Book your barista training",
		bodyHtml: "<p>Hi {{firstName}},</p><p>Your machines are in. Pick a time for your team's training session: we'll cover dialing in, milk texturing and daily cleaning.</p>" },
	{ slug: "cafe-30-day", name: "Café onboarding: 30-day check-in", subject: "How's the first month going?",
		bodyHtml: "<p>Hi {{firstName}},</p><p>It's been a month. How are the machines treating you? Reply with anything that's bugging you and we'll sort it.</p>" },
	{ slug: "show-thanks", name: "Trade show: thanks for stopping by", subject: "Great to meet you at HostEx",
		bodyHtml: "<p>Hi {{firstName}},</p><p>Thanks for stopping by our booth at HostEx. As promised, here's the S2 spec sheet and our café financing options.</p>" },
	{ slug: "show-demo", name: "Trade show: book a demo", subject: "See the S2 in your own café",
		bodyHtml: "<p>Hi {{firstName}},</p><p>Want to try the S2 with your own beans? We can bring a demo unit to you for a morning.</p>" },
	{ slug: "show-last-call", name: "Trade show: show pricing ends Friday", subject: "Show pricing ends Friday",
		bodyHtml: "<p>Hi {{firstName}},</p><p>A quick reminder that HostEx show pricing (10% off and free installation) ends this Friday.</p>" },
];

export const SEQUENCES = [
	{ name: "New café onboarding", steps: [
		{ order: 1, templateSlug: "cafe-welcome", delayHours: 0 },
		{ order: 2, templateSlug: "cafe-setup-checklist", delayHours: 48 },
		{ order: 3, templateSlug: "cafe-training", delayHours: 24 * 7 },
		{ order: 4, templateSlug: "cafe-30-day", delayHours: 24 * 30 },
	], enroll: [FINN, ARJUN, ZOE, BETA, ISLA] },
	{ name: "HostEx Chicago follow-up", steps: [
		{ order: 1, templateSlug: "show-thanks", delayHours: 2 },
		{ order: 2, templateSlug: "show-demo", delayHours: 72 },
		{ order: 3, templateSlug: "show-last-call", delayHours: 24 * 6 },
	], enroll: [NOOR, LUCA, ELENA] },
	{ name: "Care plan renewal reminders", steps: [
		{ order: 1, templateSlug: "cafe-30-day", delayHours: 0 },
	], enroll: [] },
];

/** Labels per mailbox (user labels). Colours are the app's palette. */
/** Custom folders per mailbox. */
export const FOLDERS = { [MAYA.email]: ["Receipts"] };

export const LABEL_COLORS = {
	Orders: "#4f46e5", Logistics: "#0ea5e9", Events: "#d946ef", Suppliers: "#f97316", Warranty: "#ef4444",
	Finance: "#10b981", Leads: "#8b5cf6", Harborline: "#14b8a6", Customers: "#22c55e", IT: "#64748b", Urgent: "#dc2626",
};

/** AI triage presets enabled per mailbox (fewer on Maya's, whose sidebar also lists her own labels). */
export const TRIAGE_PRESETS_ON = {
	default: ["customers", "billing", "vendors"],
	[MAYA.email]: ["customers", "vendors"],
};

/**
 * A month of earlier outbound mail from the shared mailboxes, so Sent and the
 * analytics charts have history. Single messages, already answered.
 */
const HISTORY_CUSTOMERS = [BEA, KWAME, ELENA, LUCA, NOOR, FINN, ZOE, ARJUN, ISLA, BETA, OSKAR, PRIYA,
	P("Hugo Laurent", "hugo@laurentpatisserie.example"), P("Amara Obi", "amara@sunroomcafe.example"),
	P("Peter Novak", "peter@novakdeli.example"), P("Sofia Reyes", "sofia@lumacoffee.example"),
	P("Ben Carter", "ben@carterandsons.example"), P("Yuki Sato", "yuki@kissacafe.example")];
const HISTORY_SUBJECTS = [
	["support@northwind.example", "Re: Descaling schedule for hard water", "Hi {first},\n\nFor hard water and around 300 shots a day, descale every three weeks and swap the softener cartridge every two months. Our guide is at northwind.example/learn/descale.\n\nNorthwind Support"],
	["support@northwind.example", "Re: Group head temperature", "Hi {first},\n\nThe S2 holds 93 °C at the group by default. You can raise it in Settings → Brew → Temperature, in 0.5 °C steps.\n\nNorthwind Support"],
	["support@northwind.example", "Your technician visit is booked", "Hi {first},\n\nYour technician visit is booked for {day} between 8 and 10am. They'll call 30 minutes before arriving.\n\nNorthwind Support"],
	["support@northwind.example", "Re: Replacement shower screen", "Hi {first},\n\nA new shower screen (SKU NW-SS58) is on its way, tracking to follow. No charge, it's covered.\n\nNorthwind Support"],
	["support@northwind.example", "Re: Error E04 on startup", "Hi {first},\n\nE04 means the boiler didn't reach pressure in time, usually after a power cut. Switch off for 30 seconds and back on; if it returns, reply and we'll send someone.\n\nNorthwind Support"],
	["sales@northwind.example", "Your Northwind quote", "Hi {first},\n\nThanks for your interest. Your quote is attached, including installation and barista training. It's valid for 30 days.\n\nDaniel Reyes"],
	["sales@northwind.example", "Following up on the S2 demo", "Hi {first},\n\nGreat to see you at the demo. Any questions from the team? Happy to set up a trial machine for a week.\n\nDaniel Reyes"],
	["sales@northwind.example", "Financing options for your café", "Hi {first},\n\nAs promised, here are our financing options: 12, 24 or 36 months, with service included on the 36-month plan.\n\nDaniel Reyes"],
	["support@northwind.example", "Re: Milk jug sizes", "Hi {first},\n\nWe stock 350, 600 and 1,000 ml jugs. For flat whites most cafés go with the 600.\n\nNorthwind Support"],
	["support@northwind.example", "Re: Grinder burr replacement", "Hi {first},\n\nBurrs on the G1 last roughly 500 kg of coffee. Yours are due in about two months; we'll send a reminder.\n\nNorthwind Support"],
	["support@northwind.example", "Your repair is complete", "Hi {first},\n\nGood news: the repair is done and your machine passed its pressure and temperature checks. It ships back {day}.\n\nNorthwind Support"],
	["sales@northwind.example", "Install date for your new machines", "Hi {first},\n\nYour installation is set for {day}. The engineer needs about three hours and a clear counter.\n\nDaniel Reyes"],
	["sales@northwind.example", "Thanks for visiting the showroom", "Hi {first},\n\nThanks for coming by the Newark showroom. As promised, the spec sheets and the service plan comparison are attached.\n\nDaniel Reyes"],
	["sales@northwind.example", "Order confirmed", "Hi {first},\n\nYour order is confirmed and scheduled to ship on {day}. We'll email tracking once it leaves Newark.\n\nDaniel Reyes"],
];
const HISTORY_TIMES = ["08:52", "09:17", "09:41", "10:06", "10:38", "11:12", "11:47", "13:24", "14:03", "14:36", "15:19", "15:58", "16:27", "17:11"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
for (let d = 3, i = 0; d <= 29; d++) {
	const perDay = [3, 5, 2, 6, 4, 5, 3][d % 7];
	for (let k = 0; k < perDay; k++, i++) {
		const [mailbox, subject, body] = HISTORY_SUBJECTS[(i * 5 + d) % HISTORY_SUBJECTS.length];
		const who = HISTORY_CUSTOMERS[(i * 7 + k) % HISTORY_CUSTOMERS.length];
		const first = who.name.split(" ")[0];
		THREADS.push({
			key: `history-${d}-${k}`, mailbox, history: true, unread: false,
			subject,
			messages: [{
				from: { name: mailbox.startsWith("sales") ? "Daniel Reyes" : "Aiko Tanaka", email: mailbox }, to: [who], sent: true, from_mailbox: true,
				...(i % 4 === 1 ? { cc: [HISTORY_CUSTOMERS[(i * 11 + 3) % HISTORY_CUSTOMERS.length]] } : {}),
				at: { d, t: HISTORY_TIMES[(i * 3 + k) % HISTORY_TIMES.length] },
				body: body.replace("{first}", first).replace("{day}", WEEKDAYS[(i + d) % 5]),
			}],
		});
	}
}
