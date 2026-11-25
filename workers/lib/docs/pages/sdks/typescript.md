# TypeScript SDK

> A typed client for Node, Cloudflare Workers, Deno, Bun and browsers, with safe retries, webhook verification and a reconnecting event stream.

The SDK is a small `fetch` wrapper with no runtime dependencies. Its types are generated from this deployment's OpenAPI document, so request and response fields match the [API reference](/docs/api). It needs Node 20.3 or later.

## Install

The package is named `@cloudmail/sdk`. It is not published to npm yet, so install it from the `sdk/typescript` folder of the cloudmail source you deployed from.

Build it once:

```bash
cd sdk/typescript
npm ci --ignore-scripts
npm run build
```

Then add the folder to your project:

```bash
npm install /path/to/cloudmail/sdk/typescript
```

## Configure

Pass the base URL of your deployment and an API token. Create the token at [Settings, API tokens](/settings/account?new-token=1); see [Authentication](/docs/authentication) for scopes.

```ts
import { Cloudmail } from "@cloudmail/sdk";

const mail = new Cloudmail({
	baseUrl: "{{BASE_URL}}",
	token: process.env.CLOUDMAIL_TOKEN!,
});
```

The client does not read environment variables on its own. Keep the token on a server; do not ship it in browser code.

| Option | Meaning |
| --- | --- |
| `baseUrl` | Your deployment's origin. Required. |
| `token` | An API token, `ttk_<id>_<secret>`. Required. |
| `maxRetries` | Retries for requests that are safe to repeat. Default 2. |
| `timeoutMs` | Timeout per attempt. Default 30,000. |
| `fetch` | Your own `fetch`, for tests or a proxy. |

## Send mail

```ts
import { Cloudmail, isPendingApproval } from "@cloudmail/sdk";

const result = await mail.mail.send("support@example.com", {
	to: "customer@example.org",
	subject: "Your order shipped",
	text: "It is on the way.",
});

if (isPendingApproval(result)) {
	// Nothing was sent. A person approves it in the app. Do not send it again.
	console.log("held:", result.approval_url);
} else {
	console.log("sent:", result.id);
}
```

`from` defaults to the mailbox address. `mail.reply(mailbox, emailId, input)` and `mail.forward(mailbox, emailId, input)` take the same input. The fields are described in [Sending mail](/docs/guides/sending-mail).

A send made with a token is held for a person by default. A held send comes back as a `PendingApproval` value; the client does not throw. See [Agent sends and approval](/docs/guides/approvals).

## Read mail

```ts
const page = await mail.mail.list("support@example.com", { folder: "inbox", unread: true, limit: 20 });
for (const row of page.emails) console.log(row.date, row.sender, row.subject);

const newest = page.emails[0];
if (newest) {
	const message = await mail.mail.get("support@example.com", newest.id);
	const thread = await mail.threads.get("support@example.com", message.thread_id!);

	const first = message.attachments?.[0];
	if (first) {
		const res = await mail.mail.attachment("support@example.com", message.id, first.id);
		const bytes = await res.arrayBuffer();
	}
}

const found = await mail.mail.search("support@example.com", "from:customer@example.org has:attachment");
```

Downloads return the unread `Response`, so you can stream `res.body` instead of buffering. `mail.mailboxes.state(mailbox)` returns the change counter described in [Reading mail](/docs/guides/reading-mail).

## Drafts and scheduled sends

```ts
const draft = await mail.mail.saveDraft("support@example.com", {
	to: "customer@example.org",
	subject: "Refund update",
	body: "Hi, the refund was issued today.",
});

const queued = await mail.scheduledSends.schedule("support@example.com", {
	to: "customer@example.org",
	subject: "Reminder",
	text: "As discussed.",
	delay_seconds: 3600,
});

// A send made with a token can be held for approval. Then there is no id to cancel.
if ("id" in queued && queued.id) {
	await mail.scheduledSends.cancel("support@example.com", queued.id);
}
```

`schedule` can come back as a `PendingApproval` instead of a queued message. A held send has an `approval_id` and no `id`, which is why the example checks for `id` before it cancels.

## Held sends

```ts
const sent = await mail.mail.send("support@example.com", { to: "customer@example.org", subject: "Quote", html: "<p>EUR 1,200</p>" });

if (isPendingApproval(sent)) {
	// Change it in place instead of sending a second copy.
	const revised = await mail.approvals.revise("support@example.com", sent.approval_id, {
		html: "<p>EUR 1,150, valid 30 days</p>",
	});
	console.log("now at revision", revised.revision);

	const decided = await mail.approvals.waitForDecision("support@example.com", sent.approval_id, { intervalMs: 10_000 });
	console.log(decided.status); // sent, rejected, failed, sent_unconfirmed, or still pending after the timeout
}
```

