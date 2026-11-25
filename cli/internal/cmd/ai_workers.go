package cmd

import (
	"fmt"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

// `cloudmail ai status`, `ai models list` and `ai route`: the built-in
// provider (Cloudflare Workers AI) and where AI runs.

func aiStatusCommand(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Where AI runs, each role's model, and this month's calls",
		Long: strings.TrimSpace(`
Show which provider AI runs on (Cloudflare Workers AI unless a gateway is
active), the exceptions, the Workers AI model each role uses and where it comes
from (admin pick, SUMMARY_MODEL or the default), and this month's model requests
per provider.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			s, err := a.Client.AIStatusFull(a.Ctx(c))
			if err != nil {
				return err
			}
			if a.Out.Format() != output.Table {
				return a.emit(output.Result{Data: s})
			}
			// The mode line is the answer, so it prints even with --quiet.
			out := a.Out.Out()
			fmt.Fprintln(out, a.Out.Bold(s.Status.Line))
			if err := a.emit(output.Result{
				Data:    s,
				Rows:    s.WorkersAI.Roles,
				Columns: workersAIRoleColumns(),
			}); err != nil {
				return err
			}
			for _, e := range s.Status.Exceptions {
				fmt.Fprintf(out, "  %s\n", e.Text)
			}
			if len(s.Usage.ByProvider) > 0 {
				return a.section("Calls this month ("+s.Usage.Month+")", output.Result{
					Data: s.Usage.ByProvider,
					Columns: []output.Column{
						{Header: "provider", Field: "providerId"},
						{Header: "calls", Field: "calls", Right: true},
						{Header: "input tokens", Field: "inputTokens", Right: true},
						{Header: "output tokens", Field: "outputTokens", Right: true},
					},
				})
			}
			return nil
		},
	}
}

func aiModelsCommand(a *App) *cobra.Command {
	c := group("models", "The Workers AI model catalogue", `
Cloudflare's Workers AI catalogue (text generation and embeddings), cached for an
hour by the server. Without a CF_ANALYTICS_TOKEN that has Workers AI Read the
server returns a short built-in list instead.`,
		"cloudmail ai models list",
		"cloudmail ai models list --task embeddings",
	)
	c.AddCommand(aiModelsList(a))
	return c
}

func aiModelsList(a *App) *cobra.Command {
	var task, search string
	c := &cobra.Command{
		Use:   "list",
		Short: "List Workers AI models with their capabilities",
		Long: strings.TrimSpace(`
List Workers AI models. --task text or --task embeddings narrows the list.
Capabilities: tools (function calling), json (JSON mode), context window, and
price per million tokens. "?" means not verified: run Test in Settings, or pick
a model the catalogue vouches for.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			t, err := workersAITask(task)
			if err != nil {
				return err
			}
			cat, err := a.Client.ListWorkersAIModels(a.Ctx(c), t, search)
			if err != nil {
				return err
			}
			summary := fmt.Sprintf("%d model(s)", cat.Count)
			if cat.Source != "live" {
				summary += " from the built-in list"
				if cat.Detail != nil && *cat.Detail != "" {
					summary += ": " + *cat.Detail
				}
			}
			if err := a.emit(output.Result{
				Data:    cat,
				Rows:    cat.Models,
				Columns: workersAIModelColumns(),
				Summary: summary,
				Empty:   "no models match",
			}); err != nil {
				return err
			}
			if a.Out.Format() == output.Table {
				for _, r := range cat.Roles {
					if r.Unlisted == nil {
						continue
					}
					msg := fmt.Sprintf("%s uses %s, which is not in Cloudflare's current catalogue and may be retired", r.Role, r.ModelID)
					if r.Unlisted.Successor != nil {
						msg += fmt.Sprintf("; consider %s", *r.Unlisted.Successor)
					}
					a.Out.Warn("%s", msg)
				}
			}
			return nil
		},
	}
	c.Flags().StringVar(&task, "task", "", "text or embeddings")
	c.Flags().StringVar(&search, "search", "", "substring of the model id or description")
	return c
}

// workersAITask maps the friendly --task values to the server's task names.
func workersAITask(v string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "":
		return "", nil
	case "text", "text-generation", "text generation", "chat":
		return "Text Generation", nil
	case "embeddings", "embedding", "text-embeddings", "text embeddings":
		return "Text Embeddings", nil
	}
	return "", fail.Usagef("--task must be text or embeddings")
}

