// Package cmd wires cloudmail's command tree.
//
// # Shape of the tree
//
// Commands are noun-verb: `cloudmail mail list`, `cloudmail label create`. The noun
// is the resource, the verb is the action, and the same verbs mean the same thing
// under every noun. That is not a style preference. It is what makes the tree
// searchable: a caller that does not know this tool runs `cloudmail --help`, sees
// the resources, runs `cloudmail mail --help`, and sees the actions. Each step
// narrows the space deterministically. A flat list of forty verb-noun commands
// offers no such path and has to be read in full.
//
// Abbreviations are deliberately not accepted. Allowing `cloudmail m l` would
// freeze the namespace: adding `mailbox` later would make `m` ambiguous and break
// every script that relied on it.
package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"runtime/debug"
	"strings"
	"syscall"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/config"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

// Build information, stamped by the linker. See the Makefile.
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

// init fills in build information the linker did not stamp. A `go install
// ...@v1.2.3` build carries no ldflags, but the module version and VCS
// revision are recorded in the binary, so `cloudmail version` can still
// report something real.
func init() {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return
	}
	if Version == "dev" && info.Main.Version != "" && info.Main.Version != "(devel)" {
		Version = info.Main.Version
	}
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			if Commit == "none" && len(s.Value) >= 7 {
				Commit = s.Value[:7]
			}
		case "vcs.time":
			if Date == "unknown" {
				Date = s.Value
			}
		}
	}
}

// App is the state every command shares. Built once by the root command's
// PersistentPreRunE, so a subcommand never resolves configuration itself and
// therefore cannot resolve it differently.
type App struct {
	Cfg    *config.Config
	Client *api.Client
	Out    *output.Writer

	// assumeYes skips confirmation prompts.
	assumeYes bool
	// dryRun previews mutations instead of sending them.
	dryRun bool
	// force permits irreversible operations that otherwise refuse to run
	// unattended.
	force bool

	// limit is the global --limit. It caps rendered rows, and is also used as the
	// server-side page size when a listing command was not given an explicit
	// --limit-per-page. Fetching fifty rows to display ten wastes a round trip and
	// the caller's rate-limit budget, and nobody passing --limit 10 wants that.
	limit int
}

// pageLimit resolves the number of rows to ask the server for.
//
// An explicit --limit-per-page wins, since it is the more specific request. Failing
// that, the global --limit is used, so the common case needs one flag rather than
// two that have to agree.
func (a *App) pageLimit(perPage int) int {
	if perPage > 0 {
		return perPage
	}
	return a.limit
}

// globalFlags holds the raw flag values before they are resolved into a Config.
//
// Every field is a pointer or is paired with a Changed() check, because the
// difference between "the user passed --output json" and "the user said nothing"
// decides whether a flag overrides the config file or yields to it.
type globalFlags struct {
	profile          string
	baseURL          string
	mailbox          string
	clientID         string
	clientSecretFile string
	timeout          string
	retries          int
	outputFormat     string
	jsonOutput       bool
	color            string
	fence            string
	selectFields     []string
	limit            int
	readOnly         bool
	verbose          bool
	quiet            bool
	dryRun           bool
	assumeYes        bool
	force            bool
}

// Execute runs the CLI and returns the process exit code.
//
// It returns rather than calling os.Exit so that deferred cleanup runs and so the
// whole tree is testable: a test can assert on the code without the test binary
// exiting.
func Execute() int {
	// SIGINT and SIGTERM cancel the context, which unblocks the in-flight HTTP
	// request rather than leaving the process to be killed mid-write.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	root, app := NewRootCommand()
	root.SetContext(ctx)

	// ExecuteC rather than Execute so the failing command is known. That is what
	// lets an argument-count error point at the help page for the command that
	// was actually run, instead of at the root.
	cmd, err := root.ExecuteC()
	if err == nil {
		return fail.OK
	}
	return report(errWithCommandContext(err, cmd), app)
}

// errWithCommandContext gives a bare cobra error a remediation naming the command
// that produced it.
func errWithCommandContext(err error, cmd *cobra.Command) error {
	var already *fail.Error
	if errors.As(err, &already) || cmd == nil {
		return err
	}
	return fail.Usagef("%s", err.Error()).
		WithRemediation("run `%s --help` for its arguments and flags", cmd.CommandPath()).
		Wrap(err)
}

