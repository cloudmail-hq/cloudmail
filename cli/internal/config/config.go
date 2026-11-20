// Package config resolves cloudmail's settings from three sources with a fixed
// precedence: command-line flags beat environment variables, which beat the
// config file on disk.
//
// That order is the one every CLI user already expects, and it is the order that
// makes the tool usable from a script: the file holds what is stable (which
// deployment, which mailbox you usually work in), the environment holds what is
// per-session or secret, and a flag overrides both for one invocation without
// disturbing either.
//
// Credentials are deliberately never accepted as flag values. A flag lands in
// the process list and in shell history, so `--client-secret hunter2` leaks the
// secret to every other user on the box. Secrets come from the environment, from
// a file named by --client-secret-file or CLOUDMAIL_TOKEN_FILE, from stdin, or from
// the credentials file `cloudmail auth login` writes.
//
// Secrets never go in config.json. That file is meant to be read, copied between
// machines and pasted into bug reports; the credentials file next to it is 0600,
// holds nothing else, and is refused if anyone but its owner can read it.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// EnvPrefix is prepended to every environment variable this CLI reads.
const EnvPrefix = "CLOUDMAIL_"

// The CLI was called tapemail before it was renamed cloudmail. Its config
// directory and TAPEMAIL_* variables are still read when the new ones are
// absent, so existing logins and scripts keep working; LegacyNotice reports it.
const (
	LegacyEnvPrefix = "TAPEMAIL_"
	legacyDirName   = "tapemail"
	dirName         = "cloudmail"
)

// legacyUsed records which legacy source was read, for LegacyNotice.
var legacyUsed []string

func noteLegacy(what string) {
	for _, w := range legacyUsed {
		if w == what {
			return
		}
	}
	legacyUsed = append(legacyUsed, what)
}

// LegacyNotice is a one-line notice naming the old tapemail settings that were
// used, or "" when none were.
func LegacyNotice() string {
	if len(legacyUsed) == 0 {
		return ""
	}
	return "using " + strings.Join(legacyUsed, " and ") +
		" from tapemail, cloudmail's old name; move them to the cloudmail names to silence this"
}

// getenv reads CLOUDMAIL_<name>, falling back to TAPEMAIL_<name>.
func getenv(name string) string {
	if v := os.Getenv(EnvPrefix + name); v != "" {
		return v
	}
	if v := os.Getenv(LegacyEnvPrefix + name); v != "" {
		noteLegacy(LegacyEnvPrefix + name)
		return v
	}
	return ""
}

// DefaultBaseURL points at a local `npm run dev` server, because that is the
// only endpoint that exists before an operator has told us about theirs. A dev
// server runs built-in auth for real, so this still needs an API token unless
// the operator set DEV_AUTH_BYPASS=1.
const DefaultBaseURL = "http://localhost:5173"

// TokenPrefix starts every API token the deployment mints (`ttk_<id>_<secret>`).
// Used only to hint at a likely mistake -- pasting a session cookie or an Access
// secret -- never to refuse a value, so a future token format still works.
const TokenPrefix = "ttk_"

