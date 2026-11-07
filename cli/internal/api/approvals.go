package api

import (
	"context"
)

// ApprovalStatuses are the states a held send can be in, plus "all" for listing.
var ApprovalStatuses = []string{"pending", "sending", "sent", "sent_unconfirmed", "rejected", "failed", "all"}

// ApprovalRequester is who asked for a held send: the user, and which API token
// or connected app (OAuth client) the request came from.
type ApprovalRequester struct {
	User            *string `json:"user"`
	Via             string  `json:"via"`
	Method          *string `json:"method"`
	TokenID         *string `json:"tokenId"`
	TokenName       *string `json:"tokenName"`
	OAuthClientID   *string `json:"oauthClientId"`
	OAuthClientName *string `json:"oauthClientName"`
}

// HeldMessage is one message exactly as approving will send it (open and click
// tracking are added at send).
type HeldMessage struct {
	To          []string         `json:"to"`
	Cc          []string         `json:"cc"`
	Bcc         []string         `json:"bcc"`
	From        any              `json:"from"`
	Subject     string           `json:"subject"`
	HTML        *string          `json:"html"`
	Text        *string          `json:"text"`
	Attachments []map[string]any `json:"attachments"`
	SendAt      *string          `json:"send_at"`
	Bulk        bool             `json:"bulk"`
}

// Approval is an API-token, connected-app or agent send waiting for a person,
// as /api/v1/mailboxes/:id/approvals describes it.
type Approval struct {
	ID                  string            `json:"id"`
	Kind                string            `json:"kind"`
	Status              string            `json:"status"`
	Reason              string            `json:"reason"`
	Recipients          []string          `json:"recipients"`
	Subject             string            `json:"subject"`
	Messages            []HeldMessage     `json:"messages"`
	Note                *string           `json:"note"`
	Enrollment          map[string]any    `json:"enrollment"`
	TrackingAddedAtSend bool              `json:"tracking_added_at_send"`
	Editable            bool              `json:"editable"`
	RequestedBy         ApprovalRequester `json:"requested_by"`
	Result              map[string]any    `json:"result"`
	Error               *string           `json:"error"`
	DecidedBy           *string           `json:"decided_by"`
	CreatedAt           string            `json:"created_at"`
	DecidedAt           *string           `json:"decided_at"`
	ExpiresAt           string            `json:"expires_at"`
	// Revision is 1 when stored and +1 per edit or revision. Approve sends it
	// back so a version nobody has seen is never sent.
	Revision  int     `json:"revision"`
	RevisedAt *string `json:"revised_at"`
	// RevisedBy is "requester" when the asking credential revised its own send,
	// "reviewer" when a person edited it.
	RevisedBy *string `json:"revised_by"`
}

// ApprovalEdits change a pending single-message approval. The server re-runs
// the draft check on a new body and stores the result, which is then exactly
// what approving sends.
type ApprovalEdits struct {
	To      []string `json:"to,omitempty"`
	Cc      []string `json:"cc,omitempty"`
	Subject *string  `json:"subject,omitempty"`
	HTML    *string  `json:"html,omitempty"`
}

// Empty reports whether no edit was given.
func (e ApprovalEdits) Empty() bool {
	return len(e.To) == 0 && len(e.Cc) == 0 && e.Subject == nil && e.HTML == nil
}

// ApprovalOutcome is the response to approve, reject and retry.
type ApprovalOutcome struct {
	Approval Approval       `json:"approval"`
	Result   map[string]any `json:"result,omitempty"`
}

// ListApprovals returns a mailbox's held sends, newest first.
func (c *Client) ListApprovals(ctx context.Context, mailbox, status string, limit int) ([]Approval, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out struct {
		Approvals []Approval `json:"approvals"`
	}
	if err := c.get(ctx, mailboxPath(mailbox, "approvals"), NewQuery().Str("status", status).Int("limit", limit), &out); err != nil {
		return nil, err
	}
	return out.Approvals, nil
}

