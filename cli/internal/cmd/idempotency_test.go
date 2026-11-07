package cmd

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// keyServer records the Idempotency-Key of every POST. `respond` decides the
// answer per request number.
func keyServer(t *testing.T, respond func(n int, w http.ResponseWriter)) (*httptest.Server, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var keys []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodPost {
			_, _ = w.Write([]byte(`{}`))
			return
		}
		mu.Lock()
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		n := len(keys)
		mu.Unlock()
		respond(n, w)
	}))
	t.Cleanup(srv.Close)
	return srv, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), keys...)
	}
}

func runAgainst(t *testing.T, srv *httptest.Server, retries string, args ...string) int {
	t.Helper()
	t.Setenv("CLOUDMAIL_CONFIG_DIR", t.TempDir())
	t.Setenv("CLOUDMAIL_BASE_URL", srv.URL)
	t.Setenv("CLOUDMAIL_TOKEN", "ttk_test_secret")
	t.Setenv("CLOUDMAIL_RETRIES", retries)
	root, _ := NewRootCommand()
	root.SetArgs(append([]string{"--quiet", "--output", "json", "--yes"}, args...))
	_, err := root.ExecuteC()
	if err == nil {
		return fail.OK
	}
	return classifyTopLevel(err).ExitCode()
}

var sendArgs = []string{"mail", "send", "--mailbox", "support@example.com",
	"--to", "c@example.org", "--subject", "Hi", "--text", "Hello"}

func TestSendCarriesTheGivenIdempotencyKey(t *testing.T) {
	srv, keys := keyServer(t, func(_ int, w http.ResponseWriter) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"id":"m1","status":"sent"}`))
	})
	code := runAgainst(t, srv, "0", append(sendArgs, "--idempotency-key", "order-42")...)
	if code != fail.OK {
		t.Fatalf("exit = %d", code)
	}
	if got := keys(); len(got) != 1 || got[0] != "order-42" {
		t.Fatalf("keys = %v, want [order-42]", got)
	}
}

func TestSendGeneratesAKeyPerInvocation(t *testing.T) {
	srv, keys := keyServer(t, func(_ int, w http.ResponseWriter) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"id":"m1"}`))
	})
	runAgainst(t, srv, "0", sendArgs...)
	runAgainst(t, srv, "0", sendArgs...)
	got := keys()
	if len(got) != 2 || !strings.HasPrefix(got[0], "cloudmail-") || got[0] == got[1] {
		t.Fatalf("keys = %v, want two distinct generated keys", got)
	}
}

// A keyed send that hit a 5xx is retried with the same key, which is what makes
// the retry safe: the server replays rather than sending twice.
func TestKeyedSendIsRetriedWithTheSameKey(t *testing.T) {
	srv, keys := keyServer(t, func(n int, w http.ResponseWriter) {
		if n == 1 {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":"upstream"}`))
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"id":"m1"}`))
	})
	code := runAgainst(t, srv, "2", append(sendArgs, "--idempotency-key", "k-1")...)
	if code != fail.OK {
		t.Fatalf("exit = %d", code)
	}
	if got := keys(); len(got) != 2 || got[0] != "k-1" || got[1] != "k-1" {
		t.Fatalf("keys = %v, want [k-1 k-1]", got)
	}
}

func TestInProgressConflictIsRetried(t *testing.T) {
	srv, keys := keyServer(t, func(n int, w http.ResponseWriter) {
		if n == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"in flight","code":"idempotency_request_in_progress"}`))
			return
		}
		w.Header().Set("Idempotent-Replayed", "true")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"id":"m1"}`))
	})
	if code := runAgainst(t, srv, "2", append(sendArgs, "--idempotency-key", "k-2")...); code != fail.OK {
		t.Fatalf("exit = %d", code)
	}
	if got := keys(); len(got) != 2 {
		t.Fatalf("keys = %v, want two attempts", got)
	}
}

func TestReusedKeyIsAConflictAndNotRetried(t *testing.T) {
	srv, keys := keyServer(t, func(_ int, w http.ResponseWriter) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"reused","code":"idempotency_key_reused"}`))
	})
	if code := runAgainst(t, srv, "2", append(sendArgs, "--idempotency-key", "k-3")...); code != fail.Conflict {
		t.Fatalf("exit = %d, want %d", code, fail.Conflict)
	}
	if got := keys(); len(got) != 1 {
		t.Fatalf("keys = %v, want one attempt", got)
	}
}

// Several requests in one run get <key>, <key>-2, ... so a rerun maps each to
// the key it had the first time.
func TestMultiRequestCommandDerivesKeysInOrder(t *testing.T) {
	srv, keys := keyServer(t, func(_ int, w http.ResponseWriter) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"added":1,"existing":0,"items":[]}`))
	})
	code := runAgainst(t, srv, "0", "suppression", "add", "a@example.org", "b@example.org",
		"--idempotency-key", "batch")
	if code != fail.OK {
		t.Fatalf("exit = %d", code)
	}
	if got := keys(); len(got) != 2 || got[0] != "batch" || got[1] != "batch-2" {
		t.Fatalf("keys = %v, want [batch batch-2]", got)
	}
}

func TestInvalidKeyIsRefusedLocally(t *testing.T) {
	srv, keys := keyServer(t, func(_ int, w http.ResponseWriter) { _, _ = w.Write([]byte(`{}`)) })
	if code := runAgainst(t, srv, "0", append(sendArgs, "--idempotency-key", "café")...); code != fail.Usage {
		t.Fatalf("exit = %d, want usage", code)
	}
	if got := keys(); len(got) != 0 {
		t.Fatalf("sent %v", got)
	}
}

// Non-keyed POSTs (a rule, a label) carry no key.
func TestUnkeyedCommandSendsNoKey(t *testing.T) {
	srv, keys := keyServer(t, func(_ int, w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"id":"l1","name":"x"}`))
	})
	runAgainst(t, srv, "0", "label", "create", "x", "--mailbox", "support@example.com")
	for _, k := range keys() {
		if k != "" {
			t.Fatalf("unexpected key %q on an unkeyed command", k)
		}
	}
}

func TestKeyedCommandsHaveTheFlag(t *testing.T) {
	root, _ := NewRootCommand()
	for _, p := range keyedCommands {
		c, _, err := root.Find(strings.Fields(p))
		if err != nil || c == root || c.CommandPath() != "cloudmail "+p {
			t.Errorf("%q does not resolve to a command", p)
			continue
		}
		if c.Flags().Lookup(idempotencyFlag) == nil {
			t.Errorf("%q has no --%s", p, idempotencyFlag)
		}
	}
}
