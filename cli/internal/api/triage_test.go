package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestTriageClientRoutes(t *testing.T) {
	type call struct {
		method, path, idemKey string
		body                  map[string]any
	}
	var calls []call
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		calls = append(calls, call{r.Method, r.URL.Path, r.Header.Get("Idempotency-Key"), body})
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v1/mailboxes/founder@tapetide.com/label-prompts":
			_, _ = w.Write([]byte(`{"enabled":true,"screener":"unknown_only","daily_ai_cap":200,"ai_calls_today":4,"labels":[{"id":"l1","name":"Bugs","prompt":"Customer bug reports","auto_archive":false,"show_tab":true}],"presets":[{"key":"billing","name":"Billing","prompt":"x","enabled":true}]}`))
		case r.URL.Path == "/api/v1/mailboxes/founder@tapetide.com/screener":
			_, _ = w.Write([]byte(`{"senders":[{"sender":"sdr@lead.example","count":2,"unread":2,"latest_date":"2026-10-26T00:00:00Z","latest_id":"e1","verdict":"Looks like cold sales (high)"}]}`))
		case r.URL.Path == "/api/v1/mailboxes/founder@tapetide.com/triage/backfill":
			_, _ = w.Write([]byte(`{"processed":10,"classified":7,"remaining":3,"capped":false}`))
		default:
			_, _ = w.Write([]byte(`{"id":"l1","name":"Bugs","sender":"sdr@lead.example","decision":"block","folder":"trash","moved":2,"listed":true}`))
		}
	}))
	ctx := context.Background()
	mb := "founder@tapetide.com"

	lp, err := c.ListLabelPrompts(ctx, mb)
	if err != nil || len(lp.Labels) != 1 || !lp.Labels[0].ShowTab || lp.AICallsToday != 4 {
		t.Fatalf("ListLabelPrompts = %+v, %v", lp, err)
	}
	prompt := "Customer bug reports"
	tab := true
	if _, err := c.SetLabelPrompt(ctx, mb, "l1", LabelPromptInput{Prompt: &prompt, ShowTab: &tab}); err != nil {
		t.Fatalf("SetLabelPrompt: %v", err)
	}
	if _, err := c.SetLabelPrompt(ctx, mb, "l1", LabelPromptInput{ClearPrompt: true}); err != nil {
		t.Fatalf("SetLabelPrompt clear: %v", err)
	}
	if _, err := c.SetTriagePreset(ctx, mb, "newsletters", true, &tab, nil); err != nil {
		t.Fatalf("SetTriagePreset: %v", err)
	}
	bf, err := c.BackfillTriage(ctx, mb, 10)
	if err != nil || bf.Remaining != 3 {
		t.Fatalf("BackfillTriage = %+v, %v", bf, err)
	}
	senders, err := c.ListScreener(ctx, mb)
	if err != nil || len(senders) != 1 || *senders[0].Verdict != "Looks like cold sales (high)" {
		t.Fatalf("ListScreener = %+v, %v", senders, err)
	}
	c.SetIdempotencyKey("run-1")
	res, err := c.ScreenSender(ctx, mb, "sdr@lead.example", "block", "trash")
	if err != nil || res.Moved != 2 {
		t.Fatalf("ScreenSender = %+v, %v", res, err)
	}

	if calls[1].method != "PUT" || calls[1].path != "/api/v1/mailboxes/founder@tapetide.com/labels/l1/prompt" ||
		calls[1].body["prompt"] != "Customer bug reports" || calls[1].body["show_tab"] != true {
		t.Errorf("set prompt call = %+v", calls[1])
	}
	if v, ok := calls[2].body["prompt"]; !ok || v != nil {
		t.Errorf("clear should send prompt: null, got %+v", calls[2].body)
	}
	if calls[3].path != "/api/v1/mailboxes/founder@tapetide.com/triage/presets/newsletters" ||
		calls[3].body["enabled"] != true || calls[3].body["auto_archive"] != true {
		t.Errorf("preset call = %+v", calls[3])
	}
	if _, has := calls[3].body["show_tab"]; has {
		t.Errorf("preset call should leave show_tab alone: %+v", calls[3].body)
	}
	if calls[4].method != "POST" || calls[4].body["limit"] != float64(10) {
		t.Errorf("backfill call = %+v", calls[4])
	}
	last := calls[len(calls)-1]
	if last.method != "POST" || last.path != "/api/v1/mailboxes/founder@tapetide.com/screener/sdr@lead.example" ||
		last.body["decision"] != "block" || last.body["target"] != "trash" || last.idemKey == "" {
		t.Errorf("screen call = %+v", last)
	}
}

func TestTriageClientValidation(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("no request expected, got %s %s", r.Method, r.URL.Path)
	}))
	ctx := context.Background()
	mb := "a@b.com"
	empty := "   "
	if _, err := c.SetLabelPrompt(ctx, mb, "l1", LabelPromptInput{Prompt: &empty}); err == nil {
		t.Error("an empty prompt should fail")
	}
	if _, err := c.SetLabelPrompt(ctx, mb, "l1", LabelPromptInput{}); err == nil {
		t.Error("a no-op update should fail")
	}
	if _, err := c.SetTriagePreset(ctx, mb, "everything", true, nil, nil); err == nil {
		t.Error("an unknown preset should fail")
	}
	if _, err := c.BackfillTriage(ctx, mb, 99); err == nil {
		t.Error("a batch over 25 should fail")
	}
	if _, err := c.ScreenSender(ctx, mb, "nobody", "allow", ""); err == nil {
		t.Error("a non-address should fail")
	}
	if _, err := c.ScreenSender(ctx, mb, "x@y.z", "maybe", ""); err == nil {
		t.Error("an unknown decision should fail")
	}
	if _, err := c.ScreenSender(ctx, mb, "x@y.z", "block", "archive"); err == nil {
		t.Error("an unknown target should fail")
	}
}
