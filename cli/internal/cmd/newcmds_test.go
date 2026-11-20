package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

type hit struct {
	method, path, query string
	body                map[string]any
}

// fakeDeployment answers with respond (or `{}`) and records every request.
func fakeDeployment(t *testing.T, respond func(r *http.Request, w http.ResponseWriter) bool) (*httptest.Server, func() []hit) {
	t.Helper()
	var mu sync.Mutex
	var hits []hit
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		hits = append(hits, hit{r.Method, r.URL.EscapedPath(), r.URL.RawQuery, body})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if respond != nil && respond(r, w) {
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(srv.Close)
	return srv, func() []hit {
		mu.Lock()
		defer mu.Unlock()
		return append([]hit(nil), hits...)
	}
}

// run executes the tree against srv without --yes and returns the error.
func run(t *testing.T, srv *httptest.Server, args ...string) *fail.Error {
	t.Helper()
	t.Setenv("CLOUDMAIL_CONFIG_DIR", t.TempDir())
	t.Setenv("CLOUDMAIL_BASE_URL", srv.URL)
	t.Setenv("CLOUDMAIL_TOKEN", "ttk_test_secret")
	t.Setenv("CLOUDMAIL_RETRIES", "0")
	root, _ := NewRootCommand()
	root.SetOut(io.Discard)
	root.SetArgs(append([]string{"--quiet", "--output", "json"}, args...))
	_, err := root.ExecuteC()
	if err == nil {
		return nil
	}
	return classifyTopLevel(err)
}

func exitOf(e *fail.Error) int {
	if e == nil {
		return fail.OK
	}
	return e.ExitCode()
}

const approvalJSON = `{"id":"apr_1","status":"pending","recipients":["c@x.com"],"subject":"Hi","revision":3,"requested_by":{"via":"mcp"}}`

func TestApproveSendsTheRevisionItFetched(t *testing.T) {
	srv, hits := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		_, _ = w.Write([]byte(`{"approval":` + approvalJSON + `}`))
		return true
	})
	if e := run(t, srv, "--mailbox", "s@x.com", "approval", "approve", "apr_1", "--yes"); e != nil {
		t.Fatalf("approve: %v", e)
	}
	h := hits()
	if len(h) != 2 || h[0].method != "GET" || h[1].path != "/api/v1/mailboxes/s@x.com/approvals/apr_1/approve" {
		t.Fatalf("requests = %+v", h)
	}
	if h[1].body["revision"] != float64(3) {
		t.Errorf("approve body = %v, want revision 3", h[1].body)
	}
}

func TestApproveRevisionFlagSkipsTheFetch(t *testing.T) {
	srv, hits := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		_, _ = w.Write([]byte(`{"approval":` + approvalJSON + `}`))
		return true
	})
	if e := run(t, srv, "--mailbox", "s@x.com", "approval", "approve", "apr_1", "--revision", "2", "--yes"); e != nil {
		t.Fatalf("approve: %v", e)
	}
	h := hits()
	if len(h) != 1 || h[0].body["revision"] != float64(2) {
		t.Fatalf("requests = %+v", h)
	}
	if e := run(t, srv, "--mailbox", "s@x.com", "approval", "approve", "apr_1", "--revision", "0", "--yes"); exitOf(e) != fail.Usage {
		t.Errorf("--revision 0: exit %d, want usage", exitOf(e))
	}
}

