// Package api is the HTTP client for a tapetide-agentic-inbox deployment.
//
// The Worker's API is a Hono app under /api/v1. Three properties of it shape
// this client:
//
//  1. A deployment authenticates in one of two modes. With built-in auth (the
//     default) a machine caller sends a personal API token as
//     `Authorization: Bearer ttk_...`, and the Worker answers a missing or bad
//     one with a JSON 401. In legacy Cloudflare Access mode authentication
//     happens at the edge instead: the caller presents an Access service token
//     (CF-Access-Client-Id / CF-Access-Client-Secret) and the edge exchanges it
//     for the JWT the Worker validates, or redirects to a login page.
//
//  2. The Worker runs a CSRF guard on every unsafe method. It passes a request
//     that sends neither Origin nor Sec-Fetch-Site, on the reasoning that a
//     non-browser client cannot be coerced into spending someone else's cookie.
//     So this client deliberately sends neither header. Adding an Origin here
//     would start failing every POST.
//
//  3. Responses are not uniformly shaped. The list-emails route returns a bare
//     JSON array when no folder is given and an object when one is. Rather than
//     paper over that in each command, Client decodes into json.RawMessage and
//     the typed helpers normalise it once.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/cloudmail-hq/cloudmail/cli/internal/config"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// UserAgent identifies this client in the Worker's logs. Version is stamped by
// the build; see cmd.Version.
var UserAgent = "cloudmail/dev (+https://github.com/cloudmail-hq/cloudmail)"

// Client talks to one deployment.
type Client struct {
	cfg  *config.Config
	http *http.Client

	// dryRun makes every state-changing request return a preview instead of
	// being sent. It lives on the client rather than being threaded through each
	// call so a command cannot forget to honour it -- the check happens at the
	// single choke point every request passes through.
	dryRun bool

	// readOnly refuses state-changing requests outright.
	readOnly bool

	// verbose traces requests to stderr.
	verbose bool

	// previews accumulates the requests withheld by --dry-run.
	//
	// Recorded on the client rather than returned to each call site because a
	// command that loops -- deleting several ids, applying a bulk action in chunks
	// -- produces one preview per request, and the command layer should be able to
	// report all of them without threading a collector through every method. It
	// also means a typed helper whose result value is left zero by a dry run
	// cannot accidentally render that empty value as the outcome.
	previews []*Preview

	// now is injectable for tests.
	now func() time.Time

	// idemKey is this invocation's Idempotency-Key, sent on Keyed requests.
	// idemUsed counts keyed requests so far; see nextIdempotencyKey.
	idemKey  string
	idemUsed int
}

// Previews returns the requests --dry-run withheld, in the order they were made.
func (c *Client) Previews() []*Preview { return c.previews }

