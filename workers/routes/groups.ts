/**
 * Group addresses: team@example.com delivered into each member's own mailbox.
 *
 *   GET    /api/v1/groups              every group (admins)
 *   PUT    /api/v1/groups/:address     create or replace { name?, members }
 *   DELETE /api/v1/groups/:address
 *
 * A group is routing, not a mailbox: nothing is stored under its address, and
 * each member gets an ordinary copy in their own inbox (see
 * workers/lib/inbound-routing.ts). For one shared inbox several people work
 * from (support@), create a mailbox and share it instead.
 *
 * The address must be on a served domain and must not already be a mailbox or
 * an alias; members must be existing mailboxes. Administrator-only, like
 * aliases and mailbox creation.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { auditActorRole, recordAuditDeferred } from "../lib/audit";
import { requireAdminScope, type MailboxContext } from "../lib/mailbox";
import { domainOfAddress, isDomainAllowed } from "../lib/zones";
import type { MailGroup } from "../lib/domain-store";

/**
 * Members per group. A fan-out runs each member's whole delivery (storage,
 * rules, triage, notifications) in one email-handler invocation, so this stays
 * well inside the Worker's per-invocation subrequest and CPU limits.
 */
export const MAX_GROUP_MEMBERS = 25;

interface GroupStore {
	listGroups(): Promise<MailGroup[]>;
	getGroup(address: string): Promise<MailGroup | null>;
	putGroup(input: { address: string; name: string; members: string[] }, now: number): Promise<MailGroup>;
	deleteGroup(address: string): Promise<boolean>;
	allAliases(): Promise<Record<string, string>>;
}

/** Injectable for tests; the AuthDO in production. */
export const groupDeps = {
	store(env: Env): GroupStore {
		const ns = env.AUTH_STORE as unknown as DurableObjectNamespace | undefined;
		if (!ns) throw new Error("Groups need the AUTH_STORE binding");
		return ns.get(ns.idFromName("global")) as unknown as GroupStore;
	},
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GroupBody = z.object({
	name: z.string().trim().max(120).optional(),
	members: z.array(z.string().trim().toLowerCase()).min(1).max(MAX_GROUP_MEMBERS),
});

const mailboxExists = async (env: Env, address: string) => (await env.BUCKET.head(`mailboxes/${address}.json`)) !== null;

export const groupRoutes = new Hono<MailboxContext>();
const requireGroupAdmin = requireAdminScope("mailboxes:manage");

groupRoutes.get("/api/v1/groups", requireGroupAdmin, async (c) => {
	return c.json({ groups: await groupDeps.store(c.env).listGroups() });
});

groupRoutes.put("/api/v1/groups/:address", requireGroupAdmin, async (c) => {
	const address = decodeURIComponent(c.req.param("address")!).trim().toLowerCase();
	if (!EMAIL.test(address)) return c.json({ error: "Enter the group's full address, e.g. team@example.com." }, 400);
	if (!isDomainAllowed(c.env, domainOfAddress(address))) {
		return c.json({ error: `${domainOfAddress(address)} isn't one of this deployment's domains.` }, 400);
	}
	const body = GroupBody.parse(await c.req.json());
	const store = groupDeps.store(c.env);

	if (await mailboxExists(c.env, address)) {
		return c.json({ error: `${address} is already a mailbox. Pick another address for the group.`, code: "address_taken" }, 409);
	}
	const aliasOf = (await store.allAliases())[address];
	if (aliasOf) {
		return c.json({ error: `${address} is already an alias of ${aliasOf}.`, code: "address_taken" }, 409);
	}

	const members = [...new Set(body.members)].filter((m) => m !== address);
	const missing: string[] = [];
	for (const m of members) if (!EMAIL.test(m) || !(await mailboxExists(c.env, m))) missing.push(m);
	if (missing.length > 0) {
		return c.json({ error: `Not a mailbox here: ${missing.join(", ")}. Members must be mailboxes on this deployment.` }, 400);
	}
	if (members.length === 0) return c.json({ error: "Add at least one member." }, 400);

	const existed = (await store.getGroup(address)) !== null;
	const group = await store.putGroup({ address, name: body.name ?? "", members }, Date.now());
	await recordAuditDeferred(c, {
		action: "group.change",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		mailboxId: null,
		target: address,
		detail: { op: existed ? "update" : "create", members: group.members.join(", ") },
	});
	return c.json({ group }, existed ? 200 : 201);
});

groupRoutes.delete("/api/v1/groups/:address", requireGroupAdmin, async (c) => {
	const address = decodeURIComponent(c.req.param("address")!).trim().toLowerCase();
	if (!(await groupDeps.store(c.env).deleteGroup(address))) return c.json({ error: "No such group" }, 404);
	await recordAuditDeferred(c, {
		action: "group.change",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		mailboxId: null,
		target: address,
		detail: { op: "delete" },
	});
	return c.body(null, 204);
});
