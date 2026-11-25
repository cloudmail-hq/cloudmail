package api

// Client calls for the instance and per-user routes the CLI wraps with thin
// commands: branding, delegates, notifications, preferences, privacy and the
// account, sending health, usage, licence, migration, the Cloudflare
// connection, and the smaller AI, domain, webhook, product and search routes.
//
// Most of these return the server's JSON untouched. Their shapes are settings
// documents that the command layer prints rather than interprets, so decoding
// them into Go structs would only add a place for the CLI to drift from the
// server.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// getRaw performs a read and returns the body undecoded.
func (c *Client) getRaw(ctx context.Context, p string, q *Query) (json.RawMessage, error) {
	var out json.RawMessage
	if err := c.get(ctx, p, q, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// mutateRaw performs a state-changing request and returns the body undecoded.
// Under --dry-run it returns nil; the command layer renders the preview.
func (c *Client) mutateRaw(ctx context.Context, req Request) (json.RawMessage, error) {
	var out json.RawMessage
	if _, err := c.mutate(ctx, req, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// LogoUpload is the body of the branding and product logo routes: the image,
// base64-encoded, with its filename and MIME type.
type LogoUpload struct {
	Content  string `json:"content"`
	Filename string `json:"filename"`
	Type     string `json:"type"`
}

// LogoTypes are the image types the server accepts for a logo.
var LogoTypes = []string{"image/png", "image/jpeg", "image/webp", "image/gif"}

// MaxLogoBytes is the server's limit on a decoded logo.
const MaxLogoBytes = 512 * 1024

// ── Branding ───────────────────────────────────────────────────────

// GetBranding returns the instance name, tagline, accent colour and logo metadata.
func (c *Client) GetBranding(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("branding"), nil)
}

// UpdateBranding patches the branding. Administrator only.
func (c *Client) UpdateBranding(ctx context.Context, patch map[string]any) (json.RawMessage, error) {
	return c.mutateRaw(ctx, Request{
		Method: "PUT", Path: path("branding"), Body: patch,
		Idempotent: true, Reversible: true,
		Note: "changes the name, tagline or colour every user sees",
	})
}

// ResetBranding restores the default branding and deletes the logo.
func (c *Client) ResetBranding(ctx context.Context) (json.RawMessage, error) {
	return c.mutateRaw(ctx, Request{
		Method: "DELETE", Path: path("branding"), Idempotent: true,
		Note: "restores the default name, tagline and colour, and deletes the uploaded logo",
	})
}

// GetBrandingLogo downloads the uploaded logo.
func (c *Client) GetBrandingLogo(ctx context.Context) ([]byte, string, error) {
	resp, err := c.Do(ctx, Request{
		Method: "GET", Path: path("branding", "logo"), Idempotent: true,
		Headers: map[string]string{"Accept": "*/*"},
	})
	if err != nil {
		return nil, "", err
	}
	return resp.Bytes, resp.Header.Get("Content-Type"), nil
}

// UploadBrandingLogo replaces the logo.
func (c *Client) UploadBrandingLogo(ctx context.Context, logo LogoUpload) (json.RawMessage, error) {
	return c.mutateRaw(ctx, Request{
		Method: "PUT", Path: path("branding", "logo"), Body: logo,
		Idempotent: true, Reversible: true,
		Note: "replaces the logo every user sees",
	})
}

// DeleteBrandingLogo removes the logo.
func (c *Client) DeleteBrandingLogo(ctx context.Context) (json.RawMessage, error) {
	return c.mutateRaw(ctx, Request{
		Method: "DELETE", Path: path("branding", "logo"), Idempotent: true,
		Note: "deletes the uploaded logo; upload it again to restore it",
	})
}

// ── Delegates ──────────────────────────────────────────────────────

// DelegateRoles and DelegateCapabilities are the vocabularies the delegate
// route accepts.
var (
	DelegateRoles        = []string{"viewer", "agent", "manager", "owner"}
	DelegateKinds        = []string{"user", "service"}
	DelegateCapabilities = []string{"read", "sendAs", "sendOnBehalf", "delete", "deletePermanently",
		"organise", "draft", "manageRules", "manageSettings", "manageDelegates"}
)

// DelegateInput grants or changes one delegate's access to a mailbox.
type DelegateInput struct {
	ID      string   `json:"id"`
	Kind    string   `json:"kind,omitempty"`
	Role    string   `json:"role"`
	Extra   []string `json:"extra,omitempty"`
	Revoked []string `json:"revoked,omitempty"`
	Label   string   `json:"label,omitempty"`
}

// ListDelegates returns everyone who can reach a mailbox, and how far.
func (c *Client) ListDelegates(ctx context.Context, mailbox string) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	return c.getRaw(ctx, mailboxPath(mailbox, "delegates"), nil)
}

// PutDelegate grants or changes one delegate's access.
func (c *Client) PutDelegate(ctx context.Context, mailbox string, in DelegateInput) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := ValidateDelegate(in); err != nil {
		return nil, err
	}
	return c.mutateRaw(ctx, Request{
		Method: "PUT", Path: mailboxPath(mailbox, "delegates"), Body: in,
		Idempotent: true, Reversible: true,
		Note: "changes who can reach this mailbox",
	})
}

// ValidateDelegate checks a delegate's role, kind and capabilities locally, so
// a typo is a usage error before anyone is asked to confirm it.
func ValidateDelegate(in DelegateInput) error {
	if !contains(DelegateRoles, in.Role) {
		return fail.Usagef("unknown role %q", in.Role).
			WithRemediation("use one of %s", strings.Join(DelegateRoles, ", "))
	}
	if in.Kind != "" && !contains(DelegateKinds, in.Kind) {
		return fail.Usagef("unknown kind %q", in.Kind).
			WithRemediation("use user or service")
	}
	for _, cp := range append(append([]string{}, in.Extra...), in.Revoked...) {
		if !contains(DelegateCapabilities, cp) {
			return fail.Usagef("unknown capability %q", cp).
				WithRemediation("use %s", strings.Join(DelegateCapabilities, ", "))
		}
	}
	return nil
}

// RemoveDelegate removes one delegate from a mailbox.
func (c *Client) RemoveDelegate(ctx context.Context, mailbox, kind, id string) error {
	if err := requireMailbox(mailbox); err != nil {
		return err
	}
	if !contains(DelegateKinds, kind) {
		return fail.Usagef("unknown kind %q", kind).WithRemediation("use user or service")
	}
	seg, err := pathSegment("delegate id", id)
	if err != nil {
		return err
	}
	_, err = c.mutate(ctx, Request{
		Method: "DELETE", Path: mailboxPath(mailbox, "delegates", kind, seg), Idempotent: true,
		Note: "removes this delegate's access to the mailbox",
	}, nil)
	return err
}

// ── Notifications (Web Push) ───────────────────────────────────────

// ListPushDevices returns the caller's devices registered for Web Push.
func (c *Client) ListPushDevices(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("push", "subscriptions"), nil)
}

