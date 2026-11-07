package api

import (
	"context"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// Followup is a "remind me if no reply" reminder on a sent message.
type Followup struct {
	EmailID         string  `json:"email_id"`
	ThreadID        string  `json:"thread_id"`
	FollowupAt      string  `json:"followup_at"`
	FollowupMode    string  `json:"followup_mode"`
	Status          string  `json:"status"`
	DurationSeconds int     `json:"duration_seconds,omitempty"`
	CreatedAt       string  `json:"created_at,omitempty"`
	FiredAt         *string `json:"fired_at,omitempty"`
	ResolvedAt      *string `json:"resolved_at,omitempty"`
	Subject         *string `json:"subject,omitempty"`
	Recipient       *string `json:"recipient,omitempty"`
	SentAt          *string `json:"sent_at,omitempty"`
}

// FollowupStatuses are the filters `followup list --status` accepts.
var FollowupStatuses = []string{"active", "pending", "fired"}

// ListFollowups returns sent mail awaiting a reply: fired reminders first,
// then pending ones by due date.
func (c *Client) ListFollowups(ctx context.Context, mailbox, status string) ([]Followup, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if status != "" && !contains(FollowupStatuses, status) {
		return nil, fail.Usagef("unknown status %q", status).
			WithRemediation("use active, pending or fired")
	}
	q := NewQuery().Str("status", status)
	var out struct {
		Followups []Followup `json:"followups"`
	}
	if err := c.get(ctx, mailboxPath(mailbox, "followups"), q, &out); err != nil {
		return nil, err
	}
	return out.Followups, nil
}

// SetFollowup sets or replaces the reminder on a sent message. Exactly one of
// at (ISO 8601) or delaySeconds.
func (c *Client) SetFollowup(
	ctx context.Context, mailbox, emailID, at string, delaySeconds int,
) (*Followup, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", emailID); err != nil {
		return nil, err
	}
	if (at == "") == (delaySeconds <= 0) {
		return nil, fail.Usagef("followup set needs exactly one of --at or --in").
			WithRemediation("try --in 3d, or --at 2026-11-02T09:00:00Z")
	}
	body := map[string]any{}
	if at != "" {
		body["at"] = at
	} else {
		body["delay_seconds"] = delaySeconds
	}
	var out Followup
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "emails", emailID, "followup"),
		Body:       body,
		Idempotent: true,
		Keyed:      true,
		Reversible: true,
		Note:       "returns the thread to the inbox if nobody replies by then",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// CancelFollowup cancels the active reminder on a message or its thread. A
// fired one is dismissed and its message goes back to the folder it came from.
func (c *Client) CancelFollowup(ctx context.Context, mailbox, emailID string) (*Followup, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", emailID); err != nil {
		return nil, err
	}
	var out Followup
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "emails", emailID, "followup", "cancel"),
		Idempotent: true,
		Keyed:      true,
		Reversible: true,
		Note:       "removes the reminder; set it again with followup set",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
