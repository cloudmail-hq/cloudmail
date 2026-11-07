package api

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// Bring-your-own AI gateway: providers, their model catalogues, and routing.
//
// Every route is administrator-only. Reads, discover and test accept an
// admin-scoped API token. Config changes (create, models, routing) need a
// signed-in browser session; an API token gets 403 with code person_required.

// AIRoles is the role vocabulary, kept in step with AI_ROLES in
// shared/ai-providers.ts. injection_scanner is listed but never routable.
var AIRoles = []string{
	"agent_chat", "auto_draft", "nudge", "summary", "triage",
	"followup_classifier", "injection_scanner", "draft_verifier",
	"embeddings", "ask_answer", "daily_brief",
}

// AIPinnedRoles always run on Workers AI.
var AIPinnedRoles = []string{"injection_scanner"}

// AIWires, AIAuthSchemes, AIChecks and AIEmbeddingModes are the enums the
// server accepts.
var (
	AIWires          = []string{"anthropic", "openai"}
	AIAuthSchemes    = []string{"bearer", "x-api-key", "api-key", "custom", "none"}
	AIChecks         = []string{"text", "json", "tools", "embed"}
	AIEmbeddingModes = []string{"gateway", "workers-ai", "off"}
	AICaps           = []string{"tools", "json", "vision", "embed"}
)

// AIProviderAuth is how the gateway token is presented. Header is set only for
// the custom scheme.
type AIProviderAuth struct {
	Scheme string `json:"scheme"`
	Header string `json:"header,omitempty"`
}

// AIProviderHeader is one extra request header. A secret header's value is
// never returned.
type AIProviderHeader struct {
	Name   string  `json:"name"`
	Secret bool    `json:"secret"`
	Value  *string `json:"value,omitempty"`
	Set    bool    `json:"set"`
}

// AICatalogue summarises the last model discovery.
type AICatalogue struct {
	FetchedAt *string `json:"fetchedAt"`
	Status    string  `json:"status"`
	Detail    *string `json:"detail,omitempty"`
	Count     int     `json:"count"`
}

// AIBreaker is the provider's circuit breaker.
type AIBreaker struct {
	State     string `json:"state"`
	OpenUntil *int64 `json:"openUntil"`
}

// AICap is one capability value and where it came from: provider, hint
// (inferred), probe (tested) or admin.
type AICap struct {
	Value  *bool  `json:"value"`
	Source string `json:"source"`
}

// AIModel is one catalogue entry.
type AIModel struct {
	ID              string           `json:"id"`
	Label           string           `json:"label,omitempty"`
	Kind            string           `json:"kind"`
	ContextTokens   *int             `json:"contextTokens"`
	MaxOutputTokens *int             `json:"maxOutputTokens"`
	Caps            map[string]AICap `json:"caps"`
	EmbeddingDims   *int             `json:"embeddingDims,omitempty"`
	Lifecycle       json.RawMessage  `json:"lifecycle,omitempty"`
	Pricing         json.RawMessage  `json:"pricing,omitempty"`
	Tier            json.RawMessage  `json:"tier,omitempty"`
	Custom          bool             `json:"custom,omitempty"`
	TestedAt        json.RawMessage  `json:"testedAt,omitempty"`
}

// AIProvider is a configured gateway. The token itself is never returned,
// only TokenHint.
type AIProvider struct {
	ID             string             `json:"id"`
	Label          string             `json:"label"`
	Wire           string             `json:"wire"`
	BaseURL        string             `json:"baseUrl"`
	ExactBaseURL   bool               `json:"exactBaseUrl"`
	APIBase        string             `json:"apiBase"`
	Auth           AIProviderAuth     `json:"auth"`
	TokenSet       bool               `json:"tokenSet"`
	TokenHint      *string            `json:"tokenHint"`
	Headers        []AIProviderHeader `json:"headers"`
	Options        json.RawMessage    `json:"options,omitempty"`
	Enabled        bool               `json:"enabled"`
	Catalogue      AICatalogue        `json:"catalogue"`
	Models         []AIModel          `json:"models"`
	NeedsCustomIDs bool               `json:"needsCustomIds"`
	Breaker        AIBreaker          `json:"breaker"`
	CreatedAt      string             `json:"createdAt,omitempty"`
	UpdatedAt      string             `json:"updatedAt,omitempty"`
}