// Config is the fully resolved settings for one invocation.
//
// Every field is populated by Load; nothing reads the environment or the file
// after that, so a command handler cannot accidentally observe a different
// value than the one Validate checked.
type Config struct {
	// Profile is the name of the config-file section these values came from. Not
	// persisted -- the map key in the file already carries it -- so omitempty
	// keeps a stored profile from holding a redundant empty string.
	Profile string `json:"profile,omitempty"`

	// BaseURL is the deployment root, without a trailing slash and without the
	// /api/v1 prefix -- e.g. https://mailer.example.com.
	BaseURL string `json:"base_url"`

	// Mailbox is the mailbox address used when a command needs one and the user
	// did not pass --mailbox. Having a default is what makes the CLI pleasant to
	// use by hand; every command still accepts an explicit override.
	Mailbox string `json:"mailbox,omitempty"`

	// Token is a personal API token (`ttk_...`) created in the app at Settings ->
	// Account & security -> API tokens, sent as `Authorization: Bearer`. It acts
	// with the authority of the user who created it. Preferred over the Access
	// credentials below when both are present.
	Token string `json:"-"` // never serialized

	// ClientID and ClientSecret are a Cloudflare Access service token: the
	// machine credential for a deployment still running in legacy Access mode,
	// where authentication happens at the edge rather than in the application.
	ClientID     string `json:"client_id,omitempty"`
	ClientSecret string `json:"-"` // never serialized

	// AccessJWT is an already-minted Access assertion, sent as
	// Cf-Access-Jwt-Assertion. Useful behind `cloudflared access token`, where
	// the JWT is what you have and a service token is what you don't.
	AccessJWT string `json:"-"` // never serialized

	// MigrationToken authorizes the /_migrate routes. Separate from everything
	// else because it is a deployment-level break-glass secret.
	MigrationToken string `json:"-"` // never serialized

	// Timeout bounds a single HTTP request.
	Timeout Duration `json:"timeout,omitempty"`

	// Retries is the number of additional attempts after the first failure.
	// Only idempotent requests and explicit 429s are retried; see internal/api.
	Retries int `json:"retries,omitempty"`

	// Output is the response format: json, ndjson, table, csv or plain.
	Output string `json:"output,omitempty"`

	// Color controls ANSI styling: auto, always or never.
	Color string `json:"color,omitempty"`

	// ReadOnly refuses every state-changing request inside this process, before
	// it reaches the network. An agent operator can set CLOUDMAIL_READ_ONLY=1
	// once and stop auditing individual commands.
	ReadOnly bool `json:"read_only,omitempty"`

	// FencePolicy controls how untrusted message content is delimited. See
	// internal/output.Fence.
	Fence string `json:"fence,omitempty"`

	// Verbose logs each HTTP request to stderr.
	Verbose bool `json:"-"`

	// path is the file these values were loaded from, for error messages.
	path string

	// tokenSource says where Token came from, for `auth status`.
	tokenSource string

	// warnings are problems Load worked around rather than failed on, for the
	// command layer to print.
	warnings []string
}

// Warnings reports problems Load worked around, such as a credentials file it
// refused to read.
func (c *Config) Warnings() []string { return c.warnings }

// Path reports the config file this Config was resolved from, or "" when no
// file was involved.
func (c *Config) Path() string { return c.path }

// TokenSource reports where the API token came from: "env", "file:<path>",
// "credentials:<path>", or "" when there is none.
func (c *Config) TokenSource() string { return c.tokenSource }

// Auth reports how this Config will authenticate, for `auth status` and for
// error remediation text.
//
// An API token wins over Access credentials. Someone who has created a token
// has moved to built-in auth; a CF_ACCESS_* variable still exported from an
// older script should not silently take precedence.
func (c *Config) Auth() string {
	switch {
	case c.Token != "":
		return "api-token"
	case c.ClientID != "" && c.ClientSecret != "":
		return "service-token"
	case c.AccessJWT != "":
		return "access-jwt"
	default:
		return "none"
	}
}

// TokenHint returns a warning when the token does not look like one the
// deployment mints, or "" when it does. Advisory only; see TokenPrefix.
func (c *Config) TokenHint() string {
	return TokenHint(c.Token)
}

// TokenHint is the check behind Config.TokenHint, for a token not yet loaded.
func TokenHint(token string) string {
	if token == "" || strings.HasPrefix(token, TokenPrefix) {
		return ""
	}
	return fmt.Sprintf("the API token does not start with %q; tokens are created at "+
		"Settings -> Account & security -> API tokens and look like ttk_<id>_<secret>",
		TokenPrefix)
}

// Duration is a time.Duration that round-trips through JSON as a string like
// "30s", so a config file stays readable instead of holding 30000000000.
type Duration struct{ Value int64 } // nanoseconds

// file is the on-disk shape: a set of named profiles plus a pointer at the
// active one. Profiles exist because anyone with a staging deployment will
// otherwise keep two config files and edit the wrong one.
type file struct {
	Current  string             `json:"current_profile,omitempty"`
	Profiles map[string]*Config `json:"profiles"`
}

// Defaults returns the configuration used when nothing has been set anywhere.
func Defaults() *Config {
	return &Config{
		Profile: "default",
		BaseURL: DefaultBaseURL,
		Timeout: Duration{Value: 30_000_000_000}, // 30s
		Retries: 2,
		Output:  "auto",
		Color:   "auto",
		Fence:   "auto",
	}
}

