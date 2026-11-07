package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// parseFlexibleDuration reads a delay the way a person writes one.
//
// time.ParseDuration handles "4h" and "30m" but rejects "2d", because a day is
// not a fixed quantity in the general case. For a mail snooze it is: nobody
// snoozing something for two days means anything other than 48 hours. Refusing
// "2d" would be technically defensible and practically annoying, so days and
// weeks are expanded here before handing the rest to the standard parser.
func parseFlexibleDuration(s string) (time.Duration, error) {
	t := strings.TrimSpace(strings.ToLower(s))
	if t == "" {
		return 0, fmt.Errorf("empty duration")
	}

	// A bare number is read as minutes: `--for 30` is a person who did not think
	// a unit was needed, and minutes is the least surprising reading for a snooze.
	if n, err := strconv.Atoi(t); err == nil {
		return time.Duration(n) * time.Minute, nil
	}

	for suffix, unit := range map[string]time.Duration{
		"d": 24 * time.Hour,
		"w": 7 * 24 * time.Hour,
	} {
		if strings.HasSuffix(t, suffix) {
			n, err := strconv.Atoi(strings.TrimSuffix(t, suffix))
			if err != nil {
				continue
			}
			return time.Duration(n) * unit, nil
		}
	}
	return time.ParseDuration(t)
}

// parseWhen normalises an absolute time argument to RFC 3339, which is what the
// API expects.
//
// Accepting only RFC 3339 would be correct and unhelpful: "2026-09-01 09:00" is
// what someone types, and rejecting it teaches them nothing they wanted to know.
// A bare date and a bare date-time are read as local time, because that is what
// the person at the keyboard means.
func parseWhen(s string) (string, error) {
	t := strings.TrimSpace(s)
	if t == "" {
		return "", fail.Usagef("empty time")
	}
	layouts := []struct {
		layout string
		local  bool
	}{
		{time.RFC3339, false},
		{"2006-01-02T15:04:05", true},
		{"2006-01-02T15:04", true},
		{"2006-01-02 15:04:05", true},
		{"2006-01-02 15:04", true},
		{"2006-01-02", true},
	}
	for _, l := range layouts {
		var (
			parsed time.Time
			err    error
		)
		if l.local {
			parsed, err = time.ParseInLocation(l.layout, t, time.Local)
		} else {
			parsed, err = time.Parse(l.layout, t)
		}
		if err == nil {
			return parsed.UTC().Format(time.RFC3339), nil
		}
	}
	return "", fail.Usagef("cannot read %q as a time", s).
		WithRemediation("try 2026-09-01T09:00:00Z, or 2026-09-01 09:00 for local time")
}

// readJSONArg resolves a JSON argument given either literally or as a file.
//
// Both spellings exist because a small object is easiest inline and a large one is
// unmanageable that way, and because shell quoting of nested JSON is a reliable
// source of mistakes.
func readJSONArg(literal, file string) (json.RawMessage, error) {
	if literal != "" && file != "" {
		return nil, fail.Usagef("both inline JSON and a file were given").
			WithRemediation("use one or the other")
	}
	var raw []byte
	switch {
	case literal != "":
		raw = []byte(literal)
	case file == "-":
		s, err := readAll(os.Stdin)
		if err != nil {
			return nil, fail.Errf("cannot read JSON from stdin: %v", err)
		}
		raw = []byte(s)
	case file != "":
		var err error
		raw, err = os.ReadFile(file)
		if err != nil {
			return nil, fail.Usagef("cannot read %s: %v", file, err)
		}
	default:
		return nil, nil
	}

	if !json.Valid(raw) {
		// Naming the offset turns "invalid JSON" into something a caller can act
		// on, especially when the JSON was assembled by a program.
		var probe any
		err := json.Unmarshal(raw, &probe)
		return nil, fail.Usagef("the JSON is not valid: %v", err).
			WithRemediation("check for a trailing comma or an unquoted key")
	}
	return json.RawMessage(raw), nil
}

// parseKeyValues turns repeated `key=value` flags into a map.
func parseKeyValues(in []string) (map[string]string, error) {
	if len(in) == 0 {
		return nil, nil
	}
	out := make(map[string]string, len(in))
	for _, s := range in {
		k, v, ok := strings.Cut(s, "=")
		if !ok || strings.TrimSpace(k) == "" {
			return nil, fail.Usagef("cannot read %q as key=value", s).
				WithRemediation("write it as name=value")
		}
		out[strings.TrimSpace(k)] = v
	}
	return out, nil
}