// New builds a Client from resolved configuration.
func New(cfg *config.Config) *Client {
	return &Client{
		cfg:      cfg,
		readOnly: cfg.ReadOnly,
		verbose:  cfg.Verbose,
		now:      time.Now,
		http: &http.Client{
			Timeout: cfg.Timeout.AsDuration(),
			// Redirects are not followed for API calls. Behind Access, a 302 is
			// almost always the login page: following it would return HTML with
			// a 200, and the caller would see "unexpected response" instead of
			// "you are not authenticated". Stopping here lets classify() say the
			// useful thing.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// SetDryRun enables preview mode.
func (c *Client) SetDryRun(v bool) { c.dryRun = v }

// DryRun reports whether preview mode is on.
func (c *Client) DryRun() bool { return c.dryRun }

// ReadOnly reports whether mutations are refused locally.
func (c *Client) ReadOnly() bool { return c.readOnly }

// Config exposes the resolved configuration for commands that need to report it.
func (c *Client) Config() *config.Config { return c.cfg }

// Preview describes a request that --dry-run withheld. It is returned as the
// command's normal output so the preview is machine-readable: a caller can
// inspect exactly what would have been sent, which is the whole point of a
// dry run for an agent deciding whether to commit.
type Preview struct {
	DryRun bool   `json:"dry_run"`
	Method string `json:"method"`
	URL    string `json:"url"`
	// Body is the JSON that would have been sent, inlined rather than escaped
	// into a string so the preview reads as the request it describes.
	Body json.RawMessage `json:"body,omitempty"`
	// Reversible flags whether the real call could be undone afterwards. An
	// agent can use this to decide whether to ask a human first.
	Reversible bool   `json:"reversible"`
	Note       string `json:"note,omitempty"`
}

// Request is one API call.
type Request struct {
	Method string
	// Path is relative to the deployment root and must begin with a slash,
	// e.g. "/api/v1/mailboxes". Segments are escaped by the Path helpers, not
	// here, because only the caller knows which parts are data.
	Path  string
	Query url.Values

	// Body is marshalled to JSON when non-nil.
	Body any

	// Raw sends these bytes verbatim with ContentType. Used for uploads.
	Raw         []byte
	ContentType string

	// Headers are added after the auth headers, and may not override them: a
	// command must not be able to forge or strip a credential.
	Headers map[string]string

	// Mutates marks a request that changes server state. This drives both the
	// read-only refusal and the dry-run preview, so getting it wrong is a
	// safety bug. It is set explicitly rather than inferred from the method
	// because a POST can be a read (search) and that distinction matters.
	Mutates bool

	// Reversible describes whether the change could be undone. Reported in
	// previews and used to decide whether a confirmation is required.
	Reversible bool

	// Idempotent allows retrying after a transport failure. A send is not
	// idempotent: a request that failed on the way back may already have sent
	// the mail, and retrying would send it twice.
	Idempotent bool

	// Keyed marks a send or create the server deduplicates on Idempotency-Key.
	// When the invocation has a key it is attached, and the request becomes
	// safe to retry: a repeat replays the first response instead of acting.
	Keyed bool

	// Note is shown in a dry-run preview to explain a consequence the request
	// body does not make obvious.
	Note string
}

// Response is a decoded API response.
type Response struct {
	Status int
	Header http.Header
	// Body is the raw JSON, left undecoded because response shapes vary per
	// route. Use Decode or the typed helpers.
	Body json.RawMessage
	// Bytes is the unparsed payload, for binary routes like attachment download.
	Bytes []byte
	// Preview is set instead of Status/Body when --dry-run withheld the request.
	Preview *Preview
}

// Decode unmarshals the JSON body into v.
func (r *Response) Decode(v any) error {
	if r.Preview != nil {
		return nil // nothing came back; the caller renders the preview
	}
	if len(r.Body) == 0 {
		return nil // 204, or an empty 200
	}
	if err := json.Unmarshal(r.Body, v); err != nil {
		return fail.Errf("the server returned JSON this version cannot read: %v", err).
			WithRemediation("this usually means the CLI is older than the deployment; " +
				"upgrade cloudmail, or report it with `cloudmail --version`").
			Wrap(err)
	}
	return nil
}

// Do executes a request, applying the read-only guard, the dry-run preview, auth
// headers, retries, and error classification. Every call in this package goes
// through it.
func (c *Client) Do(ctx context.Context, req Request) (*Response, error) {
	c.applyIdempotency(&req)
	if req.Mutates {
		if c.readOnly {
			return nil, fail.Refusedf(
				"%s %s changes state, and this session is read-only",
				req.Method, req.Path).
				WithRemediation("drop --read-only, or unset CLOUDMAIL_READ_ONLY, to allow it")
		}
		if c.dryRun {
			return c.preview(req)
		}
	}

	full, err := c.url(req.Path, req.Query)
	if err != nil {
		return nil, err
	}

	var payload []byte
	contentType := req.ContentType
	switch {
	case req.Raw != nil:
		payload = req.Raw
	case req.Body != nil:
		payload, err = json.Marshal(req.Body)
		if err != nil {
			return nil, fail.Errf("cannot encode the request body: %v", err).Wrap(err)
		}
		if contentType == "" {
			contentType = "application/json"
		}
	}

	// Retries cover only the cases where a repeat is safe and plausibly useful:
	// a transport failure or a 5xx on an idempotent request, and a 429 on
	// anything (the server explicitly told us to come back). A failed send is
	// never retried -- see Request.Idempotent.
	attempts := 1 + c.cfg.Retries
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		resp, err := c.attempt(ctx, req, full, payload, contentType)
		if err == nil {
			return resp, nil
		}
		lastErr = err

		if attempt == attempts || !c.shouldRetry(req, err) {
			break
		}
		wait := c.backoff(attempt, err)
		// A long wait is announced whether or not --verbose was asked for. Honouring
		// a server's Retry-After of 60s in silence is indistinguishable from a
		// hang, and the reader needs to know it is a deliberate wait they can
		// shorten with --retries 0.
		if c.verbose || wait >= 3*time.Second {
			fmt.Fprintf(os.Stderr, "cloudmail: %s; waiting %s before retry %d of %d "+
				"(Ctrl-C to stop, or pass --retries 0)\n",
				shortErr(err), wait, attempt, attempts-1)
		}
		select {
		case <-ctx.Done():
			return nil, ctxErr(ctx)
		case <-time.After(wait):
		}
	}
	return nil, lastErr
}

func (c *Client) preview(req Request) (*Response, error) {
	full, err := c.url(req.Path, req.Query)
	if err != nil {
		return nil, err
	}
	p := &Preview{
		DryRun:     true,
		Method:     req.Method,
		URL:        full,
		Reversible: req.Reversible,
		Note:       req.Note,
	}
	if req.Body != nil {
		raw, err := json.Marshal(req.Body)
		if err != nil {
			return nil, fail.Errf("cannot encode the request body: %v", err).Wrap(err)
		}
		p.Body = raw
	}
	c.previews = append(c.previews, p)
	return &Response{Status: 0, Preview: p}, nil
}

func (c *Client) attempt(
	ctx context.Context, req Request, full string, payload []byte, contentType string,
) (*Response, error) {
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}

	httpReq, err := http.NewRequestWithContext(ctx, req.Method, full, body)
	if err != nil {
		return nil, fail.Usagef("cannot build a request for %s: %v", full, err).Wrap(err)
	}

	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	// authenticate runs after the caller's headers, so it overwrites any it sets.
	// Authorization is also dropped outright: in Access mode authenticate sends
	// none, and a passed-through one would reach the Worker unexamined.
	httpReq.Header.Del("Authorization")
	if contentType != "" {
		httpReq.Header.Set("Content-Type", contentType)
	}
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("User-Agent", UserAgent)
	c.authenticate(httpReq)

	// Deliberately absent: Origin and Sec-Fetch-Site. The Worker's CSRF guard
	// admits a request carrying neither. See the package comment.

	if c.verbose {
		fmt.Fprintf(os.Stderr, "cloudmail: %s %s\n", req.Method, full)
	}

	httpResp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, c.transportError(req, full, err)
	}
	defer httpResp.Body.Close()

	// 8 MiB ceiling. A mailbox export can be far larger, but those routes stream
	// to a file rather than coming through here; an API response this big means
	// something has gone wrong, and buffering it unbounded would let the server
	// exhaust the client's memory.
	raw, err := io.ReadAll(io.LimitReader(httpResp.Body, 8<<20))
	if err != nil {
		return nil, c.transportError(req, full, err)
	}

	resp := &Response{
		Status: httpResp.StatusCode,
		Header: httpResp.Header,
		Bytes:  raw,
	}
	if isJSON(httpResp.Header.Get("Content-Type")) && len(raw) > 0 {
		resp.Body = json.RawMessage(raw)
	}

	// 3xx counts as a failure here, deliberately. CheckRedirect stops the client
	// from following redirects, so a 302 arrives intact -- and behind Access it is
	// the login page, which classify() reports as "not authenticated" rather than
	// as an odd status. Narrowing this to >= 400 would let that 302 return as a
	// success carrying HTML, which is the confusing outcome the package comment
	// and TestRedirectIsReportedAsAuthFailure both exist to prevent.
	if httpResp.StatusCode >= 300 {
		return nil, c.classify(req, full, httpResp, raw)
	}
	return resp, nil
}