// Dir is the directory holding the config file. It honours CLOUDMAIL_CONFIG_DIR
// first, then XDG_CONFIG_HOME, then ~/.config -- the same ladder every other
// well-behaved CLI walks, so the file lands where a user expects to find it.
//
// When the cloudmail directory does not exist but the old tapemail one does,
// the old one is used (for reads and writes, so config and credentials stay
// together) and LegacyNotice says so.
func Dir() (string, error) {
	if dir := getenv("CONFIG_DIR"); dir != "" {
		return dir, nil
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("cannot locate your home directory: %w", err)
		}
		base = filepath.Join(home, ".config")
	}
	dir := filepath.Join(base, dirName)
	if _, err := os.Stat(dir); err == nil {
		return dir, nil
	}
	legacy := filepath.Join(base, legacyDirName)
	if info, err := os.Stat(legacy); err == nil && info.IsDir() {
		noteLegacy(legacy)
		return legacy, nil
	}
	return dir, nil
}

// FilePath is the full path to the config file.
func FilePath() (string, error) {
	if p := getenv("CONFIG"); p != "" {
		return p, nil
	}
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

// CredentialsPath is the file `cloudmail auth login` writes API tokens to. It
// sits beside config.json in Dir(), but is a separate file so the config can be
// shared without leaking a secret.
func CredentialsPath() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "credentials"), nil
}

// Overrides carries the values a command line supplied. A nil pointer field
// means "the user said nothing", which is what lets flags layer over the
// environment without a zero value silently winning.
//
// Secrets are absent by design: there is no --client-secret. See the package
// comment.
type Overrides struct {
	Profile         string
	BaseURL         *string
	Mailbox         *string
	ClientID        *string
	ClientSecretEnv *string // name of a file to read the secret from
	Timeout         *int64
	Retries         *int
	Output          *string
	Color           *string
	ReadOnly        *bool
	Fence           *string
	Verbose         *bool

	// CreatesProfile marks a command that writes the named profile, such as
	// `config set` and `auth login`. For those, a named profile that does not
	// exist yet is the profile about to be created, not a mistake, so Load
	// starts it from defaults instead of refusing.
	CreatesProfile bool
}

// Load resolves the effective configuration.
//
// A missing config file is not an error: the CLI must work on a fresh machine
// with nothing but environment variables, which is the situation every CI job
// and every containerised agent starts in.
func Load(ov Overrides) (*Config, error) {
	legacyUsed = nil
	cfg := Defaults()

	path, err := FilePath()
	if err != nil {
		return nil, err
	}

	f, err := readFile(path)
	if err != nil {
		return nil, err
	}

	name := ov.Profile
	if name == "" {
		name = getenv("PROFILE")
	}
	if name == "" && f != nil {
		name = f.Current
	}
	if name == "" {
		name = "default"
	}
	// Set even without a config file, so the credentials lookup below and
	// `auth login` agree on which profile a token belongs to.
	cfg.Profile = name

	if f != nil {
		p, ok := f.Profiles[name]
		if !ok {
			// An explicitly named profile that does not exist is a mistake worth
			// reporting: silently falling back to defaults would talk to the
			// wrong deployment, which for a mail tool means sending real mail
			// from the wrong place.
			if (ov.Profile != "" || getenv("PROFILE") != "") && !ov.CreatesProfile {
				return nil, fmt.Errorf(
					"profile %q is not in %s (available: %s); create it with "+
						"`cloudmail --profile %s config set base-url <url>`",
					name, path, strings.Join(profileNames(f), ", "), name)
			}
		} else {
			merge(cfg, p)
		}
		cfg.path = path
	}

	// The stored token is the lowest-precedence source, so it goes in before the
	// environment, which overrides it.
	//
	// A credentials file that cannot be used is skipped with a warning rather
	// than failing the load: failing would also block `auth logout` and
	// `auth login`, the two commands that repair it.
	creds, credPath, err := readCredentials()
	if err != nil {
		cfg.warnings = append(cfg.warnings, err.Error())
	} else if c := creds.Profiles[name]; c != nil && c.Token != "" {
		cfg.Token = strings.TrimSpace(c.Token)
		cfg.tokenSource = "credentials:" + credPath
	}

	if err := applyEnv(cfg); err != nil {
		return nil, err
	}

	if err := applyOverrides(cfg, ov); err != nil {
		return nil, err
	}

	cfg.BaseURL = strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	cfg.Mailbox = strings.TrimSpace(cfg.Mailbox)

	return cfg, cfg.Validate()
}

