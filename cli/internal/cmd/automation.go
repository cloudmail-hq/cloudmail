package cmd

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

// ── schedule ───────────────────────────────────────────────────────

func newScheduleCommand(a *App) *cobra.Command {
	c := group("schedule", "Queue mail to go out later, and recall it", `
Messages waiting to be sent.

Every ordinary send passes through this queue for roughly thirty seconds so that it
can be undone, which means a message you just sent will briefly appear in
`+"`schedule list`"+` -- and can be stopped with `+"`schedule cancel`"+` during
that window. That is the recall mechanism; after it, mail is gone.`,
		"cloudmail schedule list",
		"cloudmail schedule create --to bob@example.com --subject Reminder --text 'Ping' --in 4h",
		"cloudmail schedule cancel <message-id>",
	)
	c.AddCommand(scheduleList(a), scheduleCreate(a), scheduleCancel(a), scheduleSendNow(a))
	return c
}

func scheduleList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List messages waiting to be sent",
		Long: strings.TrimSpace(`
Show queued messages and when each leaves.

A message that appears here with a send time seconds away is one you just sent,
sitting in the undo window.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			items, err := a.Client.ListScheduled(a.Ctx(c), mb)
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:      items,
				Columns:   scheduledColumns(),
				Summary:   fmt.Sprintf("%d queued", len(items)),
				Untrusted: []string{"subject", "recipient", "last_error"},
				Empty:     "nothing queued",
			})
		},
	}
}

func scheduleCreate(a *App) *cobra.Command {
	cf := &composeFlags{}
	var (
		at, in            string
		replyTo, mode     string
		supersedesDraftID string
	)
	c := &cobra.Command{
		Use:   "create (--at <time> | --in <duration>)",
		Short: "Queue a message for later",
		Long: strings.TrimSpace(`
Queue a message to be sent at a chosen time. Give exactly one of --at (absolute) or
--in (a delay from now). The maximum delay is ninety days.

With --reply-to and --threaded-mode the queued message becomes a scheduled reply or
forward of an existing message rather than a fresh one.`),
		Example: exampleBlock(
			"cloudmail schedule create --to bob@example.com --subject 'Reminder' \\",
			"    --text 'As discussed.' --in 4h",
			"",
			"cloudmail schedule create --to a@x.com --subject Monday --text 'Morning' \\",
			"    --at '2026-09-01 09:00'",
			"",
			"# A reply, queued",
			"cloudmail schedule create --reply-to <message-id> --threaded-mode reply \\",
			"    --to alice@example.com --subject 'Re: Report' --text 'Tomorrow.' --in 2h",
		),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			req, err := cf.build(mb)
			if err != nil {
				return err
			}

			opt := api.ScheduleOptions{
				ReplyToEmailID:    replyTo,
				ThreadedMode:      mode,
				SupersedesDraftID: supersedesDraftID,
			}
			switch {
			case at != "":
				when, err := parseWhen(at)
				if err != nil {
					return err
				}
				opt.SendAt = when
			case in != "":
				secs, err := parseDelaySeconds(in)
				if err != nil {
					return err
				}
				opt.DelaySeconds = secs
			}

			res, err := a.Client.Schedule(a.Ctx(c), mb, req, opt)
			if err != nil {
				return err
			}
			return a.emitSend(res, output.Result{}, nil)
		},
	}
	cf.register(c, true)
	f := c.Flags()
	f.StringVar(&at, "at", "", "absolute send time, e.g. 2026-09-01T09:00:00Z")
	f.StringVar(&in, "in", "", "delay from now, e.g. 4h or 2d (max 90d)")
	f.StringVar(&replyTo, "reply-to", "", "message this should reply to or forward")
	f.StringVar(&mode, "threaded-mode", "", "reply or forward (needs --reply-to)")
	f.StringVar(&supersedesDraftID, "from-draft", "",
		"draft to remove once this is queued")
	c.MarkFlagsMutuallyExclusive("at", "in")
	c.MarkFlagsOneRequired("at", "in")
	return c
}

func scheduleCancel(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "cancel <message-id>...",
		Short: "Stop a queued message from being sent",
		Long: strings.TrimSpace(`
Cancel a queued message. This is also how a message you just sent is recalled, within
the roughly thirty-second window before it leaves.

The cancellation itself cannot be undone.`),
		Args: cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			for _, id := range args {
				if _, err := a.Client.CancelScheduled(a.Ctx(c), mb, id); err != nil {
					return err
				}
			}
			return a.emitMutation(output.Result{
				Data:    map[string]any{"status": "cancelled", "ids": args, "dry_run": a.DryRun()},
				Summary: fmt.Sprintf("%d message(s) cancelled", len(args)),
			})
		},
	}
}

func scheduleSendNow(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "send-now <message-id>",
		Short: "Send a queued message immediately",
		Long: strings.TrimSpace(`
Send a queued message straight away, skipping the remaining delay.

Once it has left it cannot be recalled, so this forfeits the undo window rather than
shortening it.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			if err := a.Confirm(fmt.Sprintf(
				"send %s now, giving up the chance to recall it", args[0]), true); err != nil {
				return err
			}
			res, err := a.Client.SendScheduledNow(a.Ctx(c), mb, args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
}

// ── rules ──────────────────────────────────────────────────────────

func newRuleCommand(a *App) *cobra.Command {
	c := group("rule", "Sort inbound mail automatically", `
Rules act on mail as it arrives: file it, label it, flag it, deprioritise it or bin
it before you ever see it. They apply to new mail only, never retroactively.

Order matters. Rules run top to bottom, and an earlier rule can pre-empt a later one
by binning or filing the message. Change the order with `+"`rule reorder`"+`.

Conditions are written field:operator:value --

  fields     `+strings.Join(api.RuleFields, "  ")+`
  operators  `+strings.Join(api.RuleOperators, "  ")+`

Actions are written type[:value] --

  `+strings.Join(api.RuleActions, "  ")+`

is_true takes no value; it tests a boolean field such as has_attachment.`,
		`cloudmail rule create --name 'File receipts' --if subject:contains:receipt --then move_to_folder:archive`,
		"cloudmail rule list",
	)
	c.AddCommand(ruleList(a), ruleCreate(a), ruleUpdate(a), ruleDelete(a), ruleReorder(a))
	return c
}

func ruleList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List inbound rules in the order they run",
		Long:  "Show the rules, top to bottom, in the order they are applied.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			rules, err := a.Client.ListRules(a.Ctx(c), mb)
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    rules,
				Columns: ruleColumns(),
				Summary: fmt.Sprintf("%d rule(s), applied in this order", len(rules)),
				Empty:   "no rules yet",
			})
		},
	}
}