// report renders an error and returns its exit code.
//
// Errors go to stderr in every format, including JSON. stdout is for the result
// of a command that worked; a caller redirecting stdout to a file wants that file
// to hold data or nothing, never an error envelope that a later parse mistakes
// for a record.
func report(err error, app *App) int {
	e := classifyTopLevel(err)

	// The writer may not exist yet -- configuration itself can fail -- so fall
	// back to plain stderr rather than losing the message.
	asJSON := false
	if app != nil && app.Out != nil {
		f := app.Out.Format()
		asJSON = f == output.JSON || f == output.NDJSON
	}

	if asJSON {
		if data, mErr := marshalError(e); mErr == nil {
			fmt.Fprintln(os.Stderr, string(data))
			return e.ExitCode()
		}
	}

	fmt.Fprintln(os.Stderr, "error: "+e.Error())
	if e.Capability != "" {
		fmt.Fprintf(os.Stderr, "missing capability: %s\n", e.Capability)
	}
	return e.ExitCode()
}

// classifyTopLevel assigns an exit code to any error reaching main.
//
// Everything cloudmail itself raises is already a *fail.Error carrying a code. What
// is left is cobra's own parsing and validation: an unknown command, an unknown
// flag, the wrong number of arguments, two mutually exclusive flags. Those are all
// usage errors -- nothing was sent, and the fix is to change the command line --
// so they must exit 2 rather than the generic 1.
//
// The invariant this relies on is that no other code path returns a bare error.
// emit() and the raw writers wrap theirs, which is what keeps the rule sound.
func classifyTopLevel(err error) *fail.Error {
	var e *fail.Error
	if errors.As(err, &e) {
		return e
	}
	return fail.Usagef("%s", err.Error()).
		WithRemediation("run `cloudmail --help`, or `cloudmail schema` for the machine-readable form").
		Wrap(err)
}

// rootArgs validates the root command's arguments and offers a correction.
//
// cobra's own "unknown command" error carries no suggestion when the parent is
// runnable, which is the case here because bare `cloudmail` prints help. Since a
// mistyped noun is the single most likely mistake a newcomer makes, answering it
// with the nearest real command is worth the small amount of code.
func rootArgs(c *cobra.Command, args []string) error {
	if len(args) == 0 {
		return nil
	}
	e := fail.Usagef("there is no %q command", args[0])
	if best, ok := nearestCommand(c, args[0]); ok {
		return e.WithRemediation("did you mean `cloudmail %s`?", best)
	}
	return e.WithRemediation("run `cloudmail --help` to see the available resources")
}

