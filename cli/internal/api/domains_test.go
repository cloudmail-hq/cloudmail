package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// recorded is one request as the server saw it.
type recorded struct {
	method, path string
	body         map[string]any
}

// recordingServer answers every request with status and reply, and records it.
func recordingServer(t *testing.T, status int, reply string) (*Client, *[]recorded) {
	t.Helper()
	var got []recorded
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := recorded{method: r.Method, path: r.URL.EscapedPath()}
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			if err := json.Unmarshal(raw, &rec.body); err != nil {
				t.Errorf("request body is not a JSON object: %s", raw)
			}
		}
		got = append(got, rec)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(reply))
	}))
	return c, &got
}

func onlyRequest(t *testing.T, got *[]recorded) recorded {
	t.Helper()
	if len(*got) != 1 {
		t.Fatalf("server saw %d request(s), want 1", len(*got))
	}
	return (*got)[0]
}

const domainJSON = `{"id":"dom_1","hostname":"example.com","displayName":"Example",
	"zoneId":null,"status":"active","routingStatus":"ready","sendingStatus":"enabled",
	"sendingSubdomainId":null,"dkim":null,"catchAllMailbox":"hello@example.com",
	"source":"api","lastError":null,"createdAt":1,"updatedAt":2,"lastCheckedAt":null,
	"mailboxCount":3}`

func TestListDomains(t *testing.T) {
	c, got := recordingServer(t, 200,
		`{"domains":[`+domainJSON+`],"cloudflare":{"configured":true,"workerScriptName":"w"}}`)

	list, err := c.ListDomains(context.Background())
	if err != nil {
		t.Fatalf("ListDomains: %v", err)
	}
	req := onlyRequest(t, got)
	if req.method != "GET" || req.path != "/api/v1/domains" {
		t.Errorf("request = %s %s, want GET /api/v1/domains", req.method, req.path)
	}
	if len(list.Domains) != 1 || list.Domains[0].MailboxCount != 3 || !list.Cloudflare.Configured {
		t.Errorf("decoded %+v", list)
	}
	if list.Domains[0].CatchAllMailbox == nil || *list.Domains[0].CatchAllMailbox != "hello@example.com" {
		t.Errorf("catchAllMailbox not decoded")
	}
}

func TestGetDomainAcceptsHostname(t *testing.T) {
	c, got := recordingServer(t, 200, `{"domain":`+domainJSON+`,
		"records":[{"purpose":"routing","type":"MX","name":"example.com","value":"mx.example","priority":10}],
		"manualSteps":["create the MX record"],
		"audit":{"checkedAt":5,"summary":"warn","checks":[{"id":"mx","label":"MX","type":"MX",
			"name":"example.com","status":"warn","expected":"mx","found":[],"message":"missing"}]},
		"provision":null,"cloudflare":{"configured":false,"workerScriptName":"w"}}`)

	d, err := c.GetDomain(context.Background(), "example.com")
	if err != nil {
		t.Fatalf("GetDomain: %v", err)
	}
	req := onlyRequest(t, got)
	if req.method != "GET" || req.path != "/api/v1/domains/example.com" {
		t.Errorf("request = %s %s", req.method, req.path)
	}
	if len(d.Records) != 1 || d.Records[0].Priority == nil || *d.Records[0].Priority != 10 {
		t.Errorf("records = %+v", d.Records)
	}
	if d.Audit == nil || d.Audit.Summary != "warn" || len(d.Audit.Checks) != 1 {
		t.Errorf("audit = %+v", d.Audit)
	}
	if d.Provision != nil {
		t.Errorf("provision should be nil")
	}
	if len(d.ManualSteps) != 1 {
		t.Errorf("manualSteps = %v", d.ManualSteps)
	}
}

func TestCreateDomainSendsBody(t *testing.T) {
	c, got := recordingServer(t, 201, `{"domain":`+domainJSON+`}`)

	d, err := c.CreateDomain(context.Background(), DomainInput{
		Hostname: " Example.COM. ", DisplayName: "Example", CatchAllMailbox: "hello@example.com",
	})
	if err != nil {
		t.Fatalf("CreateDomain: %v", err)
	}
	if d.ID != "dom_1" {
		t.Errorf("id = %q", d.ID)
	}
	req := onlyRequest(t, got)
	if req.method != "POST" || req.path != "/api/v1/domains" {
		t.Errorf("request = %s %s", req.method, req.path)
	}
	if req.body["hostname"] != "example.com" {
		t.Errorf("hostname = %v, want normalised example.com", req.body["hostname"])
	}
	if req.body["displayName"] != "Example" || req.body["catchAllMailbox"] != "hello@example.com" {
		t.Errorf("body = %v", req.body)
	}
	if _, ok := req.body["zoneId"]; ok {
		t.Errorf("an unset zoneId must be omitted, got %v", req.body["zoneId"])
	}
}

