package cmd

// Instance and account resources: branding, delegates, notifications,
// preferences, privacy and the account, sending health, usage, the licence,
// migration and the Cloudflare connection.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

// ── shared helpers ─────────────────────────────────────────────────

// onOffFlags collects tri-state on|off flags into a JSON patch: a flag that was
// not given is left out, so the server keeps its current value.
type onOffFlags struct {
	vals map[string]*string
	keys map[string]string
}

func newOnOffFlags() *onOffFlags {
	return &onOffFlags{vals: map[string]*string{}, keys: map[string]string{}}
}

// add registers --flag on|off, written to the patch as key.
func (o *onOffFlags) add(c *cobra.Command, flag, key, usage string) {
	v := new(string)
	o.vals[flag], o.keys[flag] = v, key
	c.Flags().StringVar(v, flag, "", usage+": on or off")
}

// apply writes every given flag into patch.
func (o *onOffFlags) apply(c *cobra.Command, patch map[string]any) error {
	for flag, v := range o.vals {
		if !c.Flags().Changed(flag) {
			continue
		}
		b, err := onOff("--"+flag, *v)
		if err != nil {
			return err
		}
		patch[o.keys[flag]] = b
	}
	return nil
}

// jsonPatchFlags registers --<name> and --<name>-file for a JSON object.
func jsonPatchFlags(c *cobra.Command, name, what string) (*string, *string) {
	lit, file := new(string), new(string)
	c.Flags().StringVar(lit, name, "", what+" as a JSON object")
	c.Flags().StringVar(file, name+"-file", "", "read "+what+" from a JSON file (- for stdin)")
	c.MarkFlagsMutuallyExclusive(name, name+"-file")
	return lit, file
}

// requireJSONObject reads a patch and insists it is a non-empty object.
func requireJSONObject(lit, file, flag string) (json.RawMessage, error) {
	raw, err := readJSONArg(lit, file)
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, fail.Usagef("nothing to change").
			WithRemediation("pass --%s '{...}' or --%s-file patch.json", flag, flag)
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return nil, fail.Usagef("--%s must be a JSON object", flag)
	}
	if len(m) == 0 {
		return nil, fail.Usagef("the patch is empty; nothing to change")
	}
	return raw, nil
}

// emitPatch refuses an empty patch, then sends it.
func needPatch(patch map[string]any, flags string) error {
	if len(patch) == 0 {
		return fail.Usagef("nothing to change").WithRemediation("pass %s", flags)
	}
	return nil
}

// readLogo loads an image file and checks it against the server's rules
// before uploading, so a wrong file is a usage error rather than a 400.
func readLogo(file string) (api.LogoUpload, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return api.LogoUpload{}, fail.Usagef("cannot read %s: %v", file, err)
	}
	if len(data) > api.MaxLogoBytes {
		return api.LogoUpload{}, fail.Usagef("%s is %s; a logo may be at most %s",
			file, humanBytes(float64(len(data))), humanBytes(float64(api.MaxLogoBytes)))
	}
	ctype := http.DetectContentType(data)
	if !containsStr(api.LogoTypes, ctype) {
		return api.LogoUpload{}, fail.Usagef("%s is %s; a logo must be PNG, JPEG, WebP or GIF", file, ctype)
	}
	return api.LogoUpload{
		Content:  base64.StdEncoding.EncodeToString(data),
		Filename: filepath.Base(file),
		Type:     ctype,
	}, nil
}

// writeNewFile creates path for writing, refusing to replace an existing file
// unless --force was given.
func (a *App) writeNewFile(path string) (*os.File, error) {
	flags := os.O_WRONLY | os.O_CREATE | os.O_EXCL
	if a.force {
		flags = os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags, 0o600)
	if errors.Is(err, os.ErrExist) {
		return nil, fail.Refusedf("%s already exists", path).
			WithRemediation("choose another --output-file, or pass --force to replace it")
	}
	if err != nil {
		return nil, fail.Errf("cannot create %s: %v", path, err)
	}
	return f, nil
}

func rawCmd(use, short, long string, run func(c *cobra.Command, args []string) (json.RawMessage, error), a *App, args cobra.PositionalArgs) *cobra.Command {
	return &cobra.Command{
		Use: use, Short: short, Long: strings.TrimSpace(long), Args: args,
		RunE: func(c *cobra.Command, as []string) error {
			data, err := run(c, as)
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: data})
		},
	}
}

// ── branding ───────────────────────────────────────────────────────

