package cmd

import (
	"fmt"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

func newApprovalCommand(a *App) *cobra.Command {
	c := group("approval", "Review API-token, connected-app and agent sends waiting for approval", `
When a mailbox's agent send mode is "approve" (the default), a message that an API
token, a connected (MCP/OAuth) app or the in-app assistant asks to send waits here
instead of going out. You see who asked, the recipients and the message exactly as
it will be sent, and approve, edit or reject it.

Approving sends the stored message, exactly once: approving again reports that it
was already decided and sends nothing. A send that may have reached the provider
but was not confirmed is shown as sent_unconfirmed and is never sent again.

Deciding from the CLI needs a token with the approvals:manage scope, and that
token can never decide a send that it, its parent or a token it created asked
for. The app (a signed-in browser) can always decide.

Change the mode, or the recipients that skip approval, in the app's mailbox
settings; API tokens cannot change it.`,
		"cloudmail approval list",
		"cloudmail approval show apr_xxxxxxxxxxxxxxxxxxxx",
		"cloudmail approval edit apr_xxxxxxxxxxxxxxxxxxxx --subject \"Re: your invoice\"",
		"cloudmail approval approve apr_xxxxxxxxxxxxxxxxxxxx",
		"cloudmail approval revise apr_xxxxxxxxxxxxxxxxxxxx --body-file fixed.html",
		"cloudmail approval reject apr_xxxxxxxxxxxxxxxxxxxx --note \"wrong customer\"",
	)

	var status string
	list := &cobra.Command{
		Use:   "list",
		Short: "List held sends",
		Long:  "List sends waiting for approval, newest first. --status shows decided ones too.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			items, err := a.Client.ListApprovals(a.Ctx(c), mb, status, a.pageLimit(0))
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:      items,
				Columns:   approvalColumns(),
				Summary:   fmt.Sprintf("%d %s approval(s) in %s", len(items), status, mb),
				Untrusted: []string{"subject"},
				Empty:     "nothing waiting for approval",
			})
		},
	}
	list.Flags().StringVar(&status, "status", "pending", "which: "+strings.Join(api.ApprovalStatuses, ", "))

	show := &cobra.Command{
		Use:   "show <approval-id>",
		Short: "Show one held send in full",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			item, err := a.Client.GetApproval(a.Ctx(c), mb, args[0])
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: item, Untrusted: []string{"subject", "messages", "enrollment"}})
		},
	}

	var (
		to, cc        []string
		subject, body string
	)
	edit := &cobra.Command{
		Use:   "edit <approval-id>",
		Short: "Change a held message before approving it",
		Long: strings.TrimSpace(`
Save changes to a pending single-message approval: --to, --cc, --subject and
--body-file (HTML). A new body is checked the same way an agent's is, and the
result replaces the stored message. Nothing is sent; run approve afterwards.
Review it with show first.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			edits := api.ApprovalEdits{To: to, Cc: cc}
			if c.Flags().Changed("subject") {
				edits.Subject = &subject
			}
			if c.Flags().Changed("body-file") {
				data, err := readBody("", body)
				if err != nil {
					return err
				}
				edits.HTML = &data
			}
			if edits.Empty() {
				return fail.Usagef("nothing to change: give --to, --cc, --subject or --body-file")
			}
			out, err := a.Client.EditApproval(a.Ctx(c), mb, args[0], edits)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{
				Data:      out,
				Summary:   fmt.Sprintf("saved %s; not sent. Review with show, then approve", out.Approval.ID),
				Untrusted: []string{"approval"},
			})
		},
	}
	edit.Flags().StringSliceVar(&to, "to", nil, "replace the recipients")
	edit.Flags().StringSliceVar(&cc, "cc", nil, "replace the Cc list")
	edit.Flags().StringVar(&subject, "subject", "", "replace the subject")
	edit.Flags().StringVar(&body, "body-file", "", "replace the HTML body with this file's contents (- for stdin)")

	var revision int
	approve := &cobra.Command{
		Use:   "approve <approval-id>",
		Short: "Approve and send a held message exactly as stored",
		Long: strings.TrimSpace(`
Send the held message now, exactly as show displays it (open and click tracking
are added at send). Change it first with edit. Asks for confirmation unless --yes
is given, because a sent message cannot be recalled.

approve sends the revision it fetched (or --revision, the one you reviewed with
show). If the requester revised the message after that, the server sends nothing
and this exits 5: review the new version with show, then approve again.`),
		Example: exampleBlock(
			"cloudmail approval approve apr_xxxxxxxxxxxxxxxxxxxx",
			"# Approve only the revision you reviewed",
			"cloudmail approval approve apr_xxxxxxxxxxxxxxxxxxxx --revision 2",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			// Refuse an unattended run before reading anything, so a script
			// without --yes gets the consent error rather than a network one.
			if err := a.canConfirm("sending a held message"); err != nil {
				return err
			}
			rev := revision
			prompt := fmt.Sprintf("sending held message %s (revision %d)", args[0], rev)
			if !c.Flags().Changed("revision") {
				// Pin the version that is about to be described to the person
				// confirming, so a revision landing between this read and the
				// approve is refused rather than sent unseen.
				item, err := a.Client.GetApproval(a.Ctx(c), mb, args[0])
				if err != nil {
					return err
				}
				rev = item.Revision
				prompt = fmt.Sprintf("sending held message %s (revision %d) to %s, subject %q",
					item.ID, item.Revision, strings.Join(item.Recipients, ", "), item.Subject)
			} else if rev < 1 {
				return fail.Usagef("--revision must be 1 or more")
			}
			if err := a.Confirm(prompt, true); err != nil {
				return err
			}
			out, err := a.Client.ApproveApproval(a.Ctx(c), mb, args[0], rev)
			if err != nil {
				return a.staleRevisionError(c, err, mb, args[0], rev)
			}
			return a.emitMutation(output.Result{
				Data:    out,
				Summary: fmt.Sprintf("approved %s: %s to %s", out.Approval.ID, out.Approval.Status, strings.Join(out.Approval.Recipients, ", ")),
			})
		},
	}
	approve.Flags().IntVar(&revision, "revision", 0, "the revision you reviewed; refused if it has been revised since (default: the current one, fetched first)")

	var (
		rto, rcc        []string
		rsubject, rbody string
	)
	revise := &cobra.Command{
		Use:   "revise <approval-id>",
		Short: "Revise your own held send in place",
		Long: strings.TrimSpace(`
Replace a pending send that this credential asked for: --to, --cc, --subject and
--body-file (HTML). Only the API token or app that requested the send can revise
it. It stays pending, its revision goes up by one, and an approver still holding
the old revision is refused, so nobody approves text they have not seen.

Recipients are checked against the same rules a new send would face. Nothing is
sent.`),
		Example: exampleBlock(
			"cloudmail approval revise apr_xxxxxxxxxxxxxxxxxxxx --subject \"Re: your invoice (corrected)\"",
			"cloudmail approval revise apr_xxxxxxxxxxxxxxxxxxxx --body-file reply.html",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			edits := api.ApprovalEdits{To: rto, Cc: rcc}
			if c.Flags().Changed("subject") {
				edits.Subject = &rsubject
			}
			if c.Flags().Changed("body-file") {
				data, err := readBody("", rbody)
				if err != nil {
					return err
				}
				edits.HTML = &data
			}
			if edits.Empty() {
				return fail.Usagef("nothing to change: give --to, --cc, --subject or --body-file")
			}
			out, err := a.Client.ReviseApproval(a.Ctx(c), mb, args[0], edits)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{
				Data:      out,
				Summary:   fmt.Sprintf("revised %s (now revision %d); still waiting for approval", out.Approval.ID, out.Approval.Revision),
				Untrusted: []string{"approval"},
			})
		},
	}
	revise.Flags().StringSliceVar(&rto, "to", nil, "replace the recipients")
	revise.Flags().StringSliceVar(&rcc, "cc", nil, "replace the Cc list")
	revise.Flags().StringVar(&rsubject, "subject", "", "replace the subject")
	revise.Flags().StringVar(&rbody, "body-file", "", "replace the HTML body with this file's contents (- for stdin)")

	retry := &cobra.Command{
		Use:   "retry <approval-id>",
		Short: "Put a failed send back in the queue",
		Long: strings.TrimSpace(`
Reopen an approved send whose provider refused it (status failed), so it waits
for approval again. Nothing is sent until it is approved. A sent_unconfirmed
send may already have been delivered and is refused (exit 5).`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			out, err := a.Client.RetryApproval(a.Ctx(c), mb, args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{
				Data:    out,
				Summary: fmt.Sprintf("%s is pending again; approve it to send", out.Approval.ID),
			})
		},
	}

	count := &cobra.Command{
		Use:   "count",
		Short: "How many sends are waiting",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			n, err := a.Client.CountApprovals(a.Ctx(c), mb)
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    map[string]any{"mailbox": mb, "pending": n},
				Summary: fmt.Sprintf("%d waiting in %s", n, mb),
			})
		},
	}

	var rejectNote string
	reject := &cobra.Command{
		Use:   "reject <approval-id>",
		Short: "Reject a held send; nothing is sent",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			out, err := a.Client.RejectApproval(a.Ctx(c), mb, args[0], rejectNote)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{
				Data:    out,
				Summary: fmt.Sprintf("rejected %s; nothing was sent", out.Approval.ID),
			})
		},
	}
	reject.Flags().StringVar(&rejectNote, "note", "", "why, for the audit log")

	c.AddCommand(list, count, show, edit, revise, approve, reject, retry)
	return c
}

func approvalColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 26},
		{Header: "kind", Field: "kind", Truncate: 14},
		{Header: "status", Field: "status", Truncate: 9},
		{Header: "to", Field: "recipients", Truncate: 36, Value: func(r map[string]any) string {
			list, _ := r["recipients"].([]any)
			parts := make([]string, 0, len(list))
			for _, v := range list {
				if s, ok := v.(string); ok {
					parts = append(parts, s)
				}
			}
			return strings.Join(parts, ", ")
		}},
		{Header: "subject", Field: "subject", Truncate: 40},
		{Header: "requested by", Field: "requested_by", Truncate: 28, Value: func(r map[string]any) string {
			return requesterName(r["requested_by"])
		}},
	}
}

// requesterName names the token or connected app behind a held send.
func requesterName(v any) string {
	m, _ := v.(map[string]any)
	str := func(k string) string { s, _ := m[k].(string); return s }
	switch {
	case str("via") == "agent":
		return "in-app assistant"
	case str("oauthClientName") != "":
		return str("oauthClientName") + " (app)"
	case str("tokenName") != "":
		return str("tokenName") + " (token)"
	case str("tokenId") != "":
		return str("tokenId") + " (token)"
	}
	return "MCP client"
}

// staleRevisionError turns the server's "changed after you opened it" 409 into
// an instruction to review the new version. Other errors pass through.
//
// The server's 409 carries no machine-readable code, so the item is read back:
// still pending at a revision other than the one sent means it changed. The
// message check is only the fallback when that read fails.
func (a *App) staleRevisionError(c *cobra.Command, err error, mb, id string, sent int) error {
	e := fail.AsError(err)
	if e == nil || e.Status != 409 {
		return err
	}
	revised := false
	if item, gerr := a.Client.GetApproval(a.Ctx(c), mb, id); gerr == nil {
		revised = item.Status == "pending" && sent > 0 && item.Revision != sent
	} else {
		revised = strings.Contains(strings.ToLower(e.Message), "changed")
	}
	if !revised {
		return err
	}
	e.Code = "APPROVAL_REVISED"
	e.Message = "the held message was revised after you reviewed it; nothing was sent"
	e.Remediation = fmt.Sprintf("review the new version with `cloudmail approval show %s`, "+
		"then run approve again (it sends the revision show displays)", id)
	return e
}
