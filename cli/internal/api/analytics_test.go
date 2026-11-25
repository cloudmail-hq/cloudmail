package api

import (
	"context"
	"net/http"
	"testing"
)

func TestAnalyticsSectionRoutes(t *testing.T) {
	type call struct{ method, path, query string }
	var calls []call
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, call{r.Method, r.URL.Path, r.URL.RawQuery})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"scope":"zone"}`))
	}))
	ctx := context.Background()

	out, err := c.AnalyticsSection(ctx, "overview", AnalyticsOptions{Days: 30, Scope: "zone", Domain: "mail.example.com", Refresh: true})
	if err != nil || string(out) != `{"scope":"zone"}` {
		t.Fatalf("overview = %s, %v", out, err)
	}
	if _, err := c.AnalyticsSection(ctx, "engagement", AnalyticsOptions{Mailbox: "support@example.com"}); err != nil {
		t.Fatalf("engagement: %v", err)
	}
	if _, err := c.AnalyticsSection(ctx, "dmarc", AnalyticsOptions{}); err != nil {
		t.Fatalf("dmarc: %v", err)
	}
	if _, err := c.AnalyticsSection(ctx, "", AnalyticsOptions{}); err == nil {
		t.Fatalf("empty section should be refused")
	}

	want := []call{
		{"GET", "/api/v1/analytics/overview", "days=30&domain=mail.example.com&refresh=1&scope=zone"},
		{"GET", "/api/v1/analytics/engagement", "mailbox=support%40example.com"},
		{"GET", "/api/v1/analytics/dmarc", ""},
	}
	if len(calls) != len(want) {
		t.Fatalf("calls = %+v", calls)
	}
	for i := range want {
		if calls[i] != want[i] {
			t.Errorf("call %d = %+v, want %+v", i, calls[i], want[i])
		}
	}
}
