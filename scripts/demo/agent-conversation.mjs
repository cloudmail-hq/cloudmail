// A stored agent conversation for the screenshot of the AI agent panel.
//
// The offline dev server has no model (LOCAL_AI_MOCK answers with a scripted
// stand-in), so capture.mjs serves this as the panel's history instead. It is
// in the shape the agent persists (AI SDK UI messages) and reflects the seeded
// mail: every fact in it is in scripts/demo/demo-data.mjs.

export const AGENT_CONVERSATION = [
	{
		id: "demo-u1",
		role: "user",
		parts: [{ type: "text", text: "What needs my attention this week?" }],
	},
	{
		id: "demo-a1",
		role: "assistant",
		parts: [
			{ type: "step-start" },
			{
				type: "tool-list_emails",
				toolCallId: "call_demo_1",
				state: "output-available",
				input: { folder: "inbox", unread: true, limit: 25 },
				output: { count: 6 },
			},
			{
				type: "tool-search_emails",
				toolCallId: "call_demo_2",
				state: "output-available",
				input: { query: "deadline OR due OR by Friday" },
				output: { count: 4 },
			},
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
	{
		id: "demo-u2",
		role: "user",
		parts: [{ type: "text", text: "Yes. Net-30 with the 2% discount; Daniel sends the checklist." }],
	},
	{
		id: "demo-a2",
		role: "assistant",
		parts: [
			{ type: "step-start" },
			{
				type: "tool-get_thread",
				toolCallId: "call_demo_3",
				state: "output-available",
				input: { subject: "Q4 wholesale order" },
				output: { messages: 3 },
			},
			{
				type: "tool-draft_reply",
				toolCallId: "call_demo_4",
				state: "output-available",
				input: { to: "priya@brightcup.example" },
				output: { draftId: "demo-draft-brightcup", status: "draft_saved" },
			},
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
