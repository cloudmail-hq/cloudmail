package cmd

import (
	"encoding/json"
	"testing"
)

// --no-track reaches the request body as `"track": false`; without it the
// field is absent, so the server follows the mailbox setting.
func TestComposeNoTrackFlag(t *testing.T) {
	for _, tc := range []struct {
		name    string
		noTrack bool
		want    any // nil = absent
	}{
		{"default follows the mailbox", false, nil},
		{"--no-track sends track:false", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cf := &composeFlags{to: []string{"bob@example.com"}, subject: "Hi", text: "Hey", noTrack: tc.noTrack}
			req, err := cf.build("support@example.com")
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(req)
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			got, present := body["track"]
			if tc.want == nil {
				if present {
					t.Fatalf("track should be absent, got %v", got)
				}
				return
			}
			if got != tc.want {
				t.Fatalf("track = %v, want %v", got, tc.want)
			}
		})
	}
}
