package cmd

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudmail-hq/cloudmail/cli/internal/config"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// runIn executes the tree with a config directory of its own and stdin set to
// stdin, and returns the error.
func runIn(t *testing.T, dir, stdin string, args ...string) *fail.Error {
	t.Helper()
	t.Setenv("CLOUDMAIL_CONFIG_DIR", dir)
	for _, k := range []string{"TOKEN", "TOKEN_FILE", "BASE_URL", "PROFILE", "CONFIG"} {
		t.Setenv("CLOUDMAIL_"+k, "")
		t.Setenv("TAPEMAIL_"+k, "")
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(w, stdin)
	w.Close()
	old := os.Stdin
	os.Stdin = r
	defer func() { os.Stdin = old; r.Close() }()

	root, _ := NewRootCommand()
	root.SetOut(io.Discard)
	root.SetArgs(append([]string{"--quiet", "--output", "json"}, args...))
	_, err = root.ExecuteC()
	if err == nil {
		return nil
	}
	return classifyTopLevel(err)
}

// `--profile X config set` then `--profile X auth login` creates and fills a
// new profile, without the `--in-profile` detour.
func TestProfileFlagCreatesANewProfile(t *testing.T) {
	dir := t.TempDir()
	if e := runIn(t, dir, "", "--profile", "default", "config", "set", "base-url", "https://a.example.com"); e != nil {
		t.Fatalf("seed default: %v", e)
	}
	if e := runIn(t, dir, "", "--profile", "newname", "config", "set", "base-url", "https://b.example.com"); e != nil {
		t.Fatalf("config set in a new profile: %v", e)
	}
	if e := runIn(t, dir, "ttk_abc_def\n", "--profile", "newname", "auth", "login", "--with-token", "--no-verify"); e != nil {
		t.Fatalf("auth login in the new profile: %v", e)
	}

	t.Setenv("CLOUDMAIL_CONFIG_DIR", dir)
	cfg, err := config.Load(config.Overrides{Profile: "newname"})
	if err != nil {
		t.Fatalf("load newname: %v", err)
	}
	if cfg.BaseURL != "https://b.example.com" || cfg.Token != "ttk_abc_def" {
		t.Errorf("newname = base %q token %q", cfg.BaseURL, cfg.Token)
	}
	def, err := config.Load(config.Overrides{Profile: "default"})
	if err != nil || def.BaseURL != "https://a.example.com" || def.Token != "" {
		t.Errorf("default changed: %+v %v", def, err)
	}

	// auth login alone also creates a profile that does not exist yet.
	if e := runIn(t, dir, "ttk_x_y\n", "--profile", "third", "auth", "login", "--with-token", "--no-verify"); e != nil {
		t.Fatalf("auth login in an absent profile: %v", e)
	}
	if _, err := os.Stat(filepath.Join(dir, "credentials")); err != nil {
		t.Fatalf("no credentials file: %v", err)
	}
}

// Every other command still refuses a profile that does not exist, because
// silently falling back would talk to the wrong deployment.
func TestUnknownProfileIsStillRefusedElsewhere(t *testing.T) {
	dir := t.TempDir()
	if e := runIn(t, dir, "", "config", "set", "base-url", "https://a.example.com"); e != nil {
		t.Fatal(e)
	}
	e := runIn(t, dir, "", "--profile", "typo", "mail", "list", "--mailbox", "a@example.com")
	if e == nil {
		t.Fatal("want a refusal for an unknown profile")
	}
	if !strings.Contains(e.Error(), `profile "typo" is not in`) ||
		!strings.Contains(e.Error(), "config set base-url") {
		t.Errorf("error = %q", e.Error())
	}
}
