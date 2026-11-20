// Command cloudmail is a command-line client for a cloudmail deployment.
//
// It is built so that a person and a program can drive the same tool: aligned
// tables at a terminal, JSON in a pipe, exit codes that classify failures, and a
// dry run available on everything that changes state.
//
// Run `cloudmail --help` to start, or `cloudmail guide` if you are a program.
package main

import (
	"os"

	"github.com/cloudmail-hq/cloudmail/cli/internal/cmd"
)

func main() {
	// Execute returns the code rather than exiting itself, so deferred cleanup in
	// the command tree runs before the process ends.
	os.Exit(cmd.Execute())
}
