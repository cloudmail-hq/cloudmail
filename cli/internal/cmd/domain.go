package cmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

func newDomainCommand(a *App) *cobra.Command {
	c := group("domain", "Manage the domains this deployment receives mail for", `
A domain is a hostname mailboxes can live on. Adding one records it; mail only
arrives once its DNS and Cloudflare Email Routing point at this Worker.

Two ways to get there: `+"`cloudmail domain provision`"+` configures Cloudflare for
you when the deployment has CF_API_TOKEN, and `+"`cloudmail domain get`"+` lists the
records to create by hand when it does not. `+"`cloudmail domain verify`"+` checks the
live DNS either way.

Every command here is administrator-only. A domain can be named by its id
(dom_...) or by its hostname.`,
		"cloudmail domain list",
		"cloudmail domain add example.com --catch-all hello@example.com",
		"cloudmail domain provision example.com --yes",
		"cloudmail domain verify example.com",
	)
	c.AddCommand(
		domainList(a), domainGet(a), domainAdd(a),
		domainVerify(a), domainProvision(a), domainDelete(a),
	)
	return c
}

func domainList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List the domains this deployment serves",
		Long: strings.TrimSpace(`
List every domain, with its routing and sending state and how many mailboxes live
on it.

Domains with source "env" are seeded from the deployment's DOMAINS configuration and
cannot be deleted while they are listed there.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			list, err := a.Client.ListDomains(a.Ctx(c))
			if err != nil {
				return err
			}
			cf := "Cloudflare API not configured: provisioning is manual"
			if list.Cloudflare.Configured {
				cf = "Cloudflare API configured"
			}
			return a.emit(output.Result{
				Data:    list,
				Rows:    list.Domains,
				Columns: domainColumns(),
				Summary: fmt.Sprintf("%d domain(s); %s", len(list.Domains), cf),
				Empty:   "no domains -- add one with `cloudmail domain add example.com`",
			})
		},
	}
}

func domainGet(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "get <id-or-hostname>",
		Short: "Show a domain, its DNS records and its last check",
		Long: strings.TrimSpace(`
Show one domain: its state, the DNS records it needs, the result of the last
verification and provisioning runs, and any steps that have to be done by hand.

The records listed are what the domain needs, not what DNS currently holds. Run
` + "`cloudmail domain verify`" + ` to compare them against live DNS.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			d, err := a.Client.GetDomain(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			if a.Out.Format() != output.Table {
				return a.emit(output.Result{Data: d})
			}

			if err := a.emit(output.Result{Data: d.Domain, Columns: domainDetailColumns()}); err != nil {
				return err
			}
			if err := a.section("DNS records", output.Result{
				Data:    d.Records,
				Columns: dnsRecordColumns(),
				Empty:   "no records reported",
			}); err != nil {
				return err
			}
			if d.Audit != nil {
				if err := a.section(fmt.Sprintf("Last check: %s (%s)",
					d.Audit.Summary, formatEpochMS(d.Audit.CheckedAt)), output.Result{
					Data:    d.Audit.Checks,
					Columns: auditCheckColumns(),
					Empty:   "no checks",
				}); err != nil {
					return err
				}
			} else {
				a.Out.Info("never verified -- run `cloudmail domain verify %s`", d.Domain.Hostname)
			}
			if d.Provision != nil {
				if err := a.section(fmt.Sprintf("Last provision: %s (%s)",
					okWord(d.Provision.OK), formatEpochMS(d.Provision.RanAt)), output.Result{
					Data:    d.Provision.Steps,
					Columns: provisionStepColumns(),
					Empty:   "no steps",
				}); err != nil {
					return err
				}
			}
			if len(d.ManualSteps) > 0 {
				out := a.Out.Out()
				fmt.Fprintln(out)
				fmt.Fprintln(out, a.Out.Bold("Manual steps"))
				for i, step := range d.ManualSteps {
					fmt.Fprintf(out, "  %d. %s\n", i+1, step)
				}
			}
			return nil
		},
	}
}

