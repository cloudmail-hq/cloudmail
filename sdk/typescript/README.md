# @cloudmail/sdk

Typed TypeScript client for the cloudmail API. Types are generated from the deployment's OpenAPI document (`GET /api/v1/openapi.json`). The client is a small fetch wrapper with no runtime dependencies. Runs on Node 20.3+, Cloudflare Workers, Deno, Bun and browsers.

```bash
npm install @cloudmail/sdk
```

This package was previously `@tapetide/mail`. The class is still exported as `Tapetide`, and `Cloudmail` is the same class under the new name.

## Use

```ts
import { Cloudmail, isPendingApproval } from "@cloudmail/sdk";

const mail = new Cloudmail({ baseUrl: "https://mail.example.com", token: process.env.CLOUDMAIL_TOKEN! });

const result = await mail.mail.send("support@example.com", {
	to: "customer@example.org",
	subject: "Your order shipped",
	text: "It's on the way.",
});
if (isPendingApproval(result)) console.log("held:", result.approval_url);
else console.log("sent:", result.id);
```

## Agent flow: send, held for approval, revise, wait

An agent token without `mail:send:auto`, on a mailbox whose agent send mode is `approve`, gets its sends held for a person. The agent can revise its own held send until someone decides it.

```ts
import { Cloudmail, isPendingApproval } from "@cloudmail/sdk";

const agent = new Cloudmail({ baseUrl: process.env.CLOUDMAIL_URL!, token: process.env.AGENT_TOKEN! });
const mailbox = "agent-7@example.com";

const sent = await agent.mail.send(mailbox, { to: "lead@example.org", subject: "Quote", html: "<p>EUR 1,200</p>" });
if (isPendingApproval(sent)) {
	// Nothing was sent. Don't retry the send; fix it in place instead.
	const revised = await agent.approvals.revise(mailbox, sent.approval_id, { html: "<p>EUR 1,150, valid 30 days</p>" });
	console.log("now at revision", revised.revision); // revised_by: "requester"

	const decided = await agent.approvals.waitForDecision(mailbox, sent.approval_id, { intervalMs: 10_000 });
	console.log(decided.status); // "sent", "rejected", "failed", "sent_unconfirmed", or still "pending" after the timeout
}
```

The person (or an unrelated token with `approvals:manage`) approves the version they looked at:

```ts
import { ApprovalChangedError } from "@cloudmail/sdk";

const held = await reviewer.approvals.get(mailbox, approvalId);
try {
	await reviewer.approvals.approve(mailbox, approvalId, { revision: held.revision });
} catch (err) {
	if (err instanceof ApprovalChangedError) {
		// The agent revised it after we read it. Nothing was sent.
		console.log("review again:", err.approval?.revision);
	} else throw err;
}
```

## Resources