// ruleSpecFlags parses the --if and --then shorthand.
type ruleSpecFlags struct {
	name      string
	matchType string
	ifSpecs   []string
	thenSpecs []string
	enabled   bool
	disabled  bool
}

func (rf *ruleSpecFlags) register(c *cobra.Command) {
	f := c.Flags()
	f.StringVar(&rf.name, "name", "", "a name for the rule")
	f.StringVar(&rf.matchType, "match", "", "all (every condition) or any (at least one)")
	f.StringArrayVar(&rf.ifSpecs, "if", nil,
		"condition as field:operator:value (repeatable)")
	f.StringArrayVar(&rf.thenSpecs, "then", nil,
		"action as type[:value] (repeatable)")
	f.BoolVar(&rf.enabled, "enable", false, "enable the rule")
	f.BoolVar(&rf.disabled, "disable", false, "disable the rule without deleting it")
	f.SortFlags = false
	c.MarkFlagsMutuallyExclusive("enable", "disable")
}

func (rf *ruleSpecFlags) build(c *cobra.Command) (api.RuleInput, error) {
	in := api.RuleInput{Name: rf.name, MatchType: rf.matchType}

	for _, spec := range rf.ifSpecs {
		cond, err := parseCondition(spec)
		if err != nil {
			return in, err
		}
		in.Conditions = append(in.Conditions, cond)
	}
	for _, spec := range rf.thenSpecs {
		act, err := parseAction(spec)
		if err != nil {
			return in, err
		}
		in.Actions = append(in.Actions, act)
	}
	if c.Flags().Changed("enable") {
		v := true
		in.Enabled = &v
	}
	if c.Flags().Changed("disable") {
		v := false
		in.Enabled = &v
	}
	return in, nil
}