// RemovePushDevice revokes one of the caller's devices by id.
func (c *Client) RemovePushDevice(ctx context.Context, id string) (json.RawMessage, error) {
	if err := requireID("device", id); err != nil {
		return nil, err
	}
	return c.mutateRaw(ctx, Request{
		Method: "DELETE", Path: path("push", "subscriptions"), Body: map[string]string{"id": id},
		Idempotent: true,
		Note:       "the device stops receiving notifications until its browser subscribes again",
	})
}

// GetPushPreferences returns the caller's notification preferences.
func (c *Client) GetPushPreferences(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("push", "preferences"), nil)
}

// UpdatePushPreferences merges a patch into the caller's notification preferences.
func (c *Client) UpdatePushPreferences(ctx context.Context, patch json.RawMessage) (json.RawMessage, error) {
	return c.mutateRaw(ctx, Request{
		Method: "PUT", Path: path("push", "preferences"), Body: patch,
		Idempotent: true, Reversible: true,
	})
}

// SendTestPush sends a test notification to every one of the caller's devices.
func (c *Client) SendTestPush(ctx context.Context) (json.RawMessage, error) {
	return c.mutateRaw(ctx, Request{
		Method: "POST", Path: path("push", "test"), Body: map[string]any{},
		Note: "sends a test notification to every device you registered",
	})
}

// ── Preferences ────────────────────────────────────────────────────

// GetPreferences returns the instance-wide display, notification and sending preferences.
func (c *Client) GetPreferences(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("preferences"), nil)
}

// UpdatePreferences merges a patch into the instance preferences. Administrator only.
func (c *Client) UpdatePreferences(ctx context.Context, patch json.RawMessage) (json.RawMessage, error) {
	return c.mutateRaw(ctx, Request{
		Method: "PUT", Path: path("preferences"), Body: patch,
		Idempotent: true, Reversible: true,
		Note: "changes the defaults for every user of this deployment",
	})
}

