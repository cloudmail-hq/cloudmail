package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

// ── drafts ─────────────────────────────────────────────────────────

func newDraftCommand(a *App) *cobra.Command {
	c := group("draft", "Write and amend drafts", `
Drafts are unsent messages kept in the Drafts folder. Writing one needs only the
draft capability, not permission to send, which is what makes drafting the safe way
for an automated caller to prepare mail for a person to approve.

A draft holds whatever you typed, including a half-finished address, so its
recipient fields are free text rather than validated addresses.`,
		"cloudmail draft create --to bob@example.com --subject Hi --body 'Draft text'",
		"cloudmail draft list",
		"cloudmail draft update <draft-id> --body 'Revised text'",
	)
	c.AddCommand(draftList(a), draftCreate(a), draftUpdate(a), draftDelete(a), draftSend(a))
	return c
}

// draftFlags are the fields of a draft.
type draftFlags struct {
	to, cc, bcc string
	subject     string
	body        string
	bodyFile    string
	inReplyTo   string
	threadID    string
	attach      []string
	replaceAtt  bool
}

func (df *draftFlags) register(c *cobra.Command) {
	f := c.Flags()
	f.StringVar(&df.to, "to", "", "recipients, comma-separated")
	f.StringVar(&df.cc, "cc", "", "carbon copy, comma-separated")
	f.StringVar(&df.bcc, "bcc", "", "blind carbon copy, comma-separated")
	f.StringVarP(&df.subject, "subject", "s", "", "subject line")
	f.StringVar(&df.body, "body", "", "message body")
	f.StringVar(&df.bodyFile, "body-file", "", "read the body from a file, or - for stdin")
	f.StringVar(&df.inReplyTo, "in-reply-to", "", "Message-ID this draft answers")
	f.StringVar(&df.threadID, "thread", "", "conversation this draft belongs to")
	f.StringArrayVar(&df.attach, "attach", nil, "attach a file (repeatable)")
	f.BoolVar(&df.replaceAtt, "replace-attachments", false,
		"discard the draft's existing attachments rather than adding to them")
	f.SortFlags = false
}

func (df *draftFlags) build(draftID string) (*api.DraftRequest, error) {
	body, err := readBody(df.body, df.bodyFile)
	if err != nil {
		return nil, err
	}
	req := &api.DraftRequest{
		To:                 df.to,
		CC:                 df.cc,
		BCC:                df.bcc,
		Subject:            df.subject,
		Body:               body,
		InReplyTo:          df.inReplyTo,
		ThreadID:           df.threadID,
		DraftID:            draftID,
		ReplaceAttachments: df.replaceAtt,
	}
	for _, p := range df.attach {
		att, err := loadAttachment(p, "attachment")
		if err != nil {
			return nil, err
		}
		req.Attachments = append(req.Attachments, *att)
	}
	return req, nil
}

func draftList(a *App) *cobra.Command {
	var page, limit int
	c := &cobra.Command{
		Use:   "list",
		Short: "List drafts",
		Long:  "Show the Drafts folder. Draft ids are message ids.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			list, err := a.Client.ListDrafts(a.Ctx(c), mb, page, a.pageLimit(limit))
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:      list.Emails,
				Columns:   emailColumns(),
				Summary:   countSummary(len(list.Emails), list.TotalCount, "drafts"),
				Untrusted: untrustedEmailFields(),
				Empty:     "no drafts",
			})
		},
	}
	c.Flags().IntVar(&page, "page", 0, "page number, starting at 1")
	c.Flags().IntVar(&limit, "limit-per-page", 0, "drafts per page requested from the server")
	return c
}

func draftCreate(a *App) *cobra.Command {
	df := &draftFlags{}
	c := &cobra.Command{
		Use:   "create",
		Short: "Save a new draft",
		Long: strings.TrimSpace(`
Save a new draft. Nothing is sent.

This is the right way for an automated caller to propose a message: it needs only
the draft capability, and a person can read and send it afterwards.`),
		Example: exampleBlock(
			"cloudmail draft create --to bob@example.com --subject 'Proposal' --body 'Draft.'",
			"",
			"# Draft a reply within an existing conversation",
			"cloudmail draft create --thread <thread-id> --in-reply-to <message-id> \\",
			"    --to alice@example.com --subject 'Re: Report' --body 'Looks good.'",
		),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			req, err := df.build("")
			if err != nil {
				return err
			}
			res, err := a.Client.SaveDraft(a.Ctx(c), mb, req)
			if err != nil {
				return err
			}
			if !a.DryRun() && res.ID != "" {
				a.Out.Info("send it with `cloudmail draft send %s`", res.ID)
			}
			return a.emitMutation(output.Result{
				Data:      res,
				Columns:   emailDetailColumns(),
				Untrusted: untrustedEmailFields(),
			})
		},
	}
	df.register(c)
	return c
}

