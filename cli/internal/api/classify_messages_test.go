package api

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// The statuses a caller most often has to act on each name the next step.
func TestErrorMessagesForAuthConflictAndRateLimit(t *testing.T) {
	for _, tc := range []struct {
		name, method string
		status       int
		body         string
		wantExit     int
		wantCode     string
		wantRemedy   string
	}{
		{"401", "GET", 401, `{"error":"Unauthenticated","code":"unauthenticated"}`, fail.Unauthenticated, "UNAUTHENTICATED", "API tokens"},
		{"402", "GET", 402, `{"error":"Licence required","code":"licence_required"}`, fail.Denied, "LICENCE_REQUIRED", "cloudmail licence status"},
		{"403 scope", "GET", 403, `{"error":"no","code":"insufficient_scope","scope":"admin"}`, fail.Denied, "INSUFFICIENT_SCOPE", `"admin" scope`},
		{"403 session", "GET", 403, `{"error":"no","code":"session_required"}`, fail.Denied, "SESSION_REQUIRED", "browser session"},
		{"403 reauth", "GET", 403, `{"error":"no","code":"reauth_required"}`, fail.Denied, "REAUTH_REQUIRED", "15 minutes"},
		{"409 state", "GET", 409, `{"error":"Already sent; nothing was sent again."}`, fail.Conflict, "CONFLICT", "Read it again"},
		{"409 create", "POST", 409, `{"error":"A label with that name already exists"}`, fail.Conflict, "CONFLICT", "update it instead"},
		{"429", "GET", 429, `{"error":"slow down"}`, fail.RateLimited, "RATE_LIMITED", "wait 60s"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			c.cfg.Token = "ttk_a_b"
			var err error
			if tc.method == "POST" {
				_, err = c.CreateLabel(context.Background(), "a@b.com", LabelInput{Name: "x"})
			} else {
				_, err = c.GetEmail(context.Background(), "a@b.com", "id1")
			}
			e := fail.AsError(err)
			if e == nil || e.ExitCode() != tc.wantExit || e.Code != tc.wantCode {
				t.Fatalf("got %+v, want exit %d code %s", e, tc.wantExit, tc.wantCode)
			}
			if !strings.Contains(e.Remediation, tc.wantRemedy) {
				t.Errorf("remediation %q does not mention %q", e.Remediation, tc.wantRemedy)
			}
		})
	}
}