// AIModelRef names a model, on the routing's gateway unless ProviderID says
// otherwise.
type AIModelRef struct {
	ProviderID string `json:"providerId,omitempty"`
	ModelID    string `json:"modelId"`
}

// AIRouting is which gateway is active and which model each role uses.
type AIRouting struct {
	GatewayProviderID   *string               `json:"gatewayProviderId"`
	Models              map[string]AIModelRef `json:"models"`
	Default             *AIModelRef           `json:"default,omitempty"`
	FallbackToWorkersAI bool                  `json:"fallbackToWorkersAi"`
	WorkersAIExceptions []string              `json:"workersAiExceptions"`
	DisabledRoles       []string              `json:"disabledRoles"`
	EmbeddingsMode      string                `json:"embeddingsMode"`
}

// AIRoleInfo describes a role and the capability it needs.
type AIRoleInfo struct {
	Role   string `json:"role"`
	Label  string `json:"label"`
	Needs  string `json:"needs"`
	Pinned bool   `json:"pinned"`
}

// AIRoleProblem is a role whose model fails its capability check.
type AIRoleProblem struct {
	Role   string `json:"role"`
	Reason string `json:"reason"`
}

// AIProviderList is the GET /ai/providers envelope.
type AIProviderList struct {
	Providers     []AIProvider    `json:"providers"`
	Routing       AIRouting       `json:"routing"`
	Problems      []AIRoleProblem `json:"problems"`
	Roles         []AIRoleInfo    `json:"roles"`
	AuthSecretSet bool            `json:"authSecretSet"`
}

// AIRoutingResult is the routing envelope.
type AIRoutingResult struct {
	Routing  AIRouting       `json:"routing"`
	Problems []AIRoleProblem `json:"problems"`
}

// AITestResult is one check of a model test.
type AITestResult struct {
	Check string  `json:"check"`
	OK    bool    `json:"ok"`
	MS    int     `json:"ms"`
	Error *string `json:"error,omitempty"`
	Dims  *int    `json:"dims,omitempty"`
}

// AITestResponse is the POST .../test envelope.
type AITestResponse struct {
	Results  []AITestResult `json:"results"`
	Provider *AIProvider    `json:"provider,omitempty"`
}

// AIHeaderInput is one header on create.
type AIHeaderInput struct {
	Name   string `json:"name"`
	Value  string `json:"value,omitempty"`
	Secret bool   `json:"secret,omitempty"`
}

// AIProviderInput is the body of POST /ai/providers.
type AIProviderInput struct {
	Label        string          `json:"label"`
	Wire         string          `json:"wire"`
	BaseURL      string          `json:"baseUrl"`
	ExactBaseURL bool            `json:"exactBaseUrl,omitempty"`
	Auth         AIProviderAuth  `json:"auth"`
	Token        string          `json:"token,omitempty"`
	Headers      []AIHeaderInput `json:"headers,omitempty"`
}

// AIRoutingPatch is the body of PATCH /ai/routing. Nil fields are omitted; a
// nil value inside Models or a set ClearDefault sends null, which clears it.
type AIRoutingPatch struct {
	// GatewayProviderID is set by activate. SetGateway distinguishes "send
	// null" (deactivate) from "leave alone".
	SetGateway        bool
	GatewayProviderID *string
	Models            map[string]*string
	SetDefault        bool
	Default           *string
	Fallback          *bool
	Embeddings        string
}

