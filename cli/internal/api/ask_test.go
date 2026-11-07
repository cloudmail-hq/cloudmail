package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestAskPostsQuestionAndDecodesCitations(t *testing.T) {
	var gotPath, gotMethod string
	var gotBody map[string]any
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod = r.URL.Path, r.Method
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"question":"when is my flight","answer":"3 November [1].","insufficient":false,"semantic":true,
			"citations":[{"n":1,"mailbox":"me@x.com","email_id":"e1","subject":"Flight","href":"/mail/me%40x.com/inbox?m=e1"}],
			"mailboxes":["me@x.com"]}`))
	}))
	// A question changes nothing, so a read-only session may still ask.
	c.readOnly = true

	res, err := c.Ask(context.Background(), " when is my flight ", "*", []string{"acme"})
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if gotMethod != "POST" || gotPath != "/api/v1/ask" {
		t.Errorf("request = %s %s", gotMethod, gotPath)
	}
	if gotBody["question"] != "when is my flight" || gotBody["mailbox"] != "*" {
		t.Errorf("body = %v", gotBody)
	}
	if len(res.Citations) != 1 || res.Citations[0].EmailID != "e1" || !res.Semantic {
		t.Errorf("decoded = %+v", res)
	}
}

func TestAskValidatesLocally(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("no request expected")
	}))
	if _, err := c.Ask(context.Background(), "  ", "", nil); err == nil {
		t.Error("empty question accepted")
	}
	long := make([]byte, 501)
	for i := range long {
		long[i] = 'a'
	}
	if _, err := c.Ask(context.Background(), string(long), "", nil); err == nil {
		t.Error("over-long question accepted")
	}
}
