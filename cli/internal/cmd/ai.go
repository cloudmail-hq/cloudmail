package cmd

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

// personOnly is appended to the help of commands an API token cannot run.
const personOnly = `
Needs a signed-in browser session. An API token, even an admin one, gets 403
person_required by design, so make this change in the web app when using a token.`

func newAICommand(a *App) *cobra.Command {
	c := group("ai", "AI providers: where AI runs, models and routing", `
By default every AI feature runs on the built-in provider, Cloudflare Workers AI,
and an administrator can pick the Workers AI model for each feature. They can
also add their own gateway (any OpenAI- or Anthropic-compatible endpoint) and
route each feature to one of its models.`,
		"cloudmail ai status",
		"cloudmail ai models list --task text",
		"cloudmail ai route agent_chat @cf/moonshotai/kimi-k2.6 --provider workers-ai",
		"cloudmail ai provider list",
	)
	c.AddCommand(aiStatusCommand(a), aiModelsCommand(a), aiRouteCommand(a), newAIProviderCommand(a))
	return c
}

func newAIProviderCommand(a *App) *cobra.Command {
	c := group("provider", "Bring-your-own AI gateways and per-feature model routing", `
Administrator-only. list, discover and test work with an admin-scoped API token.
add, models, route and activate change configuration and need a signed-in browser
session: an API token gets 403 person_required, by design.

The prompt-injection scanner always runs on Workers AI and cannot be routed.`,
		"cloudmail ai provider list",
		"cloudmail ai provider add --label OpenRouter --wire openai --base-url https://openrouter.ai/api/v1",
		"cloudmail ai provider discover openrouter",
		"cloudmail ai provider test openrouter --model openai/gpt-4o-mini",
		"cloudmail ai provider route summary=openai/gpt-4o-mini triage= --fallback on",
		"cloudmail ai provider activate openrouter",
	)
	c.AddCommand(
		aiProviderList(a), aiProviderAdd(a), aiProviderDiscover(a), aiProviderTest(a),
		aiProviderModels(a), aiProviderRoute(a), aiProviderActivate(a),
	)
	return c
}

