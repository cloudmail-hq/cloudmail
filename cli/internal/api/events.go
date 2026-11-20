package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/gorilla/websocket"
)

// The realtime event stream: GET /api/v1/events/stream (WebSocket). See
// docs/realtime.md in the server repository.

// StreamMessage is one frame from the server. Type is "event" for an event
// (ID and Event set) and hello/subscribed/replayed/overflow/... otherwise.
type StreamMessage struct {
	Type       string          `json:"type"`
	ID         int64           `json:"id,omitempty"`
	Event      json.RawMessage `json:"event,omitempty"`
	ResumeFrom *int64          `json:"resume_from,omitempty"`
	Error      string          `json:"error,omitempty"`
	Code       string          `json:"code,omitempty"`
	Denied     []string        `json:"denied,omitempty"`
	Mailbox    string          `json:"mailbox,omitempty"`
	LatestID   *int64          `json:"latest_id,omitempty"`
	Raw        json.RawMessage `json:"-"`
}

// StreamOptions picks what to subscribe to. Empty slices mean "all".
type StreamOptions struct {
	Mailboxes []string
	Events    []string
	// Since replays retained events after this id; nil for live only.
	Since *int64
}

// StreamURL is the WebSocket URL for the deployment.
func (c *Client) StreamURL(since *int64) (string, error) {
	base, err := url.Parse(c.cfg.BaseURL)
	if err != nil {
		return "", fail.Usagef("the base URL is not valid: %s", c.cfg.BaseURL).Wrap(err)
	}
	switch base.Scheme {
	case "https":
		base.Scheme = "wss"
	case "http":
		base.Scheme = "ws"
	default:
		return "", fail.Usagef("the base URL must be http(s), got %q", base.Scheme)
	}
	base.Path = strings.TrimRight(base.Path, "/") + APIPrefix + "/events/stream"
	if since != nil {
		base.RawQuery = url.Values{"since": {strconv.FormatInt(*since, 10)}}.Encode()
	}
	return base.String(), nil
}

// subscribeFrame is what the client sends after connecting.
func subscribeFrame(opts StreamOptions) map[string]any {
	msg := map[string]any{"type": "subscribe"}
	if len(opts.Mailboxes) > 0 {
		msg["mailboxes"] = opts.Mailboxes
	}
	if len(opts.Events) > 0 {
		msg["events"] = opts.Events
	}
	return msg
}

// Stream connects, subscribes and calls onMessage for each frame until ctx is
// cancelled or the server closes. Returns the highest event id seen, so a
// caller can reconnect with Since.
func (c *Client) Stream(ctx context.Context, opts StreamOptions, onMessage func(StreamMessage) error) (int64, error) {
	last := int64(0)
	if opts.Since != nil {
		last = *opts.Since
	}
	target, err := c.StreamURL(opts.Since)
	if err != nil {
		return last, err
	}
	header := http.Header{}
	header.Set("User-Agent", UserAgent)
	// Same credential as every other request; never an Origin (see the package doc).
	probe, _ := http.NewRequest("GET", c.cfg.BaseURL, nil)
	c.authenticate(probe)
	for k, v := range probe.Header {
		header[k] = v
	}
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second, Proxy: http.ProxyFromEnvironment}
	conn, resp, err := dialer.DialContext(ctx, target, header)
	if err != nil {
		if resp != nil {
			defer resp.Body.Close()
			var body struct {
				Error string `json:"error"`
				Scope string `json:"scope"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&body)
			msg := body.Error
			if msg == "" {
				msg = resp.Status
			}
			switch resp.StatusCode {
			case http.StatusUnauthorized:
				return last, fail.New(fail.Unauthenticated, "UNAUTHENTICATED", "the event stream refused the credential: "+msg).
					WithRemediation("check CLOUDMAIL_TOKEN, or run `cloudmail auth status`")
			case http.StatusForbidden:
				return last, fail.New(fail.Denied, "FORBIDDEN", msg).WithRemediation("the token needs the mail:read scope")
			case http.StatusTooManyRequests:
				return last, fail.New(fail.RateLimited, "RATE_LIMITED", msg).WithRemediation("close another open stream first")
			}
			return last, fail.Errf("could not open the event stream (%d): %s", resp.StatusCode, msg)
		}
		return last, fail.Errf("could not connect to %s: %v", target, err).Wrap(err)
	}
	defer conn.Close()

	// Close the socket when the context ends, so ReadMessage returns.
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "bye"), time.Now().Add(time.Second))
			_ = conn.Close()
		case <-done:
		}
	}()

	if err := conn.WriteJSON(subscribeFrame(opts)); err != nil {
		return last, fail.Errf("could not subscribe: %v", err).Wrap(err)
	}

	// Keep the connection warm through proxies that drop idle sockets.
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping"}`)); err != nil {
					return
				}
			case <-done:
				return
			}
		}
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			if ctx.Err() != nil {
				return last, nil
			}
			var ce *websocket.CloseError
			if errors.As(err, &ce) {
				switch ce.Code {
				case websocket.CloseNormalClosure:
					return last, nil
				case 1013:
					return last, fail.Errf("the server dropped this stream as too slow: %s", ce.Text).
						WithRemediation("reconnect with --since %d", last)
				case 4001:
					return last, fail.Errf("the stream's authorization expired").
						WithRemediation("reconnect with --since %d", last)
				case 4401:
					// Retrying cannot help: the credential is gone.
					return last, fail.New(fail.Unauthenticated, "UNAUTHENTICATED", "the API token or session was revoked").
						WithRemediation("create a new token, then run `cloudmail events tail --since %d`", last)
				case 4503:
					return last, fail.Errf("the server could not re-check authorization").
						WithRemediation("reconnect with --since %d", last)
				}
				return last, fail.Errf("the event stream closed (%d %s)", ce.Code, ce.Text)
			}
			return last, fail.Errf("the event stream failed: %v", err).Wrap(err)
		}
		var msg StreamMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			return last, fail.Errf("unreadable frame from the server: %v", err).Wrap(err)
		}
		msg.Raw = append(json.RawMessage(nil), data...)
		if msg.Type == "event" && msg.ID > last {
			last = msg.ID
		}
		if msg.Type == "error" {
			return last, fail.Usagef("the server refused the subscription: %s", msg.Error)
		}
		if err := onMessage(msg); err != nil {
			return last, err
		}
	}
}

// DescribeStreamMessage is a one-line summary of a non-event frame.
func DescribeStreamMessage(m StreamMessage) string {
	switch m.Type {
	case "subscribed":
		if len(m.Denied) > 0 {
			return fmt.Sprintf("subscribed (not readable, skipped: %s)", strings.Join(m.Denied, ", "))
		}
		return "subscribed"
	case "subscription_revoked":
		return fmt.Sprintf("no longer allowed to read %s; its events stop", m.Mailbox)
	case "overflow":
		return fmt.Sprintf("too slow; resume from %d", derefInt(m.ResumeFrom))
	default:
		return m.Type
	}
}

func derefInt(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}
