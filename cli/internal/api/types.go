package api

import "encoding/json"

// Wire types mirroring workers/lib/schemas.ts and the Drizzle schema in
// workers/db/schema.ts.
//
// Pointer and omitempty choices are deliberate. The Worker distinguishes a field
// that is absent from one that is explicitly null -- a label's parent_id, a
// message's priority -- and collapsing the two would turn "leave this alone"
// into "clear this". Where the distinction matters the field is a pointer.

// Email is one message. It covers both the metadata shape returned by list
// routes and the full shape returned by GET /emails/:id; the body-bearing fields
// are simply absent in the former.
type Email struct {
	ID        string `json:"id"`
	Subject   string `json:"subject"`
	Sender    string `json:"sender"`
	Recipient string `json:"recipient"`
	CC        string `json:"cc,omitempty"`
	BCC       string `json:"bcc,omitempty"`
	Date      string `json:"date"`
	Read      bool   `json:"read"`
	Starred   bool   `json:"starred"`

	InReplyTo string `json:"in_reply_to,omitempty"`
	// References is `email_references` on the wire: the Worker renamed it to
	// avoid colliding with SQL's REFERENCES keyword.
	References string `json:"email_references,omitempty"`
	ThreadID   string `json:"thread_id,omitempty"`
	FolderID   string `json:"folder_id,omitempty"`
	Snippet    string `json:"snippet,omitempty"`

	Body        string       `json:"body,omitempty"`
	MessageID   string       `json:"message_id,omitempty"`
	RawHeaders  string       `json:"raw_headers,omitempty"`
	Attachments []Attachment `json:"attachments,omitempty"`

	Priority       string  `json:"priority,omitempty"`
	SnoozedUntil   string  `json:"snoozed_until,omitempty"`
	SpamScore      float64 `json:"spam_score,omitempty"`
	SpamSignals    string  `json:"spam_signals,omitempty"`
	DeliveryStatus string  `json:"delivery_status,omitempty"`
	DeliveryError  string  `json:"delivery_error,omitempty"`
	// Engagement cache for sent mail. "Opened" means the tracking image loaded,
	// which mail-privacy proxies can trigger; it is not proof of reading.
	OpenedAt       string `json:"opened_at,omitempty"`
	LastOpenedAt   string `json:"last_opened_at,omitempty"`
	OpenCount      int    `json:"open_count,omitempty"`
	OpenProxyCount int    `json:"open_proxy_count,omitempty"`
	ClickedAt      string `json:"clicked_at,omitempty"`
	ClickCount     int    `json:"click_count,omitempty"`
	TrashedAt      string `json:"trashed_at,omitempty"`
	TrashedFrom    string `json:"trashed_from,omitempty"`
}

// Attachment is one stored attachment.
type Attachment struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	Mimetype    string `json:"mimetype"`
	Size        int64  `json:"size"`
	ContentID   string `json:"content_id,omitempty"`
	Disposition string `json:"disposition,omitempty"`
	// Blocked marks a type the server will refuse to serve back.
	Blocked bool `json:"blocked,omitempty"`
}

// AttachmentPayload is one outbound attachment. Content is base64 with no
// `data:` prefix, matching AttachmentPayloadSchema.
type AttachmentPayload struct {
	Content     string `json:"content"`
	Filename    string `json:"filename"`
	Type        string `json:"type"`
	Disposition string `json:"disposition"`
	ContentID   string `json:"contentId,omitempty"`
}

// EmailList is the shape of a list response.
//
// The Worker returns `{emails, totalCount}` when a folder was named and a bare
// array otherwise. Normalising that here rather than at each call site means a
// command never has to know which route it hit. TotalCount is a pointer so
// "the server did not say" stays distinguishable from "zero".
type EmailList struct {
	Emails     []Email `json:"emails"`
	TotalCount *int    `json:"totalCount,omitempty"`
}

// UnmarshalJSON accepts both response shapes.
func (l *EmailList) UnmarshalJSON(b []byte) error {
	// Try the object form first: an array cannot be mistaken for it.
	var obj struct {
		Emails     []Email `json:"emails"`
		TotalCount *int    `json:"totalCount"`
	}
	if err := json.Unmarshal(b, &obj); err == nil && obj.Emails != nil {
		l.Emails, l.TotalCount = obj.Emails, obj.TotalCount
		return nil
	}
	var arr []Email
	if err := json.Unmarshal(b, &arr); err != nil {
		// Report against the documented shape rather than the array attempt,
		// which would be the more confusing of the two messages.
		return json.Unmarshal(b, &obj)
	}
	l.Emails, l.TotalCount = arr, nil
	return nil
}

// Mailbox is one mailbox.
type Mailbox struct {
	ID       string          `json:"id"`
	Email    string          `json:"email"`
	Name     string          `json:"name,omitempty"`
	Domain   string          `json:"domain,omitempty"`
	Settings json.RawMessage `json:"settings,omitempty"`
}

// Folder is a system or user folder. Folders are addressed by id, which for the
// built-ins is a lowercase name like "inbox" or "trash".
type Folder struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	IsDeletable *int   `json:"is_deletable,omitempty"`
}

