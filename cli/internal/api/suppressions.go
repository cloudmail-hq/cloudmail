package api

import (
	"context"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// Suppressions: the deployment-wide list of addresses that sequences, template
// sends and non-transactional API sends skip. Reading is open to any signed-in
// caller; changing it needs an administrator.

// Suppression is one entry on the list.
type Suppression struct {
	ID        string `json:"id"`
	Address   string `json:"address"`
	Scope     string `json:"scope"`
	Reason    string `json:"reason"`
	Source    string `json:"source"`
	CreatedAt int64  `json:"created_at"`
}

// SuppressionPage is one page of the list.
type SuppressionPage struct {
	Items  []Suppression `json:"items"`
	Total  int           `json:"total"`
	Limit  int           `json:"limit"`
	Offset int           `json:"offset"`
}

// SuppressionListOptions filters and pages the list.
type SuppressionListOptions struct {
	Query  string
	Scope  string
	Reason string
	Limit  int
	Offset int
}

// SuppressionAddResult reports how many entries were new.
type SuppressionAddResult struct {
	Added    int           `json:"added"`
	Existing int           `json:"existing"`
	Items    []Suppression `json:"items"`
}

// SuppressionImportResult reports a CSV import.
type SuppressionImportResult struct {
	Added      int `json:"added"`
	Existing   int `json:"existing"`
	Rows       int `json:"rows"`
	ErrorCount int `json:"errorCount"`
	Errors     []struct {
		Line  int    `json:"line"`
		Error string `json:"error"`
	} `json:"errors"`
}

// SuppressionReasons are the values the server accepts.
var SuppressionReasons = []string{"unsubscribed", "hard_bounce", "complaint", "manual"}

func validReason(r string) bool {
	for _, v := range SuppressionReasons {
		if v == r {
			return true
		}
	}
	return false
}

// ListSuppressions returns one page of the suppression list, newest first.
func (c *Client) ListSuppressions(ctx context.Context, opt SuppressionListOptions) (*SuppressionPage, error) {
	q := NewQuery().
		Str("q", opt.Query).
		Str("scope", opt.Scope).
		Str("reason", opt.Reason).
		Int("limit", opt.Limit)
	if opt.Offset > 0 {
		q.Int("offset", opt.Offset)
	}
	var out SuppressionPage
	if err := c.get(ctx, path("suppressions"), q, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AddSuppression adds one address. An empty scope means every sending domain.
func (c *Client) AddSuppression(ctx context.Context, address, scope, reason string) (*SuppressionAddResult, error) {
	address = strings.TrimSpace(address)
	if !strings.Contains(address, "@") {
		return nil, fail.Usagef("%q is not an email address", address)
	}
	if reason == "" {
		reason = "manual"
	}
	if !validReason(reason) {
		return nil, fail.Usagef("unknown reason %q", reason).
			WithRemediation("use one of %s", strings.Join(SuppressionReasons, ", "))
	}
	body := map[string]string{"address": address, "reason": reason}
	if scope != "" {
		body["scope"] = scope
	}
	var out SuppressionAddResult
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       path("suppressions"),
		Keyed:      true,
		Body:       body,
		Idempotent: true,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveSuppression deletes one entry by id.
func (c *Client) RemoveSuppression(ctx context.Context, id string) (*StatusResult, error) {
	if err := requireID("suppression", id); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       path("suppressions", id),
		Idempotent: true,
		Reversible: false,
		Note:       "the address will receive sequence and bulk mail again",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ImportSuppressions uploads a CSV: one address per line, or columns
// address,scope,reason with or without a header row.
func (c *Client) ImportSuppressions(ctx context.Context, csv, scope, reason string) (*SuppressionImportResult, error) {
	if strings.TrimSpace(csv) == "" {
		return nil, fail.Usagef("the import file is empty")
	}
	if reason != "" && !validReason(reason) {
		return nil, fail.Usagef("unknown reason %q", reason).
			WithRemediation("use one of %s", strings.Join(SuppressionReasons, ", "))
	}
	body := map[string]string{"csv": csv}
	if scope != "" {
		body["scope"] = scope
	}
	if reason != "" {
		body["reason"] = reason
	}
	var out SuppressionImportResult
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       path("suppressions", "import"),
		Body:       body,
		Idempotent: true,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
