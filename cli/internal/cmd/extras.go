package cmd

// Verbs added to existing nouns for routes the CLI did not yet reach: the
// smaller AI, domain, webhook, suppression, template, product, mail, thread and
// follow-up routes. They are attached after the tree is built so each noun's
// own file stays about its core verbs.

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

// attachExtras adds the verbs to their nouns. A missing parent is a programming
// error, caught by TestEveryOperationIsMappedOrExcluded.
func attachExtras(root *cobra.Command, a *App) {
	add := func(parent string, cmds ...*cobra.Command) {
		p, _, err := root.Find(strings.Fields(parent))
		if err != nil || p == root {
			panic("attachExtras: no command " + parent)
		}
		p.AddCommand(cmds...)
	}
	add("ai", aiSettingsCommand(a), aiSemanticCommand(a), aiBriefCommand(a), aiAssistantCommand(a), aiModelsTest(a), aiRouteShow(a))
	add("ai provider", aiProviderUpdate(a), aiProviderDelete(a))
	add("thread", threadSummary(a))
	add("domain", domainUpdate(a))
	add("webhook", webhookGet(a), webhookUpdate(a), webhookRotate(a), webhookEvents(a))
	add("suppression", suppressionCheck(a))
	add("template", templateSend(a))
	add("product", productCreate(a), productDelete(a), productLogo(a), productRefresh(a), productResolve(a))
	add("mail", mailTabs(a))
	add("followup", followupGet(a))
	add("sequence", sequencePerson(a))
	add("mailbox", mailboxSemantic(a))
	add("auth", authConfig(a))
}

// ── ai ─────────────────────────────────────────────────────────────

func aiSettingsCommand(a *App) *cobra.Command {
	c := group("settings", "Instance AI summary and semantic search settings", `
show reads the settings; set changes them (administrator). Daily caps limit how
many summaries and embeddings one mailbox can use per day.`,
		"cloudmail ai settings show",
		"cloudmail ai settings set --summaries on --daily-cap 200",
	)
	show := rawCmd("show", "Show the AI settings", "", func(c *cobra.Command, _ []string) (json.RawMessage, error) {
		return a.Client.GetAISettings(a.Ctx(c))
	}, a, cobra.NoArgs)
	toggles := newOnOffFlags()
	var dailyCap, embedCap int
	set := &cobra.Command{
		Use:   "set",
		Short: "Change the AI settings",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			patch := map[string]any{}
			if err := toggles.apply(c, patch); err != nil {
				return err
			}
			if c.Flags().Changed("daily-cap") {
				patch["dailyCapPerMailbox"] = dailyCap
			}
			if c.Flags().Changed("embed-daily-cap") {
				patch["embedDailyCapPerMailbox"] = embedCap
			}
			if err := needPatch(patch, "at least one setting flag"); err != nil {
				return err
			}
			res, err := a.Client.UpdateAISettings(a.Ctx(c), patch)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "AI settings saved"})
		},
	}
	toggles.add(set, "summaries", "summaries", "thread summaries")
	toggles.add(set, "bulk-summaries", "bulkSummaries", "summaries of bulk mail")
	toggles.add(set, "bulk-one-liners", "bulkOneLiners", "one-line summaries of bulk mail")
	toggles.add(set, "semantic", "semantic", "semantic search")
	set.Flags().IntVar(&dailyCap, "daily-cap", 0, "summaries per mailbox per day")
	set.Flags().IntVar(&embedCap, "embed-daily-cap", 0, "embeddings per mailbox per day")
	c.AddCommand(show, set)
	return c
}

func aiSemanticCommand(a *App) *cobra.Command {
	return rawCmd("semantic", "Whether semantic search is available here", `
Report whether the deployment has the vector index and AI bindings semantic search
needs, and whether it is switched on. `+"`cloudmail mailbox semantic`"+` shows one
mailbox's index.`, func(c *cobra.Command, _ []string) (json.RawMessage, error) {
		return a.Client.GetSemanticAvailability(a.Ctx(c))
	}, a, cobra.NoArgs)
}

func aiRouteShow(a *App) *cobra.Command {
	return rawCmd("routing", "Show which model each AI role uses, and any problems", "Administrator-only.",
		func(c *cobra.Command, _ []string) (json.RawMessage, error) {
			return a.Client.GetAIRouting(a.Ctx(c))
		}, a, cobra.NoArgs)
}

