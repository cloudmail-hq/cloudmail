package cmd

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/config"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

func newAuthCommand(a *App) *cobra.Command {
	c := group("auth", "Sign in, and check who you are and what you may do", `
A deployment with built-in sign-in (the default) authenticates a program with a
personal **API token**. The token acts as the user who created it, narrowed by any
scopes and mailboxes it was created with (see `+"`cloudmail token --help`"+`).

  1. Sign in to the web app and open Settings -> Account & security -> API tokens.
  2. Create a token. It looks like ttk_<id>_<secret> and is shown once.
  3. Give it to cloudmail, either for this machine:

       cloudmail auth login                      # prompts, without echo
       pbpaste | cloudmail auth login --with-token

     or per process, which is the better fit for CI and agents:

       export CLOUDMAIL_TOKEN=ttk_...
       export CLOUDMAIL_TOKEN_FILE=/run/secrets/cloudmail   # or point at a file

`+"`auth login`"+` stores the token in a credentials file next to the config file
(0600, one token per profile), never in config.json. CLOUDMAIL_TOKEN beats
CLOUDMAIL_TOKEN_FILE, which beats the stored token. The token is sent as
`+"`Authorization: Bearer`"+`, and is never accepted as a command-line flag, because a
flag is visible in the process list and recorded in shell history.

Legacy: Cloudflare Access mode. A deployment still behind Access authenticates at
the edge and ignores API tokens. A machine caller there uses an Access service token:

  1. In Cloudflare Zero Trust, go to Access -> Service auth and create a service
     token. You get a Client ID and a Client Secret.
  2. Add that token to the Access policy protecting this Worker, as a Service Auth
     policy.
  3. In the app, at Settings -> Access, add the token's Client ID as a service
     principal and grant it the mailboxes it needs.
  4. Export the two halves, and leave CLOUDMAIL_TOKEN unset -- a token takes
     precedence:

       export CLOUDMAIL_CLIENT_ID=<client-id>
       export CLOUDMAIL_CLIENT_SECRET=<client-secret>

A service token with no grant reaches nothing, and service tokens are never matched
against ADMIN_EMAILS -- a machine is only ever an administrator by an explicit grant.

A local `+"`npm run dev`"+` server runs built-in sign-in for real, so it needs a token
too, unless it was started with DEV_AUTH_BYPASS=1.`,
		"cloudmail auth login",
		"cloudmail auth whoami",
		"cloudmail auth status",
	)
	c.AddCommand(authLogin(a), authLogout(a), authWhoami(a), authStatus(a), authCan(a))
	return c
}

