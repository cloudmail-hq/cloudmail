package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

func newProductCommand(a *App) *cobra.Command {
	c := group("product", "See and edit the products your domains send as", `
A product is the identity a group of domains and aliases presents: display name,
accent colour, logo, default signature, the agent's reply tone and the knowledge
it drafts from. Mail from an address uses its product automatically -- the alias
first, then the domain.

Every domain starts as a product of its own. Name a product by its id (prd_...)
or its slug. Editing is administrator-only.`,
		"cloudmail product list",
		"cloudmail product get acme",
		"cloudmail product update acme --display-name \"Acme Analytics\" --signature-file sig.html",
	)
	c.AddCommand(productList(a), productGet(a), productUpdate(a))
	return c
}

func productList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List products and the domains they cover",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			products, err := a.Client.ListProducts(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    products,
				Columns: productColumns(),
				Summary: fmt.Sprintf("%d product(s)", len(products)),
				Empty:   "no products -- add a domain with `cloudmail domain add` and it gets one",
			})
		},
	}
}

func productGet(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "get <id-or-slug>",
		Short: "Show one product",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			p, err := a.Client.GetProduct(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: p, Columns: productDetailColumns()})
		},
	}
}

func productUpdate(a *App) *cobra.Command {
	var (
		name, displayName, accent, tone, knowledge, knowledgeURL string
		signatureFile, knowledgeFile                             string
		domains, aliases, templates                              []string
	)
	c := &cobra.Command{
		Use:   "update <id-or-slug>",
		Short: "Change a product's identity",
		Long: strings.TrimSpace(`
Change only what you pass. An empty value clears a field: --accent "" goes back
to the default colour, --signature-file /dev/null removes the signature.

--domain and --alias replace the whole list. A domain or alias can belong to one
product at a time; the server refuses one that another product holds.`),
		Example: exampleBlock(
			"# Rename and recolour",
			`cloudmail product update acme --display-name "Acme Analytics" --accent "#0F766E"`,
			"",
			"# Give the agent a voice and some facts",
			`cloudmail product update acme --tone "Friendly and brief." --knowledge-file faq.txt`,
			"",
			"# Group two domains under one product",
			"cloudmail product update acme --domain acme.com --domain acme.io",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			var patch api.ProductPatch
			f := c.Flags()
			// Only flags actually passed reach the patch.
			assign := func(dst **string, flag string, v *string) {
				if f.Changed(flag) {
					*dst = v
				}
			}
			assign(&patch.Name, "name", &name)
			assign(&patch.DisplayName, "display-name", &displayName)
			assign(&patch.AccentColor, "accent", &accent)
			assign(&patch.AgentPrompt, "tone", &tone)
			assign(&patch.KnowledgeText, "knowledge", &knowledge)
			assign(&patch.KnowledgeURL, "knowledge-url", &knowledgeURL)
			if f.Changed("signature-file") {
				body, err := readTextFile(signatureFile, "signature")
				if err != nil {
					return err
				}
				patch.SignatureHTML = &body
			}
			if f.Changed("knowledge-file") {
				if f.Changed("knowledge") {
					return fail.Usagef("--knowledge and --knowledge-file both set the knowledge text").
						WithRemediation("pass one of them")
				}
				body, err := readTextFile(knowledgeFile, "knowledge")
				if err != nil {
					return err
				}
				patch.KnowledgeText = &body
			}
			if f.Changed("domain") {
				patch.Domains = &domains
			}
			if f.Changed("alias") {
				patch.Aliases = &aliases
			}
			if f.Changed("template") {
				patch.DefaultTemplates = &templates
			}
			p, err := a.Client.UpdateProduct(a.Ctx(c), args[0], patch)
			if err != nil {
				return err
			}
			if a.Client.DryRun() {
				return nil
			}
			return a.emit(output.Result{Data: p, Columns: productDetailColumns(), Summary: "updated " + p.Name})
		},
	}
	f := c.Flags()
	f.StringVar(&name, "name", "", "internal name")
	f.StringVar(&displayName, "display-name", "", "name recipients see")
	f.StringVar(&accent, "accent", "", "accent colour as #RRGGBB")
	f.StringVar(&tone, "tone", "", "reply tone appended to the agent's prompt")
	f.StringVar(&knowledge, "knowledge", "", "facts the agent drafts from")
	f.StringVar(&knowledgeFile, "knowledge-file", "", "read --knowledge from a file")
	f.StringVar(&knowledgeURL, "knowledge-url", "", "https page to fetch knowledge from (refresh in Settings)")
	f.StringVar(&signatureFile, "signature-file", "", "default signature, HTML, from a file")
	f.StringSliceVar(&domains, "domain", nil, "domains this product covers (repeatable; replaces the list)")
	f.StringSliceVar(&aliases, "alias", nil, "extra addresses this product signs as (repeatable; replaces the list)")
	f.StringSliceVar(&templates, "template", nil, "default template slugs (repeatable; replaces the list)")
	f.SortFlags = false
	return c
}

