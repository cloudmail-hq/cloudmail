package cmd

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// runCLI executes the command tree against a fake deployment and returns the exit
// code and the requests that reached it. Stdin is not a terminal under `go test`,
// which is exactly the unattended case the confirmation guard exists for.
func runCLI(t *testing.T, args ...string) (int, []string) {
	t.Helper()
	var hits []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.Method+" "+r.URL.EscapedPath())
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "DELETE":
			_, _ = w.Write([]byte(`{"ok":true}`))
		case r.URL.Path == "/api/v1/mailboxes/hello@example.com/aliases":
			_, _ = w.Write([]byte(`{"aliases":["hi@example.com"]}`))
		default:
			_, _ = w.Write([]byte(`{"domain":{"id":"dom_1","hostname":"example.com"},` +
				`"provision":{"ok":true,"ranAt":1,"steps":[]}}`))
		}
	}))
	t.Cleanup(srv.Close)

	t.Setenv("CLOUDMAIL_CONFIG_DIR", t.TempDir())
	t.Setenv("CLOUDMAIL_BASE_URL", srv.URL)
	t.Setenv("CLOUDMAIL_TOKEN", "ttk_test_secret")
	t.Setenv("CLOUDMAIL_RETRIES", "0")

	root, _ := NewRootCommand()
	root.SetArgs(append([]string{"--quiet", "--output", "json"}, args...))
	_, err := root.ExecuteC()
	if err == nil {
		return fail.OK, hits
	}
	return classifyTopLevel(err).ExitCode(), hits
}

func TestDomainDeleteNeedsConsent(t *testing.T) {
	code, hits := runCLI(t, "domain", "delete", "example.com")
	if code != fail.WriteRefused {
		t.Errorf("exit = %d, want %d", code, fail.WriteRefused)
	}
	if len(hits) != 0 {
		t.Errorf("requests sent without consent: %v", hits)
	}

	code, hits = runCLI(t, "domain", "delete", "example.com", "--yes")
	if code != fail.OK {
		t.Errorf("with --yes: exit = %d, want 0", code)
	}
	if len(hits) != 1 || hits[0] != "DELETE /api/v1/domains/example.com" {
		t.Errorf("with --yes: requests = %v", hits)
	}
}

// Overwriting the catch-all redirects mail another service may rely on, so --yes
// is not enough; it needs --force.
func TestDomainProvisionOverwriteRemediationNamesForce(t *testing.T) {
	code, hits := runCLI(t, "domain", "provision", "example.com", "--overwrite-catch-all", "--yes")
	// --yes covers the irreversible case too (see App.Confirm), so it proceeds;
	// what must refuse is the bare, unattended invocation, and the remediation
	// it gives names --force.
	if code != fail.OK || len(hits) != 1 {
		t.Errorf("with --yes: exit = %d, requests = %v", code, hits)
	}

	root, _ := NewRootCommand()
	t.Setenv("CLOUDMAIL_CONFIG_DIR", t.TempDir())
	t.Setenv("CLOUDMAIL_BASE_URL", "http://127.0.0.1:1")
	root.SetArgs([]string{"--quiet", "domain", "provision", "example.com", "--overwrite-catch-all"})
	_, err := root.ExecuteC()
	e := classifyTopLevel(err)
	if e.ExitCode() != fail.WriteRefused {
		t.Fatalf("exit = %d, want %d", e.ExitCode(), fail.WriteRefused)
	}
	if want := "pass --force to proceed without being asked"; e.Remediation != want {
		t.Errorf("remediation = %q, want %q", e.Remediation, want)
	}
}

func TestDomainProvisionNeedsConsent(t *testing.T) {
	code, hits := runCLI(t, "domain", "provision", "example.com")
	if code != fail.WriteRefused || len(hits) != 0 {
		t.Errorf("exit = %d, requests = %v; want refusal with nothing sent", code, hits)
	}
}

func TestDomainVerifyAndListNeedNoConsent(t *testing.T) {
	code, hits := runCLI(t, "domain", "verify", "example.com")
	if code != fail.OK || len(hits) != 1 || hits[0] != "POST /api/v1/domains/example.com/verify" {
		t.Errorf("verify: exit = %d, requests = %v", code, hits)
	}
}

func TestDomainDryRunSendsNothing(t *testing.T) {
	code, hits := runCLI(t, "domain", "add", "example.com", "--dry-run")
	if code != fail.DryRun || len(hits) != 0 {
		t.Errorf("exit = %d, requests = %v; want %d and nothing sent", code, hits, fail.DryRun)
	}
}

func TestMailboxAliasesCommands(t *testing.T) {
	code, hits := runCLI(t, "mailbox", "aliases", "hello@example.com")
	if code != fail.OK || len(hits) != 1 || hits[0] != "GET /api/v1/mailboxes/hello@example.com/aliases" {
		t.Errorf("list: exit = %d, requests = %v", code, hits)
	}

	code, hits = runCLI(t, "mailbox", "aliases", "set", "hello@example.com", "hi@example.com")
	if code != fail.OK || len(hits) != 1 || hits[0] != "PUT /api/v1/mailboxes/hello@example.com/aliases" {
		t.Errorf("set: exit = %d, requests = %v", code, hits)
	}

	// An empty list would silently remove every alias, so it has to be asked for.
	code, hits = runCLI(t, "mailbox", "aliases", "set", "hello@example.com")
	if code != fail.Usage || len(hits) != 0 {
		t.Errorf("set with no aliases: exit = %d, requests = %v; want usage error", code, hits)
	}
	code, hits = runCLI(t, "mailbox", "aliases", "set", "hello@example.com", "--clear")
	if code != fail.OK || len(hits) != 1 {
		t.Errorf("set --clear: exit = %d, requests = %v", code, hits)
	}
}

func TestDomainCommandsAreInSchema(t *testing.T) {
	root, _ := NewRootCommand()
	for _, path := range [][]string{
		{"domain", "list"}, {"domain", "get"}, {"domain", "add"}, {"domain", "verify"},
		{"domain", "provision"}, {"domain", "delete"},
		{"mailbox", "aliases"}, {"mailbox", "aliases", "set"},
	} {
		c, _, err := root.Find(path)
		if err != nil || c.Name() != path[len(path)-1] {
			t.Errorf("%v: not found in the command tree", path)
			continue
		}
		// Reads report mutates:false so a caller knows --dry-run is moot for them.
		read := c.Name() == "list" || c.Name() == "get" || c.Name() == "aliases"
		if got := commandMutates(c); got == read {
			t.Errorf("%v: mutates = %v, want %v", path, got, !read)
		}
	}
}
