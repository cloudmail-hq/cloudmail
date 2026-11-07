/**
 * The command palette's model, as pure functions.
 *
 * `buildPaletteItems` turns what the app knows (mailboxes, folders, labels,
 * people, templates, the selection) into a flat list of items, and
 * `rankPaletteItems` orders them for a query. The React side in
 * `CommandPalette.tsx` only renders the result and runs the chosen item.
 *
 * Mail actions come straight from `SHORTCUT_COMMANDS` and are kept or dropped
 * by asking `resolveSequence` what the shortcut would do right now. So an
 * action that needs a message only appears when the keystroke would act on
 * one, and the palette can never offer something the keyboard refuses.
 */

import { FOLDER_DISPLAY_NAMES, Folders, SYSTEM_FOLDER_IDS } from "../../shared/folders";
import {
	visibleSections,
	type SettingsSectionId,
	type SettingsViewer,
} from "../../shared/settings-sections";
import { visibleAnalyticsSections, type AnalyticsSectionId } from "../../shared/analytics-sections";
import { fuzzyFilter } from "~/lib/fuzzy";
import {
	SHORTCUT_COMMANDS,
	gotoSequence,
	resolveSequence,
	type ShortcutAction,
	type ShortcutContext,
} from "~/lib/shortcuts";

export type PaletteMode = "all" | "templates";

export type PaletteSection =
	| "Recent"
	| "Actions"
	| "Search"
	| "Go to"
	| "Mailboxes"
	| "People"
	| "Templates"
	| "Settings"
	| "Recent threads";

/** What running an item does. The component maps each kind to an effect. */
export type PaletteRun =
	| { kind: "shortcut"; action: ShortcutAction }
	| { kind: "navigate"; to: string }
	| { kind: "search"; query: string }
	| { kind: "insert-template"; slug: string }
	| { kind: "open-thread"; mailboxId: string; id: string }
	| { kind: "templates-mode" };

export interface PaletteItem {
	/** Stable across renders and sessions; drives "recently used". */
	id: string;
	section: PaletteSection;
	title: string;
	subtitle?: string;
	keywords?: readonly string[];
	/** Shortcut keys to show, e.g. `["g", "i"]`. */
	shortcut?: readonly string[];
	run: PaletteRun;
}

/**
 * Extra words for each settings page, so "dkim" finds Domains and "2fa" finds
 * Account. Which pages exist and who sees them comes from
 * `shared/settings-sections`, the same list the settings route renders.
 */
const SETTINGS_KEYWORDS: Partial<Record<SettingsSectionId, readonly string[]>> = {
	account: ["password", "2fa", "passkey", "profile", "sessions"],
	preferences: ["theme", "dark", "light", "appearance", "density", "reading pane"],
	"auto-draft": ["ai", "auto draft"],
	users: ["invite", "accounts"],
	domains: ["dns", "dkim", "spf", "dmarc", "zone", "catch-all"],
	cloudflare: ["api token", "cf_api_token", "connect", "account"],
	products: ["brand", "signature", "tone", "knowledge", "identity", "saas"],
	access: ["permissions", "grants"],
	"access-log": ["audit"],
	webhooks: ["events", "http", "callbacks"],
	branding: ["logo", "name", "colour", "color"],
	sending: ["undo send", "desktop alerts", "sound"],
	notifications: ["push", "phone", "mobile", "quiet hours", "vip", "alerts"],
	suppressions: ["bounces", "unsubscribe", "blocklist"],
};

/** Extra words for each analytics tab (`shared/analytics-sections`). */
const ANALYTICS_KEYWORDS: Partial<Record<AnalyticsSectionId, readonly string[]>> = {
	sending: ["volume", "delivery", "bounces", "errors", "quota", "senders", "domains", "reputation"],
	engagement: ["opens", "clicks", "links", "tracking"],
	inbound: ["received", "routing", "spf", "dkim", "catch-all", "spam"],
	dmarc: ["reports", "alignment", "spoofing"],
	suppressions: ["bounced", "complaints", "blocklist"],
	usage: ["cost", "billing", "budget", "neurons", "workers ai", "storage", "quota"],
};

