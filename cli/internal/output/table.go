package output

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Table and plain rendering.
//
// Written by hand rather than pulled from a dependency because the requirement is
// small and the alternative brings a transitive tree into a tool whose whole
// appeal is a single static binary.

// terminalBudget is the width assumed when the terminal's real width is unknown.
// 100 rather than the classic 80: mail listings carry an id, an address and a
// subject, and 80 columns forces all three to be useless.
const terminalBudget = 100

func (w *Writer) emitTable(r Result) error {
	cols := w.columns(r)
	rows, ok, err := w.rowsOf(r)
	if err != nil {
		return err
	}

	// Not a list of records: render key-value pairs instead of forcing a shape
	// the data does not have. `mailbox get` and `auth whoami` land here.
	if !ok {
		return w.emitRecord(r)
	}
	if len(cols) == 0 {
		return w.emitJSON(r)
	}

	if len(rows) == 0 {
		empty := r.Empty
		if empty == "" {
			empty = "no results"
		}
		if w.format == Plain {
			// Plain output is consumed by scripts, so an empty result is zero
			// lines on stdout. The explanation belongs on stderr.
			w.Info("%s", empty)
			return nil
		}
		fmt.Fprintln(w.out, w.dim(empty))
		w.note(r)
		return nil
	}

	widths := w.layout(cols, rows)

	if w.format == Table {
		headers := make([]string, len(cols))
		for i, c := range cols {
			headers[i] = pad(strings.ToUpper(c.Header), widths[i], c.Right)
		}
		fmt.Fprintln(w.out, w.bold(strings.TrimRight(strings.Join(headers, "  "), " ")))
	}

	sep := "  "
	if w.format == Plain {
		// Tab-separated and unpadded: the form `cut -f2` expects.
		sep = "\t"
	}

	for _, row := range rows {
		cells := make([]string, len(cols))
		for i, c := range cols {
			v := cell(c, row, w.truncationFor(c, widths[i]))
			if w.format == Table {
				v = pad(v, widths[i], c.Right)
			}
			cells[i] = v
		}
		line := strings.Join(cells, sep)
		if w.format == Table {
			line = strings.TrimRight(line, " ")
		}
		fmt.Fprintln(w.out, line)
	}

	w.note(r)
	return nil
}

func (w *Writer) truncationFor(c Column, width int) int {
	if w.format == Plain {
		return 0 // never shorten data a script will parse
	}
	if c.Truncate > 0 && c.Truncate < width {
		return c.Truncate
	}
	return width
}

// layout sizes each column to its widest cell, then shrinks the flexible ones if
// the total exceeds the terminal.
//
// Shrinking the widest column rather than all of them proportionally is what
// keeps ids and dates intact: those are fixed-width and useless when clipped,
// whereas a subject line still reads when it is cut short.
func (w *Writer) layout(cols []Column, rows []map[string]any) []int {
	widths := make([]int, len(cols))
	for i, c := range cols {
		widths[i] = utf8.RuneCountInString(c.Header)
		if c.Truncate > 0 && widths[i] > c.Truncate {
			widths[i] = c.Truncate
		}
	}
	for _, row := range rows {
		for i, c := range cols {
			n := utf8.RuneCountInString(cell(c, row, 0))
			if c.Truncate > 0 && n > c.Truncate {
				n = c.Truncate
			}
			if n > widths[i] {
				widths[i] = n
			}
		}
	}
	if w.format == Plain {
		return widths
	}

	budget := w.width()
	gaps := 2 * (len(cols) - 1)
	sum := gaps
	for _, n := range widths {
		sum += n
	}
	// Shrink the widest column repeatedly until it fits, never below 8 runes,
	// which is the point past which a truncated string tells you nothing.
	for sum > budget {
		widest, idx := 0, -1
		for i, n := range widths {
			if n > widest && n > 8 {
				widest, idx = n, i
			}
		}
		if idx < 0 {
			break
		}
		widths[idx]--
		sum--
	}
	return widths
}

func (w *Writer) width() int {
	if n := terminalWidth(w.out); n > 20 {
		return n
	}
	return terminalBudget
}