func aiModelsTest(a *App) *cobra.Command {
	c := group("workers-ai", "Probe the built-in Workers AI models", "")
	var checks []string
	test := &cobra.Command{
		Use:   "test <model-id>",
		Short: "Run live checks against one Workers AI model",
		Long: strings.TrimSpace(`
Send small live requests to one Workers AI model: text, JSON mode, a tool call or
embeddings. The calls count against this month's usage. Exits 1 when any check
fails. Administrator-only.`),
		Example: exampleBlock("cloudmail ai workers-ai test @cf/meta/llama-3.1-8b-instruct --check text,json"),
		Args:    cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			res, err := a.Client.TestWorkersAIModel(a.Ctx(c), args[0], checks)
			if err != nil {
				return err
			}
			failed := 0
			for _, r := range res.Results {
				if !r.OK {
					failed++
				}
			}
			r := output.Result{Data: res, Rows: res.Results, Columns: aiTestColumns()}
			if a.DryRun() || failed == 0 {
				r.Summary = fmt.Sprintf("%s: %d check(s) passed", args[0], len(res.Results))
				return a.emitMutation(r)
			}
			if err := a.emit(r); err != nil {
				return err
			}
			return fail.Errf("%d of %d check(s) failed for %s", failed, len(res.Results), args[0]).
				WithRemediation("route only the roles whose needs passed, or pick another model")
		},
	}
	test.Flags().StringSliceVar(&checks, "check", nil, "checks to run, comma-separated: text, json, tools, embed")
	c.AddCommand(test)
	return c
}

func aiProviderUpdate(a *App) *cobra.Command {
	var label, baseURL string
	var enabled string
	c := &cobra.Command{
		Use:   "update <provider-id>",
		Short: "Rename a gateway, change its URL, or switch it on or off",
		Long: strings.TrimSpace(`
Change a gateway's label, base URL or enabled flag. To replace its token, remove
the gateway and add it again with --token-stdin, so a token never passes through
a flag.
` + personOnly),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			patch := map[string]any{}
			if c.Flags().Changed("label") {
				patch["label"] = label
			}
			if c.Flags().Changed("base-url") {
				patch["baseUrl"] = baseURL
			}
			if c.Flags().Changed("enabled") {
				b, err := onOff("--enabled", enabled)
				if err != nil {
					return err
				}
				patch["enabled"] = b
			}
			if err := needPatch(patch, "--label, --base-url or --enabled"); err != nil {
				return err
			}
			if _, ok := patch["baseUrl"]; ok {
				if err := a.Confirm(fmt.Sprintf("send %s's AI traffic, and its token, to %s", args[0], baseURL), false); err != nil {
					return err
				}
			}
			res, err := a.Client.UpdateAIProvider(a.Ctx(c), args[0], patch)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "saved " + args[0]})
		},
	}
	c.Flags().StringVar(&label, "label", "", "a new label")
	c.Flags().StringVar(&baseURL, "base-url", "", "a new base URL")
	c.Flags().StringVar(&enabled, "enabled", "", "on or off")
	return c
}

func aiProviderDelete(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "delete <provider-id>",
		Short: "Remove a gateway and its stored token",
		Long: strings.TrimSpace(`
Remove a gateway. The server refuses while it is the active one; run
` + "`cloudmail ai provider activate --off`" + ` first. Asks for confirmation unless
--yes is given.
` + personOnly),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf("remove AI gateway %s and its stored token", args[0]), true); err != nil {
				return err
			}
			if err := a.Client.DeleteAIProvider(a.Ctx(c), args[0]); err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: map[string]any{"status": "deleted", "id": args[0]}})
		},
	}
}