func aiProviderList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List gateways, the model each feature uses, and any problems",
		Long: strings.TrimSpace(`
List the configured gateways, then the model each AI feature is routed to and any
feature whose model lacks a capability it needs. Tokens are never shown, only
their last characters.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			list, err := a.Client.ListAIProviders(a.Ctx(c))
			if err != nil {
				return err
			}
			active := ""
			if list.Routing.GatewayProviderID != nil {
				active = *list.Routing.GatewayProviderID
			}
			gateway := "Workers AI (no gateway active)"
			if active != "" {
				gateway = "active gateway: " + active
			}
			if err := a.emit(output.Result{
				Data:    list,
				Rows:    list.Providers,
				Columns: aiProviderColumns(active),
				Summary: fmt.Sprintf("%d provider(s); %s", len(list.Providers), gateway),
				Empty:   "no providers -- add one with `cloudmail ai provider add`",
			}); err != nil {
				return err
			}
			if a.Out.Format() != output.Table {
				return nil
			}
			if err := a.section("Routing", output.Result{
				Data:    aiRoutingRows(list),
				Columns: aiRoutingColumns(),
			}); err != nil {
				return err
			}
			if len(list.Problems) > 0 {
				out := a.Out.Out()
				fmt.Fprintln(out)
				fmt.Fprintln(out, a.Out.Bold("Problems"))
				for _, p := range list.Problems {
					fmt.Fprintf(out, "  %s: %s\n", p.Role, p.Reason)
				}
			}
			return nil
		},
	}
}

func aiProviderAdd(a *App) *cobra.Command {
	var (
		in                api.AIProviderInput
		headers, secrets  []string
		tokenStdin, exact bool
	)
	c := &cobra.Command{
		Use:   "add",
		Short: "Add a gateway",
		Long: strings.TrimSpace(`
Add a gateway. It is not used until ` + "`cloudmail ai provider activate`" + `.

The token is never a flag. At a terminal you are prompted for it without echo;
otherwise pipe it in with --token-stdin. With --auth none no token is sent.

--auth defaults to x-api-key for --wire anthropic and bearer for openai
(api-key for Azure hosts). --secret-header values are stored encrypted and never
shown again, but they do pass through argv and shell history.
` + personOnly),
		Example: exampleBlock(
			"cloudmail ai provider add --label OpenRouter --wire openai \\",
			"    --base-url https://openrouter.ai/api/v1",
			"",
			"# Token from a secrets manager, never in shell history",
			"op read op://ai/gateway/token | cloudmail ai provider add --label Corp \\",
			"    --wire anthropic --base-url https://llm.example.com --token-stdin",
		),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			in.ExactBaseURL = exact
			if in.Auth.Scheme == "" {
				in.Auth.Scheme = defaultAIAuth(in.Wire, in.BaseURL)
			}
			for _, raw := range headers {
				h, err := parseHeaderFlag("--header", raw, false)
				if err != nil {
					return err
				}
				in.Headers = append(in.Headers, h)
			}
			for _, raw := range secrets {
				h, err := parseHeaderFlag("--secret-header", raw, true)
				if err != nil {
					return err
				}
				in.Headers = append(in.Headers, h)
			}

			switch {
			case in.Auth.Scheme == "none":
				if tokenStdin {
					return fail.Usagef("--token-stdin has no effect with --auth none")
				}
			case tokenStdin || isStdinTerminal():
				token, err := readSecret(a, tokenStdin, "Paste the gateway token (input is hidden): ")
				if err != nil {
					return err
				}
				if strings.ContainsFunc(token, func(r rune) bool { return r < ' ' || r == 0x7f }) {
					return fail.Usagef("the token contains control characters")
				}
				in.Token = token
				if token == "" {
					a.Out.Warn("no token given; the provider is saved without one")
				}
			default:
				a.Out.Warn("stdin is not a terminal and --token-stdin was not given; " +
					"the provider is saved without a token")
			}

			p, err := a.Client.CreateAIProvider(a.Ctx(c), in)
			if err != nil {
				return err
			}
			if !a.DryRun() {
				a.Out.Info("next: `cloudmail ai provider discover %s`", p.ID)
			}
			return a.emitMutation(output.Result{Data: p, Columns: aiProviderColumns("")})
		},
	}
	f := c.Flags()
	f.StringVar(&in.Label, "label", "", "display name")
	f.StringVar(&in.Wire, "wire", "", "API dialect the gateway speaks: anthropic or openai")
	f.StringVar(&in.BaseURL, "base-url", "", "the gateway's https:// base URL")
	f.BoolVar(&exact, "exact-base-url", false, "use the base URL as given, without appending /v1")
	f.StringVar(&in.Auth.Scheme, "auth", "", "how the token is sent: bearer, x-api-key, api-key, custom, none")
	f.StringVar(&in.Auth.Header, "auth-header", "", "header name that carries the token, with --auth custom")
	f.StringArrayVar(&headers, "header", nil, "extra header NAME=VALUE (repeatable)")
	f.StringArrayVar(&secrets, "secret-header", nil, "extra secret header NAME=VALUE, stored encrypted (repeatable)")
	f.BoolVar(&tokenStdin, "token-stdin", false, "read the gateway token from stdin")
	_ = c.MarkFlagRequired("label")
	_ = c.MarkFlagRequired("wire")
	_ = c.MarkFlagRequired("base-url")
	return c
}

func aiProviderDiscover(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "discover <provider-id>",
		Short: "Refresh a gateway's model list",
		Long: strings.TrimSpace(`
Ask the gateway for its models and store the catalogue. When it comes back empty
the status says why: no-discovery (the gateway lists nothing, so add ids with
` + "`cloudmail ai provider models`" + `), auth-failed or error.

Capability badges: "inferred" is a guess from the model name, "tested" was
probed, "set by admin" is an override. A bare value came from the gateway.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			p, err := a.Client.DiscoverAIModels(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{
				Data:    p,
				Rows:    p.Models,
				Columns: aiModelColumns(),
				Summary: catalogueSummary(p.Catalogue),
				Empty:   "no models",
			})
		},
	}
}

