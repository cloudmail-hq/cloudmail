// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Bring-your-own AI gateway: Settings → AI providers over HTTP.
 *
 *   GET    /api/v1/ai/providers                  providers, routing, problems
 *   POST   /api/v1/ai/providers                  add one (Idempotency-Key honoured)
 *   PATCH  /api/v1/ai/providers/:id              change one; token: string replaces, null clears
 *   DELETE /api/v1/ai/providers/:id              remove one (not while active)
 *   POST   /api/v1/ai/providers/:id/discover     fetch its model list
 *   PATCH  /api/v1/ai/providers/:id/models       custom ids, capability overrides
 *   POST   /api/v1/ai/providers/:id/test         probe one model's capabilities
 *   GET    /api/v1/ai/routing                    routing and its problems
 *   PATCH  /api/v1/ai/routing                    per-role models, activate, fallback, embeddings
 *
 * ## Access
 *
 * All of it is admin-only (`isAdminFor(principal, "admin")`). Reading,
 * discovery and Test also work with an admin-scoped API token. Every change
 * to the config needs a signed-in person: an API token or connected app
 * could otherwise point the deployment's mail at a gateway it controls
 * (the #122 rule for the agent send policy).
 *
 * ## Secrets
 *
 * Tokens and secret header values are encrypted before they are stored
 * (./../lib/ai-provider-secrets.ts) and are never returned: views carry
 * `tokenSet` and `tokenHint` only. Errors from a gateway are reported as a
 * status and a redacted message; a gateway's response body is never echoed.
 * The audit log gets the provider id, host, wire and header names.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import {
	AI_ROLES,
	AiProviderOptionsSchema,
	AuthSchema,
	GATEWAY_ROLES,
	MODEL_ID,
	PROVIDER_ID,
	WORKERS_AI_MODEL_ID,
	WORKERS_AI_PINNED_ROLES,
	WORKERS_AI_PROVIDER_ID,
	isAiRole,
	providerModels,
	type AiProvider,
	type AiProvidersFile,
	type AiRole,
	type CatalogModel,
	type WorkersAiTested,
} from "../../shared/ai-providers";
import {
	WORKERS_AI_DEFAULTS,
	WORKERS_AI_TASKS,
	checkWorkersAiPick,
	filterByTask,
	needsReindexConfirm,
	unlistedModel,
	unlistedWarning,
	withTested,
} from "../../shared/workers-ai";
import { monthWindow } from "../../shared/usage";
import {
	ROLE_LABELS,
	ROLE_NEEDS,
	activationProblems,
	apiBaseFor,
	canonicalBaseUrl,
	checkRoleModel,
	headerNameProblem,
	headerValueProblem,
	needsCustomIds,
	tokenHint,
	type RoleProblem,
} from "../../shared/ai-gateway";
import { hintFor } from "../../shared/ai-model-hints";
import { validatePublicHttpsUrl } from "../../shared/outbound-url";
import { isAdminFor } from "../lib/authz";
import { auditActorRole, recordAuditDeferred, type RecordAuditInput } from "../lib/audit";
import { AiProvidersConflictError, emptyAiProvidersFile, getAiProvidersFile, updateAiProvidersFile } from "../lib/ai-providers-store";
import { hasAuthSecret, providerKeyMaterial, sealProviderHeader, sealProviderToken } from "../lib/ai-provider-secrets";
import { factoryFromClient, loadGatewayClient, ownHosts } from "../lib/ai-gateway-factory";
import { discoverModels } from "../lib/ai-discovery";
import { applyProbeResults, defaultChecks, PROBE_CHECKS, runProbes, runWorkersAiProbes } from "../lib/ai-probes";
import { aiBreaker } from "../lib/ai-breaker";
import { aiAvailable, workersAiModelFor } from "../lib/ai-router";
import { usageStore } from "../lib/usage";
import { workersAiCatalogue } from "../lib/workers-ai-catalogue";
import type { MailboxContext } from "../lib/mailbox";

type AppContext = Context<MailboxContext>;

export const aiProviderRoutes = new Hono<MailboxContext>();

/** Tests: replace the Workers AI catalogue (synthetic fixtures). */
let catalogueLoader: typeof workersAiCatalogue = workersAiCatalogue;
export function setWorkersAiCatalogueForTests(loader: typeof workersAiCatalogue | undefined): void {
	catalogueLoader = loader ?? workersAiCatalogue;
}

// ── Gates ──────────────────────────────────────────────────────────

const ADMIN_REQUIRED = { error: "Administrator access required", scope: "admin" };
const PERSON_REQUIRED = {
	error: "AI provider settings can only be changed by a signed-in person in the app, not with an API token or connected app.",
	code: "person_required",
};

/** Admin for every route here. Exported so workers/index.ts runs it before the idempotency layer. */
export async function requireAiAdmin(c: AppContext, next: () => Promise<void>) {
	if (!isAdminFor(c.var.principal, "admin")) return c.json(ADMIN_REQUIRED, 403);
	return next();
}

/**
 * Discovery and Test change only the cached catalogue and tested caps;
 * every other write needs a person. Matched exactly (POST, the action
 * segment after a provider id), so a provider whose id is `test` or
 * `discover` is not mistaken for the action.
 */
// `workers-ai` matches too: its Test only records results, like a gateway's.
const TOKEN_OK_ACTION = /^\/api\/v1\/ai\/providers\/[a-z0-9-]{1,32}\/(discover|test)\/?$/;
export function isPersonOnly(method: string, path: string): boolean {
	const m = method.toUpperCase();
	if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
	return !(m === "POST" && TOKEN_OK_ACTION.test(path));
}

export async function requireAiPerson(c: AppContext, next: () => Promise<void>) {
	if (!isPersonOnly(c.req.method, new URL(c.req.url).pathname)) return next();
	const method = c.var.authMethod ?? c.var.principal.credential?.method;
	if (method === "token" || method === "oauth") return c.json(PERSON_REQUIRED, 403);
	return next();
}

aiProviderRoutes.use("/api/v1/ai/providers", requireAiAdmin, requireAiPerson);
aiProviderRoutes.use("/api/v1/ai/providers/*", requireAiAdmin, requireAiPerson);
aiProviderRoutes.use("/api/v1/ai/routing", requireAiAdmin, requireAiPerson);

// ── Views ──────────────────────────────────────────────────────────

export function providerView(p: AiProvider) {
	const models = providerModels(p);
	const breakerState = aiBreaker.state(p.id);
	return {
		id: p.id,
		label: p.label,
		wire: p.wire,
		baseUrl: p.baseUrl,
		exactBaseUrl: p.exactBaseUrl,
		apiBase: safeApiBase(p),
		auth: p.auth,
		tokenSet: !!p.tokenEnc,
		tokenHint: p.tokenEnc ? p.tokenHint : null,
		headers: p.headers.map((h) => ({
			name: h.name,
			secret: h.secret,
			...(h.secret ? {} : { value: h.value ?? "" }),
			set: h.secret ? !!h.valueEnc : h.value !== undefined,
		})),
		options: p.options,
		enabled: p.enabled,
		catalogue: {
			fetchedAt: p.catalogue.fetchedAt,
			status: p.catalogue.status,
			detail: p.catalogue.detail ?? null,
			count: p.catalogue.models.length,
		},
		models,
		needsCustomIds: needsCustomIds(p.baseUrl),
		breaker: { state: breakerState, openUntil: null as number | null },
		createdAt: p.createdAt,
		updatedAt: p.updatedAt,
	};
}

function safeApiBase(p: AiProvider): string {
	try {
		return apiBaseFor(p.baseUrl, p.wire, p.exactBaseUrl);
	} catch {
		return p.baseUrl;
	}
}

function embeddingsMode(file: AiProvidersFile): "gateway" | "workers-ai" | "off" {
	if (file.routing.disabledRoles.includes("embeddings")) return "off";
	if (file.routing.workersAiExceptions.includes("embeddings")) return "workers-ai";
	return "gateway";
}

function routingView(file: AiProvidersFile) {
	return { ...file.routing, embeddingsMode: embeddingsMode(file) };
}

/** Problems stopping the active (or a candidate) provider from serving every role. */
function problemsFor(file: AiProvidersFile, providerId: string | null): RoleProblem[] {
	if (!providerId) return [];
	const p = file.providers.find((x) => x.id === providerId);
	if (!p) return [{ role: "agent_chat", reason: "That provider no longer exists." }];
	return activationProblems(p, file.routing, providerModels(p));
}

const ROLES = GATEWAY_ROLES.concat(["injection_scanner"]).map((role) => ({
	role,
	label: ROLE_LABELS[role],
	needs: ROLE_NEEDS[role],
	pinned: role === "injection_scanner",
}));

// ── Input ──────────────────────────────────────────────────────────

const HeaderInput = z
	.object({
		name: z.string().trim().min(1).max(64),
		value: z.string().max(4096).optional(),
		secret: z.boolean().optional(),
	})
	.strict();

const ProviderCreate = z
	.object({
		label: z.string().trim().min(1).max(60),
		wire: z.enum(["openai", "anthropic"]),
		baseUrl: z.string().trim().min(1).max(2048),
		exactBaseUrl: z.boolean().optional(),
		auth: AuthSchema,
		token: z.string().max(8192).optional(),
		headers: z.array(HeaderInput).max(8).optional(),
		options: AiProviderOptionsSchema.partial().optional(),
		/** Optional; generated from the label otherwise. */
		id: z.string().regex(PROVIDER_ID).optional(),
	})
	.strict();

const ProviderPatch = ProviderCreate.omit({ id: true })
	.partial()
	.extend({ token: z.string().max(8192).nullable().optional(), enabled: z.boolean().optional() })
	.strict();

class InputError extends Error {
	constructor(
		message: string,
		readonly field?: string,
		readonly status: 400 | 404 | 409 | 422 = 400,
		readonly code?: string,
		readonly extra?: Record<string, unknown>,
	) {
		super(message);
	}
}

function slug(label: string): string {
	const base = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
	return base && base !== WORKERS_AI_PROVIDER_ID ? base : "gateway";
}

function uniqueId(file: AiProvidersFile, wanted: string): string {
	const taken = new Set(file.providers.map((p) => p.id));
	if (!taken.has(wanted)) return wanted;
	for (let i = 2; i < 100; i++) {
		const id = `${wanted.slice(0, 28)}-${i}`;
		if (!taken.has(id)) return id;
	}
	return `gw-${crypto.randomUUID().slice(0, 8)}`;
}

async function checkUrl(c: AppContext, baseUrl: string, allowCustomPorts: boolean): Promise<string> {
	const check = validatePublicHttpsUrl(baseUrl, {
		purpose: "ai-gateway",
		ownHosts: await ownHosts(c.env, c.req.url),
		allowCustomPorts,
	});
	if (!check.ok) throw new InputError(check.error, "baseUrl");
	const canonical = canonicalBaseUrl(check.url);
	if (!canonical) throw new InputError("That is not a valid URL.", "baseUrl");
	return canonical;
}

/** Validate and seal the header list. A secret header sent without a value keeps its stored one. */
async function sealHeaders(
	input: z.infer<typeof HeaderInput>[],
	previous: AiProvider["headers"],
	auth: AiProvider["auth"],
	providerId: string,
	key: () => Promise<string>,
): Promise<AiProvider["headers"]> {
	const seen = new Set<string>();
	const out: AiProvider["headers"] = [];
	for (const h of input) {
		const problem = headerNameProblem(h.name, auth);
		if (problem) throw new InputError(problem, "headers");
		const lower = h.name.toLowerCase();
		if (seen.has(lower)) throw new InputError(`${h.name} is listed twice.`, "headers");
		seen.add(lower);
		if (h.value !== undefined) {
			const vp = headerValueProblem(h.value);
			if (vp) throw new InputError(vp, "headers");
		}
		if (h.secret) {
			if (h.value === undefined || h.value === "") {
				const kept = previous.find((p) => p.name.toLowerCase() === lower && p.secret && p.valueEnc);
				if (!kept) throw new InputError(`Enter a value for ${h.name}.`, "headers");
				// Re-sealed under the (possibly re-cased) name it is stored with.
				out.push({ name: kept.name, valueEnc: kept.valueEnc, secret: true });
				continue;
			}
			out.push({ name: h.name, valueEnc: await sealProviderHeader(h.value, await key(), providerId, h.name), secret: true });
		} else {
			out.push({ name: h.name, value: h.value ?? "", secret: false });
		}
	}
	return out;
}

function auditBase(c: AppContext): Pick<RecordAuditInput, "actor" | "actorRole"> {
	return { actor: c.var.principal.identity?.id ?? null, actorRole: auditActorRole(c.var.principal, null) };
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
}

function fail(c: AppContext, e: unknown) {
	if (e instanceof InputError) {
		return c.json({ error: e.message, ...(e.field ? { field: e.field } : {}), ...(e.code ? { code: e.code } : {}), ...e.extra }, e.status);
	}
	if (e instanceof AiProvidersConflictError) return c.json({ error: e.message, code: "conflict" }, 409);
	if (e instanceof z.ZodError) {
		const issue = e.issues[0];
		return c.json({ error: issue?.message ?? "Invalid request", field: issue?.path.join(".") }, 400);
	}
	throw e;
}

async function body(c: AppContext): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new InputError("Send a JSON body.");
	}
}