// parseCondition reads field:operator:value.
//
// The value is everything after the second colon, not the third field of a split:
// a condition like subject:contains:Re: Q3 has a colon in its value, and splitting
// on every colon would silently truncate it.
func parseCondition(spec string) (api.RuleCondition, error) {
	field, rest, ok := strings.Cut(spec, ":")
	if !ok {
		return api.RuleCondition{}, fail.Usagef("cannot read condition %q", spec).
			WithRemediation("write it as field:operator:value, "+
				"e.g. subject:contains:invoice (fields: %s)",
				strings.Join(api.RuleFields, ", "))
	}
	operator, value, hasValue := strings.Cut(rest, ":")
	cond := api.RuleCondition{
		Field:    strings.TrimSpace(field),
		Operator: strings.TrimSpace(operator),
	}
	if hasValue {
		cond.Value = value
	}
	if cond.Operator == "" {
		return cond, fail.Usagef("condition %q names no operator", spec).
			WithRemediation("operators: %s", strings.Join(api.RuleOperators, ", "))
	}
	return cond, nil
}

// parseAction reads type[:value].
func parseAction(spec string) (api.RuleAction, error) {
	t, value, _ := strings.Cut(spec, ":")
	act := api.RuleAction{Type: strings.TrimSpace(t), Value: value}
	if act.Type == "" {
		return act, fail.Usagef("cannot read action %q", spec).
			WithRemediation("write it as type[:value], "+
				"e.g. move_to_folder:archive (types: %s)",
				strings.Join(api.RuleActions, ", "))
	}
	return act, nil
}

func ruleCreate(a *App) *cobra.Command {
	rf := &ruleSpecFlags{}
	c := &cobra.Command{
		Use:   "create",
		Short: "Create an inbound rule",
		Long: strings.TrimSpace(`
Create a rule. It needs at least one condition and one action, and applies to mail
arriving from now on -- existing messages are not reprocessed.`),
		Example: exampleBlock(
			"# File anything from a vendor",
			"cloudmail rule create --name 'Vendor mail' \\",
			"    --if from:domain_is:vendor.example --then move_to_folder:archive",
			"",
			"# Label and flag invoices with an attachment",
			"cloudmail rule create --name Invoices --match all \\",
			"    --if subject:contains:invoice --if has_attachment:is_true \\",
			"    --then apply_label:<label-id> --then star",
			"",
			"# Bin a nuisance sender",
			"cloudmail rule create --name Spammer --if from:contains:noise@example --then trash",
		),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			in, err := rf.build(c)
			if err != nil {
				return err
			}
			rule, err := a.Client.CreateRule(a.Ctx(c), mb, in)
			if err != nil {
				return err
			}
			if !a.DryRun() {
				a.Out.Info("rules run in order; check the order with `cloudmail rule list`")
			}
			return a.emitMutation(output.Result{Data: rule, Columns: ruleColumns()})
		},
	}
	rf.register(c)
	return c
}

