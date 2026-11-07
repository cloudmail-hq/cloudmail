// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { index, layout, type RouteConfig, route } from "@react-router/dev/routes";

export default [
	/**
	 * Public auth pages. They render without a session (the Worker's SSR guard
	 * lets these paths through) and fetch nothing that needs one.
	 */
	route("login", "routes/login.tsx"),
	route("setup", "routes/setup.tsx"),
	route("invite/:token", "routes/invite.tsx"),
	route("reset/:token", "routes/reset.tsx"),
	route("recover", "routes/recover.tsx"),
	route("forgot", "routes/forgot.tsx"),

	/**
	 * Everything signed in renders inside the app shell (top bar, section links,
	 * phone tab bar, agent panel, palette), mounted once so it stays put while
	 * pages change. See routes/app-shell.tsx.
	 */
	layout("routes/app-shell.tsx", [
		// Mailbox chooser. Redirects into the workspace when there is only one
		// mailbox, which is the common case.
		index("routes/inboxes.tsx"),

		/**
		 * The mail workspace: folder rail, list, reading pane and composer.
		 *
		 * This is the only mail UI. The kumo-based `/mailbox/:id/*` screens that
		 * shipped with the upstream project have been removed, so a capability
		 * missing here is missing from the product.
		 */
		/**
		 * Unified inbox across every readable mailbox. A static segment, so it
		 * outranks `mail/:mailboxId` (a mailbox id always contains `@`, so "all"
		 * can never be one). Opening a message deep-links into the owning
		 * mailbox's reader with `?m=`.
		 */
		// The top bar's search off Mail: every readable mailbox. Before `:folder?`.
		route("mail/all/search", "routes/mail-all-search.tsx"),
		route("mail/all/:folder?", "routes/mail-all.tsx"),

		route("mail/:mailboxId", "routes/mail.tsx", [
			route("settings", "routes/mail-settings.tsx"),
			route("search", "routes/mail-search.tsx"),
			// Agent and MCP sends waiting for the user's approval.
			route("approvals", "routes/mail-approvals.tsx"),
			route("label/:labelId", "routes/mail-label.tsx"),
			// Sent mail with a follow-up reminder. Before `:folder`, which would match it.
			route("awaiting", "routes/mail-awaiting.tsx"),
			// First-time senders grouped by sender. Also before `:folder`.
			route("screener", "routes/mail-screener.tsx"),
			// Folder last: it matches any single segment, so the specific routes above
			// have to be declared first.
			route(":folder", "routes/mail-folder.tsx"),
		]),

		// Person-centric view of the same mail, across every mailbox.
		route("people", "routes/people.tsx"),

		// Templates
		route("templates", "routes/templates.tsx"),
		{ path: "templates/new", file: "routes/template-editor.tsx", id: "template-new" },
		{
			path: "templates/:slug/edit",
			file: "routes/template-editor.tsx",
			id: "template-edit",
		},

		// Sequences
		route("sequences", "routes/sequences.tsx"),
		{ path: "sequences/new", file: "routes/sequence-editor.tsx", id: "sequence-new" },
		route("sequences/:id", "routes/sequence-detail.tsx"),
		{
			path: "sequences/:id/edit",
			file: "routes/sequence-editor.tsx",
			id: "sequence-edit",
		},

		// Sent analytics: delivery + engagement across every accessible mailbox.
		// One tab per section (`/analytics/sending`, …); `/analytics` redirects.
		route("analytics/:section?", "routes/analytics.tsx"),

		// Admin
		// One page per section (`/settings/domains`, …); `/settings` redirects.
		route("settings/:section?", "routes/app-settings.tsx"),
		// Guided Cloudflare setup for administrators.
		route("onboarding", "routes/onboarding.tsx"),

		route("*", "routes/not-found.tsx"),
	]),
] satisfies RouteConfig;
