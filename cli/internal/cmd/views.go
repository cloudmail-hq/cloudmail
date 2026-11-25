package cmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
)

// Table layouts for the API's types.
//
// Kept together rather than beside each command so that the same resource looks
// the same everywhere it appears -- a message row from `mail list`, from
// `mail search` and from `label emails` is one layout, defined once.
//
// Every Column.Field is the JSON field name the server uses, which is what makes
// --select work identically against the table and the JSON.

// emailColumns is the message listing.
//
// Ordered by what a reader scans for: whether it needs attention (flags), who it
// is from, what it is about, and when. The id comes first because it is the
// argument every follow-up command takes, and hunting for it at the end of a wide
// line is a papercut on every single use.
func emailColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 22},
		// Decorative: a glyph column reads well to a person and is noise to a
		// spreadsheet, which can have read/starred/priority as their own fields.
		{Header: "", Field: "flags", Value: emailFlags, Decorative: true},
		{Header: "from", Field: "sender", Truncate: 30},
		{Header: "subject", Field: "subject", Truncate: 48},
		{Header: "date", Field: "date", Value: relativeDate, Truncate: 16},
	}
}

// sentColumns is the listing for the Sent folder: the same layout with the
// recipient instead of the sender, and a delivery/engagement status column.
func sentColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 22},
		{Header: "", Field: "flags", Value: emailFlags, Decorative: true},
		{Header: "to", Field: "recipient", Truncate: 30},
		{Header: "subject", Field: "subject", Truncate: 40},
		{Header: "status", Field: "status", Value: sentStatus, Truncate: 28},
		{Header: "date", Field: "date", Value: relativeDate, Truncate: 16},
	}
}

// sentStatus summarises delivery and engagement, matching the web app:
// "sending", "sent", "delivered", "opened 3x", "opened 3x, clicked 1",
// "failed", "bounced". "Opened" means the tracking image loaded; privacy
// proxies can trigger it, so it is never reported as "read". A "(proxy)"
// suffix marks opens that all came through a known mail-privacy proxy.
func sentStatus(row map[string]any) string {
	status := output.Stringify(row["delivery_status"])
	switch status {
	case "failed", "bounced":
		return status
	}
	opens := intField(row["open_count"])
	clicks := intField(row["click_count"])
	var parts []string
	switch {
	case opens > 0:
		s := fmt.Sprintf("opened %dx", opens)
		if intField(row["open_proxy_count"]) >= opens {
			s += " (proxy)"
		}
		parts = append(parts, s)
	case status == "delivered":
		parts = append(parts, "delivered")
	case status == "queued":
		parts = append(parts, "sending")
	default:
		parts = append(parts, "sent")
	}
	if clicks > 0 {
		parts = append(parts, fmt.Sprintf("clicked %d", clicks))
	}
	return strings.Join(parts, ", ")
}

func intField(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	default:
		return 0
	}
}

// isSentFolder reports whether a --folder value names the Sent folder.
func isSentFolder(folder string) bool {
	return strings.EqualFold(strings.TrimSpace(folder), "sent")
}

// emailFlags renders the message's state as a compact glyph column.
//
// A single column of marks reads faster than four yes/no columns, and it costs
// four characters instead of thirty.
func emailFlags(row map[string]any) string {
	var b strings.Builder
	if truthy(row["read"]) {
		b.WriteString(" ")
	} else {
		b.WriteString("\u25cf") // filled circle: unread
	}
	if truthy(row["starred"]) {
		b.WriteString("\u2605") // star
	} else {
		b.WriteString(" ")
	}
	if hasAttachments(row) {
		b.WriteString("\u0040") // @: carries an attachment
	} else {
		b.WriteString(" ")
	}
	switch output.Stringify(row["priority"]) {
	case "high":
		b.WriteString("!")
	case "low":
		b.WriteString("\u2193")
	default:
		b.WriteString(" ")
	}
	return b.String()
}

func hasAttachments(row map[string]any) bool {
	if v, ok := row["attachments"]; ok {
		if list, ok := v.([]any); ok {
			return len(list) > 0
		}
	}
	// A listing does not include the attachment array, so fall back to the
	// boolean the list route provides when it does.
	return truthy(row["has_attachment"])
}

func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case float64:
		return t != 0
	case string:
		return t == "true" || t == "1"
	default:
		return false
	}
}