export interface PaletteSource {
	/** The mailbox in the URL, if any. */
	mailboxId?: string;
	/**
	 * The same snapshot the keyboard hook hands `resolveShortcut`. Null off the
	 * mail workspace, where no mail action can run.
	 */
	shortcutContext: ShortcutContext | null;
	mailboxes: readonly { id: string; email: string; name?: string }[];
	/** Custom folders of the current mailbox. */
	folders: readonly { id: string; name: string }[];
	labels: readonly { id: string; name: string }[];
	people: readonly { email: string; name: string | null }[];
	templates: readonly { slug: string; name: string; subject?: string }[];
	recentThreads: readonly { mailboxId: string; id: string; subject: string; sender: string }[];
	/** True while a composer is open and can take a template. */
	canInsertTemplate: boolean;
	/** Who is looking, for which settings pages exist. */
	viewer: SettingsViewer;
	/** The palette's current text, for the "Search mail for …" row. */
	query: string;
}

const enc = encodeURIComponent;

/**
 * Order of actions in the idle list. Acting on the open message first, then
 * writing, then the list-wide helpers. Anything not named keeps registry order
 * after these.
 */
const ACTION_ORDER = [
	"reply", "reply-all", "forward", "archive", "trash", "snooze", "mark-unread",
	"mark-read", "star", "label", "move", "mute", "spam", "important",
	"not-important", "compose", "undo", "back-to-list", "more",
];

function actionRank(id: string): number {
	const at = ACTION_ORDER.indexOf(id);
	return at === -1 ? ACTION_ORDER.length : at;
}

function mailActions(source: PaletteSource): PaletteItem[] {
	const ctx = source.shortcutContext;
	const items: PaletteItem[] = [];
	const ordered = [...SHORTCUT_COMMANDS].sort((a, b) => actionRank(a.id) - actionRank(b.id));
	for (const command of ordered) {
		if (command.palette !== "action") continue;
		if (command.id === "compose") {
			// Compose works from any page: the People view has its own composer,
			// and elsewhere the palette routes into the mailbox first.
			items.push({
				id: `cmd:${command.id}`,
				section: "Actions",
				title: command.title,
				keywords: command.keywords,
				shortcut: command.sequence,
				run: { kind: "shortcut", action: { type: "compose" } },
			});
			continue;
		}
		if (!ctx) continue;
		// The palette is a dialog over the workspace. Ask what the key would do
		// with the dialog closed, which is the moment the action actually runs.
		const action = resolveSequence(command.sequence, {
			...ctx,
			isHelpOpen: false,
			prefix: null,
		});
		if (action.type === "none") continue;
		items.push({
			id: `cmd:${command.id}`,
			section: "Actions",
			title: command.title,
			keywords: command.keywords,
			shortcut: command.sequence,
			run: { kind: "shortcut", action },
		});
	}
	return items;
}

