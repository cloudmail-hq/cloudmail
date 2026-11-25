package cmd

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

const flowApprovalJSON = `{"id":"apr_0123456789abcdef0123","mailbox":"support@example.com",` +
	`"approval_url":"https://mail.example.com/mail/support%40example.com/approvals?id=apr_0123456789abcdef0123",` +
	`"kind":"rest_send","status":"%s","recipients":["c@example.org"],"subject":"Hi","messages":[],` +
	`"tracking_added_at_send":true,"editable":true,"revision":1,"requested_by":{"via":"api"},` +
	`"result":null,"error":null,"decided_by":null,"created_at":"2026-11-15T10:00:00.000Z",` +
	`"decided_at":null,"expires_at":"2099-11-22T10:00:00.000Z","sent_messages":%s}`

func approvalWith(status, sent string) string {
	return strings.Replace(strings.Replace(flowApprovalJSON, "%s", status, 1), "%s", sent, 1)
}

func TestApprovalListChecksEveryMailboxUnlessOneIsNamed(t *testing.T) {
	srv, hits := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		switch r.URL.Path {
		case "/api/v1/approvals":
			_, _ = w.Write([]byte(`{"approvals":[` + approvalWith("pending", "[]") + `],"mailboxes_checked":["devops@example.com","support@example.com"],"truncated":false}`))
		default:
			_, _ = w.Write([]byte(`{"approvals":[]}`))
		}
		return true
	})
	// A default mailbox from the environment does not narrow the list.
	t.Setenv("CLOUDMAIL_MAILBOX", "devops@example.com")
	stdout, stderr, err := captureBoth(t, srv.URL, "approval", "list")
	if err != nil {
		t.Fatalf("err = %v\n%s", err, stderr)
	}
	var rows []map[string]any
	if jerr := json.Unmarshal([]byte(stdout), &rows); jerr != nil || len(rows) != 1 {
		t.Fatalf("stdout = %s (%v)", stdout, jerr)
	}
	if rows[0]["mailbox"] != "support@example.com" || !strings.Contains(rows[0]["approval_url"].(string), "approvals?id=apr_") {
		t.Errorf("row lacks mailbox or approval_url: %v", rows[0])
	}
	if got := hits(); got[0].path != "/api/v1/approvals" {
		t.Errorf("hit %s, want /api/v1/approvals", got[0].path)
	}

	// --mailbox on the command line asks only that mailbox, and an empty result says so.
	_, stderr, err = captureBoth(t, srv.URL, "approval", "list", "--mailbox", "devops@example.com", "-o", "table")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	last := hits()[len(hits())-1]
	if last.path != "/api/v1/mailboxes/devops@example.com/approvals" {
		t.Errorf("hit %s", last.path)
	}
	_ = stderr
}

func TestApprovalListFallsBackOnOlderDeployments(t *testing.T) {
	srv, hits := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		if r.URL.Path == "/api/v1/approvals" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"Not found"}`))
			return true
		}
		_, _ = w.Write([]byte(`{"approvals":[]}`))
		return true
	})
	t.Setenv("CLOUDMAIL_MAILBOX", "devops@example.com")
	if _, stderr, err := captureBoth(t, srv.URL, "approval", "list"); err != nil {
		t.Fatalf("err = %v\n%s", err, stderr)
	}
	got := hits()
	if got[len(got)-1].path != "/api/v1/mailboxes/devops@example.com/approvals" {
		t.Errorf("no fallback to the default mailbox: %v", got)
	}
}

func TestApprovalWaitExitCodes(t *testing.T) {
	cases := map[string]struct {
		status string
		exit   int
	}{
		"sent":             {"sent", fail.OK},
		"rejected":         {"rejected", fail.Denied},
		"failed":           {"failed", fail.Conflict},
		"sent_unconfirmed": {"sent_unconfirmed", fail.Conflict},
		"still pending":    {"pending", fail.Network},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			srv, _ := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
				sent := "[]"
				if tc.status == "sent" {
					sent = `[{"email_id":"e1","provider_message_id":"p1","scheduled":false,"delivery_status":"sent"}]`
				}
				_, _ = w.Write([]byte(`{"approval":` + approvalWith(tc.status, sent) + `}`))
				return true
			})
			stdout, _, err := captureBoth(t, srv.URL, "approval", "wait", "apr_0123456789abcdef0123", "--timeout", "1s", "--interval", "1s")
			code := fail.OK
			if fe := fail.AsError(err); fe != nil {
				code = fe.ExitCode()
			}
			if code != tc.exit {
				t.Fatalf("exit %d, want %d (err %v)", code, tc.exit, err)
			}
			if !strings.Contains(stdout, `"status": "`+tc.status+`"`) && !strings.Contains(stdout, `"status":"`+tc.status+`"`) {
				t.Errorf("stdout lacks the final approval: %s", stdout)
			}
		})
	}
}

func TestApprovalPolicyAndWhoamiShowSendOutcome(t *testing.T) {
	policies := `{"credential_may_auto_send":true,"policies":[` +
		`{"mailbox":"support@example.com","mode":"approve","skip_approval":[],"allowed_recipients":null,"your_sends":"held"},` +
		`{"mailbox":"bot@example.com","mode":"auto","skip_approval":["@partner.example"],"allowed_recipients":null,"your_sends":"sent"}]}`
	srv, _ := fakeDeployment(t, func(r *http.Request, w http.ResponseWriter) bool {
		switch r.URL.Path {
		case "/api/v1/send-policies":
			_, _ = w.Write([]byte(policies))
		case "/api/v1/me":
			_, _ = w.Write([]byte(`{"role":"member","mailboxes":["support@example.com"],"capabilities":null,"enforced":true}`))
		}
		return true
	})
	stdout, _, err := captureBoth(t, srv.URL, "approval", "policy")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout, `"your_sends": "held"`) {
		t.Errorf("policy output: %s", stdout)
	}
	stdout, _, err = captureBoth(t, srv.URL, "auth", "whoami")
	if err != nil {
		t.Fatal(err)
	}
	var id map[string]any
	if jerr := json.Unmarshal([]byte(stdout), &id); jerr != nil {
		t.Fatalf("whoami stdout: %s", stdout)
	}
	list, _ := id["send_policies"].([]any)
	if len(list) != 2 {
		t.Errorf("whoami lacks send_policies: %s", stdout)
	}
}

func TestStaleCLIWarning(t *testing.T) {
	if !olderThan("v0.2.0", "0.3.0") || olderThan("v0.3.0", "0.3.0") || olderThan("v0.4.1", "0.3.0") {
		t.Error("olderThan compares wrongly")
	}
	if olderThan("dev", "0.3.0") || olderThan("881ff10", "0.3.0") || olderThan("v0.2.0", "") {
		t.Error("an unreadable version must never warn")
	}
	if !olderThan("v0.2.0-3-gabc-dirty", "0.3.0") {
		t.Error("a git describe suffix should be ignored")
	}
}

func TestSendHelpMentionsHeldSendsAndYes(t *testing.T) {
	root, _ := NewRootCommand()
	for _, path := range [][]string{{"mail", "send"}, {"mail", "reply"}, {"mail", "forward"}} {
		c, _, err := root.Find(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{"pending_approval", "approval_url", "approval wait", "--yes"} {
			if !strings.Contains(c.Long, want) {
				t.Errorf("%s help lacks %q", strings.Join(path, " "), want)
			}
		}
	}
	if !strings.Contains(agentGuide, "mail:send:auto does NOT skip approval") || !strings.Contains(agentGuide, "needs --yes") {
		t.Error("guide does not explain approve-mode holds or --yes")
	}
}
