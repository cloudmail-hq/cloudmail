// Package fail defines cloudmail's error and exit-code taxonomy.
//
// # Why exit codes carry meaning here
//
// An exit code is the first and cheapest signal a caller sees. With only 0 and 1
// a script -- or an agent -- has to parse English out of stderr to decide whether
// to retry, to pick a different argument, or to stop and ask a human. Those three
// responses are wildly different, and guessing between them by substring match on
// an error message is how automation ends up retrying a permission denial forever.
//
// So every failure lands in exactly one of the codes below, each code names one
// response, and the mapping is part of the CLI's contract: changing what a code
// means is a breaking change, in the same way that renaming a JSON field is.
//
// # The paired machine code
//
// The exit code says what kind of failure it was. The `code` string in the JSON
// error body says which specific failure, and `remediation` says what to do about
// it. An exit code cannot be more specific without growing to hundreds of values,
// and a caller that wants detail is already reading stdout.
package fail

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Exit codes. Stable across versions.
//
// Codes 0-2 follow POSIX and shell convention. 3-14 are this tool's, grouped so
// a caller can branch on ranges: 3-5 are "your request was understood and
// refused for a reason you can act on", 6-7 are "fix your credentials or wait",
// 8-9 are "not your fault, maybe retry", 10-12 are local refusals that never
// touched the network.
const (
	// OK means the command did what was asked.
	OK = 0

	// Err is a failure with no more specific classification. A caller seeing
	// this should read stderr; it is deliberately the code of last resort.
	Err = 1

	// Usage means the command line itself was wrong: unknown flag, missing
	// argument, bad enum value, mutually exclusive flags. Nothing was sent.
	// The fix is to change the arguments and run again.
	Usage = 2

	// NotFound means the mailbox, message, label, folder or template named does
	// not exist (HTTP 404). The fix is to list the collection and pick a real id.
	NotFound = 3

	// Denied means authenticated but not authorized (HTTP 403): the caller has
	// no grant on this mailbox, or lacks the capability this operation needs.
	// Retrying is pointless; a human must widen the grant.
	Denied = 4

	// Conflict means the resource already exists or the state does not allow the
	// change (HTTP 409). Usually the fix is to update instead of create.
	Conflict = 5

	// Unauthenticated means no usable credential (HTTP 401, or the edge returned
	// an Access login page). The fix is an API token (`cloudmail auth login`);
	// only a deployment in legacy Cloudflare Access mode needs a service token.
	// The error's remediation names which one this deployment wants.
	Unauthenticated = 6

	// RateLimited means HTTP 429. Transient by definition: wait for the
	// Retry-After the server named and try again.
	RateLimited = 7

	// Network means the request never got an answer: DNS failure, connection
	// refused, TLS failure, timeout. Transient; retrying is reasonable.
	Network = 8

	// Server means HTTP 5xx. Not the caller's fault. Possibly transient.
	Server = 9

	// DryRun means a --dry-run completed and the request was NOT sent. Separate
	// from OK so a caller can tell "I previewed it" from "I did it" without
	// tracking which flags it passed.
	DryRun = 10

	// WriteRefused means this build or this invocation is not permitted to
	// change state: --read-only was set, or a confirmation was required and
	// stdin is not a terminal. Nothing was sent.
	WriteRefused = 11

	// Invalid means the server rejected the request body as malformed
	// (HTTP 400, typically with per-field details). The fix is to correct the
	// named fields.
	Invalid = 12

	// TooLarge means HTTP 413: the message or its attachments exceed the cap.
	TooLarge = 13

	// Interrupted is the conventional shell code for death by SIGINT.
	Interrupted = 130
)

// codeNames documents the exit codes for `cloudmail schema` and for --help, so
// the contract is discoverable at runtime rather than only in this source file.
var codeNames = map[int]struct{ Name, Meaning string }{
	OK:              {"ok", "the command succeeded"},
	Err:             {"error", "unclassified failure; read stderr"},
	Usage:           {"usage", "bad arguments or flags; nothing was sent"},
	NotFound:        {"not_found", "the named resource does not exist"},
	Denied:          {"denied", "authenticated but lacking the required capability"},
	Conflict:        {"conflict", "the resource already exists or the state forbids the change"},
	Unauthenticated: {"unauthenticated", "no usable credential; create an API token in Settings -> API tokens and run `cloudmail auth login` (legacy Access deployments: an Access service token); the remediation says which"},
	RateLimited:     {"rate_limited", "too many requests; wait for Retry-After and retry"},
	Network:         {"network", "the request never reached the server; transient"},
	Server:          {"server", "the server failed (5xx); possibly transient"},
	DryRun:          {"dry_run", "the request was previewed and NOT sent"},
	WriteRefused:    {"write_refused", "a mutation was blocked locally; nothing was sent"},
	Invalid:         {"invalid", "the server rejected the request body; fix the named fields"},
	TooLarge:        {"too_large", "the payload exceeds the server's size cap"},
	Interrupted:     {"interrupted", "cancelled by SIGINT"},
}

// ExitCodes returns the documented codes in ascending order.
func ExitCodes() []ExitCodeDoc {
	out := make([]ExitCodeDoc, 0, len(codeNames))
	for code, d := range codeNames {
		out = append(out, ExitCodeDoc{Code: code, Name: d.Name, Meaning: d.Meaning})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Code < out[j].Code })
	return out
}

// ExitCodeDoc is one row of the exit-code contract.
type ExitCodeDoc struct {
	Code    int    `json:"code"`
	Name    string `json:"name"`
	Meaning string `json:"meaning"`
}