function navigation(source: PaletteSource): PaletteItem[] {
	const items: PaletteItem[] = [];
	const { mailboxId } = source;
	if (mailboxId) {
		const base = `/mail/${enc(mailboxId)}`;
		for (const id of [...SYSTEM_FOLDER_IDS, Folders.SPAM]) {
			items.push({
				id: `go:folder:${id}`,
				section: "Go to",
				title: FOLDER_DISPLAY_NAMES[id] ?? id,
				subtitle: "Folder",
				keywords: ["folder", "go"],
				shortcut: gotoSequence(id) ?? undefined,
				run: { kind: "navigate", to: `${base}/${id}` },
			});
		}
		// First-time senders waiting for Yes or No. Its own route, same path shape.
		items.push({
			id: `go:folder:${Folders.SCREENER}`,
			section: "Go to",
			title: "Screener",
			subtitle: "First-time senders",
			keywords: ["screen", "new senders", "gatekeeper", "approve", "unknown"],
			shortcut: gotoSequence(Folders.SCREENER) ?? undefined,
			run: { kind: "navigate", to: `${base}/screener` },
		});
		items.push({
			id: "go:mailbox-settings:triage",
			section: "Settings",
			title: "AI labels and Screener",
			subtitle: "Mailbox settings",
			keywords: ["triage", "auto label", "split inbox", "tabs", "presets", "newsletters", "screener", "ai"],
			run: { kind: "navigate", to: `${base}/settings#triage` },
		});
		for (const folder of source.folders) {
			if ((SYSTEM_FOLDER_IDS as readonly string[]).includes(folder.id)) continue;
			if (folder.id === Folders.SPAM || folder.id === Folders.SCREENER) continue;
			items.push({
				id: `go:folder:${folder.id}`,
				section: "Go to",
				title: folder.name,
				subtitle: "Folder",
				keywords: ["folder"],
				run: { kind: "navigate", to: `${base}/${enc(folder.id)}` },
			});
		}
		for (const label of source.labels) {
			items.push({
				id: `go:label:${label.id}`,
				section: "Go to",
				title: label.name,
				subtitle: "Label",
				keywords: ["label", "tag"],
				run: { kind: "navigate", to: `${base}/label/${enc(label.id)}` },
			});
		}
		items.push({
			id: "go:mailbox-settings",
			section: "Settings",
			title: "Mailbox settings",
			subtitle: mailboxId,
			keywords: ["signature", "auto reply", "vacation", "rules", "filters", "aliases", "delegates"],
			run: { kind: "navigate", to: `${base}/settings` },
		});
	}

	const pages: [string, string, string, string[]][] = [
		["all-inboxes", "All inboxes", "/mail/all/inbox", ["unified", "every mailbox", "products", "combined"]],
		["people", "People", "/people", ["contacts", "correspondents"]],
		["templates", "Templates", "/templates", ["snippets", "canned"]],
		["sequences", "Sequences", "/sequences", ["drip", "campaign", "follow up"]],
		["analytics", "Analytics", "/analytics", ["stats", "delivery", "opens"]],
		["mailboxes", "All mailboxes", "/", ["accounts", "inboxes"]],
	];
	for (const [id, title, to, keywords] of pages) {
		items.push({ id: `go:page:${id}`, section: "Go to", title, keywords, run: { kind: "navigate", to } });
	}
	// One entry per analytics tab, from the same list that drives its side nav.
	for (const section of visibleAnalyticsSections(source.viewer)) {
		if (section.id === "overview") continue; // "Analytics" above lands there.
		items.push({
			id: `go:analytics:${section.id}`,
			section: "Go to",
			title: section.label,
			subtitle: "Analytics",
			keywords: ["analytics", "stats", ...(ANALYTICS_KEYWORDS[section.id] ?? [])],
			run: { kind: "navigate", to: `/analytics/${section.id}` },
		});
	}
	items.push({
		id: "go:settings",
		section: "Settings",
		title: "Settings",
		keywords: ["preferences", "admin"],
		run: { kind: "navigate", to: "/settings" },
	});
	for (const section of visibleSections(source.viewer)) {
		items.push({
			id: `go:settings:${section.id}`,
			section: "Settings",
			title: section.label,
			subtitle: "Settings",
			keywords: ["settings", ...(SETTINGS_KEYWORDS[section.id] ?? [])],
			run: { kind: "navigate", to: `/settings/${section.id}` },
		});
		// API tokens are a panel inside Account, and the thing people look for.
		if (section.id === "account") {
			items.push({
				id: "go:settings:api-tokens",
				section: "Settings",
				title: "API tokens",
				subtitle: "Settings · Account & security",
				keywords: ["settings", "tokens", "keys", "ttk", "api", "mcp"],
				run: { kind: "navigate", to: "/settings/account#api-tokens" },
			});
		}
	}
	return items;
}

/** Every item the palette can show, before ranking. */
export function buildPaletteItems(source: PaletteSource): PaletteItem[] {
	const items: PaletteItem[] = [...mailActions(source)];

	if (source.canInsertTemplate && source.templates.length > 0) {
		items.push({
			id: "cmd:insert-template",
			section: "Actions",
			title: "Insert template…",
			keywords: ["snippet", "canned", "template"],
			shortcut: [";"],
			run: { kind: "templates-mode" },
		});
	}

	// The same scope as the top bar's search: this mailbox, or every inbox.
	const query = source.query.trim();
	if (query) {
		items.push({
			id: "search",
			section: "Search",
			title: source.mailboxId ? `Search mail for “${query}”` : `Search all inboxes for “${query}”`,
			run: { kind: "search", query },
		});
	}

	items.push(...navigation(source));

	for (const mailbox of source.mailboxes) {
		if (mailbox.id === source.mailboxId) continue;
		items.push({
			id: `mailbox:${mailbox.id}`,
			section: "Mailboxes",
			title: mailbox.name && mailbox.name !== mailbox.email ? mailbox.name : mailbox.email,
			subtitle: mailbox.email,
			keywords: ["switch", "mailbox", "account"],
			run: { kind: "navigate", to: `/mail/${enc(mailbox.id)}/inbox` },
		});
	}

	for (const person of source.people) {
		items.push({
			id: `person:${person.email.toLowerCase()}`,
			section: "People",
			title: person.name || person.email,
			subtitle: person.name ? person.email : undefined,
			run: { kind: "navigate", to: `/people?person=${enc(person.email)}` },
		});
	}

	for (const thread of source.recentThreads) {
		items.push({
			id: `thread:${thread.mailboxId}:${thread.id}`,
			section: "Recent threads",
			title: thread.subject || "(no subject)",
			subtitle: thread.sender,
			run: { kind: "open-thread", mailboxId: thread.mailboxId, id: thread.id },
		});
	}

	return items;
}

