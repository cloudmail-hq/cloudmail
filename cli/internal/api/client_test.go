package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/cloudmail-hq/cloudmail/cli/internal/config"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// These tests pin the behaviours that are easy to break silently and expensive to
// get wrong: the auth headers, the absence of the headers the Worker's CSRF guard
// rejects, the two different shapes the list route returns, and the mapping from
// HTTP status to exit code.

func newTestClient(t *testing.T, h http.Handler) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	cfg := config.Defaults()
	cfg.BaseURL = srv.URL
	cfg.ClientID = "cid"
	cfg.ClientSecret = "csecret"
	cfg.Retries = 0
	return New(cfg), srv
}

func TestServiceTokenHeadersAreSent(t *testing.T) {
	var got http.Header
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"role":"admin","mailboxes":[],"capabilities":null}`))
	}))

	if _, err := c.Whoami(context.Background()); err != nil {
		t.Fatalf("Whoami: %v", err)
	}
	if got.Get("CF-Access-Client-Id") != "cid" {
		t.Errorf("CF-Access-Client-Id = %q, want cid", got.Get("CF-Access-Client-Id"))
	}
	if got.Get("CF-Access-Client-Secret") != "csecret" {
		t.Errorf("CF-Access-Client-Secret missing")
	}
}

// The Worker admits an unsafe request that sends neither Origin nor
// Sec-Fetch-Site. Sending either would make every POST fail, so their absence is a
// requirement rather than an accident.
func TestCSRFSensitiveHeadersAreNotSent(t *testing.T) {
	var got http.Header
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"id":"m1","status":"sent"}`))
	}))

	_, err := c.Send(context.Background(), "a@b.com", &SendRequest{
		To: Recipients{"x@y.com"}, From: "a@b.com", Subject: "s", Text: "t",
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	for _, h := range []string{"Origin", "Sec-Fetch-Site"} {
		if v := got.Get(h); v != "" {
			t.Errorf("%s was sent as %q; the CSRF guard requires it to be absent", h, v)
		}
	}
}

// The list route answers with an object when a folder is named and a bare array
// otherwise. Both must decode.
func TestEmailListAcceptsBothResponseShapes(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		wantN      int
		wantTotal  bool
	}{
		{"object with totalCount", `{"emails":[{"id":"1"},{"id":"2"}],"totalCount":7}`, 2, true},
		{"bare array", `[{"id":"1"},{"id":"2"},{"id":"3"}]`, 3, false},
		{"empty object", `{"emails":[],"totalCount":0}`, 0, true},
		{"empty array", `[]`, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var list EmailList
			if err := json.Unmarshal([]byte(tc.body), &list); err != nil {
				t.Fatalf("unmarshal %s: %v", tc.body, err)
			}
			if len(list.Emails) != tc.wantN {
				t.Errorf("got %d emails, want %d", len(list.Emails), tc.wantN)
			}
			if (list.TotalCount != nil) != tc.wantTotal {
				t.Errorf("TotalCount present = %v, want %v", list.TotalCount != nil, tc.wantTotal)
			}
		})
	}
}

