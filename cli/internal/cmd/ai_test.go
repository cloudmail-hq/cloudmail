package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// Synthetic fixtures only.
const aiListBody = `{
  "providers": [{
    "id": "corp-gw", "label": "Corp gateway", "wire": "openai",
    "baseUrl": "https://llm.example.com/v1", "exactBaseUrl": false, "apiBase": "https://llm.example.com/v1",
    "auth": {"scheme": "bearer"}, "tokenSet": true, "tokenHint": "…a1b2",
    "headers": [], "enabled": true,
    "catalogue": {"fetchedAt": "2026-10-01T00:00:00Z", "status": "ok", "count": 2},
    "models": [], "needsCustomIds": false,
    "breaker": {"state": "closed", "openUntil": null}
  }],
  "routing": {
    "gatewayProviderId": "corp-gw",
    "models": {"summary": {"modelId": "example/chat-small"}},
    "default": {"modelId": "example/chat-large"},
    "fallbackToWorkersAi": false, "workersAiExceptions": [], "disabledRoles": [],
    "embeddingsMode": "workers-ai"
  },
  "problems": [{"role": "triage", "reason": "example/chat-large has no JSON output"}],
  "roles": [
    {"role": "summary", "label": "Summary", "needs": "json", "pinned": false},
    {"role": "triage", "label": "Triage", "needs": "json", "pinned": false},
    {"role": "injection_scanner", "label": "Scanner", "needs": "json", "pinned": true},
    {"role": "embeddings", "label": "Search", "needs": "embed", "pinned": false}
  ],
  "authSecretSet": true
}`

type aiHit struct {
	Method, Path, RawQuery, IdemKey string
	Body                            map[string]any
}

// aiServer records every request and answers with respond(r).
func aiServer(t *testing.T, respond func(r *http.Request, w http.ResponseWriter)) (*httptest.Server, func() []aiHit) {
	t.Helper()
	var mu sync.Mutex
	var hits []aiHit
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		hits = append(hits, aiHit{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Idempotency-Key"), body})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		respond(r, w)
	}))
	t.Cleanup(srv.Close)
	return srv, func() []aiHit {
		mu.Lock()
		defer mu.Unlock()
		return append([]aiHit(nil), hits...)
	}
}

// runAI runs the CLI with the given output format, capturing stdout and the
// classified error. stdin, when non-empty, replaces os.Stdin.
func runAI(t *testing.T, srv *httptest.Server, stdin, format string, args ...string) (string, *fail.Error) {
	t.Helper()
	t.Setenv("CLOUDMAIL_CONFIG_DIR", t.TempDir())
	t.Setenv("CLOUDMAIL_BASE_URL", srv.URL)
	t.Setenv("CLOUDMAIL_TOKEN", "ttk_test_secret")
	t.Setenv("CLOUDMAIL_RETRIES", "0")

	if stdin != "" {
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.WriteString(stdin)
		_ = w.Close()
		old := os.Stdin
		os.Stdin = r
		t.Cleanup(func() { os.Stdin = old; _ = r.Close() })
	}

	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	oldOut := os.Stdout
	os.Stdout = outW
	done := make(chan string)
	go func() {
		var b bytes.Buffer
		_, _ = io.Copy(&b, outR)
		done <- b.String()
	}()

	root, _ := NewRootCommand()
	root.SetArgs(append([]string{"--quiet", "--output", format}, args...))
	_, runErr := root.ExecuteC()

	_ = outW.Close()
	os.Stdout = oldOut
	out := <-done
	if runErr == nil {
		return out, nil
	}
	return out, classifyTopLevel(runErr)
}

