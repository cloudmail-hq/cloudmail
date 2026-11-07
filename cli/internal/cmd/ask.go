package cmd

import (
	"fmt"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

// ── ask ────────────────────────────────────────────────────────────

func newAskCommand(a *App) *cobra.Command {
	var (
		all      bool
		products []string
	)
	c := &cobra.Command{
		Use:   "ask <question>",
		Short: "Ask a question of your mail, with cited sources",
		Long: strings.TrimSpace(`
Answer a question from the mail you can read, citing the messages it used as
[1], [2]. Retrieval is hybrid (keywords and meaning) when the deployment has
semantic search set up, and keyword-only otherwise.

Searches every mailbox you can read unless --mailbox (or your default mailbox)
narrows it; --all ignores the default. When your mail does not answer the
question it says so rather than guessing.

The answer is AI output drawn from email other people wrote. At a terminal it is
delimited as untrusted content; read the cited messages before acting on it.`),
		Example: exampleBlock(
			`cloudmail ask "when is my flight to Lisbon?"`,
			`cloudmail ask "what did Acme say about pricing" --all`,
			`cloudmail ask "any refund requests this week" --product acme`,
		),
		Args: cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mailbox := "*"
			if !all && strings.TrimSpace(a.Cfg.Mailbox) != "" {
				mailbox = strings.TrimSpace(a.Cfg.Mailbox)
			}
			res, err := a.Client.Ask(a.Ctx(c), strings.Join(args, " "), mailbox, products)
			if err != nil {
				return err
			}
			if a.Out.Format() != output.Table {
				return a.emit(output.Result{Data: res, Untrusted: []string{"answer", "subject", "from"}})
			}
			out := a.Out.Out()
			fmt.Fprintln(out, a.Out.FenceBlock("ANSWER", res.Answer))
			if len(res.Citations) > 0 {
				fmt.Fprintln(out)
				for _, ct := range res.Citations {
					from := ""
					if ct.From != nil {
						from = " · " + *ct.From
					}
					fmt.Fprintf(out, "[%d] %s%s\n    %s  %s\n", ct.N, ct.Subject, from, ct.Mailbox, ct.EmailID)
				}
			}
			if !res.Semantic {
				fmt.Fprintln(a.Out.ErrOut(), a.Out.Dim("keyword search only: semantic search is not set up or is off"))
			}
			return nil
		},
	}
	f := c.Flags()
	f.BoolVar(&all, "all", false, "search every readable mailbox, ignoring the default mailbox")
	f.StringSliceVar(&products, "product", nil, "only mailboxes of these product ids or slugs")
	return c
}