func ruleUpdate(a *App) *cobra.Command {
	rf := &ruleSpecFlags{}
	c := &cobra.Command{
		Use:   "update <rule-id>",
		Short: "Change a rule",
		Long: strings.TrimSpace(`
Change a rule.

Conditions and actions are replaced wholesale when given: passing one --if replaces
every condition the rule had. To disable a rule rather than change it, use --disable.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			in, err := rf.build(c)
			if err != nil {
				return err
			}
			rule, err := a.Client.UpdateRule(a.Ctx(c), mb, args[0], in)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: rule, Columns: ruleColumns()})
		},
	}
	rf.register(c)
	return c
}

func ruleDelete(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "delete <rule-id>...",
		Short: "Delete a rule",
		Long: strings.TrimSpace(`
Delete a rule. To stop a rule acting without losing how it was written, prefer
` + "`cloudmail rule update <id> --disable`" + `.`),
		Args: cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			for _, id := range args {
				if _, err := a.Client.DeleteRule(a.Ctx(c), mb, id); err != nil {
					return err
				}
			}
			return a.emitMutation(output.Result{
				Data:    map[string]any{"status": "deleted", "ids": args, "dry_run": a.DryRun()},
				Summary: fmt.Sprintf("%d rule(s) deleted", len(args)),
			})
		},
	}
}

func ruleReorder(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "reorder <rule-id>...",
		Short: "Set the order rules run in",
		Long: strings.TrimSpace(`
Set the order rules are applied in. List every rule id in the order you want.

Order is behaviour, not presentation: a rule that bins a message stops later rules
from seeing it at all.`),
		Example: exampleBlock(
			"cloudmail rule list --output json --select id",
			"cloudmail rule reorder <id-first> <id-second> <id-third>",
		),
		Args: cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			res, err := a.Client.ReorderRules(a.Ctx(c), mb, args)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
}

// ── senders ────────────────────────────────────────────────────────

func newSenderCommand(a *App) *cobra.Command {
	c := group("sender", "Block or allow senders", `
Two lists of patterns. A blocked sender's mail is refused; an allowed sender's mail
skips spam filtering.

An explicit block wins over an allow, so listing the same pattern on both leaves it
blocked. A pattern can be a full address or a domain.`,
		"cloudmail sender list blocked",
		"cloudmail sender add blocked noise@example.com --reason 'newsletter spam'",
		"cloudmail sender add allowed partner.example",
	)

	list := &cobra.Command{
		Use:       "list <blocked|allowed>",
		Short:     "Show a sender list",
		Long:      "List the patterns on the blocked or allowed sender list.",
		Args:      cobra.ExactArgs(1),
		ValidArgs: []string{"blocked", "allowed"},
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			items, err := a.Client.ListSenders(a.Ctx(c), mb, args[0])
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:      items,
				Columns:   senderColumns(),
				Summary:   fmt.Sprintf("%d %s pattern(s)", len(items), args[0]),
				Untrusted: []string{"pattern", "reason"},
				Empty:     fmt.Sprintf("nothing on the %s list", args[0]),
			})
		},
	}

	var reason string
	add := &cobra.Command{
		Use:   "add <blocked|allowed> <pattern>",
		Short: "Add a pattern to a sender list",
		Long: strings.TrimSpace(`
Add an address or a domain to the blocked or allowed list. At least three characters.

Applies to mail arriving from now on; messages already delivered are unaffected.`),
		Args:      cobra.ExactArgs(2),
		ValidArgs: []string{"blocked", "allowed"},
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			res, err := a.Client.AddSender(a.Ctx(c), mb, args[0], args[1], reason)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Columns: senderColumns()})
		},
	}
	add.Flags().StringVar(&reason, "reason", "", "why, for whoever reads this later")

	remove := &cobra.Command{
		Use:       "remove <blocked|allowed> <entry-id>",
		Short:     "Remove an entry from a sender list",
		Long:      "Remove one entry. Ids come from `cloudmail sender list`.",
		Args:      cobra.ExactArgs(2),
		ValidArgs: []string{"blocked", "allowed"},
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			res, err := a.Client.RemoveSender(a.Ctx(c), mb, args[0], args[1])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}

	c.AddCommand(list, add, remove)
	return c
}

// ── signatures ─────────────────────────────────────────────────────

func newSignatureCommand(a *App) *cobra.Command {
	c := group("signature", "Manage sending signatures", `
Stored HTML signatures for the mailbox. One can be the default.

Writing signatures needs the manageSettings capability.`,
		"cloudmail signature list",
		"cloudmail signature create Work --body-file ./sig.html --default",
	)

	list := &cobra.Command{
		Use:   "list",
		Short: "List signatures",
		Long:  "Show the mailbox's signatures and which is the default.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			sigs, err := a.Client.ListSignatures(a.Ctx(c), mb)
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    sigs,
				Columns: signatureColumns(),
				Summary: fmt.Sprintf("%d signature(s)", len(sigs)),
				Empty:   "no signatures yet",
			})
		},
	}

	get := &cobra.Command{
		Use:   "default",
		Short: "Show the default signature",
		Long:  "Show the signature used when none is chosen explicitly.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			sig, err := a.Client.DefaultSignature(a.Ctx(c), mb)
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: sig})
		},
	}

	var (
		bodyHTML, bodyFile string
		isDefault          bool
	)
	create := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a signature",
		Long:  "Add a signature. The body is HTML, up to 50,000 characters.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			body, err := readBody(bodyHTML, bodyFile)
			if err != nil {
				return err
			}
			sig, err := a.Client.CreateSignature(a.Ctx(c), mb, args[0], body, isDefault)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: sig, Columns: signatureColumns()})
		},
	}
	create.Flags().StringVar(&bodyHTML, "body-html", "", "the signature as HTML")
	create.Flags().StringVar(&bodyFile, "body-file", "", "read the HTML from a file, or - for stdin")
	create.Flags().BoolVar(&isDefault, "default", false, "make this the default signature")

	var (
		upName, upHTML, upFile string
		upDefault, upNotDflt   bool
	)
	update := &cobra.Command{
		Use:   "update <signature-id>",
		Short: "Change a signature",
		Long:  "Change a signature's name, body, or default status.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			body, err := readBody(upHTML, upFile)
			if err != nil {
				return err
			}
			var dflt *bool
			if c.Flags().Changed("default") {
				dflt = &upDefault
			}
			if c.Flags().Changed("not-default") {
				v := false
				dflt = &v
			}
			sig, err := a.Client.UpdateSignature(a.Ctx(c), mb, args[0], upName, body, dflt)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: sig, Columns: signatureColumns()})
		},
	}
	update.Flags().StringVar(&upName, "name", "", "new name")
	update.Flags().StringVar(&upHTML, "body-html", "", "new HTML body")
	update.Flags().StringVar(&upFile, "body-file", "", "read the new HTML from a file")
	update.Flags().BoolVar(&upDefault, "default", false, "make this the default")
	update.Flags().BoolVar(&upNotDflt, "not-default", false, "stop this being the default")
	update.MarkFlagsMutuallyExclusive("default", "not-default")

	del := &cobra.Command{
		Use:   "delete <signature-id>",
		Short: "Delete a signature",
		Long:  "Remove a signature.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			res, err := a.Client.DeleteSignature(a.Ctx(c), mb, args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}

	c.AddCommand(list, get, create, update, del)
	return c
}

// ── templates ──────────────────────────────────────────────────────

func newTemplateCommand(a *App) *cobra.Command {
	c := group("template", "Reusable message bodies", `
Templates are shared across the whole deployment, not per mailbox. Each has a slug
that identifies it -- lowercase letters, digits and hyphens.

Sequences are built from templates, so changing a template changes what an in-flight
sequence sends, and deleting one breaks any sequence step that named it.`,
		"cloudmail template list",
		"cloudmail template create welcome --name Welcome --subject 'Hello' --body-file ./welcome.html",
	)

	list := &cobra.Command{
		Use:   "list",
		Short: "List templates",
		Long:  "Show every template in the deployment.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			items, err := a.Client.ListTemplates(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    items,
				Columns: templateColumns(),
				Summary: fmt.Sprintf("%d template(s)", len(items)),
				Empty:   "no templates yet",
			})
		},
	}

	get := &cobra.Command{
		Use:   "get <slug>",
		Short: "Show one template",
		Long:  "Show a template's subject and body.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			t, err := a.Client.GetTemplate(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: t})
		},
	}

	var name, subject, bodyHTML, bodyFile string
	create := &cobra.Command{
		Use:   "create <slug>",
		Short: "Create a template",
		Long: strings.TrimSpace(`
Create a template. The slug is its identifier and must be lowercase letters, digits
and hyphens -- it appears in sequence definitions, so pick something readable.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			body, err := readBody(bodyHTML, bodyFile)
			if err != nil {
				return err
			}
			t, err := a.Client.CreateTemplate(a.Ctx(c), api.Template{
				Slug: args[0], Name: name, Subject: subject, BodyHTML: body,
			})
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: t, Columns: templateColumns()})
		},
	}
	create.Flags().StringVar(&name, "name", "", "human-readable name")
	create.Flags().StringVar(&subject, "subject", "", "subject line")
	create.Flags().StringVar(&bodyHTML, "body-html", "", "body as HTML")
	create.Flags().StringVar(&bodyFile, "body-file", "", "read the body from a file, or - for stdin")

	var upName, upSubject, upHTML, upFile string
	update := &cobra.Command{
		Use:   "update <slug>",
		Short: "Change a template",
		Long: strings.TrimSpace(`
Change a template's name, subject or body.

Sequences already running will use the new content for steps they have not yet sent.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			body, err := readBody(upHTML, upFile)
			if err != nil {
				return err
			}
			t, err := a.Client.UpdateTemplate(a.Ctx(c), args[0], api.Template{
				Name: upName, Subject: upSubject, BodyHTML: body,
			})
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: t, Columns: templateColumns()})
		},
	}
	update.Flags().StringVar(&upName, "name", "", "new name")
	update.Flags().StringVar(&upSubject, "subject", "", "new subject")
	update.Flags().StringVar(&upHTML, "body-html", "", "new HTML body")
	update.Flags().StringVar(&upFile, "body-file", "", "read the new body from a file")

	del := &cobra.Command{
		Use:   "delete <slug>",
		Short: "Delete a template",
		Long: strings.TrimSpace(`
Delete a template.

Any sequence step naming this slug will stop working, so check
` + "`cloudmail sequence list`" + ` first.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf(
				"delete template %s -- any sequence step using it will break", args[0]),
				true); err != nil {
				return err
			}
			res, err := a.Client.DeleteTemplate(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}

	c.AddCommand(list, get, create, update, del)
	return c
}

