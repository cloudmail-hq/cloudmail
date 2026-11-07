// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Bring-your-own AI gateway rules that the Worker and the settings UI share:
 * base-URL normalisation, the wire and auth suggestions, the extra-header
 * denylist, per-role requirements and the capability gate.
 *
 * Pure, so the form shows the same verdict the API enforces.
 */

import { EMBEDDING_DIMENSIONS } from "./semantic";
import {
	GATEWAY_ROLES,
	type AiProvider,
	type AiProviderHeader,
	type AiRole,
	type AuthScheme,
	type CapSource,
	type CatalogModel,
} from "./ai-providers";

export type Wire = AiProvider["wire"];

// ── Base URL ───────────────────────────────────────────────────────

/** The stored form: no query, no fragment, no trailing slash. Null when unparseable. */
export function canonicalBaseUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL((raw ?? "").trim());
	} catch {
		return null;
	}
	url.search = "";
	url.hash = "";
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.protocol}//${url.host}${path}`;
}

const hostIs = (host: string, ...names: string[]) => names.some((n) => host === n || host.endsWith(`.${n}`));

/**
 * The URL prefix API paths hang off (`{apiBase}/models`, `/chat/completions`,
 * `/messages`, `/embeddings`). Most gateways want `/v1` appended; the
 * exceptions are in the research doc's table 2.1 and in `test/ai-gateway.test.ts`.
 */
export function apiBaseFor(baseUrl: string, wire: Wire, exact = false): string {
	const canonical = canonicalBaseUrl(baseUrl) ?? baseUrl.replace(/\/+$/, "");
	if (exact) return canonical;
	const url = new URL(canonical);
	const host = url.hostname.toLowerCase();
	const path = url.pathname.replace(/\/+$/, "");
	const origin = `${url.protocol}//${url.host}`;

	// Already a full API base.
	if (/\/v1$/i.test(path) || /\/v1beta\/openai$/i.test(path)) return canonical;

	// Cloudflare AI Gateway: /v1/{account}/{gateway}/{provider}. The path is the
	// prefix; only the Anthropic provider wants its own /v1.
	if (host === "gateway.ai.cloudflare.com") {
		return /\/anthropic$/i.test(path) ? `${canonical}/v1` : canonical;
	}
	if (hostIs(host, "openai.azure.com", "services.ai.azure.com", "cognitiveservices.azure.com")) {
		return path === "" || /^\/openai$/i.test(path) ? `${origin}/openai/v1` : `${canonical}/v1`;
	}
	if (host === "openrouter.ai") return path === "" || path === "/api" ? `${origin}/api/v1` : `${canonical}/v1`;
	if (host === "api.groq.com") return path === "" || path === "/openai" ? `${origin}/openai/v1` : `${canonical}/v1`;
	if (host === "generativelanguage.googleapis.com") {
		return path === "" || /^\/v1beta$/i.test(path) ? `${origin}/v1beta/openai` : canonical;
	}
	if (host === "api.fireworks.ai") return path === "" || path === "/inference" ? `${origin}/inference/v1` : `${canonical}/v1`;
	if (host === "api.deepseek.com" && wire === "anthropic" && path === "") return `${origin}/anthropic/v1`;
	return `${canonical}/v1`;
}

/** Hosts whose wire is known. Anything else gets no suggestion: the admin picks. */
export function suggestWire(baseUrl: string): Wire | null {
	const canonical = canonicalBaseUrl(baseUrl);
	if (!canonical) return null;
	const url = new URL(canonical);
	const host = url.hostname.toLowerCase();
	const path = url.pathname.toLowerCase();
	if (host === "api.anthropic.com" || /(^|\/)anthropic(\/|$)/.test(path)) return "anthropic";
	if (
		host === "api.openai.com" ||
		host === "openrouter.ai" ||
		host === "api.groq.com" ||
		host === "api.mistral.ai" ||
		host === "api.together.xyz" ||
		host === "api.fireworks.ai" ||
		host === "generativelanguage.googleapis.com" ||
		hostIs(host, "openai.azure.com", "services.ai.azure.com", "cognitiveservices.azure.com") ||
		/(^|\/)(openai|compat)(\/|$)/.test(path)
	) {
		return "openai";
	}
	return null;
}

