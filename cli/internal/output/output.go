// Package output renders command results.
//
// # Two audiences, one code path
//
// A person at a terminal wants aligned columns and colour. A script or an agent
// wants JSON it can parse, on stdout, with nothing else mixed in. Serving both
// from one renderer is what keeps them consistent: there is no "the table shows
// a field the JSON forgot", because both read the same Result.
//
// The format is chosen automatically from whether stdout is a terminal. That
// default matters more than it sounds -- an automated caller almost never passes
// --output json explicitly, and a CLI that emits a decorated table into a pipe
// has produced something nobody can consume.
//
// # stdout is data, stderr is commentary
//
// Absolutely everything that is not the result goes to stderr: progress,
// warnings, confirmation prompts, the note explaining a dry run. A single stray
// line on stdout breaks `| jq`, and it breaks it intermittently, which is worse
// than breaking it always.
package output

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/term"
)

// Format is a rendering.
type Format string

const (
	// JSON is one indented document. The default for anything non-interactive.
	JSON Format = "json"
	// NDJSON is one compact document per line, for streaming into tools that
	// read record-at-a-time.
	NDJSON Format = "ndjson"
	// Table is aligned columns for a human.
	Table Format = "table"
	// CSV is for spreadsheets.
	CSV Format = "csv"
	// Plain is tab-separated with no header, the shape `awk` and `cut` expect.
	Plain Format = "plain"
)

// Column describes one field in a tabular rendering.
//
// Commands declare their columns rather than having them guessed by reflection.
// Declared columns give a stable order, useful headers, and a deliberate choice
// about what a human sees first -- and they mean adding a field to a wire type
// cannot silently reshape every table.
type Column struct {
	// Header is the column title.
	Header string
	// Field is the JSON field this column reads, and the name --select matches.
	Field string
	// Value extracts and formats the cell. When nil the raw field is used.
	Value func(row map[string]any) string
	// Truncate caps the rendered width in table format. Zero means no cap.
	// Ignored for CSV and JSON, where losing data to fit a terminal would be
	// data loss rather than formatting.
	Truncate int
	// Right aligns the column to the right, for numbers.
	Right bool
	// Decorative marks a column that exists only to be looked at -- a glyph
	// summarising several fields, say. It is omitted from CSV and plain output,
	// where a column of symbols is noise a spreadsheet or an awk script cannot
	// use, and where its underlying fields are available individually anyway.
	Decorative bool
}

// Result is one command's output.
type Result struct {
	// Data is the value rendered by JSON and NDJSON. It should be the API's own
	// shape wherever possible, so a caller can rely on it matching the server.
	Data any

	// Columns render the tabular formats. Without them, a tabular format falls
	// back to JSON rather than inventing a layout.
	Columns []Column

	// Rows overrides the rows for tabular rendering. Normally Data is used; set
	// this when Data is an envelope and the rows live inside it.
	Rows any

	// Summary is one line for a human, written to stderr after the table. Never
	// on stdout, so it cannot contaminate a parse.
	Summary string

	// Untrusted names the fields carrying content that arrived in an email:
	// bodies, subjects, sender names. See fence.go for why this is called out.
	Untrusted []string

	// Empty is what a human sees when there are no rows. "No messages" is more
	// useful than a bare header row.
	Empty string
}

// Writer renders Results.
type Writer struct {
	format Format
	out    io.Writer
	errOut io.Writer

	// selected is the --select projection, empty for "everything".
	selected []string
	// limit caps rendered rows, 0 for unlimited.
	limit int

	color    bool
	fence    bool
	outIsTTY bool
	quiet    bool
}

// Options configures a Writer.
type Options struct {
	// Format is "auto", or one of the Format values.
	Format string
	// Color is auto, always or never.
	Color string
	// Fence is auto, always or never.
	Fence string
	// Select is a comma-separated field list, or nil for all fields.
	Select []string
	// Limit caps the rows rendered.
	Limit int
	// Quiet suppresses stderr commentary.
	Quiet bool

	Out    io.Writer
	ErrOut io.Writer
}

// NewWriter resolves the options against the terminal and returns a Writer.
func NewWriter(o Options) (*Writer, error) {
	out := o.Out
	if out == nil {
		out = os.Stdout
	}
	errOut := o.ErrOut
	if errOut == nil {
		errOut = os.Stderr
	}

	outTTY := isTerminal(out)

	format, err := resolveFormat(o.Format, outTTY)
	if err != nil {
		return nil, err
	}

	w := &Writer{
		format:   format,
		out:      out,
		errOut:   errOut,
		selected: normalizeSelect(o.Select),
		limit:    o.Limit,
		outIsTTY: outTTY,
		quiet:    o.Quiet,
	}
	w.color = resolveColor(o.Color, outTTY)
	w.fence = resolveFence(o.Fence, format)
	return w, nil
}

