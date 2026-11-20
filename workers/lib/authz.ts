// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Authorization: who is asking, and which mailboxes they may touch.
 *
 * ## What this fixes
 *
 * Cloudflare Access authenticated the reader; nothing authorized them. The
 * verified identity was read in exactly one place — `GET /api/v1/me`, to print a
 * name in the corner — and every other route ignored it. Anyone who passed the
 * shared Access policy could read, send from, and delete *any* mailbox, and
 * `role` was reported as `"admin"` for everyone because there was nothing else it
 * could truthfully say.
 *
 * ## Two kinds of caller, one model
 *
 * Access issues two shapes of token, and both arrive here already verified by the
 * edge and re-verified in `workers/app.ts`:
 *
 * - a **person**, authenticated by an identity provider, carrying `email`
 * - a **machine**, authenticated by an Access *service token*, carrying
 *   `common_name` (the token's Client ID, e.g. `…​.access`), an empty `sub`, and
 *   no `email` at all
 *
 * Machines are granted mailboxes the same way people are, so there is one
 * authorization model rather than an application-level API key system sitting
 * beside it. That matters here specifically: Access is enforced at the edge on the
 * Worker route, so a client presenting only an app-issued bearer token never
 * reaches this code — such a key could be minted and displayed but never used.
 * Service tokens are the credential that actually works, so they are the one the
 * app understands.
 *
 * `common_name` is also where an mTLS client certificate's common name lands.
 * That needs no special handling: grants are an explicit allow-list keyed by exact
 * id, so an unrecognised common name simply has no grant and is refused.
 *
 * ## Why enforcement is opt-in
 *
 * Turning this on unconditionally would lock existing deployments out of their own
 * mail: with no stored grants, a fail-closed check denies everybody, including the
 * owner, on the first request after deploy. There is no safe bootstrap from inside
 * the app either — "first caller becomes admin" is a race that hands the mailbox
 * to whoever knocks first.
 *
 * So the switch is `ADMIN_EMAILS`, a Worker var listing the addresses that are
 * unconditionally admin. While it is unset the app behaves exactly as it did
 * before (every authenticated caller is an admin) and says so in `/api/v1/me` and
 * in the logs, so the unenforced state is visible rather than silent. Set it and
 * enforcement begins, with the listed addresses guaranteed to be able to get back
 * in — that guarantee is the whole reason it lives in configuration rather than in
 * the bucket alongside the grants it protects.
 *
 * ## Shape of the model
 *
 * Two roles. An `admin` reaches every mailbox and manages grants. A `member`
 * reaches exactly the mailboxes named in their grant, and nothing else. Absence
 * of a grant means no access, not full access.
 *
 * Grants live in R2 under `access/users/` and `access/services/`, split by kind so
 * the storage location is what decides whether a record is a person or a machine
 * — a field inside the record could disagree with where it was found. A grant may
 * itself carry `role: "admin"`, so admins can be appointed from the UI;
 * `ADMIN_EMAILS` stays the floor that cannot be revoked by a bad write.
 *
 * ## Testability
 *
 * Every decision is a pure function over plain data — `decidePrincipal`,
 * `canAccessMailbox`, `visibleMailboxes` — with R2 and Hono confined to the
 * helpers at the bottom. The interesting cases (no identity, unset config, empty
 * grant, mixed casing, a machine claiming to be a person) are then exhaustively
 * testable without a Worker runtime. See `test/authz.test.ts`.
 */

import {
	MAILBOX_CAPABILITIES,
	accessCapabilities,
	attributionFor,
	parseMailboxAccess,
	serializeMailboxAccess,
	type MailboxAccess,
	type MailboxCapability,
	type SendAttribution,
} from "./capabilities";
import { listAllKeys, listJsonUnderPrefix } from "./r2";
import {
	effectiveTokenScopes,
	normalizeTokenMailboxes,
	type TokenScope,
} from "../../shared/token-scopes";

/** R2 prefixes holding one grant record per principal, split by kind. */
export const ACCESS_USERS_PREFIX = "access/users/";
export const ACCESS_SERVICES_PREFIX = "access/services/";

export type Role = "admin" | "member";

/**
 * Whether a principal is a person or a machine.
 *
 * Kept explicit rather than inferred from the id's shape: the two are granted
 * separately and stored separately, and a check that guessed from "does it look
 * like an email" would be one typo away from crossing them.
 */
export type PrincipalKind = "user" | "service";

/** The verified caller, as read from the Access token. */
export interface AccessIdentity {
	kind: PrincipalKind;
	/** Email for a person; the service token's Client ID for a machine. */
	id: string;
	/** Access `sub` claim — stable per user, and empty for service tokens. */
	subject: string | null;
}

/** A stored grant. */
export interface AccessGrant {
	id: string;
	kind: PrincipalKind;
	role: Role;
	/**
	 * Mailbox addresses this principal may act on. Meaningless for admins, who
	 * reach everything; kept on the record anyway so demoting an admin to member
	 * does not silently discard the list.
	 *
	 * Derived from {@link access} and kept as a flat list of ids because most
	 * callers only ask "which mailboxes", not "how far in each".
	 */
	mailboxes: string[];
	/**
	 * The same mailboxes with the authority held over each.
	 *
	 * Parallel to {@link mailboxes} and always the same length. Entries written
	 * before capabilities existed parse as full access, so an old grant means
	 * exactly what it used to. See `workers/lib/capabilities.ts`.
	 */
	access: MailboxAccess[];
	/**
	 * Human-readable note. Service token Client IDs are opaque hex, so without
	 * somewhere to write "CI deploy bot" an operator cannot tell which row to
	 * revoke.
	 */
	label?: string;
	updatedAt: string;
}

/** The resolved authority of the caller for this request. */
export interface Principal {
	/** The verified identity, or null when there is none. */
	identity: AccessIdentity | null;
	role: Role;
	/**
	 * Mailboxes this principal may act on, or `null` for "all of them".
	 *
	 * `null` and `[]` are deliberately different: the first is an admin, the
	 * second is an authenticated stranger with no grant. Collapsing them is how
	 * this kind of check ends up failing open.
	 */
	mailboxes: string[] | null;
	/**
	 * The authority held over each reachable mailbox, or `null` when every
	 * mailbox is reachable with full authority (an admin, or an unenforced
	 * deployment).
	 *
	 * Same `null` versus `[]` distinction as {@link mailboxes}, for the same
	 * reason: `null` is "everything", `[]` is "nothing".
	 */
	access: MailboxAccess[] | null;
	/** Whether `ADMIN_EMAILS` is configured, i.e. whether any of this is binding. */
	enforced: boolean;
	/** True when authority came from the local-development bypass. */
	developmentBypass: boolean;
	/**
	 * A narrowing applied because the caller authenticated with a scoped `ttk_`
	 * API token. Absent (or null) for sessions, OAuth, Access and legacy
	 * unscoped tokens, which act with the user's full authority.
	 *
	 * Everything above still describes the *user*; the query functions below
	 * (`canAccessMailbox`, `mailboxCapabilities`, `canDo`, `isAdmin`,
	 * `visibleMailboxes`, `sendAttributionFor`) intersect it with this, so every
	 * route, MCP tool and agent socket that asks them is narrowed with no
	 * per-route code. See {@link applyTokenRestriction}.
	 */
	token?: TokenRestriction | null;
	/**
	 * Which credential made this request, for attribution and for the agent send
	 * policy (`shared/agent-send-policy.ts`). Never widens anything: `sendAuto`
	 * only lets an already-permitted send skip the approval queue on a mailbox
	 * whose owner chose `auto`.
	 */
	credential?: CredentialInfo | null;
}

/** The credential behind a request, as the audit log and the send policy see it. */
export interface CredentialInfo {
	method: "session" | "token" | "oauth" | "access" | "dev";
	tokenId?: string | null;
	tokenName?: string | null;
	oauthGrantId?: string | null;
	oauthClientId?: string | null;
	oauthClientName?: string | null;
	/**
	 * The credential explicitly allows sending without approval: a token holding
	 * `mail:send` + `mail:send:auto`, or an OAuth grant marked as trusted.
	 */
	sendAuto: boolean;
}

/** Parse a credential that crossed into the MCP agent; anything malformed is dropped. */
export function parseCredential(value: unknown): CredentialInfo | null {
	if (!value || typeof value !== "object") return null;
	const r = value as Record<string, unknown>;
	const methods = ["session", "token", "oauth", "access", "dev"] as const;
	const method = methods.find((m) => m === r.method);
	if (!method) return null;
	const s = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : null);
	return {
		method,
		tokenId: s(r.tokenId),
		tokenName: s(r.tokenName),
		oauthGrantId: s(r.oauthGrantId),
		oauthClientId: s(r.oauthClientId),
		oauthClientName: s(r.oauthClientName),
		// Only a token or OAuth credential can carry auto-send.
		sendAuto: r.sendAuto === true && (method === "token" || method === "oauth"),
	};
}

