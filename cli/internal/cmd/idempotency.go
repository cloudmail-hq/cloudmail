package cmd

import (
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/spf13/cobra"
)

// idempotencyFlag is the per-command flag that sets the Idempotency-Key.
const idempotencyFlag = "idempotency-key"

// keyedCommands are the commands that send or create something the server
// deduplicates on Idempotency-Key. Each gets --idempotency-key.
//
// Listed by path rather than flagged in each constructor so the set is visible
// in one place, and TestKeyedCommandsHaveTheFlag fails if a path stops
// resolving.
var keyedCommands = []string{
	"mail send",
	"mail reply",
	"mail forward",
	"draft create",
	"draft send",
	"schedule create",
	"schedule send-now",
	"mailbox create",
	"agent-inbox create",
	"domain add",
	"webhook create",
	"ai provider add",
	"suppression add",
	"sequence enroll",
	"token create",
	"import mbox",
	"import imap",
	"approval approve",
	"template send",
}

// addIdempotencyFlags attaches --idempotency-key to every keyed command.
func addIdempotencyFlags(root *cobra.Command) {
	for _, p := range keyedCommands {
		c, _, err := root.Find(strings.Fields(p))
		if err != nil || c == root {
			continue // pinned by the test
		}
		c.Flags().String(idempotencyFlag, "",
			"key that makes a retry safe: rerunning with the same key and arguments within 24h "+
				"returns the first result instead of acting again (default: a fresh key per run, "+
				"printed with --verbose)")
	}
}

// setupIdempotency gives a keyed command its key: the one passed, or a fresh
// one. A fresh key still matters: it makes the client's own retries after a
// lost response replay instead of sending twice.
func (a *App) setupIdempotency(c *cobra.Command) error {
	f := c.Flags().Lookup(idempotencyFlag)
	if f == nil {
		return nil
	}
	key := f.Value.String()
	if f.Changed {
		if err := api.ValidateIdempotencyKey(key); err != nil {
			return err
		}
	} else {
		key = api.NewIdempotencyKey()
	}
	a.Client.SetIdempotencyKey(key)
	if a.Cfg.Verbose {
		a.Out.Info("cloudmail: idempotency key %s (rerun with --idempotency-key %s to retry safely)", key, key)
	}
	return nil
}