func profileNames(f *file) []string {
	if len(f.Profiles) == 0 {
		return []string{"none"}
	}
	out := make([]string, 0, len(f.Profiles))
	for k := range f.Profiles {
		out = append(out, k)
	}
	return out
}

func readFile(path string) (*file, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cannot read config %s: %w", path, err)
	}
	var f file
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf(
			"config %s is not valid JSON: %w\nrun `cloudmail config init --force` to rewrite it", path, err)
	}
	return &f, nil
}

// merge copies the non-empty fields of src over dst. Empty means "not set in
// this profile", so a profile can specify only a base URL and inherit the rest.
func merge(dst, src *Config) {
	if src.BaseURL != "" {
		dst.BaseURL = src.BaseURL
	}
	if src.Mailbox != "" {
		dst.Mailbox = src.Mailbox
	}
	if src.ClientID != "" {
		dst.ClientID = src.ClientID
	}
	if src.Timeout.Value != 0 {
		dst.Timeout = src.Timeout
	}
	if src.Retries != 0 {
		dst.Retries = src.Retries
	}
	if src.Output != "" {
		dst.Output = src.Output
	}
	if src.Color != "" {
		dst.Color = src.Color
	}
	if src.Fence != "" {
		dst.Fence = src.Fence
	}
	if src.ReadOnly {
		dst.ReadOnly = true
	}
}

func applyEnv(cfg *Config) error {
	if v := getenv("BASE_URL"); v != "" {
		cfg.BaseURL = v
	}
	if v := getenv("MAILBOX"); v != "" {
		cfg.Mailbox = v
	}
	if v := getenv("OUTPUT"); v != "" {
		cfg.Output = v
	}
	if v := getenv("COLOR"); v != "" {
		cfg.Color = v
	}
	if v := getenv("FENCE"); v != "" {
		cfg.Fence = v
	}
	if v := getenv("RETRIES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			cfg.Retries = n
		}
	}
	if v := getenv("TIMEOUT"); v != "" {
		if d, err := ParseDuration(v); err == nil {
			cfg.Timeout = d
		}
	}
	if truthy(getenv("READ_ONLY")) {
		cfg.ReadOnly = true
	}

	// Credentials. Both the CLOUDMAIL_-prefixed and the bare CF_ACCESS_* spellings
	// are honoured: the latter is what Cloudflare's own docs and existing scripts
	// use, and refusing it would make every reader of those docs debug an auth
	// failure that is really a naming difference.
	cfg.ClientID = firstEnv(cfg.ClientID,
		EnvPrefix+"CLIENT_ID", LegacyEnvPrefix+"CLIENT_ID", "CF_ACCESS_CLIENT_ID")
	cfg.ClientSecret = firstEnv(cfg.ClientSecret,
		EnvPrefix+"CLIENT_SECRET", LegacyEnvPrefix+"CLIENT_SECRET", "CF_ACCESS_CLIENT_SECRET")
	cfg.AccessJWT = firstEnv(cfg.AccessJWT,
		EnvPrefix+"ACCESS_JWT", LegacyEnvPrefix+"ACCESS_JWT", "CF_ACCESS_JWT_ASSERTION", "CF_AUTHORIZATION")
	cfg.MigrationToken = firstEnv(cfg.MigrationToken,
		EnvPrefix+"MIGRATION_TOKEN", LegacyEnvPrefix+"MIGRATION_TOKEN", "MIGRATION_TOKEN")

	// A secret may also be pointed at rather than exported, so a systemd unit or
	// a Kubernetes projected volume can supply it without it ever being in the
	// environment of a child process.
	if p := getenv("CLIENT_SECRET_FILE"); p != "" && cfg.ClientSecret == "" {
		if s, err := readSecretFile(p); err == nil {
			cfg.ClientSecret = s
		}
	}

	// The API token: CLOUDMAIL_TOKEN beats CLOUDMAIL_TOKEN_FILE, and both beat the
	// credentials file already loaded. Unlike the secret file above, an
	// unreadable token file is an error: it was named explicitly, and falling
	// back to a stored token would act as a different user than intended.
	if v := strings.TrimSpace(getenv("TOKEN")); v != "" {
		cfg.Token = v
		cfg.tokenSource = "env"
	} else if p := getenv("TOKEN_FILE"); p != "" {
		s, err := readSecretFile(p)
		if err != nil {
			return err
		}
		cfg.Token = s
		cfg.tokenSource = "file:" + p
	}
	return nil
}

