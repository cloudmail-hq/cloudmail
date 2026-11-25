# API documentation

> Read, send and organise the mail on this deployment over HTTP, with an API token you create yourself.

Everything the web app does goes through this API, so anything you can do in the app you can do from a script, a backend or an agent.

| | |
| --- | --- |
| Base URL | `{{BASE_URL}}` |
| Authentication | `Authorization: Bearer ttk_<id>_<secret>` |
| Format | JSON over HTTPS |
| Description | [OpenAPI 3.1](/api/v1/openapi.json) |

These pages are served by your own deployment. The base URL above and every example on every page already point at it, so you can paste them as they stand. When you are signed in, the examples also use one of your own mailboxes.

## First request

1. [Create an API token](/settings/account?new-token=1). It is shown once, so copy it.
2. Call the API with it:

```bash
export CLOUDMAIL_TOKEN="ttk_..."

curl "{{BASE_URL}}/api/v1/me" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN"
```

The [quickstart](/docs/quickstart) goes on from there: list your mailboxes, read the inbox and send a message.

## Start here

- [Quickstart](/docs/quickstart): from a new token to a sent message in five calls.
- [Authentication](/docs/authentication): creating tokens, scopes, limiting a token to mailboxes, rotation.
- [Core concepts](/docs/concepts): mailboxes, messages, folders, threads, labels and paging.
- [Errors](/docs/errors): the error body, every status code and what to do about each.
- [Rate limits](/docs/rate-limits): request limits, send caps and how to back off.

## Guides

- [Reading mail](/docs/guides/reading-mail): list, read, search, download attachments and poll for changes.
- [Sending mail](/docs/guides/sending-mail): send, reply, forward, attach files, drafts and scheduled sends.
- [Agent sends and approval](/docs/guides/approvals): why a token's sends are held by default, and how to send unattended.
- [Idempotency keys](/docs/guides/idempotency): make a retried send or create safe.
- [Webhooks](/docs/guides/webhooks): get a signed POST when mail arrives or a send bounces.
- [Realtime events](/docs/guides/realtime-events): the same events over a WebSocket or Server-Sent Events.

## SDKs and tools

- [TypeScript SDK](/docs/sdks/typescript)
- [Python SDK](/docs/sdks/python)
- [Command-line interface](/docs/sdks/cli)
- [MCP server](/docs/mcp): connect Claude, Cursor or another MCP client.

## API reference

The [API reference](/docs/api) has one page per endpoint, generated from the OpenAPI description this deployment serves. Each page gives the path, the token scope it needs, a request you can paste, the request and response fields, and the status codes.

## Markdown for every page

Every page has a Markdown version at the same address with `.md` on the end, for example [/docs/quickstart.md](/docs/quickstart.md). **Copy as Markdown** at the top of a page puts it on your clipboard, and **View as Markdown** opens it. [/llms.txt](/llms.txt) lists every page with its Markdown address, which is the file to give a coding agent.