/** What a scoped API token adds on top of its user's grants. Only ever narrows. */
export interface TokenRestriction {
	/** The token's public id, for logs and `/me`. */
	id: string;
	/**
	 * Scopes held, never null: a mailbox-only token is normalized to the mail
	 * scopes by {@link applyTokenRestriction}, so admin-class scopes always have
	 * to be listed explicitly. See `effectiveTokenScopes`.
	 */
	scopes: TokenScope[];
	/** Mailboxes the token may reach, or null for "whatever the user can reach". */
	mailboxes: string[] | null;
}

/**
 * The mailbox capabilities each token scope unlocks.
 *
 * `mail:organize` carries both delete capabilities because the scope is "tidy
 * the mailbox" from an API caller's point of view; the user's own grant still
 * decides whether `deletePermanently` is really available. Scopes that map to
 * nothing here (`domains:manage`, `webhooks:manage`, `admin`) are instance-level
 * and enforced by the route table in `workers/lib/token-scope-guard.ts`.
 */
export const SCOPE_CAPABILITIES: Record<TokenScope, readonly MailboxCapability[]> = {
	"mail:read": ["read"],
	"mail:send": ["sendAs", "sendOnBehalf"],
	// Grants no capability of its own: it only changes whether an agent send
	// waits for approval (`shared/agent-send-policy.ts`).
	"mail:send:auto": [],
	// Lets a person's CLI token decide held sends; checked by the approvals routes.
	"approvals:manage": [],
	"mail:draft": ["draft"],
	"mail:organize": ["organise", "delete", "deletePermanently"],
	"mailboxes:manage": ["manageRules", "manageSettings", "manageDelegates"],
	"domains:manage": [],
	"webhooks:manage": [],
	admin: [],
};

