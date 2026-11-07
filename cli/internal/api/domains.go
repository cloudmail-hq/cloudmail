package api

import (
	"context"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// Domains and mailbox aliases.
//
// A domain is a hostname this deployment receives mail for. The routes are
// administrator-only, and every :id slot accepts either the domain id (dom_...)
// or the hostname, so a caller never has to look one up to use the other.

// Domain is one hostname the deployment serves.
type Domain struct {
	ID                 string      `json:"id"`
	Hostname           string      `json:"hostname"`
	DisplayName        string      `json:"displayName"`
	ZoneID             *string     `json:"zoneId"`
	Status             string      `json:"status"`
	RoutingStatus      *string     `json:"routingStatus"`
	SendingStatus      *string     `json:"sendingStatus"`
	SendingSubdomainID *string     `json:"sendingSubdomainId"`
	DKIM               *DomainDKIM `json:"dkim"`
	CatchAllMailbox    *string     `json:"catchAllMailbox"`
	// Source is "env" for a domain seeded from the DOMAINS/ZONES configuration,
	// which cannot be deleted while it is still listed there, or "api".
	Source        string  `json:"source"`
	LastError     *string `json:"lastError"`
	CreatedAt     int64   `json:"createdAt"`
	UpdatedAt     int64   `json:"updatedAt"`
	LastCheckedAt *int64  `json:"lastCheckedAt"`
	MailboxCount  int     `json:"mailboxCount"`
}

// DomainDKIM is the DKIM selector the sending setup publishes.
type DomainDKIM struct {
	Selector string  `json:"selector"`
	Name     string  `json:"name"`
	Value    *string `json:"value"`
}

// DNSRecord is one record the domain needs, for routing, sending or DMARC.
type DNSRecord struct {
	Purpose  string `json:"purpose"`
	Type     string `json:"type"`
	Name     string `json:"name"`
	Value    string `json:"value"`
	Priority *int   `json:"priority,omitempty"`
	Note     string `json:"note,omitempty"`
}

// AuditCheck is one DNS check and its verdict.
type AuditCheck struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Type     string   `json:"type"`
	Name     string   `json:"name"`
	Status   string   `json:"status"`
	Expected string   `json:"expected"`
	Found    []string `json:"found"`
	Message  string   `json:"message"`
}

// DomainAudit is the result of checking a domain's live DNS.
type DomainAudit struct {
	CheckedAt int64        `json:"checkedAt"`
	Summary   string       `json:"summary"`
	Checks    []AuditCheck `json:"checks"`
}

