# Contributing to cloudmail

Bug reports, fixes, docs and features are welcome. This page covers how to run
cloudmail on your computer, how to check a change, and how pull requests work.

## Where to start

- **Found a bug?** [Open an issue](https://github.com/cloudmail-hq/cloudmail/issues/new/choose). For a security problem, follow [SECURITY.md](SECURITY.md) instead.
- **Want something small to work on?** Pick an issue labelled [`good first issue`](https://github.com/cloudmail-hq/cloudmail/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22). Each one names the files to change.
- **Want something larger?** Issues labelled [`help wanted`](https://github.com/cloudmail-hq/cloudmail/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) need more work, such as a new sending provider.
- **Have an idea or a question?** Start a [discussion](https://github.com/cloudmail-hq/cloudmail/discussions).
- **Want to know what is planned?** Read the [roadmap](https://github.com/cloudmail-hq/cloudmail/discussions/1).

Comment on an issue before you start, so two people don't build the same thing.
For a change larger than a bug fix, agree on the approach in the issue first.

## A free licence for contributors

When your first pull request is merged, we send you a free Unlimited licence
(normally $29): any number of domains, one deployment. To get it, email
hello@trycloudmail.com from the address on your commits with a link to the
pull request, or say in the pull request which address to send the key to.

One licence per person. A pull request that only fixes typos is welcome, but it
doesn't count for the licence.

## Run it on your computer

You need Node 22.5 or newer, on macOS or Linux (on Windows, use WSL). You don't
need a Cloudflare account or a licence key: a development build skips the
licence check.

```bash
git clone https://github.com/cloudmail-hq/cloudmail.git
cd cloudmail
npm ci
npm run dev:demo
```

The first run takes about a minute. It fills a local instance with fictional
mail (five mailboxes, about 120 messages, labels, drafts, a send waiting for
approval) and prints the address and the sign-in. Later runs start at once.
`scripts/demo/run.sh reset` throws the local data away.

The demo instance runs offline, so it has no AI model, no semantic search and
no real sending. To work on those, run against your own Cloudflare account:

```bash
npx wrangler login
cp .dev.vars.example .dev.vars
npm run secrets -- --dev
npm run dev
```

Then open `/setup`. [docs/reference.md](docs/reference.md#local-development) has the details.

## Where things are

| Path | What it holds |
| - | - |
| `app/` | The web app: React 19, React Router v7, Tailwind CSS v4 |
| `workers/` | The Worker: Hono routes, Durable Objects, mail in and out, the MCP server |
| `shared/` | Code used by both the app and the Worker |
| `cli/` | The `cloudmail` command-line tool, in Go |
| `sdk/typescript/`, `sdk/python/` | The SDKs |
| `test/` | Vitest tests for the app, the Worker and shared code |
| `docs/` | Deploy, upgrade, troubleshooting and reference docs |

## Check your change

Run the tests for what you changed while you work:

```bash
npx vitest run test/search-query.test.ts
```

Before you open a pull request, run what CI runs:

```bash
npm test
npm run typecheck
npm run build
```

If you changed an SDK or the CLI:

```bash
cd sdk/typescript && npm ci && npm run check:generated && npm run typecheck && npm test
cd sdk/python && uv venv && uv pip install -e '.[dev]' && uv run pytest -q
cd cli && go vet ./... && go test -race ./...
```

### Adding or changing an API route

A route under `/api/v1` is part of the public API, and CI checks that every
client covers it. A new route needs:

1. an entry in `workers/lib/openapi.ts`;
2. `npm run generate` in `sdk/typescript`, with the generated files committed;
3. a method in `sdk/typescript/src/resources.ts` and in `sdk/python/src/cloudmail/resources.py`, or an entry with a reason in each SDK's coverage test;
4. a command or an exclusion in `cli/internal/cmd/coverage_test.go`.

## Pull requests

- Keep one change per pull request, with a test for it.
- Say what you changed, why, and how you checked it. Add a screenshot for a change to the interface.
- Match the code around your change. New files need no licence header.
- Use fictional people and `.example` domains in tests and fixtures. Never commit real mail, tokens, keys or licence keys.
- A first-time contributor's pull request waits for a maintainer to start CI.

We don't merge changes that remove or weaken the licence check, because the
[licence](LICENSE) doesn't allow it.

## Licence of your contribution

cloudmail is fair source under the [Fair Core License](LICENSE), and each
release becomes Apache 2.0 two years after it ships. We also sell licence keys
for it. To keep doing both with code you contribute, opening a pull request
means you agree that:

- you wrote the contribution, or you have the right to submit it;
- you give Tapetide, the licensor named in [LICENSE](LICENSE), a perpetual, worldwide, non-exclusive, royalty-free, irrevocable copyright and patent licence to use, change, distribute and sublicense your contribution as part of cloudmail, under the project's current licence and any later one;
- you keep the copyright in your contribution and can use it anywhere else.

## Conduct

Be respectful. The [code of conduct](CODE_OF_CONDUCT.md) applies to issues,
discussions and pull requests.
