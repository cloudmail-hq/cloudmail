package api

import (
	"context"
	"fmt"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// Message reading, sending and organising: the operations that make up the bulk
// of what anyone, human or agent, does with a mailbox.

// ListOptions filters and pages a message listing.
type ListOptions struct {
	Mailbox  string
	Folder   string
	ThreadID string
	// Threaded collapses a folder listing to one row per conversation. The
	// Worker only honours it together with a folder.
	Threaded bool

	Page  int
	Limit int

	SortColumn    string
	SortDirection string

	// Tri-state filters: nil omits the parameter. See Query.Bool.
	Unread        *bool
	Starred       *bool
	HasAttachment *bool
}

// ListEmails returns messages from a folder.
func (c *Client) ListEmails(ctx context.Context, o ListOptions) (*EmailList, error) {
	if err := requireMailbox(o.Mailbox); err != nil {
		return nil, err
	}
	if o.Threaded && o.Folder == "" {
		// The Worker silently ignores threaded without a folder, which would
		// hand back a flat list and look like a bug in this CLI.
		return nil, fail.Usagef("--threaded needs a folder").
			WithRemediation("add --folder inbox")
	}
	if err := validateSort(o.SortColumn, o.SortDirection); err != nil {
		return nil, err
	}

	q := NewQuery().
		Str("folder", o.Folder).
		Str("thread_id", o.ThreadID).
		Int("page", o.Page).
		Int("limit", o.Limit).
		Str("sortColumn", o.SortColumn).
		Str("sortDirection", strings.ToUpper(o.SortDirection)).
		Bool("unread", o.Unread).
		Bool("starred", o.Starred).
		Bool("has_attachment", o.HasAttachment)
	q.Flag("threaded", o.Threaded)

	var out EmailList
	if err := c.get(ctx, mailboxPath(o.Mailbox, "emails"), q, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SortColumns are the orderings the mailbox understands.
var SortColumns = []string{"date", "subject", "sender", "recipient", "read", "starred", "priority"}

// SortDirections are the two orderings.
var SortDirections = []string{"asc", "desc"}

func validateSort(col, dir string) error {
	if col != "" && !contains(SortColumns, col) {
		return fail.Usagef("cannot sort by %q", col).
			WithRemediation("choose one of: %s", strings.Join(SortColumns, ", "))
	}
	if dir != "" && !contains(SortDirections, strings.ToLower(dir)) {
		return fail.Usagef("unknown sort direction %q", dir).
			WithRemediation("use asc or desc")
	}
	return nil
}

// GetEmail returns one message with its body and attachment list.
func (c *Client) GetEmail(ctx context.Context, mailbox, id string) (*Email, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", id); err != nil {
		return nil, err
	}
	var out Email
	if err := c.get(ctx, mailboxPath(mailbox, "emails", id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SearchEmails runs the mailbox's full-text search.
//
// The query string is passed through untouched: the Worker parses the Gmail-style
// grammar itself (shared/search-query.ts), and any escaping done here would break
// operators the server supports. A malformed query degrades to a free-text search
// server-side rather than erroring, so there is nothing to validate locally.
func (c *Client) SearchEmails(
	ctx context.Context, mailbox, query, folder string, page, limit int,
) (*EmailList, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if strings.TrimSpace(query) == "" {
		return nil, fail.Usagef("no search query given").
			WithRemediation(`try a word, or an operator such as ` +
				`'from:alice@example.com is:unread' -- see ` + "`cloudmail mail search --help`")
	}
	q := NewQuery().
		Str("query", query).
		Str("folder", folder).
		Int("page", page).
		Int("limit", limit)

	var out EmailList
	if err := c.get(ctx, mailboxPath(mailbox, "search"), q, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Recipients is a to/cc/bcc field. The Worker accepts a single address or an
// array; this always sends an array, which both shapes of the schema accept and
// which keeps the wire form predictable for anyone reading a --dry-run preview.
type Recipients []string

// From is a sender: an address, optionally with a display name.
type From struct {
	Email string `json:"email"`
	Name  string `json:"name"`
}

// SendRequest is the body for send, reply, forward and schedule.
type SendRequest struct {
	To      Recipients `json:"to"`
	CC      Recipients `json:"cc,omitempty"`
	BCC     Recipients `json:"bcc,omitempty"`
	From    any        `json:"from"`
	Subject string     `json:"subject"`

	// HTML and Text: the server requires at least one. Sending both is normal
	// and lets a client render either.
	HTML string `json:"html,omitempty"`
	Text string `json:"text,omitempty"`

	Attachments []AttachmentPayload `json:"attachments,omitempty"`

	InReplyTo  string   `json:"in_reply_to,omitempty"`
	References []string `json:"references,omitempty"`
	ThreadID   string   `json:"thread_id,omitempty"`

	// Track, when set to false, sends this message without open/click
	// tracking. Nil follows the mailbox setting, so it is omitted from the body.
	Track *bool `json:"track,omitempty"`
}

// Validate catches locally what the server would reject, so a mistake costs no
// round trip and the error names the flag rather than the JSON field.
func (r *SendRequest) Validate() error {
	if len(r.To) == 0 {
		return fail.Usagef("no recipient given").
			WithRemediation("add --to someone@example.com (repeatable)")
	}
	if r.HTML == "" && r.Text == "" {
		return fail.Usagef("the message has no body").
			WithRemediation("add --text, --html, --body-file, or pipe the body on stdin")
	}
	if r.From == nil || r.From == "" {
		return fail.Usagef("no sender given").
			WithRemediation("the mailbox address is used by default; " +
				"pass --from to override, or --from-name to add a display name")
	}
	for _, addr := range append(append(Recipients{}, r.To...), append(r.CC, r.BCC...)...) {
		if err := validateAddress(addr); err != nil {
			return err
		}
	}
	for i, a := range r.Attachments {
		if a.Filename == "" {
			return fail.Usagef("attachment %d has no filename", i+1)
		}
		if a.Disposition != "attachment" && a.Disposition != "inline" {
			return fail.Usagef("attachment %q has disposition %q", a.Filename, a.Disposition).
				WithRemediation("use attachment or inline")
		}
	}
	return nil
}

// validateAddress does the cheap structural check, not a full RFC 5322 parse.
//
// The server validates properly; the point here is to catch the common typo
// before spending a request, and to refuse the control characters that would let
// a crafted argument inject a header.
func validateAddress(addr string) error {
	t := strings.TrimSpace(addr)
	if t == "" {
		return fail.Usagef("an empty address was given")
	}
	if strings.ContainsAny(t, "\r\n\x00") {
		// A newline in an address is how header injection starts. The server
		// would reject it, but refusing here means a malicious argument never
		// reaches the network at all.
		return fail.Usagef("the address %q contains a line break", addr).
			WithRemediation("addresses must be a single line; " +
				"pass multiple recipients as repeated --to flags")
	}
	at := strings.IndexByte(t, '@')
	if at <= 0 || at == len(t)-1 || strings.Count(t, "@") != 1 {
		return fail.Usagef("%q does not look like an email address", addr).
			WithRemediation("use the form name@example.com")
	}
	if strings.Contains(t, " ") {
		return fail.Usagef("the address %q contains a space", addr).
			WithRemediation("pass a bare address; use --from-name for a display name")
	}
	return nil
}

// Send sends a message.
//
// Not idempotent, and marked so: if the response is lost in transit the message
// may already be on its way, and a retry would deliver it twice. Duplicate mail
// is worse than a failed command, because only one of the two can be undone.
func (c *Client) Send(ctx context.Context, mailbox string, body *SendRequest) (*SendResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := body.Validate(); err != nil {
		return nil, err
	}
	var out SendResult
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "emails"),
		Keyed:      true,
		Body:       body,
		Idempotent: false,
		Reversible: false,
		Note: "the deployment holds outbound mail for about 30 seconds before it " +
			"leaves, so `cloudmail schedule cancel <id>` can still stop it",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Reply replies to a message. Threading headers are derived server-side from the
// original, so InReplyTo, References and ThreadID on the request are ignored.
func (c *Client) Reply(
	ctx context.Context, mailbox, emailID string, body *SendRequest,
) (*SendResult, error) {
	return c.replyOrForward(ctx, mailbox, emailID, "reply", body)
}

// Forward forwards a message.
func (c *Client) Forward(
	ctx context.Context, mailbox, emailID string, body *SendRequest,
) (*SendResult, error) {
	return c.replyOrForward(ctx, mailbox, emailID, "forward", body)
}

func (c *Client) replyOrForward(
	ctx context.Context, mailbox, emailID, verb string, body *SendRequest,
) (*SendResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", emailID); err != nil {
		return nil, err
	}
	if err := body.Validate(); err != nil {
		return nil, err
	}
	var out SendResult
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "emails", emailID, verb),
		Keyed:      true,
		Body:       body,
		Idempotent: false,
		Reversible: false,
		Note: fmt.Sprintf(
			"threading is derived from the original message, so in-reply-to and "+
				"references are set by the server; %s also marks the thread read", verb),
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// SetFlags updates the read and starred flags on a message. Both are pointers so
// a caller can change one without asserting the other.
func (c *Client) SetFlags(
	ctx context.Context, mailbox, id string, read, starred *bool,
) (*Email, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", id); err != nil {
		return nil, err
	}
	if read == nil && starred == nil {
		return nil, fail.Usagef("nothing to change").
			WithRemediation("pass --read, --unread, --star or --unstar")
	}
	body := map[string]any{}
	if read != nil {
		body["read"] = *read
	}
	if starred != nil {
		body["starred"] = *starred
	}
	var out Email
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       mailboxPath(mailbox, "emails", id),
		Body:       body,
		Idempotent: true,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete moves a message to Trash, or destroys it when permanent is set.
//
// The two are one route on the wire but two different acts: the first is
// reversible with `mail restore`, the second is not and needs the
// deletePermanently capability.
func (c *Client) Delete(
	ctx context.Context, mailbox, id string, permanent bool,
) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", id); err != nil {
		return nil, err
	}
	q := NewQuery()
	q.Flag("permanent", permanent)

	note := "moves the message to Trash; `cloudmail mail restore` puts it back"
	if permanent {
		note = "destroys the message irrecoverably; there is no undo"
	}
	var out StatusResult
	resp, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       mailboxPath(mailbox, "emails", id),
		Query:      q.Values(),
		Idempotent: true,
		Reversible: !permanent,
		Note:       note,
	}, &out)
	if err != nil {
		return nil, err
	}
	// A permanent delete answers 204 with no body, so synthesise the status the
	// caller expects rather than returning an empty struct that reads as failure.
	if resp.Preview == nil && out.Status == "" {
		out.Status = "destroyed"
		if !permanent {
			out.Status = "trashed"
		}
	}
	return &out, nil
}

// Restore returns a trashed message to the folder it came from.
func (c *Client) Restore(ctx context.Context, mailbox, id string) (*StatusResult, error) {
	return c.emailAction(ctx, mailbox, id, "restore", nil, true,
		"returns the message to the folder it was deleted from")
}

// NotSpam reclassifies a message the spam filter caught.
func (c *Client) NotSpam(ctx context.Context, mailbox, id string) (*StatusResult, error) {
	return c.emailAction(ctx, mailbox, id, "not-spam", nil, true,
		"moves the message out of Spam and teaches the filter")
}

// Move files a message into a folder.
func (c *Client) Move(ctx context.Context, mailbox, id, folderID string) (*StatusResult, error) {
	if strings.TrimSpace(folderID) == "" {
		return nil, fail.Usagef("no destination folder given").
			WithRemediation("pass --to-folder; list folders with `cloudmail folder list`")
	}
	return c.emailAction(ctx, mailbox, id, "move",
		map[string]any{"folderId": folderID}, true,
		fmt.Sprintf("files the message into %q", folderID))
}

// EmptyTrash destroys everything in Trash.
func (c *Client) EmptyTrash(ctx context.Context, mailbox string) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "trash", "empty"),
		Idempotent: true,
		Reversible: false,
		Note:       "destroys every message in Trash irrecoverably",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// MarkAllRead clears unread across a folder or a label.
func (c *Client) MarkAllRead(ctx context.Context, mailbox, folder, labelID string) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	body := map[string]any{}
	if folder != "" {
		body["folder"] = folder
	}
	if labelID != "" {
		body["label_id"] = labelID
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "mark-all-read"),
		Body:       body,
		Idempotent: true,
		Reversible: false,
		Note:       "unread state is not recorded per message, so this cannot be undone",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Snooze hides a message until a time. Exactly one of until or delaySeconds must
// be given; the server enforces it and so does this, since the error is clearer
// before the request than after.
func (c *Client) Snooze(
	ctx context.Context, mailbox, id, until string, delaySeconds int,
) (*StatusResult, error) {
	if (until == "") == (delaySeconds <= 0) {
		return nil, fail.Usagef("snooze needs exactly one of --until or --for").
			WithRemediation("try --until 2026-09-01T09:00:00Z, or --for 4h")
	}
	body := map[string]any{}
	if until != "" {
		body["until"] = until
	} else {
		body["delay_seconds"] = delaySeconds
	}
	return c.emailAction(ctx, mailbox, id, "snooze", body, true,
		"hides the message until the given time, then returns it to the inbox")
}

// Unsnooze cancels a snooze.
func (c *Client) Unsnooze(ctx context.Context, mailbox, id string) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", id); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       mailboxPath(mailbox, "emails", id, "snooze"),
		Idempotent: true,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ListSnoozed returns messages currently hidden.
func (c *Client) ListSnoozed(ctx context.Context, mailbox string) ([]Email, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out EmailList
	if err := c.get(ctx, mailboxPath(mailbox, "snoozed"), nil, &out); err != nil {
		return nil, err
	}
	return out.Emails, nil
}

// Priorities are the values `mail priority` accepts. The empty string clears it,
// which the Worker models as an explicit null.
var Priorities = []string{"high", "low", "none"}

// SetPriority raises or lowers a message, or clears the marking with "none".
func (c *Client) SetPriority(ctx context.Context, mailbox, id, priority string) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", id); err != nil {
		return nil, err
	}
	if !contains(Priorities, priority) {
		return nil, fail.Usagef("unknown priority %q", priority).
			WithRemediation("use high, low, or none to clear it")
	}
	// "none" is spelled null on the wire: the column is nullable and the Worker's
	// schema accepts high | low | null.
	var value any
	if priority != "none" {
		value = priority
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       mailboxPath(mailbox, "emails", id, "priority"),
		Body:       map[string]any{"priority": value},
		Idempotent: true,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// emailAction is the shared shape of the small POST routes hanging off a message.
func (c *Client) emailAction(
	ctx context.Context, mailbox, id, action string, body any, reversible bool, note string,
) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", id); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "emails", id, action),
		Body:       body,
		Idempotent: true,
		Reversible: reversible,
		Note:       note,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ── Bulk ───────────────────────────────────────────────────────────

// BulkActions are the operations `mail bulk` accepts.
var BulkActions = []string{
	"read", "unread", "star", "unstar",
	"delete", "delete_permanently", "restore",
	"move", "label", "unlabel",
}

// BulkLimit is the most ids the Worker accepts in one call. Requests are chunked
// to this size rather than refused, because "you gave me 640 ids, give me fewer"
// is work the caller should not have to do.
const BulkLimit = 500

// BulkResult is the outcome of one chunk.
type BulkResult struct {
	Action    string `json:"action"`
	Requested int    `json:"requested"`
	Updated   *int   `json:"updated,omitempty"`
	Failed    *int   `json:"failed,omitempty"`
	Status    string `json:"status,omitempty"`
}

// Bulk applies one action to many messages, chunked to BulkLimit.
//
// Reported per chunk so a partial failure is visible: if the third of four
// chunks is rate-limited, the caller needs to know the first two applied rather
// than assuming the whole call was atomic. It never was.
func (c *Client) Bulk(
	ctx context.Context, mailbox, action string, ids []string, folderID, labelID string,
) ([]BulkResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if !contains(BulkActions, action) {
		return nil, fail.Usagef("unknown bulk action %q", action).
			WithRemediation("choose one of: %s", strings.Join(BulkActions, ", "))
	}
	ids = dedupe(ids)
	if len(ids) == 0 {
		return nil, fail.Usagef("no message ids given").
			WithRemediation("pass ids as arguments, or pipe them on stdin with --ids-from -")
	}
	switch action {
	case "move":
		if folderID == "" {
			return nil, fail.Usagef("bulk move needs a destination").
				WithRemediation("pass --to-folder; list folders with `cloudmail folder list`")
		}
	case "label", "unlabel":
		if labelID == "" {
			return nil, fail.Usagef("bulk %s needs a label", action).
				WithRemediation("pass --label; list labels with `cloudmail label list`")
		}
	}

	reversible := action != "delete_permanently"
	var results []BulkResult

	for _, chunk := range chunkStrings(ids, BulkLimit) {
		body := map[string]any{"action": action, "ids": chunk}
		if action == "move" {
			body["folder_id"] = folderID
		}
		if action == "label" || action == "unlabel" {
			body["label_id"] = labelID
		}

		var out BulkResult
		resp, err := c.mutate(ctx, Request{
			Method:     "POST",
			Path:       mailboxPath(mailbox, "emails", "bulk"),
			Body:       body,
			Idempotent: true,
			Reversible: reversible,
			Note: fmt.Sprintf("applies %s to %d message(s)%s",
				action, len(chunk), map[bool]string{true: "", false: " -- irrecoverably"}[reversible]),
		}, &out)
		if err != nil {
			// Return what already succeeded alongside the error: discarding it
			// would leave the caller unable to tell which ids still need work.
			if len(results) > 0 {
				return results, err
			}
			return nil, err
		}
		out.Action = action
		out.Requested = len(chunk)
		if resp.Preview != nil {
			out.Status = "dry-run"
		}
		results = append(results, out)
	}
	return results, nil
}

func chunkStrings(in []string, size int) [][]string {
	var out [][]string
	for len(in) > size {
		out = append(out, in[:size])
		in = in[size:]
	}
	if len(in) > 0 {
		out = append(out, in)
	}
	return out
}

func dedupe(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		t := strings.TrimSpace(s)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}