/** Template rows for the palette's "Insert template…" mode. */
export function templateItems(
	templates: readonly { slug: string; name: string; subject?: string }[],
): PaletteItem[] {
	return templates.map((template) => ({
		id: `template:${template.slug}`,
		section: "Templates",
		title: template.name,
		subtitle: `;${template.slug}`,
		keywords: template.subject ? [template.subject] : [],
		run: { kind: "insert-template", slug: template.slug },
	}));
}

/** With an empty query, how many of each long section to show. */
const IDLE_LIMITS: Partial<Record<PaletteSection, number>> = {
	Actions: 12,
	"Go to": 12,
	Settings: 4,
	Mailboxes: 5,
	People: 0,
	"Recent threads": 5,
};

/** Above any fuzzy score difference within one tier, below a tier jump. */
const RECENT_BOOST = 60;
/** Actions edge out navigation for the same match quality. */
const SECTION_BOOST: Partial<Record<PaletteSection, number>> = {
	Search: -1000,
	Actions: 20,
	"Go to": 10,
};

/**
 * Order items for display.
 *
 * Empty query: recently used commands first (in their own "Recent" section),
 * then everything else in section order, long sections trimmed.
 *
 * With a query: one list by match quality, with a boost for recent use and
 * for actions over destinations. "Search mail for …" always goes last, as the
 * fallback when nothing above is what was meant.
 */
export function rankPaletteItems(
	items: readonly PaletteItem[],
	query: string,
	recentIds: readonly string[],
	limit = 50,
): PaletteItem[] {
	const recentRank = new Map(recentIds.map((id, index) => [id, index]));
	const trimmed = query.trim();

	if (!trimmed) {
		const recent = recentIds
			.map((id) => items.find((item) => item.id === id))
			.filter((item): item is PaletteItem => !!item)
			.map((item) => ({ ...item, section: "Recent" as const }));
		const recentSet = new Set(recent.map((item) => item.id));
		const counts = new Map<PaletteSection, number>();
		const rest = items.filter((item) => {
			if (recentSet.has(item.id)) return false;
			const cap = IDLE_LIMITS[item.section];
			if (cap === undefined) return true;
			const seen = counts.get(item.section) ?? 0;
			counts.set(item.section, seen + 1);
			return seen < cap;
		});
		return [...recent, ...rest].slice(0, limit);
	}

	const search = items.filter((item) => item.run.kind === "search");
	const ranked = fuzzyFilter(
		items.filter((item) => item.run.kind !== "search"),
		trimmed,
		(item) => ({ title: item.title, subtitle: item.subtitle, keywords: item.keywords }),
		(item) => {
			const rank = recentRank.get(item.id);
			const recency = rank === undefined ? 0 : RECENT_BOOST - rank * 4;
			return recency + (SECTION_BOOST[item.section] ?? 0);
		},
	);
	return [...ranked.slice(0, limit - search.length), ...search];
}

/**
 * Whether a keydown should open the palette.
 *
 * ⌘K / Ctrl+K from anywhere, including text fields (it's what people expect
 * from every other app, and no field here uses the chord). `/` only when the
 * user isn't typing, and never with a modifier.
 */
export function isPaletteShortcut(event: {
	key: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	typing?: boolean;
	defaultPrevented?: boolean;
}): boolean {
	if (event.defaultPrevented) return false;
	const key = event.key.toLowerCase();
	if (key === "k" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
		return true;
	}
	if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
		return !event.typing;
	}
	return false;
}