func aiProviderTest(a *App) *cobra.Command {
	var model string
	var checks []string
	c := &cobra.Command{
		Use:   "test <provider-id>",
		Short: "Run live checks against one model",
		Long: strings.TrimSpace(`
Send small live requests to one model and report each check. The default checks
are text, json and tools for a chat model, and embed for an embedding model. The
gateway bills these calls as usual.

Exits 1 when any check fails.`),
		Example: exampleBlock(
			"cloudmail ai provider test openrouter --model openai/gpt-4o-mini",
			"cloudmail ai provider test openrouter --model openai/text-embedding-3-small --check embed",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			res, err := a.Client.TestAIModel(a.Ctx(c), args[0], model, checks)
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
				r.Summary = fmt.Sprintf("%s: %d check(s) passed", model, len(res.Results))
				return a.emitMutation(r)
			}
			if err := a.emit(r); err != nil {
				return err
			}
			return fail.Errf("%d of %d check(s) failed for %s", failed, len(res.Results), model).
				WithRemediation("route only the roles whose needs passed, or pick another model")
		},
	}
	c.Flags().StringVar(&model, "model", "", "the model id to test")
	c.Flags().StringSliceVar(&checks, "check", nil, "checks to run, comma-separated: text, json, tools, embed")
	_ = c.MarkFlagRequired("model")
	return c
}

func aiProviderModels(a *App) *cobra.Command {
	var adds, removes, caps []string
	c := &cobra.Command{
		Use:   "models <provider-id>",
		Short: "Add or remove custom model ids and override capabilities",
		Long: strings.TrimSpace(`
Edit a gateway's catalogue by hand: for gateways that list nothing (Azure,
Cloudflare AI Gateway), or to correct a capability.

--add ID adds a chat model; --add ID:embedding adds an embedding model.
--cap ID:CAP=on|off|clear sets or clears an override for tools, json, vision or
embed.
` + personOnly),
		Example: exampleBlock(
			"cloudmail ai provider models azure --add gpt-4o-prod --add embed-prod:embedding",
			"cloudmail ai provider models openrouter --cap acme/model-x:tools=off",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			in := api.AIModelsPatch{Remove: removes}
			for _, raw := range adds {
				in.Add = append(in.Add, parseModelAdd(raw))
			}
			patches, err := parseCapFlags(caps)
			if err != nil {
				return err
			}
			in.Caps = patches
			p, err := a.Client.PatchAIModels(a.Ctx(c), args[0], in)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{
				Data: p, Rows: p.Models, Columns: aiModelColumns(),
				Summary: catalogueSummary(p.Catalogue),
			})
		},
	}
	f := c.Flags()
	f.StringArrayVar(&adds, "add", nil, "custom model id to add, ID or ID:embedding (repeatable)")
	f.StringArrayVar(&removes, "remove", nil, "model id to remove (repeatable)")
	f.StringArrayVar(&caps, "cap", nil, "capability override ID:CAP=on|off|clear (repeatable)")
	return c
}

func aiProviderRoute(a *App) *cobra.Command {
	var def, fallback, embeddings string
	c := &cobra.Command{
		Use:   "route [<role>=<model>...]",
		Short: "Choose the model each AI feature uses",
		Long: strings.TrimSpace(`
Set the model for one or more roles. role= with no model clears the role, so it
uses --default. Models are on the active gateway.

Roles: ` + wrapList(routableRoles(), 72) + `.

The server checks each model has what its role needs (json, tools or embed). When
one does not, nothing is saved and each problem is printed as "role: reason"
(exit 12).
` + personOnly),
		Example: exampleBlock(
			"cloudmail ai provider route summary=openai/gpt-4o-mini triage=openai/gpt-4o-mini",
			"cloudmail ai provider route --default openai/gpt-4o --fallback on",
			"cloudmail ai provider route ask_answer= --embeddings workers-ai",
		),
		RunE: func(c *cobra.Command, args []string) error {
			p := api.AIRoutingPatch{Embeddings: embeddings}
			if len(args) > 0 {
				p.Models = map[string]*string{}
			}
			for _, raw := range args {
				role, model, ok := strings.Cut(raw, "=")
				role = strings.TrimSpace(role)
				if !ok || role == "" {
					return fail.Usagef("%q is not role=model", raw).
						WithRemediation("e.g. summary=openai/gpt-4o-mini, or summary= to clear it")
				}
				if _, dup := p.Models[role]; dup {
					return fail.Usagef("%s is given twice", role)
				}
				if m := strings.TrimSpace(model); m != "" {
					p.Models[role] = &m
				} else {
					p.Models[role] = nil
				}
			}
			if c.Flags().Changed("default") {
				p.SetDefault = true
				if d := strings.TrimSpace(def); d != "" {
					p.Default = &d
				}
			}
			if c.Flags().Changed("fallback") {
				v, err := onOff("--fallback", fallback)
				if err != nil {
					return err
				}
				p.Fallback = &v
			}
			res, err := a.Client.PatchAIRouting(a.Ctx(c), p)
			if err != nil {
				return err
			}
			return a.emitRouting(res, "routing saved")
		},
	}
	f := c.Flags()
	f.StringVar(&def, "default", "", `model for every role without its own (--default "" clears it)`)
	f.StringVar(&fallback, "fallback", "", "retry a failed gateway call once on Workers AI: on or off")
	f.StringVar(&embeddings, "embeddings", "", "semantic search vectors: gateway, workers-ai or off")
	return c
}