// authLogin stores an API token for the current profile.
//
// Modelled on `gh auth login --with-token`: the token arrives on stdin or at a
// no-echo prompt, never as an argument, for the same reason there is no
// --client-secret.
func authLogin(a *App) *cobra.Command {
	var withToken, noVerify bool
	c := &cobra.Command{
		Use:   "login",
		Short: "Store an API token for this profile",
		Long: strings.TrimSpace(`
Store a personal API token in the credentials file, for the current profile.

Create the token in the web app at Settings -> Account & security -> API tokens. At a
terminal you are prompted for it, and what you type is not echoed. With --with-token,
or whenever stdin is not a terminal, the token is read from stdin instead.

The token is checked against the deployment before it is saved, so a typo or a
token from a different deployment fails here rather than on the next command. Pass
--no-verify to store it without that check, e.g. when the deployment is unreachable.

The credentials file lives beside the config file (see ` + "`cloudmail config path`" + `)
and is written 0600. CLOUDMAIL_TOKEN and CLOUDMAIL_TOKEN_FILE, when set, take
precedence over what is stored here.`),
		Example: exampleBlock(
			"cloudmail auth login",
			"cloudmail auth login --with-token < token.txt",
			"cloudmail --profile staging auth login",
		),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			token, err := readToken(a, withToken || !isStdinTerminal())
			if err != nil {
				return err
			}
			if token == "" {
				return fail.Usagef("no token given").
					WithRemediation("create one at Settings → Account & security → API tokens, " +
						"then paste it at the prompt or pipe it to `cloudmail auth login --with-token`")
			}
			if strings.ContainsFunc(token, func(r rune) bool { return r <= ' ' || r == 0x7f }) {
				return fail.Usagef("the token contains whitespace or control characters").
					WithRemediation("copy it again; a token is a single line like ttk_<id>_<secret>")
			}
			if hint := config.TokenHint(token); hint != "" {
				a.Out.Warn("%s", hint)
			}

			result := map[string]any{
				"profile":  a.Cfg.Profile,
				"base_url": a.Cfg.BaseURL,
				"verified": false,
			}
			if !noVerify {
				// A throwaway client carrying only the new token, so the check
				// cannot pass on the strength of an Access credential also present.
				probe := *a.Cfg
				probe.Token = token
				probe.ClientID, probe.ClientSecret, probe.AccessJWT = "", "", ""
				id, err := api.New(&probe).Whoami(a.Ctx(c))
				if err != nil {
					return err
				}
				result["verified"] = true
				result["role"] = id.Role
				if id.Email != "" {
					result["email"] = id.Email
				}
			}

			path, err := config.SaveToken(a.Cfg.Profile, token)
			if err != nil {
				return fail.Errf("%s", err.Error())
			}
			result["credentials_file"] = path

			if src := a.Cfg.TokenSource(); src == "env" || strings.HasPrefix(src, "file:") {
				a.Out.Warn("CLOUDMAIL_TOKEN or CLOUDMAIL_TOKEN_FILE is set in this environment " +
					"and takes precedence over the stored token")
			}

			summary := fmt.Sprintf("token stored for profile %s in %s", a.Cfg.Profile, path)
			if who, ok := result["email"].(string); ok {
				summary = fmt.Sprintf("signed in to %s as %s; %s", a.Cfg.BaseURL, who, summary)
			}
			return a.emit(output.Result{Data: result, Summary: summary})
		},
	}
	c.Flags().BoolVar(&withToken, "with-token", false, "read the token from stdin")
	c.Flags().BoolVar(&noVerify, "no-verify", false, "store the token without checking it against the deployment")
	return c
}

// readToken reads one token from stdin or a no-echo terminal prompt.
func readToken(a *App, fromStdin bool) (string, error) {
	return readSecret(a, fromStdin, "Paste your API token (input is hidden): ")
}

// readSecret reads one secret line from stdin, or from a no-echo terminal
// prompt, so it never reaches argv or shell history.
func readSecret(a *App, fromStdin bool, prompt string) (string, error) {
	if fromStdin {
		// One line, bounded: a token is about 60 bytes, and reading an unbounded
		// stdin would hang on, or buffer, whatever was piped by mistake.
		line, err := bufio.NewReader(io.LimitReader(os.Stdin, 4096)).ReadString('\n')
		if err != nil && err != io.EOF {
			return "", fail.Errf("cannot read the token from stdin: %v", err).Wrap(err)
		}
		return strings.TrimSpace(line), nil
	}
	fmt.Fprint(a.Out.ErrOut(), prompt)
	raw, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(a.Out.ErrOut())
	if err != nil {
		return "", fail.Errf("cannot read the token from the terminal: %v", err).Wrap(err)
	}
	return strings.TrimSpace(string(raw)), nil
}

