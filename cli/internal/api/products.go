package api

import (
	"context"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// Products and the unified inbox.
//
// A product is the identity a group of domains and aliases sends as: display
// name, accent colour, logo, signature, reply tone and knowledge for the agent.
// Every :id slot takes the product id (prd_...) or its slug.

// Product is one product as GET /products returns it. AgentPrompt and the
// knowledge fields are only filled in for administrators.
type Product struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Slug               string   `json:"slug"`
	Domains            []string `json:"domains"`
	Aliases            []string `json:"aliases"`
	DisplayName        *string  `json:"displayName"`
	AccentColor        *string  `json:"accentColor"`
	SignatureHTML      *string  `json:"signatureHtml"`
	DefaultTemplates   []string `json:"defaultTemplates"`
	LogoURL            *string  `json:"logoUrl"`
	AgentPrompt        *string  `json:"agentPrompt,omitempty"`
	KnowledgeText      *string  `json:"knowledgeText,omitempty"`
	KnowledgeURL       *string  `json:"knowledgeUrl,omitempty"`
	KnowledgeFetchedAt *int64   `json:"knowledgeFetchedAt,omitempty"`
	CreatedAt          int64    `json:"createdAt"`
	UpdatedAt          int64    `json:"updatedAt"`
}

// ProductPatch is the body of PATCH /products/:id. Nil fields are left alone;
// a pointer to "" clears a nullable text field.
type ProductPatch struct {
	Name             *string   `json:"name,omitempty"`
	DisplayName      *string   `json:"displayName,omitempty"`
	AccentColor      *string   `json:"accentColor,omitempty"`
	Domains          *[]string `json:"domains,omitempty"`
	Aliases          *[]string `json:"aliases,omitempty"`
	SignatureHTML    *string   `json:"signatureHtml,omitempty"`
	AgentPrompt      *string   `json:"agentPrompt,omitempty"`
	KnowledgeText    *string   `json:"knowledgeText,omitempty"`
	KnowledgeURL     *string   `json:"knowledgeUrl,omitempty"`
	DefaultTemplates *[]string `json:"defaultTemplates,omitempty"`
}

// Empty reports whether the patch changes nothing.
func (p ProductPatch) Empty() bool {
	return p.Name == nil && p.DisplayName == nil && p.AccentColor == nil && p.Domains == nil &&
		p.Aliases == nil && p.SignatureHTML == nil && p.AgentPrompt == nil && p.KnowledgeText == nil &&
		p.KnowledgeURL == nil && p.DefaultTemplates == nil
}

// MarshalBody turns empty strings into JSON null so a flag like
// --accent "" clears the field rather than failing validation.
func (p ProductPatch) body() map[string]any {
	out := map[string]any{}
	text := func(key string, v *string) {
		if v == nil {
			return
		}
		if strings.TrimSpace(*v) == "" && key != "name" {
			out[key] = nil
			return
		}
		out[key] = *v
	}
	text("name", p.Name)
	text("displayName", p.DisplayName)
	text("accentColor", p.AccentColor)
	text("signatureHtml", p.SignatureHTML)
	text("agentPrompt", p.AgentPrompt)
	text("knowledgeText", p.KnowledgeText)
	text("knowledgeUrl", p.KnowledgeURL)
	if p.Domains != nil {
		out["domains"] = *p.Domains
	}
	if p.Aliases != nil {
		out["aliases"] = *p.Aliases
	}
	if p.DefaultTemplates != nil {
		out["defaultTemplates"] = *p.DefaultTemplates
	}
	return out
}

type productEnvelope struct {
	Product Product `json:"product"`
}

func productPath(id string, rest ...string) (string, error) {
	seg, err := pathSegment("product", id)
	if err != nil {
		return "", err
	}
	return path(append([]string{"products", seg}, rest...)...), nil
}

// ListProducts returns every product.
func (c *Client) ListProducts(ctx context.Context) ([]Product, error) {
	var out struct {
		Products []Product `json:"products"`
	}
	if err := c.get(ctx, path("products"), nil, &out); err != nil {
		return nil, err
	}
	return out.Products, nil
}

// GetProduct returns one product by id or slug.
func (c *Client) GetProduct(ctx context.Context, id string) (*Product, error) {
	p, err := productPath(id)
	if err != nil {
		return nil, err
	}
	var out productEnvelope
	if err := c.get(ctx, p, nil, &out); err != nil {
		return nil, err
	}
	return &out.Product, nil
}

// UpdateProduct patches a product. Administrator only.
func (c *Client) UpdateProduct(ctx context.Context, id string, patch ProductPatch) (*Product, error) {
	if patch.Empty() {
		return nil, fail.Usagef("nothing to update").
			WithRemediation("pass at least one flag, such as --display-name or --signature-file")
	}
	route, err := productPath(id)
	if err != nil {
		return nil, err
	}
	var out productEnvelope
	_, err = c.mutate(ctx, Request{
		Method:     "PATCH",
		Path:       route,
		Body:       patch.body(),
		Idempotent: true,
		Reversible: true,
		Note:       "administrator only. Changes what this product's addresses sign and sound like",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out.Product, nil
}

// UnifiedOptions narrows GET /inbox.
type UnifiedOptions struct {
	Folder   string
	Limit    int
	Cursor   string
	Products []string
	Unread   *bool
	Starred  *bool
}

// UnifiedEmail is one row of the unified inbox: an Email plus the mailbox it
// belongs to and the product it sends as.
type UnifiedEmail struct {
	Email
	MailboxID string          `json:"mailboxId"`
	Product   *UnifiedProduct `json:"product"`
}

// UnifiedProduct is the badge a unified row carries.
type UnifiedProduct struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

// UnifiedList is the GET /inbox envelope.
type UnifiedList struct {
	Emails     []UnifiedEmail `json:"emails"`
	NextCursor *string        `json:"nextCursor"`
	Unread     int            `json:"unread"`
	Mailboxes  []string       `json:"mailboxes"`
	Truncated  []string       `json:"truncated"`
	Degraded   []string       `json:"degraded"`
}

// ListUnified returns conversations across every readable mailbox, newest
// first, capped server-side at 20 mailboxes.
func (c *Client) ListUnified(ctx context.Context, o UnifiedOptions) (*UnifiedList, error) {
	q := NewQuery().
		Str("folder", o.Folder).
		Int("limit", o.Limit).
		Str("cursor", o.Cursor).
		Str("product", strings.Join(o.Products, ",")).
		Bool("unread", o.Unread).
		Bool("starred", o.Starred)
	var out UnifiedList
	if err := c.get(ctx, path("inbox"), q, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
