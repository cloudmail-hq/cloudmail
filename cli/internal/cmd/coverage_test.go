package cmd

import (
	"encoding/json"
	"os"
	"sort"
	"strings"
	"testing"
)

// The API's source of truth. Generated from workers/lib/openapi.ts; a test on the
// server side keeps it matching the real routes, and this one keeps the CLI
// matching it.
const openAPIPath = "../../../sdk/typescript/openapi.json"

// operationCommands maps every OpenAPI operationId the CLI reaches to the command
// that reaches it. A new route on the server fails
// TestEveryOperationIsMappedOrExcluded until it is added here or to
// operationExclusions.
var operationCommands = map[string]string{
	// Access and audit
	"listAccessGrants":  "access list",
	"putAccessGrant":    "access set",
	"deleteAccessGrant": "access revoke",
	"listInstanceAudit": "access log",
	"listMailboxAudit":  "mailbox audit",

	// Agent inboxes
	"createAgentInbox": "agent-inbox create",
	"listAgentInboxes": "agent-inbox list",
	"getAgentInbox":    "agent-inbox get",
	"deleteAgentInbox": "agent-inbox delete",
	"updateAgentInbox": "agent-inbox update",

	// AI
	"listAiProviders":          "ai provider list",
	"createAiProvider":         "ai provider add",
	"updateAiProvider":         "ai provider update",
	"deleteAiProvider":         "ai provider delete",
	"discoverAiProviderModels": "ai provider discover",
	"testAiProviderModel":      "ai provider test",
	"updateAiProviderModels":   "ai provider models",
	"getAiRouting":             "ai routing",
	"updateAiRouting":          "ai provider route",
	"listWorkersAiModels":      "ai models list",
	"testWorkersAiModel":       "ai workers-ai test",
	"updateWorkersAiRouting":   "ai route",
	"getAiSettings":            "ai settings show",
	"updateAiSettings":         "ai settings set",
	"getSemanticAvailability":  "ai semantic",
	"getAssistantPrefs":        "ai assistant show",
	"updateAssistantPrefs":     "ai assistant set",
	"getDailyBrief":            "ai brief show",
	"generateDailyBrief":       "ai brief generate",
	"dismissDailyBrief":        "ai brief dismiss",
	"getThreadSummary":         "thread summary",
	"generateThreadSummary":    "thread summary",
	"refreshThreadSummary":     "thread summary",

	// Analytics
	"getAnalytics":           "analytics summary",
	"getSentAnalytics":       "analytics sent",
	"getAnalyticsDmarc":      "analytics dmarc",
	"getAnalyticsEngagement": "analytics engagement",
	"getAnalyticsInbound":    "analytics inbound",
	"getAnalyticsOverview":   "analytics overview",

	// Approvals
	"listSendApprovals":   "approval list",
	"countSendApprovals":  "approval count",
	"getSendApproval":     "approval show",
	"editSendApproval":    "approval edit",
	"reviseSendApproval":  "approval revise",
	"approveSendApproval": "approval approve",
	"rejectSendApproval":  "approval reject",
	"retrySendApproval":   "approval retry",

	// Branding
	"getBranding":        "branding show",
	"updateBranding":     "branding set",
	"resetBranding":      "branding reset",
	"getBrandingLogo":    "branding logo get",
	"uploadBrandingLogo": "branding logo set",
	"deleteBrandingLogo": "branding logo delete",

	// Delegates
	"listMailboxDelegates":  "delegate list",
	"putMailboxDelegate":    "delegate set",
	"deleteMailboxDelegate": "delegate remove",

	// Domains and Cloudflare
	"listDomains":             "domain list",
	"getDomain":               "domain get",
	"createDomain":            "domain add",
	"updateDomain":            "domain update",
	"deleteDomain":            "domain delete",
	"verifyDomain":            "domain verify",
	"provisionDomain":         "domain provision",
	"listMailboxAliases":      "mailbox aliases",
	"setMailboxAliases":       "mailbox aliases set",
	"getCloudflareConnection": "cloudflare status",
	"discoverCloudflare":      "cloudflare discover",
	"planCloudflareSetup":     "cloudflare plan",
	"listCloudflareChanges":   "cloudflare changes",

	// Drafts and emails
	"saveDraft":          "draft create",
	"listEmails":         "mail list",
	"getEmail":           "mail get",
	"sendEmail":          "mail send",
	"replyToEmail":       "mail reply",
	"forwardEmail":       "mail forward",
	"updateEmail":        "mail read",
	"deleteEmail":        "mail delete",
	"restoreEmail":       "mail restore",
	"moveEmail":          "mail move",
	"markNotSpam":        "mail not-spam",
	"setEmailPriority":   "mail priority",
	"markAllRead":        "mail mark-all-read",
	"emptyTrash":         "mail empty-trash",
	"bulkEmailAction":    "mail bulk",
	"listDeliveryEvents": "mail delivery",
	"getAttachment":      "attachment get",

	// Events and export
	"streamEvents":  "events tail",
	"exportMailbox": "mailbox export",

	// Folders
	"listFolders":  "folder list",
	"createFolder": "folder create",
	"renameFolder": "folder rename",
	"deleteFolder": "folder delete",

	// Follow-ups
	"listFollowups":  "followup list",
	"getFollowup":    "followup get",
	"setFollowup":    "followup set",
	"cancelFollowup": "followup cancel",

	// Import
	"createImport":     "import mbox",
	"uploadImportPart": "import mbox",
	"completeImport":   "import mbox",
	"listImports":      "import status",
	"getImport":        "import status",
	"pauseImport":      "import pause",
	"resumeImport":     "import resume",
	"cancelImport":     "import cancel",

	// Labels and triage
	"listLabels":       "label list",
	"createLabel":      "label create",
	"updateLabel":      "label update",
	"deleteLabel":      "label delete",
	"listLabelEmails":  "label emails",
	"listEmailLabels":  "label of",
	"addEmailLabel":    "label apply",
	"removeEmailLabel": "label remove",
	"setEmailLabels":   "label set",
	"listLabelPrompts": "label prompt list",
	"setLabelPrompt":   "label prompt set",
	"setTriagePreset":  "label prompt preset",
	"backfillTriage":   "label prompt backfill",
	"listInboxTabs":    "mail tabs",

	// Licence
	"getLicence":     "licence status",
	"refreshLicence": "licence refresh",

	// Mailboxes, me and config
	"listMailboxes":   "mailbox list",
	"getMailbox":      "mailbox get",
	"createMailbox":   "mailbox create",
	"updateMailbox":   "mailbox settings",
	"deleteMailbox":   "mailbox delete",
	"getMailboxState": "mailbox watch",
	"getMe":           "auth whoami",
	"getConfig":       "auth deployment",

	// Migration
	"getMigrationStatus": "migrate status",
	"migrateMailbox":     "migrate run",

	// Notifications
	"listPushSubscriptions":  "notification devices",
	"deletePushSubscription": "notification remove",
	"getPushPreferences":     "notification prefs",
	"updatePushPreferences":  "notification set",
	"sendTestPush":           "notification test",

	// People
	"listPeople":       "people list",
	"listPersonEmails": "people mail",

	// Preferences
	"getPreferences":    "preferences show",
	"updatePreferences": "preferences set",

	// Privacy and the account
	"getPrivacySettings":     "privacy show",
	"updatePrivacySettings":  "privacy set",
	"getTrackingSettings":    "privacy tracking show",
	"updateTrackingSettings": "privacy tracking set",
	"getAccountDeletion":     "account deletion",
	"cancelAccountDeletion":  "account cancel-deletion",
	"listAccountExports":     "account export list",
	"downloadAccountExport":  "account export download",

	// Products
	"listProducts":            "product list",
	"getProduct":              "product get",
	"createProduct":           "product create",
	"updateProduct":           "product update",
	"deleteProduct":           "product delete",
	"putProductLogo":          "product logo set",
	"deleteProductLogo":       "product logo delete",
	"refreshProductKnowledge": "product refresh-knowledge",
	"resolveProduct":          "product resolve",
	"listUnifiedInbox":        "mail list",

	// Rules
	"listRules":    "rule list",
	"createRule":   "rule create",
	"updateRule":   "rule update",
	"deleteRule":   "rule delete",
	"reorderRules": "rule reorder",

	// Scheduled sends
	"listScheduledSends":  "schedule list",
	"scheduleSend":        "schedule create",
	"cancelScheduledSend": "schedule cancel",
	"sendScheduledNow":    "schedule send-now",

	// Screener and senders
	"listScreener":        "screener list",
	"screenSender":        "screener allow",
	"listAllowedSenders":  "sender list",
	"listBlockedSenders":  "sender list",
	"allowSender":         "sender add",
	"blockSender":         "sender add",
	"removeAllowedSender": "sender remove",
	"unblockSender":       "sender remove",

	// Search
	"askInbox":           "ask",
	"searchEmails":       "mail search",
	"searchAllMailboxes": "mail search",
	"getSemanticStatus":  "mailbox semantic",

	// Sending health
	"listSendingHealth":     "sending health",
	"evaluateSendingHealth": "sending evaluate",
	"pauseBulkSending":      "sending pause",
	"resumeBulkSending":     "sending resume",
	"getSendLimits":         "sending limits",
	"updateSendLimits":      "sending set-limits",

	// Sequences
	"listSequences":           "sequence list",
	"getSequence":             "sequence get",
	"createSequence":          "sequence create",
	"updateSequence":          "sequence update",
	"deleteSequence":          "sequence delete",
	"enrollInSequence":        "sequence enroll",
	"listSequenceEnrollments": "sequence enrollments",
	"getPersonEnrollment":     "sequence person",
	"cancelEnrollment":        "sequence unenroll",

	// Signatures
	"listSignatures":      "signature list",
	"getDefaultSignature": "signature default",
	"createSignature":     "signature create",
	"updateSignature":     "signature update",
	"deleteSignature":     "signature delete",

	// Snooze
	"listSnoozed":   "mail snoozed",
	"snoozeEmail":   "mail snooze",
	"unsnoozeEmail": "mail unsnooze",

	// Suppressions
	"listSuppressions":   "suppression list",
	"addSuppressions":    "suppression add",
	"deleteSuppression":  "suppression remove",
	"importSuppressions": "suppression import",
	"checkSuppressions":  "suppression check",
	"sendTemplate":       "template send",

	// Templates
	"listTemplates":  "template list",
	"getTemplate":    "template get",
	"createTemplate": "template create",
	"updateTemplate": "template update",
	"deleteTemplate": "template delete",

	// Threads
	"getThread":        "thread get",
	"markThreadRead":   "thread read",
	"muteThread":       "thread mute",
	"unmuteThread":     "thread unmute",
	"listMutedThreads": "thread muted",

	// Usage
	"getUsage":          "usage show",
	"updateUsageBudget": "usage budget",

	// Webhooks
	"listWebhooks":          "webhook list",
	"getWebhook":            "webhook get",
	"createWebhook":         "webhook create",
	"updateWebhook":         "webhook update",
	"deleteWebhook":         "webhook delete",
	"testWebhook":           "webhook test",
	"rotateWebhookSecret":   "webhook rotate-secret",
	"listWebhookDeliveries": "webhook deliveries",
	"retryWebhookDelivery":  "webhook retry",
	"listWebhookEvents":     "webhook events",
}

