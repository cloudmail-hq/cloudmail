package api

import (
	"context"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// Agent inboxes: a mailbox minted for one automated agent, with an API token
// confined to it, a send policy and an optional expiry. Administrators only;
// a scoped token needs mailboxes:manage.

// AgentSendModes is the vocabulary the server accepts, in step with
// shared/agent-inboxes.ts. They match agent-safety's agent_send_mode.
var AgentSendModes = []string{"draft_only", "approve", "auto"}

// AgentInbox is one agent inbox as the server lists it. No secrets.
type AgentInbox struct {
	Address           string   `json:"address"`
	Purpose           string   `json:"purpose"`
	DisplayName       *string  `json:"display_name"`
	SendMode          string   `json:"send_mode"`
	AllowedRecipients []string `json:"allowed_recipients"`
	TokenID           *string  `json:"token_id"`
	Scopes            []string `json:"scopes"`
	WebhookID         *string  `json:"webhook_id"`
	WebhookURL        *string  `json:"webhook_url"`
	CreatedBy         *string  `json:"created_by"`
	CreatedAt         int64    `json:"created_at"`
	ExpiresAt         *int64   `json:"expires_at"`
	Expired           bool     `json:"expired"`
	ExpiresInMs       *int64   `json:"expires_in_ms"`
}

// AgentInboxInput creates one. Nil pointers and slices are omitted.
type AgentInboxInput struct {
	Domain            string   `json:"domain"`
	LocalPart         string   `json:"local_part,omitempty"`
	Purpose           string   `json:"purpose"`
	TTLHours          *float64 `json:"ttl_hours,omitempty"`
	AllowedRecipients []string `json:"allowed_recipients,omitempty"`
	SendMode          string   `json:"send_mode"`
	WebhookURL        string   `json:"webhook_url,omitempty"`
	DisplayName       string   `json:"display_name,omitempty"`
}

// AgentInboxCreated is the create response. Token.Secret and Webhook.Secret
// are shown once; an idempotent replay returns them as null.
type AgentInboxCreated struct {
	AgentInbox AgentInbox `json:"agent_inbox"`
	Address    string     `json:"address"`
	Token      struct {
		ID        string   `json:"id"`
		Secret    *string  `json:"secret"`
		Scopes    []string `json:"scopes"`
		Mailboxes []string `json:"mailboxes"`
		ExpiresAt *int64   `json:"expires_at"`
	} `json:"token"`
	Policy struct {
		SendMode          string   `json:"send_mode"`
		AllowedRecipients []string `json:"allowed_recipients"`
		TTLHours          *float64 `json:"ttl_hours"`
		ExpiresAt         *int64   `json:"expires_at"`
	} `json:"policy"`
	Webhook *struct {
		ID     string   `json:"id"`
		URL    string   `json:"url"`
		Events []string `json:"events"`
		Secret *string  `json:"secret"`
	} `json:"webhook"`
	Routing struct {
		Routed  bool    `json:"routed"`
		Source  string  `json:"source"`
		Warning *string `json:"warning"`
	} `json:"routing"`
	Warnings       []string `json:"warnings"`
	SecretRedacted bool     `json:"secret_redacted,omitempty"`
}

// AgentInboxEnded reports what ending one did.
type AgentInboxEnded struct {
	Address         string `json:"address"`
	TokenRevoked    bool   `json:"token_revoked"`
	WebhookDisabled bool   `json:"webhook_disabled"`
	Archive         *struct {
		Key       string `json:"key"`
		Messages  int    `json:"messages"`
		Truncated bool   `json:"truncated"`
	} `json:"archive"`
	MailboxDeleted bool `json:"mailbox_deleted"`
}

// ValidateAgentInboxInput checks what the server would reject, before sending.
func ValidateAgentInboxInput(in AgentInboxInput) error {
	if strings.TrimSpace(in.Domain) == "" {
		return fail.Usagef("an agent inbox needs a domain").WithRemediation("pass --domain, e.g. --domain example.com")
	}
	if strings.TrimSpace(in.Purpose) == "" {
		return fail.Usagef("an agent inbox needs a purpose").WithRemediation(`pass --purpose "what the agent does"`)
	}
	ok := false
	for _, m := range AgentSendModes {
		if in.SendMode == m {
			ok = true
		}
	}
	if !ok {
		return fail.Usagef("unknown send mode %q", in.SendMode).
			WithRemediation("use one of: %s", strings.Join(AgentSendModes, ", "))
	}
	if in.TTLHours != nil && (*in.TTLHours <= 0 || *in.TTLHours > 2160) {
		return fail.Usagef("--ttl-hours must be above 0 and at most 2160 (90 days)")
	}
	if in.WebhookURL != "" && !strings.HasPrefix(strings.ToLower(in.WebhookURL), "https://") {
		return fail.Usagef("webhook URLs must use https://")
	}
	return nil
}

// CreateAgentInbox mints a mailbox, a token and (optionally) a webhook.
func (c *Client) CreateAgentInbox(ctx context.Context, in AgentInboxInput) (*AgentInboxCreated, error) {
	if err := ValidateAgentInboxInput(in); err != nil {
		return nil, err
	}
	var out AgentInboxCreated
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       path("agent-inboxes"),
		Keyed:      true,
		Body:       in,
		Reversible: true,
		Note:       "creates a mailbox and an API token; the token secret is printed once",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ListAgentInboxes returns every agent inbox.
func (c *Client) ListAgentInboxes(ctx context.Context) ([]AgentInbox, error) {
	var out struct {
		AgentInboxes []AgentInbox `json:"agent_inboxes"`
	}
	if err := c.get(ctx, path("agent-inboxes"), nil, &out); err != nil {
		return nil, err
	}
	return out.AgentInboxes, nil
}

// GetAgentInbox returns one.
func (c *Client) GetAgentInbox(ctx context.Context, address string) (*AgentInbox, error) {
	if err := requireID("agent-inbox", address); err != nil {
		return nil, err
	}
	var out struct {
		AgentInbox AgentInbox `json:"agent_inbox"`
	}
	if err := c.get(ctx, path("agent-inboxes", address), nil, &out); err != nil {
		return nil, err
	}
	return &out.AgentInbox, nil
}

// UpdateAgentInbox changes or clears the optional recipient restriction. A nil
// slice clears it, so the inbox may send to anyone (the default); a list
// restricts it to those addresses and @domains.
func (c *Client) UpdateAgentInbox(ctx context.Context, address string, allowed []string) (*AgentInbox, error) {
	if err := requireID("agent-inbox", address); err != nil {
		return nil, err
	}
	var body map[string]any
	if allowed == nil {
		body = map[string]any{"allowed_recipients": nil}
	} else {
		body = map[string]any{"allowed_recipients": allowed}
	}
	var out struct {
		AgentInbox AgentInbox `json:"agent_inbox"`
	}
	_, err := c.mutate(ctx, Request{
		Method:     "PATCH",
		Path:       path("agent-inboxes", address),
		Body:       body,
		Idempotent: true,
		Reversible: true,
		Note:       "changes who the agent inbox may send to",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out.AgentInbox, nil
}

// DeleteAgentInbox ends one now: token revoked, webhook removed, mail archived
// to R2 as mbox, mailbox deleted.
func (c *Client) DeleteAgentInbox(ctx context.Context, address string) (*AgentInboxEnded, error) {
	if err := requireID("agent-inbox", address); err != nil {
		return nil, err
	}
	var out struct {
		Ended AgentInboxEnded `json:"ended"`
	}
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       path("agent-inboxes", address),
		Idempotent: true,
		Reversible: false,
		Note:       "revokes the token, archives the mail to R2 as mbox and deletes the mailbox",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out.Ended, nil
}
