package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// APIPrefix is the version prefix every route in this client shares. Kept in one
// place so a future /api/v2 is a one-line change rather than a search.
const APIPrefix = "/api/v1"

// path builds a route from literal segments and caller-supplied data.
//
// Every dynamic segment is percent-escaped. This matters more than it looks: a
// mailbox id is an email address, so it always contains an `@`, and a label name
// can contain a slash. Interpolating those with fmt.Sprintf would produce a URL
// that addresses a different resource than the one asked for, and for a delete
// that is a real hazard rather than a cosmetic bug.
func path(segments ...string) string {
	var b strings.Builder
	b.WriteString(APIPrefix)
	for _, s := range segments {
		b.WriteByte('/')
		b.WriteString(url.PathEscape(s))
	}
	return b.String()
}

// mailboxPath builds /api/v1/mailboxes/{id}/... .
func mailboxPath(mailbox string, rest ...string) string {
	return path(append([]string{"mailboxes", mailbox}, rest...)...)
}

// ── Query building ─────────────────────────────────────────────────

// Query accumulates query parameters, skipping empty values so a route never
// receives `?folder=` and has to decide what an empty folder means.
type Query struct{ v url.Values }

// NewQuery starts an empty parameter set.
func NewQuery() *Query { return &Query{v: url.Values{}} }

// Str adds a string parameter when non-empty.
func (q *Query) Str(key, val string) *Query {
	if val != "" {
		q.v.Set(key, val)
	}
	return q
}

// Int adds an integer parameter when positive. Zero means "not specified" for
// every numeric parameter this API takes (page, limit, days), so it is skipped.
func (q *Query) Int(key string, val int) *Query {
	if val > 0 {
		q.v.Set(key, strconv.Itoa(val))
	}
	return q
}

// Bool adds a tri-state flag. A nil pointer omits the parameter entirely, which
// is what "do not filter on this" has to mean: sending `unread=false` filters
// for read messages, a different question from not filtering at all.
func (q *Query) Bool(key string, val *bool) *Query {
	if val != nil {
		q.v.Set(key, strconv.FormatBool(*val))
	}
	return q
}

// Flag adds a parameter only when true, for switches like `permanent=1` where
// the Worker tests only for presence and truthiness.
func (q *Query) Flag(key string, val bool) *Query {
	if val {
		q.v.Set(key, "1")
	}
	return q
}

// Values returns the accumulated parameters.
func (q *Query) Values() url.Values { return q.v }

// ── Typed request helpers ──────────────────────────────────────────

// get performs a read and decodes the result. Reads are always idempotent and
// never mutate, so those flags are set here once instead of at each call site
// where forgetting one would silently disable retries.
func (c *Client) get(ctx context.Context, p string, q *Query, out any) error {
	var vals url.Values
	if q != nil {
		vals = q.Values()
	}
	resp, err := c.Do(ctx, Request{
		Method:     "GET",
		Path:       p,
		Query:      vals,
		Idempotent: true,
	})
	if err != nil {
		return err
	}
	return resp.Decode(out)
}

// mutate performs a state-changing request.
func (c *Client) mutate(ctx context.Context, req Request, out any) (*Response, error) {
	req.Mutates = true
	resp, err := c.Do(ctx, req)
	if err != nil {
		return nil, err
	}
	if out != nil {
		if err := resp.Decode(out); err != nil {
			return nil, err
		}
	}
	return resp, nil
}

// Raw exposes an arbitrary route for `cloudmail api`, the escape hatch that keeps
// the CLI useful against a deployment newer than itself.
//
// A CLI that can only reach the routes its author wrapped becomes an obstacle the
// moment the server grows a feature. This method is that obstacle's absence. It
// takes the path verbatim, so the caller owns escaping.
func (c *Client) Raw(
	ctx context.Context, method, p string, q url.Values, body json.RawMessage, mutates bool,
) (*Response, error) {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	req := Request{
		Method:     strings.ToUpper(method),
		Path:       p,
		Query:      q,
		Mutates:    mutates,
		Idempotent: isIdempotentMethod(method),
		Reversible: false,
		Note:       "sent verbatim by `cloudmail api`; cloudmail cannot vouch for its effect",
	}
	if len(body) > 0 {
		req.Body = body
	}
	return c.Do(ctx, req)
}

func isIdempotentMethod(m string) bool {
	switch strings.ToUpper(m) {
	case "GET", "HEAD", "OPTIONS", "PUT", "DELETE":
		return true
	default:
		return false
	}
}

// requireMailbox turns a missing mailbox into a usage error naming the three ways
// to supply one, rather than letting the request go out addressed to
// /mailboxes//emails and come back as a puzzling 404.
func requireMailbox(mailbox string) error {
	if strings.TrimSpace(mailbox) != "" {
		return nil
	}
	return fail.Usagef("no mailbox specified").
		WithRemediation("pass --mailbox you@example.com, " +
			"set a default with `cloudmail config set mailbox you@example.com`, " +
			"or export CLOUDMAIL_MAILBOX. List what you can reach with `cloudmail mailbox list`")
}

// requireID rejects an empty positional argument with the same courtesy.
func requireID(kind, id string) error {
	if strings.TrimSpace(id) != "" {
		return nil
	}
	return fail.Usagef("no %s id given", kind).
		WithRemediation("run `cloudmail %s list` to find one", kind)
}

// pathSegment rejects a value that would change the shape of the URL rather than
// filling a slot in it.
//
// url.PathEscape handles slashes, but a segment that is empty or is "." or ".."
// still resolves somewhere unintended, and for a DELETE the unintended target
// could be the collection rather than the member.
func pathSegment(kind, v string) (string, error) {
	t := strings.TrimSpace(v)
	if t == "" {
		return "", fail.Usagef("the %s cannot be empty", kind)
	}
	if t == "." || t == ".." {
		return "", fail.Usagef("%q is not a valid %s", v, kind)
	}
	if strings.ContainsAny(t, "\x00\n\r") {
		return "", fail.Usagef("the %s contains a control character", kind)
	}
	return t, nil
}

// intOrDefault is a small readability helper for optional numeric flags.
func intOrDefault(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

var _ = fmt.Sprintf // retained for future path helpers