// ── Providers ──────────────────────────────────────────────────────

aiProviderRoutes.get("/api/v1/ai/providers", async (c) => {
	const file = (await getAiProvidersFile(c.env.BUCKET, { fresh: true })) ?? emptyAiProvidersFile();
	return c.json({
		providers: file.providers.map(providerView),
		routing: routingView(file),
		problems: problemsFor(file, file.routing.gatewayProviderId),
		roles: ROLES,
		authSecretSet: hasAuthSecret(c.env),
		workersAi: workersAiView(c.env, file),
		status: aiStatus(file),
		usage: await usageThisMonth(c.env),
	});
});

// ── Workers AI (the built-in provider) ─────────────────────────────
//
// Registered before the `/:id` routes: `workers-ai` is a reserved provider id.

/** The built-in provider: each role's model on Workers AI and where it came from. */
export function workersAiView(env: { SUMMARY_MODEL?: string }, file: AiProvidersFile) {
	const picks = file.workersAi.models;
	const envSummary = env.SUMMARY_MODEL?.trim() || null;
	return {
		id: WORKERS_AI_PROVIDER_ID,
		label: "Cloudflare Workers AI",
		builtIn: true as const,
		roles: AI_ROLES.map((role) => {
			const locked = WORKERS_AI_PINNED_ROLES.includes(role);
			const picked = locked ? null : (picks[role] ?? null);
			return {
				role,
				modelId: workersAiModelFor(env, role, null, picks),
				defaultModelId: WORKERS_AI_DEFAULTS[role],
				source: picked ? "admin" : role === "summary" && envSummary ? "env" : "default",
				locked,
			};
		}),
		tested: file.workersAi.tested,
	};
}

