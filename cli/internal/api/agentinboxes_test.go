package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/gorilla/websocket"
)

func TestAgentInboxClientRoutes(t *testing.T) {
	type call struct {
		method, path string
		body         map[string]any
		idemKey      string
	}
	var calls []call
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		calls = append(calls, call{r.Method, r.URL.Path, body, r.Header.Get("Idempotency-Key")})
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "POST":
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"address":"agent-abc123@example.com","token":{"id":"t1","secret":"ttk_t1_s","scopes":["mail:read"],"mailboxes":["agent-abc123@example.com"],"expires_at":null},"policy":{"send_mode":"draft_only","allowed_recipients":null,"ttl_hours":24,"expires_at":5},"webhook":null,"routing":{"routed":false,"source":"unknown","warning":"add a rule"},"warnings":["add a rule"],"agent_inbox":{"address":"agent-abc123@example.com"}}`))
		case r.Method == "DELETE":
			_, _ = w.Write([]byte(`{"ended":{"address":"agent-abc123@example.com","token_revoked":true,"webhook_disabled":false,"archive":{"key":"archives/agent-inboxes/x.mbox","messages":3,"truncated":false},"mailbox_deleted":true}}`))
		case r.URL.Path == "/api/v1/agent-inboxes":
			_, _ = w.Write([]byte(`{"agent_inboxes":[{"address":"agent-abc123@example.com","send_mode":"auto","expires_in_ms":3600000,"scopes":[]}]}`))
		default:
			_, _ = w.Write([]byte(`{"agent_inbox":{"address":"agent-abc123@example.com","send_mode":"auto"}}`))
		}
	}))
	ctx := context.Background()
	ttl := 24.0
	created, err := c.CreateAgentInbox(ctx, AgentInboxInput{Domain: "example.com", Purpose: "triage", SendMode: "draft_only", TTLHours: &ttl, AllowedRecipients: []string{"@partner.com"}})
	if err != nil || created.Token.Secret == nil || *created.Token.Secret != "ttk_t1_s" || created.Routing.Warning == nil {
		t.Fatalf("CreateAgentInbox = %+v, %v", created, err)
	}
	list, err := c.ListAgentInboxes(ctx)
	if err != nil || len(list) != 1 || list[0].SendMode != "auto" || *list[0].ExpiresInMs != 3600000 {
		t.Fatalf("ListAgentInboxes = %+v, %v", list, err)
	}
	if _, err := c.GetAgentInbox(ctx, "agent-abc123@example.com"); err != nil {
		t.Fatalf("GetAgentInbox: %v", err)
	}
	ended, err := c.DeleteAgentInbox(ctx, "agent-abc123@example.com")
	if err != nil || !ended.TokenRevoked || ended.Archive == nil || ended.Archive.Messages != 3 {
		t.Fatalf("DeleteAgentInbox = %+v, %v", ended, err)
	}

	if calls[0].path != "/api/v1/agent-inboxes" || calls[0].body["send_mode"] != "draft_only" || calls[0].body["ttl_hours"] != 24.0 {
		t.Errorf("create call = %+v", calls[0])
	}
	if _, ok := calls[0].body["local_part"]; ok {
		t.Errorf("an empty local part must be omitted so the server generates one: %+v", calls[0].body)
	}
	if calls[2].path != "/api/v1/agent-inboxes/agent-abc123@example.com" {
		t.Errorf("get path = %s", calls[2].path)
	}
	if calls[3].method != "DELETE" {
		t.Errorf("delete call = %+v", calls[3])
	}
}

func TestAgentInboxInputValidation(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("no request should be sent")
	}))
	ctx := context.Background()
	bad := []AgentInboxInput{
		{Purpose: "x", SendMode: "auto"},
		{Domain: "example.com", SendMode: "auto"},
		{Domain: "example.com", Purpose: "x", SendMode: "yolo"},
		{Domain: "example.com", Purpose: "x", SendMode: "auto", WebhookURL: "http://insecure"},
	}
	for _, in := range bad {
		if _, err := c.CreateAgentInbox(ctx, in); err == nil {
			t.Errorf("expected an error for %+v", in)
		}
	}
	zero := 0.0
	if _, err := c.CreateAgentInbox(ctx, AgentInboxInput{Domain: "example.com", Purpose: "x", SendMode: "auto", TTLHours: &zero}); err == nil {
		t.Error("expected an error for a zero TTL")
	}
}

func TestStreamURL(t *testing.T) {
	c, srv := newTestClient(t, http.NotFoundHandler())
	got, err := c.StreamURL(nil)
	if err != nil || got != "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/events/stream" {
		t.Fatalf("StreamURL = %q, %v", got, err)
	}
	since := int64(42)
	got, _ = c.StreamURL(&since)
	if !strings.HasSuffix(got, "/api/v1/events/stream?since=42") {
		t.Fatalf("StreamURL with since = %q", got)
	}
}

func TestStreamSubscribesAndDeliversEvents(t *testing.T) {
	upgrader := websocket.Upgrader{}
	var gotHeader http.Header
	var gotSub map[string]any
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/events/stream" || r.URL.Query().Get("since") != "7" {
			t.Errorf("unexpected request %s", r.URL)
		}
		gotHeader = r.Header.Clone()
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"hello","latest_id":9}`))
		if err := conn.ReadJSON(&gotSub); err != nil {
			t.Errorf("read subscribe: %v", err)
			return
		}
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"subscribed","mailboxes":["a@x.com"],"events":"all","denied":["b@x.com"]}`))
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"event","id":8,"event":{"type":"message.received","mailbox":"a@x.com"}}`))
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"event","id":9,"event":{"type":"message.sent","mailbox":"a@x.com"}}`))
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "done"), time.Now().Add(time.Second))
	}))

	since := int64(7)
	var events []StreamMessage
	var denied []string
	last, err := c.Stream(context.Background(), StreamOptions{Mailboxes: []string{"a@x.com", "b@x.com"}, Since: &since}, func(m StreamMessage) error {
		if m.Type == "event" {
			events = append(events, m)
		}
		if m.Type == "subscribed" {
			denied = m.Denied
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if last != 9 || len(events) != 2 || events[0].ID != 8 {
		t.Fatalf("last=%d events=%+v", last, events)
	}
	if len(denied) != 1 || denied[0] != "b@x.com" {
		t.Errorf("denied = %v", denied)
	}
	if gotSub["type"] != "subscribe" || len(gotSub["mailboxes"].([]any)) != 2 {
		t.Errorf("subscribe frame = %+v", gotSub)
	}
	if _, has := gotSub["events"]; has {
		t.Errorf("no --event means no events filter: %+v", gotSub)
	}
	if gotHeader.Get("CF-Access-Client-Id") != "cid" || gotHeader.Get("Origin") != "" {
		t.Errorf("handshake headers = %v", gotHeader)
	}
}

func TestStreamReportsRefusals(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"This API token does not have the \"mail:read\" scope.","scope":"mail:read"}`))
	}))
	_, err := c.Stream(context.Background(), StreamOptions{}, func(StreamMessage) error { return nil })
	var fe *fail.Error
	if !errors.As(err, &fe) || fe.ExitCode() != fail.Denied || !strings.Contains(fe.Message, "mail:read") {
		t.Fatalf("err = %v", err)
	}
}

