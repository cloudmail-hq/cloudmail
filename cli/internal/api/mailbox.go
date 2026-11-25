package api

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// Mailbox-level and deployment-level operations.

// Whoami reports the caller's identity and what they may reach.
//
// The most useful first call for anything automated: it answers "am I
// authenticated", "which mailboxes can I touch" and "what may I do in them" in
// one request, so a caller can plan instead of discovering limits through 403s.
func (c *Client) Whoami(ctx context.Context) (*Identity, error) {
	var out Identity
	if err := c.get(ctx, path("me"), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeploymentConfig reports the domains and addresses this deployment serves.
func (c *Client) DeploymentConfig(ctx context.Context) (*Config, error) {
	var out Config
	if err := c.get(ctx, path("config"), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListMailboxes returns the mailboxes the caller can reach, optionally narrowed
// to one domain. The server already filters by grant, so an empty result means
// "you have none", not "there are none".
func (c *Client) ListMailboxes(ctx context.Context, domain string) ([]Mailbox, error) {
	q := NewQuery().Str("domain", domain)
	var out []Mailbox
	if err := c.get(ctx, path("mailboxes"), q, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetMailbox returns one mailbox with its settings.
func (c *Client) GetMailbox(ctx context.Context, id string) (*Mailbox, error) {
	if err := requireMailbox(id); err != nil {
		return nil, err
	}
	var out Mailbox
	if err := c.get(ctx, path("mailboxes", id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateMailbox adds a mailbox. Administrator only, and the address must be on a
// domain the deployment serves.
func (c *Client) CreateMailbox(
	ctx context.Context, email, name string, settings json.RawMessage,
) (*Mailbox, error) {
	if err := validateAddress(email); err != nil {
		return nil, err
	}
	if strings.TrimSpace(name) == "" {
		name = email
	}
	body := map[string]any{"email": email, "name": name}
	if len(settings) > 0 {
		body["settings"] = settings
	}
	var out Mailbox
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       path("mailboxes"),
		Keyed:      true,
		Body:       body,
		Idempotent: false,
		Reversible: true,
		Note: "administrator only. The address must be on a domain this deployment " +
			"serves, and Email Routing must point at the Worker for mail to arrive",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateMailboxSettings patches a mailbox's settings.
//
// The server merges the patch into the existing settings, so a partial object is
// safe and a caller does not have to read-modify-write. That is worth stating
// because the opposite assumption would silently clear every field left out.
func (c *Client) UpdateMailboxSettings(
	ctx context.Context, id string, settings json.RawMessage,
) (*Mailbox, error) {
	if err := requireMailbox(id); err != nil {
		return nil, err
	}
	if len(settings) == 0 {
		return nil, fail.Usagef("no settings given").
			WithRemediation("pass --settings '{...}' or --settings-file settings.json; " +
				"see current values with `cloudmail mailbox get --output json`")
	}
	if !json.Valid(settings) {
		return nil, fail.Usagef("the settings are not valid JSON")
	}
	var out Mailbox
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       path("mailboxes", id),
		Body:       map[string]any{"settings": settings},
		Idempotent: true,
		Reversible: true,
		Note: "merged into the existing settings, so omitted fields keep their " +
			"current values. Note that forwarding.email redirects all incoming mail",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteMailbox destroys a mailbox, its messages, and its audit log.
func (c *Client) DeleteMailbox(ctx context.Context, id string) (*StatusResult, error) {
	if err := requireMailbox(id); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       path("mailboxes", id),
		Idempotent: true,
		Reversible: false,
		Note: "destroys the mailbox, every message in it, and its audit log. " +
			"The address is also stripped from every access grant that named it",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// MailboxStateVersion returns the mailbox's change counter.
//
// Cheap enough to poll. Intended for a script that wants to react to new mail
// without listing messages on a timer: watch this, and only list when it moves.
func (c *Client) MailboxStateVersion(ctx context.Context, mailbox string) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out json.RawMessage
	if err := c.get(ctx, mailboxPath(mailbox, "state"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// MailboxAudit returns the mailbox's access log. Needs manageSettings.
func (c *Client) MailboxAudit(ctx context.Context, mailbox string, limit int) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	q := NewQuery().Int("limit", limit)
	var out json.RawMessage
	if err := c.get(ctx, mailboxPath(mailbox, "audit"), q, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ExportMailbox streams the whole mailbox as mbox.
//
// Returns the bytes rather than a reader because the route is paged server-side
// and the client has already buffered the response. For a very large mailbox the
// 8 MiB response ceiling in attempt() applies, so this is a convenience for
// ordinary mailboxes rather than a backup tool for enormous ones.
func (c *Client) ExportMailbox(ctx context.Context, mailbox string) ([]byte, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	resp, err := c.Do(ctx, Request{
		Method:     "GET",
		Path:       mailboxPath(mailbox, "export"),
		Idempotent: true,
		Headers:    map[string]string{"Accept": "*/*"},
	})
	if err != nil {
		return nil, err
	}
	return resp.Bytes, nil
}

// ── People and analytics ───────────────────────────────────────────

// ListPeople returns correspondents aggregated across every reachable mailbox.
func (c *Client) ListPeople(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	if err := c.get(ctx, path("people"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PersonEmails returns the mail exchanged with one correspondent.
func (c *Client) PersonEmails(ctx context.Context, person string, page, limit int) (*EmailList, error) {
	if err := requireID("person", person); err != nil {
		return nil, err
	}
	q := NewQuery().Int("page", page).Int("limit", limit)
	var out EmailList
	if err := c.get(ctx, path("people", person, "emails"), q, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Analytics returns the send-outcome rollup over a window of days.
func (c *Client) Analytics(ctx context.Context, days int) (*Analytics, error) {
	q := NewQuery().Int("days", days)
	var out Analytics
	if err := c.get(ctx, path("analytics"), q, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SentAnalytics returns the per-mailbox send rollup. The server clamps days to
// 1..90.
func (c *Client) SentAnalytics(ctx context.Context, days int) (json.RawMessage, error) {
	q := NewQuery().Int("days", days)
	var out json.RawMessage
	if err := c.get(ctx, path("analytics", "sent"), q, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AnalyticsOptions are the query parameters the analytics console routes take.
// Days is 1, 7, 30 or 90 (the server defaults others to 7); Scope is "app" or
// "zone" (zone is administrator-only).
type AnalyticsOptions struct {
	Days    int
	Scope   string
	Domain  string
	Mailbox string
	Refresh bool
}

// AnalyticsSection reads one analytics console section: "overview",
// "engagement", "inbound" or "dmarc". The shapes are documented in the
// OpenAPI spec (shared/analytics-types.ts on the server).
func (c *Client) AnalyticsSection(ctx context.Context, section string, opts AnalyticsOptions) (json.RawMessage, error) {
	if err := requireID("section", section); err != nil {
		return nil, err
	}
	q := NewQuery().
		Int("days", opts.Days).
		Str("scope", opts.Scope).
		Str("domain", opts.Domain).
		Str("mailbox", opts.Mailbox).
		Flag("refresh", opts.Refresh)
	var out json.RawMessage
	if err := c.get(ctx, path("analytics", section), q, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ── Access grants (administrator) ──────────────────────────────────

// ListAccess returns the grant table and the role vocabulary the Worker enforces.
func (c *Client) ListAccess(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	if err := c.get(ctx, path("access"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AccessAudit returns the deployment-wide access log.
func (c *Client) AccessAudit(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	if err := c.get(ctx, path("access", "audit"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PutAccess replaces the grant table.
//
// A whole-table write, not a patch: the route takes the complete set. That makes
// it easy to lock people out by sending a partial table, which is why this is
// flagged irreversible and the command layer requires confirmation.
func (c *Client) PutAccess(ctx context.Context, grants json.RawMessage) (json.RawMessage, error) {
	if len(grants) == 0 || !json.Valid(grants) {
		return nil, fail.Usagef("the grants payload is not valid JSON").
			WithRemediation("read the current table with " +
				"`cloudmail access list --output json`, edit it, and pass it back")
	}
	var out json.RawMessage
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       path("access"),
		Body:       grants,
		Idempotent: true,
		Reversible: false,
		Note: "replaces the entire grant table. Anyone absent from the payload " +
			"loses access, so send the full table rather than a patch",
	}, &out)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// RevokeAccess removes one principal's grant. Kind is "email" or "service".
func (c *Client) RevokeAccess(ctx context.Context, kind, id string) error {
	if kind != "email" && kind != "service" {
		return fail.Usagef("unknown principal kind %q", kind).
			WithRemediation("use email or service")
	}
	if err := requireID("principal", id); err != nil {
		return err
	}
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       path("access", kind, id),
		Idempotent: true,
		Reversible: false,
		Note:       "revokes every mailbox this principal could reach",
	}, nil)
	return err
}