func (p AIRoutingPatch) body() map[string]any {
	b := map[string]any{}
	if p.SetGateway {
		b["gatewayProviderId"] = p.GatewayProviderID
	}
	if len(p.Models) > 0 {
		b["models"] = p.Models
	}
	if p.SetDefault {
		b["default"] = p.Default
	}
	if p.Fallback != nil {
		b["fallbackToWorkersAi"] = *p.Fallback
	}
	if p.Embeddings != "" {
		b["embeddings"] = p.Embeddings
	}
	return b
}

// AIModelAdd is one custom model to add to a catalogue.
type AIModelAdd struct {
	ID   string `json:"id"`
	Kind string `json:"kind,omitempty"`
}

// AIModelsPatch is the body of PATCH /ai/providers/:id/models. Each Caps entry
// maps a capability to true, false or nil (clear the admin override).
type AIModelsPatch struct {
	Add    []AIModelAdd     `json:"add,omitempty"`
	Remove []string         `json:"remove,omitempty"`
	Caps   []map[string]any `json:"caps,omitempty"`
}

type aiProviderEnvelope struct {
	Provider AIProvider `json:"provider"`
}

const aiPersonNote = "needs a signed-in browser session; an API token is refused " +
	"with 403 person_required"

func aiProviderPath(id string, rest ...string) (string, error) {
	seg, err := pathSegment("provider id", id)
	if err != nil {
		return "", err
	}
	return path(append([]string{"ai", "providers", seg}, rest...)...), nil
}

// ListAIProviders returns the providers, routing, role problems and roles.
func (c *Client) ListAIProviders(ctx context.Context) (*AIProviderList, error) {
	var out AIProviderList
	if err := c.get(ctx, path("ai", "providers"), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateAIProvider adds a gateway. The token travels only in the body.
func (c *Client) CreateAIProvider(ctx context.Context, in AIProviderInput) (*AIProvider, error) {
	if !contains(AIWires, in.Wire) {
		return nil, fail.Usagef("--wire must be one of %s", strings.Join(AIWires, ", "))
	}
	if !contains(AIAuthSchemes, in.Auth.Scheme) {
		return nil, fail.Usagef("--auth must be one of %s", strings.Join(AIAuthSchemes, ", "))
	}
	if in.Auth.Scheme == "custom" && strings.TrimSpace(in.Auth.Header) == "" {
		return nil, fail.Usagef("--auth custom needs --auth-header NAME")
	}
	if in.Auth.Scheme != "custom" && in.Auth.Header != "" {
		return nil, fail.Usagef("--auth-header only applies with --auth custom")
	}
	var out aiProviderEnvelope
	resp, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       path("ai", "providers"),
		Keyed:      true,
		Body:       in,
		Reversible: true,
		Note:       "adds the provider; it is not used until activated. " + aiPersonNote,
	}, &out)
	if err != nil {
		return nil, err
	}
	if resp.Preview != nil {
		// Redact the token from the preview: a dry run prints the body.
		redactPreviewToken(resp.Preview)
	}
	return &out.Provider, nil
}

// redactPreviewToken replaces the token in a dry-run preview body.
func redactPreviewToken(p *Preview) {
	var m map[string]any
	if json.Unmarshal(p.Body, &m) != nil {
		return
	}
	if _, ok := m["token"]; ok {
		m["token"] = "[redacted]"
	}
	if hs, ok := m["headers"].([]any); ok {
		for _, h := range hs {
			if hm, ok := h.(map[string]any); ok && hm["secret"] == true {
				hm["value"] = "[redacted]"
			}
		}
	}
	if raw, err := json.Marshal(m); err == nil {
		p.Body = raw
	}
}