// ── Privacy and the account ────────────────────────────────────────

// GetPrivacySettings returns the privacy notice settings and retention periods.
func (c *Client) GetPrivacySettings(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("privacy"), nil)
}

// UpdatePrivacySettings merges a patch into the privacy settings. Administrator only.
func (c *Client) UpdatePrivacySettings(ctx context.Context, patch json.RawMessage) (json.RawMessage, error) {
	return c.mutateRaw(ctx, Request{
		Method: "PUT", Path: path("privacy"), Body: patch, Idempotent: true,
		Note: "changes the privacy notice and the retention periods; shorter retention " +
			"lets the server purge older data sooner, and purged data cannot be recovered",
	})
}

// GetTrackingSettings returns a mailbox's tracking toggles.
func (c *Client) GetTrackingSettings(ctx context.Context, mailbox string) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	return c.getRaw(ctx, mailboxPath(mailbox, "settings", "tracking"), nil)
}

// UpdateTrackingSettings patches a mailbox's tracking toggles.
func (c *Client) UpdateTrackingSettings(ctx context.Context, mailbox string, patch map[string]any) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	return c.mutateRaw(ctx, Request{
		Method: "PATCH", Path: mailboxPath(mailbox, "settings", "tracking"), Body: patch,
		Idempotent: true, Reversible: true,
	})
}

// GetAccountDeletion reports whether the caller's account is scheduled for deletion.
func (c *Client) GetAccountDeletion(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("account", "deletion"), nil)
}

// CancelAccountDeletion cancels a pending deletion of the caller's account.
func (c *Client) CancelAccountDeletion(ctx context.Context) (json.RawMessage, error) {
	return c.mutateRaw(ctx, Request{
		Method: "POST", Path: path("account", "deletion", "cancel"), Body: map[string]any{},
		Idempotent: true,
		Note:       "keeps the account; sessions and tokens revoked by the request stay revoked",
	})
}

// AccountExport is one export job.
type AccountExport struct {
	ID          string  `json:"id"`
	Status      string  `json:"status"`
	Size        *int64  `json:"size"`
	Error       *string `json:"error"`
	CreatedAt   int64   `json:"createdAt"`
	CompletedAt *int64  `json:"completedAt"`
	ExpiresAt   int64   `json:"expiresAt"`
	DownloadURL *string `json:"downloadUrl"`
}

// ListAccountExports returns the caller's account exports, with signed
// download links for the finished ones.
func (c *Client) ListAccountExports(ctx context.Context) ([]AccountExport, error) {
	var out struct {
		Exports []AccountExport `json:"exports"`
	}
	if err := c.get(ctx, path("account", "exports"), nil, &out); err != nil {
		return nil, err
	}
	return out.Exports, nil
}

// exportDownloadPrefix is the only place an export download link may point.
// The link comes from the server, but it is checked anyway: the client attaches
// the caller's credential to it.
const exportDownloadPrefix = APIPrefix + "/account/exports/"

// DownloadAccountExport streams a finished export to w. link is the
// downloadUrl from ListAccountExports.
func (c *Client) DownloadAccountExport(ctx context.Context, link string, w io.Writer) (int64, error) {
	u, err := url.Parse(link)
	if err != nil || u.IsAbs() || u.Host != "" || !strings.HasPrefix(u.Path, exportDownloadPrefix) ||
		!strings.HasSuffix(u.Path, "/download") || strings.Contains(u.Path, "..") {
		return 0, fail.Errf("the server returned an unexpected download link").
			WithRemediation("list the exports again with `cloudmail account export list`")
	}
	n, _, err := c.Download(ctx, u.Path, u.Query(), w)
	return n, err
}

// ── Sending health ─────────────────────────────────────────────────

// ListSendingHealth returns the complaint rate and bulk-pause state per sending domain.
func (c *Client) ListSendingHealth(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("sending-health"), nil)
}

// EvaluateSendingHealth re-evaluates every sending domain now. It can pause
// bulk sending on a domain over the threshold.
func (c *Client) EvaluateSendingHealth(ctx context.Context) (json.RawMessage, error) {
	return c.mutateRaw(ctx, Request{
		Method: "POST", Path: path("sending-health", "evaluate"), Body: map[string]any{},
		Idempotent: true,
		Note:       "may pause bulk sending on a domain over the complaint threshold",
	})
}

func sendingDomainPath(domain string, action string) (string, error) {
	h, err := validateHostname(domain)
	if err != nil {
		return "", err
	}
	return path("sending-health", h, action), nil
}