// ── sequences ──────────────────────────────────────────────────────

func newSequenceCommand(a *App) *cobra.Command {
	c := group("sequence", "Send a series of templates on a schedule", `
A sequence is an ordered set of templates, each sent after a delay measured in hours
from enrollment. Steps are dispatched by a cron tick every five minutes, so delays are
approximate to that resolution.

Steps are written as templateSlug:delayHours.

Enrollment checks your authority over the --from address at the time you enroll,
because the dispatcher sends the mail later with no caller attached.`,
		"cloudmail sequence create Onboarding --step welcome:0 --step tips:24 --step checkin:72",
		"cloudmail sequence enroll <sequence-id> --person bob@example.com --from hello@example.com",
	)

	list := &cobra.Command{
		Use:   "list",
		Short: "List sequences",
		Long:  "Show every sequence and its steps.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			items, err := a.Client.ListSequences(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    items,
				Columns: sequenceColumns(),
				Summary: fmt.Sprintf("%d sequence(s)", len(items)),
				Empty:   "no sequences yet",
			})
		},
	}

	get := &cobra.Command{
		Use:   "get <sequence-id>",
		Short: "Show one sequence",
		Long:  "Show a sequence and its steps.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			s, err := a.Client.GetSequence(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: s})
		},
	}

	var steps []string
	create := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a sequence",
		Long: strings.TrimSpace(`
Create a sequence from a list of steps.

Each --step is templateSlug:delayHours, where the delay is measured from enrollment
rather than from the previous step. A delay of 0 sends at enrollment; the maximum is
8760 hours, which is a year. Up to fifty steps.`),
		Example: exampleBlock(
			"cloudmail sequence create Onboarding \\",
			"    --step welcome:0 --step tips:24 --step checkin:168",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			parsed, err := parseSteps(steps)
			if err != nil {
				return err
			}
			s, err := a.Client.CreateSequence(a.Ctx(c), args[0], parsed)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: s, Columns: sequenceColumns()})
		},
	}
	create.Flags().StringArrayVar(&steps, "step", nil,
		"a step as templateSlug:delayHours (repeatable)")

	var upName string
	var upSteps []string
	update := &cobra.Command{
		Use:   "update <sequence-id>",
		Short: "Change a sequence",
		Long: strings.TrimSpace(`
Change a sequence's name or steps. Passing any --step replaces every step.

People already enrolled follow the amended steps for anything not yet sent.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			parsed, err := parseSteps(upSteps)
			if err != nil {
				return err
			}
			s, err := a.Client.UpdateSequence(a.Ctx(c), args[0], upName, parsed)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: s, Columns: sequenceColumns()})
		},
	}
	update.Flags().StringVar(&upName, "name", "", "new name")
	update.Flags().StringArrayVar(&upSteps, "step", nil,
		"replace the steps; templateSlug:delayHours (repeatable)")

	del := &cobra.Command{
		Use:   "delete <sequence-id>",
		Short: "Delete a sequence",
		Long: strings.TrimSpace(`
Delete a sequence. Anyone enrolled stops receiving the steps they had not yet been
sent.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf(
				"delete sequence %s and stop the steps enrolled people have not yet received",
				args[0]), true); err != nil {
				return err
			}
			res, err := a.Client.DeleteSequence(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}

	c.AddCommand(list, get, create, update, del,
		sequenceEnroll(a), sequenceEnrollments(a), sequenceUnenroll(a))
	return c
}