// authenticate attaches the credential.
//
// Exactly one is sent. An API token wins (see config.Config.Auth); otherwise a
// service token is preferred over a bare JWT, because the token is refreshed by
// the edge on every call, whereas a JWT captured earlier expires and produces a
// confusing 403 an hour into a long job.
func (c *Client) authenticate(r *http.Request) {
	switch {
	case c.cfg.Token != "":
		r.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	case c.cfg.ClientID != "" && c.cfg.ClientSecret != "":
		r.Header.Set("CF-Access-Client-Id", c.cfg.ClientID)
		r.Header.Set("CF-Access-Client-Secret", c.cfg.ClientSecret)
	case c.cfg.AccessJWT != "":
		r.Header.Set("Cf-Access-Jwt-Assertion", c.cfg.AccessJWT)
		// Some Access setups read the cookie rather than the header. Sending both
		// costs nothing and removes a class of "works in curl, not here" reports.
		r.Header.Set("Cookie", "CF_Authorization="+c.cfg.AccessJWT)
	}
	if c.cfg.MigrationToken != "" {
		r.Header.Set("X-Migration-Token", c.cfg.MigrationToken)
	}
}

func (c *Client) url(path string, q url.Values) (string, error) {
	if !strings.HasPrefix(path, "/") {
		return "", fail.Errf("internal: request path %q must start with a slash", path)
	}
	full := c.cfg.BaseURL + path
	if len(q) > 0 {
		full += "?" + q.Encode()
	}
	if _, err := url.Parse(full); err != nil {
		return "", fail.Usagef("the resulting URL is not valid: %s", full).Wrap(err)
	}
	return full, nil
}