func draftUpdate(a *App) *cobra.Command {
	df := &draftFlags{}
	c := &cobra.Command{
		Use:   "update <draft-id>",
		Short: "Amend an existing draft",
		Long: strings.TrimSpace(`
Amend a draft in place.

Be aware that an id the server does not recognise creates a *new* draft rather than
failing. That is the server's behaviour, and it means a typo here leaves you with
two drafts rather than an error -- so check the returned id.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			req, err := df.build(args[0])
			if err != nil {
				return err
			}
			res, err := a.Client.SaveDraft(a.Ctx(c), mb, req)
			if err != nil {
				return err
			}
			if !a.DryRun() && res.ID != "" && res.ID != args[0] {
				a.Out.Warn("the server did not recognise draft %s, so a new draft %s was created instead",
					args[0], res.ID)
			}
			return a.emitMutation(output.Result{
				Data:      res,
				Columns:   emailDetailColumns(),
				Untrusted: untrustedEmailFields(),
			})
		},
	}
	df.register(c)
	return c
}

func draftDelete(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "delete <draft-id>...",
		Short: "Discard a draft",
		Long: strings.TrimSpace(`
Move a draft to Trash. Reversible with ` + "`cloudmail mail restore`" + `, since a
draft is an ordinary message as far as the mailbox is concerned.`),
		Args: cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			for _, id := range args {
				if _, err := a.Client.Delete(a.Ctx(c), mb, id, false); err != nil {
					return err
				}
			}
			return a.emitMutation(output.Result{
				Data:    map[string]any{"status": "trashed", "ids": args, "dry_run": a.DryRun()},
				Summary: fmt.Sprintf("%d draft(s) discarded", len(args)),
			})
		},
	}
}

func draftSend(a *App) *cobra.Command {
	var to []string
	var subject string
	c := &cobra.Command{
		Use:   "send <draft-id>",
		Short: "Send a draft",
		Long: strings.TrimSpace(`
Send a draft.

The API has no "send this draft" route, so this reads the draft and sends its
content as a new message. Two consequences worth knowing: the draft itself is not
removed, and the sent message is a new one with its own id.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			draft, err := a.Client.GetEmail(a.Ctx(c), mb, args[0])
			if err != nil {
				return err
			}

			recipients := splitAddresses(to)
			if len(recipients) == 0 {
				recipients = splitAddresses([]string{draft.Recipient})
			}
			if len(recipients) == 0 {
				return fail.Usagef("draft %s has no recipient", args[0]).
					WithRemediation("pass --to, or set one with `cloudmail draft update`")
			}
			subj := subject
			if subj == "" {
				subj = draft.Subject
			}

			req := &api.SendRequest{
				To:        recipients,
				CC:        splitAddresses([]string{draft.CC}),
				BCC:       splitAddresses([]string{draft.BCC}),
				From:      mb,
				Subject:   subj,
				HTML:      draft.Body,
				InReplyTo: draft.InReplyTo,
				ThreadID:  draft.ThreadID,
			}
			// A draft body may be plain text; the send schema needs html or text,
			// and sending the same content as text as well costs nothing and
			// guarantees the message has a body the server accepts.
			if !strings.Contains(draft.Body, "<") {
				req.HTML, req.Text = "", draft.Body
			}
			if err := req.Validate(); err != nil {
				return err
			}
			if err := a.Confirm(fmt.Sprintf("Send draft %q to %s?",
				subj, strings.Join(recipients, ", ")), false); err != nil {
				return err
			}

			res, err := a.Client.Send(a.Ctx(c), mb, req)
			if err != nil {
				return err
			}
			return a.emitSend(res, output.Result{}, func() {
				a.Out.Info("the draft was not removed; discard it with `cloudmail draft delete %s`", args[0])
			})
		},
	}
	c.Flags().StringArrayVar(&to, "to", nil, "override the draft's recipients")
	c.Flags().StringVarP(&subject, "subject", "s", "", "override the draft's subject")
	return c
}

