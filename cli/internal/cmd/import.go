package cmd

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

// ── import ─────────────────────────────────────────────────────────

func newImportCommand(a *App) *cobra.Command {
	c := group("import", "Bring old mail into a mailbox", `
Import mail from a file (mbox, Google Takeout's mbox, a zip of .eml files, or a
single .eml) or from an IMAP account.

Imports run on the server in the background: once the upload finishes you can
close the terminal. Dates, Message-IDs, threads, read and starred state, Gmail
labels and IMAP folders are kept, and messages the mailbox already has are
skipped. Imported mail never triggers auto-replies, forwarding, webhooks or
notifications.`,
		"cloudmail import mbox ~/Takeout/Mail/All\\ mail\\ Including\\ Spam\\ and\\ Trash.mbox --mailbox me@example.com",
		"cloudmail import imap --host imap.example.com --user me@example.com --password-stdin < pw.txt",
		"cloudmail import status",
	)
	c.AddCommand(importFile(a), importIMAP(a), importStatus(a), importControl(a, "pause"), importControl(a, "resume"), importControl(a, "cancel"))
	return c
}

func importColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 26},
		{Header: "source", Field: "source", Truncate: 6},
		{Header: "status", Field: "status", Truncate: 10},
		{Header: "progress", Field: "progress", Value: func(r map[string]any) string {
			p, _ := r["progress"].(map[string]any)
			if p == nil {
				return ""
			}
			done, _ := p["done"].(float64)
			total, _ := p["total"].(float64)
			if total <= 0 {
				return ""
			}
			return fmt.Sprintf("%.0f%%", 100*done/total)
		}, Right: true},
		{Header: "imported", Field: "counts", Value: importCount("imported"), Right: true},
		{Header: "dupes", Field: "counts", Value: importCount("duplicates"), Right: true},
		{Header: "failed", Field: "counts", Value: importCount("failed"), Right: true},
		{Header: "label", Field: "label", Truncate: 40},
	}
}

func importCount(name string) func(map[string]any) string {
	return func(r map[string]any) string {
		c, _ := r["counts"].(map[string]any)
		if c == nil {
			return ""
		}
		return output.Stringify(c[name])
	}
}

// sourceForPath picks the import kind from a file's extension.
func sourceForPath(path string) (string, error) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mbox", ".mbx", "":
		return "mbox", nil
	case ".zip":
		return "zip", nil
	case ".eml":
		return "eml", nil
	}
	return "", fail.Usagef("cannot tell what kind of file %s is", filepath.Base(path)).
		WithRemediation("pass --format mbox, zip or eml")
}

func importFile(a *App) *cobra.Command {
	var format, folder string
	var wait bool
	c := &cobra.Command{
		Use:     "mbox <file>",
		Aliases: []string{"file", "eml", "zip"},
		Short:   "Upload and import an mbox, zip of .eml, or .eml file",
		Long: strings.TrimSpace(`
Upload a file and import its messages. The file is streamed in 5 MiB parts, so
any size up to 50 GB works without loading it into memory. Google Takeout's Mail
export is an mbox; its X-Gmail-Labels become folders and labels here.

Messages without Gmail labels go to Archive, or to the Inbox with --folder inbox.
With --wait the command stays until the server has finished importing.`),
		Example: exampleBlock(
			"cloudmail import mbox all-mail.mbox --mailbox me@example.com",
			"cloudmail import mbox exported.zip --folder inbox --wait",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			path := args[0]
			source := format
			if source == "" {
				if source, err = sourceForPath(path); err != nil {
					return err
				}
			}
			f, err := os.Open(path)
			if err != nil {
				return fail.Usagef("cannot open %s: %v", path, err).Wrap(err)
			}
			defer f.Close()
			info, err := f.Stat()
			if err != nil {
				return fail.Errf("cannot read %s: %v", path, err).Wrap(err)
			}
			if info.IsDir() {
				return fail.Usagef("%s is a directory", path).
					WithRemediation("zip the .eml files first, then import the zip")
			}
			errOut := a.Out.ErrOut()
			showProgress := !a.Out.Quiet() && term.IsTerminal(int(os.Stderr.Fd()))
			last := time.Time{}
			job, err := a.Client.UploadImportFile(a.Ctx(c), mb, source, filepath.Base(path), info.Size(), folder,
				bufio.NewReaderSize(f, 1<<20), func(sent, total int64) {
					if !showProgress || (time.Since(last) < 200*time.Millisecond && sent < total) {
						return
					}
					last = time.Now()
					fmt.Fprintf(errOut, "\ruploading %s of %s (%.0f%%)", humanBytes(float64(sent)), humanBytes(float64(total)), 100*float64(sent)/float64(total))
					if sent == total {
						fmt.Fprintln(errOut)
					}
				})
			if err != nil {
				return err
			}
			if wait && job.ID != "" {
				if job, err = waitForImport(a, c, mb, job.ID); err != nil {
					return err
				}
			}
			return a.emitMutation(output.Result{
				Data:    job,
				Columns: importColumns(),
				Summary: importSummary(job),
			})
		},
	}
	c.Flags().StringVar(&format, "format", "", "mbox, zip or eml (default: from the file extension)")
	c.Flags().StringVar(&folder, "folder", "", "where mail without Gmail labels goes: archive (default) or inbox")
	c.Flags().BoolVar(&wait, "wait", false, "stay until the import finishes")
	return c
}