// operationExclusions are operations the CLI deliberately has no command for.
// Each is still reachable with `cloudmail api` where the server allows a token.
var operationExclusions = map[string]string{
	"getOpenApiDocument":         "the spec itself; fetch it with `cloudmail api GET /api/v1/openapi.json`",
	"streamEventsSse":            "Server-Sent Events alternative for browsers; `events tail` uses the WebSocket stream",
	"createPushSubscription":     "needs a browser PushSubscription (endpoint and keys) that only a service worker can create",
	"getPushVapidKey":            "only used by a browser subscribing to Web Push",
	"activateLicence":            "the server requires a signed-in browser session (session_required)",
	"deactivateLicence":          "the server requires a signed-in browser session (session_required)",
	"deleteAccount":              "the server requires a browser session re-confirmed by password or passkey in the last 15 minutes",
	"createAccountExport":        "the server requires a browser session re-confirmed by password or passkey in the last 15 minutes",
	"putCloudflareConnection":    "the server requires a browser session re-confirmed by password or passkey in the last 15 minutes",
	"deleteCloudflareConnection": "the server requires a browser session re-confirmed by password or passkey in the last 15 minutes",
	"verifyCloudflareConnection": "the server requires a browser session re-confirmed by password or passkey in the last 15 minutes",
	"applyCloudflareSetup":       "the server requires a browser session re-confirmed by password or passkey in the last 15 minutes",
	"revertCloudflareChange":     "the server requires a browser session re-confirmed by password or passkey in the last 15 minutes",
	"deleteFollowup":             "REST alias of cancelFollowup, which `followup cancel` calls",
	"replaceWebhookFields":       "PUT alias of updateWebhook (PATCH), which `webhook update` calls",
}