func newBrandingCommand(a *App) *cobra.Command {
	c := group("branding", "The deployment's name, tagline, accent colour and logo", `
Branding is what every user sees in the app and in mail the deployment sends on its
own behalf. Anyone signed in can read it; changing it is administrator-only.`,
		"cloudmail branding show",
		`cloudmail branding set --app-name "Acme Mail" --accent-color "#0055ff"`,
		"cloudmail branding logo set ./logo.png",
	)

	show := rawCmd("show", "Show the branding", "", func(c *cobra.Command, _ []string) (json.RawMessage, error) {
		return a.Client.GetBranding(a.Ctx(c))
	}, a, cobra.NoArgs)

	var appName, tagline, accent string
	var noTagline bool
	set := &cobra.Command{
		Use:   "set",
		Short: "Change the name, tagline or accent colour",
		Long:  "Change the fields given and keep the rest. Administrator-only.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			patch := map[string]any{}
			if c.Flags().Changed("app-name") {
				patch["appName"] = appName
			}
			if c.Flags().Changed("tagline") {
				patch["tagline"] = tagline
			}
			if noTagline {
				if c.Flags().Changed("tagline") {
					return fail.Usagef("pass --tagline or --no-tagline, not both")
				}
				patch["tagline"] = nil
			}
			if c.Flags().Changed("accent-color") {
				patch["accentColor"] = accent
			}
			if err := needPatch(patch, "--app-name, --tagline, --no-tagline or --accent-color"); err != nil {
				return err
			}
			res, err := a.Client.UpdateBranding(a.Ctx(c), patch)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "branding saved"})
		},
	}
	set.Flags().StringVar(&appName, "app-name", "", "the product name shown in the app")
	set.Flags().StringVar(&tagline, "tagline", "", "the line under the name")
	set.Flags().BoolVar(&noTagline, "no-tagline", false, "remove the tagline")
	set.Flags().StringVar(&accent, "accent-color", "", "accent colour as #rrggbb")

	reset := &cobra.Command{
		Use:   "reset",
		Short: "Restore the default branding and delete the logo",
		Long: strings.TrimSpace(`
Put the name, tagline and colour back to their defaults and delete the uploaded
logo. The logo cannot be recovered afterwards; keep a copy with
` + "`cloudmail branding logo get --output-file logo.png`" + ` first. Asks for
confirmation unless --yes is given.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			if err := a.Confirm("reset branding to the defaults and delete the logo", true); err != nil {
				return err
			}
			res, err := a.Client.ResetBranding(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "branding reset"})
		},
	}

	logo := group("logo", "Download, upload or remove the logo", "")
	var outFile string
	logoGet := &cobra.Command{
		Use:   "get",
		Short: "Download the logo",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			data, ctype, err := a.Client.GetBrandingLogo(a.Ctx(c))
			if err != nil {
				return err
			}
			if outFile == "" {
				if a.Out.IsTTY() {
					return fail.Usagef("refusing to write an image to the terminal").
						WithRemediation("pass --output-file logo.png, or redirect stdout")
				}
				_, err := a.Out.Out().Write(data)
				return writeErr(err)
			}
			f, err := a.writeNewFile(outFile)
			if err != nil {
				return err
			}
			if _, err := f.Write(data); err != nil {
				f.Close()
				return fail.Errf("cannot write %s: %v", outFile, err)
			}
			if err := f.Close(); err != nil {
				return fail.Errf("cannot write %s: %v", outFile, err)
			}
			return a.emit(output.Result{
				Data:    map[string]any{"path": outFile, "bytes": len(data), "content_type": ctype},
				Summary: fmt.Sprintf("wrote %s to %s", humanBytes(float64(len(data))), outFile),
			})
		},
	}
	logoGet.Flags().StringVar(&outFile, "output-file", "", "write the image here")

	logoSet := &cobra.Command{
		Use:   "set <image-file>",
		Short: "Upload a logo (PNG, JPEG, WebP or GIF, up to 512 KiB)",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			up, err := readLogo(args[0])
			if err != nil {
				return err
			}
			res, err := a.Client.UploadBrandingLogo(a.Ctx(c), up)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "logo uploaded"})
		},
	}
	logoDelete := &cobra.Command{
		Use:   "delete",
		Short: "Remove the logo",
		Long:  "Delete the uploaded logo. Asks for confirmation unless --yes is given.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			if err := a.Confirm("delete the deployment's logo", true); err != nil {
				return err
			}
			res, err := a.Client.DeleteBrandingLogo(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "logo removed"})
		},
	}
	logo.AddCommand(logoGet, logoSet, logoDelete)
	c.AddCommand(show, set, reset, logo)
	return c
}

// ── delegates ──────────────────────────────────────────────────────

func newDelegateCommand(a *App) *cobra.Command {
	c := group("delegate", "Who can reach one mailbox, and how far", `
Delegates are the people and service tokens with access to one mailbox. Changing
them needs the manageDelegates capability on that mailbox; `+"`cloudmail access`"+`
manages the whole deployment's grant table instead.

Roles, from least to most: `+strings.Join(api.DelegateRoles, ", ")+`. --extra and
--revoke adjust a role by single capabilities: `+strings.Join(api.DelegateCapabilities, ", ")+`.`,
		"cloudmail delegate list --mailbox support@example.com",
		"cloudmail delegate set alice@example.com --role agent --mailbox support@example.com",
		"cloudmail delegate remove user alice@example.com --mailbox support@example.com",
	)

	list := rawCmd("list", "List the mailbox's delegates", "", func(c *cobra.Command, _ []string) (json.RawMessage, error) {
		mb, err := a.mustMailbox()
		if err != nil {
			return nil, err
		}
		return a.Client.ListDelegates(a.Ctx(c), mb)
	}, a, cobra.NoArgs)

	var in api.DelegateInput
	set := &cobra.Command{
		Use:   "set <email-or-client-id>",
		Short: "Grant or change one delegate's access",
		Long: strings.TrimSpace(`
Give one person (--kind user, the default) or Access service token (--kind service,
by Client ID) a role on the mailbox, replacing any role they had. Asks for
confirmation unless --yes is given.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			in.ID = strings.TrimSpace(args[0])
			if err := api.ValidateDelegate(in); err != nil {
				return err
			}
			if err := a.Confirm(fmt.Sprintf("give %s the %s role on %s", in.ID, in.Role, mb), false); err != nil {
				return err
			}
			res, err := a.Client.PutDelegate(a.Ctx(c), mb, in)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: fmt.Sprintf("%s is now %s on %s", in.ID, in.Role, mb)})
		},
	}
	set.Flags().StringVar(&in.Role, "role", "", "one of "+strings.Join(api.DelegateRoles, ", "))
	set.Flags().StringVar(&in.Kind, "kind", "user", "user or service")
	set.Flags().StringSliceVar(&in.Extra, "extra", nil, "capabilities to add to the role")
	set.Flags().StringSliceVar(&in.Revoked, "revoke", nil, "capabilities to take away from the role")
	set.Flags().StringVar(&in.Label, "label", "", "a name for a service token")
	_ = set.MarkFlagRequired("role")

	remove := &cobra.Command{
		Use:   "remove <user|service> <email-or-client-id>",
		Short: "Remove a delegate from the mailbox",
		Long:  "Remove one delegate's access to this mailbox. Asks for confirmation unless --yes is given.",
		Args:  cobra.ExactArgs(2),
		RunE: func(c *cobra.Command, args []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			if err := a.Confirm(fmt.Sprintf("remove %s %s from %s", args[0], args[1], mb), true); err != nil {
				return err
			}
			if err := a.Client.RemoveDelegate(a.Ctx(c), mb, args[0], args[1]); err != nil {
				return err
			}
			return a.emitMutation(output.Result{
				Data: map[string]any{"status": "removed", "kind": args[0], "id": args[1], "mailbox": mb},
			})
		},
	}
	c.AddCommand(list, set, remove)
	return c
}