func domainAdd(a *App) *cobra.Command {
	var name, zoneID, catchAll string
	c := &cobra.Command{
		Use:   "add <hostname>",
		Short: "Add a domain",
		Long: strings.TrimSpace(`
Record a new domain. Administrator-only.

This does not touch DNS. Afterwards, either run ` + "`cloudmail domain provision`" + ` to
have the deployment configure Cloudflare, or create the records listed by
` + "`cloudmail domain get`" + ` yourself.

--catch-all names the mailbox that receives mail for addresses on this domain that
have no mailbox of their own. Without it, such mail is not routed.`),
		Example: exampleBlock(
			"cloudmail domain add example.com",
			"cloudmail domain add example.com --name 'Example' --catch-all hello@example.com",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			d, err := a.Client.CreateDomain(a.Ctx(c), api.DomainInput{
				Hostname:        args[0],
				DisplayName:     name,
				ZoneID:          zoneID,
				CatchAllMailbox: catchAll,
			})
			if err != nil {
				return err
			}
			if !a.DryRun() {
				a.Out.Info("next: `cloudmail domain provision %s`, or create the records "+
					"`cloudmail domain get %s` lists", d.Hostname, d.Hostname)
			}
			return a.emitMutation(output.Result{Data: d, Columns: domainDetailColumns()})
		},
	}
	c.Flags().StringVar(&name, "name", "", "display name (default: the hostname)")
	c.Flags().StringVar(&zoneID, "zone-id", "", "Cloudflare zone id (default: looked up by hostname)")
	c.Flags().StringVar(&catchAll, "catch-all", "", "mailbox that receives mail for unknown addresses")
	return c
}

func domainVerify(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "verify <id-or-hostname>",
		Short: "Check a domain's live DNS",
		Long: strings.TrimSpace(`
Look up the domain's live DNS and compare it with the records it needs. Each check
passes, warns or fails, and the result is stored as the domain's last check.

Nothing in DNS is changed, so this is safe to repeat. DNS changes can take a while
to propagate; a fail shortly after creating a record may clear on its own.

Exits 0 whatever the verdict; read the summary field to branch on it.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			res, err := a.Client.VerifyDomain(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			if a.DryRun() || a.Out.Format() != output.Table || res.Audit == nil {
				return a.emitMutation(output.Result{Data: res})
			}
			return a.emitMutation(output.Result{
				Data:    res.Audit.Checks,
				Columns: auditCheckColumns(),
				Summary: fmt.Sprintf("%s: %s (%s)", res.Domain.Hostname,
					res.Audit.Summary, auditTally(res.Audit.Checks)),
				Empty: "no checks were run",
			})
		},
	}
}

func domainProvision(a *App) *cobra.Command {
	var overwrite, confirmEnv bool
	c := &cobra.Command{
		Use:   "provision <id-or-hostname>",
		Short: "Configure Cloudflare for a domain",
		Long: strings.TrimSpace(`
Have the deployment configure Cloudflare for the domain: find the zone, enable Email
Routing, point the catch-all rule at this Worker, and set up sending with its DNS
records. Each step reports ok, skipped, warn or error.

Needs CF_API_TOKEN on the deployment. Without it this exits 5 with code
CLOUDFLARE_NOT_CONFIGURED and lists the steps to do by hand.

Any existing catch-all rule, including a disabled one, is left alone unless
--overwrite-catch-all is given. With the catch-all off Cloudflare bounces mail to
unknown addresses; turning it on sends that mail to this Worker, which drops it
unless the domain has a catch-all mailbox. So overwriting needs --force rather
than --yes.

A domain from DOMAINS/ZONES is already live, so provisioning it also needs
--confirm-env-domain.`),
		Example: exampleBlock(
			"cloudmail domain provision example.com --yes",
			"cloudmail domain provision example.com --overwrite-catch-all --force",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			prompt := fmt.Sprintf("change Cloudflare DNS and Email Routing for %s", args[0])
			if overwrite {
				prompt += ", replacing its existing catch-all rule"
			}
			if err := a.Confirm(prompt, overwrite); err != nil {
				return err
			}
			res, err := a.Client.ProvisionDomain(a.Ctx(c), args[0], api.ProvisionOptions{
				OverwriteCatchAll: overwrite,
				ConfirmEnvDomain:  confirmEnv,
			})
			if err != nil {
				return err
			}
			if a.DryRun() || a.Out.Format() != output.Table || res.Provision == nil {
				return a.emitMutation(output.Result{Data: res})
			}
			if !res.Provision.OK {
				a.Out.Warn("provisioning did not complete; see the steps marked error or warn")
			}
			return a.emitMutation(output.Result{
				Data:    res.Provision.Steps,
				Columns: provisionStepColumns(),
				Summary: fmt.Sprintf("%s: provision %s -- check DNS with `cloudmail domain verify %s`",
					res.Domain.Hostname, okWord(res.Provision.OK), res.Domain.Hostname),
				Empty: "no steps were run",
			})
		},
	}
	c.Flags().BoolVar(&overwrite, "overwrite-catch-all", false,
		"replace an existing catch-all routing rule (needs --force)")
	c.Flags().BoolVar(&confirmEnv, "confirm-env-domain", false,
		"confirm provisioning a domain that comes from DOMAINS/ZONES")
	return c
}

func domainDelete(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "delete <id-or-hostname>",
		Short: "Remove a domain",
		Long: strings.TrimSpace(`
Remove a domain from this deployment. Administrator-only.

The server refuses (exit 5) while any mailbox still lives on the domain, and while
the domain is listed in the deployment's DOMAINS configuration. Cloudflare DNS and
Email Routing are not changed.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf("remove domain %s", args[0]), false); err != nil {
				return err
			}
			res, err := a.Client.DeleteDomain(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{
				Data:    res,
				Summary: fmt.Sprintf("removed %s", args[0]),
			})
		},
	}
}