/**
 * One line for the page and `tapemail ai status`: where AI runs, and the
 * exceptions. Mirrors the router: a gateway that is missing or turned off
 * means Workers AI.
 */
export function aiStatus(file: AiProvidersFile) {
	const r = file.routing;
	const gateway = r.gatewayProviderId ? file.providers.find((p) => p.id === r.gatewayProviderId && p.enabled) : undefined;
	const exceptions: { role: AiRole | null; text: string }[] = [
		{ role: "injection_scanner", text: "The prompt-injection scanner always runs on Workers AI." },
	];
	if (gateway) {
		if (r.disabledRoles.includes("embeddings")) exceptions.push({ role: "embeddings", text: "Semantic search is off." });
		else if (r.workersAiExceptions.includes("embeddings")) exceptions.push({ role: "embeddings", text: "Embeddings run on Workers AI." });
		if (r.fallbackToWorkersAi) exceptions.push({ role: null, text: "Failed text calls retry on Workers AI; embeddings stay on their configured model." });
	}
	return {
		mode: gateway ? ("gateway" as const) : ("workers-ai" as const),
		activeProviderId: gateway?.id ?? WORKERS_AI_PROVIDER_ID,
		activeLabel: gateway?.label ?? "Cloudflare Workers AI",
		line: gateway ? `All AI runs on ${gateway.label}.` : "All AI runs on Cloudflare Workers AI.",
		exceptions,
	};
}