// relativeDate renders a timestamp the way a mail client does: a time for today,
// a weekday for this week, a date beyond that.
//
// Absolute timestamps all look alike in a column, and the question a reader is
// actually asking is "how recent is this".
func relativeDate(row map[string]any) string {
	raw := output.Stringify(row["date"])
	if raw == "" {
		return ""
	}
	t, err := parseTime(raw)
	if err != nil {
		return raw // show what the server said rather than nothing
	}
	now := time.Now()
	switch {
	case t.After(now.Add(-24 * time.Hour)):
		return t.Local().Format("15:04")
	case t.After(now.Add(-6 * 24 * time.Hour)):
		return t.Local().Format("Mon 15:04")
	case t.Year() == now.Year():
		return t.Local().Format("2 Jan")
	default:
		return t.Local().Format("2 Jan 2006")
	}
}

func parseTime(s string) (time.Time, error) {
	// The mailbox stores ISO-8601, but a header-derived date can arrive in RFC
	// 1123 form, so both are tried before giving up.
	for _, layout := range []string{
		time.RFC3339Nano, time.RFC3339,
		"2006-01-02T15:04:05.999Z", "2006-01-02 15:04:05",
		time.RFC1123Z, time.RFC1123,
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognised time %q", s)
}

func mailboxColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 40},
		{Header: "name", Field: "name", Truncate: 24},
		{Header: "domain", Field: "domain", Truncate: 24},
	}
}

func folderColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 28},
		{Header: "name", Field: "name", Truncate: 32},
		{Header: "deletable", Field: "is_deletable", Value: func(r map[string]any) string {
			if truthy(r["is_deletable"]) {
				return "yes"
			}
			return "no"
		}},
	}
}

func labelColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 24},
		{Header: "name", Field: "name", Truncate: 30},
		{Header: "color", Field: "color", Truncate: 9},
		{Header: "parent", Field: "parent_id", Truncate: 24},
	}
}

func attachmentColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 24},
		{Header: "filename", Field: "filename", Truncate: 36},
		{Header: "type", Field: "mimetype", Truncate: 24},
		{Header: "size", Field: "size", Value: func(r map[string]any) string {
			return humanBytes(r["size"])
		}, Right: true},
		{Header: "blocked", Field: "blocked", Value: func(r map[string]any) string {
			if truthy(r["blocked"]) {
				return "yes"
			}
			return ""
		}},
	}
}

// humanBytes renders a size the way a person reads it.
func humanBytes(v any) string {
	n, ok := v.(float64)
	if !ok {
		return output.Stringify(v)
	}
	const unit = 1024.0
	if n < unit {
		return fmt.Sprintf("%d B", int64(n))
	}
	suffixes := []string{"KB", "MB", "GB"}
	size := n / unit
	for _, suffix := range suffixes {
		if size < unit {
			return fmt.Sprintf("%.1f %s", size, suffix)
		}
		size /= unit
	}
	return fmt.Sprintf("%.1f TB", size)
}

func scheduledColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "email_id", Truncate: 24},
		{Header: "send at", Field: "send_at", Value: func(r map[string]any) string {
			return untilWhen(output.Stringify(r["send_at"]))
		}, Truncate: 22},
		{Header: "status", Field: "status", Truncate: 12},
		{Header: "to", Field: "recipient", Truncate: 28},
		{Header: "subject", Field: "subject", Truncate: 34},
		{Header: "error", Field: "last_error", Truncate: 30},
	}
}

// untilWhen renders a future timestamp as a countdown.
//
// For a queued message the useful fact is "in 2 minutes", not the wall-clock time
// it will leave -- especially inside the 30-second undo window, where knowing the
// send is imminent is the whole reason to look.
func untilWhen(raw string) string {
	if raw == "" {
		return ""
	}
	t, err := parseTime(raw)
	if err != nil {
		return raw
	}
	d := time.Until(t)
	switch {
	case d < -time.Minute:
		return "overdue"
	case d < 0:
		return "now"
	case d < time.Minute:
		return fmt.Sprintf("in %ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("in %dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("in %dh", int(d.Hours()))
	default:
		return t.Local().Format("2 Jan 15:04")
	}
}

func ruleColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 24},
		{Header: "name", Field: "name", Truncate: 24},
		{Header: "on", Field: "enabled", Value: func(r map[string]any) string {
			// A rule with no `enabled` field is enabled: absence means the
			// deployment predates the switch, and reading it as "off" would
			// misreport every rule as inert.
			if v, ok := r["enabled"]; ok && !truthy(v) {
				return "no"
			}
			return "yes"
		}},
		{Header: "match", Field: "match_type", Truncate: 6},
		{Header: "if", Field: "conditions", Value: func(r map[string]any) string {
			return summariseConditions(r["conditions"])
		}, Truncate: 38},
		{Header: "then", Field: "actions", Value: func(r map[string]any) string {
			return summariseActions(r["actions"])
		}, Truncate: 30},
	}
}