// authLogout forgets the stored token. Nothing is revoked server-side: a token
// can only be revoked from a signed-in session, and saying so stops a reader
// assuming a leaked token is now dead.
func authLogout(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Remove the stored API token for this profile",
		Long: strings.TrimSpace(`
Delete this profile's token from the credentials file. The file itself is removed once
it holds no tokens.

This does not revoke the token. To do that, delete it at Settings -> Account & security
-> API tokens. A token exported as CLOUDMAIL_TOKEN is not affected either.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			removed, path, err := config.DeleteToken(a.Cfg.Profile)
			if err != nil {
				return fail.Errf("cannot update credentials %s: %v", path, err).Wrap(err)
			}
			summary := fmt.Sprintf("no stored token for profile %s", a.Cfg.Profile)
			if removed {
				summary = fmt.Sprintf("removed the stored token for profile %s; "+
					"revoke it at Settings → Account & security → API tokens if it may have leaked",
					a.Cfg.Profile)
			}
			if src := a.Cfg.TokenSource(); src == "env" || strings.HasPrefix(src, "file:") {
				a.Out.Warn("CLOUDMAIL_TOKEN or CLOUDMAIL_TOKEN_FILE is still set in this environment")
			}
			return a.emit(output.Result{
				Data: map[string]any{
					"profile": a.Cfg.Profile, "removed": removed, "credentials_file": path,
				},
				Summary: summary,
			})
		},
	}
}

func authWhoami(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Show your identity, mailboxes and capabilities",
		Long: strings.TrimSpace(`
Ask the deployment who you are and what you may do.

This is the best first call for anything automated: it answers "am I authenticated",
"which mailboxes can I touch" and "what may I do in each" in one request, so a caller
can plan rather than discovering its limits through a series of 403s.

A capability list of null means unrestricted -- you are an administrator, or the
deployment has not turned per-mailbox authorization on. That is reported as
enforced:false.

With a scoped API token, the role, mailboxes and capabilities shown are what the
token can actually do (your grants narrowed by its scopes and mailboxes), and the
token line lists its scopes. A mailbox of "*" means "every mailbox you can reach".`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			id, err := a.Client.Whoami(a.Ctx(c))
			if err != nil {
				return err
			}

			if a.Out.Format() == output.Table {
				fmt.Fprintf(a.Out.Out(), "%s  %s\n", a.Out.Bold("role:     "), id.Role)
				if id.Kind != "" {
					fmt.Fprintf(a.Out.Out(), "%s  %s\n", a.Out.Bold("kind:     "), id.Kind)
				}
				if id.Email != "" {
					fmt.Fprintf(a.Out.Out(), "%s  %s\n", a.Out.Bold("email:    "), id.Email)
				}
				fmt.Fprintf(a.Out.Out(), "%s  %s\n", a.Out.Bold("auth:     "), a.Cfg.Auth())
				fmt.Fprintf(a.Out.Out(), "%s  %v\n", a.Out.Bold("enforced: "), id.Enforced)
				if t := id.Token; t != nil {
					scopes := "mail:* (restricted by mailbox only)"
					if t.Scopes != nil {
						scopes = strings.Join(*t.Scopes, ", ")
						if scopes == "" {
							scopes = "none"
						}
					}
					fmt.Fprintf(a.Out.Out(), "%s  %s (%s)\n", a.Out.Bold("token:    "), t.ID, scopes)
					if t.Mailboxes != nil {
						fmt.Fprintf(a.Out.Out(), "%s  %s\n", a.Out.Bold("token for:"), strings.Join(*t.Mailboxes, ", "))
					}
				} else if id.AuthMethod == "token" {
					fmt.Fprintf(a.Out.Out(), "%s  %s\n", a.Out.Bold("token:    "), "full access (no scopes)")
				}

				if id.Unrestricted() {
					fmt.Fprintf(a.Out.Out(), "%s  %s\n", a.Out.Bold("access:   "),
						a.Out.Green("every capability on every mailbox"))
					if !id.Enforced {
						a.Out.Info("per-mailbox authorization is off on this deployment " +
							"(ADMIN_EMAILS is unset), so every signed-in caller is an administrator")
					}
				}
				if len(id.Mailboxes) > 0 {
					fmt.Fprintf(a.Out.Out(), "%s  %s\n", a.Out.Bold("mailboxes:"),
						strings.Join(id.Mailboxes, ", "))
				}
				if id.Capabilities != nil {
					fmt.Fprintln(a.Out.Out())
					return a.emit(output.Result{
						Data: *id.Capabilities,
						Columns: []output.Column{
							{Header: "mailbox", Field: "mailboxId", Truncate: 36},
							{Header: "role", Field: "role", Truncate: 10},
							{Header: "capabilities", Field: "capabilities", Truncate: 60},
						},
						Empty: "no mailbox grants -- ask an administrator for one",
					})
				}
				return nil
			}
			return a.emit(output.Result{Data: id})
		},
	}
}

func authStatus(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show how this CLI is configured to authenticate",
		Long: strings.TrimSpace(`
Report the resolved configuration and whether the deployment answers.

Nothing secret is printed: the client id is shown because it is an identifier, the
secrets are reported only as present or absent, and the API token only by where it
came from (env, file:<path> or credentials:<path>).`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			cfg := a.Cfg
			if hint := cfg.TokenHint(); hint != "" {
				a.Out.Warn("%s", hint)
			}

			status := map[string]any{
				"base_url":       cfg.BaseURL,
				"profile":        cfg.Profile,
				"config_file":    orNone(cfg.Path()),
				"mailbox":        orNone(cfg.Mailbox),
				"auth_method":    cfg.Auth(),
				"token_present":  cfg.Token != "",
				"token_source":   orNone(cfg.TokenSource()),
				"client_id":      orNone(cfg.ClientID),
				"secret_present": cfg.ClientSecret != "",
				"read_only":      cfg.ReadOnly,
				"timeout":        cfg.Timeout.String(),
				"retries":        cfg.Retries,
				"output":         string(a.Out.Format()),
				"fencing":        a.Out.Fencing(),
			}

			// Actually calling the deployment is the only honest way to report
			// whether authentication works. Configuration looking right and
			// authentication succeeding are different claims.
			id, err := a.Client.Whoami(a.Ctx(c))
			if err != nil {
				e := fail.AsError(err)
				status["reachable"] = false
				status["error"] = e.Message
				status["error_code"] = e.Code
				status["remediation"] = e.Remediation
				if err := a.emit(output.Result{Data: status}); err != nil {
					return err
				}
				return err
			}

			status["reachable"] = true
			status["role"] = id.Role
			status["mailbox_count"] = len(id.Mailboxes)
			status["authorization_enforced"] = id.Enforced
			if id.AuthMode != "" {
				status["deployment_auth_mode"] = id.AuthMode
			}
			if id.Email != "" {
				status["email"] = id.Email
			}

			return a.emit(output.Result{
				Data:    status,
				Summary: fmt.Sprintf("authenticated to %s as %s", cfg.BaseURL, id.Role),
			})
		},
	}
}

func orNone(s string) string {
	if s == "" {
		return ""
	}
	return s
}

// authCan answers "may I do this" without attempting it.
//
// The alternative is to try the operation and read the 403, which for a mutation
// means finding out by doing half of it. A caller planning a batch of work wants to
// know beforehand.
func authCan(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "can <capability> [mailbox]",
		Short: "Check whether you hold a capability, without using it",
		Long: strings.TrimSpace(`
Report whether your grant on a mailbox carries a capability. Exits 0 if it does and 4
if it does not, so a script can branch on the exit code alone.

Capabilities:
  read                what you can open: list, read, search, attachments, export
  sendAs              send as the mailbox, leaving no trace of who sent it
  sendOnBehalf        send attributed as "you on behalf of the mailbox"
  draft               write drafts. Needs no send permission
  delete              move to Trash, and restore from it
  deletePermanently   destroy irrecoverably, and empty Trash
  organise            folders, labels, read/star, snooze, mute, priority
  manageRules         inbound rules and the sender lists
  manageSettings      identity, signatures, forwarding, auto-reply, agent prompt

Roles bundle these: viewer is read; agent adds sendOnBehalf, draft, delete and
organise; manager adds sendAs, deletePermanently and manageRules; owner is everything.`),
		Example: exampleBlock(
			"cloudmail auth can sendAs",
			"",
			"if cloudmail auth can deletePermanently --mailbox shared@example.com; then",
			"  cloudmail mail empty-trash --mailbox shared@example.com --force",
			"fi",
		),
		Args: cobra.RangeArgs(1, 2),
		RunE: func(c *cobra.Command, args []string) error {
			capability := args[0]
			if !validCapability(capability) {
				return fail.Usagef("unknown capability %q", capability).
					WithRemediation("one of: %s", strings.Join(allCapabilities(), ", "))
			}
			mailbox := a.Cfg.Mailbox
			if len(args) == 2 {
				mailbox = args[1]
			}
			if mailbox == "" {
				return fail.Usagef("no mailbox given").
					WithRemediation("name one, or set a default with " +
						"`cloudmail config set mailbox you@example.com`")
			}

			id, err := a.Client.Whoami(a.Ctx(c))
			if err != nil {
				return err
			}

			allowed := false
			reason := ""
			switch {
			case id.Unrestricted():
				allowed = true
				reason = "administrator: every capability on every mailbox"
			default:
				grant, ok := id.Grant(mailbox)
				if !ok {
					reason = fmt.Sprintf("no grant on %s", mailbox)
				} else if grant.Can(capability) {
					allowed = true
					reason = fmt.Sprintf("granted by role %q", grant.Role)
				} else {
					reason = fmt.Sprintf("role %q does not include it (you have: %s)",
						grant.Role, strings.Join(grant.Capabilities, ", "))
				}
			}

			result := map[string]any{
				"capability": capability,
				"mailbox":    mailbox,
				"allowed":    allowed,
				"reason":     reason,
			}
			if err := a.emit(output.Result{Data: result}); err != nil {
				return err
			}
			if !allowed {
				// Exit 4 rather than 0-with-false, so `if cloudmail auth can ...`
				// works as a shell condition without parsing the output.
				e := fail.New(fail.Denied, "CAPABILITY_MISSING",
					fmt.Sprintf("you do not hold %q on %s", capability, mailbox))
				e.Capability = capability
				return e.WithRemediation(
					"ask an administrator to grant it at Settings -> Access")
			}
			return nil
		},
	}
}

func allCapabilities() []string {
	return []string{
		"read", "sendAs", "sendOnBehalf", "draft",
		"delete", "deletePermanently", "organise",
		"manageRules", "manageSettings",
	}
}

func validCapability(s string) bool {
	for _, c := range allCapabilities() {
		if c == s {
			return true
		}
	}
	return false
}

// ── config ─────────────────────────────────────────────────────────

func newConfigCommand(a *App) *cobra.Command {
	c := group("config", "Read and write stored settings", `
Settings resolve from three places, and the later ones win: the config file, then
environment variables, then command-line flags. The file holds what is stable, the
environment holds what is secret or per-session, and a flag overrides both for one
command.

Profiles let one file hold several deployments -- production and staging, say -- so
you switch with `+"`config use`"+` instead of editing.

Secrets are not stored in the file. An API token comes from CLOUDMAIL_TOKEN,
CLOUDMAIL_TOKEN_FILE, or the separate credentials file `+"`cloudmail auth login`"+`
writes; an Access service token secret from CLOUDMAIL_CLIENT_SECRET or
--client-secret-file.`,
		"cloudmail config show",
		"cloudmail config set base-url https://mail.example.com",
		"cloudmail config set mailbox hello@example.com",
		"cloudmail config use staging",
	)
	c.AddCommand(configShow(a), configGet(a), configSet(a), configPath(a),
		configProfiles(a), configUse(a), configUnset(a))
	return c
}

// settableKeys is the writable surface, kept as data so `config set` can validate a
// key and list the alternatives in one place.
var settableKeys = map[string]string{
	"base-url":  "deployment root, e.g. https://mail.example.com",
	"mailbox":   "default mailbox address",
	"client-id": "legacy Access service token client id",
	"output":    "default output format: auto, json, ndjson, table, csv, plain",
	"color":     "colour: auto, always, never",
	"fence":     "delimit untrusted content: auto, always, never",
	"timeout":   "per-request timeout, e.g. 30s",
	"retries":   "retries after a transient failure",
	"read-only": "true to refuse every mutation",
}

func configShow(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "show",
		Short: "Show the resolved configuration",
		Long: strings.TrimSpace(`
Show the settings actually in effect, after the file, the environment and the flags
have been combined. No secret values are printed.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			cfg := a.Cfg
			return a.emit(output.Result{Data: map[string]any{
				"profile":        cfg.Profile,
				"config_file":    cfg.Path(),
				"base-url":       cfg.BaseURL,
				"mailbox":        cfg.Mailbox,
				"client-id":      cfg.ClientID,
				"secret_present": cfg.ClientSecret != "",
				"token_present":  cfg.Token != "",
				"auth_method":    cfg.Auth(),
				"output":         cfg.Output,
				"color":          cfg.Color,
				"fence":          cfg.Fence,
				"timeout":        cfg.Timeout.String(),
				"retries":        cfg.Retries,
				"read-only":      cfg.ReadOnly,
			}})
		},
	}
}