func firstEnv(current string, names ...string) string {
	if current != "" {
		return current
	}
	for _, n := range names {
		if v := strings.TrimSpace(os.Getenv(n)); v != "" {
			if strings.HasPrefix(n, LegacyEnvPrefix) {
				noteLegacy(n)
			}
			return v
		}
	}
	return ""
}

func readSecretFile(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("cannot read secret file %s: %w", path, err)
	}
	// Trailing newlines are what `echo secret > file` produces, and a newline in
	// an HTTP header value is rejected by net/http, so the failure would surface
	// far from its cause.
	return strings.TrimSpace(string(raw)), nil
}

func applyOverrides(cfg *Config, ov Overrides) error {
	if ov.BaseURL != nil {
		cfg.BaseURL = *ov.BaseURL
	}
	if ov.Mailbox != nil {
		cfg.Mailbox = *ov.Mailbox
	}
	if ov.ClientID != nil {
		cfg.ClientID = *ov.ClientID
	}
	if ov.ClientSecretEnv != nil && *ov.ClientSecretEnv != "" {
		s, err := readSecretFile(*ov.ClientSecretEnv)
		if err != nil {
			return err
		}
		cfg.ClientSecret = s
	}
	if ov.Timeout != nil {
		cfg.Timeout = Duration{Value: *ov.Timeout}
	}
	if ov.Retries != nil {
		cfg.Retries = *ov.Retries
	}
	if ov.Output != nil {
		cfg.Output = *ov.Output
	}
	if ov.Color != nil {
		cfg.Color = *ov.Color
	}
	if ov.Fence != nil {
		cfg.Fence = *ov.Fence
	}
	if ov.ReadOnly != nil && *ov.ReadOnly {
		cfg.ReadOnly = true
	}
	if ov.Verbose != nil {
		cfg.Verbose = *ov.Verbose
	}
	return nil
}

var (
	validOutputs = []string{"auto", "json", "ndjson", "table", "csv", "plain"}
	validColors  = []string{"auto", "always", "never"}
	validFences  = []string{"auto", "always", "never"}
)

// Validate checks the resolved values. It reports usage problems, so callers
// map its errors to the usage exit code rather than to a generic failure.
func (c *Config) Validate() error {
	if c.BaseURL == "" {
		return errors.New(
			"no deployment URL configured\n" +
				"set one with `cloudmail config set base-url https://mail.example.com`, " +
				"or pass --base-url, or export CLOUDMAIL_BASE_URL")
	}
	if !strings.HasPrefix(c.BaseURL, "http://") && !strings.HasPrefix(c.BaseURL, "https://") {
		return fmt.Errorf("base URL %q must start with http:// or https://", c.BaseURL)
	}
	if !oneOf(c.Output, validOutputs) {
		return fmt.Errorf("unknown --output %q (want one of: %s)",
			c.Output, strings.Join(validOutputs, ", "))
	}
	if !oneOf(c.Color, validColors) {
		return fmt.Errorf("unknown --color %q (want one of: %s)",
			c.Color, strings.Join(validColors, ", "))
	}
	if !oneOf(c.Fence, validFences) {
		return fmt.Errorf("unknown --fence %q (want one of: %s)",
			c.Fence, strings.Join(validFences, ", "))
	}
	if c.Retries < 0 || c.Retries > 10 {
		return fmt.Errorf("--retries must be between 0 and 10, got %d", c.Retries)
	}
	if c.Timeout.Value <= 0 {
		return errors.New("--timeout must be greater than zero")
	}
	// A space or newline inside a token is always a paste accident, and net/http
	// would reject the header with an error that names neither the token nor
	// where it came from.
	if strings.ContainsFunc(c.Token, func(r rune) bool { return r <= ' ' || r == 0x7f }) {
		return fmt.Errorf("the API token (from %s) contains whitespace or control characters; "+
			"copy it again from Settings -> Account & security -> API tokens", c.tokenSource)
	}
	// A service token is two halves and useless as one. Reporting the mismatch
	// here turns a puzzling 403 from the edge into a sentence naming the missing
	// half.
	if (c.ClientID == "") != (c.ClientSecret == "") {
		missing := "CLOUDMAIL_CLIENT_SECRET"
		if c.ClientID == "" {
			missing = "CLOUDMAIL_CLIENT_ID"
		}
		return fmt.Errorf(
			"an Access service token needs both halves; %s is not set\n"+
				"see `cloudmail auth --help` for how to create one", missing)
	}
	return nil
}

