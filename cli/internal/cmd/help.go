package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

// Help presentation, confirmation prompts, and the error rendering shared across
// the tree.

// helpTemplate replaces cobra's default.
//
// Two additions matter. Subcommands are labelled "Resources" rather than
// "Available Commands", which tells a reader that the next word is a noun and the
// one after it is a verb. And the footer names the two introspection commands, so
// a caller who lands on --help learns that a machine-readable description exists
// without having to guess its name.
const helpTemplate = `{{with (or .Long .Short)}}{{. | trimTrailingWhitespaces}}

{{end}}{{if or .Runnable .HasSubCommands}}{{.UsageString}}{{end}}`

const usageTemplate = `Usage:{{if .Runnable}}
  {{.UseLine}}{{end}}{{if .HasAvailableSubCommands}}
  {{.CommandPath}} <command> [flags]{{end}}
{{if gt (len .Aliases) 0}}
Aliases:
  {{.NameAliases}}
{{end}}{{if .HasExample}}
Examples:
{{.Example}}
{{end}}{{if .HasAvailableSubCommands}}
{{if .HasParent}}Commands:{{else}}Resources:{{end}}{{range .Commands}}{{if (or .IsAvailableCommand (eq .Name "help"))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{end}}
{{end}}{{if .HasAvailableLocalFlags}}
Flags:
{{.LocalFlags.FlagUsages | trimTrailingWhitespaces}}
{{end}}{{if .HasAvailableInheritedFlags}}
Global flags:
{{.InheritedFlags.FlagUsages | trimTrailingWhitespaces}}
{{end}}{{if .HasAvailableSubCommands}}
Run "{{.CommandPath}} <command> --help" for details of a command.{{end}}
{{if not .HasParent}}
Exit codes:
  0  ok            5  conflict         10 dry run (nothing sent)
  1  error         6  unauthenticated  11 write refused (nothing sent)
  2  usage         7  rate limited     12 invalid request body
  3  not found     8  network          13 payload too large
  4  denied        9  server error     130 interrupted

Environment:
  CLOUDMAIL_BASE_URL      deployment root
  CLOUDMAIL_MAILBOX       default mailbox
  CLOUDMAIL_TOKEN         API token (ttk_...), sent as Authorization: Bearer
  CLOUDMAIL_TOKEN_FILE    file holding the API token
  CLOUDMAIL_CLIENT_ID     legacy Access service token client id
  CLOUDMAIL_CLIENT_SECRET legacy Access service token client secret
  CLOUDMAIL_OUTPUT        default output format
  CLOUDMAIL_READ_ONLY     set to 1 to refuse every mutation
  NO_COLOR               disable colour

For programs:
  cloudmail guide         orientation written for an automated caller
  cloudmail schema        the whole command tree as JSON
{{end}}`

func applyHelpTemplates(root *cobra.Command) {
	root.SetHelpTemplate(helpTemplate)
	root.SetUsageTemplate(usageTemplate)
	// Applied to the root only; cobra propagates both templates to children,
	// which is what keeps every page in the tree looking the same.
}

// ── Confirmation ───────────────────────────────────────────────────

func isStdinTerminal() bool { return term.IsTerminal(int(os.Stdin.Fd())) }

// promptYesNo asks at the terminal.
//
// An irreversible action defaults to no and requires the word "yes" rather than
// accepting a bare "y". The extra keystrokes are the point: a reflexive keypress
// should not be able to empty a Trash, and requiring a whole word forces the
// reader to have read the question.
func promptYesNo(w *output.Writer, prompt string, irreversible bool) error {
	errOut := w.ErrOut()

	if irreversible {
		fmt.Fprintf(errOut, "%s %s\n", w.Red("This cannot be undone:"), prompt)
		fmt.Fprintf(errOut, "Type %s to continue, anything else to stop: ", w.Bold("yes"))
	} else {
		fmt.Fprintf(errOut, "%s [y/N]: ", prompt)
	}

	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		// EOF here means the terminal went away mid-prompt. Treated as a refusal:
		// the safe reading of "no answer" is no.
		return fail.Refusedf("cancelled")
	}
	answer := strings.ToLower(strings.TrimSpace(line))

	if irreversible {
		if answer != "yes" {
			return fail.Refusedf("cancelled")
		}
		return nil
	}
	if answer == "y" || answer == "yes" {
		return nil
	}
	return fail.Refusedf("cancelled")
}

// marshalError renders a fail.Error as JSON for the error stream.
func marshalError(e *fail.Error) ([]byte, error) {
	enc, err := json.MarshalIndent(e, "", "  ")
	if err != nil {
		return nil, err
	}
	return enc, nil
}

// ── Shared command plumbing ────────────────────────────────────────

// exampleBlock indents examples consistently. cobra prints the Example field
// verbatim, so the indentation has to be in the string.
func exampleBlock(lines ...string) string {
	var b strings.Builder
	for i, l := range lines {
		if i > 0 {
			b.WriteByte('\n')
		}
		if l == "" {
			continue
		}
		b.WriteString("  ")
		b.WriteString(l)
	}
	return b.String()
}

