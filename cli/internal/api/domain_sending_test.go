package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// fakeSecret is shaped like an IAM secret access key, assembled at runtime.
var fakeSecret = strings.Repeat("s", 36) + "LAST"

func TestSetDomainSendingDryRunMasksTheSecret(t *testing.T) {
	var hits int
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	c.SetDryRun(true)

	_, err := c.SetDomainSending(context.Background(), "example.com", DomainSendingInput{
		Provider: "ses", Region: "eu-west-1", AccessKeyID: "AKIA" + strings.Repeat("A", 16), SecretAccessKey: fakeSecret,
	})
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if hits != 0 {
		t.Fatalf("a dry run reached the server")
	}
	previews := c.Previews()
	if len(previews) != 1 {
		t.Fatalf("previews = %d, want 1", len(previews))
	}
	raw := string(previews[0].Body)
	if strings.Contains(raw, fakeSecret) {
		t.Fatalf("preview leaked the secret: %s", raw)
	}
	var body map[string]any
	if err := json.Unmarshal(previews[0].Body, &body); err != nil || body["secretAccessKey"] != "<redacted>" {
		t.Errorf("preview body = %s, want secretAccessKey redacted", raw)
	}
}

func TestSetDomainSendingSendsTheSecretInTheBody(t *testing.T) {
	var got map[string]any
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PUT" || r.URL.Path != "/api/v1/domains/example.com/sending" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"domain":"example.com","provider":"ses","ses":{"region":"eu-west-1","accessKeyIdLast4":"AAAA","secretStored":true,"configurationSet":null}}`))
	}))
	s, err := c.SetDomainSending(context.Background(), "example.com", DomainSendingInput{
		Provider: "ses", Region: "eu-west-1", AccessKeyID: "AKIA" + strings.Repeat("A", 16), SecretAccessKey: fakeSecret,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got["secretAccessKey"] != fakeSecret || got["provider"] != "ses" {
		t.Errorf("body = %v", got)
	}
	if s.SES == nil || !s.SES.SecretStored {
		t.Errorf("view = %+v", s)
	}
}

func TestSetDomainSendingOmitsAnEmptySecret(t *testing.T) {
	var raw string
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		raw = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"domain":"example.com","provider":"ses"}`))
	}))
	if _, err := c.SetDomainSending(context.Background(), "example.com", DomainSendingInput{
		Provider: "ses", Region: "eu-west-1", AccessKeyID: "AKIA" + strings.Repeat("A", 16),
	}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "secretAccessKey") {
		t.Errorf("an empty secret must be omitted so the stored one is kept: %s", raw)
	}
}