func oneOf(v string, allowed []string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}

func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// ── Persistence ────────────────────────────────────────────────────

// Save writes one profile back to the config file, leaving the other profiles
// and the current-profile pointer as they were.
//
// The file is written through a temporary file in the same directory and then
// renamed, so an interrupted write cannot leave a truncated config behind --
// which for this tool would mean the next command cannot find the deployment.
func Save(profile string, c *Config) error {
	path, err := FilePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("cannot create config directory: %w", err)
	}

	f, err := readFile(path)
	if err != nil {
		return err
	}
	if f == nil {
		f = &file{Profiles: map[string]*Config{}}
	}
	if f.Profiles == nil {
		f.Profiles = map[string]*Config{}
	}
	if profile == "" {
		profile = "default"
	}

	stored := *c
	stored.Profile = "" // implied by the map key
	stored.path = ""    // not persisted
	stored.Verbose = false
	stored.Token = "" // json:"-" already; belt and braces for a future tag change
	f.Profiles[profile] = &stored
	if f.Current == "" {
		f.Current = profile
	}

	return writeFile(path, f)
}

// SetCurrentProfile points the config file at a different profile.
func SetCurrentProfile(name string) error {
	path, err := FilePath()
	if err != nil {
		return err
	}
	f, err := readFile(path)
	if err != nil {
		return err
	}
	if f == nil || f.Profiles[name] == nil {
		return fmt.Errorf("profile %q does not exist; create it with "+
			"`cloudmail config set base-url <url> --profile %s`", name, name)
	}
	f.Current = name
	return writeFile(path, f)
}

// DeleteProfile removes a profile.
func DeleteProfile(name string) error {
	path, err := FilePath()
	if err != nil {
		return err
	}
	f, err := readFile(path)
	if err != nil {
		return err
	}
	if f == nil || f.Profiles[name] == nil {
		return fmt.Errorf("profile %q does not exist", name)
	}
	delete(f.Profiles, name)
	if f.Current == name {
		f.Current = ""
	}
	return writeFile(path, f)
}

// Profiles lists the stored profile names and which one is current.
func Profiles() (names []string, current string, err error) {
	path, e := FilePath()
	if e != nil {
		return nil, "", e
	}
	f, e := readFile(path)
	if e != nil {
		return nil, "", e
	}
	if f == nil {
		return nil, "", nil
	}
	for k := range f.Profiles {
		names = append(names, k)
	}
	return names, f.Current, nil
}

func writeFile(path string, f *file) error {
	return writeJSON(path, f)
}

