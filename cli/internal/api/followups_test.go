package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestFollowupClientRoutes(t *testing.T) {
	type call struct {
		method, path, query, idemKey string
		body                         map[string]any
	}
	var calls []call
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		calls = append(calls, call{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Idempotency-Key"), body})
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "GET" {
			_, _ = w.Write([]byte(`{"followups":[{"email_id":"e1","thread_id":"t1","followup_at":"2026-11-02T09:00:00Z","followup_mode":"manual","status":"pending"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"email_id":"e1","thread_id":"t1","followup_at":"2026-11-02T09:00:00Z","followup_mode":"manual","status":"pending"}`))
	}))
	ctx := context.Background()
	mb := "founder@tapetide.com"

	items, err := c.ListFollowups(ctx, mb, "pending")
	if err != nil || len(items) != 1 || items[0].EmailID != "e1" {
		t.Fatalf("ListFollowups = %+v, %v", items, err)
	}
	c.SetIdempotencyKey("run-1")
	if _, err := c.SetFollowup(ctx, mb, "e1", "", 259200); err != nil {
		t.Fatalf("SetFollowup: %v", err)
	}
	if _, err := c.CancelFollowup(ctx, mb, "e1"); err != nil {
		t.Fatalf("CancelFollowup: %v", err)
	}

	if calls[0].path != "/api/v1/mailboxes/founder@tapetide.com/followups" || calls[0].query != "status=pending" {
		t.Errorf("list call = %+v", calls[0])
	}
	if calls[1].method != "POST" || calls[1].path != "/api/v1/mailboxes/founder@tapetide.com/emails/e1/followup" ||
		calls[1].body["delay_seconds"] != float64(259200) {
		t.Errorf("set call = %+v", calls[1])
	}
	if calls[1].idemKey == "" {
		t.Errorf("set call carried no Idempotency-Key")
	}
	if calls[2].path != "/api/v1/mailboxes/founder@tapetide.com/emails/e1/followup/cancel" {
		t.Errorf("cancel call = %+v", calls[2])
	}
}

func TestFollowupClientValidation(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("no request expected, got %s %s", r.Method, r.URL.Path)
	}))
	ctx := context.Background()
	if _, err := c.SetFollowup(ctx, "a@b.com", "e1", "", 0); err == nil {
		t.Error("SetFollowup with neither --at nor --in should fail")
	}
	if _, err := c.SetFollowup(ctx, "a@b.com", "e1", "2026-11-02T09:00:00Z", 60); err == nil {
		t.Error("SetFollowup with both --at and --in should fail")
	}
	if _, err := c.ListFollowups(ctx, "a@b.com", "everything"); err == nil {
		t.Error("ListFollowups with an unknown status should fail")
	}
}
