package api

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// IdempotencyHeader is the request header the Worker deduplicates sends and
// creates on. A repeat with the same key and body returns the first response
// (marked Idempotent-Replayed: true) instead of acting again.
const IdempotencyHeader = "Idempotency-Key"

// MaxIdempotencyKeyLength is the server's limit.
const MaxIdempotencyKeyLength = 256

// NewIdempotencyKey returns a random key, used when --idempotency-key is not
// given so every invocation is still safe to retry internally.
func NewIdempotencyKey() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand does not fail on supported platforms; a fixed fallback
		// would make unrelated invocations collide, so fail loudly instead.
		panic(fmt.Sprintf("crypto/rand: %v", err))
	}
	return "cloudmail-" + hex.EncodeToString(b)
}

// ValidateIdempotencyKey enforces the server's 1-256 printable ASCII rule
// locally, so a bad key fails before anything is sent.
func ValidateIdempotencyKey(key string) error {
	if key == "" || len(key) > MaxIdempotencyKeyLength {
		return fail.Usagef("--idempotency-key must be 1-%d characters", MaxIdempotencyKeyLength)
	}
	for _, r := range key {
		if r < 0x20 || r > 0x7e {
			return fail.Usagef("--idempotency-key must be printable ASCII").
				WithRemediation("use letters, digits and punctuation, e.g. a UUID")
		}
	}
	return nil
}

// SetIdempotencyKey sets the key keyed requests carry for the rest of this
// invocation. An empty key turns keying off.
func (c *Client) SetIdempotencyKey(key string) {
	c.idemKey = key
	c.idemUsed = 0
}

// IdempotencyKey is the invocation's base key, or "" when none is set.
func (c *Client) IdempotencyKey() string { return c.idemKey }

// nextIdempotencyKey hands out the key for the next keyed request.
//
// The first request uses the key as given; later ones in the same invocation
// (`suppression add a b c`) get `<key>-2`, `<key>-3`, in order. Re-running the
// same command with the same key therefore maps each request to the key it had
// the first time, and the whole run replays rather than repeating.
func (c *Client) nextIdempotencyKey() string {
	if c.idemKey == "" {
		return ""
	}
	c.idemUsed++
	if c.idemUsed == 1 {
		return c.idemKey
	}
	suffix := fmt.Sprintf("-%d", c.idemUsed)
	base := c.idemKey
	if len(base)+len(suffix) > MaxIdempotencyKeyLength {
		base = base[:MaxIdempotencyKeyLength-len(suffix)]
	}
	return base + suffix
}

// applyIdempotency attaches a key to a keyed request. With a key, a request
// that was unsafe to retry becomes safe: a repeat replays instead of acting.
func (c *Client) applyIdempotency(req *Request) {
	if !req.Keyed || req.Method != "POST" {
		return
	}
	key := c.nextIdempotencyKey()
	if key == "" {
		return
	}
	headers := make(map[string]string, len(req.Headers)+1)
	for k, v := range req.Headers {
		headers[k] = v
	}
	headers[IdempotencyHeader] = key
	req.Headers = headers
	req.Idempotent = true
	if c.verbose {
		fmt.Fprintf(os.Stderr, "cloudmail: %s: %s\n", IdempotencyHeader, key)
	}
}