// NewRootCommand builds the command tree.
func NewRootCommand() (*cobra.Command, *App) {
	app := &App{}
	g := &globalFlags{}

	root := &cobra.Command{
		Use:   "cloudmail",
		Short: "Read, send and organise mail in a cloudmail inbox",
		Long: strings.TrimSpace(`
cloudmail drives a cloudmail deployment from the command line: read and search
a mailbox, send and reply, keep drafts, file mail into folders and labels, and
manage the rules that sort it before you see it.

It is built to be driven by a person or by a program with equal comfort. Output is
an aligned table at a terminal and JSON everywhere else, exit codes classify
failures so a script can branch without parsing prose, and every command that
changes something accepts --dry-run.

If you are a program reading this: run ` + "`cloudmail guide`" + ` for a short
orientation written for you, and ` + "`cloudmail schema`" + ` for the whole command
tree as JSON.`),
		Example: exampleBlock(
			"# What am I, and what may I touch?",
			"cloudmail auth whoami",
			"",
			"# The ten most recent unread messages in the inbox",
			"cloudmail mail list --folder inbox --unread --limit 10",
			"",
			"# Find something",
			"cloudmail mail search 'from:alice@example.com has:attachment newer_than:7d'",
			"",
			"# Read one message, body included",
			"cloudmail mail get 019...c4",
			"",
			"# Send",
			"cloudmail mail send --to bob@example.com --subject 'Hello' --text 'Morning.'",
			"",
			"# Reply, without retyping the threading headers",
			"cloudmail mail reply 019...c4 --text 'Thanks, will do.'",
			"",
			"# Preview a deletion instead of performing it",
			"cloudmail mail delete 019...c4 --dry-run",
		),

		// Errors and usage are printed by report(), which knows the output
		// format. Letting cobra also print them would duplicate every message.
		SilenceErrors: true,
		SilenceUsage:  true,

		// An unknown subcommand should be a usage error naming the nearest real
		// one, not a run of the parent with a stray argument.
		Args: rootArgs,

		PersistentPreRunE: func(c *cobra.Command, _ []string) error {
			return app.setup(c, g)
		},

		RunE: func(c *cobra.Command, _ []string) error {
			// Bare `cloudmail` shows help and succeeds. Help is what was asked
			// for, so it is not a failure.
			return c.Help()
		},
	}

	registerGlobalFlags(root, g)
	applyHelpTemplates(root)

	// `cloudmail --version` as well as `cloudmail version`, for the many scripts
	// and package managers that probe a binary that way.
	root.Version = Version
	root.SetVersionTemplate("cloudmail {{.Version}}\n")

	// Suggest a near miss rather than only refusing. `cloudmail mial list` should
	// say "did you mean mail".
	root.SuggestionsMinimumDistance = 2

	// A flag mistake is a usage error, and saying so here means the exit code is
	// right even though the error originated inside pflag.
	root.SetFlagErrorFunc(func(c *cobra.Command, err error) error {
		return fail.Usagef("%s", err.Error()).
			WithRemediation("run `%s --help` to see the flags it takes", c.CommandPath())
	})

	root.AddCommand(
		newAuthCommand(app),
		newMailCommand(app),
		newAskCommand(app),
		newAICommand(app),
		newDraftCommand(app),
		newThreadCommand(app),
		newFolderCommand(app),
		newLabelCommand(app),
		newAttachmentCommand(app),
		newMailboxCommand(app),
		newDomainCommand(app),
		newProductCommand(app),
		newScheduleCommand(app),
		newFollowupCommand(app),
		newImportCommand(app),
		newScreenerCommand(app),
		newRuleCommand(app),
		newSenderCommand(app),
		newSuppressionCommand(app),
		newApprovalCommand(app),
		newSignatureCommand(app),
		newTemplateCommand(app),
		newSequenceCommand(app),
		newPeopleCommand(app),
		newAnalyticsCommand(app),
		newAccessCommand(app),
		newTokenCommand(app),
		newWebhookCommand(app),
		newAgentInboxCommand(app),
		newDelegateCommand(app),
		newBrandingCommand(app),
		newPreferencesCommand(app),
		newNotificationCommand(app),
		newPrivacyCommand(app),
		newAccountCommand(app),
		newSendingCommand(app),
		newUsageCommand(app),
		newLicenceCommand(app),
		newCloudflareCommand(app),
		newMigrateCommand(app),
		newEventsCommand(app),
		newConfigCommand(app),
		newAPICommand(app),
		newSchemaCommand(app),
		newGuideCommand(app),
		newCompletionCommand(),
		newVersionCommand(app),
	)
	attachExtras(root, app)
	addIdempotencyFlags(root)

	return root, app
}

func registerGlobalFlags(root *cobra.Command, g *globalFlags) {
	f := root.PersistentFlags()

	f.StringVar(&g.profile, "profile", "",
		"configuration profile to use")
	f.StringVar(&g.baseURL, "base-url", "",
		"deployment root, e.g. https://mail.example.com")
	f.StringVarP(&g.mailbox, "mailbox", "m", "",
		"mailbox address to act on (default: the configured one)")

	f.StringVar(&g.clientID, "client-id", "",
		"legacy Cloudflare Access service token client id")
	// There is no --client-secret. A secret passed as an argument is visible in
	// the process list to every user on the machine and is recorded in shell
	// history. The two safe channels are a file and the environment.
	f.StringVar(&g.clientSecretFile, "client-secret-file", "",
		"file holding the legacy Access service token client secret")

	f.StringVarP(&g.outputFormat, "output", "o", "",
		"output format: auto, json, ndjson, table, csv, plain (auto: table on a terminal, json otherwise)")
	f.BoolVar(&g.jsonOutput, "json", false,
		"shorthand for --output json")
	f.StringSliceVar(&g.selectFields, "select", nil,
		"only these fields, comma-separated (keeps large listings small)")
	f.IntVar(&g.limit, "limit", 0,
		"at most this many rows; listings also ask the server for only this many")
	f.StringVar(&g.color, "color", "",
		"colour output: auto, always, never (NO_COLOR is honoured)")
	f.StringVar(&g.fence, "fence", "",
		"delimit untrusted message content: auto, always, never")

	f.StringVar(&g.timeout, "timeout", "",
		"per-request timeout, e.g. 30s")
	f.IntVar(&g.retries, "retries", -1,
		"retries after a transient failure (0 disables)")

	f.BoolVar(&g.readOnly, "read-only", false,
		"refuse every state-changing request before it is sent")
	f.BoolVar(&g.dryRun, "dry-run", false,
		"show what would be sent, and send nothing")
	f.BoolVarP(&g.assumeYes, "yes", "y", false,
		"answer yes to confirmation prompts")
	f.BoolVar(&g.force, "force", false,
		"permit irreversible operations without a terminal to confirm at")

	f.BoolVarP(&g.verbose, "verbose", "v", false,
		"trace requests to stderr")
	f.BoolVarP(&g.quiet, "quiet", "q", false,
		"suppress stderr commentary; results still go to stdout")

	// Grouped in --help so twenty flags read as five ideas.
	f.SortFlags = false
}

