package api

import (
	"context"
	"encoding/json"
)

// Per-domain sending provider: Cloudflare Email Service (the default), Amazon
// SES or Resend. Secrets (the SES secret access key, the Resend API key and
// webhook signing secret) are write-only on the server; no response carries
// them, and a dry-run preview masks them.

// DomainSending is the GET/PUT/DELETE /api/v1/domains/:id/sending view.
type DomainSending struct {
	Domain        string                `json:"domain"`
	Provider      string                `json:"provider"`
	SES           *DomainSendingSES     `json:"ses"`
	Resend        *DomainSendingResend  `json:"resend"`
	Webhook       *DomainSendingWebhook `json:"webhook"`
	LastEvent     json.RawMessage       `json:"lastEvent"`
	UpdatedAt     *int64                `json:"updatedAt"`
	UpdatedBy     *string               `json:"updatedBy"`
	LastTest      json.RawMessage       `json:"lastTest"`
	IAMPolicy     json.RawMessage       `json:"iamPolicy"`
	BlockedReason *string               `json:"blockedReason,omitempty"`
}

// DomainSendingSES is the stored SES settings, without the secret.
type DomainSendingSES struct {
	Region           *string `json:"region"`
	AccessKeyIDLast4 *string `json:"accessKeyIdLast4"`
	SecretStored     bool    `json:"secretStored"`
	ConfigurationSet *string `json:"configurationSet"`
	SNSTopicArn      *string `json:"snsTopicArn"`
}

// DomainSendingResend is the stored Resend settings, without the key or secret.
type DomainSendingResend struct {
	APIKeyLast4         *string `json:"apiKeyLast4"`
	APIKeyStored        bool    `json:"apiKeyStored"`
	WebhookSecretStored bool    `json:"webhookSecretStored"`
}

// DomainSendingWebhook is where the provider posts events.
type DomainSendingWebhook struct {
	Provider string  `json:"provider"`
	Path     string  `json:"path"`
	URL      *string `json:"url"`
}

// DomainSendingInput is the PUT body. Empty secrets keep the stored ones.
type DomainSendingInput struct {
	Provider         string  `json:"provider"`
	Region           string  `json:"region,omitempty"`
	AccessKeyID      string  `json:"accessKeyId,omitempty"`
	SecretAccessKey  string  `json:"secretAccessKey,omitempty"`
	ConfigurationSet *string `json:"configurationSet,omitempty"`
	SNSTopicArn      *string `json:"snsTopicArn,omitempty"`
	APIKey           string  `json:"apiKey,omitempty"`
	WebhookSecret    string  `json:"webhookSecret,omitempty"`
}

// DomainSendingTestInput is the optional POST .../sending/test body.
type DomainSendingTestInput struct {
	Provider string `json:"provider,omitempty"`
	SendTest bool   `json:"sendTest,omitempty"`
}

// DomainSendingTest is the POST .../sending/test result.
type DomainSendingTest struct {
	Test    json.RawMessage `json:"test"`
	Sending DomainSending   `json:"sending"`
}

// GetDomainSending returns the domain's sending provider.
func (c *Client) GetDomainSending(ctx context.Context, id string) (*DomainSending, error) {
	p, err := domainPath(id, "sending")
	if err != nil {
		return nil, err
	}
	var out DomainSending
	if err := c.get(ctx, p, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetDomainSending saves the provider settings. SES or Resend becomes active
// only after a passing connection test of the saved settings; until then the
// result carries BlockedReason and the domain keeps sending through Cloudflare.
func (c *Client) SetDomainSending(ctx context.Context, id string, in DomainSendingInput) (*DomainSending, error) {
	p, err := domainPath(id, "sending")
	if err != nil {
		return nil, err
	}
	note := "outgoing mail from this domain is sent through " + in.Provider
	if in.Provider != "cloudflare" {
		note += " once a connection test of these settings has passed; there is no fallback to Cloudflare if it cannot send"
	} else {
		note += " from now on"
	}
	var out DomainSending
	_, err = c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       p,
		Body:       in,
		Idempotent: true,
		Reversible: true,
		Note:       note,
		Redact:     []string{"secretAccessKey", "apiKey", "webhookSecret"},
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ResetDomainSending sends through Cloudflare again and forgets the provider settings.
func (c *Client) ResetDomainSending(ctx context.Context, id string) (*DomainSending, error) {
	p, err := domainPath(id, "sending")
	if err != nil {
		return nil, err
	}
	var out DomainSending
	_, err = c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       p,
		Idempotent: true,
		Reversible: false,
		Note:       "the stored SES and Resend keys and secrets are deleted; entering them again is the only undo",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// TestDomainSending checks the stored settings with the provider. With
// SendTest it also sends one message to the provider's test address.
func (c *Client) TestDomainSending(ctx context.Context, id string, in DomainSendingTestInput) (*DomainSendingTest, error) {
	p, err := domainPath(id, "sending", "test")
	if err != nil {
		return nil, err
	}
	note := "read-only provider calls; the result is recorded, nothing is sent"
	if in.SendTest {
		note = "provider checks plus one test message to the provider's test address (SES mailbox simulator or delivered@resend.dev)"
	}
	var out DomainSendingTest
	_, err = c.mutate(ctx, Request{
		Method:     "POST",
		Path:       p,
		Body:       in,
		Idempotent: !in.SendTest,
		Reversible: true,
		Note:       note,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