/** This month's model requests per provider, from the router's counters. Empty when unavailable. */
async function usageThisMonth(env: AppContext["env"]) {
	const window = monthWindow();
	const store = usageStore(env);
	let rows: Awaited<ReturnType<NonNullable<NonNullable<typeof store>["aiUsageByProvider"]>>> = [];
	try {
		if (store?.aiUsageByProvider) rows = await store.aiUsageByProvider(window.startDate, window.today);
	} catch {
		rows = [];
	}
	return {
		month: window.month,
		byProvider: (Array.isArray(rows) ? rows : []).map((r) => ({
			providerId: r.provider_id,
			calls: r.calls_mtd,
			inputTokens: r.input_tokens_mtd,
			outputTokens: r.output_tokens_mtd,
			costUsd: r.cost_mtd_usd,
		})),
	};
}

const CatalogueQuery = z.object({
	task: z.enum(WORKERS_AI_TASKS).optional(),
	search: z.string().trim().max(100).optional(),
	refresh: z.enum(["1", "true"]).optional(),
});

/** The catalogue with Test results folded in, the default models included even when unlisted. */
async function catalogueWithTested(c: AppContext, refresh = false) {
	const file = (await getAiProvidersFile(c.env.BUCKET, { fresh: true })) ?? emptyAiProvidersFile();
	const catalogue = await catalogueLoader(c.env, { refresh });
	const tested = file.workersAi.tested;
	return { file, catalogue: { ...catalogue, models: catalogue.models.map((m) => withTested(m, tested[m.id])) } };
}

aiProviderRoutes.get(`/api/v1/ai/providers/${WORKERS_AI_PROVIDER_ID}/models`, async (c) => {
	try {
		const q = CatalogueQuery.parse({
			task: c.req.query("task") || undefined,
			search: c.req.query("search") || undefined,
			refresh: c.req.query("refresh") || undefined,
		});
		const { file, catalogue } = await catalogueWithTested(c, !!q.refresh);
		const needle = q.search?.toLowerCase();
		const models = filterByTask(catalogue.models, q.task).filter(
			(m) => !needle || m.id.toLowerCase().includes(needle) || (m.description ?? "").toLowerCase().includes(needle),
		);
		// Each role's model, with the unlisted warning and the suggested successor.
		const roles = workersAiView(c.env, file).roles.map((r) => {
			const task = r.role === "embeddings" ? "Text Embeddings" : "Text Generation";
			return { role: r.role, modelId: r.modelId, unlisted: unlistedWarning(r.modelId, catalogue, task) };
		});
		return c.json({
			source: catalogue.source,
			fetchedAt: catalogue.fetchedAt,
			detail: catalogue.detail ?? null,
			count: models.length,
			models,
			roles,
		});
	} catch (e) {
		return fail(c, e);
	}
});

const WorkersAiRoutingPatch = z
	.object({
		/** Role → model id, or null for the default. */
		models: z.record(z.string(), z.string().trim().max(200).nullable()),
		/** Required to change the embeddings model: every mailbox re-indexes. */
		confirmReindex: z.boolean().optional(),
	})
	.strict();

aiProviderRoutes.patch(`/api/v1/ai/providers/${WORKERS_AI_PROVIDER_ID}/routing`, async (c) => {
	try {
		const input = WorkersAiRoutingPatch.parse(await body(c));
		const entries = Object.entries(input.models);
		if (entries.length === 0) throw new InputError("Name at least one role.", "models");
		for (const [role, modelId] of entries) {
			if (!isAiRole(role)) throw new InputError(`Unknown role ${role}.`, "models");
			if (modelId !== null && !WORKERS_AI_MODEL_ID.test(modelId)) {
				throw new InputError("Workers AI model ids start with @cf/ or @hf/.", "models");
			}
		}
		const { catalogue } = await catalogueWithTested(c);
		let reindex = false;
		const result = await updateAiProvidersFile(c.env.BUCKET, (file) => {
			const picks = file.workersAi.models;
			const active = file.routing.gatewayProviderId
				? file.providers.find((p) => p.id === file.routing.gatewayProviderId && p.enabled)
				: undefined;
			const workersAiServesEmbeddings = !active || file.routing.workersAiExceptions.includes("embeddings");
			const problems: RoleProblem[] = [];
			for (const [role, modelId] of entries as [AiRole, string | null][]) {
				const current = workersAiModelFor(c.env, role, null, picks);
				const next = modelId ?? workersAiModelFor(c.env, role, null, {});
				const tested = file.workersAi.tested[next];
				const listed = catalogue.models.find((m) => m.id === next);
				const model = listed ? withTested(listed, tested) : unlistedModel(next, role, tested);
				// A reset is checked too: it can change the embeddings model.
				const verdict =
					role === "injection_scanner" || modelId !== null || next !== current
						? checkWorkersAiPick(role, {
								model,
								current,
								// The confirmation only matters when this pick is the live index model.
								confirmReindex: input.confirmReindex || (role === "embeddings" && !workersAiServesEmbeddings),
							})
						: ({ ok: true } as const);
				if (!verdict.ok) {
					problems.push({ role, reason: verdict.reason });
					continue;
				}
				if (role === "embeddings" && next !== current && workersAiServesEmbeddings) reindex = true;
				if (modelId === null) delete picks[role];
				else picks[role] = modelId;
			}
			if (problems.length) {
				const onlyConfirm = problems.every((p) => needsReindexConfirm({ ok: false, reason: p.reason }));
				throw new InputError(
					onlyConfirm ? "Changing the embeddings model re-indexes every mailbox." : "Some choices don't meet their role's needs.",
					"models",
					422,
					onlyConfirm ? "reindex_confirm_required" : "capability_check_failed",
					{ problems },
				);
			}
			return { file, result: file };
		});
		await recordAuditDeferred(c, {
			action: "ai.routing",
			...auditBase(c),
			target: WORKERS_AI_PROVIDER_ID,
			detail: {
				provider: WORKERS_AI_PROVIDER_ID,
				roles: entries.map(([role, id]) => `${role}=${id ?? "default"}`).join(","),
				reindex,
			},
		});
		return c.json({ workersAi: workersAiView(c.env, result), status: aiStatus(result), reindex });
	} catch (e) {
		return fail(c, e);
	}
});