// ── threads ────────────────────────────────────────────────────────

func newThreadCommand(a *App) *cobra.Command {
	c := group("thread", "Work with whole conversations", `
A thread is every message that belongs to one conversation. Thread ids come from
the thread_id field of any message: `+"`cloudmail mail list --output json`"+`.

Muting a conversation sends its later replies straight to Archive, which is how you
leave a thread without leaving the mailbox.`,
		"cloudmail thread get <thread-id>",
		"cloudmail thread mute <thread-id>",
	)
	c.AddCommand(threadGet(a), threadRead(a), threadMute(a), threadUnmute(a), threadMuted(a))
	return c
}

func threadGet(a *App) *cobra.Command {
	var folder string
	c := &cobra.Command{
		Use:   "get <thread-id>",
		Short: "Show every message in a conversation",
		Long:  "List a conversation's messages in order, oldest first.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			msgs, err := a.Client.GetThread(a.Ctx(c), mb, args[0], folder)
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:      msgs,
				Columns:   emailColumns(),
				Summary:   fmt.Sprintf("%d message(s) in the conversation", len(msgs)),
				Untrusted: untrustedEmailFields(),
				Empty:     "no messages in that conversation",
			})
		},
	}
	c.Flags().StringVarP(&folder, "folder", "f", "", "restrict to one folder")
	return c
}

func threadRead(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "read <thread-id>...",
		Short: "Mark a whole conversation read",
		Long:  "Clear unread on every message in a conversation.",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			for _, id := range args {
				if _, err := a.Client.MarkThreadRead(a.Ctx(c), mb, id); err != nil {
					return err
				}
			}
			return a.emitMutation(output.Result{
				Data:    map[string]any{"status": "marked_read", "threads": args, "dry_run": a.DryRun()},
				Summary: fmt.Sprintf("%d conversation(s) marked read", len(args)),
			})
		},
	}
}

func threadMute(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "mute <thread-id>...",
		Short: "Send a conversation's later replies to Archive",
		Long: strings.TrimSpace(`
Mute a conversation. Replies that arrive afterwards skip the inbox and are filed in
Archive, so the thread stops interrupting without being deleted.`),
		Args: cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			for _, id := range args {
				if _, err := a.Client.MuteThread(a.Ctx(c), mb, id); err != nil {
					return err
				}
			}
			return a.emitMutation(output.Result{
				Data:    map[string]any{"status": "muted", "threads": args, "dry_run": a.DryRun()},
				Summary: fmt.Sprintf("%d conversation(s) muted", len(args)),
			})
		},
	}
}

func threadUnmute(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "unmute <thread-id>...",
		Short: "Stop muting a conversation",
		Long:  "Let a conversation's replies reach the inbox again.",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			for _, id := range args {
				if _, err := a.Client.UnmuteThread(a.Ctx(c), mb, id); err != nil {
					return err
				}
			}
			return a.emitMutation(output.Result{
				Data:    map[string]any{"status": "unmuted", "threads": args, "dry_run": a.DryRun()},
				Summary: fmt.Sprintf("%d conversation(s) unmuted", len(args)),
			})
		},
	}
}

func threadMuted(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "muted",
		Short: "List muted conversations",
		Long:  "Show which conversations are muted.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			rows, err := a.Client.ListMutedThreads(a.Ctx(c), mb)
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:  rows,
				Empty: "no muted conversations",
			})
		},
	}
}

// ── folders ────────────────────────────────────────────────────────

func newFolderCommand(a *App) *cobra.Command {
	c := group("folder", "Manage folders", `
Folders are where a message lives; a message is in exactly one. The built-ins --
inbox, archive, sent, drafts, trash, spam -- cannot be deleted.

For a message that belongs in several places at once, use a label instead.`,
		"cloudmail folder list",
		"cloudmail folder create Receipts",
	)
	c.AddCommand(folderList(a), folderCreate(a), folderRename(a), folderDelete(a))
	return c
}