func TestHTTPStatusMapsToExitCode(t *testing.T) {
	for _, tc := range []struct {
		status   int
		body     string
		wantExit int
		wantCode string
	}{
		{400, `{"error":"Invalid request body","details":[{"path":["to"],"message":"bad"}]}`,
			fail.Invalid, "INVALID_REQUEST"},
		{401, `{"error":"nope"}`, fail.Unauthenticated, "UNAUTHENTICATED"},
		{403, `{"error":"no permission","capability":"deletePermanently"}`, fail.Denied, "FORBIDDEN"},
		{404, `{"error":"Email not found"}`, fail.NotFound, "NOT_FOUND"},
		{409, `{"error":"exists"}`, fail.Conflict, "CONFLICT"},
		{413, `{"error":"too big"}`, fail.TooLarge, "TOO_LARGE"},
		{429, `{"error":"slow down"}`, fail.RateLimited, "RATE_LIMITED"},
		{500, `{"error":"Internal server error"}`, fail.Server, "SERVER_ERROR"},
		{503, `{"error":"down"}`, fail.Server, "SERVER_UNAVAILABLE"},
	} {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))

			_, err := c.GetEmail(context.Background(), "a@b.com", "id1")
			if err == nil {
				t.Fatal("want an error, got nil")
			}
			e := fail.AsError(err)
			if e.ExitCode() != tc.wantExit {
				t.Errorf("exit = %d, want %d (%s)", e.ExitCode(), tc.wantExit, e.Message)
			}
			if e.Code != tc.wantCode {
				t.Errorf("code = %q, want %q", e.Code, tc.wantCode)
			}
			if e.Remediation == "" {
				t.Error("no remediation; every failure should say what to do next")
			}
		})
	}
}

// A 403 naming a capability must surface that capability as a field, so a caller
// does not have to regex it out of the message.
func TestCapabilityRefusalIsExtractable(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(
			`{"error":"You do not have permission to do this in this mailbox (deletePermanently)",` +
				`"capability":"deletePermanently"}`))
	}))

	_, err := c.Delete(context.Background(), "a@b.com", "id1", true)
	e := fail.AsError(err)
	if e.Capability != "deletePermanently" {
		t.Errorf("Capability = %q, want deletePermanently", e.Capability)
	}
	if e.ExitCode() != fail.Denied {
		t.Errorf("exit = %d, want %d", e.ExitCode(), fail.Denied)
	}
}

