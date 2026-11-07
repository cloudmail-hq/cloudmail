// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Centralised query key factories for cache invalidation. */
export const queryKeys = {
	suppressions: {
		all: ["suppressions"] as const,
		list: (params: Record<string, string | number>) => ["suppressions", "list", params] as const,
		check: (addresses: string[], from: string) =>
			["suppressions", "check", from, ...addresses] as const,
	},
	mailboxes: {
		all: ["mailboxes"] as const,
		detail: (id: string) => ["mailboxes", id] as const,
		withSettings: ["mailboxes", "with-settings"] as const,
		aliases: (id: string) => ["mailboxes", id, "aliases"] as const,
	},
	domains: {
		all: ["domains"] as const,
		detail: (id: string) => ["domains", id] as const,
	},
	emails: {
		list: (mailboxId: string, params: Record<string, string>) =>
			["emails", mailboxId, params] as const,
		detail: (mailboxId: string, emailId: string) =>
			["emails", mailboxId, emailId] as const,
		deliveryEvents: (mailboxId: string, emailId: string) =>
			["emails", mailboxId, emailId, "delivery-events"] as const,
		/**
		 * `folder` is part of the key because the answer depends on it: a Trash view
		 * shows only the conversation's trashed messages, every other view shows
		 * everything except Trash and Spam.
		 */
		thread: (mailboxId: string, threadId: string, folder?: string) =>
			["emails", mailboxId, "thread", threadId, folder ?? null] as const,
	},
	folders: {
		list: (mailboxId: string) => ["folders", mailboxId] as const,
	},
	labels: {
		list: (mailboxId: string) => ["labels", mailboxId] as const,
		emails: (mailboxId: string, labelId: string, params: Record<string, string>) =>
			["labels", mailboxId, labelId, "emails", params] as const,
		forEmail: (mailboxId: string, emailId: string) =>
			["labels", mailboxId, "email", emailId] as const,
	},
	signatures: {
		list: (mailboxId: string) => ["signatures", mailboxId] as const,
	},
	snoozed: {
		list: (mailboxId: string) => ["snoozed", mailboxId] as const,
	},
	scheduledSends: {
		list: (mailboxId: string) => ["scheduled-sends", mailboxId] as const,
	},
	/**
	 * Under `emails` on purpose: the live-update poll invalidates that prefix
	 * whenever mail moves, which is exactly when tabs and the Screener change.
	 */
	triage: {
		all: (mailboxId: string) => ["emails", mailboxId, "triage"] as const,
		prompts: (mailboxId: string) => ["emails", mailboxId, "triage", "prompts"] as const,
		tabs: (mailboxId: string) => ["emails", mailboxId, "triage", "tabs"] as const,
		screener: (mailboxId: string) => ["emails", mailboxId, "triage", "screener"] as const,
	},
	followups: {
		all: (mailboxId: string) => ["followups", mailboxId] as const,
		list: (mailboxId: string) => ["followups", mailboxId, "list"] as const,
		forEmail: (mailboxId: string, emailId: string) =>
			["followups", mailboxId, "email", emailId] as const,
	},
	blockedSenders: {
		list: (mailboxId: string) => ["blocked-senders", mailboxId] as const,
	},
	allowedSenders: {
		list: (mailboxId: string) => ["allowed-senders", mailboxId] as const,
	},
	rules: {
		list: (mailboxId: string) => ["rules", mailboxId] as const,
	},
	mutedThreads: {
		list: (mailboxId: string) => ["muted-threads", mailboxId] as const,
	},
	search: {
		/** Every search result set for a mailbox, for invalidating on retry. */
		all: (mailboxId: string) => ["search", mailboxId] as const,
		results: (mailboxId: string, query: string, page: number) =>
			["search", mailboxId, query, page] as const,
	},
	people: {
		list: (query: Record<string, unknown>) => ["people", query] as const,
		emails: (personEmail: string) => ["people", personEmail, "emails"] as const,
	},
	/**
	 * Analytics console sections. `source` is "live" or a fixture scenario, so
	 * switching between them in local development never mixes caches.
	 */
	analytics: {
		all: ["analytics"] as const,
		section: (section: string, params: Record<string, string | number>) =>
			["analytics", section, params] as const,
	},
	currentUser: ["me"] as const,
	config: ["config"] as const,
	branding: ["branding"] as const,
	accessGrants: ["access", "users"] as const,
	/** The deployment-wide access log: grants and mailbox lifecycle. */
	accessAudit: ["access", "audit"] as const,
	/** One mailbox's own log, keyed separately so it invalidates on its own. */
	mailboxAudit: (mailboxId: string) => ["access", "audit", mailboxId] as const,
	approvals: {
		all: (mailboxId: string) => ["approvals", mailboxId] as const,
		list: (mailboxId: string, status: string) => ["approvals", mailboxId, "list", status] as const,
		count: (mailboxId: string) => ["approvals", mailboxId, "count"] as const,
	},
	/** Who else can use one mailbox, as its owner sees it. */
	mailboxDelegates: (mailboxId: string) =>
		["access", "delegates", mailboxId] as const,
	preferences: ["preferences"] as const,
	/** Built-in auth (`/api/auth/*`). */
	auth: {
		state: ["auth", "state"] as const,
		sessions: ["auth", "sessions"] as const,
		tokens: ["auth", "tokens"] as const,
		oauthGrants: ["auth", "oauth-grants"] as const,
		users: ["auth", "admin", "users"] as const,
		invites: ["auth", "admin", "invites"] as const,
		passkeys: ["auth", "passkeys"] as const,
	},
};
