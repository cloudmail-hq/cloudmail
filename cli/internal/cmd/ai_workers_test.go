package cmd

import (
	"net/http"
	"strings"
	"testing"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// Synthetic fixtures only.
const aiStatusBody = `{
  "providers": [], "problems": [], "roles": [], "authSecretSet": true,
  "routing": {"gatewayProviderId": null, "models": {}, "fallbackToWorkersAi": false,
    "workersAiExceptions": [], "disabledRoles": [], "embeddingsMode": "gateway"},
  "status": {"mode": "workers-ai", "activeProviderId": "workers-ai", "activeLabel": "Cloudflare Workers AI",
    "line": "All AI runs on Cloudflare Workers AI.",
    "exceptions": [{"role": "injection_scanner", "text": "The prompt-injection scanner always runs on Workers AI."}]},
  "workersAi": {"id": "workers-ai", "label": "Cloudflare Workers AI", "builtIn": true, "tested": {},
    "roles": [
      {"role": "agent_chat", "modelId": "@cf/example/chat-2", "defaultModelId": "@cf/example/chat-1", "source": "admin", "locked": false},
      {"role": "summary", "modelId": "@cf/example/small", "defaultModelId": "@cf/example/small", "source": "env", "locked": false},
      {"role": "injection_scanner", "modelId": "@cf/example/small", "defaultModelId": "@cf/example/small", "source": "default", "locked": true}
    ]},
  "usage": {"month": "2026-10", "byProvider": [{"providerId": "workers-ai", "calls": 42, "inputTokens": null, "outputTokens": null, "costUsd": null}]}
}`

const aiModelsBody = `{
  "source": "live", "fetchedAt": "2026-10-29T00:00:00Z", "detail": null, "count": 2,
  "models": [
    {"id": "@cf/example/chat-2", "task": "Text Generation", "contextTokens": 131000,
     "tools": {"value": true, "source": "provider"}, "json": {"value": true, "source": "hint"},
     "reasoning": true, "vision": false, "dims": null, "price": {"input": 0.5, "output": 2},
     "beta": false, "lora": false, "paid": false, "deprecated": false},
    {"id": "@cf/example/embed", "task": "Text Embeddings", "contextTokens": 512,
     "tools": {"value": false, "source": "provider"}, "json": {"value": false, "source": "provider"},
     "reasoning": false, "vision": false, "dims": 1024, "price": null,
     "beta": false, "lora": false, "paid": false, "deprecated": false}
  ],
  "roles": [{"role": "agent_chat", "modelId": "@cf/example/chat-1", "unlisted": {"successor": "@cf/example/chat-2"}}]
}`

func TestAIStatusShowsModeExceptionsRolesAndUsage(t *testing.T) {
	srv, hits := aiServer(t, func(_ *http.Request, w http.ResponseWriter) { _, _ = w.Write([]byte(aiStatusBody)) })
	out, e := runAI(t, srv, "", "table", "ai", "status")
	if e != nil {
		t.Fatalf("status: %v", e)
	}
	if h := hits(); len(h) != 1 || h[0].Method != "GET" || h[0].Path != "/api/v1/ai/providers" {
		t.Fatalf("requests = %+v", h)
	}
	for _, want := range []string{
		"All AI runs on Cloudflare Workers AI.",
		"prompt-injection scanner always runs on Workers AI",
		"@cf/example/chat-2", "admin", "SUMMARY_MODEL", "fixed",
		"workers-ai", "42",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("status output lacks %q:\n%s", want, out)
		}
	}
}

func TestAIModelsListFiltersByTaskAndWarnsOnUnlisted(t *testing.T) {
	srv, hits := aiServer(t, func(_ *http.Request, w http.ResponseWriter) { _, _ = w.Write([]byte(aiModelsBody)) })
	out, e := runAI(t, srv, "", "table", "ai", "models", "list", "--task", "embeddings")
	if e != nil {
		t.Fatalf("models list: %v", e)
	}
	h := hits()
	if len(h) != 1 || h[0].Path != "/api/v1/ai/providers/workers-ai/models" || !strings.Contains(h[0].RawQuery, "task=Text+Embeddings") {
		t.Fatalf("requests = %+v", h)
	}
	for _, want := range []string{"@cf/example/embed", "embeddings 1024d", "@cf/example/chat-2", "$0.5 / $2"} {
		if !strings.Contains(out, want) {
			t.Errorf("models output lacks %q:\n%s", want, out)
		}
	}
	// A hint is not a yes.
	if !strings.Contains(out, "?") {
		t.Errorf("an inferred JSON capability should show as ?:\n%s", out)
	}

	if _, e := runAI(t, srv, "", "table", "ai", "models", "list", "--task", "images"); e == nil || e.ExitCode() != fail.Usage {
		t.Errorf("--task images: want a usage error, got %v", e)
	}
}

