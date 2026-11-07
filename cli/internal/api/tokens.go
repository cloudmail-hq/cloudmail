package api

import (
	"context"
	"net/url"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// TokenScopes is every scope the Worker understands. Kept in step with
// shared/token-scopes.ts.
var TokenScopes = []string{
	"mail:read",
	"mail:send",
	"mail:send:auto",
	"approvals:manage",
	"mail:draft",
	"mail:organize",
	"mailboxes:manage",
	"domains:manage",
	"webhooks:manage",
	"admin",
}

// ValidTokenScope reports whether s is a known scope.
func ValidTokenScope(s string) bool {
	for _, v := range TokenScopes {
		if v == s {
			return true
		}
	}
	return false
}

// APIToken is one personal API token as /api/auth/tokens describes it. The
// secret is never part of it.
//
// Scopes and Mailboxes being nil means unrestricted -- a token that acts with
// its user's full access, which is every token minted before scopes existed.
type APIToken struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	CreatedAt  int64     `json:"createdAt"`
	LastUsedAt *int64    `json:"lastUsedAt"`
	LastUsedIP *string   `json:"lastUsedIp"`
	ExpiresAt  *int64    `json:"expiresAt"`
	Scopes     *[]string `json:"scopes"`
	Mailboxes  *[]string `json:"mailboxes"`
	ParentID   *string   `json:"parentId"`
}

// TokenInput is the body for creating a token.
type TokenInput struct {
	Name string
	// ExpiresInDays of 0 means no expiry.
	ExpiresInDays int
	// Nil means "not restricted" (or, from a scoped token, "same as mine").
	Scopes    []string
	Mailboxes []string
}

// CreatedToken is the 201 body: the token and its secret, shown once.
type CreatedToken struct {
	Token  APIToken `json:"token"`
	Secret string   `json:"secret"`
}

const tokensPath = "/api/auth/tokens"

// ListTokens returns the tokens the caller may see: every token of the user
// from a session or an unscoped token, or itself and its children from a scoped
// token.
func (c *Client) ListTokens(ctx context.Context) ([]APIToken, error) {
	var out struct {
		Tokens []APIToken `json:"tokens"`
	}
	if err := c.get(ctx, tokensPath, nil, &out); err != nil {
		return nil, err
	}
	return out.Tokens, nil
}

// CreateToken mints a token. From an API token this only works when the caller
// is itself scoped, and the new token can be no broader than the caller.
func (c *Client) CreateToken(ctx context.Context, in TokenInput) (*CreatedToken, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fail.Usagef("a token needs a name")
	}
	for _, s := range in.Scopes {
		if !ValidTokenScope(s) {
			return nil, fail.Usagef("unknown scope %q", s).
				WithRemediation("one of: %s", strings.Join(TokenScopes, ", "))
		}
	}
	body := map[string]any{"name": name}
	if in.ExpiresInDays > 0 {
		body["expiresInDays"] = in.ExpiresInDays
	} else {
		body["expiresInDays"] = nil
	}
	if in.Scopes != nil {
		body["scopes"] = in.Scopes
	}
	if in.Mailboxes != nil {
		body["mailboxes"] = in.Mailboxes
	}
	var out CreatedToken
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       tokensPath,
		Keyed:      true,
		Body:       body,
		Idempotent: false,
		Reversible: true,
		Note:       "the new token's secret is printed once",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// RevokeToken revokes a token, and every token it created.
func (c *Client) RevokeToken(ctx context.Context, id string) error {
	if err := requireID("token", id); err != nil {
		return err
	}
	seg, err := pathSegment("token id", id)
	if err != nil {
		return err
	}
	_, err = c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       tokensPath + "/" + url.PathEscape(seg),
		Idempotent: true,
		Reversible: false,
	}, nil)
	return err
}
