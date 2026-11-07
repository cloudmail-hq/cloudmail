package api

import (
	"context"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// The built-in provider, Cloudflare Workers AI: its catalogue, the model each
// role uses on it, and where AI runs overall.

// WorkersAIProviderID is the reserved id of the built-in provider.
const WorkersAIProviderID = "workers-ai"

// WorkersAITasks are the catalogue task filters the server accepts.
var WorkersAITasks = []string{"Text Generation", "Text Embeddings"}

// WorkersAICap is a capability and where it came from: provider, hint or probe.
type WorkersAICap struct {
	Value  *bool  `json:"value"`
	Source string `json:"source"`
}

// WorkersAIPrice is USD per million tokens.
type WorkersAIPrice struct {
	Input  *float64 `json:"input"`
	Output *float64 `json:"output"`
}

// WorkersAIModel is one catalogue entry.
type WorkersAIModel struct {
	ID            string          `json:"id"`
	Task          string          `json:"task"`
	Description   string          `json:"description,omitempty"`
	ContextTokens *int            `json:"contextTokens"`
	Tools         WorkersAICap    `json:"tools"`
	JSON          WorkersAICap    `json:"json"`
	Reasoning     bool            `json:"reasoning"`
	Vision        bool            `json:"vision"`
	Dims          *int            `json:"dims"`
	Price         *WorkersAIPrice `json:"price"`
	Beta          bool            `json:"beta"`
	Paid          bool            `json:"paid"`
	Deprecated    bool            `json:"deprecated"`
}

// WorkersAIUnlisted is set when a role's model is no longer in Cloudflare's
// catalogue, with the suggested replacement.
type WorkersAIUnlisted struct {
	Successor *string `json:"successor"`
}

// WorkersAIRoleModel is a role's model in the catalogue response.
type WorkersAIRoleModel struct {
	Role     string             `json:"role"`
	ModelID  string             `json:"modelId"`
	Unlisted *WorkersAIUnlisted `json:"unlisted"`
}

// WorkersAICatalogue is GET /ai/providers/workers-ai/models.
type WorkersAICatalogue struct {
	Source    string               `json:"source"`
	FetchedAt string               `json:"fetchedAt"`
	Detail    *string              `json:"detail"`
	Count     int                  `json:"count"`
	Models    []WorkersAIModel     `json:"models"`
	Roles     []WorkersAIRoleModel `json:"roles"`
}

// WorkersAIRole is one role on the built-in provider.
type WorkersAIRole struct {
	Role           string `json:"role"`
	ModelID        string `json:"modelId"`
	DefaultModelID string `json:"defaultModelId"`
	Source         string `json:"source"`
	Locked         bool   `json:"locked"`
}

// WorkersAIProvider is the built-in provider's view.
type WorkersAIProvider struct {
	ID      string          `json:"id"`
	Label   string          `json:"label"`
	BuiltIn bool            `json:"builtIn"`
	Roles   []WorkersAIRole `json:"roles"`
}

// AIStatusException is something that does not follow the active provider.
type AIStatusException struct {
	Role *string `json:"role"`
	Text string  `json:"text"`
}

// AIStatus says where AI runs.
type AIStatus struct {
	Mode             string              `json:"mode"`
	ActiveProviderID string              `json:"activeProviderId"`
	ActiveLabel      string              `json:"activeLabel"`
	Line             string              `json:"line"`
	Exceptions       []AIStatusException `json:"exceptions"`
}

// AIProviderUsage is one provider's model requests this month.
type AIProviderUsage struct {
	ProviderID   string   `json:"providerId"`
	Calls        int      `json:"calls"`
	InputTokens  *int     `json:"inputTokens"`
	OutputTokens *int     `json:"outputTokens"`
	CostUSD      *float64 `json:"costUsd"`
}

// AIUsage is this month's requests per provider.
type AIUsage struct {
	Month      string            `json:"month"`
	ByProvider []AIProviderUsage `json:"byProvider"`
}

// AIStatusResponse is the part of GET /ai/providers that `ai status` shows.
type AIStatusResponse struct {
	Status    AIStatus          `json:"status"`
	WorkersAI WorkersAIProvider `json:"workersAi"`
	Providers []AIProvider      `json:"providers"`
	Routing   AIRouting         `json:"routing"`
	Roles     []AIRoleInfo      `json:"roles"`
	Usage     AIUsage           `json:"usage"`
}

// WorkersAIRoutingResult is PATCH /ai/providers/workers-ai/routing.
type WorkersAIRoutingResult struct {
	WorkersAI WorkersAIProvider `json:"workersAi"`
	Status    AIStatus          `json:"status"`
	Reindex   bool              `json:"reindex"`
}

// AIStatusFull reads where AI runs, the built-in provider's models and usage.
func (c *Client) AIStatusFull(ctx context.Context) (*AIStatusResponse, error) {
	var out AIStatusResponse
	if err := c.get(ctx, path("ai", "providers"), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListWorkersAIModels reads the Workers AI catalogue, optionally for one task.
func (c *Client) ListWorkersAIModels(ctx context.Context, task, search string) (*WorkersAICatalogue, error) {
	if task != "" && !contains(WorkersAITasks, task) {
		return nil, fail.Usagef("--task must be one of: %s", strings.Join(WorkersAITasks, ", "))
	}
	var out WorkersAICatalogue
	q := NewQuery().Str("task", task).Str("search", search)
	if err := c.get(ctx, path("ai", "providers", WorkersAIProviderID, "models"), q, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// IsWorkersAIModelID reports whether id looks like a Workers AI model id.
func IsWorkersAIModelID(id string) bool {
	return strings.HasPrefix(id, "@cf/") || strings.HasPrefix(id, "@hf/")
}

// RouteWorkersAI sets (or with a nil model, resets) a role's Workers AI model.
func (c *Client) RouteWorkersAI(ctx context.Context, role string, model *string, confirmReindex bool) (*WorkersAIRoutingResult, error) {
	if contains(AIPinnedRoles, role) {
		return nil, fail.Usagef("%s's model is fixed: it is the security gate", role)
	}
	if !contains(AIRoles, role) {
		return nil, fail.Usagef("unknown role %q", role).
			WithRemediation("roles: %s", strings.Join(routableRoles(), ", "))
	}
	if model != nil && !IsWorkersAIModelID(*model) {
		return nil, fail.Usagef("Workers AI model ids start with @cf/ or @hf/")
	}
	body := map[string]any{"models": map[string]*string{role: model}}
	if confirmReindex {
		body["confirmReindex"] = true
	}
	var out WorkersAIRoutingResult
	_, err := c.mutate(ctx, Request{
		Method:     "PATCH",
		Path:       path("ai", "providers", WorkersAIProviderID, "routing"),
		Body:       body,
		Idempotent: true,
		Reversible: true,
		Note:       "changes the Workers AI model this role uses. " + aiPersonNote,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