// setup resolves configuration and builds the client and writer.
func (a *App) setup(c *cobra.Command, g *globalFlags) error {
	f := c.Root().PersistentFlags()

	ov := config.Overrides{Profile: g.profile, CreatesProfile: createsProfile(c)}
	if f.Changed("base-url") {
		ov.BaseURL = &g.baseURL
	}
	if f.Changed("mailbox") {
		ov.Mailbox = &g.mailbox
	}
	if f.Changed("client-id") {
		ov.ClientID = &g.clientID
	}
	if f.Changed("client-secret-file") {
		ov.ClientSecretEnv = &g.clientSecretFile
	}
	if f.Changed("output") {
		ov.Output = &g.outputFormat
	}
	// --json is sugar for -o json. An explicit --output still wins, so a script
	// that sets both gets what it named in full.
	if g.jsonOutput && !f.Changed("output") {
		jsonFormat := "json"
		ov.Output = &jsonFormat
	}
	if f.Changed("color") {
		ov.Color = &g.color
	}
	if f.Changed("fence") {
		ov.Fence = &g.fence
	}
	if f.Changed("read-only") {
		ov.ReadOnly = &g.readOnly
	}
	if f.Changed("verbose") {
		ov.Verbose = &g.verbose
	}
	if f.Changed("retries") && g.retries >= 0 {
		ov.Retries = &g.retries
	}
	if f.Changed("timeout") {
		d, err := config.ParseDuration(g.timeout)
		if err != nil {
			return fail.Usagef("%s", err.Error())
		}
		ov.Timeout = &d.Value
	}

	cfg, err := config.Load(ov)
	if err != nil {
		// Everything Load reports is a bad setting or a bad file: a usage
		// problem, fixable by editing arguments or the config, and nothing was
		// sent.
		return fail.Usagef("%s", err.Error())
	}
	a.Cfg = cfg

	w, err := output.NewWriter(output.Options{
		Format: cfg.Output,
		Color:  cfg.Color,
		Fence:  cfg.Fence,
		Select: g.selectFields,
		Limit:  g.limit,
		Quiet:  g.quiet,
	})
	if err != nil {
		return fail.Usagef("%s", err.Error())
	}
	a.Out = w
	for _, warning := range cfg.Warnings() {
		w.Warn("%s", warning)
	}

	a.limit = g.limit
	a.assumeYes = g.assumeYes
	a.force = g.force
	a.dryRun = g.dryRun

	if n := config.LegacyNotice(); n != "" {
		a.Out.Warn("%s", n)
	}
	api.UserAgent = fmt.Sprintf("cloudmail/%s (+https://github.com/cloudmail-hq/cloudmail)", Version)
	a.Client = api.New(cfg)
	a.Client.SetDryRun(g.dryRun)

	return a.setupIdempotency(c)
}

// Ctx returns the command's context.
func (a *App) Ctx(c *cobra.Command) context.Context {
	if ctx := c.Context(); ctx != nil {
		return ctx
	}
	return context.Background()
}

// Mailbox resolves which mailbox a command should act on.
func (a *App) Mailbox() string { return a.Cfg.Mailbox }

// DryRun reports whether mutations are being previewed.
func (a *App) DryRun() bool { return a.dryRun }

