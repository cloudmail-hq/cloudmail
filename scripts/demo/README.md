# Demo instance and launch screenshots

Scripts that build a local, offline cloudmail instance full of believable but
entirely fictional mail, and screenshot it for the website, README and launch
posts. They add nothing to the app and change none of its behaviour.

Everything is invented: Northwind Supply Co. (northwind.example), Northwind Labs
(northwindlabs.example) and Harborline Goods (harborline.example), their staff,
customers and suppliers. Every address is under the reserved `.example` TLD
(RFC 2606). Nothing is copied from real mail.

## Work on the app with it

```bash
npm ci
npm run dev:demo
```

The first run seeds the instance (about a minute) and prints the address and
the sign-in. Later runs reuse the seeded state. `scripts/demo/run.sh reset`
throws it away. This needs no browser automation, Cloudflare login or licence key.

## Capture the screenshots

Heavy work (install, dev server, Chromium) belongs on a Linux box, not a laptop
that runs other things.

```bash
npm ci --ignore-scripts
npm i --no-save --ignore-scripts playwright-core   # or: npx playwright install chromium
export CHROMIUM_PATH=/usr/bin/chromium              # if you use a system Chromium

scripts/demo/run.sh all ./launch-shots              # reset, seed, capture everything
```

Or step by step:

```bash
scripts/demo/run.sh seed ./launch-shots   # fresh state, /setup shot, seed (both phases)
scripts/demo/run.sh serve &               # dev server on the seeded state
scripts/demo/run.sh capture ./launch-shots --only inbox-light,thread
scripts/demo/run.sh stop
```

The dev server listens on http://127.0.0.1:5173. Sign in as
`maya@northwind.example` with the password in `demo-constants.mjs` (a throwaway
local value).

## Files

| File | What it does |
| - | - |
| `vite.demo.config.ts` | Dev server config. Generates `.generated/wrangler.json` from `wrangler.jsonc` without the bindings that need a Cloudflare login (Workers AI, Vectorize, remote `send_email`), with the demo domains, `LOCAL_AI_MOCK=1`, the licence gate off, and state in `.wrangler/demo-state`. |
| `demo-constants.mjs` | Demo domains, owner account, local-only setup token. |
| `demo-data.mjs` | The content: 5 mailboxes (one shared, `support@`), ~40 conversations plus a month of earlier sent mail (124 messages), attachments, labels, AI triage labels and summaries, 3 drafts, 3 scheduled sends, a send held for approval, 7 templates, 3 sequences with enrollments. |
| `seed-demo.mjs api` | Fills a running instance through the app's own routes: `/api/auth/setup`, mailboxes, labels, triage presets, templates, sequences, drafts, scheduled sends, an API token whose send is held for approval, and every message through the local inbound handler (`/cdn-cgi/handler/email`) so parsing, threading, attachments and search indexing are the real code paths. Message `Date:` headers are backdated; the time zone is chosen so "now" is mid-morning. |
| `seed-demo.mjs db` | With the server **stopped**, edits the local Durable Object SQLite files for what has no API because it comes from the outside world or a model: which messages we sent (they were delivered inbound), read/starred state, AI triage labels, thread summaries, delivery/open/click events, listed attachment sizes (the local inbound handler caps a message at 1 MiB). |
| `capture.mjs` | Playwright. `--phase pre` shoots `/setup` before the owner exists; the default phase signs in and runs `capture-shots.mjs`. 1440×900 at 2× for desktop, 390×844 at 2× for phone. Hides scrollbars, the caret and toasts. |
| `capture-shots.mjs` | One function per shot. |
| `agent-conversation.mjs` | The AI agent panel's history for `agent.png`. The offline server has no model, so the capture serves this stored conversation to the panel (it intercepts the panel's history request); every fact in it comes from the seeded mail. |
| `run.sh` | Orchestration. |

## What is not real

- Thread summaries, AI triage labels and the agent conversation were written by
  hand, in the shapes the app stores, because there is no model offline.
- Delivery, open and click events are synthesised for the sent mail.
- With no Cloudflare account connected, Cloudflare-sourced data (zone
  analytics, DNS checks, the guided setup's plan) is not available offline.