// group builds a noun command: a container whose children are the verbs.
//
// A bare noun runs help rather than erroring. `cloudmail mail` is not a mistake,
// it is someone asking what mail can do, and answering the question is more
// useful than complaining that a subcommand is required.
func group(use, short, long string, examples ...string) *cobra.Command {
	c := &cobra.Command{
		Use:   use,
		Short: short,
		Long:  strings.TrimSpace(long),
		// A mistyped verb gets the nearest real one. cobra's own message omits the
		// suggestion here, because a runnable parent turns the unknown verb into a
		// stray argument rather than a failed lookup.
		Args: groupArgs,
		RunE: func(c *cobra.Command, _ []string) error { return c.Help() },
	}
	if len(examples) > 0 {
		c.Example = exampleBlock(examples...)
	}
	return c
}

// groupArgs rejects an unrecognised verb under a noun, suggesting the nearest one.
func groupArgs(c *cobra.Command, args []string) error {
	if len(args) == 0 {
		return nil
	}
	e := fail.Usagef("`%s` has no %q command", c.CommandPath(), args[0])
	if best, ok := nearestCommand(c, args[0]); ok {
		return e.WithRemediation("did you mean `%s %s`?", c.CommandPath(), best)
	}
	return e.WithRemediation("run `%s --help` to see what it can do", c.CommandPath())
}

// nearestCommand finds the child command whose name is closest to what was typed.
//
// Written rather than delegated to cobra's SuggestionsFor for two reasons. Cobra
// reads SuggestionsMinimumDistance from the command being searched, and that field
// is not inherited from the root, so it is zero on every subcommand and no
// suggestion is ever produced. And cobra returns matches in declaration order
// rather than by distance, so `labl` suggests whichever near-enough command happens
// to come first -- `mail` instead of `label`. A wrong suggestion is worse than none,
// because it sends the reader off to the wrong page.
func nearestCommand(c *cobra.Command, typed string) (string, bool) {
	const maxDistance = 3

	typed = strings.ToLower(typed)
	best, bestScore := "", maxDistance+1

	consider := func(candidate, name string) {
		lower := strings.ToLower(candidate)
		score := levenshtein(typed, lower)
		// A candidate that starts with, or is contained in, what was typed is
		// almost always what was meant -- `lis` for `list`, `del` for `delete` --
		// so it beats a pure edit-distance match.
		if strings.HasPrefix(lower, typed) || strings.Contains(lower, typed) {
			score = 0
		}
		if score < bestScore {
			best, bestScore = name, score
		}
	}

	for _, sub := range c.Commands() {
		if sub.Hidden || sub.Name() == "help" {
			continue
		}
		consider(sub.Name(), sub.Name())
		for _, alias := range sub.Aliases {
			consider(alias, sub.Name())
		}
	}
	if bestScore > maxDistance {
		return "", false
	}
	return best, true
}

// levenshtein returns the edit distance between two strings.
//
// Two rolling rows rather than a full matrix: command names are short, but there is
// no reason to allocate len(a)*len(b) for a value that only ever needs the previous
// row.
func levenshtein(a, b string) int {
	ar, br := []rune(a), []rune(b)
	if len(ar) == 0 {
		return len(br)
	}
	if len(br) == 0 {
		return len(ar)
	}

	prev := make([]int, len(br)+1)
	curr := make([]int, len(br)+1)
	for j := range prev {
		prev[j] = j
	}

	for i := 1; i <= len(ar); i++ {
		curr[0] = i
		for j := 1; j <= len(br); j++ {
			cost := 1
			if ar[i-1] == br[j-1] {
				cost = 0
			}
			curr[j] = min3(curr[j-1]+1, prev[j]+1, prev[j-1]+cost)
		}
		prev, curr = curr, prev
	}
	return prev[len(br)]
}

func min3(a, b, c int) int {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}

// boolFlag reads a tri-state boolean from a pair of opposing flags.
//
// Filters need three states: match, do not match, and do not filter. Two boolean
// flags express that honestly -- `--unread` and `--read` -- whereas a single
// `--unread=false` conflates "show me read mail" with "show me everything" and
// leaves a caller unable to say the latter.
func boolFlag(c *cobra.Command, positive, negative string) *bool {
	if c.Flags().Changed(positive) {
		v := true
		return &v
	}
	if negative != "" && c.Flags().Changed(negative) {
		v := false
		return &v
	}
	return nil
}

// mustMailbox resolves the mailbox for a command, failing usefully when there is
// none.
func (a *App) mustMailbox() (string, error) {
	mb := strings.TrimSpace(a.Cfg.Mailbox)
	if mb != "" {
		return mb, nil
	}
	return "", fail.Usagef("no mailbox specified").
		WithRemediation("pass --mailbox you@example.com, " +
			"set a default with `cloudmail config set mailbox you@example.com`, " +
			"or export CLOUDMAIL_MAILBOX. " +
			"See what you can reach with `cloudmail mailbox list`")
}

// previewResult renders a dry-run preview as the command's output.
//
// The preview is the result in this case, so it goes to stdout in the requested
// format rather than being narrated to stderr. A caller can then read exactly what
// would have been sent and decide whether to commit -- which is only possible if
// the preview is data.
func previewResult(p any) output.Result {
	return output.Result{
		Data:    p,
		Summary: "dry run: nothing was sent",
	}
}
