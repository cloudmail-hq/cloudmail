package cmd

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// withStdin replaces os.Stdin with a pipe holding s for the rest of the test.
func withStdin(t *testing.T, s string) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.WriteString(s)
	_ = w.Close()
	old := os.Stdin
	os.Stdin = r
	t.Cleanup(func() { os.Stdin = old; _ = r.Close() })
}

const mdBody = "Hi Maya,\n\n- **Done:** EU\n- Next: APAC\n\nThanks,\nSam\n"

func TestSendCarriesTheMarkdownBody(t *testing.T) {
	srv, hits := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"id":"m1","status":"sent"}`))
		return true
	})
	if e := run(t, srv, "--yes", "mail", "send", "--mailbox", "s@example.com",
		"--to", "c@example.org", "--subject", "Plan", "--markdown", mdBody); e != nil {
		t.Fatalf("send: %v", e)
	}
	h := hits()
	if len(h) != 1 || h[0].path != "/api/v1/mailboxes/s@example.com/emails" {
		t.Fatalf("requests = %+v", h)
	}
	if h[0].body["markdown"] != mdBody {
		t.Errorf("markdown = %q", h[0].body["markdown"])
	}
	for _, k := range []string{"html", "text"} {
		if _, ok := h[0].body[k]; ok {
			t.Errorf("%s should be absent when only Markdown is given: %v", k, h[0].body)
		}
	}
}

func TestSendMarkdownWithTextKeepsBoth(t *testing.T) {
	srv, hits := fakeDeployment(t, nil)
	_ = run(t, srv, "--yes", "mail", "send", "--mailbox", "s@example.com",
		"--to", "c@example.org", "--subject", "Plan", "--markdown", "**hi**", "--text", "hi")
	h := hits()
	if len(h) != 1 || h[0].body["markdown"] != "**hi**" || h[0].body["text"] != "hi" {
		t.Fatalf("requests = %+v", h)
	}
}

func TestReplyReadsMarkdownFromStdin(t *testing.T) {
	srv, hits := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		if r.Method == "GET" {
			_, _ = w.Write([]byte(`{"id":"e1","sender":"maya@example.org","subject":"Plan"}`))
			return true
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"id":"m1","status":"sent"}`))
		return true
	})
	withStdin(t, mdBody)
	if e := run(t, srv, "--yes", "mail", "reply", "e1", "--mailbox", "s@example.com", "--markdown-file", "-"); e != nil {
		t.Fatalf("reply: %v", e)
	}
	h := hits()
	if len(h) != 2 || h[1].path != "/api/v1/mailboxes/s@example.com/emails/e1/reply" {
		t.Fatalf("requests = %+v", h)
	}
	if h[1].body["markdown"] != mdBody || h[1].body["subject"] != "Re: Plan" {
		t.Errorf("body = %v", h[1].body)
	}
}