// PauseBulkSending stops bulk sending from a domain. Audited.
func (c *Client) PauseBulkSending(ctx context.Context, domain, reason string) (json.RawMessage, error) {
	p, err := sendingDomainPath(domain, "pause")
	if err != nil {
		return nil, err
	}
	body := map[string]any{}
	if reason != "" {
		body["reason"] = reason
	}
	return c.mutateRaw(ctx, Request{
		Method: "POST", Path: p, Body: body, Idempotent: true, Reversible: true,
		Note: "bulk and sequence sends from this domain stop until it is resumed",
	})
}

// ResumeBulkSending resumes bulk sending from a domain. Audited.
func (c *Client) ResumeBulkSending(ctx context.Context, domain string) (json.RawMessage, error) {
	p, err := sendingDomainPath(domain, "resume")
	if err != nil {
		return nil, err
	}
	return c.mutateRaw(ctx, Request{
		Method: "POST", Path: p, Body: map[string]any{}, Idempotent: true, Reversible: true,
		Note: "bulk and sequence sends from this domain start again",
	})
}

// GetSendLimits returns a mailbox's send caps and usage.
func (c *Client) GetSendLimits(ctx context.Context, mailbox string) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	return c.getRaw(ctx, mailboxPath(mailbox, "send-limits"), nil)
}

// UpdateSendLimits changes a mailbox's hourly and daily send caps. Zero leaves
// a cap unchanged.
func (c *Client) UpdateSendLimits(ctx context.Context, mailbox string, hourly, daily int) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	body := map[string]any{}
	if hourly > 0 {
		body["hourly"] = hourly
	}
	if daily > 0 {
		body["daily"] = daily
	}
	if len(body) == 0 {
		return nil, fail.Usagef("nothing to change").WithRemediation("pass --hourly, --daily or both")
	}
	return c.mutateRaw(ctx, Request{
		Method: "PUT", Path: mailboxPath(mailbox, "send-limits"), Body: body,
		Idempotent: true, Reversible: true,
	})
}

// ── Usage ──────────────────────────────────────────────────────────

// GetUsage returns this month's usage and projected cost.
func (c *Client) GetUsage(ctx context.Context, refresh bool) (json.RawMessage, error) {
	q := NewQuery()
	if refresh {
		q.Str("refresh", "1")
	}
	return c.getRaw(ctx, path("usage"), q)
}

// UpdateUsageBudget sets or clears the monthly budget thresholds. A nil field
// is left out; a field pointing at a negative number is sent as null, which
// clears that threshold.
func (c *Client) UpdateUsageBudget(ctx context.Context, aiUSD, emailUSD *float64) (json.RawMessage, error) {
	body := map[string]any{}
	set := func(key string, v *float64) {
		if v == nil {
			return
		}
		if *v < 0 {
			body[key] = nil
		} else {
			body[key] = *v
		}
	}
	set("ai_usd", aiUSD)
	set("email_usd", emailUSD)
	if len(body) == 0 {
		return nil, fail.Usagef("nothing to change").WithRemediation("pass --ai-usd, --email-usd or both")
	}
	return c.mutateRaw(ctx, Request{
		Method: "PUT", Path: path("usage", "budget"), Body: body,
		Idempotent: true, Reversible: true,
	})
}

// ── Licence ────────────────────────────────────────────────────────

// GetLicence returns the licence status. Administrators also see the plan,
// expiry and refresh state.
func (c *Client) GetLicence(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("licence"), nil)
}

// RefreshLicence asks the licence server for a fresh token now.
func (c *Client) RefreshLicence(ctx context.Context) (json.RawMessage, error) {
	return c.mutateRaw(ctx, Request{
		Method: "POST", Path: path("licence", "refresh"), Body: map[string]any{},
		Idempotent: true, Reversible: true,
		Note: "contacts the licence server and stores the token it returns",
	})
}

// ── Migration ──────────────────────────────────────────────────────

func migratePath(mailbox string, rest ...string) (string, error) {
	if err := requireMailbox(mailbox); err != nil {
		return "", err
	}
	return path(append([]string{"_migrate", "mailboxes", mailbox}, rest...)...), nil
}

// MigrationStatus compares row counts between the legacy and current namespace.
// Needs CLOUDMAIL_MIGRATION_TOKEN; without it the route answers 404.
func (c *Client) MigrationStatus(ctx context.Context, mailbox string) (json.RawMessage, error) {
	p, err := migratePath(mailbox, "status")
	if err != nil {
		return nil, err
	}
	return c.getRaw(ctx, p, nil)
}