func summariseConditions(v any) string {
	list, ok := v.([]any)
	if !ok {
		return ""
	}
	parts := make([]string, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		field := output.Stringify(m["field"])
		op := output.Stringify(m["operator"])
		val := output.Stringify(m["value"])
		if val == "" {
			parts = append(parts, fmt.Sprintf("%s %s", field, op))
		} else {
			parts = append(parts, fmt.Sprintf("%s %s %q", field, op, val))
		}
	}
	return strings.Join(parts, ", ")
}

func summariseActions(v any) string {
	list, ok := v.([]any)
	if !ok {
		return ""
	}
	parts := make([]string, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		t := output.Stringify(m["type"])
		if val := output.Stringify(m["value"]); val != "" {
			t += ":" + val
		}
		parts = append(parts, t)
	}
	return strings.Join(parts, ", ")
}

func senderColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 24},
		{Header: "pattern", Field: "pattern", Truncate: 40},
		{Header: "reason", Field: "reason", Truncate: 30},
	}
}

func signatureColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 24},
		{Header: "name", Field: "name", Truncate: 30},
		{Header: "default", Field: "is_default", Value: func(r map[string]any) string {
			if truthy(r["is_default"]) {
				return "yes"
			}
			return ""
		}},
	}
}

func templateColumns() []output.Column {
	return []output.Column{
		{Header: "slug", Field: "slug", Truncate: 28},
		{Header: "name", Field: "name", Truncate: 30},
		{Header: "subject", Field: "subject", Truncate: 40},
	}
}

func sequenceColumns() []output.Column {
	return []output.Column{
		{Header: "id", Field: "id", Truncate: 24},
		{Header: "name", Field: "name", Truncate: 30},
		{Header: "steps", Field: "steps", Value: func(r map[string]any) string {
			list, ok := r["steps"].([]any)
			if !ok {
				return "0"
			}
			return fmt.Sprintf("%d", len(list))
		}, Right: true},
		{Header: "plan", Field: "plan", Value: func(r map[string]any) string {
			return summariseSteps(r["steps"])
		}, Truncate: 42},
	}
}

func summariseSteps(v any) string {
	list, ok := v.([]any)
	if !ok {
		return ""
	}
	parts := make([]string, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		slug := output.Stringify(m["templateSlug"])
		delay := output.Stringify(m["delayHours"])
		parts = append(parts, fmt.Sprintf("%s+%sh", slug, delay))
	}
	return strings.Join(parts, " -> ")
}

// emailDetailColumns orders the fields of a single message for the record view.
func emailDetailColumns() []output.Column {
	return []output.Column{
		{Field: "id"}, {Field: "date"}, {Field: "sender"}, {Field: "recipient"},
		{Field: "cc"}, {Field: "bcc"}, {Field: "subject"},
		{Field: "folder_id"}, {Field: "thread_id"},
		{Field: "read"}, {Field: "starred"}, {Field: "priority"},
		{Field: "delivery_status"}, {Field: "delivery_error"},
		{Field: "open_count"}, {Field: "last_opened_at"}, {Field: "click_count"},
		// Attachments are a list of objects, which the generic renderer would
		// reduce to a set of key names -- "{filename,id,mimetype,size}" tells the
		// reader nothing. Name the files and their sizes instead, which is what
		// someone reading a message wants to know.
		{Field: "attachments", Value: summariseAttachments},
		{Field: "body"},
	}
}

func summariseAttachments(row map[string]any) string {
	list, ok := row["attachments"].([]any)
	if !ok || len(list) == 0 {
		return ""
	}
	parts := make([]string, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name := output.Stringify(m["filename"])
		entry := fmt.Sprintf("%s (%s, id %s)",
			name, humanBytes(m["size"]), output.Stringify(m["id"]))
		if truthy(m["blocked"]) {
			entry += " [blocked]"
		}
		parts = append(parts, entry)
	}
	return strings.Join(parts, "\n")
}

// untrustedEmailFields names the fields of a message whose content came from
// whoever sent it. See internal/output/fence.go.
func untrustedEmailFields() []string {
	return []string{"body", "subject", "sender", "recipient", "cc", "bcc", "raw_headers", "snippet"}
}

// countSummary renders the "showing n of m" line.
func countSummary(shown int, total *int, noun string) string {
	if total != nil && *total > shown {
		return fmt.Sprintf("%d of %d %s -- use --page and --limit for more", shown, *total, noun)
	}
	if shown == 0 {
		return ""
	}
	return fmt.Sprintf("%d %s", shown, noun)
}