const WorkersAiTestBody = z
	.object({
		modelId: z.string().trim().regex(WORKERS_AI_MODEL_ID, "Workers AI model ids start with @cf/ or @hf/."),
		checks: z.array(z.enum(PROBE_CHECKS)).min(1).max(4).optional(),
	})
	.strict();

/** Test results kept per model; the oldest go first. */
const MAX_TESTED = 40;

aiProviderRoutes.post(`/api/v1/ai/providers/${WORKERS_AI_PROVIDER_ID}/test`, async (c) => {
	try {
		const input = WorkersAiTestBody.parse(await body(c));
		if (!aiAvailable(c.env)) throw new InputError("The Workers AI binding isn't available in this deployment.", undefined, 409);
		const { catalogue } = await catalogueWithTested(c);
		const listed = catalogue.models.find((m) => m.id === input.modelId);
		const embedding = listed ? listed.task === "Text Embeddings" : /embed|bge-/i.test(input.modelId);
		const checks = input.checks ?? (embedding ? (["embed"] as const) : (["text", "json", "tools"] as const));
		const results = await runWorkersAiProbes(c.env, input.modelId, checks);
		const testedAt = new Date().toISOString();
		const file = await updateAiProvidersFile(c.env.BUCKET, (f) => {
			const prev = f.workersAi.tested[input.modelId];
			const entry: WorkersAiTested = { ...(prev ?? {}), testedAt };
			for (const r of results) {
				entry[r.check] = r.ok;
				if (r.check === "embed") {
					// A failed embedding check makes its old vector size unusable.
					if (r.ok && r.dims) entry.dims = r.dims;
					else delete entry.dims;
				}
			}
			f.workersAi.tested[input.modelId] = entry;
			const ids = Object.keys(f.workersAi.tested);
			if (ids.length > MAX_TESTED) {
				ids.sort((a, b) => f.workersAi.tested[a]!.testedAt.localeCompare(f.workersAi.tested[b]!.testedAt));
				for (const id of ids.slice(0, ids.length - MAX_TESTED)) delete f.workersAi.tested[id];
			}
			return { file: f, result: f };
		});
		await recordAuditDeferred(c, {
			action: "ai.provider_update",
			...auditBase(c),
			target: WORKERS_AI_PROVIDER_ID,
			detail: {
				provider: WORKERS_AI_PROVIDER_ID,
				changed: "tested",
				model: input.modelId,
				checks: results.map((r) => `${r.check}=${r.ok ? "pass" : "fail"}`).join(","),
			},
		});
		return c.json({ results, tested: file.workersAi.tested[input.modelId] ?? null });
	} catch (e) {
		return fail(c, e);
	}
});

aiProviderRoutes.post("/api/v1/ai/providers", async (c) => {
	try {
		const input = ProviderCreate.parse(await body(c));
		const options = AiProviderOptionsSchema.parse(input.options ?? {});
		const baseUrl = await checkUrl(c, input.baseUrl, options.allowCustomPorts);
		if (input.auth.scheme === "custom") {
			const p = headerNameProblem(input.auth.header);
			if (p) throw new InputError(p, "auth");
		}
		let keyMaterial: string | null = null;
		const key = async () => (keyMaterial ??= await providerKeyMaterial(c.env));
		const now = new Date().toISOString();
		const provider = await updateAiProvidersFile(c.env.BUCKET, async (file) => {
			if (file.providers.length >= 10) throw new InputError("At most 10 providers.", undefined, 409);
			const id = uniqueId(file, input.id ?? slug(input.label));
			const token = input.token?.trim() || null;
			const p: AiProvider = {
				id,
				label: input.label,
				wire: input.wire,
				baseUrl,
				exactBaseUrl: input.exactBaseUrl ?? false,
				auth: input.auth,
				tokenEnc: token ? await sealProviderToken(token, await key(), id) : null,
				tokenHint: token ? tokenHint(token) : null,
				headers: await sealHeaders(input.headers ?? [], [], input.auth, id, key),
				options,
				enabled: true,
				catalogue: { fetchedAt: null, status: "never", detail: null, models: [] },
				customModels: [],
				createdAt: now,
				updatedAt: now,
			};
			file.providers.push(p);
			return { file, result: p };
		});
		await recordAuditDeferred(c, {
			action: "ai.provider_create",
			...auditBase(c),
			target: provider.id,
			detail: {
				provider: provider.id,
				host: hostOf(provider.baseUrl),
				wire: provider.wire,
				auth: provider.auth.scheme,
				headers: provider.headers.map((h) => h.name).join(",") || null,
			},
		});
		return c.json({ provider: providerView(provider) }, 201);
	} catch (e) {
		return fail(c, e);
	}
});