// The requester revises between the CLI's read and its approve: the server
// refuses with 409, and a read-back shows a newer revision, still pending.
func TestApproveOfAChangedItemSaysToReview(t *testing.T) {
	var mu sync.Mutex
	posted := false
	srv, _ := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == "POST" {
			posted = true
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"It was changed after you opened it. Nothing was sent. Review the new version, then approve."}`))
			return true
		}
		if posted {
			_, _ = w.Write([]byte(`{"approval":` + strings.Replace(approvalJSON, `"revision":3`, `"revision":4`, 1) + `}`))
			return true
		}
		_, _ = w.Write([]byte(`{"approval":` + approvalJSON + `}`))
		return true
	})
	e := run(t, srv, "--mailbox", "s@x.com", "approval", "approve", "apr_1", "--yes")
	if exitOf(e) != fail.Conflict || e.Code != "APPROVAL_REVISED" {
		t.Fatalf("exit = %d code = %v", exitOf(e), e)
	}
	if !strings.Contains(e.Remediation, "cloudmail approval show apr_1") {
		t.Errorf("remediation = %q", e.Remediation)
	}
}

// A 409 because the item was already decided is not a revision, and must keep
// the server's own message rather than telling the user to review.
func TestApproveOfAnAlreadySentItemIsNotCalledRevised(t *testing.T) {
	sent := strings.Replace(approvalJSON, `"status":"pending"`, `"status":"sent"`, 1)
	srv, _ := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		if r.Method == "POST" {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"Already sent; nothing was sent again."}`))
			return true
		}
		_, _ = w.Write([]byte(`{"approval":` + sent + `}`))
		return true
	})
	e := run(t, srv, "--mailbox", "s@x.com", "approval", "approve", "apr_1", "--revision", "3", "--yes")
	if exitOf(e) != fail.Conflict || e.Code == "APPROVAL_REVISED" {
		t.Fatalf("exit = %d code = %v", exitOf(e), e)
	}
	if !strings.Contains(e.Message, "Already sent") {
		t.Errorf("message = %q", e.Message)
	}
}

// Without a terminal or --yes, approve refuses before it reads anything.
func TestApproveRefusesUnattendedBeforeAnyRequest(t *testing.T) {
	srv, hits := fakeDeployment(t, nil)
	if e := run(t, srv, "--mailbox", "s@x.com", "approval", "approve", "apr_1"); exitOf(e) != fail.WriteRefused {
		t.Fatalf("exit = %d", exitOf(e))
	}
	if h := hits(); len(h) != 0 {
		t.Errorf("requests before consent: %+v", h)
	}
}

// Validation runs before the confirmation, so a typo is a usage error.
func TestInvalidInputIsAUsageErrorBeforeConsent(t *testing.T) {
	for _, args := range [][]string{
		{"delegate", "set", "a@x.com", "--role", "boss", "--mailbox", "s@x.com"},
		{"sending", "set-limits", "--mailbox", "s@x.com"},
	} {
		srv, hits := fakeDeployment(t, nil)
		if e := run(t, srv, args...); exitOf(e) != fail.Usage {
			t.Errorf("%v: exit = %d, want usage", args, exitOf(e))
		}
		if h := hits(); len(h) != 0 {
			t.Errorf("%v: sent %+v", args, h)
		}
	}
}

func TestApproveWithoutConsentSendsNothing(t *testing.T) {
	srv, hits := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		_, _ = w.Write([]byte(`{"approval":` + approvalJSON + `}`))
		return true
	})
	e := run(t, srv, "--mailbox", "s@x.com", "approval", "approve", "apr_1")
	if exitOf(e) != fail.WriteRefused {
		t.Fatalf("exit = %d", exitOf(e))
	}
	for _, h := range hits() {
		if h.method == "POST" {
			t.Fatalf("sent without consent: %+v", h)
		}
	}
}

func TestReviseSendsTheEdits(t *testing.T) {
	srv, hits := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		_, _ = w.Write([]byte(`{"approval":` + approvalJSON + `}`))
		return true
	})
	if e := run(t, srv, "--mailbox", "s@x.com", "approval", "revise", "apr_1", "--subject", "Fixed", "--to", "d@x.com"); e != nil {
		t.Fatalf("revise: %v", e)
	}
	h := hits()
	if len(h) != 1 || h[0].method != "POST" || h[0].path != "/api/v1/mailboxes/s@x.com/approvals/apr_1/revise" ||
		h[0].body["subject"] != "Fixed" {
		t.Fatalf("requests = %+v", h)
	}
	if e := run(t, srv, "--mailbox", "s@x.com", "approval", "revise", "apr_1"); exitOf(e) != fail.Usage {
		t.Errorf("revise with no edits: exit %d, want usage", exitOf(e))
	}
}

