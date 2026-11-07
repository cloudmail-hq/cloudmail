// Send a message, handling the approval hold.
//   TAPETIDE_URL=https://mail.example.com TAPETIDE_TOKEN=ttk_… npx tsx examples/send.ts
import { Tapetide, isPendingApproval } from "../src/index.js";

const tapetide = new Tapetide({ baseUrl: process.env.TAPETIDE_URL!, token: process.env.TAPETIDE_TOKEN! });

const result = await tapetide.mail.send("support@example.com", {
	to: "customer@example.org",
	subject: "Your order shipped",
	text: "It's on the way. Tracking: 1Z999.",
});

if (isPendingApproval(result)) {
	// Nothing was sent. A person approves it in the app; do not retry.
	console.log(`Held for approval: ${result.approval_url}`);
} else {
	console.log(`Sent ${result.id}`);
}

const inbox = await tapetide.mail.list("support@example.com", { unread: true, limit: 10 });
for (const email of inbox.emails) console.log(email.date, email.sender, email.subject);
