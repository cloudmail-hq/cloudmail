package cmd

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

func newMailboxCommand(a *App) *cobra.Command {
	c := group("mailbox", "Inspect and manage mailboxes", `
A mailbox is an email address this deployment receives mail for. Its id *is* the
address, so `+"`--mailbox hello@example.com`"+` is how every other command names one.

Creating and deleting mailboxes is administrator-only. Changing settings needs the
manageSettings capability on that mailbox.`,
		"cloudmail mailbox list",
		"cloudmail mailbox get hello@example.com",
		"cloudmail mailbox watch --mailbox hello@example.com",
	)
	c.AddCommand(
		mailboxList(a), mailboxGet(a), mailboxCreate(a),
		mailboxSettings(a), mailboxDelete(a),
		mailboxAliases(a),
		mailboxWatch(a), mailboxAudit(a), mailboxExport(a),
	)
	return c
}

func mailboxList(a *App) *cobra.Command {
	var domain string
	c := &cobra.Command{
		Use:   "list",
		Short: "List the mailboxes you can reach",
		Long: strings.TrimSpace(`
List mailboxes.

The result is already narrowed to what your credential is granted, so an empty list
means you have no grants rather than that the deployment has no mailboxes. Check
what you hold with ` + "`cloudmail auth whoami`" + `.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			boxes, err := a.Client.ListMailboxes(a.Ctx(c), domain)
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    boxes,
				Columns: mailboxColumns(),
				Summary: fmt.Sprintf("%d mailbox(es)", len(boxes)),
				Empty: "no mailboxes you can reach -- " +
					"run `cloudmail auth whoami` to see your grants",
			})
		},
	}
	c.Flags().StringVar(&domain, "domain", "", "only mailboxes on this domain")
	return c
}

func mailboxGet(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "get [address]",
		Short: "Show a mailbox and its settings",
		Long: strings.TrimSpace(`
Show one mailbox, including its settings: identity, signatures, forwarding,
auto-reply and the agent prompt.

With no argument the configured default mailbox is used.`),
		Args: cobra.MaximumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			id := a.Cfg.Mailbox
			if len(args) == 1 {
				id = args[0]
			}
			if id == "" {
				return fail.Usagef("no mailbox given").
					WithRemediation("name one, or set a default with " +
						"`cloudmail config set mailbox you@example.com`")
			}
			box, err := a.Client.GetMailbox(a.Ctx(c), id)
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: box, Columns: mailboxColumns()})
		},
	}
}

func mailboxCreate(a *App) *cobra.Command {
	var name, settings, settingsFile string
	c := &cobra.Command{
		Use:   "create <address>",
		Short: "Create a mailbox",
		Long: strings.TrimSpace(`
Create a mailbox for an address on a domain this deployment serves.
Administrator-only.

Creating the mailbox is not enough on its own for mail to arrive: Cloudflare Email
Routing has to be pointed at the Worker for that domain. Without it the mailbox
exists and stays empty.`),
		Example: exampleBlock(
			"cloudmail mailbox create support@example.com --name 'Support'",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			raw, err := readJSONArg(settings, settingsFile)
			if err != nil {
				return err
			}
			box, err := a.Client.CreateMailbox(a.Ctx(c), args[0], name, raw)
			if err != nil {
				return err
			}
			if !a.DryRun() {
				a.Out.Info("mail will only arrive once Email Routing for %s points at this Worker",
					domainOf(args[0]))
			}
			return a.emitMutation(output.Result{Data: box, Columns: mailboxColumns()})
		},
	}
	c.Flags().StringVar(&name, "name", "", "display name (default: the address)")
	c.Flags().StringVar(&settings, "settings", "", "initial settings as JSON")
	c.Flags().StringVar(&settingsFile, "settings-file", "", "read initial settings from a JSON file")
	c.MarkFlagsMutuallyExclusive("settings", "settings-file")
	return c
}

func domainOf(addr string) string {
	if i := strings.LastIndex(addr, "@"); i >= 0 {
		return addr[i+1:]
	}
	return addr
}

func mailboxSettings(a *App) *cobra.Command {
	var settings, settingsFile string
	c := &cobra.Command{
		Use:   "settings [address]",
		Short: "Change a mailbox's settings",
		Long: strings.TrimSpace(`
Patch a mailbox's settings. Needs the manageSettings capability.

The patch is merged server-side, so fields you leave out keep their current values
and you do not have to read-modify-write. Read the current settings with
` + "`cloudmail mailbox get --output json`" + `.

One field deserves care: forwarding.email redirects every incoming message
elsewhere. Setting it is the most consequential change available here, which is why
this command asks before applying a patch that touches it.`),
		Example: exampleBlock(
			`cloudmail mailbox settings --settings '{"autoDraft":{"enabled":true}}'`,
			"cloudmail mailbox settings --settings-file ./settings.json",
		),
		Args: cobra.MaximumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			id := a.Cfg.Mailbox
			if len(args) == 1 {
				id = args[0]
			}
			raw, err := readJSONArg(settings, settingsFile)
			if err != nil {
				return err
			}
			if raw == nil {
				return fail.Usagef("no settings given").
					WithRemediation("pass --settings '{...}' or --settings-file settings.json")
			}
			// Forwarding is called out specifically because it silently redirects
			// the mailbox's entire inbound stream, and an operator reviewing a
			// script should be made to notice it.
			if strings.Contains(string(raw), "forwarding") {
				if err := a.Confirm(fmt.Sprintf(
					"this patch changes forwarding on %s, which redirects incoming mail", id),
					true); err != nil {
					return err
				}
			}
			box, err := a.Client.UpdateMailboxSettings(a.Ctx(c), id, raw)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: box})
		},
	}
	c.Flags().StringVar(&settings, "settings", "", "settings patch as JSON")
	c.Flags().StringVar(&settingsFile, "settings-file", "", "read the patch from a JSON file")
	c.MarkFlagsMutuallyExclusive("settings", "settings-file")
	return c
}

func mailboxDelete(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "delete <address>",
		Short: "Delete a mailbox and everything in it",
		Long: strings.TrimSpace(`
Delete a mailbox. Administrator-only, and irreversible.

This destroys every message in the mailbox and its audit log, and strips the address
from every access grant that named it. Re-creating the same address later does not
restore any of it.

Export first if you want the mail: ` + "`cloudmail mailbox export`" + `.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf(
				"destroy mailbox %s, every message in it, and its audit log", args[0]),
				true); err != nil {
				return err
			}
			res, err := a.Client.DeleteMailbox(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
}

// mailboxWatch polls the mailbox's change counter.
//
// The counter is cheap; listing messages is not. Watching it and only acting when
// it moves is how a script reacts to new mail without spending its rate-limit
// budget on a listing every few seconds.
func mailboxWatch(a *App) *cobra.Command {
	var interval string
	var count int
	c := &cobra.Command{
		Use:   "watch",
		Short: "Wait for the mailbox to change",
		Long: strings.TrimSpace(`
Poll the mailbox's change counter and print a line each time it moves.

This is the cheap way to notice new mail. The counter is a single small value, so
polling it every few seconds costs almost nothing, whereas re-listing the inbox on a
timer burns the request budget and grows more expensive as the mailbox does.

Exits after --count changes, or runs until interrupted.`),
		Example: exampleBlock(
			"# React to each change",
			"cloudmail mailbox watch --interval 10s |",
			"  while read -r _; do cloudmail mail list --folder inbox --unread; done",
			"",
			"# Wait for exactly one change, then exit",
			"cloudmail mailbox watch --count 1",
		),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			every, err := parseFlexibleDuration(interval)
			if err != nil {
				return fail.Usagef("cannot read --interval %q as a duration", interval)
			}
			// Below a few seconds this becomes a denial of service against the
			// caller's own rate limit rather than a useful watch.
			if every < 2*time.Second {
				return fail.Usagef("--interval must be at least 2s, got %s", interval).
					WithRemediation("the API allows 600 requests a minute; " +
						"polling faster than 2s wastes that budget")
			}

			ctx := a.Ctx(c)
			last, err := a.Client.MailboxStateVersion(ctx, mb)
			if err != nil {
				return err
			}
			a.Out.Info("watching %s every %s; press Ctrl-C to stop", mb, every)

			seen := 0
			ticker := time.NewTicker(every)
			defer ticker.Stop()

			for {
				select {
				case <-ctx.Done():
					// An interrupt during a deliberate wait is the expected way
					// to end this, not a failure.
					return nil
				case <-ticker.C:
				}

				current, err := a.Client.MailboxStateVersion(ctx, mb)
				if err != nil {
					if ctx.Err() != nil {
						return nil
					}
					// A transient failure mid-watch should not end a long-running
					// watch; report it and keep going.
					a.Out.Warn("%v", fail.AsError(err).Message)
					continue
				}
				if string(current) == string(last) {
					continue
				}
				last = current
				seen++

				if err := a.Out.Emit(output.Result{Data: map[string]any{
					"mailbox": mb, "changed_at": time.Now().UTC().Format(time.RFC3339),
					"state": current,
				}}); err != nil {
					return err
				}
				if count > 0 && seen >= count {
					return nil
				}
			}
		},
	}
	c.Flags().StringVar(&interval, "interval", "10s", "how often to check, at least 2s")
	c.Flags().IntVar(&count, "count", 0, "exit after this many changes (0 = run forever)")
	return c
}

func mailboxAudit(a *App) *cobra.Command {
	var limit int
	c := &cobra.Command{
		Use:   "audit",
		Short: "Show the mailbox's access log",
		Long: strings.TrimSpace(`
Show who has acted on this mailbox: sends and the attribution used, deletions,
destructions and settings changes. Needs the manageSettings capability.

Reads are deliberately not recorded -- a mail client reads constantly, and logging
every message opened would bury the entries worth finding. Subjects and bodies are
not stored either, so the log cannot become a second copy of the mailbox.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			entries, err := a.Client.MailboxAudit(a.Ctx(c), mb, limit)
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: entries})
		},
	}
	c.Flags().IntVar(&limit, "limit-entries", 0, "most entries to return")
	return c
}

func mailboxExport(a *App) *cobra.Command {
	var outFile string
	c := &cobra.Command{
		Use:   "export",
		Short: "Export the mailbox as mbox",
		Long: strings.TrimSpace(`
Export every message in the mailbox in mbox format, which Thunderbird, mutt and most
other mail clients can import.

Written to --output-file, or to stdout. Note that this client buffers the response,
so a very large mailbox may exceed the 8 MiB response ceiling; for those, export from
the web UI instead.`),
		Example: exampleBlock(
			"cloudmail mailbox export --output-file ./backup.mbox",
		),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			data, err := a.Client.ExportMailbox(a.Ctx(c), mb)
			if err != nil {
				return err
			}
			if outFile == "" {
				_, err := a.Out.Out().Write(data)
				return writeErr(err)
			}
			if err := os.WriteFile(outFile, data, 0o600); err != nil {
				return fail.Errf("cannot write %s: %v", outFile, err)
			}
			return a.emit(output.Result{
				Data:    map[string]any{"path": outFile, "bytes": len(data)},
				Summary: fmt.Sprintf("wrote %s to %s", humanBytes(float64(len(data))), outFile),
			})
		},
	}
	c.Flags().StringVar(&outFile, "output-file", "", "write the mbox here instead of stdout")
	return c
}

// ── people ─────────────────────────────────────────────────────────

func newPeopleCommand(a *App) *cobra.Command {
	c := group("people", "See mail grouped by correspondent", `
The same mail viewed by who it was with, across every mailbox you can reach.`,
		"cloudmail people list",
		"cloudmail people mail alice@example.com",
	)
	c.AddCommand(
		&cobra.Command{
			Use:   "list",
			Short: "List correspondents",
			Long:  "Show everyone you have exchanged mail with.",
			Args:  cobra.NoArgs,
			RunE: func(c *cobra.Command, _ []string) error {
				people, err := a.Client.ListPeople(a.Ctx(c))
				if err != nil {
					return err
				}
				return a.emit(output.Result{
					Data: people,
					Columns: []output.Column{
						{Header: "email", Field: "email", Truncate: 36},
						{Header: "name", Field: "name", Truncate: 26},
						{Header: "messages", Field: "count", Right: true},
					},
					Untrusted: []string{"name", "email"},
					Empty:     "no correspondents yet",
				})
			},
		},
		func() *cobra.Command {
			var page, limit int
			pc := &cobra.Command{
				Use:   "mail <person>",
				Short: "List mail exchanged with one person",
				Long:  "Show the messages to and from one correspondent, across mailboxes.",
				Args:  cobra.ExactArgs(1),
				RunE: func(c *cobra.Command, args []string) error {
					list, err := a.Client.PersonEmails(a.Ctx(c), args[0], page, a.pageLimit(limit))
					if err != nil {
						return err
					}
					return a.emit(output.Result{
						Data:      list.Emails,
						Columns:   emailColumns(),
						Summary:   countSummary(len(list.Emails), list.TotalCount, "messages"),
						Untrusted: untrustedEmailFields(),
						Empty:     "no mail with that person",
					})
				},
			}
			pc.Flags().IntVar(&page, "page", 0, "page number, starting at 1")
			pc.Flags().IntVar(&limit, "limit-per-page", 0, "messages per page")
			return pc
		}(),
	)
	return c
}

// ── analytics ──────────────────────────────────────────────────────

func newAnalyticsCommand(a *App) *cobra.Command {
	c := group("analytics", "Delivery outcomes for mail you sent", `
How outbound mail fared: accepted, delivered, deferred, bounced or failed.

Sending answers before delivery is known, so this is where the outcome shows up
afterwards. For one message, `+"`cloudmail mail delivery <id>`"+` is more direct.`,
		"cloudmail analytics summary --days 7",
		"cloudmail analytics sent --days 30",
	)

	var days int
	summary := &cobra.Command{
		Use:   "summary",
		Short: "Delivery totals and a daily breakdown",
		Long:  "Totals across every mailbox you can reach, plus a per-day series.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			data, err := a.Client.Analytics(a.Ctx(c), days)
			if err != nil {
				return err
			}
			if a.Out.Format() == output.Table {
				// The totals are the answer; the daily series is context. Showing
				// the series as the table and burying the totals would invert
				// that.
				a.Out.Info("delivered %d of %d sent (%d failed, %d bounced, %d pending)",
					data.Totals.Delivered, data.Totals.Total,
					data.Totals.Failed, data.Totals.Bounced, data.Totals.Pending)
				return a.emit(output.Result{
					Data: data.ByDate,
					Columns: []output.Column{
						{Header: "date", Field: "date"},
						{Header: "sent", Field: "sent", Right: true},
						{Header: "delivered", Field: "delivered", Right: true},
						{Header: "failed", Field: "failed", Right: true},
					},
					Empty: "nothing sent in that window",
				})
			}
			return a.emit(output.Result{Data: data})
		},
	}
	summary.Flags().IntVar(&days, "days", 30, "window in days")

	var sentDays int
	sent := &cobra.Command{
		Use:   "sent",
		Short: "Per-mailbox send rollup",
		Long:  "Send counts broken down by mailbox. The server clamps the window to 1-90 days.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			data, err := a.Client.SentAnalytics(a.Ctx(c), sentDays)
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: data})
		},
	}
	sent.Flags().IntVar(&sentDays, "days", 30, "window in days, 1 to 90")

	c.AddCommand(summary, sent,
		newAnalyticsSectionCommand(a, "overview", "Sending health, reputation, quota, domains and errors", `
Sending health for the window: sent, delivered, bounced, failed, complaints, and
rates. --scope app (the default) counts this app's mailboxes from the delivery
ledger, in messages. --scope zone counts every sender on the Cloudflare zone, in
recipients, and needs an administrator. Administrators also get account
reputation, the daily quota and the sending domains.`),
		newAnalyticsSectionCommand(a, "engagement", "Opens and clicks per message and per link", `
Engagement from this app's own open and click tracking. Opens are pixel loads;
image proxies such as Apple Mail Privacy Protection inflate them.`),
		newAnalyticsSectionCommand(a, "inbound", "Received mail, auth pass rates and routing", `
Inbound mail: received and stored counts, SPF/DKIM/DMARC verdicts, Email Routing
actions and rules. Cloudflare routing data needs an administrator; members get
local counts for their mailboxes.`),
		newAnalyticsSectionCommand(a, "dmarc", "DMARC aggregate reports (administrators)", `
Who sends mail as your domains and whether it passes DMARC, from the aggregate
reports mailbox providers send to Cloudflare.`),
	)
	return c
}

// newAnalyticsSectionCommand builds one analytics console subcommand. The
// output is the raw JSON section; there is no single natural table for these.
func newAnalyticsSectionCommand(a *App, section, short, long string) *cobra.Command {
	var opts api.AnalyticsOptions
	cmd := &cobra.Command{
		Use:   section,
		Short: short,
		Long:  strings.TrimSpace(long),
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			switch opts.Days {
			case 0, 1, 7, 30, 90:
			default:
				return fmt.Errorf("--days must be 1, 7, 30 or 90")
			}
			if opts.Scope != "" && opts.Scope != "app" && opts.Scope != "zone" {
				return fmt.Errorf("--scope must be app or zone")
			}
			data, err := a.Client.AnalyticsSection(a.Ctx(c), section, opts)
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: data})
		},
	}
	cmd.Flags().IntVar(&opts.Days, "days", 7, "window in days: 1, 7, 30 or 90 (Cloudflare data covers 31 days)")
	cmd.Flags().BoolVar(&opts.Refresh, "refresh", false, "bypass the 5-minute cache (administrators)")
	switch section {
	case "overview":
		cmd.Flags().StringVar(&opts.Scope, "scope", "", "app (default) or zone (administrators)")
		cmd.Flags().StringVar(&opts.Domain, "domain", "", "restrict to one sending domain")
	case "engagement":
		cmd.Flags().StringVar(&opts.Mailbox, "mailbox", "", "restrict to one mailbox")
	}
	return cmd
}

// ── access ─────────────────────────────────────────────────────────

func newAccessCommand(a *App) *cobra.Command {
	c := group("access", "Manage who can reach which mailbox", `
Sign-in decides who gets in. These grants decide what they can reach once they are
in, and with which capabilities.

Administrator-only. With built-in sign-in, authorization is always enforced. On a
legacy Cloudflare Access deployment with ADMIN_EMAILS unset, everyone who passes the
Access policy is an administrator of every mailbox -- `+
		"`cloudmail auth whoami`"+` reports enforced:false in that state.

Roles, from least to most: viewer, agent, manager, owner.`,
		"cloudmail access list",
		"cloudmail access log",
		"cloudmail access revoke email alice@example.com",
	)

	c.AddCommand(
		&cobra.Command{
			Use:   "list",
			Short: "Show the grant table",
			Long: strings.TrimSpace(`
Show every grant, and the role vocabulary the deployment enforces.

Use --output json to get the table in the shape ` + "`access set`" + ` expects back.`),
			Args: cobra.NoArgs,
			RunE: func(c *cobra.Command, _ []string) error {
				data, err := a.Client.ListAccess(a.Ctx(c))
				if err != nil {
					return err
				}
				return a.emit(output.Result{Data: data})
			},
		},
		&cobra.Command{
			Use:   "log",
			Short: "Show the deployment-wide access log",
			Long: strings.TrimSpace(`
Show every recorded action across the deployment: sends with their attribution,
deletions, destructions, settings writes, mailbox lifecycle and grant changes.`),
			Args: cobra.NoArgs,
			RunE: func(c *cobra.Command, _ []string) error {
				data, err := a.Client.AccessAudit(a.Ctx(c))
				if err != nil {
					return err
				}
				return a.emit(output.Result{Data: data})
			},
		},
		accessSet(a),
		&cobra.Command{
			Use:   "revoke <email|service> <id>",
			Short: "Revoke a principal's access entirely",
			Long: strings.TrimSpace(`
Remove every grant belonging to one principal.

Use "email" for a person and "service" for an Access service token, whose id is its
Client ID.`),
			Args: cobra.ExactArgs(2),
			RunE: func(c *cobra.Command, args []string) error {
				if err := a.Confirm(fmt.Sprintf(
					"revoke every mailbox %s %s can reach", args[0], args[1]), true); err != nil {
					return err
				}
				if err := a.Client.RevokeAccess(a.Ctx(c), args[0], args[1]); err != nil {
					return err
				}
				return a.emitMutation(output.Result{
					Data: map[string]any{
						"status": "revoked", "kind": args[0], "id": args[1], "dry_run": a.DryRun(),
					},
				})
			},
		},
	)
	return c
}

func accessSet(a *App) *cobra.Command {
	var grants, grantsFile string
	c := &cobra.Command{
		Use:   "set",
		Short: "Replace the whole grant table",
		Long: strings.TrimSpace(`
Replace the grant table with the payload given.

This is a whole-table write, not a patch. Anyone absent from the payload loses
access, so read the current table first, edit it, and send it back:

  cloudmail access list --output json > grants.json
  # edit grants.json
  cloudmail access set --grants-file grants.json

Locking yourself out is not possible if your address is in the deployment's
ADMIN_EMAILS, which is exactly why those live in configuration rather than in this
table.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			raw, err := readJSONArg(grants, grantsFile)
			if err != nil {
				return err
			}
			if raw == nil {
				return fail.Usagef("no grants given").
					WithRemediation("pass --grants '{...}' or --grants-file grants.json; " +
						"start from `cloudmail access list --output json`")
			}
			if err := a.Confirm(
				"replace the entire grant table -- anyone not in this payload loses access",
				true); err != nil {
				return err
			}
			res, err := a.Client.PutAccess(a.Ctx(c), raw)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
	c.Flags().StringVar(&grants, "grants", "", "the full grant table as JSON")
	c.Flags().StringVar(&grantsFile, "grants-file", "", "read the full grant table from a JSON file")
	c.MarkFlagsMutuallyExclusive("grants", "grants-file")
	return c
}

// unused import guard: api is referenced by other files in this package, but keep
// the symbol live here so a future edit that drops the last use is a compile error
// rather than a silent behaviour change.
var _ = api.BulkLimit