// emitRecord renders a single object as aligned key-value lines.
func (w *Writer) emitRecord(r Result) error {
	obj, ok := toObject(r.Data)
	if !ok {
		return w.emitJSON(r)
	}

	// --select narrows a record just as it narrows a listing. Without this, the
	// flag would work in JSON and be silently ignored at a terminal, which is the
	// kind of inconsistency that makes people stop trusting a flag.
	if len(w.selected) > 0 {
		obj = w.projectRow(obj)
		if len(obj) == 0 {
			w.Info("none of the selected fields are present on this record")
			return nil
		}
	}

	// Column.Value formatters are honoured here too, so a field that renders badly
	// as raw JSON -- a list of attachment objects, say -- reads the same in the
	// record view as it does in a table.
	formatters := make(map[string]func(map[string]any) string, len(r.Columns))
	for _, c := range r.Columns {
		if c.Value != nil {
			formatters[c.Field] = c.Value
		}
	}

	keys := orderedKeys(obj, r.Columns)
	width := 0
	for _, k := range keys {
		if n := utf8.RuneCountInString(k); n > width {
			width = n
		}
	}

	untrusted := make(map[string]bool, len(r.Untrusted))
	for _, f := range r.Untrusted {
		untrusted[f] = true
	}

	full, _ := toObject(r.Data) // formatters may read fields the projection dropped

	for _, k := range keys {
		v := obj[k]
		if isEmptyValue(v) {
			continue
		}

		var s string
		switch f, hasFormatter := formatters[k]; {
		case hasFormatter:
			s = f(full)
		case isNested(v):
			// A nested object or list cannot be summarised into one cell without
			// losing the thing worth reading -- Stringify would reduce it to a set
			// of key names. Indented JSON keeps the structure, and for a --dry-run
			// preview the nested value *is* the request body being inspected.
			s = indentJSON(v)
		default:
			s = Stringify(v)
		}
		if s == "" {
			continue
		}

		// A long or multi-line untrusted value -- a message body -- is set apart on
		// its own lines and delimited, rather than squeezed into a column where its
		// text would be indistinguishable from this tool's own output.
		if untrusted[k] && (strings.Contains(s, "\n") || len(s) > 200) {
			fmt.Fprintf(w.out, "%s:\n", w.bold(k))
			fmt.Fprintln(w.out, w.FenceBlock(k, s))
			continue
		}
		// A multi-line value that is *not* untrusted still needs indenting, or the
		// continuation lines would look like separate fields.
		if strings.Contains(s, "\n") {
			fmt.Fprintf(w.out, "%s:\n", w.bold(k))
			for _, line := range strings.Split(s, "\n") {
				fmt.Fprintf(w.out, "  %s\n", sanitizeCell(line))
			}
			continue
		}
		fmt.Fprintf(w.out, "%s  %s\n", w.bold(pad(k+":", width+1, false)), sanitizeCell(s))
	}
	w.note(r)
	return nil
}

// orderedKeys puts declared columns first, in their declared order, then
// everything else alphabetically.
//
// Map iteration in Go is randomised, so without this a record would print its
// fields in a different order on every run -- which makes a diff of two runs
// useless and looks like a bug.
func orderedKeys(obj map[string]any, cols []Column) []string {
	seen := make(map[string]bool, len(obj))
	var out []string
	for _, c := range cols {
		if _, ok := obj[c.Field]; ok && !seen[c.Field] {
			out = append(out, c.Field)
			seen[c.Field] = true
		}
	}
	rest := make([]string, 0, len(obj))
	for k := range obj {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sortStrings(rest)
	return append(out, rest...)
}

func isEmptyValue(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return t == ""
	case []any:
		return len(t) == 0
	case map[string]any:
		return len(t) == 0
	default:
		return false
	}
}

// isNested reports whether a value has internal structure worth laying out.
//
// A short list of scalars is fine on one line -- Stringify joins it with commas --
// so only lists containing structure, and objects, get the JSON treatment.
func isNested(v any) bool {
	switch t := v.(type) {
	case map[string]any:
		return len(t) > 0
	case []any:
		for _, item := range t {
			switch item.(type) {
			case map[string]any, []any:
				return true
			}
		}
		return false
	default:
		return false
	}
}

// indentJSON renders a value as indented JSON for the record view.
func indentJSON(v any) string {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return Stringify(v)
	}
	return string(raw)
}

func pad(s string, width int, right bool) string {
	n := utf8.RuneCountInString(s)
	if n >= width {
		return s
	}
	fill := strings.Repeat(" ", width-n)
	if right {
		return fill + s
	}
	return s + fill
}
