package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// errorBody is the envelope the Worker's error handler produces.
//
// The Worker emits `{"error": "..."}` for handled failures and
// `{"error":"Invalid request body","details":[{"path":[...],"message":"..."}]}`
// for a Zod rejection. `capability` appears on an authorization refusal and
// `blocked` on a refused attachment type.
type errorBody struct {
	Error string `json:"error"`
	// Code is the built-in auth layer's machine-readable reason, e.g.
	// "unauthenticated".
	Code    string `json:"code"`
	Message string `json:"message"`
	Details []struct {
		// Path is a Zod path: usually an array of segments, sometimes a bare
		// string. Typed as `any` because rejecting the shape we did not expect
		// would discard the very message that explains the failure.
		Path    any    `json:"path"`
		Field   string `json:"field"`
		Message string `json:"message"`
	} `json:"details"`
	Capability string `json:"capability"`
	// Scope names the token scope a scoped API token lacked (insufficient_scope).
	Scope   string `json:"scope"`
	Blocked bool   `json:"blocked"`
	// ManualSteps accompanies a 412 from domain provisioning: what to do by hand
	// when the deployment cannot call the Cloudflare API itself.
	ManualSteps []string `json:"manualSteps"`
	// Field names the rejected field on a 400 without Zod details.
	Field string `json:"field"`
	// Problems accompanies a 422 from AI routing: each role whose model fails
	// its capability check.
	Problems []struct {
		Role   string `json:"role"`
		Reason string `json:"reason"`
	} `json:"problems"`
}