// resolveFormat turns "auto" into a concrete format.
//
// Interactive means a table; anything else means JSON. Defaulting a pipe to JSON
// rather than to the table is the single most useful thing this package does for
// an automated caller: it makes the parseable form the one you get by accident.
func resolveFormat(name string, tty bool) (Format, error) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "", "auto":
		if tty {
			return Table, nil
		}
		return JSON, nil
	case "json":
		return JSON, nil
	case "ndjson", "jsonl":
		return NDJSON, nil
	case "table":
		return Table, nil
	case "csv":
		return CSV, nil
	case "plain", "text", "tsv":
		return Plain, nil
	default:
		return "", fmt.Errorf("unknown output format %q (want auto, json, ndjson, table, csv or plain)", name)
	}
}

func resolveColor(mode string, tty bool) bool {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "always":
		return true
	case "never":
		return false
	}
	// NO_COLOR is honoured whatever its value, per the informal standard: the
	// variable being present at all is the signal.
	if _, set := os.LookupEnv("NO_COLOR"); set {
		return false
	}
	if os.Getenv("TERM") == "dumb" {
		return false
	}
	return tty
}

// resolveFence decides whether untrusted content is delimited.
//
// On by default for the human formats, where the content is being read as prose
// and the risk is that instructions inside a message get followed. Off by default
// for JSON, where the content sits in a labelled string field and adding markers
// would corrupt the value a caller extracts.
func resolveFence(mode string, f Format) bool {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "always":
		return true
	case "never":
		return false
	}
	return f == Table || f == Plain
}

func normalizeSelect(in []string) []string {
	var out []string
	for _, s := range in {
		for _, part := range strings.Split(s, ",") {
			if p := strings.TrimSpace(part); p != "" {
				out = append(out, p)
			}
		}
	}
	return out
}

// Format reports the resolved format.
func (w *Writer) Format() Format { return w.format }

// IsTTY reports whether stdout is a terminal.
func (w *Writer) IsTTY() bool { return w.outIsTTY }

// Fencing reports whether untrusted content will be delimited.
func (w *Writer) Fencing() bool { return w.fence }

// Emit renders a Result.
func (w *Writer) Emit(r Result) error {
	switch w.format {
	case JSON:
		return w.emitJSON(r)
	case NDJSON:
		return w.emitNDJSON(r)
	case CSV:
		return w.emitCSV(r)
	case Table, Plain:
		return w.emitTable(r)
	default:
		return w.emitJSON(r)
	}
}

// EmitValue renders a bare value with no columns, for commands whose output is
// not a table.
func (w *Writer) EmitValue(v any) error { return w.Emit(Result{Data: v}) }

func (w *Writer) emitJSON(r Result) error {
	data := r.Data
	// Projection applies to JSON too: --select is how a caller keeps a large
	// listing from filling its context, and it would be useless if it only
	// worked in the format a machine never asks for.
	if len(w.selected) > 0 || w.limit > 0 {
		var err error
		data, err = w.project(data)
		if err != nil {
			return err
		}
	}
	enc := json.NewEncoder(w.out)
	enc.SetIndent("", "  ")
	// Email bodies and subjects routinely contain <, > and &. Escaping them into
	// \u003c makes the JSON valid but the content unreadable, and it is not
	// protecting anything here: this output goes to a pipe or a file, never
	// inline into an HTML page.
	enc.SetEscapeHTML(false)
	if err := enc.Encode(data); err != nil {
		return err
	}
	w.note(r)
	return nil
}

func (w *Writer) emitNDJSON(r Result) error {
	rows, ok, err := w.rowsOf(r)
	if err != nil {
		return err
	}
	if !ok {
		// A single object is one line, which is a legitimate NDJSON document and
		// spares the caller a special case.
		return w.emitJSON(Result{Data: r.Data})
	}
	enc := json.NewEncoder(w.out)
	enc.SetEscapeHTML(false)
	for _, row := range rows {
		if err := enc.Encode(w.projectRow(row)); err != nil {
			return err
		}
	}
	w.note(r)
	return nil
}

