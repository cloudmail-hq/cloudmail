package api

import (
	"context"
	"io"
	"strconv"

	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
)

// ImportJob is a mail import: a file upload (mbox, zip of .eml, .eml) or an
// IMAP account. It never carries a credential.
type ImportJob struct {
	ID         string  `json:"id"`
	Source     string  `json:"source"`
	Status     string  `json:"status"`
	Label      string  `json:"label"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
	StartedAt  *string `json:"started_at"`
	FinishedAt *string `json:"finished_at"`
	SizeBytes  *int64  `json:"size_bytes"`
	Upload     *struct {
		PartSize      int64 `json:"part_size"`
		PartsUploaded int   `json:"parts_uploaded"`
		PartsTotal    int   `json:"parts_total"`
	} `json:"upload"`
	Counts struct {
		Imported   int `json:"imported"`
		Duplicates int `json:"duplicates"`
		Failed     int `json:"failed"`
		Skipped    int `json:"skipped"`
	} `json:"counts"`
	Progress struct {
		Done  int64  `json:"done"`
		Total *int64 `json:"total"`
		Unit  string `json:"unit"`
	} `json:"progress"`
	LastError *string `json:"last_error"`
	IMAP      *struct {
		Host          string  `json:"host"`
		Username      string  `json:"username"`
		FoldersTotal  int     `json:"folders_total"`
		FoldersDone   int     `json:"folders_done"`
		CurrentFolder *string `json:"current_folder"`
	} `json:"imap"`
}

// Terminal reports whether the job will never change again.
func (j *ImportJob) Terminal() bool {
	return j.Status == "completed" || j.Status == "failed" || j.Status == "cancelled"
}

// ImportFileSources are the file kinds `import` accepts.
var ImportFileSources = []string{"mbox", "zip", "eml"}

// ImportPartSize is the part size the CLI uploads in: R2's 5 MiB minimum, so a
// part fits comfortably inside the request timeout on a slow link.
const ImportPartSize = 5 * 1024 * 1024

// ListImports returns recent imports, newest first.
func (c *Client) ListImports(ctx context.Context, mailbox string) ([]ImportJob, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	var out struct {
		Imports []ImportJob `json:"imports"`
	}
	if err := c.get(ctx, mailboxPath(mailbox, "imports"), nil, &out); err != nil {
		return nil, err
	}
	return out.Imports, nil
}

// GetImport returns one import with its progress.
func (c *Client) GetImport(ctx context.Context, mailbox, id string) (*ImportJob, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("import", id); err != nil {
		return nil, err
	}
	var out ImportJob
	if err := c.get(ctx, mailboxPath(mailbox, "imports", id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateFileImport starts an upload. Parts then go to UploadImportPart.
func (c *Client) CreateFileImport(
	ctx context.Context, mailbox, source, filename string, size int64, folder string,
) (*ImportJob, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if !contains(ImportFileSources, source) {
		return nil, fail.Usagef("unknown import source %q", source).WithRemediation("use mbox, zip or eml")
	}
	if size <= 0 {
		return nil, fail.Usagef("%s is empty", filename)
	}
	body := map[string]any{"source": source, "filename": filename, "size_bytes": size, "part_size": ImportPartSize}
	if folder != "" {
		if folder != "inbox" && folder != "archive" {
			return nil, fail.Usagef("--folder must be inbox or archive")
		}
		body["folder"] = folder
	}
	var out ImportJob
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "imports"),
		Body:       body,
		Keyed:      true,
		Reversible: true,
		Note:       "uploads the file, then imports its messages in the background; no notifications or auto-replies",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// UploadImportPart sends one part (1-based). Re-sending a part replaces it,
// so the request is safe to retry.
func (c *Client) UploadImportPart(ctx context.Context, mailbox, id string, n int, data []byte) (*ImportJob, error) {
	var out ImportJob
	_, err := c.mutate(ctx, Request{
		Method:      "PUT",
		Path:        mailboxPath(mailbox, "imports", id, "parts", strconv.Itoa(n)),
		Raw:         data,
		ContentType: "application/octet-stream",
		Idempotent:  true,
		Reversible:  true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// CompleteImport finishes the upload and queues the import.
func (c *Client) CompleteImport(ctx context.Context, mailbox, id string) (*ImportJob, error) {
	return c.importAction(ctx, mailbox, id, "complete")
}

// ImportAction pauses, resumes or cancels an import.
func (c *Client) ImportAction(ctx context.Context, mailbox, id, action string) (*ImportJob, error) {
	if action != "pause" && action != "resume" && action != "cancel" {
		return nil, fail.Usagef("unknown import action %q", action)
	}
	return c.importAction(ctx, mailbox, id, action)
}

func (c *Client) importAction(ctx context.Context, mailbox, id, action string) (*ImportJob, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if err := requireID("import", id); err != nil {
		return nil, err
	}
	var out ImportJob
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "imports", id, action),
		Idempotent: true,
		Reversible: action != "cancel",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateIMAPImport starts an import from an IMAP account (TLS, port 993).
func (c *Client) CreateIMAPImport(
	ctx context.Context, mailbox, host, username, password string, folders []string,
) (*ImportJob, error) {
	if err := requireMailbox(mailbox); err != nil {
		return nil, err
	}
	if host == "" || username == "" || password == "" {
		return nil, fail.Usagef("import imap needs --host, --user and a password")
	}
	body := map[string]any{"source": "imap", "host": host, "username": username, "password": password}
	if len(folders) > 0 {
		body["folders"] = folders
	}
	var out ImportJob
	_, err := c.mutate(ctx, Request{
		Method:     "POST",
		Path:       mailboxPath(mailbox, "imports"),
		Body:       body,
		Keyed:      true,
		Reversible: true,
		Note:       "reads the account read-only over TLS; the password is stored encrypted until the import ends",
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// UploadImportFile streams r in ImportPartSize parts to a new import, holding
// one part in memory at a time, then queues it. progress (may be nil) gets the
// bytes sent so far.
func (c *Client) UploadImportFile(
	ctx context.Context, mailbox, source, filename string, size int64, folder string,
	r io.Reader, progress func(sent, total int64),
) (*ImportJob, error) {
	job, err := c.CreateFileImport(ctx, mailbox, source, filename, size, folder)
	if err != nil {
		return nil, err
	}
	if job.Upload == nil {
		// --dry-run: the preview stands in for the job.
		return job, nil
	}
	partSize := job.Upload.PartSize
	buf := make([]byte, partSize)
	var sent int64
	for n := 1; n <= job.Upload.PartsTotal; n++ {
		want := partSize
		if rest := size - sent; rest < want {
			want = rest
		}
		got, err := io.ReadFull(r, buf[:want])
		if err != nil {
			return nil, fail.Errf("reading %s: %v", filename, err).
				WithRemediation("the file changed while uploading; re-run, then cancel import %s", job.ID).
				Wrap(err)
		}
		if _, err := c.UploadImportPart(ctx, mailbox, job.ID, n, buf[:got]); err != nil {
			return nil, err
		}
		sent += int64(got)
		if progress != nil {
			progress(sent, size)
		}
	}
	return c.CompleteImport(ctx, mailbox, job.ID)
}