// readTextFile reads a small text file for a flag, refusing anything large
// enough to be a mistake.
func readTextFile(name, what string) (string, error) {
	const max = 64 * 1024
	info, err := os.Stat(name)
	if err != nil {
		return "", fail.Usagef("cannot read the %s file: %v", what, err)
	}
	if info.Size() > max {
		return "", fail.Usagef("the %s file is %d bytes; the limit is %d", what, info.Size(), max)
	}
	b, err := os.ReadFile(name)
	if err != nil {
		return "", fail.Usagef("cannot read the %s file: %v", what, err)
	}
	return string(b), nil
}

func productColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 24},
		{Header: "slug", Field: "slug", Truncate: 20},
		{Header: "name", Field: "name", Value: productName, Truncate: 28},
		{Header: "domains", Field: "domains", Value: joinField("domains"), Truncate: 40},
		{Header: "aliases", Field: "aliases", Value: countField("aliases"), Right: true},
		{Header: "signature", Field: "signatureHtml", Value: presentField("signatureHtml")},
	}
}

func productDetailColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id"},
		{Header: "slug", Field: "slug"},
		{Header: "name", Field: "name"},
		{Header: "display name", Field: "displayName"},
		{Header: "accent", Field: "accentColor"},
		{Header: "domains", Field: "domains", Value: joinField("domains")},
		{Header: "aliases", Field: "aliases", Value: joinField("aliases")},
		{Header: "signature", Field: "signatureHtml", Value: presentField("signatureHtml")},
		{Header: "tone", Field: "agentPrompt", Truncate: 60},
		{Header: "knowledge url", Field: "knowledgeUrl"},
		{Header: "templates", Field: "defaultTemplates", Value: joinField("defaultTemplates")},
		{Header: "logo", Field: "logoUrl"},
	}
}

// unifiedColumns is `mail list --all`: the usual row plus mailbox and product.
func unifiedColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 22},
		{Header: "", Field: "flags", Value: emailFlags, Decorative: true},
		{Header: "product", Field: "product", Value: unifiedProduct, Truncate: 14},
		{Header: "mailbox", Field: "mailboxId", Truncate: 26},
		{Header: "from", Field: "sender", Truncate: 26},
		{Header: "subject", Field: "subject", Truncate: 44},
		{Header: "date", Field: "date", Value: relativeDate, Truncate: 16},
	}
}

func productName(row map[string]any) string {
	if v, ok := row["displayName"].(string); ok && v != "" {
		return v
	}
	s, _ := row["name"].(string)
	return s
}

func unifiedProduct(row map[string]any) string {
	p, _ := row["product"].(map[string]any)
	s, _ := p["name"].(string)
	return s
}

func joinField(field string) func(map[string]any) string {
	return func(row map[string]any) string {
		items, _ := row[field].([]any)
		parts := make([]string, 0, len(items))
		for _, it := range items {
			if s, ok := it.(string); ok {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, ", ")
	}
}

func countField(field string) func(map[string]any) string {
	return func(row map[string]any) string {
		items, _ := row[field].([]any)
		return fmt.Sprintf("%d", len(items))
	}
}

func presentField(field string) func(map[string]any) string {
	return func(row map[string]any) string {
		if s, ok := row[field].(string); ok && strings.TrimSpace(s) != "" {
			return "yes"
		}
		return "-"
	}
}
