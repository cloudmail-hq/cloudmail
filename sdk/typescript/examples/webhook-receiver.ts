// Verify webhook deliveries in a fetch-style handler (Workers, Bun, Deno,
// Hono, Next.js route handlers). Read the raw body before parsing it.
import { verifyWebhook, WebhookVerificationError } from "../src/webhooks.js";

export default {
	async fetch(request: Request, env: { TAPETIDE_WEBHOOK_SECRET: string }): Promise<Response> {
		const raw = await request.text();
		try {
			const event = await verifyWebhook(raw, request.headers, env.TAPETIDE_WEBHOOK_SECRET);
			if (event.test) return new Response("ok");
			switch (event.type) {
				case "message.received":
					console.log(`${event.mailbox} got mail from ${event.data.from}: ${event.data.subject}`);
					break;
				case "message.bounced":
					console.log(`bounce for ${event.data.detail?.recipient}`);
					break;
			}
			return new Response("ok");
		} catch (err) {
			if (err instanceof WebhookVerificationError) return new Response(err.reason, { status: 400 });
			throw err;
		}
	},
};

// Express: use the raw body, not express.json():
//   app.post("/hooks/tapetide", express.raw({ type: "application/json" }), async (req, res) => {
//     const event = await verifyWebhook(req.body, req.headers, process.env.TAPETIDE_WEBHOOK_SECRET!);
//     res.sendStatus(200);
//   });