aiProviderRoutes.patch("/api/v1/ai/providers/:id", async (c) => {
	try {
		const id = c.req.param("id")!;
		const input = ProviderPatch.parse(await body(c));
		let keyMaterial: string | null = null;
		const key = async () => (keyMaterial ??= await providerKeyMaterial(c.env));
		const changed: string[] = [];
		const provider = await updateAiProvidersFile(c.env.BUCKET, async (file) => {
			const p = file.providers.find((x) => x.id === id);
			if (!p) throw new InputError("No such provider.", undefined, 404);
			if (input.label !== undefined) (p.label = input.label), changed.push("label");
			if (input.wire !== undefined && input.wire !== p.wire) (p.wire = input.wire), changed.push("wire");
			if (input.options) (p.options = AiProviderOptionsSchema.parse({ ...p.options, ...input.options })), changed.push("options");
			if (input.baseUrl !== undefined || input.options?.allowCustomPorts !== undefined) {
				const next = await checkUrl(c, input.baseUrl ?? p.baseUrl, p.options.allowCustomPorts);
				if (next !== p.baseUrl) changed.push("baseUrl");
				p.baseUrl = next;
			}
			if (input.exactBaseUrl !== undefined) (p.exactBaseUrl = input.exactBaseUrl), changed.push("exactBaseUrl");
			if (input.auth !== undefined) {
				if (input.auth.scheme === "custom") {
					const prob = headerNameProblem(input.auth.header);
					if (prob) throw new InputError(prob, "auth");
				}
				p.auth = input.auth;
				changed.push("auth");
			}
			if (input.token !== undefined) {
				const token = input.token?.trim() || null;
				p.tokenEnc = token ? await sealProviderToken(token, await key(), p.id) : null;
				p.tokenHint = token ? tokenHint(token) : null;
				changed.push(token ? "token" : "token_cleared");
			}
			if (input.headers !== undefined) {
				p.headers = await sealHeaders(input.headers, p.headers, p.auth, p.id, key);
				changed.push("headers");
			} else if (input.auth !== undefined) {
				// The token's header may now clash with an extra header.
				for (const h of p.headers) {
					const prob = headerNameProblem(h.name, p.auth);
					if (prob) throw new InputError(prob, "headers");
				}
			}
			if (input.enabled !== undefined) {
				if (!input.enabled && file.routing.gatewayProviderId === p.id) {
					throw new InputError("Turn this provider off as the active gateway first.", undefined, 409, "provider_active");
				}
				p.enabled = input.enabled;
				changed.push("enabled");
			}
			// A different endpoint or wire makes the old catalogue meaningless.
			if (changed.includes("baseUrl") || changed.includes("wire") || changed.includes("exactBaseUrl")) {
				p.catalogue = { fetchedAt: null, status: "never", detail: null, models: [] };
			}
			p.updatedAt = new Date().toISOString();
			return { file, result: p };
		});
		await recordAuditDeferred(c, {
			action: "ai.provider_update",
			...auditBase(c),
			target: provider.id,
			detail: { provider: provider.id, host: hostOf(provider.baseUrl), changed: changed.join(",") || null },
		});
		return c.json({ provider: providerView(provider) });
	} catch (e) {
		return fail(c, e);
	}
});

aiProviderRoutes.delete("/api/v1/ai/providers/:id", async (c) => {
	try {
		const id = c.req.param("id")!;
		const removed = await updateAiProvidersFile(c.env.BUCKET, (file) => {
			const p = file.providers.find((x) => x.id === id);
			if (!p) throw new InputError("No such provider.", undefined, 404);
			if (file.routing.gatewayProviderId === id) {
				throw new InputError("Turn this provider off as the active gateway first.", undefined, 409, "provider_active");
			}
			file.providers = file.providers.filter((x) => x.id !== id);
			// Drop role picks that named it explicitly.
			for (const [role, ref] of Object.entries(file.routing.models)) {
				if (ref.providerId === id) delete file.routing.models[role];
			}
			return { file, result: p };
		});
		await recordAuditDeferred(c, {
			action: "ai.provider_delete",
			...auditBase(c),
			target: removed.id,
			detail: { provider: removed.id, host: hostOf(removed.baseUrl) },
		});
		return c.body(null, 204);
	} catch (e) {
		return fail(c, e);
	}
});

// ── Discovery, models, Test ────────────────────────────────────────

async function loadProvider(c: AppContext, id: string): Promise<AiProvider> {
	const file = await getAiProvidersFile(c.env.BUCKET, { fresh: true });
	const p = file?.providers.find((x) => x.id === id);
	if (!p) throw new InputError("No such provider.", undefined, 404);
	return p;
}

/** Tests: the network beneath discovery and probes. */
let routeNetwork: typeof fetch | undefined;
export function setAiProviderRouteNetworkForTests(f: typeof fetch | undefined): void {
	routeNetwork = f;
}

aiProviderRoutes.post("/api/v1/ai/providers/:id/discover", async (c) => {
	try {
		const p = await loadProvider(c, c.req.param("id")!);
		let catalogue;
		try {
			const client = await loadGatewayClient(c.env, p, { requestUrl: c.req.url, fetch: routeNetwork, timeoutMs: 8_000 });
			catalogue = await discoverModels(p, { fetch: client.fetch, headers: client.headers });
			if (catalogue.detail) catalogue.detail = client.redact(catalogue.detail);
		} catch (e) {
			// Decryption or client errors: never the error object itself.
			catalogue = { fetchedAt: new Date().toISOString(), status: "error" as const, detail: (e as Error)?.name === "GatewayFetchError" ? (e as Error).message : "Could not prepare the request.", models: [] };
		}
		const provider = await updateAiProvidersFile(c.env.BUCKET, (file) => {
			const cur = file.providers.find((x) => x.id === p.id);
			if (!cur) throw new InputError("No such provider.", undefined, 404);
			// Keep earlier probe results and admin overrides for models still listed.
			const prev = new Map(cur.catalogue.models.map((m) => [m.id, m]));
			cur.catalogue = {
				...catalogue,
				models: catalogue.models.map((m) => mergeKnownCaps(m, prev.get(m.id))),
			};
			cur.updatedAt = new Date().toISOString();
			return { file, result: cur };
		});
		return c.json({ provider: providerView(provider) });
	} catch (e) {
		return fail(c, e);
	}
});