func TestAIProviderListRendersProvidersRoutingAndProblems(t *testing.T) {
	srv, hits := aiServer(t, func(_ *http.Request, w http.ResponseWriter) {
		_, _ = w.Write([]byte(aiListBody))
	})
	out, e := runAI(t, srv, "", "table", "ai", "provider", "list")
	if e != nil {
		t.Fatalf("list: %v", e)
	}
	if h := hits(); len(h) != 1 || h[0].Method != "GET" || h[0].Path != "/api/v1/ai/providers" {
		t.Fatalf("requests = %+v", h)
	}
	for _, want := range []string{
		"corp-gw", "llm.example.com", "yes", "ok (2)", "…a1b2", "closed", // provider row
		"Routing",
		"example/chat-small",           // summary's own model
		"example/chat-large (default)", // triage falls back to the default
		"(built-in, pinned)",           // the scanner
		"Problems", "triage: example/chat-large has no JSON output",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("table output lacks %q:\n%s", want, out)
		}
	}
	// embeddings is on Workers AI by choice.
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "embeddings") && !strings.Contains(line, "workers-ai") {
			t.Errorf("embeddings row = %q, want workers-ai", line)
		}
	}

	out, e = runAI(t, srv, "", "json", "ai", "provider", "list")
	if e != nil {
		t.Fatalf("list --json: %v", e)
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("json output does not parse: %v\n%s", err, out)
	}
	if _, ok := doc["routing"]; !ok {
		t.Errorf("json output lacks routing: %s", out)
	}
}

func TestAIProviderAddReadsTokenFromStdinAndSendsAKey(t *testing.T) {
	const token = "gw-synthetic-token-123"
	srv, hits := aiServer(t, func(_ *http.Request, w http.ResponseWriter) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"provider":{"id":"corp-gw","label":"Corp","wire":"anthropic",` +
			`"baseUrl":"https://llm.example.com","auth":{"scheme":"x-api-key"},"tokenSet":true,` +
			`"tokenHint":"…-123","catalogue":{"status":"never","count":0},"breaker":{"state":"closed"}}}`))
	})
	args := []string{"ai", "provider", "add", "--label", "Corp", "--wire", "anthropic",
		"--base-url", "https://llm.example.com", "--header", "X-Team=mail",
		"--secret-header", "X-Extra=synthetic-secret", "--token-stdin"}
	_, e := runAI(t, srv, token+"\n", "json", args...)
	if e != nil {
		t.Fatalf("add: %v", e)
	}
	for _, a := range args {
		if strings.Contains(a, token) {
			t.Fatal("the token must not be an argument")
		}
	}
	h := hits()
	if len(h) != 1 {
		t.Fatalf("requests = %+v", h)
	}
	got := h[0]
	if got.Method != "POST" || got.Path != "/api/v1/ai/providers" {
		t.Errorf("request = %s %s", got.Method, got.Path)
	}
	if strings.Contains(got.Path, token) || strings.Contains(got.RawQuery, token) {
		t.Error("the token leaked into the URL")
	}
	if !strings.HasPrefix(got.IdemKey, "cloudmail-") {
		t.Errorf("Idempotency-Key = %q, want a generated key", got.IdemKey)
	}
	if got.Body["token"] != token {
		t.Errorf("body token = %v", got.Body["token"])
	}
	auth, _ := got.Body["auth"].(map[string]any)
	if auth["scheme"] != "x-api-key" {
		t.Errorf("auth = %v, want the anthropic default x-api-key", auth)
	}
	hs, _ := got.Body["headers"].([]any)
	if len(hs) != 2 {
		t.Fatalf("headers = %v", hs)
	}
	if sec, _ := hs[1].(map[string]any); sec["name"] != "X-Extra" || sec["secret"] != true {
		t.Errorf("secret header = %v", sec)
	}

	// A given key is passed through as is.
	_, e = runAI(t, srv, token+"\n", "json", append(args, "--idempotency-key", "gw-1")...)
	if e != nil {
		t.Fatalf("add with key: %v", e)
	}
	if h := hits(); h[len(h)-1].IdemKey != "gw-1" {
		t.Errorf("Idempotency-Key = %q, want gw-1", h[len(h)-1].IdemKey)
	}
}

func TestAIProviderAddDryRunRedactsTheToken(t *testing.T) {
	srv, hits := aiServer(t, func(_ *http.Request, w http.ResponseWriter) {})
	out, e := runAI(t, srv, "gw-synthetic-token\n", "json", "--dry-run", "ai", "provider", "add",
		"--label", "Corp", "--wire", "openai", "--base-url", "https://llm.example.com",
		"--secret-header", "X-Extra=synthetic-secret", "--token-stdin")
	if e == nil || e.ExitCode() != fail.DryRun {
		t.Fatalf("exit = %v, want dry run", e)
	}
	if len(hits()) != 0 {
		t.Fatal("dry run sent a request")
	}
	if strings.Contains(out, "gw-synthetic-token") || strings.Contains(out, "synthetic-secret") {
		t.Errorf("preview shows a secret:\n%s", out)
	}
}

func TestAIProviderAddRequiresWire(t *testing.T) {
	srv, hits := aiServer(t, func(_ *http.Request, w http.ResponseWriter) {})
	_, e := runAI(t, srv, "x\n", "json", "ai", "provider", "add", "--label", "Corp",
		"--base-url", "https://llm.example.com", "--token-stdin")
	if e == nil || e.ExitCode() != fail.Usage || len(hits()) != 0 {
		t.Fatalf("exit = %v, requests = %v; want a usage error and nothing sent", e, hits())
	}
}

func TestAIProviderRoute422RendersEachProblem(t *testing.T) {
	srv, hits := aiServer(t, func(_ *http.Request, w http.ResponseWriter) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"error":"Some roles fail their capability check",` +
			`"code":"capability_check_failed","problems":[` +
			`{"role":"triage","reason":"example/chat-small has no JSON output"},` +
			`{"role":"auto_draft","reason":"example/chat-small cannot call tools"}]}`))
	})
	_, e := runAI(t, srv, "", "json", "ai", "provider", "route",
		"triage=example/chat-small", "auto_draft=example/chat-small", "summary=", "--fallback", "off")
	if e == nil || e.ExitCode() != fail.Invalid {
		t.Fatalf("exit = %v, want %d", e, fail.Invalid)
	}
	msg := e.Error()
	for _, want := range []string{
		"triage: example/chat-small has no JSON output",
		"auto_draft: example/chat-small cannot call tools",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("error lacks %q:\n%s", want, msg)
		}
	}
	if e.Code != "CAPABILITY_CHECK_FAILED" {
		t.Errorf("code = %q", e.Code)
	}

	h := hits()
	if len(h) != 1 || h[0].Method != "PATCH" || h[0].Path != "/api/v1/ai/routing" {
		t.Fatalf("requests = %+v", h)
	}
	models, _ := h[0].Body["models"].(map[string]any)
	if models["triage"] != "example/chat-small" {
		t.Errorf("models = %v", models)
	}
	if v, ok := models["summary"]; !ok || v != nil {
		t.Errorf("summary= should send null, got %v (present %v)", v, ok)
	}
	if h[0].Body["fallbackToWorkersAi"] != false {
		t.Errorf("body = %v", h[0].Body)
	}
}

