package api

import (
	"context"
	"fmt"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// Drafts, threads, folders, labels and attachments: the operations that arrange
// a mailbox rather than adding to or removing from it.

// ── Drafts ─────────────────────────────────────────────────────────

// DraftRequest is the body for creating or amending a draft.
//
// The recipient fields are comma-joined strings here, not arrays, because the
// draft route stores what the composer had typed rather than a parsed list. A
// half-finished address must survive a save, so the server cannot validate this
// the way it validates a send.
type DraftRequest struct {
	To        string `json:"to,omitempty"`
	CC        string `json:"cc,omitempty"`
	BCC       string `json:"bcc,omitempty"`
	Subject   string `json:"subject,omitempty"`
	Body      string `json:"body"`
	InReplyTo string `json:"in_reply_to,omitempty"`
	ThreadID  string `json:"thread_id,omitempty"`

	// DraftID amends an existing draft. An unknown id creates a new draft rather
	// than failing, which is the server's behaviour and worth knowing: a typo
	// here produces a second draft, not an error.
	DraftID string `json:"draft_id,omitempty"`

	Attachments []AttachmentPayload `json:"attachments,omitempty"`
	// ReplaceAttachments discards the draft's existing attachments instead of
	// adding to them.
	ReplaceAttachments bool `json:"replace_attachments,omitempty"`
}

// SaveDraft creates or amends a draft.
func (c *Client) SaveDraft(ctx context.Context, mailbox string, body *DraftRequest) (*Email, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	// The server requires `body` to be present, though it may be empty. An
	// entirely absent body is a 400, so name the flag rather than let it be one.
	if body.Body == "" && body.Subject == "" && body.To == "" {
		return nil, fail.Usagef("the draft is empty").
			WithRemediation("give it at least a --body, --subject or --to")
	}

	note := "saves a new draft in the Drafts folder"
	if body.DraftID != "" {
		note = fmt.Sprintf("amends draft %s; an unknown id would create a new draft instead",
			body.DraftID)
	}
	if body.ReplaceAttachments {
		note += ". Existing attachments will be discarded"
	}

	var out Email
	_, err := c.mutate(ctx, Request{
		Method: "POST",
		Path:   mailboxPath(mailbox, "drafts"),
		Keyed:  true,
		Body:   body,
		// Amending a known draft is idempotent; creating one is not, because a
		// retry would leave two drafts behind.
		Idempotent: body.DraftID != "",
		Reversible: true,
		Note:       note,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ListDrafts returns the Drafts folder. There is no dedicated route: drafts are
// ordinary messages filed in a folder, and listing that folder is what the web
// UI does too.
func (c *Client) ListDrafts(ctx context.Context, mailbox string, page, limit int) (*EmailList, error) {
	return c.ListEmails(ctx, ListOptions{
		Mailbox: mailbox,
		Folder:  "drafts",
		Page:    page,
		Limit:   limit,
	})
}

// ── Threads ────────────────────────────────────────────────────────

// GetThread returns every message in a conversation.
func (c *Client) GetThread(ctx context.Context, mailbox, threadID, folder string) ([]Email, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("thread", threadID); err != nil {
		return nil, err
	}
	q := NewQuery().Str("folder", folder)
	var out EmailList
	if err := c.get(ctx, mailboxPath(mailbox, "threads", threadID), q, &out); err != nil {
		return nil, err
	}
	return out.Emails, nil
}

// MarkThreadRead clears unread across a whole conversation.
func (c *Client) MarkThreadRead(ctx context.Context, mailbox, threadID string) (*StatusResult, error) {
	return c.threadAction(ctx, mailbox, threadID, "POST", "read",
		"marks every message in the conversation read")
}

// MuteThread sends a conversation's later replies straight to Archive.
func (c *Client) MuteThread(ctx context.Context, mailbox, threadID string) (*StatusResult, error) {
	return c.threadAction(ctx, mailbox, threadID, "POST", "mute",
		"future replies in this conversation skip the inbox and go to Archive")
}

// UnmuteThread stops muting a conversation.
func (c *Client) UnmuteThread(ctx context.Context, mailbox, threadID string) (*StatusResult, error) {
	return c.threadAction(ctx, mailbox, threadID, "DELETE", "mute", "")
}

// ListMutedThreads returns the muted conversations.
func (c *Client) ListMutedThreads(ctx context.Context, mailbox string) ([]map[string]any, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out []map[string]any
	if err := c.get(ctx, mailboxPath(mailbox, "muted-threads"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) threadAction(
	ctx context.Context, mailbox, threadID, method, action, note string,
) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("thread", threadID); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     method,
		Path:       mailboxPath(mailbox, "threads", threadID, action),
		Idempotent: true,
		Reversible: true,
		Note:       note,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ── Folders ────────────────────────────────────────────────────────

// ListFolders returns the folder rail, system folders included.
func (c *Client) ListFolders(ctx context.Context, mailbox string) ([]Folder, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out []Folder
	if err := c.get(ctx, mailboxPath(mailbox, "folders"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateFolder adds a folder.
func (c *Client) CreateFolder(ctx context.Context, mailbox, name string) (*Folder, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if strings.TrimSpace(name) == "" {
		return nil, fail.Usagef("a folder needs a name")
	}
	var out Folder
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "folders"),
		Body:       map[string]any{"name": name},
		Idempotent: false,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// RenameFolder changes a folder's name.
func (c *Client) RenameFolder(ctx context.Context, mailbox, id, name string) (*Folder, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("folder", id); err != nil {
		return nil, err
	}
	if strings.TrimSpace(name) == "" {
		return nil, fail.Usagef("a folder needs a name")
	}
	var out Folder
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       mailboxPath(mailbox, "folders", id),
		Body:       map[string]any{"name": name},
		Idempotent: true,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteFolder removes a folder. The system folders are not deletable and the
// server refuses them.
func (c *Client) DeleteFolder(ctx context.Context, mailbox, id string) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("folder", id); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       mailboxPath(mailbox, "folders", id),
		Idempotent: true,
		Reversible: false,
		Note: "the folder's messages are affected by the deletion; " +
			"move anything you want to keep first",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ── Labels ─────────────────────────────────────────────────────────

// ListLabels returns every label.
func (c *Client) ListLabels(ctx context.Context, mailbox string) ([]Label, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out []Label
	if err := c.get(ctx, mailboxPath(mailbox, "labels"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// LabelInput is the body for creating or updating a label.
//
// Three states have to be expressible for the parent: leave it alone, set it to
// another label, and clear it so the label sits at the top level. A `*string` with
// `omitempty` can only express two -- a pointer to "" marshals as `""`, not as
// `null`, and the server reads those differently. So ClearParent is a separate
// field and the body is assembled as a map, where an explicit nil can be written.
type LabelInput struct {
	Name        string
	Color       string
	ParentID    *string
	ClearParent bool
	SortOrder   *int
}

// body renders the input as the JSON object the server expects, including an
// explicit null where the parent is being cleared.
func (in LabelInput) body() map[string]any {
	m := map[string]any{}
	if in.Name != "" {
		m["name"] = in.Name
	}
	if in.Color != "" {
		m["color"] = in.Color
	}
	switch {
	case in.ClearParent:
		m["parent_id"] = nil
	case in.ParentID != nil:
		m["parent_id"] = *in.ParentID
	}
	if in.SortOrder != nil {
		m["sort_order"] = *in.SortOrder
	}
	return m
}

// empty reports whether the input asks for no change at all.
func (in LabelInput) empty() bool { return len(in.body()) == 0 }

// CreateLabel adds a label.
func (c *Client) CreateLabel(ctx context.Context, mailbox string, in LabelInput) (*Label, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.Name) == "" {
		return nil, fail.Usagef("a label needs a name")
	}
	if err := validateHexColor(in.Color); err != nil {
		return nil, err
	}
	var out Label
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "labels"),
		Body:       in.body(),
		Idempotent: false,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateLabel changes a label.
func (c *Client) UpdateLabel(ctx context.Context, mailbox, id string, in LabelInput) (*Label, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("label", id); err != nil {
		return nil, err
	}
	if in.empty() {
		return nil, fail.Usagef("nothing to change").
			WithRemediation("pass --name, --color, --parent, --unnest or --sort-order")
	}
	if err := validateHexColor(in.Color); err != nil {
		return nil, err
	}
	var out Label
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       mailboxPath(mailbox, "labels", id),
		Body:       in.body(),
		Idempotent: true,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteLabel removes a label from the mailbox and from every message carrying it.
func (c *Client) DeleteLabel(ctx context.Context, mailbox, id string) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("label", id); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       mailboxPath(mailbox, "labels", id),
		Idempotent: true,
		Reversible: false,
		Note:       "the label is removed from every message that carried it",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ListLabelEmails returns the messages carrying one label, across folders.
func (c *Client) ListLabelEmails(
	ctx context.Context, mailbox, labelID string, page, limit int,
) (*EmailList, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("label", labelID); err != nil {
		return nil, err
	}
	q := NewQuery().Int("page", page).Int("limit", limit)
	var out EmailList
	if err := c.get(ctx, mailboxPath(mailbox, "labels", labelID, "emails"), q, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetEmailLabels returns the labels on one message.
func (c *Client) GetEmailLabels(ctx context.Context, mailbox, emailID string) ([]Label, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", emailID); err != nil {
		return nil, err
	}
	var out []Label
	if err := c.get(ctx, mailboxPath(mailbox, "emails", emailID, "labels"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SetEmailLabels replaces the label set on a message. An empty slice clears it,
// which is why this takes a slice rather than variadic strings: the difference
// between "no arguments" and "clear them all" has to be expressible.
func (c *Client) SetEmailLabels(
	ctx context.Context, mailbox, emailID string, labelIDs []string,
) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", emailID); err != nil {
		return nil, err
	}
	ids := dedupe(labelIDs)
	if ids == nil {
		ids = []string{} // marshal as [] rather than null
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       mailboxPath(mailbox, "emails", emailID, "labels"),
		Body:       map[string]any{"label_ids": ids},
		Idempotent: true,
		Reversible: true,
		Note:       fmt.Sprintf("replaces every label on the message with these %d", len(ids)),
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// AddEmailLabel adds one label to a message, leaving the others in place.
func (c *Client) AddEmailLabel(
	ctx context.Context, mailbox, emailID, labelID string,
) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", emailID); err != nil {
		return nil, err
	}
	if err := requireID("label", labelID); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "emails", emailID, "labels"),
		Body:       map[string]any{"label_id": labelID},
		Idempotent: true,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveEmailLabel takes one label off a message.
func (c *Client) RemoveEmailLabel(
	ctx context.Context, mailbox, emailID, labelID string,
) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", emailID); err != nil {
		return nil, err
	}
	if err := requireID("label", labelID); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       mailboxPath(mailbox, "emails", emailID, "labels", labelID),
		Idempotent: true,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func validateHexColor(c string) error {
	if c == "" {
		return nil
	}
	if !strings.HasPrefix(c, "#") || (len(c) != 4 && len(c) != 7) {
		return fail.Usagef("%q is not a hex colour", c).
			WithRemediation("use #rgb or #rrggbb, for example #6b7280")
	}
	for _, r := range c[1:] {
		if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
			return fail.Usagef("%q is not a hex colour", c).
				WithRemediation("use #rgb or #rrggbb, for example #6b7280")
		}
	}
	return nil
}

// ── Attachments ────────────────────────────────────────────────────

// DownloadAttachment fetches an attachment's bytes.
//
// Returns the raw payload rather than writing it, so the command layer decides
// between a file and stdout. The server refuses executable types with a 403
// carrying `blocked: true`; classify() turns that into an explanation rather than
// a bare permission error.
func (c *Client) DownloadAttachment(
	ctx context.Context, mailbox, emailID, attachmentID string,
) (data []byte, contentType string, err error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, "", err
	}
	if err := requireID("mail", emailID); err != nil {
		return nil, "", err
	}
	if err := requireID("attachment", attachmentID); err != nil {
		return nil, "", err
	}
	resp, err := c.Do(ctx, Request{
		Method: "GET",
		Path: mailboxPath(mailbox, "emails", emailID,
			"attachments", attachmentID),
		Idempotent: true,
		Headers:    map[string]string{"Accept": "*/*"},
	})
	if err != nil {
		return nil, "", err
	}
	return resp.Bytes, resp.Header.Get("Content-Type"), nil
}