// ── mailbox aliases ────────────────────────────────────────────────

func mailboxAliases(a *App) *cobra.Command {
	c := &cobra.Command{
		Use:   "aliases [mailbox]",
		Short: "List the extra addresses a mailbox can send as",
		Long: strings.TrimSpace(`
Show a mailbox's aliases: additional addresses it may use as From when sending,
replying or forwarding.

With no argument the configured default mailbox is used. Change the list with
` + "`cloudmail mailbox aliases set`" + `.`),
		Example: exampleBlock(
			"cloudmail mailbox aliases hello@example.com",
			"cloudmail mailbox aliases set hello@example.com hi@example.com team@example.com",
		),
		Args: cobra.MaximumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb := a.Cfg.Mailbox
			if len(args) == 1 {
				mb = args[0]
			}
			aliases, err := a.Client.MailboxAliases(a.Ctx(c), mb)
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    map[string]any{"mailbox": mb, "aliases": aliases},
				Rows:    aliasRows(aliases),
				Columns: aliasColumns(),
				Summary: fmt.Sprintf("%d alias(es) on %s", len(aliases), mb),
				Empty:   "no aliases -- add some with `cloudmail mailbox aliases set`",
			})
		},
	}
	c.AddCommand(mailboxAliasesSet(a))
	return c
}

func mailboxAliasesSet(a *App) *cobra.Command {
	var clear bool
	c := &cobra.Command{
		Use:   "set <mailbox> [alias...]",
		Short: "Replace a mailbox's aliases",
		Long: strings.TrimSpace(`
Replace the mailbox's alias list with the addresses given. Administrator-only.

This is a whole-list write: an alias you leave out is removed. To keep the current
ones, read them with ` + "`cloudmail mailbox aliases <mailbox>`" + ` and pass them back
along with the new one. Pass --clear and no addresses to remove them all.`),
		Example: exampleBlock(
			"cloudmail mailbox aliases set hello@example.com hi@example.com team@example.com",
			"cloudmail mailbox aliases set hello@example.com --clear",
		),
		Args: cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, aliases := args[0], args[1:]
			if len(aliases) == 0 && !clear {
				return fail.Usagef("no aliases given").
					WithRemediation("name the addresses to keep, or pass --clear to remove every alias")
			}
			if len(aliases) > 0 && clear {
				return fail.Usagef("--clear was given along with aliases").
					WithRemediation("use one or the other")
			}
			got, err := a.Client.SetMailboxAliases(a.Ctx(c), mb, aliases)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{
				Data:    map[string]any{"mailbox": mb, "aliases": got},
				Rows:    aliasRows(got),
				Columns: aliasColumns(),
				Summary: fmt.Sprintf("%s now has %d alias(es)", mb, len(got)),
				Empty:   "no aliases",
			})
		},
	}
	c.Flags().BoolVar(&clear, "clear", false, "remove every alias")
	return c
}