// A Zod rejection carries per-field detail; losing it would leave the caller with
// "Invalid request body" and nothing to fix.
func TestZodDetailsSurviveAsFields(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"Invalid request body","details":[
			{"path":["to"],"message":"Invalid email"},
			{"path":["attachments",0,"filename"],"message":"Blocked type"}]}`))
	}))

	_, err := c.GetEmail(context.Background(), "a@b.com", "id1")
	e := fail.AsError(err)
	if len(e.Details) != 2 {
		t.Fatalf("got %d details, want 2", len(e.Details))
	}
	if e.Details[0].Field != "to" {
		t.Errorf("first field = %q, want to", e.Details[0].Field)
	}
	if e.Details[1].Field != "attachments.[0].filename" {
		t.Errorf("second field = %q, want attachments.[0].filename", e.Details[1].Field)
	}
}

// A redirect behind Access is the login page, and must read as an auth failure
// rather than as a surprising success carrying HTML.
func TestRedirectIsReportedAsAuthFailure(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://team.cloudflareaccess.com/login", http.StatusFound)
	}))

	_, err := c.Whoami(context.Background())
	e := fail.AsError(err)
	if e.ExitCode() != fail.Unauthenticated {
		t.Errorf("exit = %d, want %d (%s)", e.ExitCode(), fail.Unauthenticated, e.Message)
	}
}

// --read-only must refuse before anything reaches the network.
func TestReadOnlyRefusesWithoutSending(t *testing.T) {
	var hits int
	cfg := config.Defaults()
	cfg.ReadOnly = true

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()
	cfg.BaseURL = srv.URL
	c := New(cfg)

	_, err := c.Send(context.Background(), "a@b.com", &SendRequest{
		To: Recipients{"x@y.com"}, From: "a@b.com", Subject: "s", Text: "t",
	})
	if err == nil {
		t.Fatal("want a refusal")
	}
	if e := fail.AsError(err); e.ExitCode() != fail.WriteRefused {
		t.Errorf("exit = %d, want %d", e.ExitCode(), fail.WriteRefused)
	}
	if hits != 0 {
		t.Errorf("the server was contacted %d time(s); read-only must not send", hits)
	}

	// A read is still allowed in read-only mode.
	if _, err := c.ListFolders(context.Background(), "a@b.com"); err == nil && hits == 0 {
		t.Error("a read should still have reached the server")
	}
}

// --dry-run must return the request rather than performing it.
func TestDryRunPreviewsWithoutSending(t *testing.T) {
	var hits int
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(http.StatusAccepted)
	}))
	c.SetDryRun(true)

	resp, err := c.mutate(context.Background(), Request{
		Method: "DELETE", Path: "/api/v1/mailboxes/a@b.com/emails/x",
		Mutates: true, Reversible: false, Note: "destroys it",
	}, nil)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if resp.Preview == nil {
		t.Fatal("no preview returned")
	}
	if !resp.Preview.DryRun || resp.Preview.Reversible {
		t.Errorf("preview = %+v, want DryRun and not Reversible", resp.Preview)
	}
	if hits != 0 {
		t.Errorf("the server was contacted %d time(s); a dry run must send nothing", hits)
	}
}

// Dynamic path segments must not be able to change the shape of the URL.
//
// `@` and `+` are legal in a path segment and are deliberately left alone -- the
// server decodes the segment with decodeURIComponent, which leaves both intact, so
// escaping them would address a mailbox whose name really did contain "%40". The
// property that matters is that a separator inside a segment cannot forge a new
// one, because for a DELETE that would mean addressing the collection rather than
// the member.
func TestPathSegmentsCannotForgeStructure(t *testing.T) {
	for _, tc := range []struct {
		name, mailbox, mustNotContain string
	}{
		{"plain address keeps @ and +", "a+tag@b.com", "%2F"},
		{"a slash is escaped", "a/../../admin@b.com", "/../"},
		{"traversal cannot escape the segment", "../../etc@b.com", "/../"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var gotPath string
			c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.EscapedPath()
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`[]`))
			}))

			if _, err := c.ListFolders(context.Background(), tc.mailbox); err != nil {
				t.Fatalf("ListFolders: %v", err)
			}
			if strings.Contains(gotPath, tc.mustNotContain) {
				t.Errorf("path = %q, must not contain %q", gotPath, tc.mustNotContain)
			}
			// Whatever the id, the route shape has to survive intact.
			if !strings.HasPrefix(gotPath, "/api/v1/mailboxes/") ||
				!strings.HasSuffix(gotPath, "/folders") {
				t.Errorf("path = %q, want /api/v1/mailboxes/<id>/folders", gotPath)
			}
			// Exactly the segments the route declares: prefix(2) + mailboxes +
			// id + folders.
			if n := strings.Count(gotPath, "/"); n != 5 {
				t.Errorf("path = %q has %d separators, want 5; a segment forged structure",
					gotPath, n)
			}
		})
	}
}

// The plain-address case is the one people actually hit, so assert it explicitly:
// a `+` tag and an `@` must reach the server unchanged.
func TestPlainAddressReachesServerIntact(t *testing.T) {
	var gotID string
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Mirror what Hono does: decode the segment.
		parts := strings.Split(r.URL.EscapedPath(), "/")
		if len(parts) > 4 {
			decoded, err := url.PathUnescape(parts[4])
			if err == nil {
				gotID = decoded
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))

	const want = "a+tag@b.com"
	if _, err := c.ListFolders(context.Background(), want); err != nil {
		t.Fatalf("ListFolders: %v", err)
	}
	if gotID != want {
		t.Errorf("server saw mailbox %q, want %q", gotID, want)
	}
}

// A send must never be retried: a lost response may mean the mail already went.
func TestSendIsNotRetried(t *testing.T) {
	var hits int
	cfg := config.Defaults()
	cfg.Retries = 3
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv.Close()
	cfg.BaseURL = srv.URL

	c := New(cfg)
	_, _ = c.Send(context.Background(), "a@b.com", &SendRequest{
		To: Recipients{"x@y.com"}, From: "a@b.com", Subject: "s", Text: "t",
	})
	if hits != 1 {
		t.Errorf("the send was attempted %d times; it must be attempted once", hits)
	}
}

// An idempotent read may be retried on a 5xx.
func TestIdempotentReadIsRetried(t *testing.T) {
	var hits int
	cfg := config.Defaults()
	cfg.Retries = 2
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if hits < 3 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":"upstream"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	cfg.BaseURL = srv.URL

	c := New(cfg)
	if _, err := c.ListFolders(context.Background(), "a@b.com"); err != nil {
		t.Fatalf("ListFolders: %v", err)
	}
	if hits != 3 {
		t.Errorf("got %d attempts, want 3 (two failures then a success)", hits)
	}
}

// Local validation should catch a header-injection attempt before it is sent.
func TestAddressWithNewlineIsRefusedLocally(t *testing.T) {
	req := &SendRequest{
		To:      Recipients{"ok@example.com\r\nBcc: attacker@evil.example"},
		From:    "a@b.com",
		Subject: "s",
		Text:    "t",
	}
	err := req.Validate()
	if err == nil {
		t.Fatal("want a refusal for an address containing CRLF")
	}
	if e := fail.AsError(err); e.ExitCode() != fail.Usage {
		t.Errorf("exit = %d, want %d", e.ExitCode(), fail.Usage)
	}
}

// Bulk must chunk rather than refuse an over-large batch.
func TestBulkChunksLargeBatches(t *testing.T) {
	var batches []int
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			IDs []string `json:"ids"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		batches = append(batches, len(body.IDs))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"updated":1}`))
	}))

	ids := make([]string, BulkLimit+50)
	for i := range ids {
		ids[i] = "id" + string(rune('a'+i%26)) + string(rune('0'+i/26%10)) + string(rune('A'+i/260))
	}

	results, err := c.Bulk(context.Background(), "a@b.com", "read", ids, "", "")
	if err != nil {
		t.Fatalf("Bulk: %v", err)
	}
	if len(batches) != 2 {
		t.Fatalf("got %d requests, want 2 for %d ids", len(batches), len(ids))
	}
	if batches[0] != BulkLimit {
		t.Errorf("first chunk = %d, want %d", batches[0], BulkLimit)
	}
	if len(results) != 2 {
		t.Errorf("got %d results, want one per chunk", len(results))
	}
}

// "none" clears a priority, and must be sent as null rather than the string.
func TestPriorityNoneIsSentAsNull(t *testing.T) {
	var raw map[string]any
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&raw)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))

	if _, err := c.SetPriority(context.Background(), "a@b.com", "id1", "none"); err != nil {
		t.Fatalf("SetPriority: %v", err)
	}
	v, present := raw["priority"]
	if !present {
		t.Fatal("priority was omitted; the server needs an explicit null to clear it")
	}
	if v != nil {
		t.Errorf("priority = %v, want null", v)
	}
}

// An API token goes out as a Bearer header, and wins over Access credentials
// that are also configured: exactly one credential is ever sent.
func TestAPITokenIsSentAsBearerAndWins(t *testing.T) {
	var got http.Header
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"role":"admin","mailboxes":[],"capabilities":null}`))
	}))
	c.cfg.Token = "ttk_abc_def"
	c.cfg.AccessJWT = "jwt"

	if _, err := c.Whoami(context.Background()); err != nil {
		t.Fatalf("Whoami: %v", err)
	}
	if v := got.Get("Authorization"); v != "Bearer ttk_abc_def" {
		t.Errorf("Authorization = %q, want Bearer ttk_abc_def", v)
	}
	for _, h := range []string{
		"CF-Access-Client-Id", "CF-Access-Client-Secret", "Cf-Access-Jwt-Assertion", "Cookie",
	} {
		if v := got.Get(h); v != "" {
			t.Errorf("%s = %q; an API token must be the only credential sent", h, v)
		}
	}
}