func aiProviderActivate(a *App) *cobra.Command {
	var off bool
	c := &cobra.Command{
		Use:   "activate <provider-id> | --off",
		Short: "Make a gateway the active one, or go back to Workers AI",
		Long: strings.TrimSpace(`
Route AI features through this gateway. Refused (exit 12, one "role: reason" line
per problem) while any routed role's model fails its capability check.

--off switches every feature back to Workers AI.
` + personOnly),
		Example: exampleBlock(
			"cloudmail ai provider activate openrouter",
			"cloudmail ai provider activate --off",
		),
		Args: cobra.MaximumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			p := api.AIRoutingPatch{SetGateway: true}
			switch {
			case off && len(args) > 0:
				return fail.Usagef("pass a provider id or --off, not both")
			case off:
				// GatewayProviderID nil sends null: deactivate.
			case len(args) == 1:
				id := strings.TrimSpace(args[0])
				if id == "" {
					return fail.Usagef("the provider id cannot be empty")
				}
				p.GatewayProviderID = &id
			default:
				return fail.Usagef("no provider given").
					WithRemediation("pass a provider id from `cloudmail ai provider list`, or --off")
			}
			res, err := a.Client.PatchAIRouting(a.Ctx(c), p)
			if err != nil {
				return err
			}
			msg := "AI features now run on Workers AI"
			if p.GatewayProviderID != nil {
				msg = "active gateway: " + *p.GatewayProviderID
			}
			return a.emitRouting(res, msg)
		},
	}
	c.Flags().BoolVar(&off, "off", false, "deactivate the gateway; everything runs on Workers AI")
	return c
}

// emitRouting renders a routing result, warning about any problems the server
// saved alongside it.
func (a *App) emitRouting(res *api.AIRoutingResult, summary string) error {
	if !a.DryRun() {
		for _, p := range res.Problems {
			a.Out.Warn("%s: %s", p.Role, p.Reason)
		}
	}
	rows := aiRoutingRows(&api.AIProviderList{Routing: res.Routing})
	return a.emitMutation(output.Result{
		Data: res, Rows: rows, Columns: aiRoutingColumns(), Summary: summary,
	})
}

// ── parsing ────────────────────────────────────────────────────────

func defaultAIAuth(wire, baseURL string) string {
	if u, err := url.Parse(baseURL); err == nil {
		h := strings.ToLower(u.Hostname())
		for _, azure := range []string{"openai.azure.com", "services.ai.azure.com", "cognitiveservices.azure.com"} {
			if h == azure || strings.HasSuffix(h, "."+azure) {
				return "api-key"
			}
		}
	}
	if wire == "anthropic" {
		return "x-api-key"
	}
	return "bearer"
}

func parseHeaderFlag(flag, raw string, secret bool) (api.AIHeaderInput, error) {
	name, value, ok := strings.Cut(raw, "=")
	name = strings.TrimSpace(name)
	if !ok || name == "" {
		return api.AIHeaderInput{}, fail.Usagef("%s %q is not NAME=VALUE", flag, redactHeaderArg(raw, secret))
	}
	return api.AIHeaderInput{Name: name, Value: value, Secret: secret}, nil
}

