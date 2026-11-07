package api

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

const productJSON = `{"id":"prd_1","name":"Acme","slug":"acme","domains":["acme.com"],"aliases":[],
	"displayName":null,"accentColor":"#0F766E","signatureHtml":"<p>A</p>","defaultTemplates":[],
	"logoUrl":null,"createdAt":1,"updatedAt":2}`

func TestListProducts(t *testing.T) {
	c, got := recordingServer(t, 200, `{"products":[`+productJSON+`]}`)
	list, err := c.ListProducts(context.Background())
	if err != nil {
		t.Fatalf("ListProducts: %v", err)
	}
	req := onlyRequest(t, got)
	if req.method != "GET" || req.path != "/api/v1/products" {
		t.Errorf("request = %s %s", req.method, req.path)
	}
	if len(list) != 1 || list[0].Slug != "acme" || list[0].Domains[0] != "acme.com" {
		t.Errorf("decoded %+v", list)
	}
}

func TestUpdateProductSendsOnlyChangedFieldsAndClearsEmpty(t *testing.T) {
	c, got := recordingServer(t, 200, `{"product":`+productJSON+`}`)
	display, accent := "Acme Analytics", ""
	domains := []string{"acme.com", "acme.io"}
	if _, err := c.UpdateProduct(context.Background(), "acme", ProductPatch{
		DisplayName: &display,
		AccentColor: &accent,
		Domains:     &domains,
	}); err != nil {
		t.Fatalf("UpdateProduct: %v", err)
	}
	req := onlyRequest(t, got)
	if req.method != "PATCH" || req.path != "/api/v1/products/acme" {
		t.Errorf("request = %s %s", req.method, req.path)
	}
	if req.body["displayName"] != "Acme Analytics" {
		t.Errorf("displayName = %v", req.body["displayName"])
	}
	if v, ok := req.body["accentColor"]; !ok || v != nil {
		t.Errorf("accentColor should be sent as null, got %v (present %v)", v, ok)
	}
	if _, ok := req.body["signatureHtml"]; ok {
		t.Errorf("signatureHtml was not changed and must not be sent")
	}
	if d, _ := req.body["domains"].([]any); len(d) != 2 {
		t.Errorf("domains = %v", req.body["domains"])
	}
}

func TestUpdateProductRefusesAnEmptyPatch(t *testing.T) {
	c, got := recordingServer(t, 200, `{}`)
	if _, err := c.UpdateProduct(context.Background(), "acme", ProductPatch{}); err == nil {
		t.Fatal("want a usage error")
	}
	if len(*got) != 0 {
		t.Errorf("no request should be made")
	}
}

func TestListUnified(t *testing.T) {
	var query string
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.RawQuery
		if r.URL.Path != "/api/v1/inbox" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"emails":[{"id":"e1","subject":"Hi","sender":"s@x.com","recipient":"a@acme.com",
			"date":"2026-10-01","read":false,"starred":false,"mailboxId":"a@acme.com",
			"product":{"id":"prd_1","name":"Acme","slug":"acme"}}],
			"nextCursor":"abc","unread":3,"mailboxes":["a@acme.com"],"truncated":[],"degraded":[]}`))
	}))
	unread := true
	list, err := c.ListUnified(context.Background(), UnifiedOptions{
		Folder: "inbox", Limit: 10, Cursor: "xyz", Products: []string{"acme", "beta"}, Unread: &unread,
	})
	if err != nil {
		t.Fatalf("ListUnified: %v", err)
	}
	for _, want := range []string{"folder=inbox", "limit=10", "cursor=xyz", "product=acme%2Cbeta", "unread=true"} {
		if !strings.Contains(query, want) {
			t.Errorf("query %q is missing %q", query, want)
		}
	}
	if len(list.Emails) != 1 || list.Emails[0].MailboxID != "a@acme.com" || list.Emails[0].Product.Slug != "acme" {
		t.Errorf("decoded %+v", list.Emails)
	}
	if list.Emails[0].Subject != "Hi" {
		t.Errorf("embedded Email fields not decoded: %+v", list.Emails[0].Email)
	}
	if list.NextCursor == nil || *list.NextCursor != "abc" || list.Unread != 3 {
		t.Errorf("envelope %+v", list)
	}
}