// emit renders the result of a read.
//
// The rendering error is wrapped rather than passed through, because
// classifyTopLevel reads a bare error as a usage mistake. A broken pipe is not the
// caller's fault and must not be reported as one.
func (a *App) emit(r output.Result) error {
	if err := a.Out.Emit(r); err != nil {
		return writeErr(err)
	}
	return nil
}

// writeErr classifies a failure to write output.
func writeErr(err error) error {
	if err == nil {
		return nil
	}
	// A closed pipe is what `| head` produces, and it is not worth a loud error:
	// the caller got what it asked for and stopped reading.
	if errors.Is(err, syscall.EPIPE) {
		return nil
	}
	return fail.Errf("cannot write output: %v", err).Wrap(err)
}

// emitMutation renders the result of a state-changing command and reports a dry
// run through the exit code.
//
// A previewed mutation exits 10 rather than 0. That distinction is the whole point
// of the flag for an automated caller: without it, a script that passed --dry-run
// by mistake would read a success and conclude the change had been applied. A
// *read* under --dry-run still exits 0, which is why this is a separate method
// rather than a check inside emit.
func (a *App) emitMutation(r output.Result) error {
	// Under --dry-run the server returned nothing, so the typed result the command
	// is holding is a zero value. Emitting it would show `{"id":""}` and imply the
	// operation had produced an empty record. The previews are what actually
	// happened, so they are the result -- and they carry the exact request body,
	// which is the thing worth inspecting before committing.
	if a.dryRun {
		if previews := a.Client.Previews(); len(previews) > 0 {
			var data any = previews
			if len(previews) == 1 {
				data = previews[0]
			}
			if err := a.Out.Emit(output.Result{
				Data: data,
				Summary: fmt.Sprintf("dry run: %d request(s) withheld, nothing was sent",
					len(previews)),
			}); err != nil {
				return writeErr(err)
			}
		}
		return fail.New(fail.DryRun, "DRY_RUN",
			"nothing was sent because --dry-run was given").
			WithRemediation("remove --dry-run to apply it")
	}
	if err := a.Out.Emit(r); err != nil {
		return writeErr(err)
	}
	return nil
}

// createsProfile reports whether a command writes the profile it runs in, so
// that naming a new one with --profile creates it rather than failing.
func createsProfile(c *cobra.Command) bool {
	switch c.CommandPath() {
	case "cloudmail config set", "cloudmail auth login":
		return true
	}
	return false
}

// canConfirm reports, before any request is made, whether Confirm could
// succeed. A command that must read something to build its prompt calls it
// first, so an unattended run is refused without touching the network.
func (a *App) canConfirm(what string) error {
	if a.dryRun || a.Cfg.ReadOnly || a.force || a.assumeYes || isStdinTerminal() {
		return nil
	}
	return fail.Refusedf("%s needs confirmation, and there is no terminal to ask at", what).
		WithRemediation("pass --force to proceed without being asked")
}

// Confirm asks before a consequential action.
//
// The rules, in order:
//
//   - A dry run has nothing to consent to, so it never asks.
//   - --yes proceeds: an operator has said so explicitly. --force does the same
//     and additionally covers the irreversible cases, so that "I meant it" and
//     "I meant it even though it cannot be undone" are separate statements.
//   - No terminal and neither flag: refuse. Prompting into a pipe would hang
//     forever, and assuming consent because nobody is there to object is how
//     automation destroys things quietly. Refusing with a code that names the
//     missing flag is the only safe answer.
//   - Otherwise: ask.
func (a *App) Confirm(prompt string, irreversible bool) error {
	if a.dryRun {
		return nil
	}
	// In read-only mode the request will be refused by the client anyway, and that
	// refusal names the real reason. Asking for consent first would report "no
	// terminal to confirm at" to someone who had asked for read-only and is owed a
	// more accurate answer.
	if a.Cfg.ReadOnly {
		return nil
	}
	if a.force || a.assumeYes {
		return nil
	}

	if !isStdinTerminal() {
		flag := "--yes"
		if irreversible {
			flag = "--force"
		}
		return fail.Refusedf("%s needs confirmation, and there is no terminal to ask at", prompt).
			WithRemediation("pass %s to proceed without being asked", flag)
	}
	return promptYesNo(a.Out, prompt, irreversible)
}
