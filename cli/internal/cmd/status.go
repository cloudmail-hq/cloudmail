package cmd

import (
	"fmt"

	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

func newStatusCommand(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the deployment's version and health checklist (admin)",
		Long: `Show the app version this deployment runs and a checklist: storage reachable,
AUTH_SECRET and rate limiting configured, semantic search and Workers AI bound.
A failed line says what to do about it.`,
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			s, err := a.Client.GetSystemStatus(a.Ctx(c))
			if err != nil {
				return err
			}
			state := "healthy"
			if !s.OK {
				state = "needs attention"
			}
			return a.emit(output.Result{
				Data: s.Checks,
				Columns: []output.Column{
					{Header: "check", Field: "label", Truncate: 32},
					{Header: "ok", Field: "ok"},
					{Header: "detail", Field: "detail", Truncate: 90},
				},
				Summary: fmt.Sprintf("version %s, %s", s.Version, state),
			})
		},
	}
}