func (w *Writer) emitCSV(r Result) error {
	cols := w.columns(r)
	rows, ok, err := w.rowsOf(r)
	if err != nil {
		return err
	}
	if !ok || len(cols) == 0 {
		// Nothing tabular to write. Falling back to JSON is better than emitting
		// an empty file that looks like a successful export of nothing.
		return w.emitJSON(r)
	}

	cw := csv.NewWriter(w.out)
	header := make([]string, len(cols))
	for i, c := range cols {
		header[i] = c.Header
	}
	if err := cw.Write(header); err != nil {
		return err
	}
	for _, row := range rows {
		rec := make([]string, len(cols))
		for i, c := range cols {
			// No truncation and no fencing: a CSV is an archive, and silently
			// shortening a cell would be data loss.
			rec[i] = cell(c, row, 0)
		}
		if err := cw.Write(rec); err != nil {
			return err
		}
	}
	cw.Flush()
	if err := cw.Error(); err != nil {
		return err
	}
	w.note(r)
	return nil
}

// rowsOf normalises a Result's rows into maps.
//
// The round trip through JSON is deliberate: it means the field names a command
// declares in Column.Field are exactly the ones the API uses, so a table column
// and a --select expression and the JSON output can never disagree about what a
// field is called.
func (w *Writer) rowsOf(r Result) ([]map[string]any, bool, error) {
	src := r.Rows
	if src == nil {
		src = r.Data
	}
	if src == nil {
		return nil, false, nil
	}

	raw, err := json.Marshal(src)
	if err != nil {
		return nil, false, err
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, false, nil // not an array of objects
	}
	if w.limit > 0 && len(rows) > w.limit {
		w.noteTruncation(w.limit, len(rows))
		rows = rows[:w.limit]
	}
	return rows, true, nil
}

// project applies --select and --limit to arbitrary data.
func (w *Writer) project(data any) (any, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}

	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err == nil {
		if w.limit > 0 && len(rows) > w.limit {
			w.noteTruncation(w.limit, len(rows))
			rows = rows[:w.limit]
		}
		out := make([]map[string]any, len(rows))
		for i, row := range rows {
			out[i] = w.projectRow(row)
		}
		return out, nil
	}

	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err == nil {
		// An object is either the record the caller asked about, or an envelope
		// wrapping the records -- {emails: [...], totalCount: n}. Which one decides
		// where the projection applies, and getting it wrong is destructive either
		// way: narrowing an envelope throws away totalCount, while descending into
		// a record's own array fields rewrites data the caller explicitly asked
		// for.
		//
		// The test is whether any selected name is a key of this object. If it is,
		// this is the record: narrow it and leave its values alone. If none is,
		// the selected names must refer to the rows inside, so project those and
		// keep the envelope.
		if len(w.selected) > 0 && selectsAnyKeyOf(obj, w.selected) {
			return w.projectRow(obj), nil
		}
		for k, v := range obj {
			nested, ok := v.([]any)
			if !ok {
				continue
			}
			if w.limit > 0 && len(nested) > w.limit {
				w.noteTruncation(w.limit, len(nested))
				nested = nested[:w.limit]
			}
			projected := make([]any, 0, len(nested))
			for _, item := range nested {
				if m, ok := item.(map[string]any); ok {
					projected = append(projected, w.projectRow(m))
				} else {
					projected = append(projected, item)
				}
			}
			obj[k] = projected
		}
		return obj, nil
	}
	return data, nil
}

// selectsAnyKeyOf reports whether any selected field names a key of this object.
func selectsAnyKeyOf(obj map[string]any, selected []string) bool {
	for _, f := range selected {
		if _, ok := obj[f]; ok {
			return true
		}
	}
	return false
}

// projectRow narrows one row to the selected fields.
//
// An unknown field name yields nothing rather than an error. That is the right
// trade for a projection: asking for a field a particular row lacks is normal
// (a listing has no body), and failing the whole command over it would make
// --select unusable across mixed results.
func (w *Writer) projectRow(row map[string]any) map[string]any {
	if len(w.selected) == 0 {
		return row
	}
	out := make(map[string]any, len(w.selected))
	for _, f := range w.selected {
		if v, ok := row[f]; ok {
			out[f] = v
		}
	}
	return out
}