func TestStreamRevokedCredentialIsNotRetryable(t *testing.T) {
	upgrader := websocket.Upgrader{}
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var sub map[string]any
		_ = conn.ReadJSON(&sub)
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"subscription_revoked","mailbox":"b@x.com"}`))
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"event","id":3,"event":{}}`))
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4401, "credential_revoked"), time.Now().Add(time.Second))
	}))
	var revoked string
	last, err := c.Stream(context.Background(), StreamOptions{}, func(m StreamMessage) error {
		if m.Type == "subscription_revoked" {
			revoked = DescribeStreamMessage(m)
		}
		return nil
	})
	if last != 3 || !strings.Contains(revoked, "b@x.com") {
		t.Fatalf("last=%d revoked=%q", last, revoked)
	}
	if fe := fail.AsError(err); fe == nil || fe.ExitCode() != fail.Unauthenticated {
		t.Fatalf("err = %v, want an unauthenticated error so tail stops instead of retrying", err)
	}
}

func TestStreamSlowConsumerCloseSaysWhereToResume(t *testing.T) {
	upgrader := websocket.Upgrader{}
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var sub map[string]any
		_ = conn.ReadJSON(&sub)
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"event","id":5,"event":{}}`))
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1013, "slow consumer"), time.Now().Add(time.Second))
	}))
	last, err := c.Stream(context.Background(), StreamOptions{}, func(StreamMessage) error { return nil })
	if last != 5 || err == nil || !strings.Contains(fail.AsError(err).Remediation, "--since 5") {
		t.Fatalf("last=%d err=%v", last, err)
	}
}
