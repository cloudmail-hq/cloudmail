package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func TestCreateTokenSendsScopesAndMailboxes(t *testing.T) {
	var body map[string]any
	var method, path string
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"token":{"id":"abcdefghijkl","name":"ci","createdAt":1,"lastUsedAt":null,"expiresAt":null,"scopes":["mail:read"],"mailboxes":["a@b.com"],"parentId":null},"secret":"ttk_abcdefghijkl_s"}`))
	}))

	out, err := c.CreateToken(context.Background(), TokenInput{
		Name: "ci", Scopes: []string{"mail:read"}, Mailboxes: []string{"a@b.com"},
	})
	if err != nil {
		t.Fatalf("CreateToken: %v", err)
	}
	if method != http.MethodPost || path != "/api/auth/tokens" {
		t.Errorf("request = %s %s", method, path)
	}
	if got := body["scopes"]; len(got.([]any)) != 1 {
		t.Errorf("scopes = %v", got)
	}
	if body["expiresInDays"] != nil {
		t.Errorf("expiresInDays = %v, want null for no expiry", body["expiresInDays"])
	}
	if out.Secret != "ttk_abcdefghijkl_s" || out.Token.Scopes == nil || (*out.Token.Scopes)[0] != "mail:read" {
		t.Errorf("decoded = %+v", out)
	}
}

func TestCreateTokenOmitsUnsetScopes(t *testing.T) {
	var body map[string]any
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"token":{"id":"abcdefghijkl","name":"x"},"secret":"ttk_x"}`))
	}))
	if _, err := c.CreateToken(context.Background(), TokenInput{Name: "x", ExpiresInDays: 30}); err != nil {
		t.Fatal(err)
	}
	if _, ok := body["scopes"]; ok {
		t.Error("scopes sent when none were asked for; the server would read [] as no scopes")
	}
	if body["expiresInDays"].(float64) != 30 {
		t.Errorf("expiresInDays = %v", body["expiresInDays"])
	}
}

func TestCreateTokenRejectsUnknownScope(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("request sent for an invalid scope")
	}))
	if _, err := c.CreateToken(context.Background(), TokenInput{Name: "x", Scopes: []string{"mail:everything"}}); err == nil {
		t.Fatal("want a usage error")
	}
}

func TestIdentityWildcardGrant(t *testing.T) {
	var id Identity
	raw := `{"role":"member","mailboxes":null,"capabilities":[{"mailboxId":"*","role":"token","capabilities":["read"]}],"token":{"id":"t","scopes":["mail:read"],"mailboxes":null}}`
	if err := json.Unmarshal([]byte(raw), &id); err != nil {
		t.Fatal(err)
	}
	g, ok := id.Grant("anyone@example.com")
	if !ok || !g.Can("read") || g.Can("sendAs") {
		t.Errorf("grant = %+v ok=%v", g, ok)
	}
	if id.Token == nil || id.Token.Scopes == nil || (*id.Token.Scopes)[0] != "mail:read" || id.Token.Mailboxes != nil {
		t.Errorf("token = %+v", id.Token)
	}
}