func aiAssistantCommand(a *App) *cobra.Command {
	c := group("assistant", "Your AI preferences: list one-liners and the daily brief schedule", "",
		"cloudmail ai assistant show",
		`cloudmail ai assistant set --brief on --brief-time 08:30 --brief-timezone Europe/London`,
	)
	show := rawCmd("show", "Show your AI preferences", "", func(c *cobra.Command, _ []string) (json.RawMessage, error) {
		return a.Client.GetAssistantPrefs(a.Ctx(c))
	}, a, cobra.NoArgs)
	var listSummaries, brief, briefEmail, briefTime, briefTZ string
	set := &cobra.Command{
		Use:   "set",
		Short: "Change your AI preferences",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			patch := map[string]any{}
			b := map[string]any{}
			f := c.Flags()
			if f.Changed("list-summaries") {
				v, err := onOff("--list-summaries", listSummaries)
				if err != nil {
					return err
				}
				patch["listSummaries"] = v
			}
			if f.Changed("brief") {
				v, err := onOff("--brief", brief)
				if err != nil {
					return err
				}
				b["enabled"] = v
			}
			if f.Changed("brief-email") {
				v, err := onOff("--brief-email", briefEmail)
				if err != nil {
					return err
				}
				b["email"] = v
			}
			if f.Changed("brief-time") {
				b["time"] = briefTime
			}
			if f.Changed("brief-timezone") {
				b["timeZone"] = briefTZ
			}
			if len(b) > 0 {
				patch["brief"] = b
			}
			if err := needPatch(patch, "--list-summaries, --brief, --brief-email, --brief-time or --brief-timezone"); err != nil {
				return err
			}
			res, err := a.Client.UpdateAssistantPrefs(a.Ctx(c), patch)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "preferences saved"})
		},
	}
	set.Flags().StringVar(&listSummaries, "list-summaries", "", "one-line summaries in message lists: on or off")
	set.Flags().StringVar(&brief, "brief", "", "the daily brief: on or off")
	set.Flags().StringVar(&briefEmail, "brief-email", "", "also email the brief: on or off")
	set.Flags().StringVar(&briefTime, "brief-time", "", "when to build the brief, HH:MM")
	set.Flags().StringVar(&briefTZ, "brief-timezone", "", "IANA time zone for --brief-time, e.g. Asia/Kolkata")
	c.AddCommand(show, set)
	return c
}