func TestCreateDomainRejectsBadHostnameLocally(t *testing.T) {
	for _, h := range []string{"", "localhost", "https://example.com", "a@example.com", "ex ample.com"} {
		c, got := recordingServer(t, 201, `{}`)
		_, err := c.CreateDomain(context.Background(), DomainInput{Hostname: h})
		if err == nil {
			t.Errorf("%q: want a usage error", h)
			continue
		}
		if e := fail.AsError(err); e.ExitCode() != fail.Usage {
			t.Errorf("%q: exit = %d, want %d", h, e.ExitCode(), fail.Usage)
		}
		if len(*got) != 0 {
			t.Errorf("%q: the server was contacted", h)
		}
	}
}

func TestVerifyDomain(t *testing.T) {
	c, got := recordingServer(t, 200, `{"domain":`+domainJSON+`,
		"audit":{"checkedAt":5,"summary":"pass","checks":[]}}`)

	res, err := c.VerifyDomain(context.Background(), "dom_1")
	if err != nil {
		t.Fatalf("VerifyDomain: %v", err)
	}
	req := onlyRequest(t, got)
	if req.method != "POST" || req.path != "/api/v1/domains/dom_1/verify" {
		t.Errorf("request = %s %s", req.method, req.path)
	}
	if res.Audit == nil || res.Audit.Summary != "pass" {
		t.Errorf("audit = %+v", res.Audit)
	}
}

func TestProvisionDomainOverwriteFlag(t *testing.T) {
	for _, overwrite := range []bool{false, true} {
		c, got := recordingServer(t, 200, `{"domain":`+domainJSON+`,
			"provision":{"ok":true,"ranAt":9,"steps":[{"step":"zone","status":"ok","detail":"found"}]}}`)

		res, err := c.ProvisionDomain(context.Background(), "example.com", ProvisionOptions{OverwriteCatchAll: overwrite})
		if err != nil {
			t.Fatalf("ProvisionDomain: %v", err)
		}
		req := onlyRequest(t, got)
		if req.method != "POST" || req.path != "/api/v1/domains/example.com/provision" {
			t.Errorf("request = %s %s", req.method, req.path)
		}
		v, present := req.body["overwriteCatchAll"]
		if overwrite && v != true {
			t.Errorf("overwriteCatchAll = %v, want true", v)
		}
		if !overwrite && present {
			t.Errorf("overwriteCatchAll sent as %v when not asked for", v)
		}
		if res.Provision == nil || len(res.Provision.Steps) != 1 || !res.Provision.OK {
			t.Errorf("provision = %+v", res.Provision)
		}
	}
}

// Without CF_API_TOKEN the server answers 412 with the manual steps. That has to
// surface as a state conflict naming the cause, with the steps attached, rather
// than as an unclassified error.
func TestProvisionWithoutCloudflareTokenIsExplained(t *testing.T) {
	c, _ := recordingServer(t, 412, `{"error":"CF_API_TOKEN is not configured",
		"manualSteps":["add an MX record","enable Email Routing"],"records":[]}`)

	_, err := c.ProvisionDomain(context.Background(), "example.com", ProvisionOptions{})
	if err == nil {
		t.Fatal("want an error")
	}
	e := fail.AsError(err)
	if e.ExitCode() != fail.Conflict || e.Code != "CLOUDFLARE_NOT_CONFIGURED" {
		t.Errorf("exit = %d code = %s, want %d CLOUDFLARE_NOT_CONFIGURED", e.ExitCode(), e.Code, fail.Conflict)
	}
	if len(e.Details) != 2 || e.Details[1].Message != "enable Email Routing" {
		t.Errorf("details = %+v, want the two manual steps", e.Details)
	}
	if !strings.Contains(e.Remediation, "cloudmail domain get") {
		t.Errorf("remediation = %q", e.Remediation)
	}
}

func TestDeleteDomain(t *testing.T) {
	c, got := recordingServer(t, 200, `{"ok":true}`)

	res, err := c.DeleteDomain(context.Background(), "example.com")
	if err != nil {
		t.Fatalf("DeleteDomain: %v", err)
	}
	req := onlyRequest(t, got)
	if req.method != "DELETE" || req.path != "/api/v1/domains/example.com" {
		t.Errorf("request = %s %s", req.method, req.path)
	}
	if res.Status != "deleted" || res.Success == nil || !*res.Success {
		t.Errorf("result = %+v", res)
	}
}

func TestDeleteDomainConflictPointsAtMailboxes(t *testing.T) {
	c, _ := recordingServer(t, 409, `{"error":"domain still has mailboxes"}`)

	_, err := c.DeleteDomain(context.Background(), "example.com")
	e := fail.AsError(err)
	if e.ExitCode() != fail.Conflict {
		t.Fatalf("exit = %d, want %d", e.ExitCode(), fail.Conflict)
	}
	if !strings.Contains(e.Remediation, "mailbox") {
		t.Errorf("remediation = %q, want it to mention mailboxes", e.Remediation)
	}
}