func TestAIProviderRouteRefusesPinnedAndUnknownRoles(t *testing.T) {
	srv, hits := aiServer(t, func(_ *http.Request, w http.ResponseWriter) {})
	for _, arg := range []string{"injection_scanner=x", "nope=x", "summary"} {
		_, e := runAI(t, srv, "", "json", "ai", "provider", "route", arg)
		if e == nil || e.ExitCode() != fail.Usage {
			t.Errorf("%s: exit = %v, want usage", arg, e)
		}
	}
	if len(hits()) != 0 {
		t.Errorf("requests sent: %v", hits())
	}
}

func TestAIProviderActivate(t *testing.T) {
	srv, hits := aiServer(t, func(_ *http.Request, w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"routing":{"gatewayProviderId":"corp-gw","models":{},` +
			`"fallbackToWorkersAi":false,"workersAiExceptions":[],"disabledRoles":[],` +
			`"embeddingsMode":"gateway"},"problems":[]}`))
	})
	if _, e := runAI(t, srv, "", "json", "ai", "provider", "activate", "corp-gw"); e != nil {
		t.Fatalf("activate: %v", e)
	}
	if _, e := runAI(t, srv, "", "json", "ai", "provider", "activate", "--off"); e != nil {
		t.Fatalf("activate --off: %v", e)
	}
	h := hits()
	if len(h) != 2 {
		t.Fatalf("requests = %+v", h)
	}
	for _, hit := range h {
		if hit.Method != "PATCH" || hit.Path != "/api/v1/ai/routing" {
			t.Errorf("request = %s %s", hit.Method, hit.Path)
		}
		if len(hit.Body) != 1 {
			t.Errorf("body = %v, want only gatewayProviderId", hit.Body)
		}
	}
	if h[0].Body["gatewayProviderId"] != "corp-gw" {
		t.Errorf("activate body = %v", h[0].Body)
	}
	if v, ok := h[1].Body["gatewayProviderId"]; !ok || v != nil {
		t.Errorf("--off body = %v, want gatewayProviderId: null", h[1].Body)
	}

	// Neither or both is a usage error.
	for _, args := range [][]string{{}, {"corp-gw", "--off"}} {
		_, e := runAI(t, srv, "", "json", append([]string{"ai", "provider", "activate"}, args...)...)
		if e == nil || e.ExitCode() != fail.Usage {
			t.Errorf("activate %v: exit = %v, want usage", args, e)
		}
	}
}

func TestAIConfigChangeWithTokenSurfacesPersonRequired(t *testing.T) {
	srv, _ := aiServer(t, func(_ *http.Request, w http.ResponseWriter) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"This change needs a signed-in person","code":"person_required"}`))
	})
	_, e := runAI(t, srv, "", "json", "ai", "provider", "activate", "corp-gw")
	if e == nil || e.ExitCode() != fail.Denied || e.Code != "PERSON_REQUIRED" {
		t.Fatalf("error = %+v, want denied PERSON_REQUIRED", e)
	}
	if !strings.Contains(e.Message, "signed-in person") || !strings.Contains(e.Remediation, "browser session") {
		t.Errorf("message = %q, remediation = %q", e.Message, e.Remediation)
	}
}