// MigrateMailbox copies a mailbox from the legacy namespace. The server's own
// check mode (check=true) counts what would be copied and writes nothing.
func (c *Client) MigrateMailbox(ctx context.Context, mailbox string, check bool) (json.RawMessage, error) {
	p, err := migratePath(mailbox)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	if check {
		q.Set("dryRun", "1")
	}
	var out json.RawMessage
	_, err = c.mutate(ctx, Request{
		Method: "POST", Path: p, Query: q, Body: map[string]any{}, Idempotent: true,
		Note: "copies the mailbox's rows from the legacy namespace; rows already copied are skipped",
	}, &out)
	return out, err
}

// ── Cloudflare ─────────────────────────────────────────────────────

// GetCloudflareConnection returns the Cloudflare token's source, account and
// capabilities. The token itself is never returned.
func (c *Client) GetCloudflareConnection(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("cloudflare", "connection"), nil)
}

// DiscoverCloudflare lists every zone the token sees, with its mail DNS and
// routing. Read-only.
func (c *Client) DiscoverCloudflare(ctx context.Context, refresh bool) (json.RawMessage, error) {
	q := NewQuery()
	if refresh {
		q.Str("refresh", "1")
	}
	return c.getRaw(ctx, path("cloudflare", "discover"), q)
}

// PlanCloudflare returns the setup plan for the chosen zones. Read-only, even
// though it is a POST.
func (c *Client) PlanCloudflare(ctx context.Context, zones []string) (json.RawMessage, error) {
	if len(zones) == 0 || len(zones) > 5 {
		return nil, fail.Usagef("give between 1 and 5 zone ids").
			WithRemediation("list them with `cloudmail cloudflare discover`")
	}
	resp, err := c.Do(ctx, Request{
		Method: "POST", Path: path("cloudflare", "plan"),
		Body: map[string]any{"zones": zones}, Idempotent: true,
	})
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

// ListCloudflareChanges returns recent changes made by apply, newest first.
func (c *Client) ListCloudflareChanges(ctx context.Context, zoneID string, limit int) (json.RawMessage, error) {
	return c.getRaw(ctx, path("cloudflare", "changes"), NewQuery().Str("zoneId", zoneID).Int("limit", limit))
}

// ── AI ─────────────────────────────────────────────────────────────

// GetAISettings returns the instance AI summary and semantic search settings.
func (c *Client) GetAISettings(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("ai", "settings"), nil)
}

// UpdateAISettings patches the instance AI settings. Administrator only.
func (c *Client) UpdateAISettings(ctx context.Context, patch map[string]any) (json.RawMessage, error) {
	return c.mutateRaw(ctx, Request{
		Method: "PUT", Path: path("ai", "settings"), Body: patch,
		Idempotent: true, Reversible: true,
	})
}

// GetAIRouting returns which model each AI role uses.
func (c *Client) GetAIRouting(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("ai", "routing"), nil)
}

// GetSemanticAvailability reports whether semantic search is available.
func (c *Client) GetSemanticAvailability(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("ai", "semantic"), nil)
}

// GetSemanticStatus returns a mailbox's semantic index status.
func (c *Client) GetSemanticStatus(ctx context.Context, mailbox string) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	return c.getRaw(ctx, mailboxPath(mailbox, "semantic"), nil)
}

// UpdateAIProvider patches a gateway. Needs a signed-in browser session.
func (c *Client) UpdateAIProvider(ctx context.Context, id string, patch map[string]any) (*AIProvider, error) {
	route, err := aiProviderPath(id)
	if err != nil {
		return nil, err
	}
	var out aiProviderEnvelope
	resp, err := c.mutate(ctx, Request{
		Method: "PATCH", Path: route, Body: patch, Idempotent: true, Reversible: true,
		Note: aiPersonNote,
	}, &out)
	if err != nil {
		return nil, err
	}
	if resp.Preview != nil {
		redactPreviewToken(resp.Preview)
	}
	return &out.Provider, nil
}

// DeleteAIProvider removes a gateway. The server refuses while it is active.
func (c *Client) DeleteAIProvider(ctx context.Context, id string) error {
	route, err := aiProviderPath(id)
	if err != nil {
		return err
	}
	_, err = c.mutate(ctx, Request{
		Method: "DELETE", Path: route, Idempotent: true,
		Note: "removes the gateway and its stored token; " + aiPersonNote,
	}, nil)
	return err
}