func TestMarkdownAndHTMLTogetherAreRefused(t *testing.T) {
	dir := t.TempDir()
	html := filepath.Join(dir, "b.html")
	if err := os.WriteFile(html, []byte("<p>x</p>"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv, hits := fakeDeployment(t, nil)
	for _, args := range [][]string{
		{"mail", "send", "--to", "c@example.org", "--subject", "S", "--markdown", "x", "--html", "<p>x</p>"},
		{"mail", "send", "--to", "c@example.org", "--subject", "S", "--markdown", "x", "--html-file", html},
		{"schedule", "create", "--to", "c@example.org", "--subject", "S", "--markdown-file", "-", "--html", "<p>x</p>", "--in", "1h"},
		{"mail", "send", "--to", "c@example.org", "--subject", "S", "--body-file", "-", "--markdown-file", "-"},
	} {
		e := run(t, srv, append([]string{"--yes", "--mailbox", "s@example.com"}, args...)...)
		if exitOf(e) != fail.Usage {
			t.Errorf("%v: exit %d, want usage (%v)", args, exitOf(e), e)
		}
	}
	if len(hits()) != 0 {
		t.Errorf("requests sent: %+v", hits())
	}
}

func TestDraftMarkdownReplacesBody(t *testing.T) {
	srv, hits := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		_, _ = w.Write([]byte(`{"id":"d1"}`))
		return true
	})
	if e := run(t, srv, "--mailbox", "s@example.com", "draft", "create", "--to", "c@example.org",
		"--subject", "Plan", "--markdown", mdBody); e != nil {
		t.Fatalf("draft create: %v", e)
	}
	if e := run(t, srv, "--mailbox", "s@example.com", "draft", "update", "d1", "--subject", "Plan v2"); e != nil {
		t.Fatalf("draft update: %v", e)
	}
	h := hits()
	if len(h) != 2 {
		t.Fatalf("requests = %+v", h)
	}
	if _, ok := h[0].body["body"]; ok || h[0].body["markdown"] != mdBody {
		t.Errorf("create body = %v", h[0].body)
	}
	// Without a Markdown flag the draft still sends `body`, even empty, as before.
	if got, ok := h[1].body["body"]; !ok || got != "" {
		t.Errorf("update body = %v", h[1].body)
	}
	if _, ok := h[1].body["markdown"]; ok {
		t.Errorf("update should carry no markdown: %v", h[1].body)
	}
}

func TestDraftBodyAndMarkdownTogetherAreRefused(t *testing.T) {
	srv, hits := fakeDeployment(t, nil)
	for _, args := range [][]string{
		{"draft", "create", "--to", "c@example.org", "--body", "x", "--markdown", "x"},
		{"draft", "update", "d1", "--body-file", "-", "--markdown-file", "-"},
		{"draft", "create", "--to", "c@example.org", "--markdown", "   "},
	} {
		e := run(t, srv, append([]string{"--mailbox", "s@example.com"}, args...)...)
		if exitOf(e) != fail.Usage {
			t.Errorf("%v: exit %d, want usage (%v)", args, exitOf(e), e)
		}
	}
	if len(hits()) != 0 {
		t.Errorf("requests sent: %+v", hits())
	}
}

func TestApprovalEditAndReviseTakeMarkdown(t *testing.T) {
	srv, hits := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		_, _ = w.Write([]byte(`{"approval":` + approvalJSON + `}`))
		return true
	})
	file := filepath.Join(t.TempDir(), "fix.md")
	if err := os.WriteFile(file, []byte(mdBody), 0o600); err != nil {
		t.Fatal(err)
	}
	if e := run(t, srv, "--mailbox", "s@example.com", "approval", "edit", "apr_1", "--markdown-file", file); e != nil {
		t.Fatalf("edit: %v", e)
	}
	withStdin(t, mdBody)
	if e := run(t, srv, "--mailbox", "s@example.com", "approval", "revise", "apr_1", "--markdown-file", "-"); e != nil {
		t.Fatalf("revise: %v", e)
	}
	h := hits()
	if len(h) != 2 || h[0].method != "PATCH" || h[1].path != "/api/v1/mailboxes/s@example.com/approvals/apr_1/revise" {
		t.Fatalf("requests = %+v", h)
	}
	for _, x := range h {
		if x.body["markdown"] != mdBody {
			t.Errorf("%s %s: markdown = %v", x.method, x.path, x.body["markdown"])
		}
		if _, ok := x.body["html"]; ok {
			t.Errorf("%s %s: html should be absent: %v", x.method, x.path, x.body)
		}
	}

	before := len(hits())
	for _, args := range [][]string{
		{"approval", "edit", "apr_1", "--markdown-file", file, "--body-file", file},
		{"approval", "revise", "apr_1", "--markdown-file", file, "--body-file", file},
	} {
		if e := run(t, srv, append([]string{"--mailbox", "s@example.com"}, args...)...); exitOf(e) != fail.Usage {
			t.Errorf("%v: exit %d, want usage", args, exitOf(e))
		}
	}
	if len(hits()) != before {
		t.Errorf("conflicting flags still sent a request: %+v", hits()[before:])
	}
}
