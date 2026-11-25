package cmd

import (
	"fmt"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

func newWebhookCommand(a *App) *cobra.Command {
	c := group("webhook", "Signed HTTP callbacks when mail arrives, sends, fails or is opened", `
Webhooks POST a signed JSON event to your backend when something happens to mail:

  `+strings.Join(api.WebhookEvents, "\n  ")+`

Each request carries X-Tapetide-Event, X-Tapetide-Delivery, X-Tapetide-Timestamp and
X-Tapetide-Signature: v1=<hex HMAC-SHA256 of "${timestamp}.${body}"> keyed with the
endpoint's secret. Failed deliveries retry after 1m, 5m, 30m, 2h and 6h.

Administrators may create webhooks for every mailbox. Anyone else may create them
only for mailboxes whose settings they manage, so pass --mailbox.`,
		"cloudmail webhook list",
		"cloudmail webhook create --name Billing --url https://api.example.com/hooks/mail --event message.received --event message.bounced",
		"cloudmail webhook test <webhook-id>",
		"cloudmail webhook deliveries <webhook-id>",
	)

	list := &cobra.Command{
		Use:   "list",
		Short: "List webhook endpoints",
		Long:  "Show the webhook endpoints you can manage. Secrets are never shown here, only their last four characters.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			items, err := a.Client.ListWebhooks(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    items,
				Columns: webhookColumns(),
				Summary: fmt.Sprintf("%d webhook(s)", len(items)),
				Empty:   "no webhooks yet",
			})
		},
	}

	var (
		name, url         string
		events, mailboxes []string
		disabled          bool
	)
	create := &cobra.Command{
		Use:   "create",
		Short: "Add a webhook endpoint",
		Long: strings.TrimSpace(`
Add an endpoint. The URL must be public HTTPS; private, loopback and internal
addresses are refused.

The signing secret is printed once, in this command's output. Store it with your
backend; if it is lost, rotate it from Settings -> Webhooks.`),
		Example: exampleBlock(
			"cloudmail webhook create --name Billing --url https://api.example.com/hooks/mail \\",
			"    --event message.received --event message.bounced",
			"",
			"# Only one mailbox",
			"cloudmail webhook create --name Support --url https://hooks.example.com/x \\",
			"    --event message.received --mailbox support@example.com",
		),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			in := api.WebhookInput{Name: name, URL: url, Events: events}
			if len(mailboxes) > 0 {
				in.Mailboxes = mailboxes
			}
			if disabled {
				off := false
				in.Enabled = &off
			}
			res, err := a.Client.CreateWebhook(a.Ctx(c), in)
			if err != nil {
				return err
			}
			summary := ""
			if res.Secret != "" {
				summary = "store the secret now; it is not shown again"
			}
			return a.emitMutation(output.Result{Data: res, Summary: summary})
		},
	}
	f := create.Flags()
	f.StringVar(&name, "name", "", "a label for the endpoint")
	f.StringVar(&url, "url", "", "the https:// URL to POST to")
	f.StringArrayVar(&events, "event", nil, "an event to send (repeatable): "+strings.Join(api.WebhookEvents, ", "))
	f.StringArrayVar(&mailboxes, "mailbox", nil, "limit to this mailbox (repeatable); omit for every mailbox (admins only)")
	f.BoolVar(&disabled, "disabled", false, "create it switched off")
	_ = create.MarkFlagRequired("name")
	_ = create.MarkFlagRequired("url")
	_ = create.MarkFlagRequired("event")

	del := &cobra.Command{
		Use:   "delete <webhook-id>",
		Short: "Delete a webhook endpoint",
		Long:  "Delete an endpoint. It stops receiving events at once and its delivery log is deleted with it.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf("delete webhook %s and its delivery log", args[0]), true); err != nil {
				return err
			}
			res, err := a.Client.DeleteWebhook(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}

	test := &cobra.Command{
		Use:   "test <webhook-id>",
		Short: "Send a test event to an endpoint",
		Long: strings.TrimSpace(`
Send one sample payload, marked "test": true, to the endpoint now and report what it
answered. A failed test is not retried.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			d, err := a.Client.TestWebhook(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			if d != nil && d.Status != "delivered" && !a.DryRun() {
				msg := "no response"
				if d.LastError != nil {
					msg = *d.LastError
				}
				if err := a.emit(output.Result{Data: d, Columns: deliveryColumns()}); err != nil {
					return err
				}
				return fail.Errf("test delivery failed: %s", msg).
					WithRemediation("check the URL is reachable over HTTPS and answers 2xx within 10 seconds")
			}
			return a.emitMutation(output.Result{Data: d, Columns: deliveryColumns()})
		},
	}

	var limit int
	deliveries := &cobra.Command{
		Use:   "deliveries <webhook-id>",
		Short: "Show an endpoint's recent deliveries",
		Long:  "Show recent deliveries for an endpoint, newest first, with status code, duration, attempt and error.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			items, err := a.Client.ListWebhookDeliveries(a.Ctx(c), args[0], limit)
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    items,
				Columns: deliveryColumns(),
				Summary: fmt.Sprintf("%d deliver(ies)", len(items)),
				Empty:   "nothing delivered yet -- try `cloudmail webhook test`",
			})
		},
	}
	deliveries.Flags().IntVar(&limit, "limit-per-page", 50, "how many deliveries to fetch (max 100)")

	retry := &cobra.Command{
		Use:   "retry <delivery-id>",
		Short: "Re-send one delivery now",
		Long:  "Re-send a failed or retrying delivery immediately and report the result.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			d, err := a.Client.RetryWebhookDelivery(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: d, Columns: deliveryColumns()})
		},
	}

	c.AddCommand(list, create, del, test, deliveries, retry)
	return c
}

func webhookColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 36},
		{Header: "name", Field: "name", Truncate: 24},
		{Header: "url", Field: "url", Truncate: 48},
		{Header: "events", Field: "events", Value: func(r map[string]any) string {
			list, _ := r["events"].([]any)
			if len(list) == len(api.WebhookEvents) {
				return "all"
			}
			parts := make([]string, 0, len(list))
			for _, e := range list {
				parts = append(parts, strings.TrimPrefix(output.Stringify(e), "message."))
			}
			return strings.Join(parts, ",")
		}, Truncate: 40},
		{Header: "mailboxes", Field: "mailboxes", Value: func(r map[string]any) string {
			list, ok := r["mailboxes"].([]any)
			if !ok || list == nil {
				return "all"
			}
			parts := make([]string, 0, len(list))
			for _, m := range list {
				parts = append(parts, output.Stringify(m))
			}
			return strings.Join(parts, ",")
		}, Truncate: 32},
		{Header: "state", Field: "enabled", Value: func(r map[string]any) string {
			if truthy(r["enabled"]) {
				return "on"
			}
			if r["disabledReason"] != nil {
				return "auto-disabled"
			}
			return "off"
		}},
	}
}

func deliveryColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 36},
		{Header: "event", Field: "eventType", Truncate: 24},
		{Header: "status", Field: "status"},
		{Header: "code", Field: "lastStatusCode", Right: true},
		{Header: "ms", Field: "lastDurationMs", Right: true},
		{Header: "attempt", Field: "attempts", Right: true},
		{Header: "error", Field: "lastError", Truncate: 48},
	}
}
