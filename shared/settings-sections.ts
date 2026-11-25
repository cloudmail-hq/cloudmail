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
	| "groups"
	| "access-log"
	| "webhooks"
	| "agent-inboxes"
	| "branding"
	| "sending"
	| "suppressions"
	| "privacy"
	| "status";

/**
 * Headings for the settings nav. Nineteen sections in one flat list put
 * personal preferences beside deployment administration; grouped, a member
 * sees "You" and an administrator can find the workspace pages.
 */
export type SettingsGroup = "You" | "Workspace" | "Sending" | "AI & developers";

export interface SettingsSectionMeta {
	id: SettingsSectionId;
	group: SettingsGroup;
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
	{ id: "account", group: "You", label: "Account & security", save: "form" },
	{ id: "preferences", group: "You", label: "Appearance & display", save: "autosave" },
	{ id: "notifications", group: "You", label: "Notifications", save: "autosave" },
	{ id: "auto-draft", group: "You", label: "Automatic draft replies", save: "autosave" },
	{ id: "assistant", group: "You", label: "AI assistant", save: "autosave" },
	{ id: "users", group: "Workspace", label: "Users & invites", save: "form" },
	{ id: "access", group: "Workspace", label: "Mailbox access", save: "form" },
	{ id: "groups", group: "Workspace", label: "Groups", save: "form" },
	{ id: "access-log", group: "Workspace", label: "Access log", save: "autosave" },
	{ id: "domains", group: "Workspace", label: "Domains", save: "autosave" },
	{ id: "cloudflare", group: "Workspace", label: "Cloudflare connection", save: "form" },
	{ id: "branding", group: "Workspace", label: "App branding", save: "form" },
	{ id: "licence", group: "Workspace", label: "Licence", save: "form" },
	{ id: "privacy", group: "Workspace", label: "Privacy & retention", save: "form" },
	{ id: "status", group: "Workspace", label: "System status", save: "autosave" },
	{ id: "sending", group: "Sending", label: "Sending & notifications", save: "autosave" },
	{ id: "suppressions", group: "Sending", label: "Suppressions", save: "form" },
	{ id: "products", group: "Sending", label: "Products", save: "form" },
	{ id: "ai-providers", group: "AI & developers", label: "AI providers", save: "form" },
	{ id: "agent-inboxes", group: "AI & developers", label: "Agent inboxes", save: "form" },
	{ id: "webhooks", group: "AI & developers", label: "Webhooks", save: "form" },
];

const ADMIN_ONLY = new Set<SettingsSectionId>([
	"users",
	"domains",
	"cloudflare",
	"licence",
	"products",
	"access",
	"groups",
	"access-log",
	"branding",
	"sending",
	"suppressions",
	"privacy",
	"status",
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