// Every destructive or redirecting command must refuse without a terminal or
// --yes, and must send nothing when it does.
func TestSensitiveCommandsNeedConsent(t *testing.T) {
	for _, args := range [][]string{
		{"branding", "reset"},
		{"branding", "logo", "delete"},
		{"privacy", "set", "--settings", `{"retention":{"trashDays":1}}`},
		{"delegate", "remove", "user", "a@x.com", "--mailbox", "s@x.com"},
		{"delegate", "set", "a@x.com", "--role", "owner", "--mailbox", "s@x.com"},
		{"domain", "update", "example.com", "--catch-all", "s@example.com"},
		{"domain", "update", "example.com", "--no-catch-all"},
		{"webhook", "rotate-secret", "wh_1"},
		{"webhook", "update", "wh_1", "--url", "https://elsewhere.example.com"},
		{"product", "delete", "acme"},
		{"ai", "provider", "delete", "corp"},
		{"sending", "pause", "example.com"},
		{"sending", "set-limits", "--hourly", "5", "--mailbox", "s@x.com"},
		{"template", "send", "welcome", "--to", "a@x.com", "--mailbox", "s@x.com"},
		{"migrate", "run", "s@x.com"},
		{"notification", "remove", "dev_1"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			srv, hits := fakeDeployment(t, nil)
			if e := run(t, srv, args...); exitOf(e) != fail.WriteRefused {
				t.Errorf("exit = %d, want %d (%v)", exitOf(e), fail.WriteRefused, e)
			}
			if h := hits(); len(h) != 0 {
				t.Errorf("requests sent without consent: %+v", h)
			}
		})
	}
}

func TestDryRunOfNewMutationsSendsNothing(t *testing.T) {
	for _, args := range [][]string{
		{"branding", "set", "--app-name", "X"},
		{"usage", "budget", "--ai-usd", "none"},
		{"privacy", "tracking", "set", "--open", "off", "--mailbox", "s@x.com"},
		{"licence", "refresh"},
		{"approval", "retry", "apr_1", "--mailbox", "s@x.com"},
	} {
		srv, hits := fakeDeployment(t, nil)
		if e := run(t, srv, append(args, "--dry-run")...); exitOf(e) != fail.DryRun {
			t.Errorf("%v: exit = %d, want %d", args, exitOf(e), fail.DryRun)
		}
		if h := hits(); len(h) != 0 {
			t.Errorf("%v: sent %+v", args, h)
		}
	}
}

func TestNewCommandsReachTheirRoutes(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"approval", "count", "--mailbox", "s@x.com"}, "GET /api/v1/mailboxes/s@x.com/approvals/count"},
		{[]string{"branding", "show"}, "GET /api/v1/branding"},
		{[]string{"delegate", "list", "--mailbox", "s@x.com"}, "GET /api/v1/mailboxes/s@x.com/delegates"},
		{[]string{"usage", "budget", "--ai-usd", "12.5"}, "PUT /api/v1/usage/budget"},
		{[]string{"sending", "health"}, "GET /api/v1/sending-health"},
		{[]string{"sending", "resume", "example.com", "--yes"}, "POST /api/v1/sending-health/example.com/resume"},
		{[]string{"licence", "status"}, "GET /api/v1/licence"},
		{[]string{"cloudflare", "plan", "0123456789abcdef0123456789abcdef"}, "POST /api/v1/cloudflare/plan"},
		{[]string{"migrate", "run", "s@x.com", "--check"}, "POST /api/v1/_migrate/mailboxes/s@x.com"},
		{[]string{"ai", "routing"}, "GET /api/v1/ai/routing"},
		{[]string{"thread", "summary", "t1", "--generate", "--mailbox", "s@x.com"}, "POST /api/v1/mailboxes/s@x.com/threads/t1/summary/generate"},
		{[]string{"mail", "search", "--all", "--mode", "hybrid", "invoice"}, "GET /api/v1/search"},
		{[]string{"suppression", "check", "a@x.com"}, "POST /api/v1/suppressions/check"},
		{[]string{"webhook", "events"}, "GET /api/v1/webhooks/events"},
		{[]string{"auth", "deployment"}, "GET /api/v1/config"},
	} {
		srv, hits := fakeDeployment(t, nil)
		if e := run(t, srv, tc.args...); e != nil {
			t.Errorf("%v: %v", tc.args, e)
			continue
		}
		h := hits()
		if len(h) == 0 || h[len(h)-1].method+" "+h[len(h)-1].path != tc.want {
			t.Errorf("%v: requests = %+v, want %s", tc.args, h, tc.want)
		}
	}
}