// DiscoverAIModels refreshes a provider's catalogue from its model listing.
func (c *Client) DiscoverAIModels(ctx context.Context, id string) (*AIProvider, error) {
	route, err := aiProviderPath(id, "discover")
	if err != nil {
		return nil, err
	}
	var out aiProviderEnvelope
	_, err = c.mutate(ctx, Request{
		Method:     "POST",
		Path:       route,
		Idempotent: true,
		Reversible: true,
		Note:       "asks the gateway for its model list and stores the catalogue",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out.Provider, nil
}

// TestAIModel runs live checks against one model. Empty checks lets the server
// pick the defaults for the model's kind.
func (c *Client) TestAIModel(ctx context.Context, id, model string, checks []string) (*AITestResponse, error) {
	route, err := aiProviderPath(id, "test")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(model) == "" {
		return nil, fail.Usagef("no model given").
			WithRemediation("pass --model; `cloudmail ai provider discover %s` lists them", id)
	}
	for _, ch := range checks {
		if !contains(AIChecks, ch) {
			return nil, fail.Usagef("unknown check %q", ch).
				WithRemediation("use %s", strings.Join(AIChecks, ", "))
		}
	}
	body := map[string]any{"modelId": model}
	if len(checks) > 0 {
		body["checks"] = checks
	}
	var out AITestResponse
	_, err = c.mutate(ctx, Request{
		Method:     "POST",
		Path:       route,
		Body:       body,
		Idempotent: true,
		Reversible: true,
		Note:       "sends small live requests to the gateway (billed by it) and records the results",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// PatchAIModels adds or removes custom models and sets capability overrides.
func (c *Client) PatchAIModels(ctx context.Context, id string, in AIModelsPatch) (*AIProvider, error) {
	route, err := aiProviderPath(id, "models")
	if err != nil {
		return nil, err
	}
	if len(in.Add)+len(in.Remove)+len(in.Caps) == 0 {
		return nil, fail.Usagef("nothing to change").
			WithRemediation("pass --add, --remove or --cap")
	}
	var out aiProviderEnvelope
	_, err = c.mutate(ctx, Request{
		Method:     "PATCH",
		Path:       route,
		Body:       in,
		Idempotent: true,
		Reversible: true,
		Note:       "edits the provider's model catalogue. " + aiPersonNote,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out.Provider, nil
}

// PatchAIRouting changes routing. A 422 carries the per-role problems as
// error details.
func (c *Client) PatchAIRouting(ctx context.Context, p AIRoutingPatch) (*AIRoutingResult, error) {
	for role := range p.Models {
		if err := ValidateAIRole(role); err != nil {
			return nil, err
		}
	}
	if p.Embeddings != "" && !contains(AIEmbeddingModes, p.Embeddings) {
		return nil, fail.Usagef("--embeddings must be one of %s", strings.Join(AIEmbeddingModes, ", "))
	}
	body := p.body()
	if len(body) == 0 {
		return nil, fail.Usagef("nothing to change").
			WithRemediation("pass role=model pairs, --default, --fallback or --embeddings")
	}
	note := "changes which models AI features use. " + aiPersonNote
	if p.SetGateway {
		note = "switches the active AI gateway for every routed feature. " + aiPersonNote
	}
	var out AIRoutingResult
	_, err := c.mutate(ctx, Request{
		Method:     "PATCH",
		Path:       path("ai", "routing"),
		Body:       body,
		Idempotent: true,
		Reversible: true,
		Note:       note,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ValidateAIRole refuses an unknown or pinned role before anything is sent.
func ValidateAIRole(role string) error {
	if contains(AIPinnedRoles, role) {
		return fail.Usagef("%s always runs on Workers AI and cannot be routed", role)
	}
	if !contains(AIRoles, role) {
		return fail.Usagef("unknown role %q", role).
			WithRemediation("roles: %s", strings.Join(routableRoles(), ", "))
	}
	return nil
}

func routableRoles() []string {
	out := make([]string, 0, len(AIRoles))
	for _, r := range AIRoles {
		if !contains(AIPinnedRoles, r) {
			out = append(out, r)
		}
	}
	return out
}
