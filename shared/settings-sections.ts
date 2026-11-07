// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Which app settings sections a user sees, and how old `/settings#hash`
 * links map onto the routed `/settings/<section>` pages.
 */

export type SettingsSectionId =
	| "account"
	| "preferences"
	| "notifications"
	| "auto-draft"
	| "assistant"
	| "ai-providers"
	| "users"
	| "domains"
	| "cloudflare"
	| "licence"
	| "products"
	| "access"
	| "access-log"
	| "webhooks"
	| "agent-inboxes"
	| "branding"
	| "sending"
	| "suppressions"
	| "privacy";

export interface SettingsSectionMeta {
	id: SettingsSectionId;
	/** Nav label. Matches the page heading. */
	label: string;
	/**
	 * How the page saves. Each page has exactly one: "autosave" pages save
	 * every change as it is made and show a "Saved" status; "form" pages hold
	 * edits until an explicit Save, because their input needs validation.
	 */
	save: "autosave" | "form";
}

export interface SettingsViewer {
	isAdmin: boolean;
	passwordMode: boolean;
	/** Non-admins who manage at least one mailbox see their webhooks. */
	managesSomeMailbox: boolean;
}

const ALL: SettingsSectionMeta[] = [
	{ id: "account", label: "Account & security", save: "form" },
	{ id: "preferences", label: "Appearance & display", save: "autosave" },
	{ id: "notifications", label: "Notifications", save: "autosave" },
	{ id: "auto-draft", label: "Automatic draft replies", save: "autosave" },
	{ id: "assistant", label: "AI assistant", save: "autosave" },
	{ id: "ai-providers", label: "AI providers", save: "form" },
	{ id: "users", label: "Users & invites", save: "form" },
	{ id: "domains", label: "Domains", save: "autosave" },
	{ id: "cloudflare", label: "Cloudflare connection", save: "form" },
	{ id: "licence", label: "Licence", save: "form" },
	{ id: "products", label: "Products", save: "form" },
	{ id: "access", label: "Mailbox access", save: "form" },
	{ id: "access-log", label: "Access log", save: "autosave" },
	{ id: "webhooks", label: "Webhooks", save: "form" },
	{ id: "agent-inboxes", label: "Agent inboxes", save: "form" },
	{ id: "branding", label: "App branding", save: "form" },
	{ id: "sending", label: "Sending & notifications", save: "autosave" },
	{ id: "suppressions", label: "Suppressions", save: "form" },
	{ id: "privacy", label: "Privacy & retention", save: "form" },
];

const ADMIN_ONLY = new Set<SettingsSectionId>([
	"users",
	"domains",
	"cloudflare",
	"licence",
	"products",
	"access",
	"access-log",
	"branding",
	"sending",
	"suppressions",
	"privacy",
	"agent-inboxes",
	"ai-providers",
]);

export function visibleSections(viewer: SettingsViewer): SettingsSectionMeta[] {
	return ALL.filter((s) => {
		if (s.id === "account") return viewer.passwordMode;
		if (s.id === "users") return viewer.isAdmin && viewer.passwordMode;
		if (s.id === "webhooks") return viewer.isAdmin || viewer.managesSomeMailbox;
		if (ADMIN_ONLY.has(s.id)) return viewer.isAdmin;
		return true;
	});
}

/** Old single-page anchors that were renamed or merged. */
const LEGACY_HASH: Record<string, SettingsSectionId> = {
	appearance: "preferences",
	display: "preferences",
	notifications: "sending",
};

export function isSectionId(value: string): value is SettingsSectionId {
	return ALL.some((s) => s.id === value);
}

/** The section a `#hash` from the old single page points at, if any. */
export function sectionForLegacyHash(hash: string): SettingsSectionId | null {
	const id = hash.replace(/^#/, "").trim().toLowerCase();
	if (!id) return null;
	if (id in LEGACY_HASH) return LEGACY_HASH[id];
	return isSectionId(id) ? id : null;
}

/**
 * Resolve the requested section against what the viewer can see: an unknown
 * or hidden section falls back to the first visible one.
 */
export function resolveSection(
	requested: string | undefined,
	visible: readonly SettingsSectionMeta[],
): SettingsSectionMeta | undefined {
	return visible.find((s) => s.id === requested) ?? visible[0];
}
