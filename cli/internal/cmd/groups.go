package cmd

import (
	"fmt"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

func newGroupCommand(a *App) *cobra.Command {
	c := group("group", "Group addresses that deliver to several mailboxes", `
A group address (team@, founders@) delivers a copy of each message into every
member's own mailbox; members reply from their own address. For one inbox that
several people work from (support@), create a mailbox and share it instead.

Members must be mailboxes on this deployment, at most 25. Managing groups needs an
administrator.`,
		"cloudmail group list",
		"cloudmail group set team@example.com alice@example.com bob@example.com --name Team",
		"cloudmail group delete team@example.com",
	)

	list := &cobra.Command{
		Use:   "list",
		Short: "Show group addresses and their members",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			groups, err := a.Client.ListGroups(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data: groups,
				Columns: []output.Column{
					{Header: "address", Field: "address", Truncate: 40},
					{Header: "name", Field: "name", Truncate: 24},
					{Header: "members", Field: "members", Value: func(r map[string]any) string {
						list, _ := r["members"].([]any)
						parts := make([]string, 0, len(list))
						for _, m := range list {
							if s, ok := m.(string); ok {
								parts = append(parts, s)
							}
						}
						return strings.Join(parts, ", ")
					}},
				},
				Summary: fmt.Sprintf("%d group(s)", len(groups)),
				Empty:   "no groups",
			})
		},
	}

	var name string
	set := &cobra.Command{
		Use:   "set <address> <member>...",
		Short: "Create a group or replace its members",
		Long: strings.TrimSpace(`
Create the group, or replace its name and member list. The address must be on one
of this deployment's domains and not already a mailbox or alias.`),
		Args: cobra.MinimumNArgs(2),
		RunE: func(c *cobra.Command, args []string) error {
			g, err := a.Client.PutGroup(a.Ctx(c), args[0], name, args[1:])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{
				Data:    map[string]any{"group": g, "dry_run": a.DryRun()},
				Summary: fmt.Sprintf("%s delivers to %d mailbox(es)", args[0], len(args)-1),
			})
		},
	}
	set.Flags().StringVar(&name, "name", "", "display name for the group")

	del := &cobra.Command{
		Use:   "delete <address>",
		Short: "Delete a group address",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf("delete group %s (mail to it will stop being delivered)", args[0]), true); err != nil {
				return err
			}
			if err := a.Client.DeleteGroup(a.Ctx(c), args[0]); err != nil {
				return err
			}
			return a.emitMutation(output.Result{
				Data:    map[string]any{"status": "deleted", "address": args[0], "dry_run": a.DryRun()},
				Summary: "deleted " + args[0],
			})
		},
	}

	c.AddCommand(list, set, del)
	return c
}
