package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// Scheduled sends, inbound rules, sender lists, signatures, templates and
// sequences: everything that acts on mail without a person present.

// ── Scheduled sends ────────────────────────────────────────────────

// ListScheduled returns messages waiting to go out.
//
// Expect to see a message here for roughly 30 seconds after any ordinary send:
// the deployment routes every send through this queue so Undo can work.
func (c *Client) ListScheduled(ctx context.Context, mailbox string) ([]ScheduledSend, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out []ScheduledSend
	if err := c.get(ctx, mailboxPath(mailbox, "scheduled-sends"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ScheduleOptions are the scheduling fields, sent alongside a SendRequest.
type ScheduleOptions struct {
	// SendAt is an ISO-8601 instant. Exactly one of SendAt and DelaySeconds.
	SendAt       string
	DelaySeconds int

	// ReplyToEmailID and ThreadedMode turn a scheduled send into a scheduled
	// reply or forward of an existing message.
	ReplyToEmailID string
	ThreadedMode   string // "reply" or "forward"

	// SupersedesDraftID removes a draft once the scheduled message is queued, so
	// scheduling from a draft does not leave the draft behind.
	SupersedesDraftID string
}

// Schedule queues a message for later.
func (c *Client) Schedule(
	ctx context.Context, mailbox string, send *SendRequest, opt ScheduleOptions,
) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := send.Validate(); err != nil {
		return nil, err
	}
	if (opt.SendAt == "") == (opt.DelaySeconds <= 0) {
		return nil, fail.Usagef("scheduling needs exactly one of --at or --in").
			WithRemediation("try --at 2026-09-01T09:00:00Z, or --in 2h")
	}
	if opt.ThreadedMode != "" && opt.ThreadedMode != "reply" && opt.ThreadedMode != "forward" {
		return nil, fail.Usagef("unknown threaded mode %q", opt.ThreadedMode).
			WithRemediation("use reply or forward")
	}
	if opt.ThreadedMode != "" && opt.ReplyToEmailID == "" {
		return nil, fail.Usagef("--threaded-mode needs --reply-to").
			WithRemediation("name the message being replied to or forwarded")
	}

	// The route parses the send body and the schedule fields as two separate
	// schemas from one JSON object, so they are merged here rather than nested.
	body, err := mergeJSON(send, scheduleFields(opt))
	if err != nil {
		return nil, err
	}

	var out json.RawMessage
	_, err = c.mutate(ctx, Request{
		Method: "POST",
		Path:   mailboxPath(mailbox, "scheduled-sends"),
		Keyed:  true,
		Body:   body,
		// Not idempotent: a retry would queue a second copy.
		Idempotent: false,
		Reversible: true,
		Note:       "queued; cancel before it leaves with `cloudmail schedule cancel <id>`",
	}, &out)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func scheduleFields(o ScheduleOptions) map[string]any {
	m := map[string]any{}
	if o.SendAt != "" {
		m["send_at"] = o.SendAt
	}
	if o.DelaySeconds > 0 {
		m["delay_seconds"] = o.DelaySeconds
	}
	if o.ReplyToEmailID != "" {
		m["reply_to_email_id"] = o.ReplyToEmailID
	}
	if o.ThreadedMode != "" {
		m["threaded_mode"] = o.ThreadedMode
	}
	if o.SupersedesDraftID != "" {
		m["supersedes_draft_id"] = o.SupersedesDraftID
	}
	return m
}

// mergeJSON flattens a struct and a map into one object. Used where a route
// parses two schemas from a single body.
func mergeJSON(a any, b map[string]any) (json.RawMessage, error) {
	raw, err := json.Marshal(a)
	if err != nil {
		return nil, fail.Errf("cannot encode the request: %v", err).Wrap(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fail.Errf("cannot merge the request: %v", err).Wrap(err)
	}
	for k, v := range b {
		m[k] = v
	}
	out, err := json.Marshal(m)
	if err != nil {
		return nil, fail.Errf("cannot encode the request: %v", err).Wrap(err)
	}
	return out, nil
}

// CancelScheduled stops a queued message. This is also how a just-sent message is
// recalled, within the roughly 30-second window.
func (c *Client) CancelScheduled(ctx context.Context, mailbox, emailID string) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", emailID); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       mailboxPath(mailbox, "scheduled-sends", emailID),
		Idempotent: true,
		Reversible: false,
		Note:       "the message will not be sent; this cannot be un-cancelled",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// SendScheduledNow sends a queued message immediately.
func (c *Client) SendScheduledNow(ctx context.Context, mailbox, emailID string) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", emailID); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "scheduled-sends", emailID, "send-now"),
		Keyed:      true,
		Idempotent: false,
		Reversible: false,
		Note:       "sends immediately, skipping the remaining delay. Mail cannot be recalled",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// DeliveryEvents returns what happened to an outbound message after it left.
func (c *Client) DeliveryEvents(ctx context.Context, mailbox, emailID string) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", emailID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	if err := c.get(ctx, mailboxPath(mailbox, "emails", emailID, "delivery-events"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ── Inbound rules ──────────────────────────────────────────────────

// Rule vocabulary, mirroring the Worker's schemas. Exposed so the command layer
// can validate locally and list the options in --help rather than making a user
// discover them through 400s.
var (
	RuleFields    = []string{"from", "to", "cc", "recipient", "subject", "body", "has_attachment"}
	RuleOperators = []string{"contains", "not_contains", "equals", "starts_with",
		"ends_with", "domain_is", "is_true"}
	RuleActions = []string{"move_to_folder", "apply_label", "mark_read", "star",
		"trash", "set_priority", "skip_auto_draft"}
	RuleMatchTypes = []string{"all", "any"}
)

// ListRules returns the inbound filter rules in the order they run.
func (c *Client) ListRules(ctx context.Context, mailbox string) ([]Rule, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out []Rule
	if err := c.get(ctx, mailboxPath(mailbox, "rules"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// RuleInput is the body for creating or updating a rule.
type RuleInput struct {
	Name       string          `json:"name,omitempty"`
	Enabled    *bool           `json:"enabled,omitempty"`
	MatchType  string          `json:"match_type,omitempty"`
	Conditions []RuleCondition `json:"conditions,omitempty"`
	Actions    []RuleAction    `json:"actions,omitempty"`
}

// Validate checks a rule against the vocabulary the server enforces.
func (r *RuleInput) Validate(requireBody bool) error {
	if r.MatchType != "" && !contains(RuleMatchTypes, r.MatchType) {
		return fail.Usagef("unknown match type %q", r.MatchType).
			WithRemediation("use all or any")
	}
	for i, c := range r.Conditions {
		if !contains(RuleFields, c.Field) {
			return fail.Usagef("condition %d tests unknown field %q", i+1, c.Field).
				WithRemediation("choose one of: %s", strings.Join(RuleFields, ", "))
		}
		if !contains(RuleOperators, c.Operator) {
			return fail.Usagef("condition %d uses unknown operator %q", i+1, c.Operator).
				WithRemediation("choose one of: %s", strings.Join(RuleOperators, ", "))
		}
		// is_true is the only operator that takes no value: it tests a boolean
		// field like has_attachment.
		if c.Operator != "is_true" && strings.TrimSpace(c.Value) == "" {
			return fail.Usagef("condition %d needs a value", i+1).
				WithRemediation("write it as field:operator:value, e.g. subject:contains:invoice")
		}
	}
	for i, a := range r.Actions {
		if !contains(RuleActions, a.Type) {
			return fail.Usagef("action %d is unknown: %q", i+1, a.Type).
				WithRemediation("choose one of: %s", strings.Join(RuleActions, ", "))
		}
		needsValue := a.Type == "move_to_folder" || a.Type == "apply_label" || a.Type == "set_priority"
		if needsValue && strings.TrimSpace(a.Value) == "" {
			return fail.Usagef("action %q needs a value", a.Type).
				WithRemediation("write it as type:value, e.g. move_to_folder:archive")
		}
	}
	if requireBody {
		if len(r.Conditions) == 0 {
			return fail.Usagef("a rule needs at least one condition").
				WithRemediation("add --if subject:contains:invoice")
		}
		if len(r.Actions) == 0 {
			return fail.Usagef("a rule needs at least one action").
				WithRemediation("add --then move_to_folder:archive")
		}
	}
	return nil
}

// CreateRule adds an inbound rule.
func (c *Client) CreateRule(ctx context.Context, mailbox string, in RuleInput) (*Rule, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := in.Validate(true); err != nil {
		return nil, err
	}
	var out Rule
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "rules"),
		Body:       in,
		Idempotent: false,
		Reversible: true,
		Note:       "applies to mail arriving from now on, not to existing messages",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateRule changes a rule.
func (c *Client) UpdateRule(ctx context.Context, mailbox, id string, in RuleInput) (*Rule, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("rule", id); err != nil {
		return nil, err
	}
	if err := in.Validate(false); err != nil {
		return nil, err
	}
	var out Rule
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       mailboxPath(mailbox, "rules", id),
		Body:       in,
		Idempotent: true,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteRule removes a rule.
func (c *Client) DeleteRule(ctx context.Context, mailbox, id string) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("rule", id); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       mailboxPath(mailbox, "rules", id),
		Idempotent: true,
		Reversible: false,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ReorderRules sets the order rules run in. Order matters: the first matching
// rule's actions can stop later ones from seeing the message.
func (c *Client) ReorderRules(ctx context.Context, mailbox string, ids []string) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	ids = dedupe(ids)
	if len(ids) == 0 {
		return nil, fail.Usagef("no rule ids given").
			WithRemediation("pass every rule id in the order you want; " +
				"see the current order with `cloudmail rule list`")
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "rules", "reorder"),
		Body:       map[string]any{"ids": ids},
		Idempotent: true,
		Reversible: true,
		Note:       "rules run in this order, and an earlier rule can pre-empt a later one",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ── Sender lists ───────────────────────────────────────────────────

// ListSenders returns the blocked or allowed sender list. Kind is "blocked" or
// "allowed".
func (c *Client) ListSenders(ctx context.Context, mailbox, kind string) ([]SenderPattern, error) {
	p, err := senderPath(mailbox, kind)
	if err != nil {
		return nil, err
	}
	var out []SenderPattern
	if err := c.get(ctx, p, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AddSender adds a pattern to a sender list.
func (c *Client) AddSender(
	ctx context.Context, mailbox, kind, pattern, reason string,
) (*SenderPattern, error) {
	p, err := senderPath(mailbox, kind)
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(pattern)) < 3 {
		return nil, fail.Usagef("the pattern %q is too short", pattern).
			WithRemediation("give at least 3 characters, e.g. an address or a domain")
	}
	body := map[string]any{"pattern": pattern}
	if reason != "" {
		body["reason"] = reason
	}
	note := "blocks matching senders from now on"
	if kind == "allowed" {
		note = "exempts matching senders from spam filtering. " +
			"An explicit block still wins over an allow"
	}
	var out SenderPattern
	_, err = c.mutate(ctx, Request{
		Method:     "POST",
		Path:       p,
		Body:       body,
		Idempotent: false,
		Reversible: true,
		Note:       note,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveSender deletes an entry from a sender list.
func (c *Client) RemoveSender(ctx context.Context, mailbox, kind, id string) (*StatusResult, error) {
	p, err := senderPath(mailbox, kind)
	if err != nil {
		return nil, err
	}
	if err := requireID("sender", id); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err = c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       p + "/" + id,
		Idempotent: true,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func senderPath(mailbox, kind string) (string, error) {
	if err := requireMailbox(mailbox); err != nil {
		return "", err
	}
	switch kind {
	case "blocked":
		return mailboxPath(mailbox, "blocked-senders"), nil
	case "allowed":
		return mailboxPath(mailbox, "allowed-senders"), nil
	default:
		return "", fail.Usagef("unknown sender list %q", kind).
			WithRemediation("use blocked or allowed")
	}
}

// ── Signatures ─────────────────────────────────────────────────────

// ListSignatures returns the mailbox's signatures.
func (c *Client) ListSignatures(ctx context.Context, mailbox string) ([]Signature, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out []Signature
	if err := c.get(ctx, mailboxPath(mailbox, "signatures"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DefaultSignature returns the signature used when none is chosen.
func (c *Client) DefaultSignature(ctx context.Context, mailbox string) (*Signature, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out Signature
	if err := c.get(ctx, mailboxPath(mailbox, "signatures", "default"), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateSignature adds a signature.
func (c *Client) CreateSignature(
	ctx context.Context, mailbox, name, bodyHTML string, isDefault bool,
) (*Signature, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if strings.TrimSpace(name) == "" {
		return nil, fail.Usagef("a signature needs a name")
	}
	if strings.TrimSpace(bodyHTML) == "" {
		return nil, fail.Usagef("a signature needs a body").
			WithRemediation("pass --body-html, or --body-file to read it from a file")
	}
	body := map[string]any{"name": name, "body_html": bodyHTML}
	if isDefault {
		body["is_default"] = true
	}
	var out Signature
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "signatures"),
		Body:       body,
		Idempotent: false,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateSignature changes a signature.
func (c *Client) UpdateSignature(
	ctx context.Context, mailbox, id, name, bodyHTML string, isDefault *bool,
) (*Signature, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("signature", id); err != nil {
		return nil, err
	}
	body := map[string]any{}
	if name != "" {
		body["name"] = name
	}
	if bodyHTML != "" {
		body["body_html"] = bodyHTML
	}
	if isDefault != nil {
		body["is_default"] = *isDefault
	}
	if len(body) == 0 {
		return nil, fail.Usagef("nothing to change").
			WithRemediation("pass --name, --body-html or --default")
	}
	var out Signature
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       mailboxPath(mailbox, "signatures", id),
		Body:       body,
		Idempotent: true,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteSignature removes a signature.
func (c *Client) DeleteSignature(ctx context.Context, mailbox, id string) (*StatusResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("signature", id); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       mailboxPath(mailbox, "signatures", id),
		Idempotent: true,
		Reversible: false,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ── Templates ──────────────────────────────────────────────────────

// ListTemplates returns every template. Templates are deployment-wide, not
// per-mailbox.
func (c *Client) ListTemplates(ctx context.Context) ([]Template, error) {
	var out []Template
	if err := c.get(ctx, path("templates"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetTemplate returns one template by slug.
func (c *Client) GetTemplate(ctx context.Context, slug string) (*Template, error) {
	if err := requireID("template", slug); err != nil {
		return nil, err
	}
	var out Template
	if err := c.get(ctx, path("templates", slug), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateTemplate adds a template.
func (c *Client) CreateTemplate(ctx context.Context, t Template) (*Template, error) {
	if err := validateSlug(t.Slug); err != nil {
		return nil, err
	}
	if strings.TrimSpace(t.Name) == "" {
		return nil, fail.Usagef("a template needs a name")
	}
	if strings.TrimSpace(t.BodyHTML) == "" {
		return nil, fail.Usagef("a template needs a body").
			WithRemediation("pass --body-html, or --body-file to read it from a file")
	}
	var out Template
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       path("templates"),
		Body:       t,
		Idempotent: false,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateTemplate changes a template. Every field is optional.
func (c *Client) UpdateTemplate(ctx context.Context, slug string, t Template) (*Template, error) {
	if err := requireID("template", slug); err != nil {
		return nil, err
	}
	body := map[string]any{}
	if t.Name != "" {
		body["name"] = t.Name
	}
	if t.Subject != "" {
		body["subject"] = t.Subject
	}
	if t.BodyHTML != "" {
		body["bodyHtml"] = t.BodyHTML
	}
	if len(body) == 0 {
		return nil, fail.Usagef("nothing to change").
			WithRemediation("pass --name, --subject or --body-html")
	}
	var out Template
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       path("templates", slug),
		Body:       body,
		Idempotent: true,
		Reversible: true,
		Note:       "sequences referring to this template will use the new content",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteTemplate removes a template.
func (c *Client) DeleteTemplate(ctx context.Context, slug string) (*StatusResult, error) {
	if err := requireID("template", slug); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       path("templates", slug),
		Idempotent: true,
		Reversible: false,
		Note:       "any sequence step referring to this slug will stop working",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func validateSlug(s string) error {
	if s == "" {
		return fail.Usagef("a template needs a slug").
			WithRemediation("use lowercase letters, digits and hyphens, e.g. welcome-email")
	}
	if s[0] == '-' {
		return fail.Usagef("the slug %q cannot start with a hyphen", s)
	}
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-'
		if !ok {
			return fail.Usagef("the slug %q may only contain lowercase letters, digits and hyphens", s).
				WithRemediation("try %q", strings.ToLower(strings.NewReplacer(
					" ", "-", "_", "-", ".", "-").Replace(s)))
		}
	}
	return nil
}

// ── Sequences ──────────────────────────────────────────────────────

// ListSequences returns every sequence.
func (c *Client) ListSequences(ctx context.Context) ([]Sequence, error) {
	var out []Sequence
	if err := c.get(ctx, path("sequences"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetSequence returns one sequence.
func (c *Client) GetSequence(ctx context.Context, id string) (*Sequence, error) {
	if err := requireID("sequence", id); err != nil {
		return nil, err
	}
	var out Sequence
	if err := c.get(ctx, path("sequences", id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateSequence adds a sequence.
func (c *Client) CreateSequence(ctx context.Context, name string, steps []SequenceStep) (*Sequence, error) {
	if strings.TrimSpace(name) == "" {
		return nil, fail.Usagef("a sequence needs a name")
	}
	if err := validateSteps(steps); err != nil {
		return nil, err
	}
	var out Sequence
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       path("sequences"),
		Body:       map[string]any{"name": name, "steps": steps},
		Idempotent: false,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateSequence changes a sequence.
func (c *Client) UpdateSequence(
	ctx context.Context, id, name string, steps []SequenceStep,
) (*Sequence, error) {
	if err := requireID("sequence", id); err != nil {
		return nil, err
	}
	body := map[string]any{}
	if name != "" {
		body["name"] = name
	}
	if len(steps) > 0 {
		if err := validateSteps(steps); err != nil {
			return nil, err
		}
		body["steps"] = steps
	}
	if len(body) == 0 {
		return nil, fail.Usagef("nothing to change").
			WithRemediation("pass --name or --step")
	}
	var out Sequence
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       path("sequences", id),
		Body:       body,
		Idempotent: true,
		Reversible: true,
		Note:       "people already enrolled follow the amended steps from here on",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteSequence removes a sequence.
func (c *Client) DeleteSequence(ctx context.Context, id string) (*StatusResult, error) {
	if err := requireID("sequence", id); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       path("sequences", id),
		Idempotent: true,
		Reversible: false,
		Note:       "enrolled people stop receiving the remaining steps",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func validateSteps(steps []SequenceStep) error {
	if len(steps) == 0 {
		return fail.Usagef("a sequence needs at least one step").
			WithRemediation("add --step welcome-email:0 " +
				"(template slug, then the delay in hours)")
	}
	if len(steps) > 50 {
		return fail.Usagef("a sequence takes at most 50 steps, got %d", len(steps))
	}
	for i, s := range steps {
		if s.TemplateSlug == "" {
			return fail.Usagef("step %d names no template", i+1)
		}
		if s.DelayHours < 0 || s.DelayHours > 8760 {
			return fail.Usagef("step %d has a delay of %d hours", i+1, s.DelayHours).
				WithRemediation("delays run from 0 to 8760 hours (one year)")
		}
	}
	return nil
}

// EnrollInput is the body for enrolling someone in a sequence.
type EnrollInput struct {
	PersonID       string            `json:"personId"`
	PersonEmail    string            `json:"personEmail"`
	PersonName     string            `json:"personName,omitempty"`
	FromAddress    string            `json:"fromAddress"`
	Variables      map[string]string `json:"variables,omitempty"`
	SkipSteps      []int             `json:"skipSteps,omitempty"`
	DelayOverrides map[string]int    `json:"delayOverrides,omitempty"`
}

// Enroll adds a person to a sequence.
//
// The cron dispatcher sends these later with no caller attached, so the server
// checks the caller's authority over FromAddress at enrollment time. A 403 here
// means the grant on that address is missing, not that the sequence is wrong.
func (c *Client) Enroll(ctx context.Context, sequenceID string, in EnrollInput) (json.RawMessage, error) {
	if err := requireID("sequence", sequenceID); err != nil {
		return nil, err
	}
	if err := validateAddress(in.PersonEmail); err != nil {
		return nil, err
	}
	if err := validateAddress(in.FromAddress); err != nil {
		return nil, err
	}
	if in.PersonID == "" {
		// The person id and the address are the same thing in practice, and
		// defaulting it saves the caller a lookup they cannot usefully do.
		in.PersonID = in.PersonEmail
	}
	var out json.RawMessage
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       path("sequences", sequenceID, "enroll"),
		Keyed:      true,
		Body:       in,
		Idempotent: false,
		Reversible: true,
		Note: fmt.Sprintf(
			"queues the sequence's steps to be sent from %s over the coming hours",
			in.FromAddress),
	}, &out)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// SequenceEnrollments lists who is enrolled in a sequence.
func (c *Client) SequenceEnrollments(ctx context.Context, sequenceID string) (json.RawMessage, error) {
	if err := requireID("sequence", sequenceID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	if err := c.get(ctx, path("sequences", sequenceID, "enrollments"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PersonEnrollment reports one person's progress, with the messages still queued.
func (c *Client) PersonEnrollment(ctx context.Context, personID string) (json.RawMessage, error) {
	if err := requireID("person", personID); err != nil {
		return nil, err
	}
	var out json.RawMessage
	if err := c.get(ctx, path("sequences", "people", personID, "enrollment"), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Unenroll removes someone from a sequence, cancelling their queued steps.
func (c *Client) Unenroll(ctx context.Context, enrollmentID string) (*StatusResult, error) {
	if err := requireID("enrollment", enrollmentID); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       path("sequences", "enrollments", enrollmentID),
		Idempotent: true,
		Reversible: false,
		Note:       "cancels the steps this person had not yet received",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