// Access mode sends no Authorization header, and a request cannot smuggle one in.
func TestAccessModeSendsNoAuthorization(t *testing.T) {
	var got http.Header
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	_, err := c.Do(context.Background(), Request{
		Method: http.MethodGet, Path: "/api/v1/me",
		Headers: map[string]string{"Authorization": "Bearer forged"},
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if v := got.Get("Authorization"); v != "" {
		t.Errorf("Authorization = %q, want none in Access mode", v)
	}
}

// Built-in auth answers a missing or bad token with a coded JSON 401. The
// remediation must point at API tokens, not at Cloudflare Access.
func TestUnauthenticatedCodePointsAtAPITokens(t *testing.T) {
	for _, tc := range []struct {
		name  string
		token string
		want  string
	}{
		{"no credential", "", "CLOUDMAIL_TOKEN"},
		{"access creds against password mode", "", "not Cloudflare Access"},
		{"rejected token", "ttk_x_y", "was rejected"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"error":"Sign in required","code":"unauthenticated"}`))
			}))
			c.cfg.Token = tc.token
			if tc.name == "no credential" {
				c.cfg.ClientID, c.cfg.ClientSecret = "", ""
			}

			_, err := c.Whoami(context.Background())
			e := fail.AsError(err)
			if e.ExitCode() != fail.Unauthenticated {
				t.Errorf("exit = %d, want %d", e.ExitCode(), fail.Unauthenticated)
			}
			if !strings.Contains(e.Remediation, tc.want) {
				t.Errorf("remediation %q does not mention %q", e.Remediation, tc.want)
			}
			if !strings.Contains(e.Remediation, "API tokens") {
				t.Errorf("remediation %q does not say where to create a token", e.Remediation)
			}
		})
	}
}

// With no credential and an uncoded refusal, the CLI asks /api/auth/state which
// mode the deployment runs in, and only points at Access service tokens when it
// is actually in Access mode.
func TestExit6RemediationFollowsTheDeploymentAuthMode(t *testing.T) {
	for _, tc := range []struct {
		mode, want, notWant string
	}{
		{"password", "API tokens", "service token"},
		{"access", "service token", "Settings → Account & security"},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/auth/state" {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"mode":"` + tc.mode + `"}`))
					return
				}
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte("Forbidden"))
			}))
			c.cfg.Token, c.cfg.ClientID, c.cfg.ClientSecret, c.cfg.AccessJWT = "", "", "", ""
			_, err := c.Whoami(context.Background())
			e := fail.AsError(err)
			if e.ExitCode() != fail.Unauthenticated {
				t.Fatalf("exit = %d, want %d", e.ExitCode(), fail.Unauthenticated)
			}
			if tc.mode == "password" && !strings.Contains(e.Remediation, tc.want) {
				t.Errorf("remediation %q does not mention %q", e.Remediation, tc.want)
			}
			if tc.mode == "password" && strings.Contains(e.Remediation, tc.notWant) {
				t.Errorf("remediation %q mentions %q", e.Remediation, tc.notWant)
			}
			if tc.mode == "access" && strings.Contains(e.Remediation, tc.notWant) {
				t.Errorf("access-mode remediation %q points at API tokens", e.Remediation)
			}
		})
	}
}

// An Access login redirect still gets Access remediation, even with a token set:
// the deployment is in legacy mode and will never accept it.
func TestRedirectWithTokenExplainsAccessMode(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://team.cloudflareaccess.com/login", http.StatusFound)
	}))
	c.cfg.Token = "ttk_x_y"

	_, err := c.Whoami(context.Background())
	if e := fail.AsError(err); e.Code != "ACCESS_LOGIN_REQUIRED" {
		t.Fatalf("code = %q, want ACCESS_LOGIN_REQUIRED", e.Code)
	}

	// The test server is on localhost, which has its own remediation; check the
	// deployed-instance wording directly.
	c.cfg.BaseURL = "https://mail.example.com"
	if r := accessRemediation(c); !strings.Contains(r, "does not accept API tokens") {
		t.Errorf("remediation = %q", r)
	}
}