// ── rendering ──────────────────────────────────────────────────────

// section prints a titled sub-table under a record, for the multi-part `get`.
func (a *App) section(title string, r output.Result) error {
	out := a.Out.Out()
	fmt.Fprintln(out)
	fmt.Fprintln(out, a.Out.Bold(title))
	return a.emit(r)
}

func domainColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 28},
		{Header: "hostname", Field: "hostname", Truncate: 32},
		{Header: "status", Field: "status"},
		{Header: "routing", Field: "routingStatus"},
		{Header: "sending", Field: "sendingStatus"},
		{Header: "catch-all", Field: "catchAllMailbox", Truncate: 30},
		{Header: "mailboxes", Field: "mailboxCount", Right: true},
		{Header: "source", Field: "source"},
	}
}

// domainDetailColumns orders the record view and formats its timestamps.
func domainDetailColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id"},
		{Header: "hostname", Field: "hostname"},
		{Header: "name", Field: "displayName"},
		{Header: "status", Field: "status"},
		{Header: "routing", Field: "routingStatus"},
		{Header: "sending", Field: "sendingStatus"},
		{Header: "catch-all", Field: "catchAllMailbox"},
		{Header: "mailboxes", Field: "mailboxCount"},
		{Header: "source", Field: "source"},
		{Header: "zone", Field: "zoneId"},
		{Header: "error", Field: "lastError"},
		{Header: "checked", Field: "lastCheckedAt", Value: epochField("lastCheckedAt")},
		{Header: "created", Field: "createdAt", Value: epochField("createdAt")},
		{Header: "updated", Field: "updatedAt", Value: epochField("updatedAt")},
	}
}

func dnsRecordColumns() []output.Column {
	return []output.Column{
		{Header: "purpose", Field: "purpose"},
		{Header: "type", Field: "type"},
		{Header: "name", Field: "name", Truncate: 36},
		{Header: "priority", Field: "priority", Right: true},
		{Header: "value", Field: "value", Truncate: 60},
		{Header: "note", Field: "note", Truncate: 40},
	}
}

func auditCheckColumns() []output.Column {
	return []output.Column{
		{Header: "status", Field: "status", Value: func(r map[string]any) string {
			return strings.ToUpper(output.Stringify(r["status"]))
		}},
		{Header: "check", Field: "label", Truncate: 28},
		{Header: "type", Field: "type"},
		{Header: "name", Field: "name", Truncate: 32},
		{Header: "message", Field: "message", Truncate: 60},
	}
}

func provisionStepColumns() []output.Column {
	return []output.Column{
		{Header: "step", Field: "step"},
		{Header: "status", Field: "status", Value: func(r map[string]any) string {
			return strings.ToUpper(output.Stringify(r["status"]))
		}},
		{Header: "detail", Field: "detail", Truncate: 80},
	}
}

func aliasColumns() []output.Column {
	return []output.Column{{Header: "alias", Field: "alias"}}
}

// aliasRows turns the API's string list into rows a table can render, without
// changing the JSON, which stays the server's own {aliases: [...]} shape.
func aliasRows(aliases []string) []map[string]string {
	rows := make([]map[string]string, len(aliases))
	for i, s := range aliases {
		rows[i] = map[string]string{"alias": s}
	}
	return rows
}

func auditTally(checks []api.AuditCheck) string {
	var pass, warn, failed int
	for _, c := range checks {
		switch c.Status {
		case "pass":
			pass++
		case "warn":
			warn++
		case "fail":
			failed++
		}
	}
	return fmt.Sprintf("%d pass, %d warn, %d fail", pass, warn, failed)
}

func okWord(ok bool) string {
	if ok {
		return "ok"
	}
	return "incomplete"
}

// epochField renders an epoch-milliseconds field as local time.
func epochField(field string) func(map[string]any) string {
	return func(r map[string]any) string {
		v, ok := r[field].(float64)
		if !ok || v <= 0 {
			return ""
		}
		return formatEpochMS(int64(v))
	}
}

func formatEpochMS(ms int64) string {
	if ms <= 0 {
		return "never"
	}
	return time.UnixMilli(ms).Local().Format("2006-01-02 15:04")
}