// classify turns an HTTP failure into a fail.Error carrying the right exit code
// and a remediation naming the next step.
//
// This function decides what an automated caller does next, so each branch
// answers one question: is retrying useful, is a different argument needed, or
// must a human change a permission? Anything that cannot answer that lands on
// the generic branch rather than guessing.
func (c *Client) classify(req Request, full string, resp *http.Response, raw []byte) error {
	body := parseErrorBody(raw)
	msg := body.pick()
	status := resp.StatusCode

	stamp := func(e *fail.Error) error {
		e.Status = status
		e.Method = req.Method
		e.URL = full
		if body.Capability != "" {
			e.Capability = body.Capability
		}
		e.Details = append(e.Details, body.details()...)
		return e
	}

	// A redirect behind Access is the login page. Reported as an auth failure
	// rather than as an odd status, because that is what it means every time.
	if status >= 300 && status < 400 {
		loc := resp.Header.Get("Location")
		e := fail.New(fail.Unauthenticated, "ACCESS_LOGIN_REQUIRED",
			"Cloudflare Access redirected this request to a login page")
		e.Remediation = accessRemediation(c)
		if loc != "" && c.verbose {
			e.Remediation += fmt.Sprintf("\n(redirected to %s)", loc)
		}
		return stamp(e)
	}

	switch status {
	case http.StatusBadRequest:
		// The server validated the body and rejected it. The details name the
		// fields, so the fix is mechanical and no human is needed.
		e := fail.New(fail.Invalid, "INVALID_REQUEST", orDefault(msg, "the server rejected this request"))
		if len(body.Details) == 0 && body.Field != "" {
			e.Details = append(e.Details, fail.Detail{Field: body.Field, Message: orDefault(msg, "invalid")})
			e.Message = "the server rejected the request"
		}
		if len(body.Details) > 0 || body.Field != "" {
			e.Remediation = "correct the fields listed above and run the command again"
		} else {
			e.Remediation = fmt.Sprintf(
				"check the arguments against `cloudmail %s --help`", commandHint(req.Path))
		}
		return stamp(e)

	case http.StatusUnauthorized:
		e := fail.New(fail.Unauthenticated, "UNAUTHENTICATED",
			orDefault(msg, "not authenticated: the deployment did not accept the credential"))
		// A JSON 401 with a code comes from the Worker's built-in auth, which
		// means the deployment wants an API token whatever this CLI holds. Only
		// an uncoded 401 can be about Access.
		if body.Code != "" || c.cfg.Auth() == "api-token" || c.deploymentAuthMode() == "password" {
			e.Remediation = tokenRemediation(c)
		} else {
			e.Remediation = accessRemediation(c)
		}
		return stamp(e)

	case http.StatusForbidden:
		// 403 is two different failures wearing one status, and they need
		// opposite responses: no credential at all is fixable by the caller,
		// while a missing capability needs somebody to widen a grant.
		if c.cfg.Auth() == "none" && !isCapabilityRefusal(body) {
			if c.deploymentAuthMode() == "password" {
				e := fail.New(fail.Unauthenticated, "NO_CREDENTIAL",
					"the deployment requires sign-in and no API token was sent")
				e.Remediation = tokenRemediation(c)
				return stamp(e)
			}
			e := fail.New(fail.Unauthenticated, "NO_CREDENTIAL",
				"the deployment requires Cloudflare Access and no credential was sent")
			e.Remediation = accessRemediation(c)
			return stamp(e)
		}
		e := fail.New(fail.Denied, "FORBIDDEN", orDefault(msg, "not permitted"))
		switch body.Code {
		case "insufficient_scope":
			e.Code = "INSUFFICIENT_SCOPE"
			if body.Scope != "" {
				e.Message = fmt.Sprintf("this API token lacks the %q scope", body.Scope)
				e.Remediation = fmt.Sprintf("create a token that includes the %q scope "+
					"(`cloudmail token create --scope %s`, from a session or an unscoped token), "+
					"or use one that has it", body.Scope, body.Scope)
			} else {
				e.Remediation = "this API token's scopes do not cover the route; " +
					"run `cloudmail auth whoami` to see them"
			}
			return stamp(e)
		case "session_required", "reauth_required":
			e.Code = strings.ToUpper(body.Code)
			session := "a signed-in browser session"
			if body.Code == "reauth_required" {
				session += " that re-confirmed your password or passkey in the last 15 minutes"
			}
			e.Remediation = "this action needs " + session + "; an API token cannot do it. " +
				"Do it in the web app"
			return stamp(e)
		}
		if body.Code == "person_required" {
			// AI gateway config (and similar) changes refuse API tokens by design:
			// a leaked token must not be able to reroute mail content.
			e.Code = "PERSON_REQUIRED"
			e.Remediation = "this change needs a signed-in browser session; an API token " +
				"cannot make it. Make it in the web app's settings, or read the current " +
				"state with a token instead"
		} else if body.Capability != "" {
			e.Message = fmt.Sprintf("this mailbox grant lacks the %q capability", body.Capability)
			e.Remediation = fmt.Sprintf(
				"ask an administrator to grant %q on this mailbox (Settings -> Access), "+
					"or run `cloudmail auth whoami` to see what you do hold",
				body.Capability)
		} else if body.Blocked {
			e.Code = "BLOCKED_CONTENT"
			e.Remediation = "the server refuses this attachment type; nothing can be changed client-side"
		} else {
			e.Remediation = "run `cloudmail auth whoami` to see which mailboxes and capabilities you hold"
		}
		return stamp(e)

	case http.StatusPaymentRequired:
		// The licence gate: every route but the licence ones answers 402 while
		// the deployment is unlicensed or its licence lapsed.
		e := fail.New(fail.Denied, "LICENCE_REQUIRED",
			orDefault(msg, "this deployment needs an active licence"))
		e.Remediation = "an administrator must activate or renew the licence in the web app " +
			"(Settings -> Licence); `cloudmail licence status` shows the current state"
		return stamp(e)

	case http.StatusNotFound:
		e := fail.New(fail.NotFound, "NOT_FOUND", orDefault(msg, "not found"))
		e.Remediation = notFoundRemediation(req.Path)
		return stamp(e)

	case http.StatusConflict:
		switch body.Code {
		case "idempotency_request_in_progress":
			// The first request with this key is still running. Safe to repeat:
			// the server will replay its result once it finishes.
			e := fail.New(fail.Conflict, "IDEMPOTENCY_IN_PROGRESS",
				orDefault(msg, "a request with this idempotency key is still running"))
			e.Retryable = true
			e.RetryAfter = retryAfterSeconds(resp.Header)
			if e.RetryAfter == 0 {
				e.RetryAfter = 1
			}
			e.Remediation = "wait a second and rerun with the same --idempotency-key; " +
				"the first request's result will be returned"
			return stamp(e)
		case "idempotency_key_reused":
			e := fail.New(fail.Conflict, "IDEMPOTENCY_KEY_REUSED",
				orDefault(msg, "this idempotency key was used for a different request"))
			e.Remediation = "use a new --idempotency-key for a different request, " +
				"or omit the flag to get a fresh one"
			return stamp(e)
		}
		e := fail.New(fail.Conflict, "CONFLICT",
			orDefault(msg, "the request conflicts with the resource's current state"))
		e.Remediation = "nothing was changed. The resource is not in the state this " +
			"request expects: it may already exist, already be decided, or have changed " +
			"since you read it. Read it again, then decide whether to retry"
		if req.Method == "POST" && !strings.Contains(req.Path, "/approvals/") &&
			strings.Contains(strings.ToLower(msg), "exist") {
			e.Remediation = "it already exists; update it instead of creating it"
		}
		if req.Method == "DELETE" && strings.Contains(req.Path, "/domains/") {
			// A domain delete is refused while mailboxes remain on it or while it
			// is seeded from configuration; "already exists" would mislead.
			e.Remediation = "delete its mailboxes first (`cloudmail mailbox list --domain <host>`), " +
				"and remove it from the deployment's DOMAINS setting if it is listed there"
		}
		return stamp(e)

	case http.StatusPreconditionFailed:
		// Only domain provisioning answers 412 today: the deployment has no
		// CF_API_TOKEN, so it cannot configure Cloudflare itself. That is a state
		// problem rather than a bad request, and retrying will not change it.
		e := fail.New(fail.Conflict, "PRECONDITION_FAILED",
			orDefault(msg, "a precondition for this request is not met"))
		if strings.Contains(req.Path, "/domains/") {
			e.Code = "CLOUDFLARE_NOT_CONFIGURED"
			e.Remediation = "set CF_API_TOKEN on the deployment and retry, or create the " +
				"records by hand -- `cloudmail domain get <domain>` lists them"
		}
		for i, step := range body.ManualSteps {
			e.Details = append(e.Details, fail.Detail{
				Field: fmt.Sprintf("step %d", i+1), Message: step,
			})
		}
		return stamp(e)

	case http.StatusPreconditionRequired:
		// Domain provisioning answers 428 for a domain from DOMAINS/ZONES: it is
		// already live, so the run has to be confirmed explicitly.
		e := fail.New(fail.Conflict, "CONFIRMATION_REQUIRED",
			orDefault(msg, "this request needs an explicit confirmation"))
		if strings.Contains(req.Path, "/domains/") {
			e.Code = "CONFIRM_ENV_DOMAIN"
			e.Remediation = "this domain is configured in DOMAINS/ZONES and already live; " +
				"rerun with --confirm-env-domain if you mean to change its Cloudflare setup"
		}
		return stamp(e)

	case http.StatusUnprocessableEntity:
		// The body parsed but failed a semantic check. AI routing sends the
		// roles whose models fail their capability check; each becomes a
		// "role: reason" line so the fix is visible without --json.
		e := fail.New(fail.Invalid, "UNPROCESSABLE",
			orDefault(msg, "the server could not apply this request"))
		if body.Code != "" {
			e.Code = strings.ToUpper(body.Code)
		}
		for _, p := range body.Problems {
			e.Details = append(e.Details, fail.Detail{Field: p.Role, Message: p.Reason})
		}
		if len(body.Problems) > 0 {
			e.Remediation = "route each role listed above to a model that has the capability " +
				"it needs (`cloudmail ai provider test <id> --model M` checks one), " +
				"or clear it with `cloudmail ai provider route <role>=`"
		}
		return stamp(e)

	case http.StatusRequestEntityTooLarge:
		e := fail.New(fail.TooLarge, "TOO_LARGE",
			orDefault(msg, "the message is larger than the server accepts"))
		e.Remediation = "remove or shrink attachments and try again"
		return stamp(e)

	case http.StatusTooManyRequests:
		after := retryAfterSeconds(resp.Header)
		if after == 0 {
			after = 60 // the Worker's own window
		}
		e := fail.New(fail.RateLimited, "RATE_LIMITED", orDefault(msg, "rate limited"))
		e.Retryable = true
		e.RetryAfter = after
		// The two rate limits behind this status need different responses: a
		// request-rate limit clears in a minute, an outbound send quota does not.
		if isSendPath(req.Path) {
			e.Code = "SEND_QUOTA"
			e.Remediation = fmt.Sprintf(
				"this mailbox is at its outbound send quota (20/hour, 100/day). "+
					"Waiting %ds will not help if the daily cap is reached; "+
					"schedule the message instead with `cloudmail schedule create`", after)
		} else {
			e.Remediation = fmt.Sprintf("wait %ds and retry; cloudmail retries this automatically "+
				"unless --retries 0 was passed", after)
		}
		return stamp(e)

	case http.StatusNotImplemented, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		e := fail.New(fail.Server, "SERVER_UNAVAILABLE",
			orDefault(msg, fmt.Sprintf("the deployment returned %d", status)))
		e.Retryable = true
		e.Remediation = "transient; retry shortly. If it persists, check the Worker's logs " +
			"with `npx wrangler tail`"
		return stamp(e)
	}

	if status >= 500 {
		e := fail.New(fail.Server, "SERVER_ERROR",
			orDefault(msg, fmt.Sprintf("the deployment returned %d", status)))
		e.Retryable = true
		e.Remediation = "this is a fault in the deployment, not in the request. " +
			"Check the Worker's logs with `npx wrangler tail`"
		return stamp(e)
	}

	e := fail.Errf("unexpected response %d from %s %s", status, req.Method, req.Path)
	if msg != "" {
		e.Message += ": " + msg
	}
	return stamp(e)
}