// columns resolves which columns to render, honouring --select and dropping
// decorative columns from the machine-facing formats.
func (w *Writer) columns(r Result) []Column {
	if len(w.selected) == 0 {
		return w.usableColumns(r.Columns)
	}
	declared := make(map[string]Column, len(r.Columns))
	for _, c := range r.Columns {
		declared[c.Field] = c
	}
	out := make([]Column, 0, len(w.selected))
	for _, f := range w.selected {
		if c, ok := declared[f]; ok {
			out = append(out, c)
			continue
		}
		// A field with no declared column is still shown, using the field name
		// as its header. Refusing it would mean --select could only name fields
		// this CLI happens to have a table for, which is not what a caller
		// asking for a raw field means.
		out = append(out, Column{Header: f, Field: f})
	}
	return out
}

// usableColumns drops decorative columns for CSV and plain output.
func (w *Writer) usableColumns(cols []Column) []Column {
	if w.format != CSV && w.format != Plain {
		return cols
	}
	out := make([]Column, 0, len(cols))
	for _, c := range cols {
		if c.Decorative {
			continue
		}
		out = append(out, c)
	}
	return out
}

// noteTruncation tells the reader on stderr that --limit shortened the output.
//
// Without it, a caller comparing the rows it received against the totalCount in the
// summary would conclude that pages were missing, when in fact its own --limit hid
// them.
func (w *Writer) noteTruncation(shown, available int) {
	if w.quiet || w.limit <= 0 || available <= shown {
		return
	}
	fmt.Fprintln(w.errOut, w.dim(fmt.Sprintf(
		"--limit %d hid %d of the %d rows returned", w.limit, available-shown, available)))
}

// cell renders one table cell.
func cell(c Column, row map[string]any, truncate int) string {
	var s string
	if c.Value != nil {
		s = c.Value(row)
	} else {
		s = Stringify(row[c.Field])
	}
	// Control characters would move the cursor and wreck the alignment, and a
	// message subject is attacker-controlled text.
	s = sanitizeCell(s)
	if truncate > 0 {
		s = truncateRunes(s, truncate)
	}
	return s
}

// Stringify renders a JSON value for a cell.
func Stringify(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		if t {
			return "yes"
		}
		return "no"
	case float64:
		// JSON numbers all decode to float64; render integers without a
		// pointless ".00" that would make an id look like a measurement.
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case []any:
		parts := make([]string, len(t))
		for i, item := range t {
			parts[i] = Stringify(item)
		}
		return strings.Join(parts, ", ")
	case map[string]any:
		// A nested object in a table cell is almost never what a reader wants,
		// but showing its keys is more useful than showing "map[...]".
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		return "{" + strings.Join(keys, ",") + "}"
	default:
		return fmt.Sprint(t)
	}
}

// note writes the human summary to stderr.
func (w *Writer) note(r Result) {
	if w.quiet || r.Summary == "" {
		return
	}
	fmt.Fprintln(w.errOut, w.dim(r.Summary))
}

// Warn writes a warning to stderr.
func (w *Writer) Warn(format string, args ...any) {
	if w.quiet {
		return
	}
	fmt.Fprintln(w.errOut, w.yellow("warning: ")+fmt.Sprintf(format, args...))
}

// Info writes a note to stderr.
func (w *Writer) Info(format string, args ...any) {
	if w.quiet {
		return
	}
	fmt.Fprintln(w.errOut, w.dim(fmt.Sprintf(format, args...)))
}

// Quiet reports whether --quiet suppresses notes, for commands that draw their
// own progress on stderr.
func (w *Writer) Quiet() bool { return w.quiet }

// ErrOut exposes the stderr stream for prompts.
func (w *Writer) ErrOut() io.Writer { return w.errOut }

// Out exposes the stdout stream for commands writing raw bytes, such as an
// attachment download.
func (w *Writer) Out() io.Writer { return w.out }

func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	return term.IsTerminal(int(f.Fd()))
}

func truncateRunes(s string, n int) string {
	if n <= 1 {
		return s
	}
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n-1]) + "\u2026"
}

// sanitizeCell strips the control characters that would corrupt a rendered table.
//
// This is not cosmetic. A subject line arrives from a stranger, and it can
// contain a carriage return, a backspace run, or an ANSI escape. Any of those can
// overwrite what was already printed, which turns a message listing into a
// surface for forging the output of the tool itself.
func sanitizeCell(s string) string {
	if !strings.ContainsAny(s, "\x00\a\b\t\n\v\f\r\x1b") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r == '\n' || r == '\r' || r == '\t' || r == '\v' || r == '\f':
			b.WriteByte(' ')
		case r == 0x1b:
			// Drop the escape introducer. The bytes that followed it become
			// inert text rather than a control sequence.
			continue
		case r < 0x20 || r == 0x7f:
			continue
		default:
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}