func aiRouteCommand(a *App) *cobra.Command {
	var provider string
	var reset, confirmReindex bool
	c := &cobra.Command{
		Use:   "route <role> [<model>] --provider workers-ai",
		Short: "Set the Workers AI model a role uses",
		Long: strings.TrimSpace(`
Set the Workers AI model for one role, or --reset it to the default. The server
checks the model can do what the role needs (tools for agent_chat and
auto_draft, JSON mode for triage, a 1024-dimension embedding model for
embeddings) and refuses it otherwise (exit 12, "role: reason").

Changing embeddings re-indexes every mailbox's search: pass --confirm-reindex.
The injection_scanner's model is fixed.

For a gateway's models use ` + "`cloudmail ai provider route`" + `.
` + personOnly),
		Example: exampleBlock(
			"cloudmail ai route agent_chat @cf/moonshotai/kimi-k2.6 --provider workers-ai",
			"cloudmail ai route summary --reset --provider workers-ai",
			"cloudmail ai route embeddings @cf/baai/bge-large-en-v1.5 --provider workers-ai --confirm-reindex",
		),
		Args: cobra.RangeArgs(1, 2),
		RunE: func(c *cobra.Command, args []string) error {
			if provider != api.WorkersAIProviderID {
				return fail.Usagef("--provider must be %s", api.WorkersAIProviderID).
					WithRemediation("for a gateway use `cloudmail ai provider route %s=<model>`", args[0])
			}
			role := strings.TrimSpace(args[0])
			var model *string
			switch {
			case reset && len(args) == 2:
				return fail.Usagef("pass a model or --reset, not both")
			case reset:
			case len(args) == 2:
				m := strings.TrimSpace(args[1])
				model = &m
			default:
				return fail.Usagef("no model given").
					WithRemediation("`cloudmail ai models list` lists them, or pass --reset for the default")
			}
			res, err := a.Client.RouteWorkersAI(a.Ctx(c), role, model, confirmReindex)
			if err != nil {
				return err
			}
			summary := "saved"
			for _, r := range res.WorkersAI.Roles {
				if r.Role == role {
					summary = fmt.Sprintf("%s now uses %s on Workers AI", role, r.ModelID)
				}
			}
			if res.Reindex {
				summary += "; mailboxes re-index their search"
			}
			return a.emitMutation(output.Result{
				Data: res, Rows: res.WorkersAI.Roles, Columns: workersAIRoleColumns(), Summary: summary,
			})
		},
	}
	c.Flags().StringVar(&provider, "provider", "", "workers-ai (the built-in provider)")
	c.Flags().BoolVar(&reset, "reset", false, "go back to the role's default model")
	c.Flags().BoolVar(&confirmReindex, "confirm-reindex", false, "allow an embeddings change, which re-indexes search")
	_ = c.MarkFlagRequired("provider")
	return c
}

func workersAIRoleColumns() []output.Column {
	return []output.Column{
		{Header: "role", Field: "role"},
		{Header: "model", Field: "modelId", Truncate: 48},
		{Header: "from", Field: "source", Value: func(r map[string]any) string {
			if truthy(r["locked"]) {
				return "fixed"
			}
			switch output.Stringify(r["source"]) {
			case "admin":
				return "admin"
			case "env":
				return "SUMMARY_MODEL"
			}
			return "default"
		}},
	}
}

func workersAIModelColumns() []output.Column {
	yesNo := func(name string) func(map[string]any) string {
		return func(r map[string]any) string {
			c, _ := r[name].(map[string]any)
			switch {
			case c == nil:
				return "?"
			case c["value"] == true && output.Stringify(c["source"]) != "hint":
				if output.Stringify(c["source"]) == "probe" {
					return "yes (tested)"
				}
				return "yes"
			case c["value"] == false:
				return "no"
			}
			return "?"
		}
	}
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 48},
		{Header: "task", Field: "task", Value: func(r map[string]any) string {
			if output.Stringify(r["task"]) == "Text Embeddings" {
				if d := intField(r["dims"]); d > 0 {
					return fmt.Sprintf("embeddings %dd", d)
				}
				return "embeddings"
			}
			return "text"
		}},
		{Header: "tools", Field: "tools", Value: yesNo("tools")},
		{Header: "json", Field: "json", Value: yesNo("json")},
		{Header: "context", Field: "contextTokens", Right: true},
		{Header: "price/M in·out", Field: "price", Value: func(r map[string]any) string {
			p, _ := r["price"].(map[string]any)
			if p == nil {
				return ""
			}
			in, out := output.Stringify(p["input"]), output.Stringify(p["output"])
			if out == "" {
				return "$" + in
			}
			return "$" + in + " / $" + out
		}},
	}
}