/** Probe and admin values outlive a refresh; the gateway's fresh values replace hints. */
function mergeKnownCaps(fresh: CatalogModel, old: CatalogModel | undefined): CatalogModel {
	if (!old) return fresh;
	const caps = { ...fresh.caps };
	for (const k of Object.keys(caps) as (keyof CatalogModel["caps"])[]) {
		const o = old.caps[k];
		if (o.source === "admin" || o.source === "probe") caps[k] = o;
	}
	return { ...fresh, caps, embeddingDims: fresh.embeddingDims ?? old.embeddingDims ?? null, testedAt: old.testedAt ?? null };
}

const ModelsPatch = z
	.object({
		add: z
			.array(
				z
					.object({
						id: z.string().trim().regex(MODEL_ID, "Model ids are letters, digits and . - _ / : @, up to 200."),
						label: z.string().trim().max(200).optional(),
						kind: z.enum(["chat", "embedding"]).optional(),
					})
					.strict(),
			)
			.max(50)
			.optional(),
		remove: z.array(z.string().max(200)).max(50).optional(),
		caps: z
			.array(
				z
					.object({
						id: z.string().max(200),
						tools: z.boolean().nullable().optional(),
						json: z.boolean().nullable().optional(),
						vision: z.boolean().nullable().optional(),
						embed: z.boolean().nullable().optional(),
					})
					.strict(),
			)
			.max(100)
			.optional(),
	})
	.strict();

/** A custom id starts from the hints table, labelled as such, never as fact. */
export function customModel(id: string, label: string | undefined, kind: "chat" | "embedding"): CatalogModel {
	const hint = kind === "chat" ? hintFor(id) : null;
	const h = (v: boolean | undefined) => ({ value: v ?? null, source: "hint" as const });
	return {
		id,
		label: label || id,
		kind,
		contextTokens: hint?.contextTokens ?? null,
		maxOutputTokens: null,
		caps: {
			tools: h(kind === "embedding" ? false : hint?.tools),
			json: h(kind === "embedding" ? false : hint?.json),
			vision: h(kind === "embedding" ? false : hint?.vision),
			reasoning: h(kind === "embedding" ? false : hint?.reasoning),
			embed: h(kind === "embedding"),
		},
		embeddingDims: null,
		tier: hint?.tier ?? null,
		custom: true,
	};
}

aiProviderRoutes.patch("/api/v1/ai/providers/:id/models", async (c) => {
	try {
		const id = c.req.param("id")!;
		const input = ModelsPatch.parse(await body(c));
		const provider = await updateAiProvidersFile(c.env.BUCKET, (file) => {
			const p = file.providers.find((x) => x.id === id);
			if (!p) throw new InputError("No such provider.", undefined, 404);
			for (const a of input.add ?? []) {
				if (p.customModels.some((m) => m.id === a.id)) continue;
				if (p.customModels.length >= 50) throw new InputError("At most 50 custom models.", "add");
				p.customModels.push(customModel(a.id, a.label, a.kind ?? "chat"));
			}
			if (input.remove?.length) p.customModels = p.customModels.filter((m) => !input.remove!.includes(m.id));
			for (const o of input.caps ?? []) {
				const lists = [p.customModels, p.catalogue.models];
				let found = false;
				for (const list of lists) {
					const i = list.findIndex((m) => m.id === o.id);
					if (i < 0) continue;
					found = true;
					const m = list[i]!;
					const caps = { ...m.caps };
					for (const k of ["tools", "json", "vision", "embed"] as const) {
						const v = o[k];
						if (v === undefined) continue;
						// null clears the override: back to an unknown hint (Discover or Test refills it).
						caps[k] = v === null ? { value: null, source: "hint" } : { value: v, source: "admin" };
					}
					list[i] = { ...m, caps };
				}
				if (!found) throw new InputError(`Unknown model ${o.id}.`, "caps");
			}
			p.updatedAt = new Date().toISOString();
			return { file, result: p };
		});
		await recordAuditDeferred(c, {
			action: "ai.provider_update",
			...auditBase(c),
			target: provider.id,
			detail: {
				provider: provider.id,
				changed: "models",
				added: (input.add ?? []).map((a) => a.id).join(",") || null,
				removed: (input.remove ?? []).join(",") || null,
				overrides: (input.caps ?? []).map((o) => o.id).join(",") || null,
			},
		});
		return c.json({ provider: providerView(provider) });
	} catch (e) {
		return fail(c, e);
	}
});

const TestBody = z
	.object({
		modelId: z.string().regex(MODEL_ID),
		checks: z.array(z.enum(PROBE_CHECKS)).min(1).max(4).optional(),
	})
	.strict();

aiProviderRoutes.post("/api/v1/ai/providers/:id/test", async (c) => {
	try {
		const input = TestBody.parse(await body(c));
		const p = await loadProvider(c, c.req.param("id")!);
		const known = providerModels(p).find((m) => m.id === input.modelId);
		if (!known) throw new InputError("Add this model id first.", "modelId", 404);
		let checks = input.checks ?? defaultChecks(known);
		if (p.wire === "anthropic") checks = checks.filter((x) => x !== "embed");
		let results;
		try {
			const client = await loadGatewayClient(c.env, p, { requestUrl: c.req.url, fetch: routeNetwork, timeoutMs: 25_000 });
			results = await runProbes(c.env, p, input.modelId, checks, factoryFromClient(client), client.secrets);
		} catch {
			results = checks.map((check) => ({ check, ok: false, ms: 0, error: "Could not prepare the request." }));
		}
		const now = new Date().toISOString();
		const provider = await updateAiProvidersFile(c.env.BUCKET, (file) => {
			const cur = file.providers.find((x) => x.id === p.id);
			if (!cur) throw new InputError("No such provider.", undefined, 404);
			for (const list of [cur.customModels, cur.catalogue.models]) {
				const i = list.findIndex((m) => m.id === input.modelId);
				if (i >= 0) list[i] = applyProbeResults(list[i]!, results, now);
			}
			return { file, result: cur };
		});
		return c.json({ results, provider: providerView(provider) });
	} catch (e) {
		return fail(c, e);
	}
});