func folderList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List folders",
		Long:  "Show every folder, including the built-in ones.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			folders, err := a.Client.ListFolders(a.Ctx(c), mb)
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    folders,
				Columns: folderColumns(),
				Summary: fmt.Sprintf("%d folder(s)", len(folders)),
			})
		},
	}
}

func folderCreate(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "create <name>",
		Short: "Create a folder",
		Long:  "Add a folder. The server assigns its id.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			f, err := a.Client.CreateFolder(a.Ctx(c), mb, args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: f, Columns: folderColumns()})
		},
	}
}

func folderRename(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "rename <folder-id> <new-name>",
		Short: "Rename a folder",
		Long:  "Change a folder's name. Its id and contents are unaffected.",
		Args:  cobra.ExactArgs(2),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			f, err := a.Client.RenameFolder(a.Ctx(c), mb, args[0], args[1])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: f, Columns: folderColumns()})
		},
	}
}

func folderDelete(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "delete <folder-id>",
		Short: "Delete a folder",
		Long: strings.TrimSpace(`
Delete a folder. The built-in folders cannot be deleted.

Move anything you want to keep out first: the folder's messages go with it.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			if err := a.Confirm(fmt.Sprintf(
				"delete folder %s and affect the messages in it", args[0]), true); err != nil {
				return err
			}
			res, err := a.Client.DeleteFolder(a.Ctx(c), mb, args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
}

// ── labels ─────────────────────────────────────────────────────────

func newLabelCommand(a *App) *cobra.Command {
	c := group("label", "Manage labels and apply them to messages", `
A label marks a message without moving it, and a message can carry several. Labels
can nest, so a parent label groups its children.

`+"`label apply`"+` and `+"`label remove`"+` change one label on a message.
`+"`label set`"+` replaces the whole set, which is the one to use when you want the
message to end up with exactly these labels and no others.`,
		"cloudmail label list",
		"cloudmail label create Invoices --color '#6b7280'",
		"cloudmail label apply <message-id> <label-id>",
		"cloudmail label emails <label-id>",
	)
	c.AddCommand(
		labelList(a), labelCreate(a), labelUpdate(a), labelDelete(a),
		labelEmails(a), labelOf(a), labelApply(a), labelRemove(a), labelSet(a), labelPrompt(a),
	)
	return c
}

func labelList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List labels",
		Long:  "Show every label in the mailbox.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			labels, err := a.Client.ListLabels(a.Ctx(c), mb)
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    labels,
				Columns: labelColumns(),
				Summary: fmt.Sprintf("%d label(s)", len(labels)),
				Empty:   "no labels yet",
			})
		},
	}
}

func labelCreate(a *App) *cobra.Command {
	var color, parent string
	var sortOrder int
	c := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a label",
		Long:  "Add a label, optionally nested under another and with a colour.",
		Example: exampleBlock(
			"cloudmail label create Invoices --color '#6b7280'",
			"cloudmail label create 2026 --parent <invoices-label-id>",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			in := api.LabelInput{Name: args[0], Color: color}
			if c.Flags().Changed("parent") {
				in.ParentID = &parent
			}
			if c.Flags().Changed("sort-order") {
				in.SortOrder = &sortOrder
			}
			l, err := a.Client.CreateLabel(a.Ctx(c), mb, in)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: l, Columns: labelColumns()})
		},
	}
	c.Flags().StringVar(&color, "color", "", "hex colour, e.g. #6b7280")
	c.Flags().StringVar(&parent, "parent", "", "parent label id")
	c.Flags().IntVar(&sortOrder, "sort-order", 0, "ordering among siblings")
	return c
}

func labelUpdate(a *App) *cobra.Command {
	var name, color, parent string
	var sortOrder int
	var unnest bool
	c := &cobra.Command{
		Use:   "update <label-id>",
		Short: "Change a label",
		Long: strings.TrimSpace(`
Change a label's name, colour, parent or ordering. Only the fields you name are
touched; use --unnest to move a label to the top level.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			in := api.LabelInput{Name: name, Color: color, ClearParent: unnest}
			if c.Flags().Changed("parent") {
				in.ParentID = &parent
			}
			if c.Flags().Changed("sort-order") {
				in.SortOrder = &sortOrder
			}
			l, err := a.Client.UpdateLabel(a.Ctx(c), mb, args[0], in)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: l, Columns: labelColumns()})
		},
	}
	f := c.Flags()
	f.StringVar(&name, "name", "", "new name")
	f.StringVar(&color, "color", "", "new hex colour")
	f.StringVar(&parent, "parent", "", "new parent label id")
	f.BoolVar(&unnest, "unnest", false, "move to the top level")
	f.IntVar(&sortOrder, "sort-order", 0, "ordering among siblings")
	c.MarkFlagsMutuallyExclusive("parent", "unnest")
	return c
}

