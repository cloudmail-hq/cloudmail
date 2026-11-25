# Command-line interface

> The cloudmail CLI for shells, scripts and coding agents: read, search, send and organise mail, with JSON output, dry runs and documented exit codes.

The CLI drives the same API as everything else on this site. At a terminal it prints aligned tables. In a pipe it prints JSON. Every command that changes something takes `--dry-run`.

## Install

The CLI is a single Go program in the `cli` folder of the cloudmail source you deployed from. Build it there. You need Go installed.

```bash
cd cli
```

```bash
make build && make install
```

`make install` copies the binary to `/usr/local/bin/cloudmail`. Set `PREFIX` to install somewhere else, for example `make install PREFIX=$HOME/.local`.

Without `make`:

```bash
go build -o cloudmail .
```

Check it:

```bash
cloudmail version
```

## Configure

Point the CLI at your deployment and pick a default mailbox:

```bash
cloudmail config set base-url {{BASE_URL}}
```

```bash
cloudmail config set mailbox support@example.com
```

Then give it an API token. Create one at [Settings, API tokens](/settings/account?new-token=1); see [Authentication](/docs/authentication) for scopes.

```bash
cloudmail auth login
```

`auth login` prompts for the token without echoing it, checks it against the deployment, and stores it in a `credentials` file with mode `0600` next to the config file. To read the token from stdin instead, use `cloudmail auth login --with-token`.

For CI and agents, use environment variables instead of a stored token:

```bash
export CLOUDMAIL_BASE_URL={{BASE_URL}}
export CLOUDMAIL_MAILBOX=support@example.com
export CLOUDMAIL_TOKEN=ttk_...
```

| Variable | Purpose |
| --- | --- |
| `CLOUDMAIL_BASE_URL` | The deployment's origin |
| `CLOUDMAIL_MAILBOX` | The default mailbox |
| `CLOUDMAIL_TOKEN` | The API token |
| `CLOUDMAIL_TOKEN_FILE` | A file to read the token from |
| `CLOUDMAIL_PROFILE` | The profile to use |
| `CLOUDMAIL_OUTPUT` | The default output format |
| `CLOUDMAIL_READ_ONLY` | `1` refuses every change |
| `CLOUDMAIL_TIMEOUT` | Timeout per request |
| `CLOUDMAIL_RETRIES` | Retries after a transient failure |

Settings resolve from the config file, then the environment, then flags, with later ones winning. `CLOUDMAIL_TOKEN` beats `CLOUDMAIL_TOKEN_FILE`, which beats the stored token. A token is never accepted as a command-line flag, because flags show up in the process list and in shell history.

Check who you are and what you may do:

```bash
cloudmail auth whoami
```

```bash
cloudmail auth can sendAs
```

`auth can` exits 0 when the capability is allowed and 4 when it is not.

Profiles keep several deployments in one config file: `cloudmail config set base-url <url> --in-profile staging`, then `cloudmail config use staging` or `--profile staging` on one command.

## Read mail

```bash
cloudmail mail list --folder inbox --unread --limit 10
cloudmail mail get <message-id>
cloudmail mail search 'from:customer@example.org has:attachment newer_than:7d'
cloudmail mail search --all --mode hybrid 'renewal pricing'
```

Search uses the query syntax in [Reading mail](/docs/guides/reading-mail). `--all` searches every mailbox the token can read.

To wait for new mail, watch the change counter instead of listing the inbox on a timer:

```bash
cloudmail mailbox watch --interval 30s --count 1
```

## Send mail

```bash
cloudmail mail send --to customer@example.org --subject 'Hello' --text 'Morning.' --yes
cloudmail mail reply <message-id> --text 'Thanks, will do.' --yes
cloudmail mail forward <message-id> --to customer@example.org --yes
cloudmail draft create --to customer@example.org --subject 'Draft' --body 'Later.'
cloudmail schedule create --to customer@example.org --subject Reminder --text 'As discussed.' --in 4h
cloudmail schedule cancel <message-id>
```

Sending asks for confirmation. With no terminal to ask at, it refuses and exits 11 unless you pass `--yes`. `--attach <file>` adds a file and can be repeated. `schedule create` takes `--in` (a delay such as `4h` or `2d`) or `--at` (an absolute time).

### Held for approval

A token's sends are held for a person unless the mailbox is set to send automatically and the token holds `mail:send:auto`, or every recipient is on the mailbox's skip-approval list. See [Agent sends and approval](/docs/guides/approvals).

A held send still exits 0, because the request succeeded, but nothing was sent. Stdout carries the hold and no message id:

```json
{
  "status": "pending_approval",
  "approval_id": "apr_0123456789abcdef0123",
  "approval_url": "{{BASE_URL}}/mail/support%40example.com/approvals?id=apr_0123456789abcdef0123",
  "expires_at": "2026-12-01T12:00:00.000Z",
  "reason": "approval_required"
}
```