func loadOperationIDs(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile(openAPIPath)
	if err != nil {
		t.Fatalf("read %s: %v", openAPIPath, err)
	}
	var doc struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", openAPIPath, err)
	}
	var ids []string
	for p, ops := range doc.Paths {
		for method, op := range ops {
			switch method {
			case "get", "post", "put", "patch", "delete":
			default:
				continue
			}
			var o struct {
				OperationID string `json:"operationId"`
			}
			if err := json.Unmarshal(op, &o); err != nil || o.OperationID == "" {
				t.Fatalf("%s %s has no operationId", strings.ToUpper(method), p)
			}
			ids = append(ids, o.OperationID)
		}
	}
	sort.Strings(ids)
	return ids
}

func TestEveryOperationIsMappedOrExcluded(t *testing.T) {
	ids := loadOperationIDs(t)
	root, _ := NewRootCommand()
	inSpec := map[string]bool{}

	for _, id := range ids {
		inSpec[id] = true
		cmdPath, mapped := operationCommands[id]
		reason, excluded := operationExclusions[id]
		switch {
		case mapped && excluded:
			t.Errorf("%s is both mapped to %q and excluded", id, cmdPath)
		case excluded:
			if strings.TrimSpace(reason) == "" || strings.Contains(reason, "\n") {
				t.Errorf("exclusion of %s needs a one-line reason", id)
			}
		case mapped:
			c, _, err := root.Find(strings.Fields(cmdPath))
			if err != nil || c.CommandPath() != "cloudmail "+cmdPath {
				t.Errorf("%s maps to %q, which is not a command", id, cmdPath)
			}
		default:
			t.Errorf("operation %s has no CLI command: add one and map it in operationCommands, "+
				"or list it in operationExclusions with a reason", id)
		}
	}

	// Entries for operations the server no longer has are stale, and stale
	// entries hide real drift.
	for id := range operationCommands {
		if !inSpec[id] {
			t.Errorf("operationCommands lists %s, which is not in the OpenAPI document", id)
		}
	}
	for id := range operationExclusions {
		if !inSpec[id] {
			t.Errorf("operationExclusions lists %s, which is not in the OpenAPI document", id)
		}
	}
}