func TestAIRouteSendsOneRoleToWorkersAI(t *testing.T) {
	srv, hits := aiServer(t, func(_ *http.Request, w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"workersAi": {"id": "workers-ai", "label": "x", "builtIn": true, "roles": [
		  {"role": "agent_chat", "modelId": "@cf/example/chat-2", "defaultModelId": "@cf/example/chat-1", "source": "admin", "locked": false}]},
		  "status": {"mode": "workers-ai", "activeProviderId": "workers-ai", "activeLabel": "x", "line": "x", "exceptions": []}, "reindex": false}`))
	})
	out, e := runAI(t, srv, "", "table", "ai", "route", "agent_chat", "@cf/example/chat-2", "--provider", "workers-ai")
	if e != nil {
		t.Fatalf("route: %v", e)
	}
	h := hits()
	if len(h) != 1 || h[0].Method != "PATCH" || h[0].Path != "/api/v1/ai/providers/workers-ai/routing" {
		t.Fatalf("requests = %+v", h)
	}
	models, _ := h[0].Body["models"].(map[string]any)
	if models["agent_chat"] != "@cf/example/chat-2" || h[0].Body["confirmReindex"] != nil {
		t.Errorf("body = %v", h[0].Body)
	}
	if !strings.Contains(out, "@cf/example/chat-2") {
		t.Errorf("output: %s", out)
	}

	// --reset sends null; --confirm-reindex is passed through.
	if _, e := runAI(t, srv, "", "table", "ai", "route", "embeddings", "--reset", "--provider", "workers-ai", "--confirm-reindex"); e != nil {
		t.Fatalf("reset: %v", e)
	}
	last := hits()[len(hits())-1].Body
	m, _ := last["models"].(map[string]any)
	if v, ok := m["embeddings"]; !ok || v != nil || last["confirmReindex"] != true {
		t.Errorf("reset body = %v", last)
	}
}

func TestAIRouteRefusesBeforeSending(t *testing.T) {
	srv, hits := aiServer(t, func(_ *http.Request, w http.ResponseWriter) { w.WriteHeader(500) })
	cases := [][]string{
		{"ai", "route", "injection_scanner", "@cf/example/x", "--provider", "workers-ai"}, // locked
		{"ai", "route", "nope", "@cf/example/x", "--provider", "workers-ai"},              // unknown role
		{"ai", "route", "summary", "gpt-x", "--provider", "workers-ai"},                   // not a Workers AI id
		{"ai", "route", "summary", "@cf/example/x", "--provider", "corp-gw"},              // gateways use `ai provider route`
		{"ai", "route", "summary", "--provider", "workers-ai"},                            // no model, no --reset
	}
	for _, args := range cases {
		if _, e := runAI(t, srv, "", "table", args...); e == nil || e.ExitCode() != fail.Usage {
			t.Errorf("%v: want a usage error, got %v", args, e)
		}
	}
	if n := len(hits()); n != 0 {
		t.Errorf("%d request(s) sent; every case should be refused locally", n)
	}
}

func TestAIWorkersCommandsAreInTheTree(t *testing.T) {
	root, _ := NewRootCommand()
	for path, mutates := range map[string]bool{"status": false, "models list": false, "route": true} {
		c, _, err := root.Find(append([]string{"ai"}, strings.Fields(path)...))
		if err != nil {
			t.Errorf("ai %s: not found", path)
			continue
		}
		if got := commandMutates(c); got != mutates {
			t.Errorf("ai %s: mutates = %v, want %v", path, got, mutates)
		}
	}
}