// ── notifications ──────────────────────────────────────────────────

func newNotificationCommand(a *App) *cobra.Command {
	c := group("notification", "Your Web Push devices and notification preferences", `
Devices are registered by the browser when you turn notifications on in the app;
the CLI can list them, remove one, send a test, and change your preferences.`,
		"cloudmail notification devices",
		"cloudmail notification test",
		`cloudmail notification set --prefs '{"approvals":true,"mode":"important"}'`,
	)

	devices := &cobra.Command{
		Use:   "devices",
		Short: "List your registered devices",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			raw, err := a.Client.ListPushDevices(a.Ctx(c))
			if err != nil {
				return err
			}
			var env struct {
				Subscriptions []map[string]any `json:"subscriptions"`
			}
			_ = json.Unmarshal(raw, &env)
			return a.emit(output.Result{
				Data: raw, Rows: env.Subscriptions,
				Columns: []output.Column{
					{Header: "id", Field: "id", Truncate: 28},
					{Header: "label", Field: "label", Truncate: 30},
					{Header: "service", Field: "push_service", Truncate: 28},
					{Header: "last success", Field: "last_success_at", Truncate: 24},
					{Header: "failures", Field: "failures", Right: true},
				},
				Empty: "no devices registered",
			})
		},
	}

	remove := &cobra.Command{
		Use:   "remove <device-id>",
		Short: "Stop notifications to one device",
		Long:  "Revoke one device. It gets nothing more until its browser subscribes again. Asks unless --yes.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf("remove device %s", args[0]), false); err != nil {
				return err
			}
			res, err := a.Client.RemovePushDevice(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}

	prefs := rawCmd("prefs", "Show your notification preferences", "", func(c *cobra.Command, _ []string) (json.RawMessage, error) {
		return a.Client.GetPushPreferences(a.Ctx(c))
	}, a, cobra.NoArgs)

	set := &cobra.Command{
		Use:   "set",
		Short: "Change your notification preferences",
		Long: strings.TrimSpace(`
Merge a patch into your preferences. Fields: newMail, approvals, followups (booleans),
mode (all, important or products), products, mailboxes, vipSenders, hideContent and
quietHours. quietHours merges field by field. Read the current values with prefs.`),
		Args: cobra.NoArgs,
	}
	lit, file := jsonPatchFlags(set, "prefs", "the preference patch")
	set.RunE = func(c *cobra.Command, _ []string) error {
		raw, err := requireJSONObject(*lit, *file, "prefs")
		if err != nil {
			return err
		}
		res, err := a.Client.UpdatePushPreferences(a.Ctx(c), raw)
		if err != nil {
			return err
		}
		return a.emitMutation(output.Result{Data: res, Summary: "preferences saved"})
	}

	test := &cobra.Command{
		Use:   "test",
		Short: "Send a test notification to every device",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			res, err := a.Client.SendTestPush(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
	c.AddCommand(devices, remove, prefs, set, test)
	return c
}

// ── preferences ────────────────────────────────────────────────────

func newPreferencesCommand(a *App) *cobra.Command {
	c := group("preferences", "Deployment-wide display, notification and sending defaults", `
Anyone signed in can read these; changing them is administrator-only. Sections:
notifications (desktop, onlyImportant, playSound), display (density,
hideSignaturesInChat, previewText, readingPanePosition) and sending
(undoWindowEnabled, undoWindowSeconds 5-120).`,
		"cloudmail preferences show",
		`cloudmail preferences set --prefs '{"sending":{"undoWindowSeconds":20}}'`,
	)
	show := rawCmd("show", "Show the preferences", "", func(c *cobra.Command, _ []string) (json.RawMessage, error) {
		return a.Client.GetPreferences(a.Ctx(c))
	}, a, cobra.NoArgs)
	set := &cobra.Command{
		Use:   "set",
		Short: "Change the preferences",
		Long:  "Merge a patch into the preferences. Fields you leave out keep their values.",
		Args:  cobra.NoArgs,
	}
	lit, file := jsonPatchFlags(set, "prefs", "the preference patch")
	set.RunE = func(c *cobra.Command, _ []string) error {
		raw, err := requireJSONObject(*lit, *file, "prefs")
		if err != nil {
			return err
		}
		res, err := a.Client.UpdatePreferences(a.Ctx(c), raw)
		if err != nil {
			return err
		}
		return a.emitMutation(output.Result{Data: res, Summary: "preferences saved"})
	}
	c.AddCommand(show, set)
	return c
}

// ── privacy and the account ────────────────────────────────────────

func newPrivacyCommand(a *App) *cobra.Command {
	c := group("privacy", "The privacy notice, retention periods and per-mailbox tracking", `
The privacy settings hold the operator's notice (controller, grievance officer,
data location) and how long data is kept. Shortening a retention period lets the
server purge older data sooner, and purged data cannot be recovered, so set asks
first.

tracking shows and changes one mailbox's open, click and attachment tracking.`,
		"cloudmail privacy show",
		`cloudmail privacy set --settings '{"dataLocation":"EU"}'`,
		"cloudmail privacy tracking show --mailbox support@example.com",
		"cloudmail privacy tracking set --open off --click off --mailbox support@example.com",
	)
	show := rawCmd("show", "Show the privacy settings", "", func(c *cobra.Command, _ []string) (json.RawMessage, error) {
		return a.Client.GetPrivacySettings(a.Ctx(c))
	}, a, cobra.NoArgs)

	set := &cobra.Command{
		Use:   "set",
		Short: "Change the privacy notice or retention periods",
		Long: strings.TrimSpace(`
Merge a patch into the privacy settings. Administrator-only. Retention values are
clamped to their bounds by the server. Asks for confirmation unless --yes is
given, because a shorter retention period lets data be purged for good.`),
		Args: cobra.NoArgs,
	}
	lit, file := jsonPatchFlags(set, "settings", "the settings patch")
	set.RunE = func(c *cobra.Command, _ []string) error {
		raw, err := requireJSONObject(*lit, *file, "settings")
		if err != nil {
			return err
		}
		prompt := "change the privacy settings"
		if strings.Contains(string(raw), `"retention"`) {
			prompt = "change the retention periods; data older than a shorter period can be purged and not recovered"
		}
		if err := a.Confirm(prompt, true); err != nil {
			return err
		}
		res, err := a.Client.UpdatePrivacySettings(a.Ctx(c), raw)
		if err != nil {
			return err
		}
		return a.emitMutation(output.Result{Data: res, Summary: "privacy settings saved"})
	}

	tracking := group("tracking", "One mailbox's open, click and attachment tracking", "")
	tShow := rawCmd("show", "Show the mailbox's tracking settings", "", func(c *cobra.Command, _ []string) (json.RawMessage, error) {
		mb, err := a.mustMailbox()
		if err != nil {
			return nil, err
		}
		return a.Client.GetTrackingSettings(a.Ctx(c), mb)
	}, a, cobra.NoArgs)
	toggles := newOnOffFlags()
	var disclosureText string
	var noDisclosureText bool
	tSet := &cobra.Command{
		Use:   "set",
		Short: "Change the mailbox's tracking settings",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			patch := map[string]any{}
			if err := toggles.apply(c, patch); err != nil {
				return err
			}
			if c.Flags().Changed("disclosure-text") {
				patch["disclosureText"] = disclosureText
			}
			if noDisclosureText {
				patch["disclosureText"] = nil
			}
			if err := needPatch(patch, "--open, --click, --attachment, --disclosure or --disclosure-text"); err != nil {
				return err
			}
			res, err := a.Client.UpdateTrackingSettings(a.Ctx(c), mb, patch)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "tracking settings saved for " + mb})
		},
	}
	toggles.add(tSet, "open", "openTracking", "open tracking")
	toggles.add(tSet, "click", "clickTracking", "click tracking")
	toggles.add(tSet, "attachment", "attachmentTracking", "attachment tracking")
	toggles.add(tSet, "disclosure", "disclosureEnabled", "the tracking disclosure line")
	tSet.Flags().StringVar(&disclosureText, "disclosure-text", "", "the disclosure line's text")
	tSet.Flags().BoolVar(&noDisclosureText, "no-disclosure-text", false, "use the default disclosure text")
	tSet.MarkFlagsMutuallyExclusive("disclosure-text", "no-disclosure-text")
	tracking.AddCommand(tShow, tSet)

	c.AddCommand(show, set, tracking)
	return c
}