/** The auth scheme a new provider starts with. */
export function defaultAuthScheme(wire: Wire, baseUrl: string): AuthScheme {
	const canonical = canonicalBaseUrl(baseUrl);
	const host = canonical ? new URL(canonical).hostname.toLowerCase() : "";
	if (hostIs(host, "openai.azure.com", "services.ai.azure.com", "cognitiveservices.azure.com")) return "api-key";
	return wire === "anthropic" ? "x-api-key" : "bearer";
}

/** LiteLLM proxies publish `/model/info`; guessed from the host, or the admin toggle. */
export function looksLikeLiteLlm(baseUrl: string): boolean {
	return /litellm/i.test(baseUrl);
}

/** Azure deployments and Cloudflare AI Gateway list nothing useful: custom ids only. */
export function needsCustomIds(baseUrl: string): boolean {
	const canonical = canonicalBaseUrl(baseUrl);
	if (!canonical) return false;
	const host = new URL(canonical).hostname.toLowerCase();
	return host === "gateway.ai.cloudflare.com" || hostIs(host, "openai.azure.com", "services.ai.azure.com", "cognitiveservices.azure.com");
}

// ── Headers ────────────────────────────────────────────────────────

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const BLOCKED_HEADERS = new Set([
	"host",
	"content-length",
	"content-type",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"expect",
	"cookie",
	"origin",
	"referer",
	"proxy-authorization",
	"proxy-connection",
]);

/** The header the token travels in, lower-cased, or null for `none`. */
export function authHeaderName(auth: AiProvider["auth"]): string | null {
	switch (auth.scheme) {
		case "bearer":
			return "authorization";
		case "x-api-key":
			return "x-api-key";
		case "api-key":
			return "api-key";
		case "custom":
			return auth.header.toLowerCase();
		default:
			return null;
	}
}

/** Null when the header may be sent; otherwise why not. */
export function headerNameProblem(name: string, auth?: AiProvider["auth"]): string | null {
	if (!HEADER_NAME.test(name)) return "Header names are letters, digits and dashes, up to 64.";
	const n = name.toLowerCase();
	if (BLOCKED_HEADERS.has(n) || n.startsWith("x-forwarded-") || n.startsWith("sec-") || n.startsWith("proxy-")) {
		return `${name} can't be set.`;
	}
	if (n.startsWith("cf-") && !n.startsWith("cf-aig-") && !n.startsWith("cf-access-")) {
		return "Only cf-aig-* and cf-access-* Cloudflare headers can be set.";
	}
	if (auth && authHeaderName(auth) === n) return `${name} already carries the token.`;
	if (n === "authorization" && auth && auth.scheme !== "none" && auth.scheme !== "custom") {
		return "Authorization is set by the auth scheme.";
	}
	return null;
}

export function headerValueProblem(value: string): string | null {
	if (/[\r\n\0]/.test(value)) return "Header values can't contain line breaks.";
	if (value.length > 4096) return "Header value is too long.";
	return null;
}

/** Problems with a full header list, in order. */
export function headersProblems(headers: Pick<AiProviderHeader, "name">[], auth: AiProvider["auth"]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const h of headers) {
		const p = headerNameProblem(h.name, auth);
		if (p) out.push(p);
		const n = h.name.toLowerCase();
		if (seen.has(n)) out.push(`${h.name} is listed twice.`);
		seen.add(n);
	}
	if (headers.length > 8) out.push("At most 8 extra headers.");
	return out;
}

/** The last four characters, for "…a1b2". */
export function tokenHint(token: string): string {
	const t = token.trim();
	return t.length <= 4 ? "…" : `…${t.slice(-4)}`;
}

// ── Roles and the capability gate ──────────────────────────────────

export type RoleNeed = "text" | "json" | "tools" | "embed";

/** What each role needs from its model. The scanner is pinned and not listed. */
export const ROLE_NEEDS: Readonly<Record<AiRole, RoleNeed>> = {
	agent_chat: "tools",
	auto_draft: "tools",
	nudge: "text",
	summary: "text",
	triage: "json",
	followup_classifier: "text",
	injection_scanner: "text",
	draft_verifier: "text",
	embeddings: "embed",
	ask_answer: "text",
	daily_brief: "text",
};