func labelDelete(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "delete <label-id>",
		Short: "Delete a label",
		Long: strings.TrimSpace(`
Delete a label. It is removed from every message carrying it; the messages
themselves are untouched.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			if err := a.Confirm(fmt.Sprintf(
				"delete label %s and remove it from every message", args[0]), true); err != nil {
				return err
			}
			res, err := a.Client.DeleteLabel(a.Ctx(c), mb, args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
}

func labelEmails(a *App) *cobra.Command {
	var page, limit int
	c := &cobra.Command{
		Use:   "emails <label-id>",
		Short: "List messages carrying a label",
		Long:  "Show every message with this label, across all folders.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			list, err := a.Client.ListLabelEmails(a.Ctx(c), mb, args[0], page, a.pageLimit(limit))
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:      list.Emails,
				Columns:   emailColumns(),
				Summary:   countSummary(len(list.Emails), list.TotalCount, "messages"),
				Untrusted: untrustedEmailFields(),
				Empty:     "no messages carry that label",
			})
		},
	}
	c.Flags().IntVar(&page, "page", 0, "page number, starting at 1")
	c.Flags().IntVar(&limit, "limit-per-page", 0, "messages per page requested from the server")
	return c
}

func labelOf(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "of <message-id>",
		Short: "Show the labels on a message",
		Long:  "List which labels a message carries.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			labels, err := a.Client.GetEmailLabels(a.Ctx(c), mb, args[0])
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:    labels,
				Columns: labelColumns(),
				Empty:   "that message has no labels",
			})
		},
	}
}

func labelApply(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "apply <message-id> <label-id>",
		Short: "Add a label to a message",
		Long:  "Add one label, leaving the message's other labels in place.",
		Args:  cobra.ExactArgs(2),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			res, err := a.Client.AddEmailLabel(a.Ctx(c), mb, args[0], args[1])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
}

func labelRemove(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "remove <message-id> <label-id>",
		Short: "Take a label off a message",
		Long:  "Remove one label, leaving the message's other labels in place.",
		Args:  cobra.ExactArgs(2),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			res, err := a.Client.RemoveEmailLabel(a.Ctx(c), mb, args[0], args[1])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
}

func labelSet(a *App) *cobra.Command {
	var clear bool
	c := &cobra.Command{
		Use:   "set <message-id> [label-id...]",
		Short: "Replace every label on a message",
		Long: strings.TrimSpace(`
Replace a message's labels with exactly the ones given. Labels not listed are
removed, which is what makes this different from ` + "`label apply`" + `.

Use --clear to remove them all.`),
		Example: exampleBlock(
			"cloudmail label set <message-id> <label-a> <label-b>",
			"cloudmail label set <message-id> --clear",
		),
		Args: cobra.MinimumNArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			ids := args[1:]
			if clear {
				if len(ids) > 0 {
					return fail.Usagef("--clear was given along with %d label(s)", len(ids)).
						WithRemediation("use one or the other")
				}
				ids = []string{}
			}
			if len(ids) == 0 && !clear {
				return fail.Usagef("no labels given").
					WithRemediation("list the labels the message should end up with, " +
						"or pass --clear to remove them all")
			}
			res, err := a.Client.SetEmailLabels(a.Ctx(c), mb, args[0], ids)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
	c.Flags().BoolVar(&clear, "clear", false, "remove every label from the message")
	return c
}

// ── attachments ────────────────────────────────────────────────────

func newAttachmentCommand(a *App) *cobra.Command {
	c := group("attachment", "List and download attachments", `
Attachment ids come from `+"`cloudmail mail get`"+`, which lists them alongside the
message body.

The deployment refuses to serve back executable types whatever their extension. A
refusal is a 403 explaining that the type is blocked, and there is nothing to be
done about it client-side -- which is the point.`,
		"cloudmail attachment list <message-id>",
		"cloudmail attachment get <message-id> <attachment-id> --output-file ./invoice.pdf",
	)
	c.AddCommand(attachmentList(a), attachmentGet(a))
	return c
}

func attachmentList(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "list <message-id>",
		Short: "List a message's attachments",
		Long:  "Show the attachments on a message, with their ids, types and sizes.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			msg, err := a.Client.GetEmail(a.Ctx(c), mb, args[0])
			if err != nil {
				return err
			}
			return a.emit(output.Result{
				Data:      msg.Attachments,
				Columns:   attachmentColumns(),
				Summary:   fmt.Sprintf("%d attachment(s)", len(msg.Attachments)),
				Untrusted: []string{"filename"},
				Empty:     "that message has no attachments",
			})
		},
	}
}

func attachmentGet(a *App) *cobra.Command {
	var outFile string
	var toDir string
	c := &cobra.Command{
		Use:   "get <message-id> <attachment-id>",
		Short: "Download an attachment",
		Long: strings.TrimSpace(`
Download an attachment.

With --output-file the bytes are written there. With --to-dir the server's filename
is used inside that directory -- sanitised first, because a filename chosen by
whoever sent the message must not be able to decide where the file lands. Without
either, the bytes go to stdout, so redirect them or you will get binary in your
terminal.`),
		Example: exampleBlock(
			"cloudmail attachment get <message-id> <attachment-id> --output-file ./invoice.pdf",
			"cloudmail attachment get <message-id> <attachment-id> --to-dir ./downloads",
			"cloudmail attachment get <message-id> <attachment-id> > file.bin",
		),
		Args: cobra.ExactArgs(2),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			data, ctype, err := a.Client.DownloadAttachment(a.Ctx(c), mb, args[0], args[1])
			if err != nil {
				return err
			}

			dest := outFile
			if dest == "" && toDir != "" {
				// The filename comes from the message, so it is attacker-chosen.
				// safeFilename strips any path from it; without that, a name like
				// "../../.ssh/authorized_keys" would escape the directory the
				// caller nominated.
				msg, err := a.Client.GetEmail(a.Ctx(c), mb, args[0])
				if err != nil {
					return err
				}
				name := "attachment"
				for _, att := range msg.Attachments {
					if att.ID == args[1] {
						name = att.Filename
						break
					}
				}
				dest = filepath.Join(toDir, safeFilename(name))
			}

			if dest == "" {
				if a.Out.IsTTY() {
					a.Out.Warn("writing %s of %s to the terminal; "+
						"use --output-file or redirect instead",
						humanBytes(float64(len(data))), ctype)
				}
				_, err := a.Out.Out().Write(data)
				return writeErr(err)
			}

			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				return fail.Errf("cannot create %s: %v", filepath.Dir(dest), err)
			}
			// 0600: an attachment can be a payslip or a contract, and the default
			// umask would often make it group-readable.
			if err := os.WriteFile(dest, data, 0o600); err != nil {
				return fail.Errf("cannot write %s: %v", dest, err)
			}
			return a.emit(output.Result{
				Data: map[string]any{
					"path": dest, "bytes": len(data), "content_type": ctype,
				},
				Summary: fmt.Sprintf("wrote %s to %s", humanBytes(float64(len(data))), dest),
			})
		},
	}
	c.Flags().StringVar(&outFile, "output-file", "", "write to this path")
	c.Flags().StringVar(&toDir, "to-dir", "", "write into this directory using the sender's filename")
	c.MarkFlagsMutuallyExclusive("output-file", "to-dir")
	return c
}

// safeFilename reduces an attacker-supplied filename to a bare basename.
//
// A filename arrives from whoever sent the message. Without this, "--to-dir ." plus
// a filename of "../../../etc/cron.d/x" writes outside the nominated directory.
// Path separators, traversal segments and leading dots are all removed.
func safeFilename(name string) string {
	name = filepath.Base(filepath.Clean("/" + name))
	name = strings.TrimLeft(name, ".")
	name = strings.Map(func(r rune) rune {
		switch {
		case r == '/' || r == '\\' || r == 0:
			return -1
		case r < 0x20 || r == 0x7f:
			return -1
		default:
			return r
		}
	}, name)
	if name == "" {
		return "attachment"
	}
	if len(name) > 200 {
		name = name[:200]
	}
	return name
}