// TestWorkersAIModel probes one Workers AI model.
func (c *Client) TestWorkersAIModel(ctx context.Context, model string, checks []string) (*AITestResponse, error) {
	if strings.TrimSpace(model) == "" {
		return nil, fail.Usagef("no model given").
			WithRemediation("pass a model id from `cloudmail ai models list`")
	}
	for _, ch := range checks {
		if !contains(AIChecks, ch) {
			return nil, fail.Usagef("unknown check %q", ch).
				WithRemediation("use %s", strings.Join(AIChecks, ", "))
		}
	}
	body := map[string]any{"modelId": model}
	if len(checks) > 0 {
		body["checks"] = checks
	}
	var out AITestResponse
	_, err := c.mutate(ctx, Request{
		Method: "POST", Path: path("ai", "providers", WorkersAIProviderID, "test"),
		Body: body, Idempotent: true, Reversible: true,
		Note: "runs small live Workers AI requests, counted against this month's usage",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// GetAssistantPrefs returns the caller's AI preferences.
func (c *Client) GetAssistantPrefs(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("me", "assistant"), nil)
}

// UpdateAssistantPrefs patches the caller's AI preferences.
func (c *Client) UpdateAssistantPrefs(ctx context.Context, patch map[string]any) (json.RawMessage, error) {
	return c.mutateRaw(ctx, Request{
		Method: "PUT", Path: path("me", "assistant"), Body: patch,
		Idempotent: true, Reversible: true,
	})
}

// GetDailyBrief returns the caller's latest daily brief.
func (c *Client) GetDailyBrief(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("me", "brief"), nil)
}

// GenerateDailyBrief builds the caller's brief now. It does not send the email.
func (c *Client) GenerateDailyBrief(ctx context.Context) (json.RawMessage, error) {
	return c.mutateRaw(ctx, Request{
		Method: "POST", Path: path("me", "brief", "generate"), Body: map[string]any{},
		Reversible: true,
		Note:       "runs the AI over your recent mail; counted against the AI budget",
	})
}

// DismissDailyBrief hides a brief until the next one.
func (c *Client) DismissDailyBrief(ctx context.Context, briefID string) (json.RawMessage, error) {
	seg, err := pathSegment("brief id", briefID)
	if err != nil {
		return nil, err
	}
	return c.mutateRaw(ctx, Request{
		Method: "POST", Path: path("me", "brief", seg, "dismiss"), Body: map[string]any{},
		Idempotent: true,
	})
}

// GetThreadSummary returns a conversation's AI summary, or null when none exists.
func (c *Client) GetThreadSummary(ctx context.Context, mailbox, threadID string) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	seg, err := pathSegment("thread id", threadID)
	if err != nil {
		return nil, err
	}
	return c.getRaw(ctx, mailboxPath(mailbox, "threads", seg, "summary"), nil)
}

// SummariseThread generates a conversation's summary now (generate) or queues
// a regeneration (refresh).
func (c *Client) SummariseThread(ctx context.Context, mailbox, threadID, action string) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if action != "generate" && action != "refresh" {
		return nil, fail.Usagef("internal: unknown summary action %q", action)
	}
	seg, err := pathSegment("thread id", threadID)
	if err != nil {
		return nil, err
	}
	return c.mutateRaw(ctx, Request{
		Method: "POST", Path: mailboxPath(mailbox, "threads", seg, "summary", action),
		Body: map[string]any{}, Idempotent: true, Reversible: true,
		Note: "runs the AI over this conversation; counted against the AI budget",
	})
}

// ── Domains ────────────────────────────────────────────────────────

// UpdateDomain renames a domain or sets or clears its catch-all mailbox.
// patch holds displayName and/or catchAllMailbox (nil clears it).
func (c *Client) UpdateDomain(ctx context.Context, id string, patch map[string]any) (json.RawMessage, error) {
	route, err := domainPath(id)
	if err != nil {
		return nil, err
	}
	return c.mutateRaw(ctx, Request{
		Method: "PATCH", Path: route, Body: patch, Idempotent: true, Reversible: true,
		Note: "a catch-all mailbox receives mail for every unknown address on the domain",
	})
}

// ── Webhooks ───────────────────────────────────────────────────────

// GetWebhook returns one endpoint.
func (c *Client) GetWebhook(ctx context.Context, id string) (*Webhook, error) {
	if err := requireID("webhook", id); err != nil {
		return nil, err
	}
	var out struct {
		Webhook Webhook `json:"webhook"`
	}
	if err := c.get(ctx, path("webhooks", id), nil, &out); err != nil {
		return nil, err
	}
	return &out.Webhook, nil
}