func configGet(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "get <key>",
		Short: "Print one setting",
		Long: strings.TrimSpace(`
Print a single value, with no decoration, so it can be captured in a shell variable.

Keys: ` + strings.Join(sortedKeys(settableKeys), ", ")),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			v, err := readConfigKey(a.Cfg, args[0])
			if err != nil {
				return err
			}
			// Deliberately bare: `X=$(cloudmail config get mailbox)` should not
			// need trimming.
			fmt.Fprintln(a.Out.Out(), v)
			return nil
		},
	}
}

func readConfigKey(cfg *config.Config, key string) (string, error) {
	switch key {
	case "base-url":
		return cfg.BaseURL, nil
	case "mailbox":
		return cfg.Mailbox, nil
	case "client-id":
		return cfg.ClientID, nil
	case "output":
		return cfg.Output, nil
	case "color":
		return cfg.Color, nil
	case "fence":
		return cfg.Fence, nil
	case "timeout":
		return cfg.Timeout.String(), nil
	case "retries":
		return fmt.Sprint(cfg.Retries), nil
	case "read-only":
		return fmt.Sprint(cfg.ReadOnly), nil
	case "profile":
		return cfg.Profile, nil
	default:
		return "", fail.Usagef("unknown setting %q", key).
			WithRemediation("one of: %s", strings.Join(sortedKeys(settableKeys), ", "))
	}
}