// GetApproval returns one held send with its full payload.
func (c *Client) GetApproval(ctx context.Context, mailbox, id string) (*Approval, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("approval", id); err != nil {
		return nil, err
	}
	var out struct {
		Approval Approval `json:"approval"`
	}
	if err := c.get(ctx, mailboxPath(mailbox, "approvals", id), nil, &out); err != nil {
		return nil, err
	}
	return &out.Approval, nil
}

// EditApproval saves changes to a pending held message and returns what will
// now be sent. Nothing is sent.
func (c *Client) EditApproval(ctx context.Context, mailbox, id string, edits ApprovalEdits) (*ApprovalOutcome, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("approval", id); err != nil {
		return nil, err
	}
	var out ApprovalOutcome
	_, err := c.mutate(ctx, Request{
		Method:     "PATCH",
		Path:       mailboxPath(mailbox, "approvals", id),
		Body:       edits,
		Idempotent: true,
		Note:       "replaces the held message; nothing is sent",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ApproveApproval sends a held message exactly as stored (edit it first with
// EditApproval). The server sends it at most once: approving again answers 409
// and sends nothing.
//
// revision is the version the caller reviewed. When it is positive the server
// refuses with 409 (and sends nothing) if the item was revised since, so a
// version nobody saw is never sent. Zero omits it.
func (c *Client) ApproveApproval(ctx context.Context, mailbox, id string, revision int) (*ApprovalOutcome, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("approval", id); err != nil {
		return nil, err
	}
	body := map[string]any{}
	if revision > 0 {
		body["revision"] = revision
	}
	var out ApprovalOutcome
	_, err := c.mutate(ctx, Request{
		Method: "POST",
		Path:   mailboxPath(mailbox, "approvals", id, "approve"),
		Body:   body,
		Keyed:  true,
		Note:   "sends the held message to its recipients",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ReviseApproval lets the credential that asked for a held send replace its own
// pending message. It takes the same edits as EditApproval, stays pending, and
// bumps the revision, so an approver holding the old revision is refused.
func (c *Client) ReviseApproval(ctx context.Context, mailbox, id string, edits ApprovalEdits) (*ApprovalOutcome, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("approval", id); err != nil {
		return nil, err
	}
	var out ApprovalOutcome
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "approvals", id, "revise"),
		Body:       edits,
		Idempotent: true,
		Note:       "replaces your own held message with a new revision; nothing is sent",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// RetryApproval puts a failed approved send back in the queue as pending. Only
// "failed" qualifies; a sent_unconfirmed send may have been delivered and is
// refused with 409.
func (c *Client) RetryApproval(ctx context.Context, mailbox, id string) (*ApprovalOutcome, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("approval", id); err != nil {
		return nil, err
	}
	var out ApprovalOutcome
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "approvals", id, "retry"),
		Body:       map[string]any{},
		Idempotent: true,
		Reversible: true,
		Note:       "puts the failed send back in the queue as pending; nothing is sent until it is approved",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// CountApprovals returns how many sends are waiting in a mailbox.
func (c *Client) CountApprovals(ctx context.Context, mailbox string) (int, error) {
	if err := requireMailbox(mailbox); err != nil {
		return 0, err
	}
	var out struct {
		Pending int `json:"pending"`
	}
	if err := c.get(ctx, mailboxPath(mailbox, "approvals", "count"), nil, &out); err != nil {
		return 0, err
	}
	return out.Pending, nil
}

// RejectApproval discards a held send. Nothing is sent.
func (c *Client) RejectApproval(ctx context.Context, mailbox, id, note string) (*ApprovalOutcome, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("approval", id); err != nil {
		return nil, err
	}
	body := map[string]any{}
	if note != "" {
		body["note"] = note
	}
	var out ApprovalOutcome
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "approvals", id, "reject"),
		Body:       body,
		Idempotent: true,
		Note:       "the held message is discarded; nothing is sent",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
