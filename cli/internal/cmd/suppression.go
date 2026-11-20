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

func newSuppressionCommand(a *App) *cobra.Command {
	c := group("suppression", "Addresses that bulk mail skips", `
The suppression list is deployment-wide. Sequences, template sends and API sends
marked non-transactional skip every address on it; mail you write yourself is not
blocked.

An entry is scoped to every sending domain ("global") or to one domain, so someone
who unsubscribes from one product keeps hearing from the others. Unsubscribe links
and hard bounces add entries automatically. Changing the list needs an
administrator.`,
		"cloudmail suppression list --search example.com",
		"cloudmail suppression add someone@example.com --scope product.dev",
		"cloudmail suppression import ./unsubscribes.csv",
		"cloudmail suppression remove sup_xxxxxxxxxxxxxxxxxxxxxx",
	)

	var search, scope, reason string
	var offset int
	list := &cobra.Command{
		Use:   "list",
		Short: "Show suppressed addresses",
		Long: strings.TrimSpace(`
List suppressed addresses, newest first. --search matches any part of the address.
Use --offset to page; the summary line says how many there are in total.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			page, err := a.Client.ListSuppressions(a.Ctx(c), api.SuppressionListOptions{
				Query: search, Scope: scope, Reason: reason,
				Limit: a.pageLimit(0), Offset: offset,
			})
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:      page.Items,
				Columns:   suppressionColumns(),
				Summary:   fmt.Sprintf("%d of %d suppressed", len(page.Items), page.Total),
				Untrusted: []string{"address", "source"},
				Empty:     "nobody is suppressed",
			})
		},
	}
	list.Flags().StringVar(&search, "search", "", "match part of the address")
	list.Flags().StringVar(&scope, "scope", "", `only entries for this scope ("global" or a domain)`)
	list.Flags().StringVar(&reason, "reason", "", "only this reason: "+strings.Join(api.SuppressionReasons, ", "))
	list.Flags().IntVar(&offset, "offset", 0, "skip this many entries")

	var addScope, addReason string
	add := &cobra.Command{
		Use:   "add <address>...",
		Short: "Suppress addresses",
		Long: strings.TrimSpace(`
Add one or more addresses. Without --scope they are suppressed for every sending
domain. Adding an address that is already listed is a no-op.`),
		Args: cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			added, existing := 0, 0
			for _, address := range args {
				res, err := a.Client.AddSuppression(a.Ctx(c), address, addScope, addReason)
				if err != nil {
					return err
				}
				added += res.Added
				existing += res.Existing
			}
			return a.emitMutation(output.Result{
				Data:    map[string]any{"added": added, "existing": existing, "dry_run": a.DryRun()},
				Summary: fmt.Sprintf("%d added, %d already listed", added, existing),
			})
		},
	}
	add.Flags().StringVar(&addScope, "scope", "", "sending domain; omit for all domains")
	add.Flags().StringVar(&addReason, "reason", "manual", "one of "+strings.Join(api.SuppressionReasons, ", "))

	remove := &cobra.Command{
		Use:   "remove <id>...",
		Short: "Take entries off the list",
		Long: strings.TrimSpace(`
Remove entries by id (from ` + "`cloudmail suppression list`" + `). The address will
receive sequence and bulk mail again, so only do this for someone who asked.`),
		Args: cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf("remove %d suppression(s)", len(args)), true); err != nil {
				return err
			}
			for _, id := range args {
				if _, err := a.Client.RemoveSuppression(a.Ctx(c), id); err != nil {
					return err
				}
			}
			return a.emitMutation(output.Result{
				Data:    map[string]any{"status": "removed", "ids": args, "dry_run": a.DryRun()},
				Summary: fmt.Sprintf("%d removed", len(args)),
			})
		},
	}

	var impScope, impReason string
	imp := &cobra.Command{
		Use:   "import <file.csv|->",
		Short: "Import a CSV of addresses",
		Long: strings.TrimSpace(`
Import addresses from a CSV file, or - for stdin. One address per line, or columns
address,scope,reason with an optional header row (an "email" column works too).
--scope and --reason fill in rows that leave them blank. Bad rows are skipped and
reported; up to 10,000 rows per import.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			var raw []byte
			var err error
			if args[0] == "-" {
				var s string
				s, err = readAll(os.Stdin)
				raw = []byte(s)
			} else {
				raw, err = os.ReadFile(args[0])
			}
			if err != nil {
				return fail.Usagef("cannot read %s: %v", args[0], err)
			}
			res, err := a.Client.ImportSuppressions(a.Ctx(c), string(raw), impScope, impReason)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{
				Data: res,
				Summary: fmt.Sprintf("%d added, %d already listed, %d skipped",
					res.Added, res.Existing, res.ErrorCount),
			})
		},
	}
	imp.Flags().StringVar(&impScope, "scope", "", "scope for rows without one; omit for all domains")
	imp.Flags().StringVar(&impReason, "reason", "", "reason for rows without one (default manual)")

	c.AddCommand(list, add, remove, imp)
	return c
}

func suppressionColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 26},
		{Header: "address", Field: "address", Truncate: 40},
		{Header: "scope", Field: "scope", Truncate: 24},
		{Header: "reason", Field: "reason", Truncate: 14},
		{Header: "added", Field: "created_at", Value: func(r map[string]any) string {
			ms, ok := r["created_at"].(float64)
			if !ok || ms <= 0 {
				return ""
			}
			return time.UnixMilli(int64(ms)).Format("2006-01-02")
		}},
	}
}