func configSet(a *App) *cobra.Command {
	var profile string
	c := &cobra.Command{
		Use:   "set <key> <value>",
		Short: "Store a setting",
		Long: strings.TrimSpace(`
Write a setting to the config file.

Keys:
` + describeKeys()),
		Example: exampleBlock(
			"cloudmail config set base-url https://mail.example.com",
			"cloudmail config set mailbox hello@example.com",
			"cloudmail config set output json",
			"",
			"# A second deployment, kept separate",
			"cloudmail config set base-url https://staging.example.com --profile staging",
		),
		Args: cobra.ExactArgs(2),
		RunE: func(c *cobra.Command, args []string) error {
			key, value := args[0], args[1]
			if _, ok := settableKeys[key]; !ok {
				return fail.Usagef("unknown setting %q", key).
					WithRemediation("one of: %s", strings.Join(sortedKeys(settableKeys), ", "))
			}

			name := profile
			if name == "" {
				name = a.Cfg.Profile
			}

			// Load the stored profile rather than the resolved config: writing the
			// resolved one would silently bake this session's environment
			// variables and flags into the file.
			stored, err := loadStoredProfile(name)
			if err != nil {
				return err
			}
			if err := applyConfigKey(stored, key, value); err != nil {
				return err
			}
			if err := stored.Validate(); err != nil {
				return fail.Usagef("%s", err.Error())
			}
			if err := config.Save(name, stored); err != nil {
				return fail.Errf("%s", err.Error())
			}

			path, _ := config.FilePath()
			return a.emit(output.Result{
				Data: map[string]any{
					"profile": name, "key": key, "value": value, "file": path,
				},
				Summary: fmt.Sprintf("%s = %s (profile %s)", key, value, name),
			})
		},
	}
	c.Flags().StringVar(&profile, "in-profile", "", "write to this profile instead of the current one")
	return c
}