`approvals.policies()` says what a send from this token will do in each mailbox. `approvals.listAll()` finds held sends in every mailbox the token can read.

A reviewer with an `approvals:manage` token approves the revision they read:

```ts
import { ApprovalChangedError } from "@cloudmail/sdk";

const held = await reviewer.approvals.get("support@example.com", approvalId);
try {
	await reviewer.approvals.approve("support@example.com", approvalId, { revision: held.revision });
} catch (err) {
	if (err instanceof ApprovalChangedError) console.log("it changed; review revision", err.approval?.revision);
	else throw err;
}
```

## Retries and idempotency

- Every send and create that the server keys gets an `Idempotency-Key`. Pass `{ idempotencyKey }` as the last argument to use your own, for example a job id.
- GETs and keyed POSTs are retried with backoff, always with the same key, after a transport error, a `429`, a `409` `idempotency_request_in_progress`, a `408` or a `5xx`.
- Sends are the exception: they are not retried on a `5xx` or `408`. The server does not store a `5xx` against the key, so a retry would run the send again, and the first attempt may already have gone out.
- Other writes are not retried.

The rules behind this are in [Idempotency keys](/docs/guides/idempotency).

## Errors

Each error is a `CloudmailError` with `status`, `code`, `message`, `body` and `headers`.

| Class | When |
| --- | --- |
| `ValidationError` | `400`, `422` |
| `AuthenticationError` | `401` |
| `PermissionDeniedError` | `403`. `code` says why, for example `insufficient_scope` or `self_approval`. |
| `NotFoundError` | `404` |
| `ConflictError` | `409`, including `idempotency_key_reused` |
| `ApprovalChangedError` | `409` from `approve` when the held send changed since you read it |
| `RateLimitError` | `429`. `retryAfter` is the server's hint in seconds, or null. |
| `ServerError` | `5xx` |
| `APIConnectionError` | No response: DNS, TLS, timeout or abort. `status` is 0. |

See [Errors](/docs/errors) for the response bodies.

## Verify webhooks

```ts
import { verifyWebhook } from "@cloudmail/sdk/webhooks";

const event = await verifyWebhook(await request.text(), request.headers, process.env.CLOUDMAIL_WEBHOOK_SECRET!);
```

It checks the signature and the timestamp (300 seconds of tolerance by default; `toleranceSeconds` changes it), and returns the parsed event or throws `WebhookVerificationError`. Pass the raw body, not re-serialised JSON. In Express, use `express.raw({ type: "application/json" })`. The signature format is in [Webhooks](/docs/guides/webhooks).

## Realtime events

```ts
const sub = mail.events.subscribe(
	{ mailboxes: ["support@example.com"], events: ["message.received"], since: savedId },
	async ({ id, event }) => {
		await handle(event);
		savedId = id;
	},
);
```

- The default transport is Server-Sent Events over `fetch`. For a WebSocket, pass `transport: "websocket"` and a `webSocket: (url, headers) => new WebSocket(url, { headers })` factory, for example from the `ws` package.
- After a dropped connection it reconnects with `since` set to the last id. Duplicates are skipped.
- Losing access to one mailbox goes to `onControl`, and the stream continues. A revoked token ends the subscription and calls `onError` with `fatal: true`.

See [Realtime events](/docs/guides/realtime-events) for the frames and limits.

## Everything else

The client has one resource per area of the API: `mail`, `mailboxes`, `threads`, `folders`, `labels`, `signatures`, `snooze`, `followups`, `scheduledSends`, `approvals`, `webhooks`, `events`, `rules`, `senders`, `templates`, `sequences`, `suppressions`, `domains`, `agentInboxes`, `people`, `analytics`, `usage` and more. Your editor's completion lists the methods.

For a route with no method, call it directly with an OpenAPI-style path:

```ts
const res = await mail.http.request({
	method: "GET",
	path: "/api/v1/mailboxes/{mailboxId}/send-limits",
	params: { mailboxId: "support@example.com" },
});
console.log(res.data);
```

A few operations refuse API tokens and so have no methods: connecting Cloudflare, activating a licence, deleting an account, starting an account export, Web Push subscriptions, and changing AI providers. Those need a person signed in to the app.
