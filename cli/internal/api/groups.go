package api

import "context"

// Group is a group address: mail to it is delivered into each member mailbox.
type Group struct {
	Address   string   `json:"address"`
	Name      string   `json:"name"`
	Members   []string `json:"members"`
	CreatedAt int64    `json:"createdAt,omitempty"`
	UpdatedAt int64    `json:"updatedAt,omitempty"`
}

// ListGroups returns every group address (administrators).
func (c *Client) ListGroups(ctx context.Context) ([]Group, error) {
	var out struct {
		Groups []Group `json:"groups"`
	}
	if err := c.get(ctx, path("groups"), nil, &out); err != nil {
		return nil, err
	}
	return out.Groups, nil
}

// PutGroup creates or replaces a group. Members must be mailboxes on the deployment.
func (c *Client) PutGroup(ctx context.Context, address, name string, members []string) (*Group, error) {
	if err := requireID("group address", address); err != nil {
		return nil, err
	}
	var out struct {
		Group Group `json:"group"`
	}
	_, err := c.mutate(ctx, Request{
		Method:     "PUT",
		Path:       path("groups", address),
		Body:       map[string]any{"name": name, "members": members},
		Idempotent: true,
		Reversible: true,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out.Group, nil
}

// DeleteGroup removes a group address. Mail to it stops being delivered.
func (c *Client) DeleteGroup(ctx context.Context, address string) error {
	if err := requireID("group address", address); err != nil {
		return err
	}
	_, err := c.mutate(ctx, Request{
		Method:     "DELETE",
		Path:       path("groups", address),
		Idempotent: true,
		Reversible: false,
		Note:       "mail to the address will no longer be delivered",
	}, nil)
	return err
}
