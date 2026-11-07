package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestSuppressionClientRoutes(t *testing.T) {
	type call struct {
		method, path, query string
		body                map[string]string
	}
	var calls []call
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		calls = append(calls, call{r.Method, r.URL.Path, r.URL.RawQuery, body})
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET":
			_, _ = w.Write([]byte(`{"items":[{"id":"sup_1","address":"a@x.com","scope":"global","reason":"manual","source":"t","created_at":1}],"total":1,"limit":50,"offset":0}`))
		case r.URL.Path == "/api/v1/suppressions/import":
			_, _ = w.Write([]byte(`{"added":2,"existing":0,"rows":2,"errorCount":0,"errors":[]}`))
		case r.Method == "DELETE":
			_, _ = w.Write([]byte(`{"success":true}`))
		default:
			_, _ = w.Write([]byte(`{"added":1,"existing":0,"items":[]}`))
		}
	}))
	ctx := context.Background()

	page, err := c.ListSuppressions(ctx, SuppressionListOptions{Query: "x.com", Limit: 10})
	if err != nil || page.Total != 1 || page.Items[0].Address != "a@x.com" {
		t.Fatalf("ListSuppressions = %+v, %v", page, err)
	}
	if _, err := c.AddSuppression(ctx, "b@x.com", "product.dev", ""); err != nil {
		t.Fatalf("AddSuppression: %v", err)
	}
	if _, err := c.ImportSuppressions(ctx, "c@x.com\nd@x.com\n", "", ""); err != nil {
		t.Fatalf("ImportSuppressions: %v", err)
	}
	if _, err := c.RemoveSuppression(ctx, "sup_1"); err != nil {
		t.Fatalf("RemoveSuppression: %v", err)
	}

	if calls[0].path != "/api/v1/suppressions" || calls[0].query != "limit=10&q=x.com" {
		t.Errorf("list call = %+v", calls[0])
	}
	if calls[1].body["reason"] != "manual" || calls[1].body["scope"] != "product.dev" {
		t.Errorf("add body = %+v", calls[1].body)
	}
	if calls[2].path != "/api/v1/suppressions/import" {
		t.Errorf("import path = %s", calls[2].path)
	}
	if calls[3].method != "DELETE" || calls[3].path != "/api/v1/suppressions/sup_1" {
		t.Errorf("remove call = %+v", calls[3])
	}
}

func TestSuppressionClientRefusesBadInput(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("no request should be sent")
	}))
	ctx := context.Background()
	if _, err := c.AddSuppression(ctx, "not-an-address", "", ""); err == nil {
		t.Error("expected an error for a non-address")
	}
	if _, err := c.AddSuppression(ctx, "a@x.com", "", "spam"); err == nil {
		t.Error("expected an error for an unknown reason")
	}
	if _, err := c.ImportSuppressions(ctx, "  ", "", ""); err == nil {
		t.Error("expected an error for an empty import")
	}
}