// redactHeaderArg keeps a secret header's value out of an error message.
func redactHeaderArg(raw string, secret bool) string {
	if secret {
		if name, _, ok := strings.Cut(raw, "="); ok {
			return name + "=…"
		}
		return "…"
	}
	return raw
}

func parseModelAdd(raw string) api.AIModelAdd {
	raw = strings.TrimSpace(raw)
	for _, kind := range []string{"embedding", "chat"} {
		if id, ok := strings.CutSuffix(raw, ":"+kind); ok && id != "" {
			return api.AIModelAdd{ID: id, Kind: kind}
		}
	}
	return api.AIModelAdd{ID: raw}
}

// parseCapFlags turns ID:CAP=on|off|clear flags into one patch per model id.
// The id may itself contain colons, so the last colon splits it.
func parseCapFlags(raw []string) ([]map[string]any, error) {
	byID := map[string]map[string]any{}
	var order []string
	for _, r := range raw {
		i := strings.LastIndex(r, ":")
		if i <= 0 {
			return nil, fail.Usagef("--cap %q is not ID:CAP=on|off|clear", r)
		}
		id, rest := r[:i], r[i+1:]
		capName, val, ok := strings.Cut(rest, "=")
		if !ok || !containsStr(api.AICaps, capName) {
			return nil, fail.Usagef("--cap %q is not ID:CAP=on|off|clear", r).
				WithRemediation("CAP is one of %s", strings.Join(api.AICaps, ", "))
		}
		var v any
		switch val {
		case "on":
			v = true
		case "off":
			v = false
		case "clear":
			v = nil
		default:
			return nil, fail.Usagef("--cap %q: the value must be on, off or clear", r)
		}
		m, seen := byID[id]
		if !seen {
			m = map[string]any{"id": id}
			byID[id] = m
			order = append(order, id)
		}
		m[capName] = v
	}
	out := make([]map[string]any, 0, len(order))
	for _, id := range order {
		out = append(out, byID[id])
	}
	return out, nil
}

func onOff(flag, v string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "on", "true", "yes":
		return true, nil
	case "off", "false", "no":
		return false, nil
	}
	return false, fail.Usagef("%s must be on or off", flag)
}

func routableRoles() []string {
	out := make([]string, 0, len(api.AIRoles))
	for _, r := range api.AIRoles {
		if !containsStr(api.AIPinnedRoles, r) {
			out = append(out, r)
		}
	}
	return out
}

func containsStr(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// ── views ──────────────────────────────────────────────────────────

func aiProviderColumns(active string) []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 24},
		{Header: "label", Field: "label", Truncate: 24},
		{Header: "wire", Field: "wire"},
		{Header: "host", Field: "baseUrl", Truncate: 32, Value: func(r map[string]any) string {
			raw := output.Stringify(r["baseUrl"])
			if u, err := url.Parse(raw); err == nil && u.Host != "" {
				return u.Host
			}
			return raw
		}},
		{Header: "active", Field: "active", Value: func(r map[string]any) string {
			if active != "" && output.Stringify(r["id"]) == active {
				return "yes"
			}
			if !truthy(r["enabled"]) {
				return "disabled"
			}
			return ""
		}},
		{Header: "catalogue", Field: "catalogue", Value: func(r map[string]any) string {
			cat, _ := r["catalogue"].(map[string]any)
			status := output.Stringify(cat["status"])
			if status == "ok" {
				return fmt.Sprintf("ok (%d)", intField(cat["count"]))
			}
			return status
		}},
		{Header: "token", Field: "tokenHint", Value: func(r map[string]any) string {
			if !truthy(r["tokenSet"]) {
				return "none"
			}
			if h := output.Stringify(r["tokenHint"]); h != "" {
				return h
			}
			return "set"
		}},
		{Header: "breaker", Field: "breaker", Value: func(r map[string]any) string {
			b, _ := r["breaker"].(map[string]any)
			return output.Stringify(b["state"])
		}},
	}
}

// aiRoutingRow is one role in the routing view.
type aiRoutingRow struct {
	Role     string `json:"role"`
	Label    string `json:"label,omitempty"`
	Model    string `json:"model"`
	Provider string `json:"provider"`
	Needs    string `json:"needs,omitempty"`
}

