package output

import (
	"encoding/json"
	"io"
	"os"
	"sort"

	"golang.org/x/term"
)

// Colour and small shared helpers.
//
// Styling is applied through these methods rather than by embedding escape codes
// at the call sites, so `w.color == false` disables all of it in one place. A
// stray hard-coded escape would otherwise show up as literal garbage in a pipe
// or a file, which is exactly the failure --no-color exists to prevent.

const (
	ansiReset  = "\x1b[0m"
	ansiBold   = "\x1b[1m"
	ansiDim    = "\x1b[2m"
	ansiRed    = "\x1b[31m"
	ansiGreen  = "\x1b[32m"
	ansiYellow = "\x1b[33m"
	ansiCyan   = "\x1b[36m"
)

func (w *Writer) style(code, s string) string {
	if !w.color || s == "" {
		return s
	}
	return code + s + ansiReset
}

func (w *Writer) bold(s string) string   { return w.style(ansiBold, s) }
func (w *Writer) dim(s string) string    { return w.style(ansiDim, s) }
func (w *Writer) red(s string) string    { return w.style(ansiRed, s) }
func (w *Writer) green(s string) string  { return w.style(ansiGreen, s) }
func (w *Writer) yellow(s string) string { return w.style(ansiYellow, s) }
func (w *Writer) cyan(s string) string   { return w.style(ansiCyan, s) }

// Bold exposes bolding for command-layer messages.
func (w *Writer) Bold(s string) string { return w.bold(s) }

// Dim exposes dimming for command-layer messages.
func (w *Writer) Dim(s string) string { return w.dim(s) }

// Red exposes red for error text.
func (w *Writer) Red(s string) string { return w.red(s) }

// Green exposes green for success text.
func (w *Writer) Green(s string) string { return w.green(s) }

// Cyan exposes cyan for identifiers.
func (w *Writer) Cyan(s string) string { return w.cyan(s) }

// Color reports whether styling is enabled.
func (w *Writer) Color() bool { return w.color }

// terminalWidth reports the width of the terminal behind a writer, or 0.
func terminalWidth(w io.Writer) int {
	f, ok := w.(*os.File)
	if !ok {
		return 0
	}
	width, _, err := term.GetSize(int(f.Fd()))
	if err != nil {
		return 0
	}
	// COLUMNS overrides, which is how a caller pins the layout in a recorded
	// session or a test.
	return width
}

// toObject converts a value to a JSON object, reporting whether it was one.
func toObject(v any) (map[string]any, bool) {
	if v == nil {
		return nil, false
	}
	if m, ok := v.(map[string]any); ok {
		return m, true
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, false
	}
	return m, true
}

func sortStrings(s []string) { sort.Strings(s) }
