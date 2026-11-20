package cmd

import (
	"fmt"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

// ── followup ───────────────────────────────────────────────────────

func newFollowupCommand(a *App) *cobra.Command {
	c := group("followup", "Remind me if no reply, on sent mail", `
Follow-up reminders on messages you sent.

If nobody else writes into the thread by the reminder time, the thread comes back
to the inbox, unread, with a "Follow up" label. A reply cancels the reminder;
replying again yourself restarts the clock. One reminder per thread.`,
		"cloudmail followup list",
		"cloudmail followup set <message-id> --in 3d",
		"cloudmail followup cancel <message-id>",
	)
	c.AddCommand(followupList(a), followupSet(a), followupCancel(a))
	return c
}

func followupColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "email_id", Truncate: 24},
		{Header: "due", Field: "followup_at", Value: func(r map[string]any) string {
			if output.Stringify(r["status"]) == "fired" {
				return "now"
			}
			return untilWhen(output.Stringify(r["followup_at"]))
		}, Truncate: 22},
		{Header: "status", Field: "status", Truncate: 10},
		{Header: "mode", Field: "followup_mode", Truncate: 8},
		{Header: "to", Field: "recipient", Truncate: 28},
		{Header: "subject", Field: "subject", Truncate: 34},
	}
}

func followupList(a *App) *cobra.Command {
	var status string
	c := &cobra.Command{
		Use:   "list",
		Short: "List sent mail awaiting a reply",
		Long: strings.TrimSpace(`
Show reminders: fired ones (already back in the inbox) first, then pending ones by
due date.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			items, err := a.Client.ListFollowups(a.Ctx(c), mb, status)
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:      items,
				Columns:   followupColumns(),
				Summary:   fmt.Sprintf("%d awaiting reply", len(items)),
				Untrusted: []string{"subject", "recipient"},
				Empty:     "nothing awaiting a reply",
			})
		},
	}
	c.Flags().StringVar(&status, "status", "", "active (default), pending or fired")
	return c
}

func followupSet(a *App) *cobra.Command {
	var at, in string
	c := &cobra.Command{
		Use:   "set <message-id> (--at <time> | --in <duration>)",
		Short: "Remind me if no reply",
		Long: strings.TrimSpace(`
Set or replace the reminder on a sent message. Give exactly one of --at (an
absolute time) or --in (a delay from now), within 90 days.`),
		Example: exampleBlock(
			"cloudmail followup set 019...c4 --in 3d",
			"cloudmail followup set 019...c4 --at 2026-11-02T09:00:00Z",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			delay := 0
			if in != "" {
				d, err := parseDelaySeconds(in)
				if err != nil {
					return err
				}
				delay = d
			}
			res, err := a.Client.SetFollowup(a.Ctx(c), mb, args[0], at, delay)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
	c.Flags().StringVar(&at, "at", "", "absolute time, e.g. 2026-11-02T09:00:00Z")
	c.Flags().StringVar(&in, "in", "", "delay from now, e.g. 3d or 36h")
	c.MarkFlagsMutuallyExclusive("at", "in")
	c.MarkFlagsOneRequired("at", "in")
	return c
}

func followupCancel(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "cancel <message-id>...",
		Short: "Cancel a reminder",
		Long: strings.TrimSpace(`
Cancel the active reminder on each message (or its thread). A reminder that has
already fired is dismissed: the message goes back to the folder it came from and
loses the Follow up label.`),
		Args: cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			for _, id := range args {
				if _, err := a.Client.CancelFollowup(a.Ctx(c), mb, id); err != nil {
					return err
				}
			}
			return a.emitMutation(output.Result{
				Data:    map[string]any{"status": "cancelled", "ids": args, "dry_run": a.DryRun()},
				Summary: fmt.Sprintf("%d reminder(s) cancelled", len(args)),
			})
		},
	}
}
