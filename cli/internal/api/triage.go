package api

import (
	"context"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// LabelPrompt is a label's AI triage settings.
type LabelPrompt struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Color       string  `json:"color,omitempty"`
	Prompt      *string `json:"prompt"`
	PresetKey   *string `json:"preset_key,omitempty"`
	AutoArchive bool    `json:"auto_archive"`
	ShowTab     bool    `json:"show_tab"`
}

// TriagePreset is one of the built-in founder presets.
type TriagePreset struct {
	Key         string  `json:"key"`
	Name        string  `json:"name"`
	Prompt      string  `json:"prompt"`
	Enabled     bool    `json:"enabled"`
	LabelID     *string `json:"label_id"`
	AutoArchive bool    `json:"auto_archive"`
	ShowTab     bool    `json:"show_tab"`
}

// LabelPrompts is the triage overview for a mailbox.
type LabelPrompts struct {
	Enabled           bool           `json:"enabled"`
	Screener          string         `json:"screener"`
	DailyAICap        int            `json:"daily_ai_cap"`
	AICallsToday      int            `json:"ai_calls_today"`
	Corrections       int            `json:"corrections"`
	BackfillRemaining int            `json:"backfill_remaining"`
	Labels            []LabelPrompt  `json:"labels"`
	Presets           []TriagePreset `json:"presets"`
}

// TriagePresetKeys are the presets `label prompt preset` accepts.
var TriagePresetKeys = []string{
	"customers", "billing", "investors", "vendors", "notifications", "newsletters", "cold_outreach",
}

// LabelPromptInput is a partial update. Nil fields are left alone.
type LabelPromptInput struct {
	Prompt      *string
	ClearPrompt bool
	AutoArchive *bool
	ShowTab     *bool
}

// ListLabelPrompts returns every label's prompt, the presets and today's AI usage.
func (c *Client) ListLabelPrompts(ctx context.Context, mailbox string) (*LabelPrompts, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out LabelPrompts
	if err := c.get(ctx, mailboxPath(mailbox, "label-prompts"), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetLabelPrompt sets a label's prompt, tab and auto-archive flags.
func (c *Client) SetLabelPrompt(ctx context.Context, mailbox, labelID string, in LabelPromptInput) (*LabelPrompt, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("label", labelID); err != nil {
		return nil, err
	}
	body := map[string]any{}
	if in.ClearPrompt {
		body["prompt"] = nil
	} else if in.Prompt != nil {
		p := strings.TrimSpace(*in.Prompt)
		if p == "" {
			return nil, fail.Usagef("a prompt cannot be empty").
				WithRemediation("use --clear to stop auto-labelling with this label")
		}
		if len(p) > 300 {
			return nil, fail.Usagef("a prompt is at most 300 characters")
		}
		body["prompt"] = p
	}
	if in.AutoArchive != nil {
		body["auto_archive"] = *in.AutoArchive
	}
	if in.ShowTab != nil {
		body["show_tab"] = *in.ShowTab
	}
	if len(body) == 0 {
		return nil, fail.Usagef("nothing to change").
			WithRemediation("give a prompt, --clear, --auto-archive or --tab")
	}
	var out LabelPrompt
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       mailboxPath(mailbox, "labels", labelID, "prompt"),
		Body:       body,
		Idempotent: true,
		Reversible: true,
		Note:       "applies to new mail; run `label prompt backfill` for recent mail",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// SetTriagePreset turns a preset on or off.
func (c *Client) SetTriagePreset(
	ctx context.Context, mailbox, key string, enabled bool, autoArchive, showTab *bool,
) (map[string]any, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if !contains(TriagePresetKeys, key) {
		return nil, fail.Usagef("unknown preset %q", key).
			WithRemediation("use one of %s", strings.Join(TriagePresetKeys, ", "))
	}
	body := map[string]any{"enabled": enabled}
	if autoArchive != nil {
		body["auto_archive"] = *autoArchive
	}
	if showTab != nil {
		body["show_tab"] = *showTab
	}
	var out map[string]any
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       mailboxPath(mailbox, "triage", "presets", key),
		Body:       body,
		Idempotent: true,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// BackfillResult is one bounded backfill step.
type BackfillResult struct {
	Processed  int  `json:"processed"`
	Classified int  `json:"classified"`
	Remaining  int  `json:"remaining"`
	Capped     bool `json:"capped"`
}

// BackfillTriage classifies one batch (1-25) of the last 14 days' mail.
func (c *Client) BackfillTriage(ctx context.Context, mailbox string, limit int) (*BackfillResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if limit < 0 || limit > 25 {
		return nil, fail.Usagef("--batch is between 1 and 25")
	}
	body := map[string]any{}
	if limit > 0 {
		body["limit"] = limit
	}
	var out BackfillResult
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "triage", "backfill"),
		Body:       body,
		Idempotent: true,
		Reversible: true,
		Note:       "labels recent mail; counts against the daily AI cap",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ScreenerSender is one sender waiting in the Screener.
type ScreenerSender struct {
	Sender           string  `json:"sender"`
	SenderName       *string `json:"sender_name"`
	Count            int     `json:"count"`
	Unread           int     `json:"unread"`
	LatestDate       string  `json:"latest_date"`
	LatestSubject    *string `json:"latest_subject"`
	LatestID         string  `json:"latest_id"`
	SenderKind       *string `json:"sender_kind"`
	SenderConfidence *string `json:"sender_confidence"`
	Verdict          *string `json:"verdict"`
}

// ScreenResult is what a Yes or No did.
type ScreenResult struct {
	Sender   string `json:"sender"`
	Decision string `json:"decision"`
	Folder   string `json:"folder"`
	Moved    int    `json:"moved"`
	Listed   bool   `json:"listed"`
}

// ListScreener returns first-time senders waiting for a decision.
func (c *Client) ListScreener(ctx context.Context, mailbox string) ([]ScreenerSender, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out struct {
		Senders []ScreenerSender `json:"senders"`
	}
	if err := c.get(ctx, mailboxPath(mailbox, "screener"), nil, &out); err != nil {
		return nil, err
	}
	return out.Senders, nil
}

// ScreenSender says Yes (allow) or No (block) to a screened sender.
func (c *Client) ScreenSender(ctx context.Context, mailbox, sender, decision, target string) (*ScreenResult, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	sender = strings.TrimSpace(sender)
	if !strings.Contains(sender, "@") {
		return nil, fail.Usagef("%q is not an email address", sender)
	}
	if decision != "allow" && decision != "block" {
		return nil, fail.Usagef("decision is allow or block")
	}
	body := map[string]any{"decision": decision}
	if target != "" {
		if target != "spam" && target != "trash" {
			return nil, fail.Usagef("--to is spam or trash")
		}
		body["target"] = target
	}
	note := "allowlists the sender and moves their screened mail to the inbox"
	if decision == "block" {
		note = "blocklists the sender and moves their screened mail out of sight"
	}
	var out ScreenResult
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "screener", sender),
		Body:       body,
		Idempotent: true,
		Keyed:      true,
		Reversible: true,
		Note:       note,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