// loadStoredProfile reads one profile from disk without the environment layered on.
func loadStoredProfile(name string) (*config.Config, error) {
	// A fresh Load with no overrides and the environment ignored is not something
	// config exposes, so the profile is rebuilt from defaults plus whatever the
	// file holds. Anything the file does not set stays at its default, which is
	// the correct starting point for a write.
	cfg, err := config.Load(config.Overrides{Profile: name})
	if err != nil {
		// A profile that does not exist yet is the normal case for the first
		// `config set`, so start from defaults rather than failing.
		d := config.Defaults()
		d.Profile = name
		return d, nil
	}
	// Secrets are never persisted; clear them so a Save cannot write one even if a
	// future change to config.Save forgets.
	cfg.Token = ""
	cfg.ClientSecret = ""
	cfg.AccessJWT = ""
	cfg.MigrationToken = ""
	return cfg, nil
}

func applyConfigKey(cfg *config.Config, key, value string) error {
	switch key {
	case "base-url":
		cfg.BaseURL = strings.TrimRight(value, "/")
	case "mailbox":
		cfg.Mailbox = value
	case "client-id":
		cfg.ClientID = value
	case "output":
		cfg.Output = value
	case "color":
		cfg.Color = value
	case "fence":
		cfg.Fence = value
	case "timeout":
		d, err := config.ParseDuration(value)
		if err != nil {
			return fail.Usagef("%s", err.Error())
		}
		cfg.Timeout = d
	case "retries":
		var n int
		if _, err := fmt.Sscanf(value, "%d", &n); err != nil {
			return fail.Usagef("retries must be a number, got %q", value)
		}
		cfg.Retries = n
	case "read-only":
		cfg.ReadOnly = value == "true" || value == "1" || value == "yes"
	default:
		return fail.Usagef("unknown setting %q", key)
	}
	return nil
}

