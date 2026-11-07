package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

// captureBoth runs the tree with -o json --yes against srvURL and returns
// stdout, stderr and the error.
func captureBoth(t *testing.T, srvURL string, args ...string) (string, string, error) {
	t.Helper()
	t.Setenv("CLOUDMAIL_CONFIG_DIR", t.TempDir())
	t.Setenv("CLOUDMAIL_BASE_URL", srvURL)
	t.Setenv("CLOUDMAIL_TOKEN", "ttk_test_secret")
	t.Setenv("CLOUDMAIL_RETRIES", "0")
	read := func(r *os.File) chan string {
		ch := make(chan string)
		go func() {
			b, _ := io.ReadAll(r)
			ch <- string(b)
		}()
		return ch
	}
	outR, outW, _ := os.Pipe()
	errR, errW, _ := os.Pipe()
	oldOut, oldErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = outW, errW
	outCh, errCh := read(outR), read(errR)
	root, _ := NewRootCommand()
	root.SetArgs(append([]string{"-o", "json", "--yes"}, args...))
	_, runErr := root.ExecuteC()
	outW.Close()
	errW.Close()
	os.Stdout, os.Stderr = oldOut, oldErr
	return <-outCh, <-errCh, runErr
}

const heldBody = `{"status":"pending_approval","approval_id":"apr_0123456789abcdef0123",` +
	`"approval_url":"https://mail.example.com/approvals/apr_0123456789abcdef0123",` +
	`"expires_at":"2026-11-08T12:00:00.000Z","reason":"approval_required",` +
	`"message":"Not sent yet. This mailbox requires the user to approve agent sends."}`

func TestHeldSendsReportTheApproval(t *testing.T) {
	srv, _ := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		if r.Method == http.MethodGet {
			// Used as the original by reply and forward, and as the draft by draft send.
			_, _ = w.Write([]byte(`{"id":"m1","subject":"Hi","sender":"a@example.org","recipient":"c@example.org","cc":"","body":"hello"}`))
			return true
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(heldBody))
		return true
	})
	mb := []string{"--mailbox", "support@example.com"}
	cases := map[string][]string{
		"mail send":       {"mail", "send", "--to", "c@example.org", "--subject", "Hi", "--text", "Hello"},
		"mail reply":      {"mail", "reply", "m1", "--text", "Thanks"},
		"mail forward":    {"mail", "forward", "m1", "--to", "c@example.org"},
		"draft send":      {"draft", "send", "d1"},
		"schedule create": {"schedule", "create", "--to", "c@example.org", "--subject", "Hi", "--text", "Hello", "--in", "1h"},
		"template send":   {"template", "send", "welcome", "--to", "c@example.org", "--force"},
		"sequence enroll": {"sequence", "enroll", "seq_1", "--person", "c@example.org"},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			stdout, stderr, err := captureBoth(t, srv.URL, append(args, mb...)...)
			if err != nil {
				t.Fatalf("err = %v (held sends exit 0)\nstderr: %s", err, stderr)
			}
			var got map[string]any
			if jerr := json.Unmarshal([]byte(stdout), &got); jerr != nil {
				t.Fatalf("stdout is not one JSON object: %v\n%s", jerr, stdout)
			}
			if _, has := got["id"]; has {
				t.Errorf("held output carries an id: %s", stdout)
			}
			for _, k := range []string{"approval_id", "approval_url", "expires_at", "message"} {
				if s, _ := got[k].(string); s == "" {
					t.Errorf("held output lacks %s: %s", k, stdout)
				}
			}
			if got["status"] != "pending_approval" {
				t.Errorf("status = %v", got["status"])
			}
			if strings.Contains(stderr, "sent as") {
				t.Errorf("stderr claims the mail was sent: %s", stderr)
			}
			want := "held for approval: apr_0123456789abcdef0123 — a person must approve it at https://mail.example.com/approvals/apr_0123456789abcdef0123"
			if !strings.Contains(stderr, want) {
				t.Errorf("stderr = %q, want it to contain %q", stderr, want)
			}
		})
	}
}

func TestAcceptedSendStillSaysSentAs(t *testing.T) {
	srv, _ := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"id":"m9","status":"sent"}`))
		return true
	})
	stdout, stderr, err := captureBoth(t, srv.URL, "mail", "send", "--mailbox", "support@example.com",
		"--to", "c@example.org", "--subject", "Hi", "--text", "Hello")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout, `"id": "m9"`) || !strings.Contains(stderr, "sent as m9") {
		t.Errorf("stdout = %s\nstderr = %s", stdout, stderr)
	}
}
