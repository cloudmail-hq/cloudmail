package cmd

import (
	"os"
	"strconv"
	"strings"
)

// UpdateCommand is the documented one-line update for macOS and Linux.
const UpdateCommand = "curl -fsSL https://raw.githubusercontent.com/cloudmail-hq/skills/main/skills/cloudmail/scripts/install.sh | CLOUDMAIL_VERSION=latest sh"

// parseSemver reads "v1.2.3" or "1.2.3" (a suffix such as -dirty or -3-gabc is
// ignored). ok is false for anything else, such as a bare commit hash.
func parseSemver(v string) (out [3]int, ok bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+ "); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// olderThan reports whether version a is strictly older than b. False when
// either cannot be read, so a dev build never nags.
func olderThan(a, b string) bool {
	x, ok1 := parseSemver(a)
	y, ok2 := parseSemver(b)
	if !ok1 || !ok2 {
		return false
	}
	for i := 0; i < 3; i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return false
}

// warnIfStale prints one line on stderr when the deployment says it was built
// with a newer CLI than this one. Silent with --quiet, with
// CLOUDMAIL_NO_UPDATE_CHECK=1, for dev builds and when the server sent nothing.
// It never changes the exit code or stdout.
func (a *App) warnIfStale() {
	if a == nil || a.Client == nil || a.Out == nil {
		return
	}
	if os.Getenv("CLOUDMAIL_NO_UPDATE_CHECK") == "1" {
		return
	}
	server := a.Client.ServerCLIVersion()
	if !olderThan(Version, server) {
		return
	}
	a.Out.Warn("this cloudmail CLI (%s) is older than the deployment (built with %s); update with: %s",
		Version, server, UpdateCommand)
}