// Label is a user label. Labels can nest via ParentID.
type Label struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Color     string  `json:"color,omitempty"`
	ParentID  *string `json:"parent_id,omitempty"`
	SortOrder *int    `json:"sort_order,omitempty"`
	CreatedAt string  `json:"created_at,omitempty"`
}

// Signature is a stored sending signature.
type Signature struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	BodyHTML  string `json:"body_html"`
	IsDefault *int   `json:"is_default,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

// ScheduledSend is a message waiting to go out. Every ordinary send passes
// through this table for roughly 30 seconds to make Undo possible, so a send
// that has just been issued will briefly appear here.
type ScheduledSend struct {
	EmailID   string `json:"email_id"`
	SendAt    string `json:"send_at"`
	Status    string `json:"status"`
	Attempts  int    `json:"attempts,omitempty"`
	LastError string `json:"last_error,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
	Subject   string `json:"subject,omitempty"`
	Recipient string `json:"recipient,omitempty"`
}

// SenderPattern is one entry on the blocked or allowed sender list.
type SenderPattern struct {
	ID        string `json:"id"`
	Pattern   string `json:"pattern"`
	Reason    string `json:"reason,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
}

// Rule is one inbound filter rule. Rules run in order; see `rule reorder`.
type Rule struct {
	ID         string          `json:"id"`
	Name       string          `json:"name,omitempty"`
	Enabled    *bool           `json:"enabled,omitempty"`
	MatchType  string          `json:"match_type,omitempty"`
	Conditions []RuleCondition `json:"conditions,omitempty"`
	Actions    []RuleAction    `json:"actions,omitempty"`
	SortOrder  *int            `json:"sort_order,omitempty"`
	CreatedAt  string          `json:"created_at,omitempty"`
}

// RuleCondition is one test a rule applies to an inbound message.
type RuleCondition struct {
	Field    string `json:"field"`
	Operator string `json:"operator"`
	Value    string `json:"value,omitempty"`
}

// RuleAction is one thing a rule does when it matches.
type RuleAction struct {
	Type  string `json:"type"`
	Value string `json:"value,omitempty"`
}

// Template is a reusable message body, shared across mailboxes.
type Template struct {
	Slug      string `json:"slug"`
	Name      string `json:"name"`
	Subject   string `json:"subject"`
	BodyHTML  string `json:"bodyHtml"`
	CreatedAt string `json:"createdAt,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}

// Sequence is an ordered set of templates sent on delays.
type Sequence struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Steps     []SequenceStep `json:"steps"`
	CreatedAt string         `json:"createdAt,omitempty"`
	UpdatedAt string         `json:"updatedAt,omitempty"`
}

// SequenceStep is one message in a sequence.
type SequenceStep struct {
	Order        int    `json:"order"`
	TemplateSlug string `json:"templateSlug"`
	DelayHours   int    `json:"delayHours"`
}

// Enrollment is one person's progress through a sequence.
type Enrollment struct {
	ID          string `json:"id"`
	SequenceID  string `json:"sequenceId,omitempty"`
	PersonID    string `json:"personId"`
	PersonEmail string `json:"personEmail"`
	PersonName  string `json:"personName,omitempty"`
	FromAddress string `json:"fromAddress"`
	Status      string `json:"status,omitempty"`
	CreatedAt   string `json:"createdAt,omitempty"`
}

// Identity is GET /api/v1/me: who the caller is and what they may do.
//
// Capabilities being nil means unrestricted -- an administrator, or a deployment
// with ADMIN_EMAILS unset. That is not the same as an empty list, which would
// mean a grant conferring nothing, so the field must stay a slice pointer.
type Identity struct {
	Role         string          `json:"role"`
	Mailboxes    []string        `json:"mailboxes"`
	Capabilities *[]MailboxGrant `json:"capabilities"`
	Enforced     bool            `json:"enforced"`
	Kind         string          `json:"kind,omitempty"`
	Email        string          `json:"email,omitempty"`
	Name         string          `json:"name,omitempty"`

	// Sent by deployments with built-in auth. AuthMode is "password" or
	// "access"; AuthMethod is how this request was authenticated, "token" for an
	// API token.
	AuthMode   string `json:"authMode,omitempty"`
	AuthMethod string `json:"authMethod,omitempty"`
	UserID     string `json:"userId,omitempty"`
	IsOwner    bool   `json:"isOwner,omitempty"`

	// Token is set when the request authenticated with a scoped API token.
	// Role, Mailboxes and Capabilities are then already the intersection of
	// the user's grants with the token's scopes and mailboxes.
	Token *TokenRestriction `json:"token,omitempty"`

	Extra map[string]any `json:"-"`
}

// TokenRestriction is the narrowing a scoped API token applies. Nil Scopes
// means every scope; nil Mailboxes means every mailbox the user can reach.
type TokenRestriction struct {
	ID        string    `json:"id"`
	Scopes    *[]string `json:"scopes"`
	Mailboxes *[]string `json:"mailboxes"`
}