/** The capabilities a scope list permits; null scopes permit every capability. */
export function capabilitiesForScopes(scopes: readonly TokenScope[] | null): Set<MailboxCapability> {
	if (scopes === null) return new Set(MAILBOX_CAPABILITIES);
	const out = new Set<MailboxCapability>();
	for (const scope of scopes) for (const cap of SCOPE_CAPABILITIES[scope] ?? []) out.add(cap);
	return out;
}

/**
 * Attach a token's restriction to a user's principal.
 *
 * Returns the principal unchanged when the token restricts nothing, so a token
 * minted before scopes existed (`scopes` and `mailboxes` both null) keeps the
 * exact behaviour it always had.
 */
export function applyTokenRestriction(
	principal: Principal,
	token: { id: string; scopes: unknown; mailboxes: unknown } | null | undefined,
): Principal {
	if (!token) return principal;
	const mailboxes = normalizeTokenMailboxes(token.mailboxes);
	// Null only for a fully legacy token. A mailbox-only token gets the mail
	// scopes and no admin-class ones, so `token.scopes` on a principal is never
	// null: every check below can treat a restricted token uniformly.
	const scopes = effectiveTokenScopes(token);
	if (scopes === null) return principal;
	return { ...principal, token: { id: token.id, scopes, mailboxes } };
}

/** Whether the caller's token (if any) holds `scope`. Unrestricted callers hold every scope. */
export function hasTokenScope(principal: Principal, scope: TokenScope): boolean {
	const token = principal.token;
	// No restriction (session, OAuth, Access, legacy token): every scope.
	if (!token) return true;
	return token.scopes.includes(scope);
}

/**
 * Administrator authority for one admin-only area, such as domains.
 *
 * The user must be an administrator, and a scoped token must hold either the
 * area's own scope or `admin`. This lets a token manage domains without being
 * able to rewrite grants or branding; it never makes a member an admin.
 */
export function isAdminFor(principal: Principal, scope: TokenScope): boolean {
	return principal.role === "admin" && (hasTokenScope(principal, scope) || hasTokenScope(principal, "admin"));
}

/**
 * Whether the caller may create, list and end agent inboxes: an administrator
 * whose token (if scoped) holds `mailboxes:manage` or `admin`. Minting one
 * creates a mailbox and a token, both administrator acts.
 */
export function canManageAgentInboxes(principal: Principal): boolean {
	return isAdminFor(principal, "mailboxes:manage");
}

function tokenAllowsMailbox(principal: Principal, address: string): boolean {
	const allow = principal.token?.mailboxes;
	return allow === null || allow === undefined || allow.includes(address);
}

