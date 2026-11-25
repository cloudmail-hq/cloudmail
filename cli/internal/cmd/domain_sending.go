package cmd

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/cloudmail-hq/cloudmail/cli/internal/api"
	"github.com/cloudmail-hq/cloudmail/cli/internal/fail"
	"github.com/cloudmail-hq/cloudmail/cli/internal/output"
	"github.com/spf13/cobra"
)

// `cloudmail domain sending show|set|test|reset`: which provider a domain's
// outgoing mail leaves through. Secrets (the SES secret access key, the Resend
// API key and webhook signing secret) are read from stdin, a file or a hidden
// prompt, never from a flag, so they stay out of argv and shell history.

func domainSending(a *App) *cobra.Command {
	c := group("sending", "Choose how a domain's outgoing mail is sent", `
Each domain sends through Cloudflare Email Service unless you switch it to Amazon
SES or Resend. A domain set to SES or Resend never falls back to Cloudflare: if the
provider cannot be used, the send fails and says why.

Switching takes two steps: save the settings with "set", run "test", then "set"
again. The provider becomes active only once a test of the saved settings passes
(SES: DKIM verified; Resend: domain verified).

Administrator-only.`,
		"cloudmail domain sending show example.com",
		"cloudmail domain sending set example.com --provider ses --region eu-west-1 --access-key-id AKIA... --secret-stdin < secret.txt",
		"cloudmail domain sending set example.com --provider resend --api-key-file ./resend-key --webhook-secret-file ./whsec",
		"cloudmail domain sending test example.com --send",
		"cloudmail domain sending reset example.com",
	)
	c.AddCommand(domainSendingShow(a), domainSendingSet(a), domainSendingTest(a), domainSendingReset(a))
	return c
}