// writeJSON writes v to path atomically with 0600 permissions.
func writeJSON(path string, v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')

	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*.tmp")
	if err != nil {
		return fmt.Errorf("cannot write config: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename succeeds

	// 0600 before any content lands: the file names a deployment and may hold a
	// service-token client ID, and widening permissions after writing leaves a
	// window where it is world-readable.
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// ── Credentials ────────────────────────────────────────────────────

// credentials is the on-disk shape of the credentials file: one token per
// profile, because each profile is usually a different deployment and a token
// is only valid on the deployment that minted it.
type credentials struct {
	Profiles map[string]*credential `json:"profiles"`
}

type credential struct {
	Token string `json:"token"`
}

// readCredentials loads the credentials file. A missing file is an empty set.
//
// A file readable by group or others is refused rather than used, the way ssh
// refuses a loose private key: using it quietly would leave the token exposed
// with nothing to tell the owner. The check is skipped on Windows, where the mode bits
// do not describe the ACL.
func readCredentials() (*credentials, string, error) {
	path, err := CredentialsPath()
	if err != nil {
		return nil, "", err
	}
	empty := &credentials{Profiles: map[string]*credential{}}

	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return empty, path, nil
	}
	if err != nil {
		return nil, path, fmt.Errorf("cannot read credentials %s: %w", path, err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return nil, path, fmt.Errorf(
			"credentials %s is readable by other users (mode %04o) and was not used\n"+
				"run `chmod 600 %s`, or delete it and run `cloudmail auth login` again",
			path, info.Mode().Perm(), path)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, path, fmt.Errorf("cannot read credentials %s: %w", path, err)
	}
	var c credentials
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, path, fmt.Errorf(
			"credentials %s is not valid JSON: %w\ndelete it and run `cloudmail auth login` again",
			path, err)
	}
	if c.Profiles == nil {
		c.Profiles = map[string]*credential{}
	}
	return &c, path, nil
}

// SaveToken stores an API token for a profile in the credentials file, creating
// the file (0600) and its directory (0700) as needed. It returns the file path.
func SaveToken(profile, token string) (string, error) {
	if profile == "" {
		profile = "default"
	}
	c, path, err := readCredentials()
	if err != nil {
		return path, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return path, fmt.Errorf("cannot create config directory: %w", err)
	}
	c.Profiles[profile] = &credential{Token: token}
	if err := writeJSON(path, c); err != nil {
		return path, fmt.Errorf("cannot write credentials %s: %w", path, err)
	}
	return path, nil
}

// DeleteToken removes a profile's token from the credentials file, deleting the
// file once it holds no tokens. It reports whether there was a token to remove.
func DeleteToken(profile string) (bool, string, error) {
	if profile == "" {
		profile = "default"
	}
	path, err := CredentialsPath()
	if err != nil {
		return false, "", err
	}
	// Deliberately not readCredentials: a file with loose permissions is exactly
	// the one a user wants to be able to get rid of.
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, path, nil
	}
	if err != nil {
		return false, path, fmt.Errorf("cannot read credentials %s: %w", path, err)
	}
	var c credentials
	if err := json.Unmarshal(raw, &c); err != nil || c.Profiles == nil {
		// Unreadable as credentials: nothing worth keeping, so remove it whole.
		return true, path, os.Remove(path)
	}
	if _, ok := c.Profiles[profile]; !ok {
		return false, path, nil
	}
	delete(c.Profiles, profile)
	if len(c.Profiles) == 0 {
		return true, path, os.Remove(path)
	}
	return true, path, writeJSON(path, &c)
}

// ── Duration ───────────────────────────────────────────────────────

// ParseDuration accepts Go duration syntax ("30s", "2m") and also a bare
// integer, read as seconds. The bare form exists because "--timeout 60" is what
// people type, and rejecting it teaches nothing.
func ParseDuration(s string) (Duration, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return Duration{}, errors.New("empty duration")
	}
	if n, err := strconv.Atoi(s); err == nil {
		if n <= 0 {
			return Duration{}, fmt.Errorf("duration must be positive, got %d", n)
		}
		return Duration{Value: int64(n) * 1_000_000_000}, nil
	}
	d, err := parseGoDuration(s)
	if err != nil {
		return Duration{}, fmt.Errorf("cannot read %q as a duration; try 30s or 2m", s)
	}
	if d <= 0 {
		return Duration{}, fmt.Errorf("duration must be positive, got %s", s)
	}
	return Duration{Value: d}, nil
}

// MarshalJSON renders the duration as a human string.
func (d Duration) MarshalJSON() ([]byte, error) {
	return json.Marshal(d.String())
}

// UnmarshalJSON accepts either a string ("30s") or a number of nanoseconds, so
// a hand-edited config file and a machine-written one both load.
func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		got, err := ParseDuration(s)
		if err != nil {
			return err
		}
		*d = got
		return nil
	}
	var n int64
	if err := json.Unmarshal(b, &n); err != nil {
		return fmt.Errorf("timeout must be a duration string like \"30s\"")
	}
	d.Value = n
	return nil
}
