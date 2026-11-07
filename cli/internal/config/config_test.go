package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// isolate points every config lookup at a fresh directory and clears the
// credential variables a developer's shell may export.
func isolate(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv(EnvPrefix+"CONFIG_DIR", dir)
	for _, k := range []string{
		"CONFIG", "PROFILE", "TOKEN", "TOKEN_FILE", "CLIENT_ID", "CLIENT_SECRET",
		"CLIENT_SECRET_FILE", "ACCESS_JWT", "BASE_URL",
	} {
		t.Setenv(EnvPrefix+k, "")
		t.Setenv(LegacyEnvPrefix+k, "")
	}
	for _, k := range []string{
		"CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET",
		"CF_ACCESS_JWT_ASSERTION", "CF_AUTHORIZATION",
	} {
		t.Setenv(k, "")
	}
	return dir
}

func TestTokenFromEnvIsPreferredOverAccess(t *testing.T) {
	isolate(t)
	t.Setenv(EnvPrefix+"TOKEN", "ttk_a_b")
	t.Setenv(EnvPrefix+"CLIENT_ID", "cid")
	t.Setenv(EnvPrefix+"CLIENT_SECRET", "csecret")

	cfg, err := Load(Overrides{})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Token != "ttk_a_b" || cfg.TokenSource() != "env" {
		t.Errorf("Token = %q from %q", cfg.Token, cfg.TokenSource())
	}
	if cfg.Auth() != "api-token" {
		t.Errorf("Auth() = %q, want api-token", cfg.Auth())
	}
}

func TestTokenPrecedenceEnvThenFileThenCredentials(t *testing.T) {
	dir := isolate(t)
	if _, err := SaveToken("default", "ttk_stored_x"); err != nil {
		t.Fatalf("SaveToken: %v", err)
	}
	tokenFile := filepath.Join(dir, "tok")
	if err := os.WriteFile(tokenFile, []byte("ttk_file_x\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	load := func() *Config {
		t.Helper()
		cfg, err := Load(Overrides{})
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		return cfg
	}

	if cfg := load(); cfg.Token != "ttk_stored_x" ||
		!strings.HasPrefix(cfg.TokenSource(), "credentials:") {
		t.Errorf("credentials only: Token = %q from %q", cfg.Token, cfg.TokenSource())
	}

	t.Setenv(EnvPrefix+"TOKEN_FILE", tokenFile)
	if cfg := load(); cfg.Token != "ttk_file_x" || cfg.TokenSource() != "file:"+tokenFile {
		t.Errorf("with file: Token = %q from %q (trailing newline must be trimmed)",
			cfg.Token, cfg.TokenSource())
	}

	t.Setenv(EnvPrefix+"TOKEN", "ttk_env_x")
	if cfg := load(); cfg.Token != "ttk_env_x" {
		t.Errorf("with env: Token = %q", cfg.Token)
	}
}

func TestMissingTokenFileIsAnError(t *testing.T) {
	dir := isolate(t)
	t.Setenv(EnvPrefix+"TOKEN_FILE", filepath.Join(dir, "absent"))
	if _, err := Load(Overrides{}); err == nil {
		t.Fatal("want an error for an unreadable CLOUDMAIL_TOKEN_FILE")
	}
}

func TestCredentialsAreScopedToProfile(t *testing.T) {
	isolate(t)
	if _, err := SaveToken("staging", "ttk_staging_x"); err != nil {
		t.Fatal(err)
	}
	staging := Defaults()
	staging.BaseURL = "https://staging.example.com"
	if err := Save("staging", staging); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(Overrides{Profile: "staging"})
	if err != nil {
		t.Fatalf("Load staging: %v", err)
	}
	if cfg.Token != "ttk_staging_x" {
		t.Errorf("staging Token = %q", cfg.Token)
	}

	t.Setenv(EnvPrefix+"CONFIG", filepath.Join(t.TempDir(), "none.json"))
	cfg, err = Load(Overrides{})
	if err != nil {
		t.Fatalf("Load default: %v", err)
	}
	if cfg.Token != "" {
		t.Errorf("default profile picked up %q from another profile", cfg.Token)
	}
}

func TestCredentialsFileIsPrivateAndTokenNeverInConfig(t *testing.T) {
	isolate(t)
	path, err := SaveToken("default", "ttk_secret_x")
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("credentials mode = %04o, want 0600", perm)
		}
	}

	// Saving a resolved config that carries the token must not write it out.
	cfg, err := Load(Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	if err := Save("default", cfg); err != nil {
		t.Fatal(err)
	}
	cfgPath, _ := FilePath()
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "ttk_secret_x") {
		t.Errorf("config.json holds the token:\n%s", raw)
	}
}

