// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * What a principal may *do* inside a mailbox they can reach.
 *
 * ## What this adds
 *
 * `workers/lib/authz.ts` decides *which* mailboxes a caller may touch. Until now
 * that was the whole answer: reaching a mailbox meant total authority over it, so
 * granting someone the shared `support@` inbox also handed them the power to
 * rewrite its forwarding address — redirecting every message it receives to an
 * address they control — and to purge its Trash. For a personal mailbox that is
 * fine, because the grantee is the owner. For a shared one it is the whole
 * problem: a support agent needs to answer mail, not to reconfigure where the
 * mail goes.
 *
 * ## Vocabulary borrowed deliberately
 *
 * The names match the two products operators already know, so a grant means what
 * they expect it to mean:
 *
 * - Exchange splits mailbox access into `FullAccess` (open it, read and change
 *   contents, but explicitly *not* send), `Send As` (mail leaves with "no
 *   indication that the message was sent by the delegate") and `Send on Behalf`
 *   (`<delegate> on behalf of <mailbox>`). Where a delegate holds both, Send As
 *   wins.
 *   https://learn.microsoft.com/en-us/exchange/recipients/mailbox-permissions
 * - Gmail delegation grants "read, send, and delete emails in your account",
 *   shows the delegate's own address on delegated sends, and withholds account
 *   settings from the delegate entirely.
 *   https://support.google.com/mail/answer/138350
 *
 * ## Two layers, kept apart
 *
 * Capabilities are orthogonal and independently grantable; enforcement code only
 * ever asks about a capability, never about a role. Roles are named bundles of
 * capabilities and exist so the UI can offer one choice instead of nine
 * checkboxes. A grant stores its role rather than the expanded list, so widening
 * a preset later widens the grants that use it.
 *
 * ## Why the default is full access
 *
 * This ships into deployments whose grants predate it, where an entry in
 * `mailboxes` already means unrestricted access. Reading such an entry as
 * anything narrower would silently revoke authority people are relying on — an
 * agent who could reply yesterday would start getting 403s with nothing in the
 * UI to explain it. So a bare address parses as {@link FULL_ACCESS_ROLE}, and
 * narrowing is something an operator opts into per mailbox.
 */

/**
 * The discrete things a grant can permit.
 *
 * `delete` and `deletePermanently` are separate because Trash is recoverable and
 * emptying it is not: a support agent should be able to bin a message without
 * being able to destroy the record of it. `sendAs` and `sendOnBehalf` are
 * separate because they differ in attribution rather than in power, and choosing
 * between them is a statement about what the recipient sees.
 */
export const MAILBOX_CAPABILITIES = [
	/** Open the mailbox: list, read, search, view attachments, export. */
	"read",
	/** Send with the mailbox as sole author. Leaves no trace of the sender. */
	"sendAs",
	/** Send attributed as `<principal> on behalf of <mailbox>`. */
	"sendOnBehalf",
	/** Move to Trash, and restore from it. Recoverable. */
	"delete",
	/** Destroy irrecoverably: permanent delete, empty Trash. */
	"deletePermanently",
	/**
	 * Organise mail: folders and labels, applying them, moving messages, and
	 * per-message state — read/starred, snooze, mute, priority. One capability
	 * because they are all "tidy the mailbox", and splitting them would produce
	 * switches no operator would ever set differently from each other.
	 */
	"organise",
	/** Compose and amend drafts. Unsent, so it needs no send capability. */
	"draft",
	/** Inbound filter rules, and the blocked/allowed sender lists. */
	"manageRules",
	/**
	 * Mailbox configuration: identity, signatures, forwarding, auto-reply, the
	 * agent's system prompt.
	 *
	 * The highest-value capability here despite the mild name, because
	 * `forwarding.email` can redirect every incoming message elsewhere.
	 */
	"manageSettings",
	/**
	 * Grant and revoke other people's access to *this* mailbox.
	 *
	 * Held only by `owner`, which is the rule both products this vocabulary comes
	 * from apply: a Gmail delegate cannot re-delegate, and Exchange keeps
	 * `Add-MailboxPermission` away from the delegates it grants. Without it,
	 * handing out access is an instance-wide admin action, so the person whose
	 * mailbox it is cannot give their own assistant access to it — which is the
	 * single most common delegation there is.
	 */
	"manageDelegates",
] as const;

export type MailboxCapability = (typeof MAILBOX_CAPABILITIES)[number];

const CAPABILITY_LOOKUP: Record<string, true> = Object.fromEntries(
	MAILBOX_CAPABILITIES.map((capability) => [capability, true]),
);

export function isMailboxCapability(value: unknown): value is MailboxCapability {
	return typeof value === "string" && CAPABILITY_LOOKUP[value] === true;
}

/** Labels for the access UI. */
export const CAPABILITY_LABELS: Record<MailboxCapability, string> = {
	read: "Read mail",
	sendAs: "Send as this mailbox",
	sendOnBehalf: "Send on behalf of this mailbox",
	delete: "Move to Trash",
	deletePermanently: "Delete permanently",
	organise: "Organise mail, folders and labels",
	draft: "Write drafts",
	manageRules: "Manage rules and blocking",
	manageSettings: "Manage mailbox settings",
	manageDelegates: "Manage who else can use this mailbox",
};

/**
 * Role presets, ordered from least to most authority.
 *
 * `viewer` is read-only oversight; `agent` answers mail in a shared inbox;
 * `manager` runs that inbox; `owner` is the person whose mailbox it is.
 */
export const MAILBOX_ROLES = ["viewer", "agent", "manager", "owner"] as const;

export type MailboxRole = (typeof MAILBOX_ROLES)[number];

const ROLE_LOOKUP: Record<string, true> = Object.fromEntries(
	MAILBOX_ROLES.map((role) => [role, true]),
);

export function isMailboxRole(value: unknown): value is MailboxRole {
	return typeof value === "string" && ROLE_LOOKUP[value] === true;
}

/**
 * The role a bare mailbox address parses as.
 *
 * Grants written before capabilities existed list plain addresses and mean
 * unrestricted access. Anything narrower here would revoke authority already in
 * use, so the compatible reading is the full one.
 */
export const FULL_ACCESS_ROLE: MailboxRole = "owner";

/**
 * What each preset permits.
 *
 * `agent` gets `sendOnBehalf` and not `sendAs`: a shared support mailbox wants
 * replies attributable to whoever wrote them, and Exchange's own note that Send
 * As leaves no indication of the delegate is exactly the property you do not
 * want by default. `sendAs` is opt-in, via `manager` or an extended grant.
 */
export const ROLE_CAPABILITIES: Record<MailboxRole, readonly MailboxCapability[]> = {
	viewer: ["read"],
	agent: ["read", "sendOnBehalf", "draft", "delete", "organise"],
	manager: [
		"read",
		"sendAs",
		"sendOnBehalf",
		"draft",
		"delete",
		"deletePermanently",
		"organise",
		"manageRules",
	],
	owner: [...MAILBOX_CAPABILITIES],
};

export const ROLE_LABELS: Record<MailboxRole, string> = {
	viewer: "Viewer",
	agent: "Agent",
	manager: "Manager",
	owner: "Owner",
};

export const ROLE_DESCRIPTIONS: Record<MailboxRole, string> = {
	viewer: "Read mail only. Cannot send, delete, or change anything.",
	agent: "Read and reply on behalf of the mailbox, file mail, and bin messages.",
	manager:
		"Run the mailbox: send as it, purge the bin, manage rules and blocking. Cannot change its settings.",
	owner: "Full control, including the mailbox's identity, forwarding and settings.",
};

/**
 * One mailbox a principal may reach, and how far.
 *
 * `extra` and `revoked` exist for the cases a preset cannot express — giving one
 * agent `sendAs`, or taking `deletePermanently` off a manager — without
 * inventing a bespoke role for a single person.
 */
export interface MailboxAccess {
	/** Normalized mailbox address. */
	id: string;
	role: MailboxRole;
	/** Capabilities added on top of the preset. */
	extra?: MailboxCapability[];
	/** Capabilities withheld from the preset. Applied last, so it wins. */
	revoked?: MailboxCapability[];
}

/**
 * Expand one entry into the capabilities it actually confers.
 *
 * Order is the security property: preset, then additions, then revocations.
 * Revoking last means an entry that contradicts itself resolves the restrictive
 * way, which is the safe reading of a mistake.
 */
export function accessCapabilities(access: MailboxAccess): Set<MailboxCapability> {
	const out = new Set<MailboxCapability>(ROLE_CAPABILITIES[access.role] ?? []);
	for (const capability of access.extra ?? []) out.add(capability);
	for (const capability of access.revoked ?? []) out.delete(capability);
	return out;
}

/**
 * Coerce a stored `mailboxes` entry into a {@link MailboxAccess}, or null when it
 * names no usable mailbox.
 *
 * Accepts both shapes a grant can hold: a bare address, written before
 * capabilities existed and meaning full access, and an object naming a role.
 * Unrecognised roles and capabilities are dropped rather than trusted — a string
 * this build does not know must never widen access, and refusing the whole record
 * would lock out a deployment whose grants were written by a newer version.
 */
export function parseMailboxAccess(
	value: unknown,
	normalize: (raw: string) => string,
): MailboxAccess | null {
	if (typeof value === "string") {
		const id = normalize(value);
		return id ? { id, role: FULL_ACCESS_ROLE } : null;
	}

	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string") return null;

	const id = normalize(record.id);
	if (!id) return null;

	// An unknown role reads as the compatible default rather than as no access:
	// a typo in a hand-edited record should not silently strip a colleague's
	// mailbox, and the operator can see the role in the UI.
	const role = isMailboxRole(record.role) ? record.role : FULL_ACCESS_ROLE;

	const extra = filterCapabilities(record.extra);
	const revoked = filterCapabilities(record.revoked);

	return {
		id,
		role,
		...(extra ? { extra } : {}),
		...(revoked ? { revoked } : {}),
	};
}

function filterCapabilities(value: unknown): MailboxCapability[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.filter(isMailboxCapability);
	return out.length > 0 ? out : undefined;
}

/** Serialize an entry back to storage, keeping bare strings bare. */
export function serializeMailboxAccess(access: MailboxAccess): string | MailboxAccess {
	// A full-access entry with no adjustments round-trips as a plain address, so
	// enabling this feature does not rewrite every existing grant into a more
	// verbose form that says the same thing.
	if (access.role === FULL_ACCESS_ROLE && !access.extra?.length && !access.revoked?.length) {
		return access.id;
	}
	return access;
}

/**
 * What a session must hold before the agent socket will open.
 *
 * The agent's nine tools span three capabilities: `list_emails`, `get_email`,
 * `get_thread` and `search_emails` are `read`; `draft_email`, `draft_reply` and
 * `discard_draft` are `draft`; `mark_email_read` and `move_email` are `organise`.
 * There is deliberately no send tool.
 *
 * All three are required rather than just the strongest, because capabilities are
 * independently adjustable: a grant holding `draft` with `organise` revoked is a
 * real configuration, and a socket opened on `draft` alone would expose a
 * `move_email` that walks around the revocation. See the gate in `workers/app.ts`.
 *
 * Lives here rather than beside the gate so tests can assert against the same list
 * the gate uses; `workers/app.ts` imports `cloudflare:workers` and cannot be
 * loaded outside a Worker runtime.
 */
export const AGENT_SOCKET_CAPABILITIES: readonly MailboxCapability[] = [
	"read",
	"draft",
	"organise",
];

/**
 * How an outgoing message from a mailbox must be attributed.
 *
 * `sendAs` beats `sendOnBehalf` when a principal holds both, matching Exchange:
 * "If a user has both Send As and Send on Behalf permissions to a mailbox or
 * group, the Send As permission is always used."
 *
 * `null` means this principal may not send from this mailbox at all. Callers must
 * treat that as a refusal and never fall back to an unattributed send, which
 * would be precisely the identity-spoofing hole the split exists to prevent.
 */
export type SendAttribution =
	| { mode: "as" }
	| { mode: "onBehalfOf"; sender: string };

export function attributionFor(
	capabilities: ReadonlySet<MailboxCapability>,
	senderId: string | null,
): SendAttribution | null {
	if (capabilities.has("sendAs")) return { mode: "as" };
	if (capabilities.has("sendOnBehalf")) {
		// Without a known identity there is nobody to attribute the send to, and
		// silently sending as the mailbox would defeat the distinction.
		return senderId ? { mode: "onBehalfOf", sender: senderId } : null;
	}
	return null;
}