// MailboxGrant is one mailbox the caller can reach, and how far.
type MailboxGrant struct {
	MailboxID    string   `json:"mailboxId"`
	Role         string   `json:"role,omitempty"`
	Capabilities []string `json:"capabilities"`
}

// Can reports whether this grant carries a capability.
func (g MailboxGrant) Can(capability string) bool {
	for _, c := range g.Capabilities {
		if c == capability {
			return true
		}
	}
	return false
}

// Unrestricted reports whether the caller is an administrator, for which the
// Worker sends a null capability list.
func (i Identity) Unrestricted() bool { return i.Capabilities == nil }

// Grant finds the caller's grant on one mailbox.
func (i Identity) Grant(mailbox string) (MailboxGrant, bool) {
	if i.Capabilities == nil {
		return MailboxGrant{}, false
	}
	var wildcard *MailboxGrant
	for idx, g := range *i.Capabilities {
		if g.MailboxID == mailbox {
			return g, true
		}
		if g.MailboxID == "*" {
			wildcard = &(*i.Capabilities)[idx]
		}
	}
	// A scoped token on an unrestricted user reports one "*" row: the same
	// capabilities on every mailbox.
	if wildcard != nil {
		g := *wildcard
		g.MailboxID = mailbox
		return g, true
	}
	return MailboxGrant{}, false
}

// Config is GET /api/v1/config: which domains and addresses this deployment
// serves.
type Config struct {
	Domains        []string        `json:"domains"`
	EmailAddresses []string        `json:"emailAddresses"`
	Zones          json.RawMessage `json:"zones,omitempty"`
}

// SendResult is the 202 body from a send, reply or forward: either the
// accepted message ({id, status:"sent"}) or, when the send was held for a
// person to approve, the PendingApproval fields. A held send has no id.
type SendResult struct {
	ID          string `json:"id,omitempty"`
	Status      string `json:"status"`
	ApprovalID  string `json:"approval_id,omitempty"`
	ApprovalURL string `json:"approval_url,omitempty"`
	ExpiresAt   string `json:"expires_at,omitempty"`
	Reason      string `json:"reason,omitempty"`
	Message     string `json:"message,omitempty"`
}

// StatusPendingApproval is the status of a send held for approval.
const StatusPendingApproval = "pending_approval"

// HeldSend is the PendingApproval body: nothing was sent, and a person must
// approve it at ApprovalURL. Every send route can answer with it.
type HeldSend struct {
	Status      string `json:"status"`
	ApprovalID  string `json:"approval_id"`
	ApprovalURL string `json:"approval_url"`
	ExpiresAt   string `json:"expires_at,omitempty"`
	Reason      string `json:"reason,omitempty"`
	Message     string `json:"message,omitempty"`
}

// AsHeldSend reports whether a send response is a hold. It accepts a
// *SendResult or the raw JSON some send routes return.
func AsHeldSend(v any) (*HeldSend, bool) {
	var h HeldSend
	switch r := v.(type) {
	case *SendResult:
		if r == nil || r.Status != StatusPendingApproval {
			return nil, false
		}
		h = HeldSend{Status: r.Status, ApprovalID: r.ApprovalID, ApprovalURL: r.ApprovalURL,
			ExpiresAt: r.ExpiresAt, Reason: r.Reason, Message: r.Message}
	case json.RawMessage:
		if len(r) == 0 || json.Unmarshal(r, &h) != nil || h.Status != StatusPendingApproval {
			return nil, false
		}
	default:
		return nil, false
	}
	return &h, true
}

// StatusResult is the small `{"status":"..."}` acknowledgement several routes
// return.
type StatusResult struct {
	Status  string `json:"status,omitempty"`
	Deleted *int   `json:"deleted,omitempty"`
	Success *bool  `json:"success,omitempty"`
}

// Person is one correspondent, aggregated across mailboxes.
type Person struct {
	ID       string `json:"id,omitempty"`
	Email    string `json:"email"`
	Name     string `json:"name,omitempty"`
	Count    int    `json:"count,omitempty"`
	LastSeen string `json:"lastSeen,omitempty"`
}

// Analytics is the send-outcome rollup.
type Analytics struct {
	Totals struct {
		Total     int `json:"total"`
		Delivered int `json:"delivered"`
		Failed    int `json:"failed"`
		Bounced   int `json:"bounced"`
		Pending   int `json:"pending"`
	} `json:"totals"`
	ByDate []struct {
		Date      string `json:"date"`
		Sent      int    `json:"sent"`
		Delivered int    `json:"delivered"`
		Failed    int    `json:"failed"`
	} `json:"byDate"`
	Mailboxes json.RawMessage `json:"mailboxes,omitempty"`
}

// MailboxState is the cheap change counter the UI polls. Useful in a script that
// wants to wait for new mail without hammering the list route.
type MailboxState struct {
	Version int64 `json:"version,omitempty"`
	Changes int64 `json:"changes,omitempty"`
	Count   int64 `json:"count,omitempty"`
	// Raw keeps whatever else the route returns, so a newer deployment adding a
	// field does not make this type lossy.
	Raw json.RawMessage `json:"-"`
}
