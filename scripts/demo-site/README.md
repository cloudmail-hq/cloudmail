# Public demo

A copy of the app that anyone can open and click through without an account. It is a static site: the mail, the AI results and every API answer come from data that ships with the page, and nothing a visitor does leaves their browser.

```bash
npm run demo
```

That builds the demo into `build-demo/client` and serves it on http://127.0.0.1:4173. The two steps are also available on their own as `npm run build:demo` and `npm run serve:demo`.

## What a visitor gets

- No sign-in. The page opens in the inbox of Maya Okafor at the fictional Northwind Supply Co., with four more mailboxes to switch to.
- Reading, search, star, read and unread, archive, move, labels, snooze, delete, drafts and attachments all work. They change data held in memory, so a reload puts everything back.
- AI features show stored results and call no model: thread summaries, the Today brief, "Ask your inbox", and the agent panel.
- Sending is off. Send, scheduled send, send now, reply and forward by API, approving a held message and enrolling in a sequence all answer "Sending is turned off in the demo."
- Settings that reach outside a mailbox are read-only: Cloudflare, domains, accounts and invitations, passwords, two-factor, passkeys, API tokens, licence, webhooks, exports and account deletion.
- A strip at the top says "This is a demo. Nothing is saved." and links to trycloudmail.com and its pricing page.

## How it works

`npm run build:demo` builds the app in Vite mode `demo` with `scripts/demo-site/vite.config.ts`. That config has no Cloudflare plugin, so the output has no Worker, Durable Object, bucket, variable or secret. `app/demo/flag.ts` turns the mode into the constant `DEMO`. In every other build `DEMO` is `false` and the demo code is not in the bundle.

| File | Job |
|---|---|
| `app/entry.client.tsx` | In the demo, starts the in-page backend before the app renders |
| `app/demo/install.ts` | Replaces `fetch`: `/api/*` and `/agents/*` are answered in the page, GETs for the site's own files pass, everything else is refused |
| `app/demo/backend.ts` | The request router: mail goes to the store, sending is refused, protected settings are read-only |
| `app/demo/store.ts` | The mail in memory, with the list, thread, count and search rules of the real mailbox |
| `app/demo/ai.ts` | Stored summaries, the brief, Ask answers and the agent's replies |
| `app/demo/files.ts` | Attachment files and sender faces, made in the page |
| `app/demo/storage-script.ts` | Makes `localStorage` and `sessionStorage` in-memory before anything reads them |
| `app/demo/data/snapshot.json` | The recorded starting data |
| `scripts/demo-site/static/_headers` | Response headers, including a policy that lets the page fetch only its own files |

The demo keeps nothing in the browser: no cookie, no storage, no IndexedDB, no cache and no service worker.

The only requests the page makes are GETs for its own static files and for the Inter font from Google Fonts, the same font request the app makes. They carry no body and no referrer. One thing still reaches the static host: the address of a page when it is loaded or reloaded. That address holds the text of a search (`?q=`) and the name of a folder a visitor created, so reloading on such a page sends it as part of the page request, as on any website. No code runs on the host to read it.

It is not a way to run cloudmail. There is no mail backend in it: it cannot receive, store or send a message, and it has no licence check to pass or skip.

## Search engines

The demo is `noindex`: a robots meta tag, an `X-Robots-Tag` header and a `robots.txt` that disallows everything. The site to index is trycloudmail.com.

## Changing the data

The data is a recording of the local demo instance (`scripts/demo`). Change the seed there, then record it again:

```bash
scripts/demo/run.sh seed
```

```bash
scripts/demo/run.sh dev
```

```bash
node scripts/demo-site/snapshot.mjs
```

The recorder reads a local instance only. It stores dates as offsets, so the newest mail is always a few hours old, and it replaces the recording machine's addresses and user agents with neutral values. Every person and company is fictional and every address is on a `.example` domain; `test/demo-site.test.ts` fails if that stops being true.

Summaries for conversations, Ask answers and the agent's stored conversation are written by hand in `app/demo/ai.ts`. Keep them in step with the seed.

## Checking it

```bash
npx vitest run test/demo-site.test.ts
```

```bash
node scripts/demo-site/verify.mjs
```

The second command drives the served demo in Chromium (`npm i --no-save playwright-core`, and `CHROMIUM_PATH` if Chromium is not at `/usr/bin/chromium`). It opens the inbox, reads a thread, stars, labels and archives, writes a draft, presses Send, reloads, and fails if any request is not a GET for a static file or carries anything the visitor typed.

## Putting it live

`scripts/demo-site/wrangler.jsonc` deploys `build-demo/client` as static assets with no Worker script:

```bash
npx wrangler deploy --config scripts/demo-site/wrangler.jsonc
```

It has no route. Add the public address as a custom domain when deploying. On a Cloudflare zone with Web Analytics set to automatic, the proxy would add a script tag to every page; `_headers` sends `Cache-Control: no-transform` on the pages so it does not. After a deploy, run `DEMO_URL=https://<address> node scripts/demo-site/verify.mjs`: it fails on any request that is not for the site's own files or the font. Any static host works if it serves `index.html` for paths that are not files; `_headers` is in the format Cloudflare reads.
