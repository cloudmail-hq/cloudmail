package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// fakeImportServer plays the import routes: create, parts, complete.
type fakeImportServer struct {
	mu         sync.Mutex
	created    map[string]any
	createKey  string
	parts      map[int][]byte
	complete   bool
	partsTotal int
}

func (s *fakeImportServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	base := "/api/v1/mailboxes/me@example.com/imports"
	switch {
	case r.Method == "POST" && r.URL.Path == base:
		_ = json.NewDecoder(r.Body).Decode(&s.created)
		s.createKey = r.Header.Get("Idempotency-Key")
		size := int64(s.created["size_bytes"].(float64))
		part := int64(s.created["part_size"].(float64))
		s.partsTotal = int((size + part - 1) / part)
		fmt.Fprintf(w, `{"id":"imp_1","source":"mbox","status":"uploading","label":"x","counts":{},"progress":{"done":0,"total":null,"unit":"bytes"},"upload":{"part_size":%d,"parts_uploaded":0,"parts_total":%d}}`, part, s.partsTotal)
	case r.Method == "PUT" && strings.HasPrefix(r.URL.Path, base+"/imp_1/parts/"):
		var n int
		fmt.Sscanf(strings.TrimPrefix(r.URL.Path, base+"/imp_1/parts/"), "%d", &n)
		if r.Header.Get("Content-Type") != "application/octet-stream" {
			w.WriteHeader(400)
			return
		}
		b, _ := io.ReadAll(r.Body)
		s.parts[n] = b
		_, _ = w.Write([]byte(`{"id":"imp_1","source":"mbox","status":"uploading","label":"x","counts":{},"progress":{"done":0,"total":null,"unit":"bytes"}}`))
	case r.Method == "POST" && r.URL.Path == base+"/imp_1/complete":
		s.complete = true
		_, _ = w.Write([]byte(`{"id":"imp_1","source":"mbox","status":"queued","label":"x","counts":{"imported":0},"progress":{"done":0,"total":100,"unit":"bytes"}}`))
	default:
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":"no route"}`))
	}
}

func TestUploadImportFileStreamsParts(t *testing.T) {
	srv := &fakeImportServer{parts: map[int][]byte{}}
	c, _ := newTestClient(t, srv)
	c.SetIdempotencyKey("run-1")
	// Two full parts and a short tail.
	line := []byte("From a@b Tue Jan 14 10:00:00 2014\nSubject: x\n\nbody\n\n")
	data := bytes.Repeat(line, (2*ImportPartSize+1234)/len(line)+1)
	data = data[:2*ImportPartSize+1234]
	var progress []int64
	job, err := c.UploadImportFile(context.Background(), "me@example.com", "mbox", "all.mbox", int64(len(data)), "inbox",
		bytes.NewReader(data), func(sent, total int64) { progress = append(progress, sent) })
	if err != nil {
		t.Fatalf("UploadImportFile: %v", err)
	}
	if job.Status != "queued" || !srv.complete {
		t.Fatalf("job = %+v, complete = %v", job, srv.complete)
	}
	if srv.createKey != "run-1" {
		t.Errorf("create carried Idempotency-Key %q", srv.createKey)
	}
	if srv.created["folder"] != "inbox" || srv.created["filename"] != "all.mbox" || srv.created["source"] != "mbox" {
		t.Errorf("create body = %v", srv.created)
	}
	if len(srv.parts) != 3 {
		t.Fatalf("parts = %d, want 3", len(srv.parts))
	}
	var joined []byte
	for n := 1; n <= 3; n++ {
		joined = append(joined, srv.parts[n]...)
	}
	if !bytes.Equal(joined, data) {
		t.Errorf("reassembled upload differs from the file")
	}
	if len(srv.parts[3]) != 1234 {
		t.Errorf("last part = %d bytes", len(srv.parts[3]))
	}
	if len(progress) != 3 || progress[2] != int64(len(data)) {
		t.Errorf("progress = %v", progress)
	}
}

func TestImportClientValidation(t *testing.T) {
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("no request expected, got %s %s", r.Method, r.URL.Path)
	}))
	ctx := context.Background()
	if _, err := c.CreateFileImport(ctx, "me@example.com", "pst", "x.pst", 10, ""); err == nil {
		t.Error("unknown source accepted")
	}
	if _, err := c.CreateFileImport(ctx, "me@example.com", "mbox", "x.mbox", 0, ""); err == nil {
		t.Error("empty file accepted")
	}
	if _, err := c.CreateFileImport(ctx, "me@example.com", "mbox", "x.mbox", 10, "spam"); err == nil {
		t.Error("bad folder accepted")
	}
	if _, err := c.CreateIMAPImport(ctx, "me@example.com", "imap.example.com", "u", "", nil); err == nil {
		t.Error("missing password accepted")
	}
	if _, err := c.ImportAction(ctx, "me@example.com", "imp_1", "delete"); err == nil {
		t.Error("unknown action accepted")
	}
}

func TestIMAPImportBodyAndStatus(t *testing.T) {
	var body map[string]any
	var paths []string
	c, _ := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "POST" {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		if r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/imports") {
			_, _ = w.Write([]byte(`{"imports":[{"id":"imp_2","source":"imap","status":"running","label":"u@imap.example.com","counts":{"imported":5},"progress":{"done":5,"total":10,"unit":"messages"}}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"imp_2","source":"imap","status":"queued","label":"u@imap.example.com","counts":{},"progress":{"done":0,"total":null,"unit":"messages"}}`))
	}))
	ctx := context.Background()
	if _, err := c.CreateIMAPImport(ctx, "me@example.com", "imap.example.com", "u", "app pw", []string{"INBOX"}); err != nil {
		t.Fatal(err)
	}
	if body["source"] != "imap" || body["password"] != "app pw" || body["host"] != "imap.example.com" {
		t.Errorf("imap body = %v", body)
	}
	jobs, err := c.ListImports(ctx, "me@example.com")
	if err != nil || len(jobs) != 1 || jobs[0].Counts.Imported != 5 || jobs[0].Terminal() {
		t.Fatalf("ListImports = %+v, %v", jobs, err)
	}
	if _, err := c.ImportAction(ctx, "me@example.com", "imp_2", "pause"); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"POST /api/v1/mailboxes/me@example.com/imports",
		"GET /api/v1/mailboxes/me@example.com/imports",
		"POST /api/v1/mailboxes/me@example.com/imports/imp_2/pause",
	}
	if strings.Join(paths, "\n") != strings.Join(want, "\n") {
		t.Errorf("paths = %v", paths)
	}
}