func TestDomainIDCannotForgeStructure(t *testing.T) {
	c, got := recordingServer(t, 200, `{"ok":true}`)
	for _, id := range []string{"..", ".", "  "} {
		if _, err := c.DeleteDomain(context.Background(), id); err == nil {
			t.Errorf("%q: want a usage error", id)
		}
	}
	if len(*got) != 0 {
		t.Errorf("the server was contacted %d time(s)", len(*got))
	}

	if _, err := c.DeleteDomain(context.Background(), "a/b"); err != nil {
		t.Fatalf("DeleteDomain: %v", err)
	}
	if p := (*got)[0].path; p != "/api/v1/domains/a%2Fb" {
		t.Errorf("path = %q, want the slash escaped", p)
	}
}

func TestMailboxAliases(t *testing.T) {
	c, got := recordingServer(t, 200, `{"aliases":["hi@example.com"]}`)

	aliases, err := c.MailboxAliases(context.Background(), "hello@example.com")
	if err != nil {
		t.Fatalf("MailboxAliases: %v", err)
	}
	req := onlyRequest(t, got)
	if req.method != "GET" || req.path != "/api/v1/mailboxes/hello@example.com/aliases" {
		t.Errorf("request = %s %s", req.method, req.path)
	}
	if len(aliases) != 1 || aliases[0] != "hi@example.com" {
		t.Errorf("aliases = %v", aliases)
	}
}

func TestSetMailboxAliasesReplacesList(t *testing.T) {
	c, got := recordingServer(t, 200, `{"aliases":["a@example.com","b@example.com"]}`)

	out, err := c.SetMailboxAliases(context.Background(), "hello@example.com",
		[]string{"a@example.com", " b@example.com"})
	if err != nil {
		t.Fatalf("SetMailboxAliases: %v", err)
	}
	req := onlyRequest(t, got)
	if req.method != "PUT" || req.path != "/api/v1/mailboxes/hello@example.com/aliases" {
		t.Errorf("request = %s %s", req.method, req.path)
	}
	sent, _ := req.body["aliases"].([]any)
	if len(sent) != 2 || sent[1] != "b@example.com" {
		t.Errorf("body aliases = %v", req.body["aliases"])
	}
	if len(out) != 2 {
		t.Errorf("returned %v", out)
	}
}

// Clearing must send an empty array, not null or an omitted field, so the server
// cannot read it as "no change".
func TestSetMailboxAliasesClearSendsEmptyArray(t *testing.T) {
	c, got := recordingServer(t, 200, `{"aliases":[]}`)

	if _, err := c.SetMailboxAliases(context.Background(), "hello@example.com", nil); err != nil {
		t.Fatalf("SetMailboxAliases: %v", err)
	}
	sent, ok := onlyRequest(t, got).body["aliases"].([]any)
	if !ok || len(sent) != 0 {
		t.Errorf("aliases = %#v, want []", onlyRequest(t, got).body["aliases"])
	}
}

func TestSetMailboxAliasesRejectsBadAddressLocally(t *testing.T) {
	c, got := recordingServer(t, 200, `{"aliases":[]}`)

	_, err := c.SetMailboxAliases(context.Background(), "hello@example.com",
		[]string{"ok@example.com", "not-an-address"})
	if e := fail.AsError(err); err == nil || e.ExitCode() != fail.Usage {
		t.Errorf("err = %v, want a usage error", err)
	}
	if len(*got) != 0 {
		t.Errorf("the server was contacted")
	}
}

// An env domain needs an explicit confirmation: the flag is sent, and the 428
// the server answers without it is explained.
func TestProvisionEnvDomainConfirmation(t *testing.T) {
	c, got := recordingServer(t, 200, `{"domain":`+domainJSON+`,"provision":{"ok":true,"ranAt":1,"steps":[]}}`)
	if _, err := c.ProvisionDomain(context.Background(), "example.com", ProvisionOptions{ConfirmEnvDomain: true}); err != nil {
		t.Fatalf("ProvisionDomain: %v", err)
	}
	if v := onlyRequest(t, got).body["confirmEnvDomain"]; v != true {
		t.Errorf("confirmEnvDomain = %v, want true", v)
	}

	c, _ = recordingServer(t, 428, `{"error":"comes from DOMAINS/ZONES","code":"confirm_env_domain"}`)
	_, err := c.ProvisionDomain(context.Background(), "example.com", ProvisionOptions{})
	e := fail.AsError(err)
	if e == nil || e.Code != "CONFIRM_ENV_DOMAIN" || !strings.Contains(e.Remediation, "--confirm-env-domain") {
		t.Errorf("err = %+v", e)
	}
}
