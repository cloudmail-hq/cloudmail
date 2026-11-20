package cmd

import "testing"

func TestSentStatus(t *testing.T) {
	cases := []struct {
		name string
		row  map[string]any
		want string
	}{
		{"queued", map[string]any{"delivery_status": "queued"}, "sending"},
		{"legacy null", map[string]any{}, "sent"},
		{"sent", map[string]any{"delivery_status": "sent"}, "sent"},
		{"delivered", map[string]any{"delivery_status": "delivered"}, "delivered"},
		{"opened", map[string]any{"delivery_status": "delivered", "open_count": float64(3)}, "opened 3x"},
		{"opened via proxy", map[string]any{"open_count": float64(2), "open_proxy_count": float64(2)}, "opened 2x (proxy)"},
		{"clicked", map[string]any{"open_count": float64(1), "click_count": float64(1)}, "opened 1x, clicked 1"},
		{"clicked without a pixel", map[string]any{"delivery_status": "delivered", "click_count": float64(2)}, "delivered, clicked 2"},
		{"bounced wins", map[string]any{"delivery_status": "bounced", "open_count": float64(1)}, "bounced"},
		{"failed", map[string]any{"delivery_status": "failed"}, "failed"},
	}
	for _, tc := range cases {
		if got := sentStatus(tc.row); got != tc.want {
			t.Errorf("%s: sentStatus = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestSentFolderUsesStatusColumn(t *testing.T) {
	if !isSentFolder("Sent") || !isSentFolder(" sent ") || isSentFolder("inbox") {
		t.Fatal("isSentFolder misclassifies")
	}
	found := false
	for _, c := range sentColumns() {
		if c.Field == "status" {
			found = true
		}
	}
	if !found {
		t.Fatal("sentColumns has no status column")
	}
}