// Detail is one field-level complaint, mirroring the shape the Worker returns
// for a Zod failure so the server's own validation messages survive the trip.
type Detail struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// Error is a cloudmail failure carrying everything a caller needs to react
// without parsing prose: an exit code for control flow, a stable machine code, a
// human message, and a remediation naming the next command to run.
type Error struct {
	// Code is a stable SCREAMING_SNAKE identifier, e.g. MAILBOX_NOT_FOUND.
	Code string `json:"code"`

	// Message is one sentence for a human, lowercase and without a period, in
	// the style of Go error strings.
	Message string `json:"error"`

	// Remediation names the concrete next step. This is the field that lets an
	// agent self-correct instead of escalating, so it should be a command to run
	// or a decision to make, never "check your configuration".
	Remediation string `json:"remediation,omitempty"`

	// Details carries per-field validation failures.
	Details []Detail `json:"details,omitempty"`

	// Status is the HTTP status, when there was one.
	Status int `json:"status,omitempty"`

	// Retryable marks failures where the identical request may succeed later.
	// It is not a promise, only a signal that retrying is not obviously futile.
	Retryable bool `json:"retryable,omitempty"`

	// RetryAfter is the server's requested wait, in seconds.
	RetryAfter int `json:"retry_after_seconds,omitempty"`

	// Capability is the mailbox capability the request lacked, when the server
	// said so. Named separately from Message because it is the thing an operator
	// has to grant, and it should be extractable without a regex.
	Capability string `json:"capability,omitempty"`

	// Method and URL locate the request that failed. Query strings are kept but
	// credentials never appear in either.
	Method string `json:"method,omitempty"`
	URL    string `json:"url,omitempty"`

	// exit is the process exit code. Unexported so it cannot be confused with
	// the machine Code string in JSON.
	exit int

	// wrapped preserves the underlying cause for errors.Is / errors.As.
	wrapped error
}

// ExitCode reports the process exit status for this error.
func (e *Error) ExitCode() int {
	if e.exit == 0 {
		return Err
	}
	return e.exit
}

func (e *Error) Error() string {
	var b strings.Builder
	b.WriteString(e.Message)
	for _, d := range e.Details {
		b.WriteString("\n  ")
		if d.Field != "" {
			b.WriteString(d.Field)
			b.WriteString(": ")
		}
		b.WriteString(d.Message)
	}
	if e.Remediation != "" {
		b.WriteString("\n")
		b.WriteString(e.Remediation)
	}
	return b.String()
}

func (e *Error) Unwrap() error { return e.wrapped }

// MarshalJSON emits the error envelope, adding the exit code so a caller reading
// only stdout still learns the classification.
func (e *Error) MarshalJSON() ([]byte, error) {
	type alias Error // avoid recursing into this method
	return json.Marshal(struct {
		alias
		ExitCode int    `json:"exit_code"`
		Kind     string `json:"kind"`
	}{
		alias:    alias(*e),
		ExitCode: e.ExitCode(),
		Kind:     codeNames[e.ExitCode()].Name,
	})
}

// New builds an Error. Every constructed failure goes through here or one of the
// helpers below, so no code path can invent an exit code that ExitCodes() does
// not document.
func New(exit int, code, message string) *Error {
	return &Error{exit: exit, Code: code, Message: message}
}

// WithRemediation attaches the next step. Chainable.
func (e *Error) WithRemediation(format string, args ...any) *Error {
	e.Remediation = fmt.Sprintf(format, args...)
	return e
}

// WithDetails attaches field-level complaints. Chainable.
func (e *Error) WithDetails(d ...Detail) *Error {
	e.Details = append(e.Details, d...)
	return e
}

// Wrap attaches an underlying cause. Chainable.
func (e *Error) Wrap(err error) *Error {
	e.wrapped = err
	return e
}

// ── Constructors for the common cases ──────────────────────────────

// Usagef reports a bad command line. Nothing was sent, so the caller can fix
// the arguments and retry with no side effects to undo.
func Usagef(format string, args ...any) *Error {
	return New(Usage, "USAGE", fmt.Sprintf(format, args...))
}

// Errf reports an unclassified failure.
func Errf(format string, args ...any) *Error {
	return New(Err, "ERROR", fmt.Sprintf(format, args...))
}

// Refusedf reports a mutation blocked before it left the process.
func Refusedf(format string, args ...any) *Error {
	return New(WriteRefused, "WRITE_REFUSED", fmt.Sprintf(format, args...))
}

// NotFoundf reports a missing resource.
func NotFoundf(format string, args ...any) *Error {
	return New(NotFound, "NOT_FOUND", fmt.Sprintf(format, args...))
}

// Invalidf reports input the server would reject, caught locally.
func Invalidf(format string, args ...any) *Error {
	return New(Invalid, "INVALID", fmt.Sprintf(format, args...))
}

// Networkf reports a request that got no answer.
func Networkf(format string, args ...any) *Error {
	e := New(Network, "NETWORK", fmt.Sprintf(format, args...))
	e.Retryable = true
	return e
}

// AsError extracts a *Error from an error chain, or classifies whatever it finds
// as a generic failure. Callers at the top of main use this to get an exit code
// out of any error at all, so no error can escape unclassified.
func AsError(err error) *Error {
	if err == nil {
		return nil
	}
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return Errf("%s", err.Error()).Wrap(err)
}

// IsRetryable reports whether retrying the identical request is worth trying.
func IsRetryable(err error) bool {
	e := AsError(err)
	return e != nil && e.Retryable
}
