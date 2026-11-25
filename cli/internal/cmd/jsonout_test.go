package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

// captureStdout runs the tree with -o json against srv and returns what reached
// stdout, plus the error.
func captureStdout(t *testing.T, srvURL string, args ...string) (string, error) {
	t.Helper()
	t.Setenv("CLOUDMAIL_CONFIG_DIR", t.TempDir())
	t.Setenv("CLOUDMAIL_BASE_URL", srvURL)
	t.Setenv("CLOUDMAIL_TOKEN", "ttk_test_secret")
	t.Setenv("CLOUDMAIL_RETRIES", "0")
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = w
	done := make(chan string)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	root, _ := NewRootCommand()
	root.SetArgs(append([]string{"-o", "json", "--yes"}, args...))
	_, runErr := root.ExecuteC()
	w.Close()
	os.Stdout = old
	return <-done, runErr
}

// jsonServer answers each route with a realistic body, including lists of
// several items, which is where a per-row encoder would show.
func jsonServer(t *testing.T) string {
	t.Helper()
	two := func(one string) string { return "[" + one + "," + one + "]" }
	approval := `{"id":"apr_1","kind":"send_email","status":"pending","recipients":["c@x.com"],"subject":"Hi <b>","revision":1,"requested_by":{"via":"mcp","tokenName":"bot"},"messages":[{"to":["c@x.com"],"subject":"Hi","html":"<p>x</p>"}]}`
	email := `{"id":"m1","thread_id":"t1","subject":"Hello","sender":"a@x.com","recipient":"b@x.com","date":"2026-11-01T00:00:00Z","read":false,"starred":false,"snippet":"hi there","folder_id":"inbox"}`
	srv, _ := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		p := r.URL.Path
		switch {
		case strings.HasSuffix(p, "/approvals"):
			_, _ = w.Write([]byte(`{"approvals":` + two(approval) + `}`))
		case strings.Contains(p, "/approvals/"):
			_, _ = w.Write([]byte(`{"approval":` + approval + `}`))
		case r.Method == "POST" && strings.HasSuffix(p, "/emails"):
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"id":"m2","status":"queued","undo_until":"2026-11-07T12:00:30Z"}`))
		case strings.HasSuffix(p, "/emails") || strings.HasSuffix(p, "/search"):
			_, _ = w.Write([]byte(`{"emails":` + two(email) + `,"totalCount":2}`))
		case strings.HasSuffix(p, "/emails/m1"):
			_, _ = w.Write([]byte(email))
		case strings.HasSuffix(p, "/labels"):
			_, _ = w.Write([]byte(`[{"id":"l1","name":"A"},{"id":"l2","name":"B"}]`))
		case strings.HasSuffix(p, "/folders"):
			_, _ = w.Write([]byte(`[{"id":"inbox","name":"Inbox"},{"id":"sent","name":"Sent"}]`))
		case p == "/api/v1/me":
			_, _ = w.Write([]byte(`{"role":"admin","kind":"user","email":"o@x.com","enforced":true,"mailboxes":["s@x.com"],"capabilities":null}`))
		case p == "/api/v1/mailboxes":
			_, _ = w.Write([]byte(`[{"id":"s@x.com","name":"S"},{"id":"t@x.com","name":"T"}]`))
		case p == "/api/v1/webhooks":
			_, _ = w.Write([]byte(`{"webhooks":[{"id":"wh1","name":"a","url":"https://x","events":["message.sent"]}]}`))
		case p == "/api/v1/sending-health":
			_, _ = w.Write([]byte(`{"domains":[{"domain":"x.com","level":"ok"},{"domain":"y.com","level":"warn"}],"thresholds":{}}`))
		case p == "/api/v1/ask":
			_, _ = w.Write([]byte(`{"answer":"Yes.","sources":[{"id":"m1","subject":"Hello"}],"semantic":true}`))
		case strings.HasSuffix(p, "/domains"):
			_, _ = w.Write([]byte(`{"domains":[{"id":"dom_1","hostname":"x.com"}]}`))
		case strings.Contains(p, "/domains/"):
			_, _ = w.Write([]byte(`{"domain":{"id":"dom_1","hostname":"x.com"},"checks":[],"manualSteps":["add MX"],"cloudflare":{}}`))
		case p == "/api/v1/ai/providers":
			_, _ = w.Write([]byte(`{"providers":[],"routing":{},"problems":[{"role":"summary","reason":"no json"}],"status":{"line":"Workers AI"},"usage":{"month":"2026-11","byProvider":[]}}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
		return true
	})
	return srv.URL
}

// With -o json every command prints exactly one valid JSON document on stdout;
// commentary belongs on stderr.
func TestJSONOutputIsOneValidDocument(t *testing.T) {
	url := jsonServer(t)
	mb := []string{"--mailbox", "s@x.com"}
	for _, args := range [][]string{
		append([]string{"approval", "list"}, mb...),
		append([]string{"approval", "show", "apr_1"}, mb...),
		append([]string{"approval", "approve", "apr_1"}, mb...),
		append([]string{"mail", "send", "--to", "c@x.com", "--subject", "Hi", "--text", "x"}, mb...),
		append([]string{"mail", "list"}, mb...),
		append([]string{"mail", "search", "hello"}, mb...),
		append([]string{"mail", "get", "m1"}, mb...),
		append([]string{"label", "list"}, mb...),
		append([]string{"folder", "list"}, mb...),
		append([]string{"ask", "is it done?"}, mb...),
		{"auth", "whoami"},
		{"mailbox", "list"},
		{"webhook", "list"},
		{"sending", "health"},
		{"domain", "get", "x.com"},
		{"ai", "status"},
		{"ai", "provider", "list"},
		{"version"},
		{"config", "show"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			out, err := captureStdout(t, url, args...)
			if err != nil {
				t.Fatalf("command failed: %v", err)
			}
			if !json.Valid([]byte(out)) {
				t.Fatalf("stdout is not one valid JSON document:\n%s", out)
			}
			// json.Valid accepts one value surrounded by whitespace only, so
			// this also rules out a second document or a stray line.
		})
	}
}