func aiBriefCommand(a *App) *cobra.Command {
	c := group("brief", "Your daily brief", `
The daily brief summarises what needs you across the mailboxes you can read.
generate builds it now (it does not send the email) and uses the AI budget.`,
		"cloudmail ai brief show",
		"cloudmail ai brief generate",
	)
	show := rawCmd("show", "Show your latest brief", "", func(c *cobra.Command, _ []string) (json.RawMessage, error) {
		return a.Client.GetDailyBrief(a.Ctx(c))
	}, a, cobra.NoArgs)
	generate := &cobra.Command{
		Use: "generate", Short: "Build your brief now", Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			res, err := a.Client.GenerateDailyBrief(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Untrusted: []string{"brief"}})
		},
	}
	dismiss := &cobra.Command{
		Use: "dismiss <brief-id>", Short: "Hide a brief until the next one", Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			res, err := a.Client.DismissDailyBrief(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
	show.RunE = func(c *cobra.Command, _ []string) error {
		res, err := a.Client.GetDailyBrief(a.Ctx(c))
		if err != nil {
			return err
		}
		return a.emit(output.Result{Data: res, Untrusted: []string{"brief"}})
	}
	c.AddCommand(show, generate, dismiss)
	return c
}

// ── threads ────────────────────────────────────────────────────────

func threadSummary(a *App) *cobra.Command {
	var generate, refresh bool
	c := &cobra.Command{
		Use:   "summary <thread-id>",
		Short: "A conversation's AI summary",
		Long: strings.TrimSpace(`
Show the stored summary: one line and up to three bullets, or null when there is
none. --generate builds it now; --refresh queues a rebuild that runs only if the
thread has new messages. Both use the AI budget.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			var res json.RawMessage
			switch {
			case generate && refresh:
				return fail.Usagef("pass --generate or --refresh, not both")
			case generate:
				res, err = a.Client.SummariseThread(a.Ctx(c), mb, args[0], "generate")
			case refresh:
				res, err = a.Client.SummariseThread(a.Ctx(c), mb, args[0], "refresh")
			default:
				res, err = a.Client.GetThreadSummary(a.Ctx(c), mb, args[0])
				if err != nil {
					return err
				}
				return a.emit(output.Result{Data: res, Untrusted: []string{"summary"}})
			}
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Untrusted: []string{"summary"}})
		},
	}
	c.Flags().BoolVar(&generate, "generate", false, "build the summary now")
	c.Flags().BoolVar(&refresh, "refresh", false, "queue a rebuild if the thread changed")
	return c
}

// ── domains ────────────────────────────────────────────────────────

func domainUpdate(a *App) *cobra.Command {
	var displayName, catchAll string
	var noCatchAll bool
	c := &cobra.Command{
		Use:   "update <id-or-hostname>",
		Short: "Rename a domain or set its catch-all mailbox",
		Long: strings.TrimSpace(`
Change a domain's display name, or route mail for every unknown address on it to
one mailbox (--catch-all), or stop doing that (--no-catch-all). Administrator-only.
Changing the catch-all redirects mail, so it asks for confirmation unless --yes is
given.`),
		Example: exampleBlock(
			"cloudmail domain update example.com --catch-all support@example.com",
			"cloudmail domain update example.com --no-catch-all",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			patch := map[string]any{}
			if c.Flags().Changed("display-name") {
				patch["displayName"] = displayName
			}
			switch {
			case c.Flags().Changed("catch-all"):
				patch["catchAllMailbox"] = catchAll
			case noCatchAll:
				patch["catchAllMailbox"] = nil
			}
			if err := needPatch(patch, "--display-name, --catch-all or --no-catch-all"); err != nil {
				return err
			}
			if v, ok := patch["catchAllMailbox"]; ok {
				prompt := fmt.Sprintf("stop catching unknown addresses on %s; mail to them will bounce", args[0])
				if v != nil {
					prompt = fmt.Sprintf("send mail for every unknown address on %s to %s", args[0], catchAll)
				}
				if err := a.Confirm(prompt, false); err != nil {
					return err
				}
			}
			res, err := a.Client.UpdateDomain(a.Ctx(c), args[0], patch)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "saved " + args[0]})
		},
	}
	c.Flags().StringVar(&displayName, "display-name", "", "a new display name")
	c.Flags().StringVar(&catchAll, "catch-all", "", "mailbox that receives mail for unknown addresses")
	c.Flags().BoolVar(&noCatchAll, "no-catch-all", false, "clear the catch-all mailbox")
	c.MarkFlagsMutuallyExclusive("catch-all", "no-catch-all")
	return c
}

// ── webhooks ───────────────────────────────────────────────────────

func webhookGet(a *App) *cobra.Command {
	return &cobra.Command{
		Use: "get <webhook-id>", Short: "Show one endpoint", Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			w, err := a.Client.GetWebhook(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: w})
		},
	}
}

func webhookUpdate(a *App) *cobra.Command {
	var name, url, enabled string
	var events, mailboxes []string
	var allMailboxes bool
	c := &cobra.Command{
		Use:   "update <webhook-id>",
		Short: "Change an endpoint's name, URL, events, mailboxes or enabled flag",
		Long: strings.TrimSpace(`
Change the fields given and keep the rest. --event and --mailbox replace the whole
list. Re-enabling an endpoint resets its failure count. Changing the URL sends
future events, signed with the same secret, somewhere else, so it asks first.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			patch := map[string]any{}
			f := c.Flags()
			if f.Changed("name") {
				patch["name"] = name
			}
			if f.Changed("url") {
				patch["url"] = url
			}
			if f.Changed("event") {
				patch["events"] = events
			}
			if f.Changed("mailbox") {
				patch["mailboxes"] = mailboxes
			}
			if allMailboxes {
				patch["mailboxes"] = nil
			}
			if f.Changed("enabled") {
				b, err := onOff("--enabled", enabled)
				if err != nil {
					return err
				}
				patch["enabled"] = b
			}
			if err := needPatch(patch, "--name, --url, --event, --mailbox, --all-mailboxes or --enabled"); err != nil {
				return err
			}
			if f.Changed("url") {
				if err := a.Confirm(fmt.Sprintf("send webhook %s's events to %s", args[0], url), false); err != nil {
					return err
				}
			}
			w, err := a.Client.UpdateWebhook(a.Ctx(c), args[0], patch)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: w, Summary: "saved " + args[0]})
		},
	}
	f := c.Flags()
	f.StringVar(&name, "name", "", "a new label")
	f.StringVar(&url, "url", "", "a new https:// URL")
	f.StringArrayVar(&events, "event", nil, "replace the events (repeatable): "+strings.Join(api.WebhookEvents, ", "))
	f.StringArrayVar(&mailboxes, "mailbox", nil, "replace the mailboxes (repeatable)")
	f.BoolVar(&allMailboxes, "all-mailboxes", false, "send events for every mailbox (admins only)")
	f.StringVar(&enabled, "enabled", "", "on or off")
	c.MarkFlagsMutuallyExclusive("mailbox", "all-mailboxes")
	return c
}