// UpdateWebhook patches an endpoint. Re-enabling resets its failure count.
func (c *Client) UpdateWebhook(ctx context.Context, id string, patch map[string]any) (*Webhook, error) {
	if err := requireID("webhook", id); err != nil {
		return nil, err
	}
	if ev, ok := patch["events"].([]string); ok {
		if err := validateWebhookEvents(ev); err != nil {
			return nil, err
		}
	}
	var out struct {
		Webhook Webhook `json:"webhook"`
	}
	if _, err := c.mutate(ctx, Request{
		Method: "PATCH", Path: path("webhooks", id), Body: patch, Idempotent: true, Reversible: true,
	}, &out); err != nil {
		return nil, err
	}
	return &out.Webhook, nil
}

// RotateWebhookSecret replaces an endpoint's signing secret. The old secret
// stops working at once.
func (c *Client) RotateWebhookSecret(ctx context.Context, id string) (*WebhookWithSecret, error) {
	if err := requireID("webhook", id); err != nil {
		return nil, err
	}
	var out WebhookWithSecret
	if _, err := c.mutate(ctx, Request{
		Method: "POST", Path: path("webhooks", id, "rotate-secret"), Body: map[string]any{},
		Note: "the old signing secret stops working immediately",
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListWebhookEvents returns the event types and the retry policy.
func (c *Client) ListWebhookEvents(ctx context.Context) (json.RawMessage, error) {
	return c.getRaw(ctx, path("webhooks", "events"), nil)
}

// ── Suppressions and template sends ────────────────────────────────

// CheckSuppressions reports which addresses are suppressed. A read, though it
// is a POST.
func (c *Client) CheckSuppressions(ctx context.Context, addresses []string, from string) (json.RawMessage, error) {
	if len(addresses) == 0 {
		return nil, fail.Usagef("no addresses given")
	}
	body := map[string]any{"addresses": addresses}
	if from != "" {
		body["from"] = from
	}
	resp, err := c.Do(ctx, Request{
		Method: "POST", Path: path("suppressions", "check"), Body: body, Idempotent: true,
	})
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

// TemplateSend renders a template and sends one message per recipient.
type TemplateSend struct {
	Template   string            `json:"template"`
	From       string            `json:"from,omitempty"`
	Recipients []string          `json:"recipients"`
	Variables  map[string]string `json:"variables,omitempty"`
	Track      *bool             `json:"track,omitempty"`
}

// SendTemplate sends a template to each recipient. The server may hold the
// whole batch for approval (202 with approval_id).
func (c *Client) SendTemplate(ctx context.Context, mailbox string, in TemplateSend) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.Template) == "" {
		return nil, fail.Usagef("no template given")
	}
	if len(in.Recipients) == 0 {
		return nil, fail.Usagef("no recipients given").WithRemediation("pass --to (repeatable)")
	}
	return c.mutateRaw(ctx, Request{
		Method: "POST", Path: mailboxPath(mailbox, "template-sends"), Body: in, Keyed: true,
		Note: "sends one message to each recipient; suppressed addresses are skipped",
	})
}

// ── Products ───────────────────────────────────────────────────────

// CreateProduct creates a product. Administrator only.
func (c *Client) CreateProduct(ctx context.Context, in map[string]any) (*Product, error) {
	var out productEnvelope
	if _, err := c.mutate(ctx, Request{
		Method: "POST", Path: path("products"), Body: in, Reversible: true,
	}, &out); err != nil {
		return nil, err
	}
	return &out.Product, nil
}

// DeleteProduct deletes a product. Its domains do not get a new default.
func (c *Client) DeleteProduct(ctx context.Context, id string) (json.RawMessage, error) {
	route, err := productPath(id)
	if err != nil {
		return nil, err
	}
	return c.mutateRaw(ctx, Request{
		Method: "DELETE", Path: route, Idempotent: true,
		Note: "its domains and aliases are left without a product and its logo is deleted",
	})
}

// PutProductLogo uploads a product's raster logo.
func (c *Client) PutProductLogo(ctx context.Context, id string, logo LogoUpload) (json.RawMessage, error) {
	route, err := productPath(id, "logo")
	if err != nil {
		return nil, err
	}
	return c.mutateRaw(ctx, Request{
		Method: "PUT", Path: route, Body: logo, Idempotent: true, Reversible: true,
	})
}

// DeleteProductLogo removes a product's logo.
func (c *Client) DeleteProductLogo(ctx context.Context, id string) (json.RawMessage, error) {
	route, err := productPath(id, "logo")
	if err != nil {
		return nil, err
	}
	return c.mutateRaw(ctx, Request{
		Method: "DELETE", Path: route, Idempotent: true,
		Note: "deletes the logo; upload it again to restore it",
	})
}

// RefreshProductKnowledge fetches the product's knowledge URL into storage.
func (c *Client) RefreshProductKnowledge(ctx context.Context, id string) (json.RawMessage, error) {
	route, err := productPath(id, "knowledge", "refresh")
	if err != nil {
		return nil, err
	}
	return c.mutateRaw(ctx, Request{
		Method: "POST", Path: route, Body: map[string]any{}, Idempotent: true, Reversible: true,
		Note: "fetches the knowledge URL and replaces the stored copy",
	})
}

// ResolveProduct returns the product a From address resolves to.
func (c *Client) ResolveProduct(ctx context.Context, from string) (json.RawMessage, error) {
	if strings.TrimSpace(from) == "" {
		return nil, fail.Usagef("no address given")
	}
	return c.getRaw(ctx, path("products", "resolve"), NewQuery().Str("from", from))
}

// ── Search, tabs, follow-ups, config ───────────────────────────────

// SearchAll runs a hybrid search across every readable mailbox (up to 20).
func (c *Client) SearchAll(ctx context.Context, query, mode, folder, product string, mailboxes []string, limit int) (json.RawMessage, error) {
	if strings.TrimSpace(query) == "" {
		return nil, fail.Usagef("no query given")
	}
	if mode != "" && mode != "fts" && mode != "hybrid" {
		return nil, fail.Usagef("--mode must be fts or hybrid")
	}
	q := NewQuery().Str("q", query).Str("mode", mode).Str("folder", folder).Str("product", product).Int("limit", limit)
	for _, m := range mailboxes {
		q.v.Add("mailbox", m)
	}
	return c.getRaw(ctx, path("search"), q)
}

// ListInboxTabs returns a mailbox's split-inbox tabs.
func (c *Client) ListInboxTabs(ctx context.Context, mailbox string) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	return c.getRaw(ctx, mailboxPath(mailbox, "inbox-tabs"), nil)
}

// GetFollowup returns the reminder on a message or its thread.
func (c *Client) GetFollowup(ctx context.Context, mailbox, emailID string) (json.RawMessage, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("mail", emailID); err != nil {
		return nil, err
	}
	return c.getRaw(ctx, mailboxPath(mailbox, "emails", emailID, "followup"), nil)
}

// ── Streaming downloads ────────────────────────────────────────────

// Download streams a GET response body to w instead of buffering it. Used for
// payloads that can exceed the 8 MiB ceiling on ordinary responses, such as an
// account export. It is not retried: a partial write cannot be undone.
func (c *Client) Download(ctx context.Context, p string, q url.Values, w io.Writer) (int64, string, error) {
	req := Request{Method: "GET", Path: p, Query: q, Idempotent: true}
	full, err := c.url(p, q)
	if err != nil {
		return 0, "", err
	}
	httpReq, err := http.NewRequestWithContext(ctx, "GET", full, nil)
	if err != nil {
		return 0, "", fail.Usagef("cannot build a request for %s: %v", p, err).Wrap(err)
	}
	httpReq.Header.Set("Accept", "*/*")
	httpReq.Header.Set("User-Agent", UserAgent)
	c.authenticate(httpReq)

	// The overall timeout would cut a large download off part way; the context
	// still cancels it on Ctrl-C.
	hc := *c.http
	hc.Timeout = 0
	resp, err := hc.Do(httpReq)
	if err != nil {
		return 0, "", c.transportError(req, p, scrubURL(err, c.cfg.BaseURL+p))
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		// The signed token is in the query; keep it out of the error's URL.
		return 0, "", c.classify(req, c.cfg.BaseURL+p, resp, raw)
	}
	n, err := io.Copy(w, resp.Body)
	if err != nil {
		return n, "", c.transportError(req, p, err)
	}
	return n, resp.Header.Get("Content-Type"), nil
}

// scrubURL replaces the URL inside a *url.Error, which for a download carries a
// signed token in its query, so no wrapped error can print it.
func scrubURL(err error, safe string) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return &url.Error{Op: ue.Op, URL: safe, Err: ue.Err}
	}
	return err
}
