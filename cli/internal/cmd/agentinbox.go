package cmd

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

func newAgentInboxCommand(a *App) *cobra.Command {
	c := group("agent-inbox", "Mailboxes minted for automated agents", `
An agent inbox is a real mailbox created for one agent, with an API token that can
only reach that mailbox, a send policy and an optional expiry.

  --send-mode draft_only   the agent reads and writes drafts; it cannot send
  --send-mode approve      the agent's sends wait in Pending approval for a person (cloudmail approval)
  --send-mode auto         the agent sends on its own (its token gets mail:send:auto)

--allow is optional. Without it the inbox may send to anyone. With it, those
recipients are a hard limit in every mode: anyone else is refused, never held.

When it expires, or you delete it, its token is revoked, its webhook removed, its
mail archived to storage as an mbox file and the mailbox deleted. Administrators
only; an API token needs the mailboxes:manage scope.

By default an agent inbox may send to and receive from anyone. Add --allow only
when you specifically want to restrict who it may send to; anyone else is then
refused (never held). Change it later with `+"`agent-inbox update`"+`.

Cloudflare Email Routing is never changed. If the domain's catch-all does not
already deliver to the Worker, create prints a warning saying what to add.`,
		"cloudmail agent-inbox create --domain example.com --local-part support-bot --purpose \"Support replies\" --send-mode auto",
		"cloudmail agent-inbox create --domain example.com --purpose \"Invoice triage\" --send-mode draft_only --ttl-hours 24",
		"# Optional: restrict who it may send to",
		"cloudmail agent-inbox create --domain example.com --local-part billing-bot --send-mode auto --allow @partner.com",
		"cloudmail agent-inbox list",
		"cloudmail agent-inbox delete agent-abc123@example.com",
	)

	list := &cobra.Command{
		Use:   "list",
		Short: "List agent inboxes and their time left",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			items, err := a.Client.ListAgentInboxes(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:      items,
				Columns:   agentInboxColumns(),
				Summary:   fmt.Sprintf("%d agent inbox(es)", len(items)),
				Untrusted: []string{"purpose"},
				Empty:     "no agent inboxes yet -- try `cloudmail agent-inbox create`",
			})
		},
	}

	get := &cobra.Command{
		Use:   "get <address>",
		Short: "Show one agent inbox",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			item, err := a.Client.GetAgentInbox(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: item, Untrusted: []string{"purpose"}})
		},
	}

	var (
		in       api.AgentInboxInput
		ttlHours float64
	)
	create := &cobra.Command{
		Use:   "create",
		Short: "Create an agent inbox and print its token",
		Long: strings.TrimSpace(`
Create a mailbox for an agent. Prints the address, the agent's API token (shown
once: give it to the agent and nowhere else), its policy and, with --webhook-url,
the webhook signing secret (also shown once).

Without --local-part the address is agent-<6 random characters>@<domain>.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			if c.Flags().Changed("ttl-hours") {
				in.TTLHours = &ttlHours
			}
			res, err := a.Client.CreateAgentInbox(a.Ctx(c), in)
			if err != nil {
				return err
			}
			if !a.DryRun() {
				for _, w := range res.Warnings {
					a.Out.Warn("%s", w)
				}
			}
			summary := ""
			if res.Token.Secret != nil {
				summary = "store the token now; it is not shown again"
			}
			return a.emitMutation(output.Result{Data: res, Summary: summary})
		},
	}
	f := create.Flags()
	f.StringVar(&in.Domain, "domain", "", "a domain this deployment serves")
	f.StringVar(&in.LocalPart, "local-part", "", "the part before @; omit for agent-<random>")
	f.StringVar(&in.Purpose, "purpose", "", "what the agent is for, shown to admins")
	f.StringVar(&in.SendMode, "send-mode", "draft_only", "one of: "+strings.Join(api.AgentSendModes, ", "))
	f.Float64Var(&ttlHours, "ttl-hours", 0, "hours until it is archived and deleted (max 2160); omit for no expiry")
	f.StringArrayVar(&in.AllowedRecipients, "allow", nil, "OPTIONAL restriction: only these addresses or @domains may be sent to (repeatable). Default: no restriction, sends to anyone")
	f.StringVar(&in.WebhookURL, "webhook-url", "", "https:// URL to receive every event for this mailbox")
	f.StringVar(&in.DisplayName, "display-name", "", "from name for its mail")
	_ = create.MarkFlagRequired("domain")
	_ = create.MarkFlagRequired("purpose")

	del := &cobra.Command{
		Use:     "delete <address>",
		Aliases: []string{"revoke"},
		Short:   "End an agent inbox now",
		Long:    "Revoke its token, remove its webhook, archive its mail to storage as mbox and delete the mailbox.",
		Args:    cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf("revoke and delete agent inbox %s (mail is archived first)", args[0]), true); err != nil {
				return err
			}
			res, err := a.Client.DeleteAgentInbox(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}

	var updAllow []string
	var updAnyone bool
	upd := &cobra.Command{
		Use:   "update <address>",
		Short: "Change who an agent inbox may send to",
		Long: strings.TrimSpace(`
Change or remove an agent inbox's optional recipient restriction.

By default an agent inbox may send to anyone. Use --allow only when you
specifically want to limit it to some addresses or @domains; anyone else is
then refused (never held for approval). Use --anyone to remove a restriction.`),
		Example: exampleBlock(
			"cloudmail agent-inbox update support-bot@example.com --anyone",
			"cloudmail agent-inbox update billing-bot@example.com --allow @partner.example --allow ap@vendor.example",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if updAnyone == (len(updAllow) > 0) {
				return fail.Usagef("give exactly one of --anyone or --allow; see `cloudmail agent-inbox update --help`")
			}
			what := "let " + args[0] + " send to anyone"
			var allowed []string
			if !updAnyone {
				allowed = updAllow
				what = fmt.Sprintf("restrict %s to %s; anyone else is refused", args[0], strings.Join(updAllow, ", "))
			}
			if err := a.Confirm(what, false); err != nil {
				return err
			}
			res, err := a.Client.UpdateAgentInbox(a.Ctx(c), args[0], allowed)
			if err != nil {
				return err
			}
			if len(res.AllowedRecipients) == 0 {
				a.Out.Info("recipients: anyone (no restriction)")
			} else {
				a.Out.Info("recipients: restricted to %s; others are refused", strings.Join(res.AllowedRecipients, ", "))
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
	upd.Flags().StringArrayVar(&updAllow, "allow", nil, "OPTIONAL restriction: only these addresses or @domains may be sent to (repeatable)")
	upd.Flags().BoolVar(&updAnyone, "anyone", false, "remove the restriction: send to anyone (the default)")

	c.AddCommand(list, get, create, upd, del)
	return c
}

// countdown renders time left the way the settings screen does.
func countdown(ms int64) string {
	if ms <= 0 {
		return "expired"
	}
	d := time.Duration(ms) * time.Millisecond
	days := int(d.Hours()) / 24
	hours := int(d.Hours()) % 24
	mins := int(d.Minutes()) % 60
	switch {
	case days > 0:
		return fmt.Sprintf("%dd %dh", days, hours)
	case hours > 0:
		return fmt.Sprintf("%dh %dm", hours, mins)
	case mins > 0:
		return fmt.Sprintf("%dm", mins)
	}
	return "1m"
}

func agentInboxColumns() []output.Column {
	return []output.Column{
		{Header: "address", Field: "address", Truncate: 40},
		{Header: "mode", Field: "send_mode"},
		{Header: "left", Field: "expires_in_ms", Value: func(r map[string]any) string {
			v, ok := r["expires_in_ms"].(json.Number)
			if ok {
				n, _ := v.Int64()
				return countdown(n)
			}
			if f, ok := r["expires_in_ms"].(float64); ok {
				return countdown(int64(f))
			}
			return "never"
		}, Right: true},
		{Header: "allowed", Field: "allowed_recipients", Value: func(r map[string]any) string {
			list, ok := r["allowed_recipients"].([]any)
			if !ok || list == nil {
				return "anyone"
			}
			parts := make([]string, 0, len(list))
			for _, e := range list {
				parts = append(parts, output.Stringify(e))
			}
			return strings.Join(parts, ",")
		}, Truncate: 32},
		{Header: "purpose", Field: "purpose", Truncate: 40},
	}
}

func newEventsCommand(a *App) *cobra.Command {
	c := group("events", "The realtime event stream", `
Events are the same JSON payloads webhooks receive (message.received, message.sent,
message.delivery_failed, message.bounced, message.opened, message.clicked), pushed
over a WebSocket as they happen. Only mailboxes you can read are delivered, and the
token needs mail:read. Events are kept for 24 hours; --since <id> replays what you
missed.`,
		"cloudmail events tail --mailbox support@example.com",
		"cloudmail events tail --event message.received --output ndjson",
		"cloudmail events tail --since 1042",
	)

	var (
		mailboxes, events []string
		since             int64
		reconnect         bool
	)
	tail := &cobra.Command{
		Use:   "tail",
		Short: "Print events as they happen",
		Long: strings.TrimSpace(`
Connect to the event stream and print each event until interrupted. With
--output json or ndjson each line is {"id": N, "event": <webhook payload>}.
With --reconnect (default) a dropped connection resumes from the last id seen.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			ctx := a.Ctx(c)
			opts := api.StreamOptions{Mailboxes: mailboxes, Events: events}
			if c.Flags().Changed("since") {
				s := since
				opts.Since = &s
			}
			machine := a.Out.Format() == output.JSON || a.Out.Format() == output.NDJSON
			print := func(m api.StreamMessage) error {
				if m.Type != "event" {
					if m.Type == "hello" || m.Type == "pong" {
						return nil
					}
					a.Out.Info("%s", api.DescribeStreamMessage(m))
					return nil
				}
				if machine {
					line, _ := json.Marshal(map[string]any{"id": m.ID, "event": m.Event})
					_, err := fmt.Fprintln(a.Out.Out(), string(line))
					return err
				}
				var ev struct {
					Type    string `json:"type"`
					Mailbox string `json:"mailbox"`
					Data    struct {
						Subject string `json:"subject"`
						From    string `json:"from"`
					} `json:"data"`
				}
				_ = json.Unmarshal(m.Event, &ev)
				_, err := fmt.Fprintf(a.Out.Out(), "%d\t%s\t%s\t%s\t%s\n", m.ID, ev.Type, ev.Mailbox, ev.Data.From, ev.Data.Subject)
				return err
			}
			backoff := time.Second
			for {
				last, err := a.Client.Stream(ctx, opts, print)
				if ctx.Err() != nil || !reconnect {
					return err
				}
				// Retrying cannot fix a bad credential, a missing scope or a bad filter.
				if fe := fail.AsError(err); fe != nil {
					switch fe.ExitCode() {
					case fail.Usage, fail.Unauthenticated, fail.Denied:
						return err
					}
				}
				if last > 0 {
					opts.Since = &last
				}
				if err != nil {
					a.Out.Warn("%v; reconnecting in %s", err, backoff)
				}
				select {
				case <-ctx.Done():
					return nil
				case <-time.After(backoff):
				}
				if backoff < 30*time.Second {
					backoff *= 2
				}
			}
		},
	}
	tf := tail.Flags()
	tf.StringArrayVar(&mailboxes, "mailbox", nil, "only this mailbox (repeatable); default every mailbox you can read")
	tf.StringArrayVar(&events, "event", nil, "only this event type (repeatable): "+strings.Join(api.WebhookEvents, ", "))
	tf.Int64Var(&since, "since", 0, "replay events after this id (kept 24 hours)")
	tf.BoolVar(&reconnect, "reconnect", true, "resume automatically when the connection drops")

	c.AddCommand(tail)
	return c
}