// parseErrorBody reads the Worker's error envelope, tolerating a non-JSON body.
//
// An HTML body is what the Access edge returns, and it must not become a
// thousand lines of markup in an error message.
func parseErrorBody(raw []byte) errorBody {
	var b errorBody
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return b
	}
	if strings.HasPrefix(trimmed, "{") {
		if err := json.Unmarshal(raw, &b); err == nil {
			return b
		}
	}
	if strings.HasPrefix(trimmed, "<") {
		// HTML: almost certainly the Access login page or a Cloudflare error page.
		return b
	}
	// A plain-text body. The Worker sends "Missing required CF Access JWT" this
	// way, which is worth surfacing verbatim.
	b.Error = truncate(trimmed, 300)
	return b
}

func (b errorBody) pick() string {
	if b.Error != "" {
		return b.Error
	}
	return b.Message
}

func (b errorBody) details() []fail.Detail {
	out := make([]fail.Detail, 0, len(b.Details))
	for _, d := range b.Details {
		out = append(out, fail.Detail{
			Field:   firstNonEmpty(d.Field, zodPath(d.Path)),
			Message: d.Message,
		})
	}
	return out
}

// zodPath renders a Zod issue path as a dotted field name. Zod sends an array of
// string and number segments; a number is an array index.
func zodPath(v any) string {
	switch p := v.(type) {
	case string:
		return p
	case []any:
		parts := make([]string, 0, len(p))
		for _, seg := range p {
			switch s := seg.(type) {
			case string:
				parts = append(parts, s)
			case float64:
				parts = append(parts, fmt.Sprintf("[%d]", int(s)))
			}
		}
		return strings.TrimPrefix(strings.Join(parts, "."), ".")
	default:
		return ""
	}
}

