package cmd

import (
	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
)

// emitSend renders the result of any command that sends mail: mail send,
// reply and forward, draft send, schedule create, template send and sequence
// enroll.
//
// The server can hold a send for a person to approve and answer 202 with
// {status:"pending_approval", approval_id, approval_url, ...}. That is a
// success (exit 0) but nothing was sent, so it is rendered as the hold, never
// with an empty id and never with a "sent as" line. onSent runs only for a
// real send outside --dry-run, for notes such as the recall hint.
func (a *App) emitSend(res any, r output.Result, onSent func()) error {
	if held, ok := api.AsHeldSend(res); ok {
		a.Out.Info("held for approval: %s — a person must approve it at %s",
			held.ApprovalID, held.ApprovalURL)
		return a.emitMutation(output.Result{
			Data:    held,
			Summary: "nothing was sent yet; do not retry. Change it with `cloudmail approval revise " + held.ApprovalID + "`",
		})
	}
	if onSent != nil && !a.DryRun() {
		onSent()
	}
	r.Data = res
	return a.emitMutation(r)
}