/** Normalize an identifier for comparison. Both kinds are case-insensitive. */
export function normalizeAddress(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Whether a parsed entry is a single plausible address.
 *
 * Deliberately strict about what it rejects, because a malformed entry is worse
 * than a missing one. `owner@x.com;other@x.com` contains an `@` and would pass a
 * looser check, producing one nonsense "address" that matches nobody — yet it is
 * non-empty, so it would switch enforcement *on* and lock the operator out of
 * their own deployment with nothing to explain why. Better to drop it, leave
 * enforcement off, and report an empty admin list the operator can see.
 */
function isPlausibleAddress(value: string): boolean {
	if (/[\s;,]/.test(value)) return false;
	const parts = value.split("@");
	if (parts.length !== 2) return false;
	const [local, domain] = parts;
	// A domain has to have a dot to be routable, and neither side may be empty.
	return local.length > 0 && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

/**
 * Whether a string is usable as a service token Client ID.
 *
 * Access issues these as hex followed by `.access`, but the suffix is not
 * required here — `common_name` is whatever Access put in the token, and pinning
 * a format the platform might change would reject valid callers. What *is*
 * enforced is that it is safe to put in an R2 key and could not be an email: no
 * slashes, no whitespace, no `@`, and not a bare dot sequence.
 */
function isPlausibleServiceId(value: string): boolean {
	if (value.length === 0 || value.length > 200) return false;
	if (!/^[a-z0-9._-]+$/.test(value)) return false;
	// `.` and `..` would traverse rather than name something.
	return /[a-z0-9]/.test(value);
}

/** Whether `id` is a valid identifier for `kind`. */
export function isValidPrincipalId(kind: PrincipalKind, id: string): boolean {
	const normalized = normalizeAddress(id);
	return kind === "user"
		? isPlausibleAddress(normalized)
		: isPlausibleServiceId(normalized);
}

/**
 * Parse the `ADMIN_EMAILS` var.
 *
 * Comma-separated, whitespace-tolerant, deduplicated, and strict about what
 * counts as an address — see {@link isPlausibleAddress} for why the strictness is
 * the safer failure mode.
 */
export function parseAdminEmails(raw: string | undefined | null): string[] {
	if (!raw) return [];
	const seen = new Set<string>();
	for (const part of raw.split(",")) {
		const email = normalizeAddress(part);
		if (isPlausibleAddress(email)) seen.add(email);
	}
	return [...seen];
}

/**
 * Whether `ADMIN_EMAILS` was set to something, but nothing usable came out.
 *
 * Distinguishes "authorization intentionally not configured" from "the operator
 * tried to configure it and the value is wrong", which otherwise look identical
 * from the outside: both leave enforcement off.
 */
export function isAdminEmailsMisconfigured(raw: string | undefined | null): boolean {
	return Boolean(raw && raw.trim().length > 0) && parseAdminEmails(raw).length === 0;
}

/**
 * The identity in a verified Access token payload, or null if it names none.
 *
 * A person's token carries `email`; a service token carries `common_name` with an
 * empty `sub` and no email at all. Anything else — a token shape this app does
 * not understand — yields null and is refused downstream rather than defaulted.
 */
export function identityFromTokenPayload(payload: {
	email?: unknown;
	common_name?: unknown;
	sub?: unknown;
}): AccessIdentity | null {
	const subject = typeof payload.sub === "string" && payload.sub ? payload.sub : null;

	if (typeof payload.email === "string" && payload.email.includes("@")) {
		return { kind: "user", id: normalizeAddress(payload.email), subject };
	}

	if (typeof payload.common_name === "string" && payload.common_name.trim()) {
		return {
			kind: "service",
			id: normalizeAddress(payload.common_name),
			subject,
		};
	}

	return null;
}

export interface DecidePrincipalInput {
	/** Addresses that are admin by configuration. Empty disables enforcement. */
	adminEmails: string[];
	/** The verified identity, if any. */
	identity?: AccessIdentity | null;
	/** Stored grant for that identity, if any. */
	grant?: AccessGrant | null;
	/** Set only by the local-development path, where Access is not consulted. */
	developmentBypass?: boolean;
	/**
	 * Enforce even when `adminEmails` is empty.
	 *
	 * Built-in password auth sets this: there, "nobody configured ADMIN_EMAILS"
	 * is the normal state, not a legacy deployment to keep open, and the owner
	 * account is the administrator. Without it every invited member would be an
	 * admin of every mailbox. See `workers/auth/middleware.ts`.
	 */
	forceEnforced?: boolean;
}

/**
 * The access entries a stored grant confers, newest field preferred.
 *
 * A grant written by this build carries `access`. One written before
 * capabilities existed carries only `mailboxes`, whose bare addresses mean
 * unrestricted access — so they are widened to the full-access role rather than
 * read as an empty capability set, which would revoke authority already in use.
 *
 * De-duplicated by mailbox id, keeping the first entry: a record naming the same
 * mailbox twice is a mistake, and silently unioning two roles for it would be a
 * quiet escalation.
 */
function grantAccessEntries(grant: AccessGrant): MailboxAccess[] {
	const source: unknown[] =
		Array.isArray(grant.access) && grant.access.length > 0
			? grant.access
			: (grant.mailboxes ?? []);

	const seen: Record<string, true> = {};
	const out: MailboxAccess[] = [];
	for (const raw of source) {
		const entry = parseMailboxAccess(raw, normalizeAddress);
		if (!entry || seen[entry.id]) continue;
		seen[entry.id] = true;
		out.push(entry);
	}
	return out;
}

/**
 * Resolve what the caller is allowed to do.
 *
 * The order of these branches is the security property. Configuration beats
 * stored state, and a missing identity is refused rather than defaulted.
 */
export function decidePrincipal(input: DecidePrincipalInput): Principal {
	const adminEmails = input.adminEmails.map(normalizeAddress);
	const enforced = input.forceEnforced === true || adminEmails.length > 0;
	const identity = input.identity
		? { ...input.identity, id: normalizeAddress(input.identity.id) }
		: null;

	// Local development never sees an Access token, so there is no identity to
	// authorize. Enforcing here would only make the app unusable on localhost.
	if (input.developmentBypass) {
		return {
			identity,
			role: "admin",
			mailboxes: null,
			access: null,
			enforced,
			developmentBypass: true,
		};
	}

	// Unconfigured: preserve the historical model rather than locking the operator
	// out of a running deployment. `enforced: false` is reported to the client so
	// this can be surfaced instead of assumed.
	if (!enforced) {
		return {
			identity,
			role: "admin",
			mailboxes: null,
			access: null,
			enforced: false,
			developmentBypass: false,
		};
	}

	// Enforced, but we could not tell who this is. Fail closed.
	if (!identity) {
		return {
			identity: null,
			role: "member",
			mailboxes: [],
			access: [],
			enforced: true,
			developmentBypass: false,
		};
	}

	// `ADMIN_EMAILS` names people. A machine is only ever an admin by an explicit
	// grant, so a service id is never matched against it.
	if (identity.kind === "user" && adminEmails.includes(identity.id)) {
		return {
			identity,
			role: "admin",
			mailboxes: null,
			access: null,
			enforced: true,
			developmentBypass: false,
		};
	}

	// The grant has to be for this exact principal: same id *and* same kind.
	if (
		input.grant &&
		normalizeAddress(input.grant.id) === identity.id &&
		input.grant.kind === identity.kind
	) {
		if (input.grant.role === "admin") {
			return {
				identity,
				role: "admin",
				mailboxes: null,
				access: null,
				enforced: true,
				developmentBypass: false,
			};
		}
		// `access` is the authority; `mailboxes` is derived from it so the two
		// cannot disagree about which mailboxes are reachable.
		const access = grantAccessEntries(input.grant);
		return {
			identity,
			role: "member",
			mailboxes: access.map((entry) => entry.id),
			access,
			enforced: true,
			developmentBypass: false,
		};
	}

	// Authenticated, but nobody has granted them anything.
	return {
		identity,
		role: "member",
		mailboxes: [],
		access: [],
		enforced: true,
		developmentBypass: false,
	};
}

/**
 * The mailbox an `/agents/...` request is addressed to, or null if it names none.
 *
 * PartyServer routes these as `/agents/{namespace}/{name}/...`, and for the email
 * agent the instance name *is* the mailbox address — the panel connects with
 * `useAgent({ agent: "EmailAgent", name: mailboxId })`. Authorizing on the name
 * therefore authorizes the mailbox, whichever namespace is asked for.
 *
 * Lives here rather than beside the route it guards so it can be tested without
 * importing the Worker entry point, which pulls in the Durable Objects and the
 * `cloudflare:` module namespace.
 */
export function agentTargetFromPath(pathname: string): string | null {
	const parts = pathname.split("/").filter(Boolean);
	if (parts[0] !== "agents" || parts.length < 3) return null;
	return decodeURIComponent(parts[2]);
}

/** Whether this principal may act on `mailboxId`. */
export function canAccessMailbox(
	principal: Principal,
	mailboxId: string,
): boolean {
	const address = normalizeAddress(mailboxId);
	if (!tokenAllowsMailbox(principal, address)) return false;
	if (principal.mailboxes === null) return true;
	return principal.mailboxes.includes(address);
}

/** Whether this principal may perform instance-wide administration. */
export function isAdmin(principal: Principal): boolean {
	return principal.role === "admin" && hasTokenScope(principal, "admin");
}

/**
 * Everything this principal may do inside `mailboxId`.
 *
 * `access: null` means unrestricted — an admin, or a deployment with enforcement
 * off — so the full capability set is returned. A mailbox the principal cannot
 * reach yields an empty set rather than a partial one, so a caller that forgets
 * to check reachability first still gets a refusal.
 */
export function mailboxCapabilities(
	principal: Principal,
	mailboxId: string,
): Set<MailboxCapability> {
	const address = normalizeAddress(mailboxId);
	let granted: Set<MailboxCapability>;
	if (principal.access === null) {
		granted = new Set(MAILBOX_CAPABILITIES);
	} else {
		const entry = principal.access.find((candidate) => candidate.id === address);
		granted = entry ? accessCapabilities(entry) : new Set();
	}
	if (!principal.token) return granted;
	// Intersection: the user's grant, the token's mailboxes, the token's scopes.
	if (!tokenAllowsMailbox(principal, address)) return new Set();
	const allowed = capabilitiesForScopes(principal.token.scopes);
	return new Set([...granted].filter((capability) => allowed.has(capability)));
}

/**
 * Whether this principal holds `capability` on `mailboxId`.
 *
 * The single question every route gate asks. Deliberately never phrased in terms
 * of roles: a route that checked `role === "manager"` would silently stop
 * honouring a per-grant adjustment.
 */
export function canDo(
	principal: Principal,
	mailboxId: string,
	capability: MailboxCapability,
): boolean {
	if (principal.access === null && !principal.token) return true;
	return mailboxCapabilities(principal, mailboxId).has(capability);
}

/**
 * How a message sent from `mailboxId` by this principal must be attributed, or
 * null when they may not send from it at all.
 *
 * An unrestricted principal sends as the mailbox: that is what "full access"
 * meant before this distinction existed, and an owner sending from their own
 * address is not acting on anyone's behalf.
 *
 * `principal` is typed as required, but a caller reached from a route that never
 * ran `resolvePrincipal` can still pass nothing. Refusing is the only safe
 * reading of "no idea who this is", and it is far better than throwing: a crash
 * mid-send would surface as a 500 after the message was already stored.
 */
export function sendAttributionFor(
	principal: Principal | undefined | null,
	mailboxId: string,
): SendAttribution | null {
	if (!principal) return null;
	if (principal.access === null && !principal.token) return { mode: "as" };
	return attributionFor(
		mailboxCapabilities(principal, mailboxId),
		principal.identity?.id ?? null,
	);
}

/**
 * Narrow a list of mailbox addresses to the ones this principal may see.
 *
 * Filters the caller's list rather than returning the grant, so a grant naming a
 * mailbox that no longer exists cannot conjure a phantom row in the sidebar.
 */
export function visibleMailboxes<T>(
	principal: Principal,
	mailboxes: T[],
	addressOf: (item: T) => string,
): T[] {
	if (principal.mailboxes === null && !principal.token?.mailboxes) return mailboxes;
	return mailboxes.filter((item) => canAccessMailbox(principal, addressOf(item)));
}

// -- Storage --------------------------------------------------------

export function prefixForKind(kind: PrincipalKind): string {
	return kind === "user" ? ACCESS_USERS_PREFIX : ACCESS_SERVICES_PREFIX;
}

function grantKey(kind: PrincipalKind, id: string): string {
	return `${prefixForKind(kind)}${normalizeAddress(id)}.json`;
}

/**
 * Coerce a stored record into a grant, or null if it is unusable.
 *
 * `kind` is passed in by the caller from the prefix the record was found under
 * rather than read out of the record, so a field that disagrees with its own
 * location cannot promote a machine into the set of people (or vice versa).
 */
export function parseGrant(value: unknown, kind: PrincipalKind): AccessGrant | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;

	// `email` is read as a fallback for records written before machines existed,
	// when a grant could only ever be a person.
	const rawId =
		typeof record.id === "string"
			? record.id
			: typeof record.email === "string"
				? record.email
				: null;
	if (!rawId) return null;

	const id = normalizeAddress(rawId);
	if (!isValidPrincipalId(kind, id)) return null;

	// Anything other than an explicit "admin" is a member. A corrupted or
	// partially-written record must not read as an escalation.
	const role: Role = record.role === "admin" ? "admin" : "member";

	/**
	 * `mailboxes` is the wire format for "which mailboxes", and every entry may
	 * be either a bare address (pre-capabilities, meaning full access) or an
	 * object naming a role. Parsing both here means one storage field carries the
	 * old and new shapes, so no migration pass has to run over existing grants.
	 */
	const seen: Record<string, true> = {};
	const access: MailboxAccess[] = [];
	for (const raw of Array.isArray(record.mailboxes) ? record.mailboxes : []) {
		const entry = parseMailboxAccess(raw, normalizeAddress);
		if (!entry || seen[entry.id]) continue;
		seen[entry.id] = true;
		access.push(entry);
	}

	return {
		id,
		kind,
		role,
		// Derived, so the flat list and the capability entries cannot disagree.
		mailboxes: access.map((entry) => entry.id),
		access,
		...(typeof record.label === "string" && record.label.trim()
			? { label: record.label.trim() }
			: {}),
		updatedAt:
			typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
	};
}

export async function getGrant(
	bucket: R2Bucket,
	kind: PrincipalKind,
	id: string,
): Promise<AccessGrant | null> {
	const obj = await bucket.get(grantKey(kind, id));
	if (!obj) return null;
	try {
		return parseGrant(await obj.json(), kind);
	} catch (e) {
		// A grant we cannot read must not become a grant we assume. Denying is
		// recoverable; guessing is not.
		console.error(
			`Unreadable access grant for ${kind} ${normalizeAddress(id)}:`,
			(e as Error).message,
		);
		return null;
	}
}

/**
 * Write a grant.
 *
 * Callers may supply either `access` (capability-aware) or a bare `mailboxes`
 * list; whichever is present is normalized into `access`, and the stored
 * `mailboxes` array is written from it. Full-access entries serialize back to
 * plain strings, so turning this feature on does not rewrite every existing
 * record into a more verbose form that says the same thing.
 */
export async function putGrant(
	bucket: R2Bucket,
	grant: Omit<AccessGrant, "updatedAt" | "access"> & { access?: MailboxAccess[] },
): Promise<AccessGrant> {
	const seen: Record<string, true> = {};
	const access: MailboxAccess[] = [];
	const source: unknown[] =
		grant.access && grant.access.length > 0 ? grant.access : (grant.mailboxes ?? []);
	for (const raw of source) {
		const entry = parseMailboxAccess(raw, normalizeAddress);
		if (!entry || seen[entry.id]) continue;
		seen[entry.id] = true;
		access.push(entry);
	}

	const record: AccessGrant = {
		id: normalizeAddress(grant.id),
		kind: grant.kind,
		role: grant.role,
		mailboxes: access.map((entry) => entry.id),
		access,
		...(grant.label?.trim() ? { label: grant.label.trim() } : {}),
		updatedAt: new Date().toISOString(),
	};

	// `mailboxes` is the single stored field: entries are strings where full
	// access is meant and objects where it is narrowed. `access` is derived on
	// read, so it is not persisted separately and cannot drift from the list.
	await bucket.put(
		grantKey(record.kind, record.id),
		JSON.stringify({
			id: record.id,
			kind: record.kind,
			role: record.role,
			mailboxes: access.map(serializeMailboxAccess),
			...(record.label ? { label: record.label } : {}),
			updatedAt: record.updatedAt,
		}),
	);
	return record;
}

export async function deleteGrant(
	bucket: R2Bucket,
	kind: PrincipalKind,
	id: string,
): Promise<void> {
	await bucket.delete(grantKey(kind, id));
}

/** Every stored grant of one kind. Unreadable records are skipped. */
export async function listGrants(
	bucket: R2Bucket,
	kind: PrincipalKind,
): Promise<AccessGrant[]> {
	const raw = await listJsonUnderPrefix<unknown>(bucket, prefixForKind(kind));
	return raw
		.map((record) => parseGrant(record, kind))
		.filter((g): g is AccessGrant => g !== null)
		.sort((a, b) => a.id.localeCompare(b.id));
}

export interface ResolvePrincipalOptions {
	/** Raw `ADMIN_EMAILS` value. */
	adminEmailsRaw: string | undefined | null;
	bucket: R2Bucket;
	identity?: AccessIdentity | null;
	developmentBypass?: boolean;
	/** Addresses that are admins in addition to `ADMIN_EMAILS` (the password-mode owner). */
	extraAdminEmails?: string[];
	/** See {@link DecidePrincipalInput.forceEnforced}. */
	forceEnforced?: boolean;
}

/**
 * Resolve a principal, fetching the stored grant only when it can change the
 * answer.
 *
 * Shared by the HTTP middleware, MCP and the agent route so the three cannot
 * drift: a second implementation of "who is this and what may they touch" is how
 * one surface ends up enforcing something another does not.
 */
export async function resolvePrincipalFor(
	options: ResolvePrincipalOptions,
): Promise<Principal> {
	const adminEmails = [
		...parseAdminEmails(options.adminEmailsRaw),
		...(options.extraAdminEmails ?? []),
	];
	const identity = options.identity ?? null;
	const developmentBypass = options.developmentBypass === true;
	const forceEnforced = options.forceEnforced === true;

	const provisional = decidePrincipal({
		adminEmails,
		identity,
		grant: null,
		developmentBypass,
		forceEnforced,
	});

	// An unenforced deployment and a configured admin are both decided from
	// configuration alone, so the common paths cost no R2 read.
	if (provisional.mailboxes === null || !identity) return provisional;

	const grant = await getGrant(options.bucket, identity.kind, identity.id);
	return decidePrincipal({ adminEmails, identity, grant, developmentBypass, forceEnforced });
}

/**
 * Rebuild a principal that crossed a Durable Object boundary.
 *
 * The MCP agent runs in its own Durable Object and receives the principal as
 * props rather than as Hono context. Props are set by this Worker and never by
 * the client, so the value is trusted — but it can be *absent*, on a session that
 * was persisted before authorization existed. In that case the authority is
 * derived from configuration alone, which denies everything once enforcement is
 * on and restores the historical behaviour when it is off.
 */
export function principalFromProps(
	props: unknown,
	adminEmailsRaw: string | undefined | null,
	options: { forceEnforced?: boolean } = {},
): Principal {
	const candidate = (props as { principal?: unknown } | undefined)?.principal;

	if (candidate && typeof candidate === "object") {
		const record = candidate as Record<string, unknown>;
		/**
		 * Capability entries survive the crossing, so a narrowed grant stays
		 * narrowed inside the agent. A blob written before capabilities existed
		 * carries bare addresses in `mailboxes`, which parse as full access — the
		 * same reading the HTTP path gives them.
		 */
		const seen: Record<string, true> = {};
		const access: MailboxAccess[] = [];
		const source: unknown[] = Array.isArray(record.access)
			? record.access
			: Array.isArray(record.mailboxes)
				? record.mailboxes
				: [];
		for (const raw of source) {
			const entry = parseMailboxAccess(raw, normalizeAddress);
			if (!entry || seen[entry.id]) continue;
			seen[entry.id] = true;
			access.push(entry);
		}

		const rawIdentity = record.identity as Record<string, unknown> | null | undefined;
		const identity: AccessIdentity | null =
			rawIdentity && typeof rawIdentity.id === "string"
				? {
						kind: rawIdentity.kind === "service" ? "service" : "user",
						id: normalizeAddress(rawIdentity.id),
						subject:
							typeof rawIdentity.subject === "string" ? rawIdentity.subject : null,
					}
				: null;

		const isAdminProp = record.role === "admin";
		const base: Principal = {
			identity,
			// Anything but an explicit "admin" is a member, as elsewhere.
			role: isAdminProp ? "admin" : "member",
			// Only an admin may carry "every mailbox"; a member claiming `null` would
			// be an escalation, so it is narrowed to no access.
			mailboxes: isAdminProp ? null : access.map((entry) => entry.id),
			access: isAdminProp ? null : access,
			enforced: record.enforced === true,
			developmentBypass: record.developmentBypass === true,
		};
		// A token restriction must survive the trip to the MCP agent: dropping it
		// would make `/mcp` the way around a token's scopes.
		const rawToken = record.token as Record<string, unknown> | null | undefined;
		const credential = parseCredential(record.credential);
		const withCredential: Principal = credential ? { ...base, credential } : base;
		return rawToken && typeof rawToken === "object" && typeof rawToken.id === "string"
			? applyTokenRestriction(withCredential, {
					id: rawToken.id,
					scopes: rawToken.scopes,
					mailboxes: rawToken.mailboxes,
				})
			: withCredential;
	}

	return decidePrincipal({
		adminEmails: parseAdminEmails(adminEmailsRaw),
		identity: null,
		forceEnforced: options.forceEnforced === true,
	});
}

/**
 * Remove every stored grant naming a mailbox that is being deleted.
 *
 * Without this, deleting and later re-creating an address would silently restore
 * everyone's access to it, and the access screen would keep listing a mailbox
 * that no longer exists.
 */
export async function revokeMailboxFromGrants(
	bucket: R2Bucket,
	mailboxId: string,
): Promise<number> {
	const address = normalizeAddress(mailboxId);
	let updated = 0;

	for (const kind of ["user", "service"] as const) {
		for (const grant of await listGrants(bucket, kind)) {
			if (!grant.mailboxes.includes(address)) continue;
			// Filter `access`, not `mailboxes`: `putGrant` derives the stored list
			// from `access` whenever it is present, so dropping the id from only the
			// flat list would write the mailbox straight back and revoke nothing.
			await putGrant(bucket, {
				...grant,
				access: grant.access.filter((entry) => entry.id !== address),
				mailboxes: grant.mailboxes.filter((m) => m !== address),
			});
			updated += 1;
		}
	}

	return updated;
}

/** Keys of every stored grant, for the mailbox purge path. */
export async function listGrantKeys(bucket: R2Bucket): Promise<string[]> {
	return [
		...(await listAllKeys(bucket, ACCESS_USERS_PREFIX)),
		...(await listAllKeys(bucket, ACCESS_SERVICES_PREFIX)),
	];
}