// ProvisionStep is one step of automatic Cloudflare setup.
type ProvisionStep struct {
	Step   string `json:"step"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

// DomainProvision is the outcome of a provisioning run.
type DomainProvision struct {
	OK    bool            `json:"ok"`
	RanAt int64           `json:"ranAt"`
	Steps []ProvisionStep `json:"steps"`
}

// CloudflareInfo says whether the deployment can call the Cloudflare API itself.
type CloudflareInfo struct {
	Configured       bool   `json:"configured"`
	WorkerScriptName string `json:"workerScriptName"`
}

// DomainList is the GET /domains envelope.
type DomainList struct {
	Domains    []Domain       `json:"domains"`
	Cloudflare CloudflareInfo `json:"cloudflare"`
}

// DomainDetail is the GET /domains/:id envelope.
type DomainDetail struct {
	Domain      Domain           `json:"domain"`
	Records     []DNSRecord      `json:"records"`
	ManualSteps []string         `json:"manualSteps"`
	Audit       *DomainAudit     `json:"audit"`
	Provision   *DomainProvision `json:"provision"`
	Cloudflare  CloudflareInfo   `json:"cloudflare"`
}

// DomainVerifyResult is the POST /domains/:id/verify envelope.
type DomainVerifyResult struct {
	Domain Domain       `json:"domain"`
	Audit  *DomainAudit `json:"audit"`
}

// DomainProvisionResult is the POST /domains/:id/provision envelope.
type DomainProvisionResult struct {
	Domain    Domain           `json:"domain"`
	Provision *DomainProvision `json:"provision"`
}

// DomainInput is the body of POST /domains.
type DomainInput struct {
	Hostname        string `json:"hostname"`
	DisplayName     string `json:"displayName,omitempty"`
	ZoneID          string `json:"zoneId,omitempty"`
	CatchAllMailbox string `json:"catchAllMailbox,omitempty"`
}

type domainEnvelope struct {
	Domain Domain `json:"domain"`
}

type aliasEnvelope struct {
	Aliases []string `json:"aliases"`
}

func domainPath(id string, rest ...string) (string, error) {
	seg, err := pathSegment("domain", id)
	if err != nil {
		return "", err
	}
	return path(append([]string{"domains", seg}, rest...)...), nil
}

// validateHostname refuses a hostname that could not be a domain before it is
// sent, so a typo comes back as a usage error naming the problem rather than a
// 400 from the server.
func validateHostname(h string) (string, error) {
	t := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(h), "."))
	switch {
	case t == "":
		return "", fail.Usagef("no hostname given")
	case strings.ContainsAny(t, "\x00\r\n\t /@"):
		return "", fail.Usagef("%q is not a hostname", h).
			WithRemediation("pass a bare domain such as example.com, without a scheme, path or @")
	case !strings.Contains(t, "."):
		return "", fail.Usagef("%q is not a fully qualified domain", h).
			WithRemediation("pass the full domain, such as example.com")
	}
	return t, nil
}

// ListDomains returns every domain the deployment serves.
func (c *Client) ListDomains(ctx context.Context) (*DomainList, error) {
	var out DomainList
	if err := c.get(ctx, path("domains"), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetDomain returns one domain with its DNS records, manual steps and the last
// audit and provisioning results.
func (c *Client) GetDomain(ctx context.Context, id string) (*DomainDetail, error) {
	p, err := domainPath(id)
	if err != nil {
		return nil, err
	}
	var out DomainDetail
	if err := c.get(ctx, p, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateDomain adds a domain. Adding it does not touch DNS; run VerifyDomain or
// ProvisionDomain afterwards.
func (c *Client) CreateDomain(ctx context.Context, in DomainInput) (*Domain, error) {
	host, err := validateHostname(in.Hostname)
	if err != nil {
		return nil, err
	}
	in.Hostname = host
	if in.CatchAllMailbox != "" {
		if err := validateAddress(in.CatchAllMailbox); err != nil {
			return nil, err
		}
	}
	var out domainEnvelope
	_, err = c.mutate(ctx, Request{
		Method:     "POST",
		Path:       path("domains"),
		Keyed:      true,
		Body:       in,
		Idempotent: false,
		Reversible: true,
		Note: "administrator only. Adds the domain record; DNS and Email Routing are " +
			"not changed until `cloudmail domain provision` runs",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out.Domain, nil
}

// DeleteDomain removes a domain. The server refuses (409) while the domain is
// still seeded from configuration or still has mailboxes.
func (c *Client) DeleteDomain(ctx context.Context, id string) (*StatusResult, error) {
	route, err := domainPath(id)
	if err != nil {
		return nil, err
	}
	var out struct {
		OK bool `json:"ok"`
	}
	resp, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       route,
		Idempotent: true,
		Reversible: true,
		Note: "removes the domain record. Refused while mailboxes exist on it or while " +
			"it is listed in the deployment's DOMAINS configuration",
	}, &out)
	if err != nil {
		return nil, err
	}
	if resp.Preview != nil {
		return &StatusResult{}, nil
	}
	ok := out.OK
	return &StatusResult{Status: "deleted", Success: &ok}, nil
}

// VerifyDomain checks the domain's live DNS against what it needs.
//
// A POST because the server records the result, but it changes nothing in DNS,
// so it is safe to repeat.
func (c *Client) VerifyDomain(ctx context.Context, id string) (*DomainVerifyResult, error) {
	route, err := domainPath(id, "verify")
	if err != nil {
		return nil, err
	}
	var out DomainVerifyResult
	_, err = c.mutate(ctx, Request{
		Method:     "POST",
		Path:       route,
		Idempotent: true,
		Reversible: true,
		Note:       "reads live DNS and records the audit; nothing in DNS is changed",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ProvisionDomain asks the deployment to configure Cloudflare for the domain:
// zone lookup, Email Routing, the catch-all rule and sending.
//
// Needs CF_API_TOKEN on the deployment; without it the server answers 412 and
// the records have to be created by hand (see GetDomain's manualSteps).
// ProvisionOptions are the opt-ins a provisioning run may carry.
type ProvisionOptions struct {
	// OverwriteCatchAll replaces an existing catch-all rule, even a disabled one.
	OverwriteCatchAll bool
	// ConfirmEnvDomain is required for a domain that comes from DOMAINS/ZONES,
	// which is already live; without it the server answers 428.
	ConfirmEnvDomain bool
}

func (c *Client) ProvisionDomain(
	ctx context.Context, id string, opts ProvisionOptions,
) (*DomainProvisionResult, error) {
	route, err := domainPath(id, "provision")
	if err != nil {
		return nil, err
	}
	overwriteCatchAll := opts.OverwriteCatchAll
	body := map[string]any{}
	if overwriteCatchAll {
		body["overwriteCatchAll"] = true
	}
	if opts.ConfirmEnvDomain {
		body["confirmEnvDomain"] = true
	}
	note := "changes Cloudflare DNS and Email Routing for the domain. An existing " +
		"catch-all rule is left alone"
	if overwriteCatchAll {
		note = "changes Cloudflare DNS and Email Routing for the domain, and REPLACES " +
			"any existing catch-all routing rule"
	}
	var out DomainProvisionResult
	_, err = c.mutate(ctx, Request{
		Method:     "POST",
		Path:       route,
		Body:       body,
		Idempotent: true,
		Reversible: !overwriteCatchAll,
		Note:       note,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// MailboxAliases returns the extra addresses a mailbox may send as.
func (c *Client) MailboxAliases(ctx context.Context, mailbox string) ([]string, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out aliasEnvelope
	if err := c.get(ctx, mailboxPath(mailbox, "aliases"), nil, &out); err != nil {
		return nil, err
	}
	if out.Aliases == nil {
		out.Aliases = []string{}
	}
	return out.Aliases, nil
}

// SetMailboxAliases replaces a mailbox's alias list. Administrator only.
//
// A whole-list write: anything absent from aliases is removed. An empty list
// clears them all.
func (c *Client) SetMailboxAliases(
	ctx context.Context, mailbox string, aliases []string,
) ([]string, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	clean := make([]string, 0, len(aliases))
	for _, a := range aliases {
		if err := validateAddress(a); err != nil {
			return nil, err
		}
		clean = append(clean, strings.TrimSpace(a))
	}
	var out aliasEnvelope
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       mailboxPath(mailbox, "aliases"),
		Body:       map[string]any{"aliases": clean},
		Idempotent: true,
		Reversible: true,
		Note:       "replaces the whole alias list; aliases not named here are removed",
	}, &out)
	if err != nil {
		return nil, err
	}
	if out.Aliases == nil {
		out.Aliases = []string{}
	}
	return out.Aliases, nil
}