func webhookRotate(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "rotate-secret <webhook-id>",
		Short: "Replace an endpoint's signing secret",
		Long: strings.TrimSpace(`
Issue a new signing secret. The old one stops working at once, so deliveries fail
verification until your backend has the new one. The new secret is printed once.
Asks for confirmation unless --yes is given.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf("rotate webhook %s's secret; the old one stops working now", args[0]), true); err != nil {
				return err
			}
			res, err := a.Client.RotateWebhookSecret(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "store the new secret now; it is not shown again"})
		},
	}
}

func webhookEvents(a *App) *cobra.Command {
	return &cobra.Command{
		Use: "events", Short: "List the event types and the retry policy", Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			raw, err := a.Client.ListWebhookEvents(a.Ctx(c))
			if err != nil {
				return err
			}
			var env struct {
				Events []map[string]any `json:"events"`
			}
			_ = json.Unmarshal(raw, &env)
			return a.emit(output.Result{Data: raw, Rows: env.Events, Columns: []output.Column{
				{Header: "type", Field: "type"}, {Header: "label", Field: "label", Truncate: 30},
				{Header: "hint", Field: "hint", Truncate: 60},
			}})
		},
	}
}

// ── suppressions and template sends ────────────────────────────────

func suppressionCheck(a *App) *cobra.Command {
	var from string
	c := &cobra.Command{
		Use:   "check <address>...",
		Short: "Which of these addresses are suppressed",
		Long:  "Report the suppression entries that would stop mail to these addresses. --from scopes the check to one sending domain.",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			raw, err := a.Client.CheckSuppressions(a.Ctx(c), args, from)
			if err != nil {
				return err
			}
			var env struct {
				Items []map[string]any `json:"items"`
			}
			_ = json.Unmarshal(raw, &env)
			return a.emit(output.Result{
				Data: raw, Rows: env.Items,
				Columns: []output.Column{
					{Header: "address", Field: "address", Truncate: 36}, {Header: "scope", Field: "scope"},
					{Header: "reason", Field: "reason"}, {Header: "id", Field: "id", Truncate: 28},
				},
				Empty: "none of these addresses is suppressed",
			})
		},
	}
	c.Flags().StringVar(&from, "from", "", "the sending address, to check its domain's entries too")
	return c
}

func templateSend(a *App) *cobra.Command {
	var to, vars []string
	var from string
	var noTrack bool
	c := &cobra.Command{
		Use:   "send <slug>",
		Short: "Render a template and send one message per recipient",
		Long: strings.TrimSpace(`
Send the template to each --to address, rendered with --var name=value. Suppressed
addresses are skipped. A token send may be held for approval (see
` + "`cloudmail approval`" + `). Asks for confirmation unless --yes is given, because
sent mail cannot be recalled.`),
		Example: exampleBlock(`cloudmail template send welcome --to a@example.com --to b@example.com --var plan=Pro`),
		Args:    cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			variables, err := parseKeyValues(vars)
			if err != nil {
				return err
			}
			in := api.TemplateSend{Template: args[0], From: from, Recipients: to, Variables: variables}
			if noTrack {
				off := false
				in.Track = &off
			}
			if err := a.Confirm(fmt.Sprintf("send template %s to %d recipient(s) from %s", args[0], len(to), mb), true); err != nil {
				return err
			}
			res, err := a.Client.SendTemplate(a.Ctx(c), mb, in)
			if err != nil {
				return err
			}
			return a.emitSend(res, output.Result{}, nil)
		},
	}
	c.Flags().StringArrayVar(&to, "to", nil, "a recipient (repeatable)")
	c.Flags().StringArrayVar(&vars, "var", nil, "a template variable as name=value (repeatable)")
	c.Flags().StringVar(&from, "from", "", "send from this address instead of the mailbox")
	c.Flags().BoolVar(&noTrack, "no-track", false, "turn off open and click tracking")
	_ = c.MarkFlagRequired("to")
	return c
}

// ── products ───────────────────────────────────────────────────────

func productCreate(a *App) *cobra.Command {
	var slug, displayName string
	var domains, aliases []string
	c := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a product",
		Long:  "Create a product and attach domains and aliases to it. Administrator-only. Set the rest with update.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			in := map[string]any{"name": args[0]}
			if slug != "" {
				in["slug"] = slug
			}
			if displayName != "" {
				in["displayName"] = displayName
			}
			if len(domains) > 0 {
				in["domains"] = domains
			}
			if len(aliases) > 0 {
				in["aliases"] = aliases
			}
			p, err := a.Client.CreateProduct(a.Ctx(c), in)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: p})
		},
	}
	c.Flags().StringVar(&slug, "slug", "", "the URL-safe name (default: from the name)")
	c.Flags().StringVar(&displayName, "display-name", "", "the From display name")
	c.Flags().StringSliceVar(&domains, "domain", nil, "a domain that sends as this product (repeatable)")
	c.Flags().StringSliceVar(&aliases, "alias", nil, "an address that sends as this product (repeatable)")
	return c
}

func productDelete(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "delete <id-or-slug>",
		Short: "Delete a product",
		Long:  "Delete a product and its logo. Its domains are left without a product and do not get a new default. Asks unless --yes.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf("delete product %s and its logo", args[0]), true); err != nil {
				return err
			}
			res, err := a.Client.DeleteProduct(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
}

func productLogo(a *App) *cobra.Command {
	c := group("logo", "Upload or remove a product's logo", "")
	set := &cobra.Command{
		Use: "set <id-or-slug> <image-file>", Short: "Upload a logo (PNG, JPEG, WebP or GIF, up to 512 KiB)",
		Args: cobra.ExactArgs(2),
		RunE: func(c *cobra.Command, args []string) error {
			up, err := readLogo(args[1])
			if err != nil {
				return err
			}
			res, err := a.Client.PutProductLogo(a.Ctx(c), args[0], up)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "logo uploaded"})
		},
	}
	del := &cobra.Command{
		Use: "delete <id-or-slug>", Short: "Remove a product's logo", Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf("delete product %s's logo", args[0]), true); err != nil {
				return err
			}
			res, err := a.Client.DeleteProductLogo(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "logo removed"})
		},
	}
	c.AddCommand(set, del)
	return c
}

func productRefresh(a *App) *cobra.Command {
	return &cobra.Command{
		Use: "refresh-knowledge <id-or-slug>", Short: "Fetch the product's knowledge URL again",
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			res, err := a.Client.RefreshProductKnowledge(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
}

func productResolve(a *App) *cobra.Command {
	return rawCmd("resolve <from-address>", "Which product a From address sends as",
		"The alias wins over the domain.", func(c *cobra.Command, args []string) (json.RawMessage, error) {
			return a.Client.ResolveProduct(a.Ctx(c), args[0])
		}, a, cobra.ExactArgs(1))
}

// ── mail, follow-ups, sequences, mailbox, auth ─────────────────────

func mailTabs(a *App) *cobra.Command {
	return &cobra.Command{
		Use: "tabs", Short: "The mailbox's split-inbox tabs, as saved searches",
		Long: "Each tab's query works with `cloudmail mail search`.",
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			raw, err := a.Client.ListInboxTabs(a.Ctx(c), mb)
			if err != nil {
				return err
			}
			var env struct {
				Tabs []map[string]any `json:"tabs"`
			}
			_ = json.Unmarshal(raw, &env)
			return a.emit(output.Result{Data: raw, Rows: env.Tabs, Columns: []output.Column{
				{Header: "id", Field: "id"}, {Header: "name", Field: "name"}, {Header: "query", Field: "query", Truncate: 60},
			}})
		},
	}
}

func followupGet(a *App) *cobra.Command {
	return rawCmd("get <message-id>", "Show the reminder on a message or its thread", "",
		func(c *cobra.Command, args []string) (json.RawMessage, error) {
			mb, err := a.mustMailbox()
			if err != nil {
				return nil, err
			}
			return a.Client.GetFollowup(a.Ctx(c), mb, args[0])
		}, a, cobra.ExactArgs(1))
}

func sequencePerson(a *App) *cobra.Command {
	return rawCmd("person <person-id>", "One person's sequence progress and queued steps", "",
		func(c *cobra.Command, args []string) (json.RawMessage, error) {
			return a.Client.PersonEnrollment(a.Ctx(c), args[0])
		}, a, cobra.ExactArgs(1))
}

func mailboxSemantic(a *App) *cobra.Command {
	return rawCmd("semantic", "The mailbox's semantic index: indexed, queued and today's usage", "",
		func(c *cobra.Command, _ []string) (json.RawMessage, error) {
			mb, err := a.mustMailbox()
			if err != nil {
				return nil, err
			}
			return a.Client.GetSemanticStatus(a.Ctx(c), mb)
		}, a, cobra.NoArgs)
}

func authConfig(a *App) *cobra.Command {
	return &cobra.Command{
		Use: "deployment", Short: "The domains and addresses this deployment serves", Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			cfg, err := a.Client.DeploymentConfig(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: cfg})
		},
	}
}