func domainSendingShow(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "show <id-or-hostname>",
		Short: "Show a domain's sending provider",
		Long: strings.TrimSpace(`
Show the provider, the stored SES or Resend settings (last 4 characters of keys,
whether secrets are stored), the webhook URL for bounces and complaints, the last
provider event, the last connection test and, for SES, the least-privilege IAM
policy. Secrets are never shown.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			s, err := a.Client.GetDomainSending(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emit(output.Result{Data: s, Summary: sendingSummary(s)})
		},
	}
}

func domainSendingSet(a *App) *cobra.Command {
	var provider, region, keyID, configSet, topicArn, secretFile, apiKeyFile, webhookSecretFile string
	var secretStdin, apiKeyStdin bool
	c := &cobra.Command{
		Use:   "set <id-or-hostname>",
		Short: "Send a domain's mail through Cloudflare, Amazon SES or Resend",
		Long: strings.TrimSpace(`
--provider cloudflare switches back to Cloudflare and keeps any stored provider settings.

--provider ses needs --region and --access-key-id. The secret access key comes from
--secret-stdin, --secret-file, or a hidden prompt at a terminal. With none of these
the stored secret is kept, which works only when the access key ID is unchanged.
--sns-topic-arn names the SNS topic SES publishes bounces and complaints to.

--provider resend reads the API key from --api-key-stdin, --api-key-file or a hidden
prompt (Enter keeps the stored key), and the webhook signing secret from
--webhook-secret-file.

SES and Resend take effect only after "cloudmail domain sending test" passes for the
saved settings. Until then the command reports why and mail keeps going through
Cloudflare.`),
		Example: exampleBlock(
			"cloudmail domain sending set example.com --provider cloudflare",
			"cloudmail domain sending set example.com --provider ses --region eu-west-1 --access-key-id AKIA... --secret-file ./ses-secret --sns-topic-arn arn:aws:sns:eu-west-1:123456789012:cloudmail",
			"cloudmail domain sending set example.com --provider resend --api-key-stdin < resend-key",
		),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			in := api.DomainSendingInput{Provider: provider}
			sesFlags := region != "" || keyID != "" || secretStdin || secretFile != "" || configSet != "" || topicArn != ""
			resendFlags := apiKeyStdin || apiKeyFile != "" || webhookSecretFile != ""
			switch provider {
			case "cloudflare":
				if sesFlags || resendFlags {
					return fail.Usagef("provider flags have no effect with --provider cloudflare")
				}
			case "ses":
				if resendFlags {
					return fail.Usagef("Resend flags have no effect with --provider ses")
				}
				if region == "" || keyID == "" {
					return fail.Usagef("--provider ses needs --region and --access-key-id")
				}
				in.Region, in.AccessKeyID = region, strings.TrimSpace(keyID)
				if configSet != "" {
					in.ConfigurationSet = &configSet
				}
				if topicArn != "" {
					in.SNSTopicArn = &topicArn
				}
				secret, err := readSecretInput(a, secretStdin, secretFile,
					"Paste the SES secret access key (input is hidden; Enter to keep the stored one): ")
				if err != nil {
					return err
				}
				in.SecretAccessKey = secret
			case "resend":
				if sesFlags {
					return fail.Usagef("SES flags have no effect with --provider resend")
				}
				key, err := readSecretInput(a, apiKeyStdin, apiKeyFile,
					"Paste the Resend API key (input is hidden; Enter to keep the stored one): ")
				if err != nil {
					return err
				}
				in.APIKey = key
				if webhookSecretFile != "" {
					whsec, err := readSecretFile(webhookSecretFile)
					if err != nil {
						return err
					}
					in.WebhookSecret = whsec
				}
			default:
				return fail.Usagef("--provider must be cloudflare, ses or resend")
			}
			s, err := a.Client.SetDomainSending(a.Ctx(c), args[0], in)
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: s, Summary: sendingSummary(s)})
		},
	}
	f := c.Flags()
	f.StringVar(&provider, "provider", "", "cloudflare, ses or resend (required)")
	f.StringVar(&region, "region", "", "SES region, e.g. eu-west-1")
	f.StringVar(&keyID, "access-key-id", "", "IAM access key ID (AKIA...)")
	f.BoolVar(&secretStdin, "secret-stdin", false, "read the SES secret access key from stdin")
	f.StringVar(&secretFile, "secret-file", "", "read the SES secret access key from this file")
	f.StringVar(&configSet, "configuration-set", "", "SES configuration set to send with")
	f.StringVar(&topicArn, "sns-topic-arn", "", "SNS topic ARN SES publishes events to")
	f.BoolVar(&apiKeyStdin, "api-key-stdin", false, "read the Resend API key from stdin")
	f.StringVar(&apiKeyFile, "api-key-file", "", "read the Resend API key from this file")
	f.StringVar(&webhookSecretFile, "webhook-secret-file", "", "read the Resend webhook signing secret (whsec_...) from this file")
	_ = c.MarkFlagRequired("provider")
	return c
}

// readSecretFile returns the first line of file, trimmed.
func readSecretFile(file string) (string, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", fail.Errf("cannot open the secret file: %v", err).Wrap(err)
	}
	defer f.Close()
	line, err := bufio.NewReader(io.LimitReader(f, 4096)).ReadString('\n')
	if err != nil && err != io.EOF {
		return "", fail.Errf("cannot read the secret file: %v", err).Wrap(err)
	}
	return strings.TrimSpace(line), nil
}

// readSecretInput returns a secret from stdin, a file, or a hidden prompt at a
// terminal; "" (keep the stored one) when none was offered.
func readSecretInput(a *App, fromStdin bool, file, prompt string) (string, error) {
	if fromStdin && file != "" {
		return "", fail.Usagef("reading the same secret from stdin and a file conflicts")
	}
	if file != "" {
		return readSecretFile(file)
	}
	if fromStdin || isStdinTerminal() {
		return readSecret(a, fromStdin, prompt)
	}
	return "", nil
}

func domainSendingTest(a *App) *cobra.Command {
	var send bool
	c := &cobra.Command{
		Use:   "test <id-or-hostname>",
		Short: "Check the stored SES or Resend settings with the provider",
		Long: strings.TrimSpace(`
SES: call GetAccount, GetEmailIdentity and GetConfigurationSet with the stored key,
one at a time. Reports sandbox status, quota, whether the domain is verified, DKIM
status, the DKIM and MAIL FROM records to publish, and provider-side tracking that
would double cloudmail's own.

Resend: read the domain's status, DNS records and tracking settings (a sending-only
key skips these).

--send also sends one message to the provider's test address
(success@simulator.amazonses.com or delivered@resend.dev). Without it nothing is sent.`),
		Args: cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			res, err := a.Client.TestDomainSending(a.Ctx(c), args[0], api.DomainSendingTestInput{SendTest: send})
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: res})
		},
	}
	c.Flags().BoolVar(&send, "send", false, "also send one message to the provider's test address")
	return c
}

func domainSendingReset(a *App) *cobra.Command {
	return &cobra.Command{
		Use:   "reset <id-or-hostname>",
		Short: "Send through Cloudflare again and delete the SES and Resend settings",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			if err := a.Confirm(fmt.Sprintf("delete the SES and Resend settings for %s", args[0]), true); err != nil {
				return err
			}
			s, err := a.Client.ResetDomainSending(a.Ctx(c), args[0])
			if err != nil {
				return err
			}
			return a.emitMutation(output.Result{Data: s, Summary: fmt.Sprintf("%s sends through Cloudflare", args[0])})
		},
	}
}

func sendingSummary(s *api.DomainSending) string {
	if s == nil {
		return ""
	}
	blocked := ""
	if s.BlockedReason != nil && *s.BlockedReason != "" {
		blocked = "; not switched yet: " + *s.BlockedReason
	}
	switch {
	case s.Provider == "ses" && s.SES != nil:
		region, last4 := "?", "?"
		if s.SES.Region != nil {
			region = *s.SES.Region
		}
		if s.SES.AccessKeyIDLast4 != nil {
			last4 = *s.SES.AccessKeyIDLast4
		}
		secret := "no secret stored"
		if s.SES.SecretStored {
			secret = "secret stored"
		}
		return fmt.Sprintf("%s sends through Amazon SES (%s, key ...%s, %s)", s.Domain, region, last4, secret)
	case s.Provider == "resend":
		last4 := "?"
		if s.Resend != nil && s.Resend.APIKeyLast4 != nil {
			last4 = *s.Resend.APIKeyLast4
		}
		return fmt.Sprintf("%s sends through Resend (key ...%s)", s.Domain, last4)
	default:
		return fmt.Sprintf("%s sends through Cloudflare%s", s.Domain, blocked)
	}
}