// parseSteps reads templateSlug:delayHours.
func parseSteps(specs []string) ([]api.SequenceStep, error) {
	if len(specs) == 0 {
		return nil, nil
	}
	out := make([]api.SequenceStep, 0, len(specs))
	for i, spec := range specs {
		slug, delay, ok := strings.Cut(spec, ":")
		if !ok {
			return nil, fail.Usagef("cannot read step %q", spec).
				WithRemediation("write it as templateSlug:delayHours, e.g. welcome:0")
		}
		hours, err := strconv.Atoi(strings.TrimSpace(delay))
		if err != nil {
			return nil, fail.Usagef("step %q has a delay of %q, which is not a number of hours",
				slug, delay).
				WithRemediation("delays are whole hours, e.g. tips:24")
		}
		out = append(out, api.SequenceStep{
			// The order is the position on the command line, one-based, which is
			// what makes the flag order meaningful rather than incidental.
			Order:        i + 1,
			TemplateSlug: strings.TrimSpace(slug),
			DelayHours:   hours,
		})
	}
	return out, nil
}

func sequenceEnroll(a *App) *cobra.Command {
	var (
		person, personName, from string
		variables                []string
		skipSteps                []int
	)
	c := &cobra.Command{
		Use:   "enroll <sequence-id>",
		Short: "Enrol someone in a sequence",
		Long: strings.TrimSpace(`
Enrol a person, queueing the sequence's steps to be sent from --from over the coming
hours.

Your authority over --from is checked now, not later, because the cron dispatcher
sends the mail with no caller attached. A 403 here means you lack a send capability on
that address.

Enrolling the same person twice is a conflict, exit code 5.`),
		Example: exampleBlock(
			"cloudmail sequence enroll <sequence-id> \\",
			"    --person bob@example.com --person-name 'Bob' --from hello@example.com",
			"",
			"# With template variables",
			"cloudmail sequence enroll <sequence-id> --person bob@example.com \\",
			"    --from hello@example.com --var company=Acme --var plan=pro",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			vars, err := parseKeyValues(variables)
			if err != nil {
				return err
			}
			if from == "" {
				// Defaulting to the configured mailbox is the right guess: it is
				// the address the caller is already working in.
				from = a.Cfg.Mailbox
			}
			if from == "" {
				return fail.Usagef("no sending address given").
					WithRemediation("pass --from, or set a default mailbox with " +
						"`cloudmail config set mailbox you@example.com`")
			}
			res, err := a.Client.Enroll(a.Ctx(c), args[0], api.EnrollInput{
				PersonEmail: person,
				PersonName:  personName,
				FromAddress: from,
				Variables:   vars,
				SkipSteps:   skipSteps,
			})
			if err != nil {
				return err
			}
			return a.emitSend(res, output.Result{}, nil)
		},
	}
	f := c.Flags()
	f.StringVar(&person, "person", "", "the person's email address")
	f.StringVar(&personName, "person-name", "", "the person's display name")
	f.StringVar(&from, "from", "", "address to send from (default: the configured mailbox)")
	f.StringArrayVar(&variables, "var", nil, "template variable as name=value (repeatable)")
	f.IntSliceVar(&skipSteps, "skip-step", nil, "step numbers to skip")
	_ = c.MarkFlagRequired("person")
	return c
}

func sequenceEnrollments(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "enrollments <sequence-id>",
		Short: "List who is enrolled in a sequence",
		Long:  "Show everyone enrolled and how far through they are.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			data, err := a.Client.SequenceEnrollments(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: data, Empty: "nobody is enrolled"})
		},
	}
}

func sequenceUnenroll(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "unenroll <enrollment-id>",
		Short: "Remove someone from a sequence",
		Long: strings.TrimSpace(`
Remove someone from a sequence, cancelling the steps they had not yet received.

Enrollment ids come from ` + "`cloudmail sequence enrollments <sequence-id>`" + `.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			res, err := a.Client.Unenroll(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
}
