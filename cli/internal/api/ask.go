package api

import (
	"context"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// AskCitation is one message an answer cites as [N].
type AskCitation struct {
	N        int     `json:"n"`
	Mailbox  string  `json:"mailbox"`
	EmailID  string  `json:"email_id"`
	ThreadID *string `json:"thread_id"`
	Folder   *string `json:"folder"`
	Subject  string  `json:"subject"`
	From     *string `json:"from"`
	Date     *string `json:"date"`
	Href     string  `json:"href"`
}

// AskAnswer is POST /api/v1/ask. The answer is model output drawn from
// third-party mail: untrusted.
type AskAnswer struct {
	Question     string        `json:"question"`
	Answer       string        `json:"answer"`
	Insufficient bool          `json:"insufficient"`
	Semantic     bool          `json:"semantic"`
	Citations    []AskCitation `json:"citations"`
	Mailboxes    []string      `json:"mailboxes"`
}

// Ask answers a question from the caller's mail. mailbox is one address, or
// "" / "*" for every readable mailbox. It is a POST that changes nothing, so it
// is not a mutation: --read-only and --dry-run let it through.
func (c *Client) Ask(ctx context.Context, question, mailbox string, products []string) (*AskAnswer, error) {
	q := strings.TrimSpace(question)
	if q == "" {
		return nil, fail.Usagef("no question given").
			WithRemediation(`try: cloudmail ask "when is my flight to Lisbon?"`)
	}
	if len(q) > 500 {
		return nil, fail.Usagef("the question is %d characters; the limit is 500", len(q))
	}
	body := map[string]any{"question": q}
	if m := strings.TrimSpace(mailbox); m != "" {
		body["mailbox"] = m
	}
	if len(products) > 0 {
		body["product"] = products
	}
	resp, err := c.Do(ctx, Request{Method: "POST", Path: "/api/v1/ask", Body: body, Idempotent: true})
	if err != nil {
		return nil, err
	}
	var out AskAnswer
	if err := resp.Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}