// isCapabilityRefusal reports whether a 403 came from the app's authorization
// layer rather than from the Access edge. The app names the capability, or says
// so in prose; the edge does neither.
func isCapabilityRefusal(b errorBody) bool {
	if b.Capability != "" || b.Blocked {
		return true
	}
	m := strings.ToLower(b.pick())
	return strings.Contains(m, "permission") ||
		strings.Contains(m, "not allowed") ||
		strings.Contains(m, "do not have")
}

// deploymentAuthMode asks the deployment which sign-in it uses: "password"
// (built-in accounts and API tokens) or "access" (legacy Cloudflare Access).
// GET /api/auth/state answers without a credential in both modes. It returns
// "" when that cannot be told, for example behind an Access login redirect,
// and the caller then keeps its Access wording. Called only on an auth failure
// whose body does not already say which mode it came from.
func (c *Client) deploymentAuthMode() string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.BaseURL+"/api/auth/state", nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", UserAgent)
	resp, err := c.http.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !isJSON(resp.Header.Get("Content-Type")) {
		return ""
	}
	var state struct {
		Mode string `json:"mode"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&state) != nil {
		return ""
	}
	switch state.Mode {
	case "password", "access":
		return state.Mode
	}
	return ""
}

// tokenRemediation explains a 401 from a deployment using built-in auth.
func tokenRemediation(c *Client) string {
	const create = "create a token in Settings → Account & security → API tokens " +
		"and set CLOUDMAIL_TOKEN or run `cloudmail auth login`"
	switch c.cfg.Auth() {
	case "api-token":
		src := c.cfg.TokenSource()
		if src == "" {
			src = "configuration"
		}
		return "the API token (from " + src + ") was rejected: it may be revoked, " +
			"expired, or from a different deployment. " + strings.ToUpper(create[:1]) + create[1:]
	case "none":
		return "this deployment requires sign-in and no API token was sent; " + create
	default:
		return "this deployment uses built-in sign-in, not Cloudflare Access, so the " +
			"Access credentials were ignored; " + create
	}
}

func accessRemediation(c *Client) string {
	if strings.Contains(c.cfg.BaseURL, "localhost") ||
		strings.Contains(c.cfg.BaseURL, "127.0.0.1") {
		return "a local `npm run dev` server normally skips Cloudflare Access entirely. " +
			"Getting this against localhost suggests --base-url points at a deployed instance"
	}
	switch c.cfg.Auth() {
	case "api-token":
		return "this deployment uses Cloudflare Access, which does not accept API tokens. " +
			"Use an Access service token instead (CLOUDMAIL_CLIENT_ID and " +
			"CLOUDMAIL_CLIENT_SECRET, with CLOUDMAIL_TOKEN unset); see `cloudmail auth --help`"
	case "none":
		return "create a Cloudflare Access service token " +
			"(Zero Trust -> Access -> Service auth), add it to the Access policy on this " +
			"Worker, then export CLOUDMAIL_CLIENT_ID and CLOUDMAIL_CLIENT_SECRET. " +
			"Run `cloudmail auth --help` for the full walkthrough"
	case "access-jwt":
		return "the supplied Access JWT was rejected, most likely expired. " +
			"Mint a fresh one, or switch to a service token, which does not expire mid-job"
	default:
		return "the service token was rejected. Confirm it is included in the Access policy " +
			"protecting this Worker, and that its Client ID is granted a mailbox at " +
			"Settings -> Access. Verify with `cloudmail auth whoami`"
	}
}

// notFoundRemediation names the sibling list command for whatever was missing,
// so the caller learns a valid id from the same error rather than guessing.
func notFoundRemediation(path string) string {
	switch {
	case strings.Contains(path, "/emails/"):
		return "list messages with `cloudmail mail list` to find a valid id"
	case strings.Contains(path, "/labels"):
		return "list labels with `cloudmail label list`"
	case strings.Contains(path, "/folders"):
		return "list folders with `cloudmail folder list`"
	case strings.Contains(path, "/threads/"):
		return "thread ids come from `cloudmail mail list --output json`"
	case strings.Contains(path, "/templates"):
		return "list templates with `cloudmail template list`"
	case strings.Contains(path, "/sequences"):
		return "list sequences with `cloudmail sequence list`"
	case strings.Contains(path, "/rules"):
		return "list rules with `cloudmail rule list`"
	case strings.Contains(path, "/signatures"):
		return "list signatures with `cloudmail signature list`"
	case strings.Contains(path, "/scheduled-sends"):
		return "list pending sends with `cloudmail schedule list`"
	case strings.Contains(path, "/domains/"):
		return "list domains with `cloudmail domain list`; " +
			"a domain can be named by its id (dom_...) or its hostname"
	case strings.Contains(path, "/mailboxes/"):
		return "list mailboxes with `cloudmail mailbox list`; " +
			"note the id is the full address, e.g. hello@example.com"
	default:
		return "list the collection to find a valid id"
	}
}

func isSendPath(path string) bool {
	return strings.HasSuffix(path, "/emails") ||
		strings.HasSuffix(path, "/reply") ||
		strings.HasSuffix(path, "/forward") ||
		strings.Contains(path, "/scheduled-sends")
}

// commandHint guesses the command family from a request path, for a remediation
// that points at the right --help page.
func commandHint(path string) string {
	switch {
	case strings.Contains(path, "/drafts"):
		return "draft"
	case strings.Contains(path, "/scheduled-sends"):
		return "schedule"
	case strings.Contains(path, "/labels"):
		return "label"
	case strings.Contains(path, "/folders"):
		return "folder"
	case strings.Contains(path, "/rules"):
		return "rule"
	case strings.Contains(path, "/templates"):
		return "template"
	case strings.Contains(path, "/sequences"):
		return "sequence"
	case strings.Contains(path, "/domains"):
		return "domain"
	case strings.Contains(path, "/emails"):
		return "mail"
	case strings.Contains(path, "/mailboxes"):
		return "mailbox"
	default:
		return ""
	}
}

func orDefault(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