func configUnset(a *App) *cobra.Command {
	var profile string
	c := &cobra.Command{
		Use:   "unset <key>",
		Short: "Clear a stored setting",
		Long:  "Remove a setting from the config file, restoring its default.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			name := profile
			if name == "" {
				name = a.Cfg.Profile
			}
			stored, err := loadStoredProfile(name)
			if err != nil {
				return err
			}
			// Setting the field to the default's value is what "unset" means for a
			// merge-based config: an empty field is skipped by merge and so falls
			// back to the default on the next load.
			def := config.Defaults()
			switch args[0] {
			case "mailbox":
				stored.Mailbox = ""
			case "client-id":
				stored.ClientID = ""
			case "base-url":
				stored.BaseURL = def.BaseURL
			case "output":
				stored.Output = def.Output
			case "color":
				stored.Color = def.Color
			case "fence":
				stored.Fence = def.Fence
			case "timeout":
				stored.Timeout = def.Timeout
			case "retries":
				stored.Retries = def.Retries
			case "read-only":
				stored.ReadOnly = false
			default:
				return fail.Usagef("unknown setting %q", args[0]).
					WithRemediation("one of: %s", strings.Join(sortedKeys(settableKeys), ", "))
			}
			if err := config.Save(name, stored); err != nil {
				return fail.Errf("%s", err.Error())
			}
			return a.emit(output.Result{
				Data:    map[string]any{"profile": name, "unset": args[0]},
				Summary: fmt.Sprintf("%s cleared in profile %s", args[0], name),
			})
		},
	}
	c.Flags().StringVar(&profile, "in-profile", "", "act on this profile instead of the current one")
	return c
}

func configPath(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "path",
		Short: "Print the config file path",
		Long: strings.TrimSpace(`
Print where the config file lives, whether or not it exists yet.

The location honours CLOUDMAIL_CONFIG, then CLOUDMAIL_CONFIG_DIR, then
XDG_CONFIG_HOME, then ~/.config/cloudmail.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			p, err := config.FilePath()
			if err != nil {
				return fail.Errf("%s", err.Error())
			}
			fmt.Fprintln(a.Out.Out(), p)
			return nil
		},
	}
}

func configProfiles(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "profiles",
		Short: "List stored profiles",
		Long:  "Show the profiles in the config file and which is current.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			names, current, err := config.Profiles()
			if err != nil {
				return fail.Errf("%s", err.Error())
			}
			sort.Strings(names)
			rows := make([]map[string]any, 0, len(names))
			for _, n := range names {
				rows = append(rows, map[string]any{"profile": n, "current": n == current})
			}
			return a.emit(output.Result{
				Data: rows,
				Columns: []output.Column{
					{Header: "profile", Field: "profile"},
					{Header: "current", Field: "current"},
				},
				Empty: "no profiles yet -- create one with `cloudmail config set base-url <url>`",
			})
		},
	}
}

func configUse(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "use <profile>",
		Short: "Switch the current profile",
		Long:  "Point the config file at a different profile for subsequent commands.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := config.SetCurrentProfile(args[0]); err != nil {
				return fail.Usagef("%s", err.Error())
			}
			return a.emit(output.Result{
				Data:    map[string]any{"profile": args[0]},
				Summary: fmt.Sprintf("now using profile %s", args[0]),
			})
		},
	}
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func describeKeys() string {
	var b strings.Builder
	for _, k := range sortedKeys(settableKeys) {
		fmt.Fprintf(&b, "  %-12s %s\n", k, settableKeys[k])
	}
	return strings.TrimRight(b.String(), "\n")
}