func importIMAP(a *App) *cobra.Command {
	var host, user string
	var passwordStdin, wait bool
	var folders []string
	c := &cobra.Command{
		Use:   "imap --host <host> --user <username>",
		Short: "Import from an IMAP account",
		Long: strings.TrimSpace(`
Copy mail from an IMAP account, read-only, over TLS on port 993. Use an app
password (Gmail, iCloud and Outlook require one). The password is read from a
hidden prompt or, with --password-stdin, from stdin; it is never a flag, so it
stays out of shell history. The server stores it encrypted until the import ends,
then deletes it.

INBOX goes to the Inbox, Sent to Sent, Junk to Spam, Trash to Trash, and every
other folder becomes a label. Drafts are not imported.`),
		Example: exampleBlock(
			"cloudmail import imap --host imap.gmail.com --user me@gmail.com",
			"cloudmail import imap --host imap.example.com --user me --folder INBOX --folder Archive --password-stdin < pw.txt",
		),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			password, err := readImportPassword(a, passwordStdin)
			if err != nil {
				return err
			}
			if password == "" {
				return fail.Usagef("no password given")
			}
			job, err := a.Client.CreateIMAPImport(a.Ctx(c), mb, host, user, password, folders)
			if err != nil {
				return err
			}
			if wait && job.ID != "" {
				if job, err = waitForImport(a, c, mb, job.ID); err != nil {
					return err
				}
			}
			return a.emitMutation(output.Result{Data: job, Columns: importColumns(), Summary: importSummary(job)})
		},
	}
	c.Flags().StringVar(&host, "host", "", "IMAP server hostname, e.g. imap.example.com")
	c.Flags().StringVar(&user, "user", "", "IMAP username")
	c.Flags().BoolVar(&passwordStdin, "password-stdin", false, "read the app password from stdin")
	c.Flags().StringArrayVar(&folders, "folder", nil, "only this folder (repeatable; default: all)")
	c.Flags().BoolVar(&wait, "wait", false, "stay until the import finishes")
	_ = c.MarkFlagRequired("host")
	_ = c.MarkFlagRequired("user")
	return c
}

func readImportPassword(a *App, fromStdin bool) (string, error) {
	if fromStdin || !isStdinTerminal() {
		line, err := bufio.NewReader(io.LimitReader(os.Stdin, 4096)).ReadString('\n')
		if err != nil && err != io.EOF {
			return "", fail.Errf("cannot read the password from stdin: %v", err).Wrap(err)
		}
		return strings.TrimRight(line, "\r\n"), nil
	}
	fmt.Fprint(a.Out.ErrOut(), "IMAP app password (input is hidden): ")
	raw, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(a.Out.ErrOut())
	if err != nil {
		return "", fail.Errf("cannot read the password from the terminal: %v", err).Wrap(err)
	}
	return string(raw), nil
}

func importStatus(a *App) *cobra.Command {
	var wait bool
	c := &cobra.Command{
		Use:   "status [import-id]",
		Short: "Show recent imports, or one import's progress",
		Args:  cobra.MaximumNArgs(1),
		Example: exampleBlock(
			"cloudmail import status",
			"cloudmail import status imp_0123456789abcdef --wait",
		),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			if len(args) == 1 {
				var job *api.ImportJob
				if wait {
					job, err = waitForImport(a, c, mb, args[0])
				} else {
					job, err = a.Client.GetImport(a.Ctx(c), mb, args[0])
				}
				if err != nil {
					return err
				}
				return a.emit(output.Result{Data: job, Columns: importColumns(), Summary: importSummary(job)})
			}
			jobs, err := a.Client.ListImports(a.Ctx(c), mb)
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    jobs,
				Columns: importColumns(),
				Summary: fmt.Sprintf("%d import(s)", len(jobs)),
				Empty:   "no imports yet",
			})
		},
	}
	c.Flags().BoolVar(&wait, "wait", false, "with an id: stay until it finishes")
	return c
}

func importControl(a *App, action string) *cobra.Command {
	short := map[string]string{
		"pause":  "Pause a running import",
		"resume": "Resume a paused import",
		"cancel": "Cancel an import (mail already imported stays)",
	}[action]
	return &cobra.Command{
		Use:   action + " <import-id>",
		Short: short,
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			job, err := a.Client.ImportAction(a.Ctx(c), mb, args[0], action)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: job, Columns: importColumns(), Summary: importSummary(job)})
		},
	}
}

// waitForImport polls until the job ends, printing a progress line on a terminal.
func waitForImport(a *App, c *cobra.Command, mb, id string) (*api.ImportJob, error) {
	errOut := a.Out.ErrOut()
	tty := !a.Out.Quiet() && term.IsTerminal(int(os.Stderr.Fd()))
	for {
		job, err := a.Client.GetImport(a.Ctx(c), mb, id)
		if err != nil {
			return nil, err
		}
		if tty {
			fmt.Fprintf(errOut, "\r%-80s", importSummary(job))
		}
		if job.Terminal() || job.Status == "paused" {
			if tty {
				fmt.Fprintln(errOut)
			}
			return job, nil
		}
		select {
		case <-a.Ctx(c).Done():
			return job, nil
		case <-time.After(3 * time.Second):
		}
	}
}

func importSummary(job *api.ImportJob) string {
	if job == nil || job.ID == "" {
		return ""
	}
	s := fmt.Sprintf("%s: %s, %d imported, %d already here", job.ID, job.Status, job.Counts.Imported, job.Counts.Duplicates)
	if job.Counts.Failed > 0 {
		s += fmt.Sprintf(", %d failed", job.Counts.Failed)
	}
	if job.Counts.Skipped > 0 {
		s += fmt.Sprintf(", %d skipped", job.Counts.Skipped)
	}
	if job.Progress.Total != nil && *job.Progress.Total > 0 && !job.Terminal() {
		s += fmt.Sprintf(" (%.0f%%)", 100*float64(job.Progress.Done)/float64(*job.Progress.Total))
	}
	if job.LastError != nil && *job.LastError != "" && job.Status == "failed" {
		s += ": " + *job.LastError
	}
	return s
}
