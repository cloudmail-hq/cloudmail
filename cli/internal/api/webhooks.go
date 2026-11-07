package api

import (
	"context"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// WebhookEvents is the event vocabulary the server accepts. Kept in step with
// shared/webhooks.ts; the server rejects anything else.
var WebhookEvents = []string{
	"message.received",
	"message.sent",
	"message.delivery_failed",
	"message.bounced",
	"message.opened",
	"message.clicked",
	"deliverability.warning",
	"usage.budget_exceeded",
}

// Webhook is an outbound webhook endpoint. The secret is never part of it:
// the server returns that only when an endpoint is created or its secret is
// rotated.
type Webhook struct {
	ID                  string   `json:"id"`
	Name                string   `json:"name"`
	URL                 string   `json:"url"`
	Events              []string `json:"events"`
	Mailboxes           []string `json:"mailboxes"`
	Enabled             bool     `json:"enabled"`
	DisabledReason      *string  `json:"disabledReason"`
	SecretHint          string   `json:"secretHint"`
	CreatedBy           *string  `json:"createdBy"`
	CreatedAt           int64    `json:"createdAt"`
	UpdatedAt           int64    `json:"updatedAt"`
	ConsecutiveFailures int      `json:"consecutiveFailures"`
	LastSuccessAt       *int64   `json:"lastSuccessAt"`
	LastFailureAt       *int64   `json:"lastFailureAt"`
}

// WebhookWithSecret is the response to create and rotate-secret.
type WebhookWithSecret struct {
	Webhook Webhook `json:"webhook"`
	Secret  string  `json:"secret"`
}

// WebhookAttempt is one HTTP attempt at a delivery.
type WebhookAttempt struct {
	Attempt    int     `json:"attempt"`
	StatusCode *int    `json:"statusCode"`
	DurationMs int     `json:"durationMs"`
	Error      *string `json:"error"`
	At         int64   `json:"at"`
}

// WebhookDelivery is one event queued for one endpoint, with its attempts.
type WebhookDelivery struct {
	ID             string           `json:"id"`
	EndpointID     string           `json:"endpointId"`
	EventID        string           `json:"eventId"`
	EventType      string           `json:"eventType"`
	Mailbox        string           `json:"mailbox"`
	Status         string           `json:"status"`
	Attempts       int              `json:"attempts"`
	NextAttemptAt  *int64           `json:"nextAttemptAt"`
	LastStatusCode *int             `json:"lastStatusCode"`
	LastError      *string          `json:"lastError"`
	LastDurationMs *int             `json:"lastDurationMs"`
	CreatedAt      int64            `json:"createdAt"`
	UpdatedAt      int64            `json:"updatedAt"`
	Test           bool             `json:"test"`
	AttemptLog     []WebhookAttempt `json:"attemptLog,omitempty"`
}

// WebhookInput creates an endpoint. A nil Mailboxes means every mailbox, which
// only an administrator may ask for.
type WebhookInput struct {
	Name      string   `json:"name"`
	URL       string   `json:"url"`
	Events    []string `json:"events"`
	Mailboxes []string `json:"mailboxes"`
	Enabled   *bool    `json:"enabled,omitempty"`
}

func validateWebhookEvents(events []string) error {
	if len(events) == 0 {
		return fail.Usagef("a webhook needs at least one event").
			WithRemediation("pass --event, e.g. --event message.received (one of: %s)", strings.Join(WebhookEvents, ", "))
	}
	for _, e := range events {
		ok := false
		for _, known := range WebhookEvents {
			if e == known {
				ok = true
				break
			}
		}
		if !ok {
			return fail.Usagef("unknown webhook event %q", e).
				WithRemediation("use one of: %s", strings.Join(WebhookEvents, ", "))
		}
	}
	return nil
}

// ListWebhooks returns the endpoints the caller may manage.
func (c *Client) ListWebhooks(ctx context.Context) ([]Webhook, error) {
	var out struct {
		Webhooks []Webhook `json:"webhooks"`
	}
	if err := c.get(ctx, path("webhooks"), nil, &out); err != nil {
		return nil, err
	}
	return out.Webhooks, nil
}

// CreateWebhook adds an endpoint and returns it with its secret, shown once.
func (c *Client) CreateWebhook(ctx context.Context, in WebhookInput) (*WebhookWithSecret, error) {
	if strings.TrimSpace(in.Name) == "" {
		return nil, fail.Usagef("a webhook needs a name").WithRemediation("pass --name")
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(in.URL)), "https://") {
		return nil, fail.Usagef("webhook URLs must use https://")
	}
	if err := validateWebhookEvents(in.Events); err != nil {
		return nil, err
	}
	var out WebhookWithSecret
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       path("webhooks"),
		Keyed:      true,
		Body:       in,
		Reversible: true,
		Note:       "the signing secret is printed once; store it before closing the terminal",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteWebhook removes an endpoint and its delivery log.
func (c *Client) DeleteWebhook(ctx context.Context, id string) (*StatusResult, error) {
	if err := requireID("webhook", id); err != nil {
		return nil, err
	}
	var out StatusResult
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       path("webhooks", id),
		Idempotent: true,
		Reversible: false,
		Note:       "the endpoint stops receiving events and its delivery log is deleted",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// TestWebhook sends a sample payload to the endpoint now and reports the result.
func (c *Client) TestWebhook(ctx context.Context, id string) (*WebhookDelivery, error) {
	if err := requireID("webhook", id); err != nil {
		return nil, err
	}
	var out struct {
		Delivery *WebhookDelivery `json:"delivery"`
	}
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       path("webhooks", id, "test"),
		Reversible: true,
		Note:       "sends one test request to the endpoint",
	}, &out)
	if err != nil {
		return nil, err
	}
	return out.Delivery, nil
}

// ListWebhookDeliveries returns an endpoint's recent deliveries, newest first.
func (c *Client) ListWebhookDeliveries(ctx context.Context, id string, limit int) ([]WebhookDelivery, error) {
	if err := requireID("webhook", id); err != nil {
		return nil, err
	}
	var out struct {
		Deliveries []WebhookDelivery `json:"deliveries"`
	}
	if err := c.get(ctx, path("webhooks", id, "deliveries"), NewQuery().Int("limit", limit), &out); err != nil {
		return nil, err
	}
	return out.Deliveries, nil
}

// RetryWebhookDelivery re-sends one delivery now.
func (c *Client) RetryWebhookDelivery(ctx context.Context, deliveryID string) (*WebhookDelivery, error) {
	if err := requireID("delivery", deliveryID); err != nil {
		return nil, err
	}
	var out struct {
		Delivery *WebhookDelivery `json:"delivery"`
	}
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       path("webhooks", "deliveries", deliveryID, "retry"),
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return out.Delivery, nil
}
