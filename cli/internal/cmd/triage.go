package cmd

import (
	"fmt"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

// ── label prompt ───────────────────────────────────────────────────

func labelPrompt(a *App) *cobra.Command {
	c := group("prompt", "AI auto-labels: label prompts and presets", `
A label with a prompt is an auto-label: new mail is classified against every
prompt in one AI call and gets the labels that fit. Rules always win, and Spam and
Trash are never touched. Header checks (List-Id, List-Unsubscribe, known billing
senders) label newsletters, notifications and billing without a model call.

Turn AI triage on for the mailbox in its settings (triage.enabled), then give
labels prompts or enable presets. --tab shows a label as an inbox tab;
--auto-archive files matching mail straight to Archive.`,
		"cloudmail label prompt list",
		"cloudmail label prompt set <label-id> \"Customer bug reports\" --tab",
		"cloudmail label prompt preset newsletters --auto-archive",
		"cloudmail label prompt backfill",
	)
	c.AddCommand(labelPromptList(a), labelPromptSet(a), labelPromptClear(a), labelPromptPreset(a), labelPromptBackfill(a))
	return c
}

func labelPromptColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 24},
		{Header: "name", Field: "name", Truncate: 20},
		{Header: "tab", Field: "show_tab", Truncate: 5},
		{Header: "archive", Field: "auto_archive", Truncate: 7},
		{Header: "prompt", Field: "prompt", Truncate: 60},
	}
}

func labelPromptList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "Show label prompts, presets and today's AI usage",
		Long:  "List every label with its prompt and flags, and summarise presets and the daily AI cap.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			res, err := a.Client.ListLabelPrompts(a.Ctx(c), mb)
			if err != nil {
				return err
			}
			on := []string{}
			for _, p := range res.Presets {
				if p.Enabled {
					on = append(on, p.Key)
				}
			}
			state := "off"
			if res.Enabled {
				state = "on"
			}
			presets := "none"
			if len(on) > 0 {
				presets = strings.Join(on, ", ")
			}
			return a.emit(output.Result{
				Data:    res.Labels,
				Columns: labelPromptColumns(),
				Summary: fmt.Sprintf("triage %s · presets: %s · AI calls today %d/%d · screener %s",
					state, presets, res.AICallsToday, res.DailyAICap, res.Screener),
				Empty: "no labels yet",
			})
		},
	}
}

func optionalBool(c *cobra.Command, name string, v bool) *bool {
	if !c.Flags().Changed(name) {
		return nil
	}
	return &v
}

func labelPromptSet(a *App) *cobra.Command {
	var tab, archive bool
	c := &cobra.Command{
		Use:   "set <label-id> [prompt]",
		Short: "Give a label a prompt, or change its tab and archive flags",
		Long: strings.TrimSpace(`
Set what mail a label is for, in a short phrase the model can match ("Customer
bug reports", "Stripe receipts"). At most 300 characters. Without a prompt, only
the flags you give change.`),
		Example: exampleBlock(
			"cloudmail label prompt set 0e6f...c4 \"Customer bug reports\"",
			"cloudmail label prompt set 0e6f...c4 --tab=false",
		),
		Args: cobra.RangeArgs(1, 2),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			in := api.LabelPromptInput{
				AutoArchive: optionalBool(c, "auto-archive", archive),
				ShowTab:     optionalBool(c, "tab", tab),
			}
			if len(args) == 2 {
				in.Prompt = &args[1]
			}
			l, err := a.Client.SetLabelPrompt(a.Ctx(c), mb, args[0], in)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: l, Columns: labelPromptColumns()})
		},
	}
	c.Flags().BoolVar(&tab, "tab", false, "show as an inbox tab")
	c.Flags().BoolVar(&archive, "auto-archive", false, "file matching mail straight to Archive")
	return c
}

func labelPromptClear(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "clear <label-id>",
		Short: "Stop auto-labelling with a label",
		Long:  "Remove a label's prompt. The label and the messages carrying it stay as they are.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			l, err := a.Client.SetLabelPrompt(a.Ctx(c), mb, args[0], api.LabelPromptInput{ClearPrompt: true})
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: l, Columns: labelPromptColumns()})
		},
	}
}