// ── Routing ────────────────────────────────────────────────────────

aiProviderRoutes.get("/api/v1/ai/routing", async (c) => {
	const file = await getAiProvidersFile(c.env.BUCKET, { fresh: true });
	if (!file) {
		return c.json({
			routing: { gatewayProviderId: null, models: {}, fallbackToWorkersAi: false, workersAiExceptions: [], disabledRoles: [], embeddingsMode: "gateway" },
			problems: [],
		});
	}
	return c.json({ routing: routingView(file), problems: problemsFor(file, file.routing.gatewayProviderId) });
});

const RoutingPatch = z
	.object({
		gatewayProviderId: z.string().regex(PROVIDER_ID).nullable().optional(),
		models: z.record(z.string(), z.string().regex(MODEL_ID).nullable()).optional(),
		default: z.string().regex(MODEL_ID).nullable().optional(),
		fallbackToWorkersAi: z.boolean().optional(),
		embeddings: z.enum(["gateway", "workers-ai", "off"]).optional(),
	})
	.strict();

aiProviderRoutes.patch("/api/v1/ai/routing", async (c) => {
	try {
		const input = RoutingPatch.parse(await body(c));
		for (const role of Object.keys(input.models ?? {})) {
			if (!isAiRole(role)) throw new InputError(`Unknown role ${role}.`, "models");
			if (role === "injection_scanner") {
				throw new InputError("The prompt-injection scanner always runs on Workers AI.", "models", 422, "capability_check_failed", {
					problems: [{ role, reason: "The prompt-injection scanner always runs on Workers AI." }],
				});
			}
		}
		const result = await updateAiProvidersFile(c.env.BUCKET, (file) => {
			const r = file.routing;
			if (input.gatewayProviderId !== undefined) r.gatewayProviderId = input.gatewayProviderId;
			if (input.fallbackToWorkersAi !== undefined) r.fallbackToWorkersAi = input.fallbackToWorkersAi;
			if (input.embeddings !== undefined) {
				r.workersAiExceptions = r.workersAiExceptions.filter((x) => x !== "embeddings");
				r.disabledRoles = r.disabledRoles.filter((x) => x !== "embeddings");
				if (input.embeddings === "workers-ai") r.workersAiExceptions.push("embeddings");
				if (input.embeddings === "off") r.disabledRoles.push("embeddings");
				if (input.embeddings !== "gateway") delete r.models.embeddings;
			}
			// The provider the picks are checked against: the active one, or the one being activated.
			const targetId = r.gatewayProviderId ?? null;
			const target = targetId ? file.providers.find((p) => p.id === targetId) : undefined;
			if (targetId && !target) throw new InputError("No such provider.", "gatewayProviderId", 404);
			if (target && !target.enabled) throw new InputError("Turn the provider on first.", "gatewayProviderId", 409);

			// Per-role picks: refused outright when they fail their check, against
			// the provider they will run on (the active one; else the only one).
			const checkAgainst = target ?? (file.providers.length === 1 ? file.providers[0] : undefined);
			const pickProblems: RoleProblem[] = [];
			const models = checkAgainst ? providerModels(checkAgainst) : [];
			for (const [role, modelId] of Object.entries(input.models ?? {}) as [AiRole, string | null][]) {
				if (modelId === null) {
					delete r.models[role];
					continue;
				}
				if (!checkAgainst) throw new InputError("Add a provider first.", "models");
				const verdict = checkRoleModel(role, models.find((m) => m.id === modelId), checkAgainst.wire);
				if (!verdict.ok) pickProblems.push({ role, reason: verdict.reason });
				else r.models[role] = { modelId };
			}
			if (input.default !== undefined) {
				if (input.default === null) delete r.default;
				else {
					if (!checkAgainst) throw new InputError("Add a provider first.", "default");
					const m = models.find((x) => x.id === input.default);
					if (!m || m.kind !== "chat") pickProblems.push({ role: "summary", reason: "The default must be a chat model from this gateway." });
					else r.default = { modelId: input.default };
				}
			}
			if (pickProblems.length) {
				throw new InputError("Some choices don't meet their role's needs.", "models", 422, "capability_check_failed", { problems: pickProblems });
			}
			// Activation (or staying active) needs every role to pass.
			if (target) {
				const problems = activationProblems(target, r, providerModels(target));
				if (problems.length && input.gatewayProviderId !== undefined && input.gatewayProviderId !== null) {
					throw new InputError("This gateway can't serve every AI feature yet.", "gatewayProviderId", 422, "capability_check_failed", {
						problems,
					});
				}
			}
			return { file, result: file };
		});
		await recordAuditDeferred(c, {
			action: "ai.routing",
			...auditBase(c),
			detail: {
				active: result.routing.gatewayProviderId,
				fallback: result.routing.fallbackToWorkersAi,
				embeddings: embeddingsMode(result),
				roles: Object.entries(result.routing.models)
					.map(([role, ref]) => `${role}=${ref.modelId}`)
					.join(",") || null,
			},
		});
		return c.json({ routing: routingView(result), problems: problemsFor(result, result.routing.gatewayProviderId) });
	} catch (e) {
		return fail(c, e);
	}
});
