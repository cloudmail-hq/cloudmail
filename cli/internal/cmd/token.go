package cmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

func newTokenCommand(a *App) *cobra.Command {
	c := group("token", "List, create and revoke API tokens", `
Personal API tokens (ttk_<id>_<secret>) for scripts, CI and agents.

A token can be narrowed with scopes and a mailbox allowlist. What it may do is the
intersection of three things: your own grants, its scopes, and its mailboxes. A
scope never adds anything you could not already do.

Scopes:
  mail:read          list, read and search mail, attachments, people, analytics
  mail:send          send, reply, forward, schedule; run sequences
  mail:send:auto     with mail:send: agent sends skip approval on mailboxes set to
                     send automatically (never implied; give it on purpose)
  approvals:manage   approve, edit and reject held sends from the CLI, never ones
                     this token or its parent/child tokens asked for (never implied)
  mail:draft         drafts and templates
  mail:organize      move, label, flag, snooze, delete
  mailboxes:manage   mailbox settings, rules, sender lists, delegates
  domains:manage     sending domains (administrators)
  webhooks:manage    webhooks
  admin              users, access grants, branding, migration (administrators)

A token with neither scopes nor mailboxes acts with your full access; every token
created before scopes existed works that way. A token limited by --mailbox alone
holds only the mail:* scopes: admin-class scopes are never implied.

From a browser session you can create any token. From an API token you can create
one only when that token is itself scoped, and the new one is never broader: its
scopes and mailboxes must be a subset, it expires no later, and revoking the
parent revokes it too.`,
		"cloudmail token list",
		"cloudmail token create ci-reader --scope mail:read --mailbox support@example.com",
		"cloudmail token revoke <token-id>",
	)
	c.AddCommand(tokenList(a), tokenCreate(a), tokenRevoke(a))
	return c
}

func tokenColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id"},
		{Header: "name", Field: "name", Truncate: 24},
		{Header: "scopes", Field: "scopes", Truncate: 40, Value: func(r map[string]any) string {
			return listOrAll(r["scopes"], "full access")
		}},
		{Header: "mailboxes", Field: "mailboxes", Truncate: 36, Value: func(r map[string]any) string {
			return listOrAll(r["mailboxes"], "all")
		}},
		{Header: "last used", Field: "lastUsedAt", Value: func(r map[string]any) string {
			s := msTime(r["lastUsedAt"], "never")
			if ip, ok := r["lastUsedIp"].(string); ok && ip != "" {
				s += " from " + ip
			}
			return s
		}},
		{Header: "expires", Field: "expiresAt", Value: func(r map[string]any) string {
			return msTime(r["expiresAt"], "never")
		}},
	}
}

// listOrAll renders a JSON array as a comma list, and null as `all`.
func listOrAll(v any, all string) string {
	items, ok := v.([]any)
	if !ok {
		return all
	}
	if len(items) == 0 {
		return "none"
	}
	parts := make([]string, 0, len(items))
	for _, it := range items {
		parts = append(parts, fmt.Sprint(it))
	}
	return strings.Join(parts, ",")
}

// msTime renders epoch milliseconds as a UTC date-time.
func msTime(v any, none string) string {
	f, ok := v.(float64)
	if !ok || f == 0 {
		return none
	}
	return time.UnixMilli(int64(f)).UTC().Format("2006-01-02 15:04Z")
}

func tokenList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List your API tokens",
		Long: strings.TrimSpace(`
List unrevoked tokens with their scopes, mailboxes and when they were last used.
Expired tokens are included so you can see why one stopped working.

Called with a scoped token, this lists only that token and the tokens it created.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			tokens, err := a.Client.ListTokens(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    tokens,
				Columns: tokenColumns(),
				Empty:   "no tokens -- create one with `cloudmail token create <name>`",
			})
		},
	}
}

func tokenCreate(a *App) *cobra.Command {
	var scopes, mailboxes []string
	var days int
	c := &cobra.Command{
		Use:   "create <name>",
		Short: "Create an API token",
		Long: strings.TrimSpace(`
Create a token and print its secret, once.

--scope and --mailbox may be repeated or comma-separated. Leave out both for a
token with your full access. With --mailbox but no --scope, the token gets the
mail scopes only (mail:read, mail:send, mail:draft, mail:organize) and no
admin-class scope; list admin, domains:manage, webhooks:manage or
mailboxes:manage explicitly if it needs them. From a scoped token, leaving out
--scope copies that token's scopes.

Scopes: ` + strings.Join(api.TokenScopes, ", ")),
		Example: exampleBlock(
			"cloudmail token create ci-reader --scope mail:read",
			"cloudmail token create support-bot --scope mail:read,mail:send --mailbox support@example.com",
			"cloudmail token create nightly --scope mail:read --expires-in 30",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			in := api.TokenInput{Name: args[0], ExpiresInDays: days}
			if c.Flags().Changed("scope") {
				in.Scopes = splitList(scopes)
				if len(in.Scopes) == 0 {
					return fail.Usagef("--scope was given but names no scope").
						WithRemediation("one of: %s", strings.Join(api.TokenScopes, ", "))
				}
			}
			if c.Flags().Changed("mailbox") {
				in.Mailboxes = splitList(mailboxes)
				if len(in.Mailboxes) == 0 {
					return fail.Usagef("--mailbox was given but names no mailbox")
				}
			}
			created, err := a.Client.CreateToken(a.Ctx(c), in)
			if err != nil {
				return err
			}
			if created == nil || created.Secret == "" {
				// --dry-run: nothing was created.
				return a.emitMutation(output.Result{})
			}
			a.Out.Warn("copy the secret now; it is not shown again")
			return a.emitMutation(output.Result{
				Data: map[string]any{
					"id":        created.Token.ID,
					"name":      created.Token.Name,
					"scopes":    created.Token.Scopes,
					"mailboxes": created.Token.Mailboxes,
					"expiresAt": created.Token.ExpiresAt,
					"secret":    created.Secret,
				},
				Summary: fmt.Sprintf("created token %s (%s)", created.Token.Name, created.Token.ID),
			})
		},
	}
	c.Flags().StringSliceVar(&scopes, "scope", nil, "limit the token to these scopes (repeatable)")
	c.Flags().StringSliceVar(&mailboxes, "mailbox", nil, "limit the token to these mailboxes (repeatable)")
	c.Flags().IntVar(&days, "expires-in", 90, "days until the token expires; 0 for never")
	return c
}

func tokenRevoke(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "revoke <token-id>",
		Short: "Revoke an API token",
		Long: strings.TrimSpace(`
Revoke a token by its id (the middle part of ttk_<id>_<secret>, shown by
` + "`token list`" + `). Anything using it stops working on its next request, and so
does every token it created. This cannot be undone.

A scoped token can revoke only itself and tokens it created.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf("revoke token %s and any tokens it created", args[0]), true); err != nil {
				return err
			}
			if err := a.Client.RevokeToken(a.Ctx(c), args[0]); err != nil {
				return err
			}
			return a.emitMutation(output.Result{
				Data:    map[string]any{"id": args[0], "revoked": true},
				Summary: fmt.Sprintf("revoked token %s", args[0]),
			})
		},
	}
}

// splitList flattens repeated and comma-separated flag values, trimming blanks.
func splitList(in []string) []string {
	out := []string{}
	for _, v := range in {
		for _, part := range strings.Split(v, ",") {
			if p := strings.TrimSpace(part); p != "" {
				out = append(out, p)
			}
		}
	}
	return out
}
