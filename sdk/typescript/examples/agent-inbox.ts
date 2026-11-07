// Create a short-lived inbox for an agent and follow its mail in realtime.
// Needs an admin token (agent inboxes are admin-only).
import { Tapetide } from "../src/index.js";

const admin = new Tapetide({ baseUrl: process.env.TAPETIDE_URL!, token: process.env.TAPETIDE_TOKEN! });

const created = await admin.agentInboxes.create({
	domain: "example.com",
	purpose: "Collect signup verification codes",
	send_mode: "draft_only",
	ttl_hours: 2,
});
console.log("address:", created.address, created.warnings);

// The scoped token is returned once (null on an idempotent replay).
const agentToken = created.token?.secret;
if (!agentToken) throw new Error("Token secret already shown; create a new inbox");
const agent = new Tapetide({ baseUrl: process.env.TAPETIDE_URL!, token: agentToken });

const sub = agent.events.subscribe(
	{
		mailboxes: [created.address!],
		events: ["message.received"],
		onControl: (frame) => frame.type === "subscription_revoked" && console.log("lost access to", frame.mailbox),
		onError: (err, { fatal }) => console.error(fatal ? "stopped:" : "reconnecting:", err.message),
	},
	async ({ id, event }) => {
		console.log(id, event.data.from, event.data.subject);
		const full = await agent.mail.get(event.mailbox, event.data.id!);
		console.log(full.body?.slice(0, 200));
	},
);

// Persist sub.lastEventId to resume with `since` after a restart.
process.on("SIGINT", () => sub.close());
await sub.closed;