func labelPromptPreset(a *App) *cobra.Command {
	var off, tab, archive bool
	c := &cobra.Command{
		Use:   "preset <key>",
		Short: "Turn a built-in preset on or off",
		Long: strings.TrimSpace(`
Presets for founders: ` + strings.Join(api.TriagePresetKeys, ", ") + `.
Turning one on creates its label (or adopts an existing label with the same name)
and gives it the preset prompt. --off clears the prompt and keeps the label.`),
		Example: exampleBlock(
			"cloudmail label prompt preset billing --tab",
			"cloudmail label prompt preset newsletters --auto-archive",
			"cloudmail label prompt preset cold_outreach --off",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			res, err := a.Client.SetTriagePreset(a.Ctx(c), mb, args[0], !off,
				optionalBool(c, "auto-archive", archive), optionalBool(c, "tab", tab))
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
	c.Flags().BoolVar(&off, "off", false, "turn the preset off")
	c.Flags().BoolVar(&tab, "tab", false, "show as an inbox tab")
	c.Flags().BoolVar(&archive, "auto-archive", false, "file matching mail straight to Archive")
	return c
}

func labelPromptBackfill(a *App) *cobra.Command {
	var batch int
	var all bool
	c := &cobra.Command{
		Use:   "backfill",
		Short: "Label the last 14 days of mail",
		Long: strings.TrimSpace(`
Classify recent Inbox mail that triage has not seen: the newest 300 messages from
the last 14 days, one batch per call. --all repeats until nothing is left or the
daily AI cap is reached.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			total := api.BackfillResult{}
			for i := 0; i < 20; i++ {
				res, err := a.Client.BackfillTriage(a.Ctx(c), mb, batch)
				if err != nil {
					return err
				}
				total.Processed += res.Processed
				total.Classified += res.Classified
				total.Remaining = res.Remaining
				total.Capped = res.Capped
				if !all || a.DryRun() || res.Capped || res.Remaining == 0 || res.Processed == 0 {
					break
				}
			}
			summary := fmt.Sprintf("%d processed, %d labelled, %d left", total.Processed, total.Classified, total.Remaining)
			if total.Capped {
				summary += " (daily AI cap reached)"
			}
			return a.emitMutation(output.Result{Data: total, Summary: summary})
		},
	}
	c.Flags().IntVar(&batch, "batch", 0, "messages per step, 1-25 (default 10)")
	c.Flags().BoolVar(&all, "all", false, "repeat until done or capped")
	return c
}

// ── screener ───────────────────────────────────────────────────────

func newScreenerCommand(a *App) *cobra.Command {
	c := group("screener", "First-time senders waiting for a Yes or No", `
With the mailbox setting screener = unknown_only, mail from someone the mailbox
has never written to, outside a known thread and not on the allowlist, waits in
the Screener instead of the inbox.

allow (Yes) adds the sender to the allowlist and moves their screened mail to the
inbox. block (No) adds them to the blocklist and moves it to Spam, or Trash with
--to trash. Future mail follows the decision.`,
		"cloudmail screener list",
		"cloudmail screener allow jane@customer.example",
		"cloudmail screener block sdr@leadgen.example --to trash",
	)
	c.AddCommand(screenerList(a), screenerDecide(a, "allow"), screenerDecide(a, "block"))
	return c
}

func screenerList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "Show senders waiting in the Screener",
		Long:  "One row per sender, newest first, with the AI pre-verdict when there is one.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			items, err := a.Client.ListScreener(a.Ctx(c), mb)
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data: items,
				Columns: []output.Column{
					{Header: "sender", Field: "sender", Truncate: 32},
					{Header: "msgs", Field: "count", Truncate: 5},
					{Header: "verdict", Field: "verdict", Truncate: 34},
					{Header: "latest", Field: "latest_subject", Truncate: 40},
				},
				Summary:   fmt.Sprintf("%d sender(s) waiting", len(items)),
				Untrusted: []string{"sender_name", "latest_subject"},
				Empty:     "nobody is waiting in the Screener",
			})
		},
	}
}

func screenerDecide(a *App, decision string) *cobra.Command {
	var to string
	short := "Yes: allowlist senders and move their mail to the inbox"
	if decision == "block" {
		short = "No: blocklist senders and move their mail to Spam or Trash"
	}
	c := &cobra.Command{
		Use:   decision + " <address>...",
		Short: short,
		Long:  short + ".",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			results := []*api.ScreenResult{}
			for _, sender := range args {
				res, err := a.Client.ScreenSender(a.Ctx(c), mb, sender, decision, to)
				if err != nil {
					return err
				}
				results = append(results, res)
			}
			return a.emitMutation(output.Result{
				Data:    results,
				Summary: fmt.Sprintf("%d sender(s) %s", len(args), map[string]string{"allow": "allowed", "block": "blocked"}[decision]),
			})
		},
	}
	if decision == "block" {
		c.Flags().StringVar(&to, "to", "", "where their mail goes: spam (default) or trash")
	}
	return c
}