func newAccountCommand(a *App) *cobra.Command {
	c := group("account", "Your own account: pending deletion and data exports", `
These work only with a built-in account (password sign-in).

Requesting deletion and starting an export need a browser session that confirmed
your password or passkey in the last 15 minutes, so do those in the app (Settings
-> Account & security). From here you can see whether a deletion is pending, cancel
it, list your exports and download a finished one.`,
		"cloudmail account deletion",
		"cloudmail account cancel-deletion",
		"cloudmail account export list",
		"cloudmail account export download <export-id> --output-file export.zip",
	)
	deletion := rawCmd("deletion", "Whether your account is scheduled for deletion", "",
		func(c *cobra.Command, _ []string) (json.RawMessage, error) {
			return a.Client.GetAccountDeletion(a.Ctx(c))
		}, a, cobra.NoArgs)
	cancel := &cobra.Command{
		Use:   "cancel-deletion",
		Short: "Keep your account; cancel a pending deletion",
		Long:  "Cancel a pending deletion. Sessions and tokens revoked by the request stay revoked.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			res, err := a.Client.CancelAccountDeletion(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "deletion cancelled"})
		},
	}

	export := group("export", "Your account exports", "")
	exList := &cobra.Command{
		Use:   "list",
		Short: "List your exports",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			items, err := a.Client.ListAccountExports(a.Ctx(c))
			if err != nil {
				return err
			}
			// The signed link is a bearer credential for 24 hours; keep it out
			// of output that tends to end up in logs.
			rows := make([]map[string]any, 0, len(items))
			for _, x := range items {
				rows = append(rows, map[string]any{
					"id": x.ID, "status": x.Status, "size": x.Size, "error": x.Error,
					"createdAt": x.CreatedAt, "completedAt": x.CompletedAt, "expiresAt": x.ExpiresAt,
					"downloadable": x.DownloadURL != nil,
				})
			}
			return a.emit(output.Result{
				Data: rows,
				Columns: []output.Column{
					{Header: "id", Field: "id", Truncate: 28},
					{Header: "status", Field: "status"},
					{Header: "size", Field: "size", Value: func(r map[string]any) string { return humanBytes(r["size"]) }, Right: true},
					{Header: "downloadable", Field: "downloadable"},
				},
				Empty: "no exports; start one in the app",
			})
		},
	}
	var outFile string
	exDownload := &cobra.Command{
		Use:   "download <export-id>",
		Short: "Download a finished export as a zip",
		Long: strings.TrimSpace(`
Download a finished export to --output-file (default account-export-<id>.zip),
written 0600. An existing file is not replaced unless --force is given.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			items, err := a.Client.ListAccountExports(a.Ctx(c))
			if err != nil {
				return err
			}
			var job *api.AccountExport
			for i := range items {
				if items[i].ID == args[0] {
					job = &items[i]
				}
			}
			if job == nil {
				return fail.NotFoundf("no export %s", args[0]).
					WithRemediation("list them with `cloudmail account export list`")
			}
			if job.Status != "ready" || job.DownloadURL == nil {
				return fail.New(fail.Conflict, "EXPORT_NOT_READY", fmt.Sprintf("export %s is %s, not ready", job.ID, job.Status)).
					WithRemediation("wait for it to finish, then run this again")
			}
			dest := outFile
			if dest == "" {
				dest = "account-export-" + safeFilename(job.ID) + ".zip"
			}
			f, err := a.writeNewFile(dest)
			if err != nil {
				return err
			}
			n, err := a.Client.DownloadAccountExport(a.Ctx(c), *job.DownloadURL, f)
			cerr := f.Close()
			if err == nil && cerr != nil {
				err = fail.Errf("cannot write %s: %v", dest, cerr)
			}
			if err != nil {
				_ = os.Remove(dest) // a partial zip is worse than none
				return err
			}
			return a.emit(output.Result{
				Data:    map[string]any{"path": dest, "bytes": n},
				Summary: fmt.Sprintf("wrote %s to %s", humanBytes(float64(n)), dest),
			})
		},
	}
	exDownload.Flags().StringVar(&outFile, "output-file", "", "write the zip here")
	export.AddCommand(exList, exDownload)

	c.AddCommand(deletion, cancel, export)
	return c
}

// ── sending health and limits ──────────────────────────────────────

func newSendingCommand(a *App) *cobra.Command {
	c := group("sending", "Sending health per domain, bulk pauses and per-mailbox send caps", `
health shows each sending domain's spam complaint rate and whether bulk sending is
paused. A domain over the threshold is paused automatically; an administrator can
pause or resume it by hand (both are audited).

limits shows a mailbox's hourly and daily send caps and how much of them is used;
set-limits changes them (administrator, audited).`,
		"cloudmail sending health",
		`cloudmail sending pause example.com --reason "complaint spike"`,
		"cloudmail sending limits --mailbox support@example.com",
		"cloudmail sending set-limits --hourly 50 --daily 300 --mailbox support@example.com",
	)

	health := &cobra.Command{
		Use:   "health",
		Short: "Complaint rate and bulk-pause state per domain",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			raw, err := a.Client.ListSendingHealth(a.Ctx(c))
			if err != nil {
				return err
			}
			var env struct {
				Domains []map[string]any `json:"domains"`
			}
			_ = json.Unmarshal(raw, &env)
			return a.emit(output.Result{
				Data: raw, Rows: env.Domains,
				Columns: []output.Column{
					{Header: "domain", Field: "domain", Truncate: 32},
					{Header: "level", Field: "level"},
					{Header: "spam rate", Field: "spam_rate", Right: true},
					{Header: "complaints", Field: "complaints", Right: true},
					{Header: "delivered", Field: "delivered", Right: true},
					{Header: "bulk paused", Field: "bulk_paused"},
				},
				Empty: "no sending domains yet",
			})
		},
	}

	evaluate := &cobra.Command{
		Use:   "evaluate",
		Short: "Re-evaluate every sending domain now",
		Long: strings.TrimSpace(`
Recompute every domain's complaint rate now instead of waiting for the schedule.
A domain over the threshold has its bulk sending paused. Administrator-only. Asks
for confirmation unless --yes is given.`),
		Args: cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			if err := a.Confirm("re-evaluate sending health; domains over the threshold will have bulk sending paused", false); err != nil {
				return err
			}
			res, err := a.Client.EvaluateSendingHealth(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}

	var reason string
	pause := &cobra.Command{
		Use:   "pause <domain>",
		Short: "Pause bulk sending from a domain",
		Long:  "Stop bulk and sequence sends from the domain until it is resumed. Ordinary mail still goes. Asks unless --yes.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf("pause bulk sending from %s", args[0]), false); err != nil {
				return err
			}
			res, err := a.Client.PauseBulkSending(a.Ctx(c), args[0], reason)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "bulk sending paused for " + args[0]})
		},
	}
	pause.Flags().StringVar(&reason, "reason", "", "why, for the audit log")

	resume := &cobra.Command{
		Use:   "resume <domain>",
		Short: "Resume bulk sending from a domain",
		Long:  "Let bulk and sequence sends from the domain go out again. Asks unless --yes.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf("resume bulk sending from %s", args[0]), false); err != nil {
				return err
			}
			res, err := a.Client.ResumeBulkSending(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "bulk sending resumed for " + args[0]})
		},
	}

	limits := rawCmd("limits", "Show the mailbox's send caps and usage", "", func(c *cobra.Command, _ []string) (json.RawMessage, error) {
		mb, err := a.mustMailbox()
		if err != nil {
			return nil, err
		}
		return a.Client.GetSendLimits(a.Ctx(c), mb)
	}, a, cobra.NoArgs)

	var hourly, daily int
	setLimits := &cobra.Command{
		Use:   "set-limits",
		Short: "Change the mailbox's hourly and daily send caps",
		Long:  "Administrator-only and audited. The server refuses caps above the deployment's maxima.",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			mb, err := a.mustMailbox()
			if err != nil {
				return err
			}
			if hourly < 0 || daily < 0 {
				return fail.Usagef("caps must be positive")
			}
			if hourly == 0 && daily == 0 {
				return fail.Usagef("nothing to change").WithRemediation("pass --hourly, --daily or both")
			}
			if err := a.Confirm(fmt.Sprintf("change the send caps of %s", mb), false); err != nil {
				return err
			}
			res, err := a.Client.UpdateSendLimits(a.Ctx(c), mb, hourly, daily)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "send caps saved for " + mb})
		},
	}
	setLimits.Flags().IntVar(&hourly, "hourly", 0, "messages per hour")
	setLimits.Flags().IntVar(&daily, "daily", 0, "messages per day")

	c.AddCommand(health, evaluate, pause, resume, limits, setLimits)
	return c
}

// ── usage ──────────────────────────────────────────────────────────

func newUsageCommand(a *App) *cobra.Command {
	c := group("usage", "This month's usage, projected cost and budget", `
Administrator-only. show reports Email Service, Workers AI, R2 and Durable Object
usage with the projected cost; budget sets the monthly thresholds that raise a
usage.budget_exceeded event.`,
		"cloudmail usage show",
		"cloudmail usage budget --ai-usd 20 --email-usd none",
	)
	var refresh bool
	show := &cobra.Command{
		Use:   "show",
		Short: "Show this month's usage and projected cost",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			res, err := a.Client.GetUsage(a.Ctx(c), refresh)
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: res})
		},
	}
	show.Flags().BoolVar(&refresh, "refresh", false, "recompute instead of using the cached figures")

	var aiUSD, emailUSD string
	budget := &cobra.Command{
		Use:   "budget",
		Short: "Set or clear the monthly budget thresholds",
		Long:  `Set a threshold in US dollars, or "none" to clear it. Thresholds you leave out keep their values.`,
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			parse := func(flag, v string) (*float64, error) {
				if !c.Flags().Changed(flag) {
					return nil, nil
				}
				if strings.EqualFold(strings.TrimSpace(v), "none") {
					clear := -1.0
					return &clear, nil
				}
				f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
				if err != nil || f < 0 {
					return nil, fail.Usagef("--%s must be an amount in USD or none", flag)
				}
				return &f, nil
			}
			ai, err := parse("ai-usd", aiUSD)
			if err != nil {
				return err
			}
			email, err := parse("email-usd", emailUSD)
			if err != nil {
				return err
			}
			res, err := a.Client.UpdateUsageBudget(a.Ctx(c), ai, email)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res, Summary: "budget saved"})
		},
	}
	budget.Flags().StringVar(&aiUSD, "ai-usd", "", `monthly AI threshold in USD, or "none"`)
	budget.Flags().StringVar(&emailUSD, "email-usd", "", `monthly email threshold in USD, or "none"`)
	c.AddCommand(show, budget)
	return c
}

// ── licence ────────────────────────────────────────────────────────

func newLicenceCommand(a *App) *cobra.Command {
	c := group("licence", "The deployment's licence status", `
status shows whether the deployment is licensed and whether it is locked. Members
see only that; administrators also see the plan, expiry and refresh state.
refresh asks the licence server for a new token now (administrator).

Activating and deactivating a licence key need a signed-in browser session, so do
them in the app (Settings -> Licence). The key is never accepted by this CLI.`,
		"cloudmail licence status",
		"cloudmail licence refresh",
	)
	status := rawCmd("status", "Show the licence status", "", func(c *cobra.Command, _ []string) (json.RawMessage, error) {
		return a.Client.GetLicence(a.Ctx(c))
	}, a, cobra.NoArgs)
	refresh := &cobra.Command{
		Use:   "refresh",
		Short: "Refresh the licence token now",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			res, err := a.Client.RefreshLicence(a.Ctx(c))
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
	c.AddCommand(status, refresh)
	return c
}

// ── migration ──────────────────────────────────────────────────────

func newMigrateCommand(a *App) *cobra.Command {
	c := group("migrate", "Copy mailboxes from a legacy per-domain deployment", `
One-off routes for consolidating per-domain deployments. They need an administrator
and the deployment's migration secret in CLOUDMAIL_MIGRATION_TOKEN; without the
secret they answer 404.

status compares row counts between the legacy and current copy. run copies a
mailbox; rows already copied are skipped, so it is safe to repeat. run --check
counts what would be copied and writes nothing.`,
		"cloudmail migrate status support@example.com",
		"cloudmail migrate run support@example.com --check",
		"cloudmail migrate run support@example.com --yes",
	)
	status := rawCmd("status <mailbox>", "Compare legacy and current row counts", "",
		func(c *cobra.Command, args []string) (json.RawMessage, error) {
			return a.Client.MigrationStatus(a.Ctx(c), args[0])
		}, a, cobra.ExactArgs(1))
	var check bool
	run := &cobra.Command{
		Use:   "run <mailbox>",
		Short: "Copy a mailbox from the legacy namespace",
		Long:  "Copy the mailbox's rows. Asks for confirmation unless --yes or --check is given.",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if !check {
				if err := a.Confirm(fmt.Sprintf("copy %s from the legacy namespace", args[0]), false); err != nil {
					return err
				}
			}
			res, err := a.Client.MigrateMailbox(a.Ctx(c), args[0], check)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
	run.Flags().BoolVar(&check, "check", false, "count what would be copied; write nothing")
	c.AddCommand(status, run)
	return c
}

// ── cloudflare ─────────────────────────────────────────────────────

func newCloudflareCommand(a *App) *cobra.Command {
	c := group("cloudflare", "The Cloudflare connection, zone discovery and the setup plan", `
Administrator-only, with domains:manage on a token. These commands only read:

  status    which Cloudflare token the app uses, its account and capabilities
  discover  every zone the token sees, with mail DNS and routing state
  plan      what setup would change for the chosen zones
  changes   what earlier setup runs changed

Connecting or forgetting a token, applying a plan and reverting a change all need
a browser session that confirmed your password or passkey in the last 15 minutes,
so do them in the app (Settings -> Domains). `+"`cloudmail domain provision`"+`
configures one domain from the CLI.`,
		"cloudmail cloudflare status",
		"cloudmail cloudflare discover",
		"cloudmail cloudflare plan <zone-id>",
	)
	status := rawCmd("status", "Show the Cloudflare connection", "", func(c *cobra.Command, _ []string) (json.RawMessage, error) {
		return a.Client.GetCloudflareConnection(a.Ctx(c))
	}, a, cobra.NoArgs)
	var refresh bool
	discover := rawCmd("discover", "List every zone the token can see", "", func(c *cobra.Command, _ []string) (json.RawMessage, error) {
		return a.Client.DiscoverCloudflare(a.Ctx(c), refresh)
	}, a, cobra.NoArgs)
	discover.Flags().BoolVar(&refresh, "refresh", false, "ask Cloudflare again instead of using the cached result")
	plan := rawCmd("plan <zone-id>...", "Show the setup plan for up to 5 zones",
		"Show each item the setup would apply, tiered auto, confirm, manual or done. Nothing is changed.",
		func(c *cobra.Command, args []string) (json.RawMessage, error) {
			return a.Client.PlanCloudflare(a.Ctx(c), args)
		}, a, cobra.RangeArgs(1, 5))
	var zone string
	var limit int
	changes := &cobra.Command{
		Use:   "changes",
		Short: "Recent changes made by setup, newest first",
		Args:  cobra.NoArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			raw, err := a.Client.ListCloudflareChanges(a.Ctx(c), zone, limit)
			if err != nil {
				return err
			}
			var env struct {
				Changes []map[string]any `json:"changes"`
			}
			_ = json.Unmarshal(raw, &env)
			return a.emit(output.Result{
				Data: raw, Rows: env.Changes,
				Columns: []output.Column{
					{Header: "id", Field: "id", Truncate: 26},
					{Header: "zone", Field: "zoneName", Truncate: 28},
					{Header: "action", Field: "action"},
					{Header: "type", Field: "recordType"},
					{Header: "name", Field: "name", Truncate: 32},
					{Header: "applied by", Field: "appliedBy", Truncate: 24},
				},
				Empty: "no changes recorded",
			})
		},
	}
	changes.Flags().StringVar(&zone, "zone", "", "only this zone id")
	changes.Flags().IntVar(&limit, "limit-per-page", 0, "how many to fetch")
	c.AddCommand(status, discover, plan, changes)
	return c
}
