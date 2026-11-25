package cmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/config"
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

A send is held unless the mailbox's mode is auto AND the token holds
mail:send:auto, or every recipient is on the mailbox's skip-approval list. In
approve mode (the default) mail:send:auto alone does not skip approval. See
yours with "cloudmail approval policy". Change the mode, or the recipients that
skip approval, in the app's mailbox settings; API tokens cannot change it.`,
		"cloudmail approval list                      # every mailbox you can read",
		"cloudmail approval show apr_xxxxxxxxxxxxxxxxxxxx",
		"cloudmail approval wait apr_xxxxxxxxxxxxxxxxxxxx --timeout 10m",
		"cloudmail approval policy                    # will my sends be held?",
		"cloudmail approval edit apr_xxxxxxxxxxxxxxxxxxxx --subject \"Re: your invoice\"",
		"cloudmail approval approve apr_xxxxxxxxxxxxxxxxxxxx",
		"cloudmail approval revise apr_xxxxxxxxxxxxxxxxxxxx --body-file fixed.html",
		"cloudmail approval reject apr_xxxxxxxxxxxxxxxxxxxx --note \"wrong customer\"",
	)

	var (
		status  string
		listAll bool
	)
	list := &cobra.Command{
		Use:   "list",
		Short: "List held sends",
		Long: strings.TrimSpace(`
List sends waiting for approval, newest first. --status shows decided ones too.

Without --mailbox on the command line this lists every mailbox you can read,
naming the mailbox on each row, because a held send waits in whichever mailbox
it was sent from. --mailbox X lists only X. --all forces every mailbox even
when a default mailbox is configured.`),
		Example: exampleBlock(
			"cloudmail approval list",
			"cloudmail approval list --mailbox support@example.com",
			"cloudmail approval list --status all --output json",
		),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			if listAll || !a.mailboxExplicit {
				res, err := a.Client.ListAllApprovals(a.Ctx(c), status, a.pageLimit(0))
				if err == nil {
					where := fmt.Sprintf("%d mailbox(es)", len(res.MailboxesChecked))
					if len(res.MailboxesChecked) == 1 {
						where = res.MailboxesChecked[0]
					}
					if res.Truncated {
						a.Out.Warn("you can read more than %d mailboxes; only the first %d were checked. Pass --mailbox for the others", len(res.MailboxesChecked), len(res.MailboxesChecked))
					}
					return a.emit(output.Result{
						Data:      res.Approvals,
						Columns:   approvalColumnsWithMailbox(),
						Summary:   fmt.Sprintf("%d %s approval(s) in %s", len(res.Approvals), status, where),
						Untrusted: []string{"subject"},
						Empty:     fmt.Sprintf("nothing %s in %s", statusWord(status), where),
					})
				}
				// An older deployment has no cross-mailbox route: fall back to the
				// default mailbox, and say that is what was checked.
				if fe := fail.AsError(err); fe == nil || fe.ExitCode() != fail.NotFound || listAll {
					return err
				}
			}
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
				Empty:     fmt.Sprintf("nothing %s in %s (only this mailbox was checked; drop --mailbox to check every mailbox you can read)", statusWord(status), mb),
			})
		},
	}
	list.Flags().BoolVar(&listAll, "all", false, "every mailbox you can read, even with a default mailbox configured")
	list.Flags().StringVar(&status, "status", "pending", "which: "+strings.Join(api.ApprovalStatuses, ", "))

	show := &cobra.Command{
		Use:   "show <approval-id>",
		Short: "Show one held send in full",
		Args:  cobra.ExactArgs(1),
		Long: strings.TrimSpace(`
Show one held send: the message exactly as approving sends it, its approval_url
(the page that opens it directly), its status and, once sent, each message's id
and delivery status. Without --mailbox the id is looked up in every mailbox you
can read.`),
		RunE: func(c *cobra.Command, args []string) error {
			item, err := a.getApproval(c, args[0])
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: item, Untrusted: []string{"subject", "messages", "enrollment"}})
		},
	}

	var (
		to, cc             []string
		subject, body, mdf string
	)
	edit := &cobra.Command{
		Use:   "edit <approval-id>",
		Short: "Change a held message before approving it",
		Long: strings.TrimSpace(`
Save changes to a pending single-message approval: --to, --cc, --subject, and a
new body as --body-file (HTML) or --markdown-file (Markdown, rendered to HTML by
the server). A new body is checked the same way an agent's is, and the result
replaces the stored message. Nothing is sent; run approve afterwards. Review it
with show first.`),
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
			if err := readApprovalBody(c, &edits, body, mdf); err != nil {
				return err
			}
			if edits.Empty() {
				return fail.Usagef("nothing to change: give --to, --cc, --subject, --body-file or --markdown-file")
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
	edit.Flags().StringVar(&mdf, "markdown-file", "", "replace the body with this Markdown file, rendered by the server (- for stdin)")
	edit.MarkFlagsMutuallyExclusive("body-file", "markdown-file")

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
		rto, rcc              []string
		rsubject, rbody, rmdf string
	)
	revise := &cobra.Command{
		Use:   "revise <approval-id>",
		Short: "Revise your own held send in place",
		Long: strings.TrimSpace(`
Replace a pending send that this credential asked for: --to, --cc, --subject, and
a new body as --body-file (HTML) or --markdown-file (Markdown, rendered to HTML by
the server). Only the API token or app that requested the send can revise it. It stays pending, its revision goes up by one, and an approver still holding
the old revision is refused, so nobody approves text they have not seen.

Recipients are checked against the same rules a new send would face. Nothing is
sent.`),
		Example: exampleBlock(
			"cloudmail approval revise apr_xxxxxxxxxxxxxxxxxxxx --subject \"Re: your invoice (corrected)\"",
			"cloudmail approval revise apr_xxxxxxxxxxxxxxxxxxxx --body-file reply.html",
			"cloudmail approval revise apr_xxxxxxxxxxxxxxxxxxxx --markdown-file reply.md",
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
			if err := readApprovalBody(c, &edits, rbody, rmdf); err != nil {
				return err
			}
			if edits.Empty() {
				return fail.Usagef("nothing to change: give --to, --cc, --subject, --body-file or --markdown-file")
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
	revise.Flags().StringVar(&rmdf, "markdown-file", "", "replace the body with this Markdown file, rendered by the server (- for stdin)")
	revise.MarkFlagsMutuallyExclusive("body-file", "markdown-file")

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

	var (
		waitTimeout  string
		waitInterval string
	)
	wait := &cobra.Command{
		Use:   "wait <approval-id>",
		Short: "Wait until a person decides a held send",
		Long: strings.TrimSpace(`
Poll a held send until it leaves pending, then print it and exit:

  0  sent (the approval record names the sent message and its delivery status)
  4  rejected; nothing was sent
  5  failed, sent_unconfirmed or expired; read the error field
  8  still pending when --timeout ran out (nothing was decided yet)

An agent can hold a send, give the person the approval_url, and run this to
report the outcome instead of leaving it open. Without --mailbox the id is
found in whichever mailbox you can read holds it.`),
		Example: exampleBlock(
			"cloudmail approval wait apr_xxxxxxxxxxxxxxxxxxxx --timeout 10m",
			"cloudmail approval wait apr_xxxxxxxxxxxxxxxxxxxx --timeout 1h --interval 30s --output json",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			timeout, err := config.ParseDuration(waitTimeout)
			if err != nil {
				return fail.Usagef("--timeout: %s", err.Error())
			}
			interval, err := config.ParseDuration(waitInterval)
			if err != nil {
				return fail.Usagef("--interval: %s", err.Error())
			}
			every := time.Duration(interval.Value)
			if every < time.Second {
				every = time.Second
			}
			ctx := a.Ctx(c)
			deadline := time.Now().Add(time.Duration(timeout.Value))
			for {
				item, err := a.getApproval(c, args[0])
				if err != nil {
					return err
				}
				expired := item.Status == "pending" && approvalExpired(item.ExpiresAt, time.Now())
				if item.Status != "pending" || expired || !time.Now().Before(deadline) {
					return a.emitDecision(item, expired)
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(minDuration(every, time.Until(deadline))):
				}
			}
		},
	}
	wait.Flags().StringVar(&waitTimeout, "timeout", "10m", "give up after this long (e.g. 30s, 10m, 2h)")
	wait.Flags().StringVar(&waitInterval, "interval", "5s", "how often to check")

	policy := &cobra.Command{
		Use:     "policy",
		Aliases: []string{"policies"},
		Short:   "Show which of your sends will be held, per mailbox",
		Long: strings.TrimSpace(`
For every mailbox you can read: its agent send mode, the recipients that skip
approval, an agent inbox's recipient limit, and what will happen to a send made
with this credential:

  sent         goes out directly
  held         waits for a person (unless every recipient is on skip_approval)
  refused      the mailbox is draft_only for agents; write a draft instead
  not_allowed  this credential cannot send from it

A send is sent directly only when the mailbox mode is auto AND the token holds
mail:send:auto. In approve mode (the default) mail:send:auto does not skip
approval. Read only: a person changes it in the mailbox settings.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			res, err := a.Client.ListSendPolicies(a.Ctx(c))
			if err != nil {
				return err
			}
			rows := res.Policies
			if a.mailboxExplicit {
				rows = nil
				for _, p := range res.Policies {
					if strings.EqualFold(p.Mailbox, a.Cfg.Mailbox) {
						rows = append(rows, p)
					}
				}
			}
			return a.emit(output.Result{
				Data:    map[string]any{"credential_may_auto_send": res.CredentialMayAutoSend, "policies": rows},
				Rows:    rows,
				Columns: sendPolicyColumns(),
				Empty:   "no mailboxes you can read",
			})
		},
	}

	c.AddCommand(list, count, show, wait, policy, edit, revise, approve, reject, retry)
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

// getApproval reads one approval: from --mailbox when it was given, otherwise
// from whichever readable mailbox holds it (falling back to the default
// mailbox on a deployment without the lookup route).
func (a *App) getApproval(c *cobra.Command, id string) (*api.Approval, error) {
	if !a.mailboxExplicit {
		item, err := a.Client.FindApproval(a.Ctx(c), id)
		if err == nil {
			return item, nil
		}
		fe := fail.AsError(err)
		if fe == nil || fe.ExitCode() != fail.NotFound || strings.TrimSpace(a.Cfg.Mailbox) == "" {
			return nil, err
		}
	}
	mb, err := a.mustMailbox()
	if err != nil {
		return nil, err
	}
	return a.Client.GetApproval(a.Ctx(c), mb, id)
}

// emitDecision prints the approval and maps its state to an exit code.
func (a *App) emitDecision(item *api.Approval, expired bool) error {
	res := output.Result{Data: item, Untrusted: []string{"subject", "messages", "enrollment"}}
	switch {
	case item.Status == "sent":
		res.Summary = "approved and sent" + deliveryNote(item)
		return a.emit(res)
	case item.Status == "rejected":
		_ = a.emit(res)
		return fail.New(fail.Denied, "APPROVAL_REJECTED", "a person rejected the held send; nothing was sent").
			WithRemediation("tell the user; do not send it another way")
	case expired:
		_ = a.emit(res)
		return fail.New(fail.Conflict, "APPROVAL_EXPIRED", "nobody decided in time and the held send expired; nothing was sent").
			WithRemediation("ask the user whether to send it again")
	case item.Status == "pending" || item.Status == "sending":
		_ = a.emit(res)
		e := fail.New(fail.Network, "APPROVAL_PENDING", "still waiting for a person to decide").
			WithRemediation("give the user the approval_url, then run `cloudmail approval wait %s` again", item.ID)
		e.Retryable = true
		return e
	default:
		_ = a.emit(res)
		msg := "the held send " + strings.ReplaceAll(item.Status, "_", " ")
		if item.Error != nil && *item.Error != "" {
			msg += ": " + *item.Error
		}
		return fail.New(fail.Conflict, "APPROVAL_"+strings.ToUpper(item.Status), msg).
			WithRemediation("read the error field; a failed send can be put back with `cloudmail approval retry %s`", item.ID)
	}
}

func deliveryNote(item *api.Approval) string {
	var parts []string
	for _, m := range item.SentMessages {
		if m.DeliveryStatus != nil && *m.DeliveryStatus != "" {
			parts = append(parts, *m.DeliveryStatus)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return " (delivery: " + strings.Join(parts, ", ") + ")"
}

func approvalExpired(expiresAt string, now time.Time) bool {
	t, err := time.Parse(time.RFC3339, expiresAt)
	return err == nil && !now.Before(t)
}

func minDuration(a, b time.Duration) time.Duration {
	if b < a {
		if b < 0 {
			return 0
		}
		return b
	}
	return a
}

// statusWord is how an empty list reads: "nothing pending", "nothing sent".
func statusWord(status string) string {
	if status == "all" {
		return "held"
	}
	return strings.ReplaceAll(status, "_", " ")
}

func approvalColumnsWithMailbox() []output.Column {
	return append([]output.Column{{Header: "mailbox", Field: "mailbox", Truncate: 30}}, approvalColumns()...)
}

func sendPolicyColumns() []output.Column {
	list := func(field string) func(r map[string]any) string {
		return func(r map[string]any) string {
			v, ok := r[field].([]any)
			if !ok {
				if field == "allowed_recipients" {
					return "anyone"
				}
				return "-"
			}
			if len(v) == 0 {
				return "-"
			}
			parts := make([]string, 0, len(v))
			for _, e := range v {
				parts = append(parts, output.Stringify(e))
			}
			return strings.Join(parts, ",")
		}
	}
	return []output.Column{
		{Header: "mailbox", Field: "mailbox", Truncate: 36},
		{Header: "mode", Field: "mode"},
		{Header: "your sends", Field: "your_sends"},
		{Header: "skip approval", Field: "skip_approval", Value: list("skip_approval"), Truncate: 32},
		{Header: "may send to", Field: "allowed_recipients", Value: list("allowed_recipients"), Truncate: 32},
	}
}

// readApprovalBody sets the new body of an approval edit from --body-file (HTML)
// or --markdown-file (Markdown). cobra refuses the two together.
func readApprovalBody(c *cobra.Command, edits *api.ApprovalEdits, htmlFile, markdownFile string) error {
	if c.Flags().Changed("body-file") {
		data, err := readBody("", htmlFile)
		if err != nil {
			return err
		}
		edits.HTML = &data
	}
	if c.Flags().Changed("markdown-file") {
		data, err := readBody("", markdownFile)
		if err != nil {
			return err
		}
		if strings.TrimSpace(data) == "" {
			return fail.Usagef("the Markdown file is empty").
				WithRemediation("write the message, or leave --markdown-file out")
		}
		edits.Markdown = &data
	}
	return nil
}
