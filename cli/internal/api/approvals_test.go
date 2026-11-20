package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestApprovalClientRoutes(t *testing.T) {
	type call struct {
		method, path, query, key string
		body                     map[string]any
	}
	var calls []call
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		calls = append(calls, call{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get(IdempotencyHeader), body})
		w.Header().Set("Content-Type", "application/json")
		one := `{"id":"apr_1","kind":"send_email","status":"pending","reason":"approval_required","recipients":["a@x.com"],"subject":"Hi","payload":{},"requested_by":{"user":"o@x.com","via":"mcp","method":"token","tokenId":"tok1","tokenName":"hermes"},"created_at":"2026-10-26T00:00:00Z","expires_at":"2026-11-02T00:00:00Z"}`
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/v1/mailboxes/s@x.com/approvals":
			_, _ = w.Write([]byte(`{"approvals":[` + one + `]}`))
		case r.Method == "GET":
			_, _ = w.Write([]byte(`{"approval":` + one + `}`))
		default:
			_, _ = w.Write([]byte(`{"approval":` + one + `}`))
		}
	}))
	ctx := context.Background()
	c.SetIdempotencyKey("key-1")

	items, err := c.ListApprovals(ctx, "s@x.com", "pending", 0)
	if err != nil || len(items) != 1 || items[0].RequestedBy.TokenName == nil || *items[0].RequestedBy.TokenName != "hermes" {
		t.Fatalf("ListApprovals = %+v, %v", items, err)
	}
	subject := "Edited"
	if _, err := c.EditApproval(ctx, "s@x.com", "apr_1", ApprovalEdits{Subject: &subject}); err != nil {
		t.Fatalf("EditApproval: %v", err)
	}
	if _, err := c.ApproveApproval(ctx, "s@x.com", "apr_1", 0); err != nil {
		t.Fatalf("ApproveApproval: %v", err)
	}
	if _, err := c.RejectApproval(ctx, "s@x.com", "apr_1", "no"); err != nil {
		t.Fatalf("RejectApproval: %v", err)
	}

	if calls[0].query != "status=pending" {
		t.Errorf("list query = %q", calls[0].query)
	}
	edit := calls[1]
	if edit.method != "PATCH" || edit.path != "/api/v1/mailboxes/s@x.com/approvals/apr_1" || edit.body["subject"] != "Edited" {
		t.Errorf("edit call = %+v", edit)
	}
	approve := calls[2]
	if approve.method != "POST" || approve.path != "/api/v1/mailboxes/s@x.com/approvals/apr_1/approve" {
		t.Errorf("approve call = %+v", approve)
	}
	if approve.key == "" {
		t.Errorf("approve must carry an Idempotency-Key so a retry cannot send twice")
	}
	if len(approve.body) != 0 {
		t.Errorf("approve sends what is stored, so it carries no edits: %+v", approve.body)
	}
	if calls[3].path != "/api/v1/mailboxes/s@x.com/approvals/apr_1/reject" || calls[3].body["note"] != "no" {
		t.Errorf("reject call = %+v", calls[3])
	}
	if _, err := c.ApproveApproval(ctx, "", "apr_1", 0); err == nil {
		t.Errorf("a missing mailbox must be refused before any request")
	}
}