// aiRoutingRows resolves which model each role uses, in the server's role
// order when it sent one.
func aiRoutingRows(list *api.AIProviderList) []aiRoutingRow {
	r := list.Routing
	gateway := ""
	if r.GatewayProviderID != nil {
		gateway = *r.GatewayProviderID
	}
	roles := list.Roles
	if len(roles) == 0 {
		for _, id := range api.AIRoles {
			roles = append(roles, api.AIRoleInfo{Role: id, Pinned: containsStr(api.AIPinnedRoles, id)})
		}
	}
	rows := make([]aiRoutingRow, 0, len(roles))
	for _, info := range roles {
		row := aiRoutingRow{Role: info.Role, Label: info.Label, Needs: info.Needs,
			Provider: "workers-ai", Model: "(built-in)"}
		switch {
		case info.Pinned:
			row.Model = "(built-in, pinned)"
		case containsStr(r.DisabledRoles, info.Role),
			info.Role == "embeddings" && r.EmbeddingsMode == "off":
			row.Provider, row.Model = "-", "off"
		case gateway == "",
			containsStr(r.WorkersAIExceptions, info.Role),
			info.Role == "embeddings" && r.EmbeddingsMode == "workers-ai":
		default:
			ref, ok := r.Models[info.Role]
			if !ok && r.Default != nil && info.Role != "embeddings" {
				ref, ok = *r.Default, true
				ref.ModelID += " (default)"
			}
			if ok {
				row.Model, row.Provider = ref.ModelID, gateway
				if ref.ProviderID != "" {
					row.Provider = ref.ProviderID
				}
			} else {
				row.Model = "(not set)"
				row.Provider = gateway
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func aiRoutingColumns() []output.Column {
	return []output.Column{
		{Header: "role", Field: "role"},
		{Header: "needs", Field: "needs"},
		{Header: "provider", Field: "provider", Truncate: 24},
		{Header: "model", Field: "model", Truncate: 48},
	}
}

func aiModelColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 48},
		{Header: "kind", Field: "kind", Value: func(r map[string]any) string {
			k := output.Stringify(r["kind"])
			if truthy(r["custom"]) {
				k += " (custom)"
			}
			return k
		}},
		{Header: "tools", Field: "caps", Value: capBadge("tools")},
		{Header: "json", Field: "caps", Value: capBadge("json")},
		{Header: "embed", Field: "caps", Value: capBadge("embed")},
	}
}

// capBadge renders a capability as yes/no/? with where the value came from.
func capBadge(name string) func(map[string]any) string {
	return func(r map[string]any) string {
		caps, _ := r["caps"].(map[string]any)
		c, _ := caps[name].(map[string]any)
		if c == nil {
			return "?"
		}
		v := "?"
		switch c["value"] {
		case true:
			v = "yes"
		case false:
			v = "no"
		}
		switch output.Stringify(c["source"]) {
		case "hint":
			v += " (inferred)"
		case "probe":
			v += " (tested)"
		case "admin":
			v += " (set by admin)"
		}
		return v
	}
}

func aiTestColumns() []output.Column {
	return []output.Column{
		{Header: "check", Field: "check"},
		{Header: "result", Field: "ok", Value: func(r map[string]any) string {
			if truthy(r["ok"]) {
				return "ok"
			}
			return "FAIL"
		}},
		{Header: "ms", Field: "ms", Right: true},
		{Header: "dims", Field: "dims", Right: true},
		{Header: "error", Field: "error", Truncate: 60},
	}
}

func catalogueSummary(c api.AICatalogue) string {
	s := fmt.Sprintf("%d model(s), catalogue %s", c.Count, c.Status)
	if c.Detail != nil && *c.Detail != "" {
		s += ": " + *c.Detail
	}
	return s
}

// wrapList joins items with ", ", breaking lines before they pass width.
func wrapList(items []string, width int) string {
	var b strings.Builder
	line := 0
	for i, it := range items {
		if i > 0 {
			b.WriteString(",")
			line++
			if line+len(it)+1 > width {
				b.WriteString("\n")
				line = 0
			} else {
				b.WriteString(" ")
				line++
			}
		}
		b.WriteString(it)
		line += len(it)
	}
	return b.String()
}