func TestAIProviderTestReportsFailedChecks(t *testing.T) {
	srv, hits := aiServer(t, func(_ *http.Request, w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"results":[{"check":"text","ok":true,"ms":120},` +
			`{"check":"tools","ok":false,"ms":340,"error":"model returned no tool call"}]}`))
	})
	out, e := runAI(t, srv, "", "table", "ai", "provider", "test", "corp-gw",
		"--model", "example/chat-small", "--check", "text,tools")
	if e == nil || e.ExitCode() != fail.Err {
		t.Fatalf("exit = %v, want 1", e)
	}
	for _, want := range []string{"FAIL", "model returned no tool call", "340"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	h := hits()
	if len(h) != 1 || h[0].Path != "/api/v1/ai/providers/corp-gw/test" || h[0].Body["modelId"] != "example/chat-small" {
		t.Fatalf("requests = %+v", h)
	}
	if checks, _ := h[0].Body["checks"].([]any); len(checks) != 2 {
		t.Errorf("checks = %v", h[0].Body["checks"])
	}
}

func TestAIProviderModelsBody(t *testing.T) {
	srv, hits := aiServer(t, func(_ *http.Request, w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"provider":{"id":"corp-gw","catalogue":{"status":"no-discovery","count":1},"models":[]}}`))
	})
	_, e := runAI(t, srv, "", "json", "ai", "provider", "models", "corp-gw",
		"--add", "chat-prod", "--add", "embed-prod:embedding", "--remove", "old",
		"--cap", "org:model-x:tools=off", "--cap", "org:model-x:json=clear")
	if e != nil {
		t.Fatalf("models: %v", e)
	}
	b := hits()[0].Body
	add, _ := b["add"].([]any)
	if len(add) != 2 || add[1].(map[string]any)["kind"] != "embedding" {
		t.Errorf("add = %v", b["add"])
	}
	caps, _ := b["caps"].([]any)
	if len(caps) != 1 {
		t.Fatalf("caps = %v, want one entry per model", b["caps"])
	}
	c := caps[0].(map[string]any)
	if v, ok := c["json"]; c["id"] != "org:model-x" || c["tools"] != false || !ok || v != nil {
		t.Errorf("caps[0] = %v", c)
	}
}

func TestAICommandsAreInTheTree(t *testing.T) {
	root, _ := NewRootCommand()
	for _, name := range []string{"list", "add", "discover", "test", "models", "route", "activate"} {
		c, _, err := root.Find([]string{"ai", "provider", name})
		if err != nil || c.Name() != name {
			t.Errorf("ai provider %s: not found", name)
			continue
		}
		if got := commandMutates(c); got == (name == "list") {
			t.Errorf("ai provider %s: mutates = %v", name, got)
		}
	}
}