func TestMigrateCheckUsesTheServersDryRunAndBudgetNoneClears(t *testing.T) {
	srv, hits := fakeDeployment(t, nil)
	if e := run(t, srv, "migrate", "run", "s@x.com", "--check"); e != nil {
		t.Fatal(e)
	}
	if q := hits()[0].query; q != "dryRun=1" {
		t.Errorf("query = %q", q)
	}
	srv, hits = fakeDeployment(t, nil)
	if e := run(t, srv, "usage", "budget", "--ai-usd", "none"); e != nil {
		t.Fatal(e)
	}
	b := hits()[0].body
	if v, ok := b["ai_usd"]; !ok || v != nil {
		t.Errorf("body = %v, want ai_usd null", b)
	}
	if _, ok := b["email_usd"]; ok {
		t.Errorf("email_usd should be left out: %v", b)
	}
}

func TestAccountExportDownloadWritesAZipAndRefusesToOverwrite(t *testing.T) {
	srv, _ := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		switch r.URL.Path {
		case "/api/v1/account/exports":
			_, _ = w.Write([]byte(`{"exports":[{"id":"ex_1","status":"ready","createdAt":1,"expiresAt":2,` +
				`"downloadUrl":"/api/v1/account/exports/ex_1/download?token=sig"}]}`))
		case "/api/v1/account/exports/ex_1/download":
			if r.URL.Query().Get("token") != "sig" || r.Header.Get("Authorization") == "" {
				w.WriteHeader(http.StatusForbidden)
				return true
			}
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write([]byte("PK zip bytes"))
		}
		return true
	})
	dest := filepath.Join(t.TempDir(), "out.zip")
	if e := run(t, srv, "account", "export", "download", "ex_1", "--output-file", dest); e != nil {
		t.Fatalf("download: %v", e)
	}
	got, _ := os.ReadFile(dest)
	if string(got) != "PK zip bytes" {
		t.Errorf("file = %q", got)
	}
	if info, _ := os.Stat(dest); info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", info.Mode().Perm())
	}
	if e := run(t, srv, "account", "export", "download", "ex_1", "--output-file", dest); exitOf(e) != fail.WriteRefused {
		t.Errorf("second download: exit %d, want refusal to overwrite", exitOf(e))
	}
}

func TestAccountExportRefusesAForeignDownloadLink(t *testing.T) {
	srv, hits := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		_, _ = w.Write([]byte(`{"exports":[{"id":"ex_1","status":"ready","createdAt":1,"expiresAt":2,` +
			`"downloadUrl":"https://evil.example.com/api/v1/account/exports/ex_1/download"}]}`))
		return true
	})
	dest := filepath.Join(t.TempDir(), "out.zip")
	if e := run(t, srv, "account", "export", "download", "ex_1", "--output-file", dest); e == nil {
		t.Fatal("want a refusal")
	}
	if len(hits()) != 1 {
		t.Errorf("followed a foreign link: %+v", hits())
	}
	if _, err := os.Stat(dest); err == nil {
		t.Errorf("left a file behind")
	}
}

func TestExportListHidesTheSignedLink(t *testing.T) {
	srv, _ := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		_, _ = w.Write([]byte(`{"exports":[{"id":"ex_1","status":"ready","createdAt":1,"expiresAt":2,` +
			`"downloadUrl":"/api/v1/account/exports/ex_1/download?token=SECRETSIG"}]}`))
		return true
	})
	t.Setenv("CLOUDMAIL_CONFIG_DIR", t.TempDir())
	t.Setenv("CLOUDMAIL_BASE_URL", srv.URL)
	t.Setenv("CLOUDMAIL_TOKEN", "ttk_test_secret")
	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w
	root, _ := NewRootCommand()
	root.SetArgs([]string{"--quiet", "--output", "json", "account", "export", "list"})
	_, err := root.ExecuteC()
	w.Close()
	os.Stdout = old
	out, _ := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "SECRETSIG") {
		t.Errorf("output leaks the signed link: %s", out)
	}
	if !strings.Contains(string(out), `"downloadable": true`) {
		t.Errorf("output = %s", out)
	}
}
