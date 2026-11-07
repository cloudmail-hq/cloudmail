/**
 * Settings → Licence, and the onboarding licence step.
 *
 *   GET    /api/v1/licence             status for anyone signed in (locked or not)
 *   POST   /api/v1/licence/activate    { licenceKey }: admin, browser session
 *   POST   /api/v1/licence/refresh     admin: refresh now
 *   POST   /api/v1/licence/deactivate  { licenceKey }: admin, browser session
 *
 * Exempt from the licence gate (./lib/licence-gate.ts), so a locked
 * deployment can be activated. The key is sent to the licence server once and
 * never stored, logged or audited; only the token it buys is kept.
 *
 * The token is bound to the host the admin is using. `APP_URL` wins when set,
 * so a deployment reached on several names binds to its canonical one.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { normaliseLicenceKey } from "../../shared/licence";
import { auditActorRole, recordAuditDeferred } from "../lib/audit";
import { configuredOrigin } from "../lib/deployment-origin";
import { resolveConnectionAccountId } from "../lib/cf-connection";
import {
	activateLicence,
	deactivateLicence,
	invalidateLicenceCache,
	licenceState,
	licenceView,
	refreshLicence,
	type LicenceDeps,
} from "../lib/licence";
import { isAdminFor } from "../lib/authz";
import { requireAdminScope, type MailboxContext } from "../lib/mailbox";

type AppContext = Context<MailboxContext>;

/** Overridable in tests. */
export const licenceRouteDeps: { deps: (c: AppContext) => LicenceDeps } = {
	deps: () => ({}),
};

/** The host to bind to: `APP_URL`, else the request's own host. */
export function bindingHost(c: AppContext): string {
	const configured = configuredOrigin(c.env);
	return new URL(configured ?? c.req.url).hostname.toLowerCase();
}

function requireBrowserSession(c: AppContext): Response | null {
	if (c.var.authMethod !== "session" && c.var.authMethod !== "access" && c.var.authMethod !== "dev") {
		return c.json(
			{ error: "Licence changes need a signed-in browser session, not an API token.", code: "session_required" },
			403,
		);
	}
	return null;
}

const KeyBody = z.object({ licenceKey: z.string().max(512) }).strict();

async function readKey(c: AppContext): Promise<string | Response> {
	const parsed = KeyBody.safeParse(await c.req.json().catch(() => null));
	const key = parsed.success ? normaliseLicenceKey(parsed.data.licenceKey) : null;
	if (!key) return c.json({ error: "Paste the licence key from your purchase email.", code: "invalid_request" }, 400);
	return key;
}

export const licenceRoutes = new Hono<MailboxContext>();

licenceRoutes.get("/api/v1/licence", async (c) => {
	const deps = licenceRouteDeps.deps(c);
	const state = await licenceState(c.env, { ...deps, host: bindingHost(c) });
	const view = licenceView(state, deps.now?.());
	// Members see whether the app is locked, not the customer details.
	if (!isAdminFor(c.var.principal, "admin")) {
		return c.json({ status: view.status, locked: view.locked, enforcement: view.enforcement, graceDaysLeft: null });
	}
	return c.json(view);
});

licenceRoutes.use("/api/v1/licence/*", requireAdminScope("admin"));

licenceRoutes.post("/api/v1/licence/activate", async (c) => {
	const refused = requireBrowserSession(c);
	if (refused) return refused;
	const key = await readKey(c);
	if (key instanceof Response) return key;
	const deps = licenceRouteDeps.deps(c);
	const result = await activateLicence(
		c.env,
		{
			licenceKey: key,
			host: bindingHost(c),
			cfAccount: await resolveConnectionAccountId(c.env).catch(() => null),
			// The app has no release version yet; the server accepts null.
			appVersion: null,
		},
		deps,
	);
	if (!result.ok) return c.json({ error: result.message, code: result.error }, result.status as 400);
	const view = licenceView(result.state, deps.now?.());
	recordAuditDeferred(c, {
		action: "licence.activate",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		mailboxId: null,
		detail: { plan: view.plan, host: view.host },
	});
	return c.json(view);
});

licenceRoutes.post("/api/v1/licence/refresh", async (c) => {
	const deps = licenceRouteDeps.deps(c);
	const outcome = await refreshLicence(c.env, { ...deps, force: true });
	invalidateLicenceCache(c.env);
	const view = licenceView(await licenceState(c.env, { ...deps, host: bindingHost(c) }), deps.now?.());
	return c.json({ outcome, ...view });
});

licenceRoutes.post("/api/v1/licence/deactivate", async (c) => {
	const refused = requireBrowserSession(c);
	if (refused) return refused;
	const key = await readKey(c);
	if (key instanceof Response) return key;
	const deps = licenceRouteDeps.deps(c);
	const result = await deactivateLicence(c.env, key, deps);
	if (!result.ok) return c.json({ error: result.message, code: result.error }, result.status as 400);
	recordAuditDeferred(c, {
		action: "licence.deactivate",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		mailboxId: null,
		detail: {},
	});
	return c.json(licenceView(await licenceState(c.env, { ...deps, host: bindingHost(c) }), deps.now?.()));
});
