/**
 * Settings → Licence, and the onboarding licence step.
 *
 *   GET    /api/v1/licence             status for anyone signed in (locked or not)
 *   POST   /api/v1/licence/activate    { licenceKey }: admin, browser session
 *   POST   /api/v1/licence/refresh     admin: refresh now
 *   POST   /api/v1/licence/deactivate  { licenceKey }: admin, browser session
 *   POST   /api/v1/licence/upgrade     admin, browser session: a checkout URL for Solo → Unlimited
 *
 * Activate with `takeover: true` moves a licence that is active on another
 * deployment here (the licence server frees the other one's slot). Without
 * it, a licence in use elsewhere answers 422 `activation_limit_reached` with
 * the masked host of the deployment that holds it.
 *
 * Exempt from the licence gate (./lib/licence-gate.ts), so a locked
 * deployment can be activated. The key is sent to the licence server once and
 * never stored, logged or audited; only the token it buys is kept.
 *
 * The token is bound to the host the admin is using. `APP_URL` wins when set,
 * so a deployment reached on several names binds to its canonical one.
 */

import { APP_VERSION } from "../../shared/app-version";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { normaliseLicenceKey, type LicenceView } from "../../shared/licence";
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
	startLicenceUpgrade,
	type LicenceDeps,
} from "../lib/licence";
import { domainUsage, LICENCE_SETTINGS_PATH, type DomainUsageDeps } from "../lib/licence-plan";
import { isAdminFor } from "../lib/authz";
import { requireAdminScope, type MailboxContext } from "../lib/mailbox";

type AppContext = Context<MailboxContext>;

/** Overridable in tests. */
export const licenceRouteDeps: { deps: (c: AppContext) => LicenceDeps & Pick<DomainUsageDeps, "listDomains"> } = {
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

const KeyBody = z.object({ licenceKey: z.string().max(512), takeover: z.boolean().optional() }).strict();

async function readKey(c: AppContext): Promise<{ key: string; takeover: boolean } | Response> {
	const parsed = KeyBody.safeParse(await c.req.json().catch(() => null));
	const key = parsed.success ? normaliseLicenceKey(parsed.data.licenceKey) : null;
	if (!key) return c.json({ error: "Paste the licence key from your purchase email.", code: "invalid_request" }, 400);
	return { key, takeover: parsed.success && parsed.data.takeover === true };
}

/** The admin view, with the configured domains against the plan. */
async function adminView(c: AppContext, view: LicenceView, deps: LicenceDeps & Pick<DomainUsageDeps, "listDomains">): Promise<LicenceView> {
	if (view.status === "off" || view.maxDomains === null) return view;
	try {
		const usage = await domainUsage(c.env, deps, { plan: view.planName ?? "unlimited", max_domains: view.maxDomains, max_deployments: view.maxDeployments });
		return { ...view, domains: { configured: usage.domains, notCovered: usage.notCovered } };
	} catch (e) {
		console.warn("licence view: domain usage unavailable:", (e as Error).message);
		return view;
	}
}

export const licenceRoutes = new Hono<MailboxContext>();

licenceRoutes.get("/api/v1/licence", async (c) => {
	const deps = licenceRouteDeps.deps(c);
	const state = await licenceState(c.env, { ...deps, host: bindingHost(c) });
	const view = licenceView(state, deps.now?.());
	// Members see whether the app is locked, not the customer details.
	if (!isAdminFor(c.var.principal, "admin")) {
		return c.json({ status: view.status, locked: view.locked, graceDaysLeft: null });
	}
	return c.json(await adminView(c, view, deps));
});

licenceRoutes.use("/api/v1/licence/*", requireAdminScope("admin"));

licenceRoutes.post("/api/v1/licence/activate", async (c) => {
	const refused = requireBrowserSession(c);
	if (refused) return refused;
	const body = await readKey(c);
	if (body instanceof Response) return body;
	const deps = licenceRouteDeps.deps(c);
	const result = await activateLicence(
		c.env,
		{
			licenceKey: body.key,
			takeover: body.takeover,
			host: bindingHost(c),
			cfAccount: await resolveConnectionAccountId(c.env).catch(() => null),
			appVersion: APP_VERSION,
		},
		deps,
	);
	if (!result.ok) {
		if (result.inUse) return c.json(result.inUse, result.status as 400);
		return c.json({ error: result.message, code: result.error }, result.status as 400);
	}
	const view = licenceView(result.state, deps.now?.());
	recordAuditDeferred(c, {
		action: "licence.activate",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		mailboxId: null,
		detail: { plan: view.planName ?? view.plan, host: view.host, takeover: body.takeover },
	});
	return c.json(await adminView(c, view, deps));
});

licenceRoutes.post("/api/v1/licence/refresh", async (c) => {
	const deps = licenceRouteDeps.deps(c);
	const outcome = await refreshLicence(c.env, { ...deps, force: true });
	invalidateLicenceCache(c.env);
	const view = licenceView(await licenceState(c.env, { ...deps, host: bindingHost(c) }), deps.now?.());
	return c.json({ outcome, ...(await adminView(c, view, deps)) });
});

licenceRoutes.post("/api/v1/licence/deactivate", async (c) => {
	const refused = requireBrowserSession(c);
	if (refused) return refused;
	const body = await readKey(c);
	if (body instanceof Response) return body;
	const deps = licenceRouteDeps.deps(c);
	const result = await deactivateLicence(c.env, body.key, deps);
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

licenceRoutes.post("/api/v1/licence/upgrade", async (c) => {
	const refused = requireBrowserSession(c);
	if (refused) return refused;
	const deps = licenceRouteDeps.deps(c);
	// Back to this page on this deployment; the licence server only accepts the token's own host.
	const origin = configuredOrigin(c.env) ?? new URL(c.req.url).origin;
	const page = new URL(LICENCE_SETTINGS_PATH, origin);
	const done = new URL(page);
	done.searchParams.set("upgrade", "done");
	const result = await startLicenceUpgrade(c.env, { returnUrl: done.toString(), cancelUrl: page.toString() }, deps);
	if (!result.ok) return c.json({ error: result.message, code: result.error }, result.status as 400);
	recordAuditDeferred(c, {
		action: "licence.upgrade_started",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		mailboxId: null,
		detail: {},
	});
	return c.json({ checkoutUrl: result.checkoutUrl });
});
