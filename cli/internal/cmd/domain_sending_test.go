package cmd

import (
	"strings"
	"testing"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// The secret is never a flag value: it would land in argv and shell history.
func TestDomainSendingSetHasNoSecretValueFlag(t *testing.T) {
	root, _ := NewRootCommand()
	cmd, _, err := root.Find([]string{"domain", "sending", "set"})
	if err != nil || cmd == nil || cmd.Name() != "set" {
		t.Fatalf("domain sending set not found: %v", err)
	}
	for _, name := range []string{"secret", "secret-access-key", "secret-key"} {
		if cmd.Flags().Lookup(name) != nil {
			t.Errorf("--%s must not exist; use --secret-stdin or --secret-file", name)
		}
	}
	if f := cmd.Flags().Lookup("secret-stdin"); f == nil || f.Value.Type() != "bool" {
		t.Errorf("--secret-stdin must be a boolean switch")
	}
	if cmd.Flags().Lookup("secret-file") == nil {
		t.Errorf("--secret-file missing")
	}
}

func TestDomainSendingSetRejectsSesFlagsForCloudflare(t *testing.T) {
	code, hits := runCLI(t, "domain", "sending", "set", "example.com", "--provider", "cloudflare", "--region", "eu-west-1")
	if code != fail.Usage || len(hits) != 0 {
		t.Errorf("exit = %d hits = %v, want a usage error and no request", code, hits)
	}
}

func TestDomainSendingSetNeedsRegionAndKey(t *testing.T) {
	code, hits := runCLI(t, "domain", "sending", "set", "example.com", "--provider", "ses")
	if code != fail.Usage || len(hits) != 0 {
		t.Errorf("exit = %d hits = %v, want a usage error and no request", code, hits)
	}
}

func TestDomainSendingResetNeedsConsent(t *testing.T) {
	code, hits := runCLI(t, "domain", "sending", "reset", "example.com")
	if code != fail.WriteRefused || len(hits) != 0 {
		t.Errorf("exit = %d hits = %v, want refusal without consent", code, hits)
	}
	code, hits = runCLI(t, "domain", "sending", "reset", "example.com", "--yes")
	if code != fail.OK || len(hits) != 1 || !strings.HasSuffix(hits[0], "/api/v1/domains/example.com/sending") {
		t.Errorf("with --yes: exit = %d hits = %v", code, hits)
	}
}