| Resource | Methods |
|---|---|
| `mail` | `send`, `reply`, `forward`, `list`, `get`, `search`, `update`, `delete`, `restore`, `move`, `setPriority`, `notSpam`, `deliveryEvents`, `attachment`, `bulk`, `emptyTrash`, `markAllRead`, `saveDraft`, `searchAll`, `ask`, `unified` |
| `mailboxes` | `list`, `get`, `create`, `update`, `delete`, `state`, `aliases`, `setAliases`, `export` |
| `agentInboxes` | `create`, `list`, `get`, `delete` |
| `approvals` | `list`, `count`, `get`, `edit`, `revise`, `approve`, `reject`, `retry`, `waitForDecision` |
| `webhooks` | `list`, `create`, `get`, `update`, `replace`, `delete`, `rotateSecret`, `test`, `deliveries`, `retryDelivery`, `eventTypes` |
| `events` | `subscribe` |
| `threads` | `get`, `summary`, `refreshSummary`, `generateSummary`, `markRead`, `mute`, `unmute`, `muted` |
| `folders` | `list`, `create`, `rename`, `delete` |
| `labels` | `list`, `create`, `update`, `delete`, `emails`, `forEmail`, `setForEmail`, `addToEmail`, `removeFromEmail` |
| `signatures` | `list`, `create`, `getDefault`, `update`, `delete` |
| `snooze` | `list`, `snooze`, `unsnooze` |
| `followups` | `list`, `get`, `set`, `delete`, `cancel` |
| `triage` | `labelPrompts`, `setLabelPrompt`, `setPreset`, `backfill`, `inboxTabs` |
| `screener` | `list`, `screen` |
| `scheduledSends` | `list`, `schedule`, `cancel`, `sendNow` |
| `senders` | `blocked`, `block`, `unblock`, `allowed`, `allow`, `removeAllowed` |
| `rules` | `list`, `create`, `update`, `delete`, `reorder` |
| `imports` | `list`, `create`, `get`, `uploadPart`, `complete`, `pause`, `resume`, `cancel` |
| `delegates` | `list`, `put`, `delete` |
| `audit` | `list`, `instance` |
| `templates` | `list`, `create`, `get`, `update`, `delete`, `send` |
| `sequences` | `list`, `create`, `get`, `update`, `delete`, `enrollments`, `enroll`, `personEnrollment`, `cancelEnrollment` |
| `suppressions` | `list`, `add`, `import`, `check`, `delete` |
| `sendingHealth` | `list`, `evaluate`, `pause`, `resume`, `limits`, `updateLimits` |
| `domains` | `list`, `create`, `get`, `update`, `delete`, `verify`, `provision` |
| `products` | `list`, `create`, `resolve`, `get`, `update`, `delete`, `putLogo`, `deleteLogo`, `refreshKnowledge` |
| `people` | `list`, `emails` |
| `analytics` | `get`, `sent`, `overview`, `engagement`, `inbound`, `dmarc` |
| `usage` | `get`, `updateBudget` |
| `ai` | `settings`, `updateSettings`, `providers`, `discoverModels`, `testModel`, `routing`, `workersAiModels`, `testWorkersAiModel`, `semanticAvailability`, `semanticStatus` |
| `assistant` | `prefs`, `updatePrefs`, `brief`, `generateBrief`, `dismissBrief` |
| `cloudflare` | `connection`, `discover`, `plan`, `changes` |
| `licence` | `get`, `refresh` |
| `privacy` | `tracking`, `updateTracking`, `settings`, `updateSettings`, `accountDeletion`, `cancelAccountDeletion`, `exports`, `downloadExport` |
| `access` | `list`, `put`, `delete` |
| `branding` | `get`, `update`, `reset`, `logo`, `uploadLogo`, `deleteLogo` |
| `preferences` | `get`, `update` |
| `notifications` | `vapidKey` |
| `meta` | `openApi`, `me`, `config` |
| `migration` | `status`, `run` (needs the deployment's `MIGRATION_TOKEN`) |

Inputs and results use the generated OpenAPI types, so a field the server adds shows up after `npm run generate`. Downloads (`mail.attachment`, `mailboxes.export`, `privacy.downloadExport`, `branding.logo`) return the unread `Response`, so you can stream `.body`. `test/coverage.test.ts` fails if an operation in `openapi.json` has no method and no listed reason.

### Not in the SDK

These operations refuse API tokens, so they have no methods:

- Cloudflare connect, verify, disconnect, apply and revert; account deletion; starting an account export. These need a browser session that re-confirmed its password or passkey in the last 15 minutes (`403 session_required` or `reauth_required`).
- Licence activate and deactivate. These need a browser session (`403 session_required`).
- Web Push subscriptions, push preferences and test pushes. These belong to a browser device (`409 no_identity`).
- Creating, changing or deleting AI providers, model lists and routing. These need a person in the app (`403 person_required`).

For anything else, call `client.http.request({ method, path, params, query, body })` with an OpenAPI-style path. `OPERATIONS` maps each `operationId` to its method and path.

### Idempotency and retries

- Every send and create the server keys gets an `Idempotency-Key` (`IDEMPOTENT_POST_PATHS`). Pass `{ idempotencyKey }` to use your own, for example a job id.
- Requests that are safe to repeat (GETs and keyed POSTs) are retried with backoff (`maxRetries`, default 2), always with the same key, after:
  - transport errors
  - 429 and 409 `idempotency_request_in_progress` (waiting for `Retry-After`)
  - 408 and 5xx, except on sends (see the next point)
- Sends (`SEND_POST_PATHS`: send, reply, forward, scheduled sends, send-now, template sends, sequence enrollment, approve) are not retried on a 5xx or 408. The server doesn't store a 5xx against the key, so a retry would run the send again, and the first attempt may already have gone out. The exception is a 503 the server returns before it runs anything (`idempotency_unavailable`, `licence_unavailable`).
- Other writes aren't retried.

### Held sends

A held send returns HTTP 202 `{ status: "pending_approval", approval_id, approval_url }`. The client returns it as a `PendingApproval` and doesn't throw. Nothing was sent, so don't send it again. Use `approvals.revise` to change it.

### Errors

Each error is a `TapetideError` (also exported as `CloudmailError`) with `status`, `code`, `message`, `body` and `headers`:

| Class | When |
|---|---|
| `ValidationError` | 400, 422 |
| `AuthenticationError` | 401 |
| `PermissionDeniedError` | 403 (`code` says why, e.g. `insufficient_scope`, `self_approval`, `session_required`) |
| `NotFoundError` | 404 |
| `ConflictError` | 409, including `idempotency_key_reused` |
| `ApprovalChangedError` | 409 from `approve` when the held send changed since you read it; `approval` is the current version |
| `RateLimitError` | 429; `retryAfter` is the server's hint in seconds, or null |
| `ServerError` | 5xx |
| `APIConnectionError` | no response (DNS, TLS, timeout, abort); `status` is 0 |

## Webhooks

```ts
import { verifyWebhook } from "@cloudmail/sdk/webhooks";

const event = await verifyWebhook(await request.text(), request.headers, process.env.CLOUDMAIL_WEBHOOK_SECRET!);
```

- It checks `X-Tapetide-Signature: v1=<hex HMAC-SHA256(secret, "${timestamp}.${body}")>` against `X-Tapetide-Timestamp`, with a 300 s tolerance by default. The header names are part of the wire format and haven't changed.
- It returns the parsed event, or throws `WebhookVerificationError` with a `reason`.
- Pass the raw body, not re-serialised JSON. In Express, use `express.raw({ type: "application/json" })`.

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

- The default transport is Server-Sent Events over `fetch`. For WebSocket, pass `transport: "websocket"` and a `webSocket: (url, headers) => new WebSocket(url, { headers })` factory, for example from the `ws` package.
- On a dropped connection it reconnects with `since=<last id>`. The server keeps 24 hours of events, and duplicates are skipped.
- A `subscription_revoked` frame (you lost access to one mailbox) goes to `onControl`, and the stream continues.
- A revoked credential ends the subscription and calls `onError(StreamRevokedError, { fatal: true })`.

See `examples/` for a sender, a webhook receiver and an agent inbox that follows its own mail.

## Develop

```bash
npm ci --ignore-scripts
npm run generate         # regenerate openapi.json, src/generated/schema.ts and operations.ts from workers/lib/openapi.ts
npm run check:generated  # CI: fail if they are stale
npm run typecheck && npm test && npm run build
```

## Publish

A maintainer publishes by hand; CI never publishes.

1. Bump `version` in `package.json` and `SDK_VERSION` in `src/http.ts`.
2. Run `npm ci && npm publish` from `sdk/typescript`. `publishConfig.access` is `public`, and `prepublishOnly` checks the generated files, typechecks, tests and builds first. You need publish rights on the `@cloudmail` npm org (`npm login`).
3. Tag the release, for example `git tag sdk-ts-v0.2.0`.