export const ROLE_LABELS: Readonly<Record<AiRole, string>> = {
	agent_chat: "Agent chat",
	auto_draft: "Auto-draft",
	nudge: "Follow-up nudge",
	summary: "Summaries",
	triage: "Triage",
	followup_classifier: "Follow-up detection",
	injection_scanner: "Prompt-injection scanner",
	draft_verifier: "Draft check",
	embeddings: "Embeddings",
	ask_answer: "Ask my inbox",
	daily_brief: "Daily brief",
};

/** Sources that count as known. A `hint` is an inference and never unlocks tools, JSON or embeddings. */
const KNOWN: readonly CapSource[] = ["provider", "probe", "admin"];

export type GateResult = { ok: true } | { ok: false; reason: string };

/**
 * Whether `model` may serve `role` on a gateway speaking `wire`. Undefined
 * `model` means the id is in neither the catalogue nor the custom list.
 */
export function checkRoleModel(role: AiRole, model: CatalogModel | undefined, wire: Wire): GateResult {
	if (role === "injection_scanner") return { ok: false, reason: "The prompt-injection scanner always runs on Workers AI." };
	if (!model) return { ok: false, reason: "Not in this gateway's model list. Add it as a custom model first." };
	const need = ROLE_NEEDS[role];
	if (need === "embed") {
		if (wire === "anthropic") return { ok: false, reason: "Anthropic-wire gateways have no embeddings API." };
		const isEmbedding = model.kind === "embedding" || (model.caps.embed.value === true && KNOWN.includes(model.caps.embed.source));
		if (!isEmbedding) return { ok: false, reason: "Not an embedding model." };
		if (model.embeddingDims == null) return { ok: false, reason: "Run Test to check its vector size." };
		if (model.embeddingDims !== EMBEDDING_DIMENSIONS) {
			return { ok: false, reason: `Returns ${model.embeddingDims}-dimension vectors; the search index needs ${EMBEDDING_DIMENSIONS}.` };
		}
		return { ok: true };
	}
	if (model.kind === "embedding") return { ok: false, reason: "An embedding model can't write text." };
	if (model.kind === "other") return { ok: false, reason: "Not a chat model." };
	if (need === "tools") {
		const c = model.caps.tools;
		if (c.value === false && KNOWN.includes(c.source)) return { ok: false, reason: "This model can't call tools." };
		if (c.value !== true || !KNOWN.includes(c.source)) return { ok: false, reason: "Tool calling isn't verified. Run Test or mark it supported." };
	}
	if (need === "json") {
		const c = model.caps.json;
		if (c.value === false && KNOWN.includes(c.source)) return { ok: false, reason: "This model can't return JSON." };
		if (c.value !== true || !KNOWN.includes(c.source)) return { ok: false, reason: "JSON output isn't verified. Run Test or mark it supported." };
	}
	return { ok: true };
}

/** The model a role uses on the gateway: its own pick, else the default (never for embeddings). */
export function effectiveModelId(
	routing: { models: Record<string, { modelId: string; providerId?: string }>; default?: { modelId: string } },
	role: AiRole,
): string | null {
	return routing.models[role]?.modelId ?? (role === "embeddings" ? null : (routing.default?.modelId ?? null));
}

export interface RoleProblem {
	role: AiRole;
	reason: string;
}

/**
 * Every problem that stops a gateway from serving all roles. Empty means it
 * may be activated: each non-pinned role has a model that passes the gate,
 * and embeddings either has one or an explicit admin choice.
 */
export function activationProblems(
	provider: AiProvider,
	routing: {
		models: Record<string, { modelId: string; providerId?: string }>;
		default?: { modelId: string };
		workersAiExceptions: string[];
		disabledRoles: string[];
	},
	models: CatalogModel[],
): RoleProblem[] {
	const byId = new Map(models.map((m) => [m.id, m]));
	const out: RoleProblem[] = [];
	for (const role of GATEWAY_ROLES) {
		if (role === "embeddings" && (routing.workersAiExceptions.includes(role) || routing.disabledRoles.includes(role))) continue;
		const id = effectiveModelId(routing, role);
		if (!id) {
			out.push({
				role,
				reason: role === "embeddings" ? "Pick an embedding model, Workers AI, or turn semantic search off." : "Pick a model.",
			});
			continue;
		}
		const verdict = checkRoleModel(role, byId.get(id), provider.wire);
		if (!verdict.ok) out.push({ role, reason: verdict.reason });
	}
	return out;
}