Branch on `status`, and do not retry.

```bash
cloudmail approval policy
cloudmail approval list
cloudmail approval show <approval-id>
cloudmail approval revise <approval-id> --body-file fixed.html
cloudmail approval wait <approval-id>
cloudmail approval approve <approval-id> --revision 2
```

`approval revise` works only for the token that asked for the send. `approval approve` needs a token with the `approvals:manage` scope. If the message was revised after the revision you name, the server sends nothing and the command exits 5 with code `APPROVAL_REVISED`.

### Safe retries

`mail send`, `mail reply`, `mail forward`, `draft create`, `draft send`, `schedule create` and the create commands send an `Idempotency-Key`. A fresh key is generated per run, so the CLI's own retries after a lost response replay instead of sending twice. To make retrying the whole command safe, pass your own key and reuse it:

```bash
cloudmail mail send --to customer@example.org --subject Hi --text Yo --yes --idempotency-key order-1234
```

A repeat within 24 hours returns the first result. The same key with different arguments exits 5. See [Idempotency keys](/docs/guides/idempotency).

## Organise

```bash
cloudmail mail archive <message-id>
cloudmail mail star <message-id>
cloudmail label apply <message-id> <label-id>
cloudmail mail delete <message-id>
cloudmail rule create --name Receipts --if subject:contains:receipt --then move_to_folder:archive
```

One bulk request handles up to 500 ids:

```bash
cloudmail mail search 'older_than:1y is:read' --output json --select id | jq -r '.[].id' | cloudmail mail bulk move --to-folder archive --ids-from -
```

## Webhooks, events and tokens

```bash
cloudmail webhook create --name Billing --url https://api.example.org/hooks/mail --event message.received --event message.bounced
cloudmail webhook test <webhook-id>
cloudmail webhook deliveries <webhook-id>
cloudmail events tail --mailbox support@example.com --output ndjson
cloudmail token create ci-reader --scope mail:read --mailbox support@example.com
cloudmail token list
cloudmail token revoke <token-id>
```

`webhook create` prints the signing secret once. `events tail` reconnects on its own and resumes from the last id it printed; `--since <id>` replays from a known point. See [Webhooks](/docs/guides/webhooks) and [Realtime events](/docs/guides/realtime-events).

From a scoped token, `token create` can only make a narrower token: a subset of its scopes and mailboxes, expiring no later.

## Output

Stdout is data. Stderr is commentary: progress, warnings and prompts. The format defaults to a table at a terminal and JSON everywhere else.

| Flag | Effect |
| --- | --- |
| `--output json` or `--json` | One indented document |
| `--output ndjson` | One compact document per line |
| `--output table` | Aligned columns |
| `--output csv` | For spreadsheets |
| `--output plain` | Tab-separated, no header |
| `--select id,subject` | Only these fields |
| `--limit 20` | Only this many rows |

## Change things safely

- `--dry-run` on any command that changes something prints the exact request and exits 10 without sending it.
- `CLOUDMAIL_READ_ONLY=1`, or `--read-only`, refuses every change for the session.
- Commands with consequences ask first. Without a terminal they refuse and exit 11. Pass `--yes` for something reversible and `--force` for something that is not.

## Exit codes

Branch on the code, not on the message text.

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | ok | Continue |
| 1 | unclassified | Read stderr |
| 2 | bad arguments | Fix the command line; nothing was sent |
| 3 | not found | List the collection for a valid id |
| 4 | denied | A capability is missing; a person must grant it |
| 5 | conflict | It already exists, or it changed |
| 6 | not authenticated | Create a token and run `cloudmail auth login` |
| 7 | rate limited | Wait for `retry_after_seconds` |
| 8 | network | Transient; retry |
| 9 | server error | Transient; retry |
| 10 | dry run | Nothing was sent |
| 11 | write refused | Blocked locally; nothing was sent |
| 12 | invalid body | Fix the fields named in `details` |
| 13 | too large | Shrink the attachments |
| 130 | interrupted | |

A failure prints a JSON envelope on stderr:

```json
{
  "code": "NOT_FOUND",
  "error": "Email not found",
  "remediation": "list messages with `cloudmail mail list` to find a valid id",
  "exit_code": 3,
  "kind": "not_found",
  "retryable": false
}
```

## Reach any route

`api` sends any request with authentication, retries and error handling applied. Use it for an endpoint in the [API reference](/docs/api) that has no command:

```bash
cloudmail api GET /api/v1/config
```

A request that changes something needs `--allow-mutations`.

## Learn the command tree

Commands are a noun then a verb, and `--help` works at every level:

```bash
cloudmail --help
cloudmail mail --help
cloudmail mail send --help
```

For a program, `cloudmail guide` prints an orientation and `cloudmail schema` prints the whole command tree, flags and exit codes as JSON.
