package api

import "context"

// StatusCheck is one line of the deployment checklist.
type StatusCheck struct {
	ID       string  `json:"id"`
	Label    string  `json:"label"`
	OK       bool    `json:"ok"`
	Detail   *string `json:"detail"`
	Required bool    `json:"required"`
}

// SystemStatus is GET /api/v1/system/status (administrators).
type SystemStatus struct {
	Version string        `json:"version"`
	OK      bool          `json:"ok"`
	Checks  []StatusCheck `json:"checks"`
}

// GetSystemStatus returns the deployment's version and checklist.
func (c *Client) GetSystemStatus(ctx context.Context) (*SystemStatus, error) {
	var out SystemStatus
	if err := c.get(ctx, path("system", "status"), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