func TestLooseCredentialsAreIgnoredWithAWarning(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("mode bits do not describe Windows ACLs")
	}
	isolate(t)
	path, err := SaveToken("default", "ttk_secret_x")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(Overrides{})
	if err != nil {
		t.Fatalf("Load must not fail, or `auth logout` could not repair it: %v", err)
	}
	if cfg.Token != "" {
		t.Error("a group/world-readable credentials file was used")
	}
	if len(cfg.Warnings()) == 0 || !strings.Contains(cfg.Warnings()[0], "chmod 600") {
		t.Errorf("warnings = %q", cfg.Warnings())
	}
}

func TestDeleteTokenKeepsOtherProfiles(t *testing.T) {
	isolate(t)
	if _, err := SaveToken("default", "ttk_a_x"); err != nil {
		t.Fatal(err)
	}
	path, err := SaveToken("staging", "ttk_b_x")
	if err != nil {
		t.Fatal(err)
	}

	removed, _, err := DeleteToken("default")
	if err != nil || !removed {
		t.Fatalf("DeleteToken(default) = %v, %v", removed, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var c credentials
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if c.Profiles["default"] != nil || c.Profiles["staging"] == nil {
		t.Errorf("after delete: %s", raw)
	}

	if removed, _, _ := DeleteToken("default"); removed {
		t.Error("second delete reported a removal")
	}
	if _, _, err := DeleteToken("staging"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("credentials file left behind once empty")
	}
}

func TestTokenHintIsAdvisory(t *testing.T) {
	isolate(t)
	t.Setenv(EnvPrefix+"TOKEN", "not-a-ttk-token")
	cfg, err := Load(Overrides{})
	if err != nil {
		t.Fatalf("a non-ttk_ token must still load: %v", err)
	}
	if cfg.TokenHint() == "" {
		t.Error("want a hint for a token without the ttk_ prefix")
	}
	if TokenHint("ttk_a_b") != "" {
		t.Error("want no hint for a ttk_ token")
	}
}

func TestTokenWithWhitespaceIsRejected(t *testing.T) {
	isolate(t)
	cfg := Defaults()
	cfg.Token = "ttk_a b"
	if err := cfg.Validate(); err == nil {
		t.Error("want an error for a token containing a space")
	}
}

func TestLegacyTapemailSettingsAreReadWithANotice(t *testing.T) {
	isolate(t)
	t.Setenv(LegacyEnvPrefix+"TOKEN", "ttk_old_x")
	t.Setenv(LegacyEnvPrefix+"BASE_URL", "https://old.example.com")
	cfg, err := Load(Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Token != "ttk_old_x" || cfg.BaseURL != "https://old.example.com" {
		t.Fatalf("legacy env not read: token=%q base=%q", cfg.Token, cfg.BaseURL)
	}
	if n := LegacyNotice(); !strings.Contains(n, "TAPEMAIL_TOKEN") || strings.Contains(n, "\n") {
		t.Fatalf("notice = %q", n)
	}

	// The new name wins, and then nothing legacy is reported.
	t.Setenv(EnvPrefix+"TOKEN", "ttk_new_x")
	t.Setenv(LegacyEnvPrefix+"BASE_URL", "")
	cfg, err = Load(Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Token != "ttk_new_x" || LegacyNotice() != "" {
		t.Fatalf("token=%q notice=%q", cfg.Token, LegacyNotice())
	}
}

func TestLegacyConfigDirIsUsedWhenTheNewOneIsAbsent(t *testing.T) {
	isolate(t)
	t.Setenv(EnvPrefix+"CONFIG_DIR", "")
	t.Setenv(LegacyEnvPrefix+"CONFIG_DIR", "")
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)

	if d, _ := Dir(); d != filepath.Join(base, "cloudmail") {
		t.Fatalf("with neither directory, Dir = %s, want the cloudmail one", d)
	}
	legacy := filepath.Join(base, "tapemail")
	if err := os.MkdirAll(legacy, 0o700); err != nil {
		t.Fatal(err)
	}
	legacyUsed = nil
	if d, _ := Dir(); d != legacy {
		t.Fatalf("Dir = %s, want the legacy %s", d, legacy)
	}
	if !strings.Contains(LegacyNotice(), legacy) {
		t.Fatalf("notice = %q", LegacyNotice())
	}
	if err := os.MkdirAll(filepath.Join(base, "cloudmail"), 0o700); err != nil {
		t.Fatal(err)
	}
	if d, _ := Dir(); d != filepath.Join(base, "cloudmail") {
		t.Fatalf("once cloudmail exists, Dir = %s", d)
	}
}