func (c *Client) shouldRetry(req Request, err error) bool {
	e := fail.AsError(err)
	if e == nil || !e.Retryable {
		return false
	}
	// A 429 is safe to repeat whatever the method: the server refused to act.
	if e.ExitCode() == fail.RateLimited {
		return true
	}
	// Everything else -- transport failures, 5xx -- may have been applied
	// server-side before the failure surfaced, so only repeat when a repeat is
	// harmless.
	return req.Idempotent
}

func (c *Client) backoff(attempt int, err error) time.Duration {
	if e := fail.AsError(err); e != nil && e.RetryAfter > 0 {
		// Honour the server's number rather than guessing. The Worker sends
		// Retry-After: 60 with its rate limits.
		return time.Duration(e.RetryAfter) * time.Second
	}
	// 500ms, 1s, 2s, 4s... capped. No jitter: a CLI is one caller, not a
	// thundering herd, and a deterministic wait is easier to reason about when
	// a job's total runtime matters.
	d := 500 * time.Millisecond << (attempt - 1)
	if d > 8*time.Second {
		d = 8 * time.Second
	}
	return d
}

func (c *Client) transportError(req Request, full string, err error) error {
	if errors.Is(err, context.Canceled) {
		return fail.New(fail.Interrupted, "CANCELLED", "cancelled")
	}
	if errors.Is(err, context.DeadlineExceeded) || isTimeout(err) {
		return fail.New(fail.Network, "TIMEOUT",
			fmt.Sprintf("no response from %s within %s", c.cfg.BaseURL, c.cfg.Timeout)).
			WithRemediation("raise --timeout, or check that the deployment is reachable").
			Wrap(err)
	}

	e := fail.Networkf("cannot reach %s: %v", c.cfg.BaseURL, unwrapURLError(err)).Wrap(err)
	e.Method, e.URL = req.Method, full

	if strings.HasPrefix(c.cfg.BaseURL, "http://localhost") ||
		strings.HasPrefix(c.cfg.BaseURL, "http://127.0.0.1") {
		e.Remediation = "start the deployment locally with `npm run dev`, " +
			"or point at a deployed one with `cloudmail config set base-url <url>`"
	} else {
		e.Remediation = "check the URL with `cloudmail config get base-url` and that you are online"
	}
	return e
}

func isJSON(ct string) bool {
	return strings.Contains(strings.ToLower(ct), "json")
}

func isTimeout(err error) bool {
	var t interface{ Timeout() bool }
	return errors.As(err, &t) && t.Timeout()
}

func unwrapURLError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) && ue.Err != nil {
		return ue.Err
	}
	return err
}

func shortErr(err error) string {
	s := fail.AsError(err).Message
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return s
}

func ctxErr(ctx context.Context) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fail.New(fail.Network, "TIMEOUT", "timed out")
	}
	return fail.New(fail.Interrupted, "CANCELLED", "cancelled")
}

func retryAfterSeconds(h http.Header) int {
	v := strings.TrimSpace(h.Get("Retry-After"))
	if v == "" {
		return 0
	}
	if n, err := strconv.Atoi(v); err == nil && n >= 0 {
		return n
	}
	// The header may also be an HTTP date.
	if t, err := http.ParseTime(v); err == nil {
		if d := int(time.Until(t).Seconds()); d > 0 {
			return d
		}
	}
	return 0
}
