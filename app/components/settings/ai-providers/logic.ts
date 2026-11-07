// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Pure helpers behind Settings → AI providers: badge wording, model filters,
 * the provider form's payload and the routing draft. No React, so the rules
 * are unit tested (test/ai-providers-ui.test.ts).
 */

import type { AiProviderAuth, AiRole, AuthScheme, Cap, CatalogModel } from "../../../../shared/ai-providers";
import {
	checkRoleModel,
	headerNameProblem,
	headerValueProblem,
	type RoleNeed,
	type RoleProblem,
	type Wire,
} from "../../../../shared/ai-gateway";
import type { EmbeddingsMode, ProviderHeaderInput, ProviderHeaderView, ProviderView, RoutingPatch } from "~/queries/ai-providers";

// ── Capability badges ──────────────────────────────────────────────

export type CapBadgeName = "tools" | "json" | "vision" | "embed";

export const CAP_BADGE_LABELS: Record<CapBadgeName, string> = {
	tools: "Tools",
	json: "JSON",
	vision: "Vision",
	embed: "Embeddings",
};

/** Source wording. `provider` is plain: the gateway said so. */
export function capSourceLabel(source: Cap["source"]): string | null {
	switch (source) {
		case "hint":
			return "inferred";
		case "probe":
			return "tested";
		case "admin":
			return "set by admin";
		default:
			return null;
	}
}

export function capSymbol(value: boolean | null): "✓" | "✗" | "?" {
	return value === true ? "✓" : value === false ? "✗" : "?";
}

/** Short screen-reader text: "Tools: yes, tested". */
export function capDescription(name: CapBadgeName, cap: Cap): string {
	const v = cap.value === true ? "yes" : cap.value === false ? "no" : "unknown";
	const src = capSourceLabel(cap.source);
	return `${CAP_BADGE_LABELS[name]}: ${v}${src ? `, ${src}` : ""}`;
}

/** The badges a model shows: chat models skip embed, embedding models show only embed. */
export function badgesFor(model: CatalogModel): CapBadgeName[] {
	if (model.kind === "embedding") return ["embed"];
	return ["tools", "json", "vision"];
}

// ── Model list ─────────────────────────────────────────────────────

export type KindFilter = "all" | "chat" | "embedding";

export function filterModels(models: CatalogModel[], query: string, kind: KindFilter): CatalogModel[] {
	const q = query.trim().toLowerCase();
	return models.filter((m) => {
		if (kind === "chat" && m.kind !== "chat") return false;
		if (kind === "embedding" && m.kind !== "embedding") return false;
		if (!q) return true;
		return m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q);
	});
}

/** Models offered in a role's picker: embedding models for embeddings, chat models otherwise. */
export function modelsForNeed(models: CatalogModel[], need: RoleNeed): CatalogModel[] {
	return need === "embed" ? models.filter((m) => m.kind === "embedding") : models.filter((m) => m.kind === "chat");
}

/** True when no model on this gateway can serve embeddings, so the admin must choose Workers AI or off. */
export function needsEmbeddingsChoice(models: CatalogModel[], wire: Wire): boolean {
	if (wire === "anthropic") return true;
	return !models.some((m) => checkRoleModel("embeddings", m, wire).ok);
}

export const CATALOGUE_STATUS_LABELS: Record<ProviderView["catalogue"]["status"], string> = {
	never: "Not discovered",
	ok: "Models listed",
	"no-discovery": "No model list",
	"auth-failed": "Token rejected",
	error: "Discovery failed",
};

export function catalogueSummary(c: ProviderView["catalogue"]): string {
	return c.status === "ok" ? `${c.count} model${c.count === 1 ? "" : "s"}` : CATALOGUE_STATUS_LABELS[c.status];
}

export function isPaused(breaker: ProviderView["breaker"]): boolean {
	return breaker.state !== "closed";
}

export const WIRE_LABELS: Record<Wire, string> = {
	anthropic: "Anthropic Messages",
	openai: "OpenAI Chat Completions",
};

export function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

// ── Provider form ──────────────────────────────────────────────────

export const AUTH_SCHEME_LABELS: Record<AuthScheme, string> = {
	bearer: "Bearer",
	"x-api-key": "x-api-key",
	"api-key": "api-key (Azure)",
	custom: "Custom header",
	none: "None",
};

export function buildAuth(scheme: AuthScheme, customHeader: string): AiProviderAuth {
	return scheme === "custom" ? { scheme, header: customHeader.trim() } : { scheme };
}

export interface HeaderRow {
	name: string;
	value: string;
	secret: boolean;
	/** A secret value is stored on the server; a blank value keeps it. */
	stored: boolean;
}

export const MAX_HEADERS = 8;

export function headerRowsFrom(headers: ProviderHeaderView[]): HeaderRow[] {
	return headers.map((h) => ({
		name: h.name,
		value: h.secret ? "" : (h.value ?? ""),
		secret: h.secret,
		stored: h.secret && h.set,
	}));
}

/** Per-row problem, or null. Blank rows are ignored when saving. */
export function headerRowProblem(row: HeaderRow, auth: AiProviderAuth, others: HeaderRow[]): string | null {
	const name = row.name.trim();
	if (!name) return row.value ? "Add a header name." : null;
	const nameProblem = headerNameProblem(name, auth);
	if (nameProblem) return nameProblem;
	if (others.some((o) => o !== row && o.name.trim().toLowerCase() === name.toLowerCase())) return `${name} is listed twice.`;
	if (row.value) return headerValueProblem(row.value);
	if (!(row.secret && row.stored)) return "Add a value.";
	return null;
}

/** The `headers` body: blank rows dropped; a stored secret left blank is sent without `value` (kept). */
export function headersPayload(rows: HeaderRow[]): ProviderHeaderInput[] {
	return rows
		.filter((r) => r.name.trim())
		.map((r) => {
			const out: ProviderHeaderInput = { name: r.name.trim(), secret: r.secret };
			if (!(r.secret && r.stored && r.value === "")) out.value = r.value;
			return out;
		});
}

export type TokenAction = "keep" | "replace" | "clear";

/**
 * The `token` field. Create: the typed token, or absent. Edit: absent keeps
 * it, a string replaces it, null clears it.
 */
export function tokenField(mode: "create" | "edit", action: TokenAction, token: string): { token?: string | null } {
	const t = token.trim();
	if (mode === "create") return t ? { token: t } : {};
	if (action === "clear") return { token: null };
	if (action === "replace" && t) return { token: t };
	return {};
}

/** Fields the API can name in a 400 that the form shows inline. */
export const FORM_FIELDS = ["label", "wire", "baseUrl", "auth", "token", "headers"] as const;
export type FormField = (typeof FORM_FIELDS)[number];

export function formFieldOf(field: unknown): FormField | null {
	if (typeof field !== "string") return null;
	const head = field.split(/[.[]/)[0];
	return (FORM_FIELDS as readonly string[]).includes(head) ? (head as FormField) : null;
}

// ── Routing ────────────────────────────────────────────────────────

export interface RoutingDraft {
	models: Partial<Record<AiRole, string>>;
	default: string;
	embeddings: EmbeddingsMode;
}

export function routingDraftFrom(routing: {
	models: Record<string, { modelId: string }>;
	default?: { modelId: string };
	embeddingsMode: EmbeddingsMode;
}): RoutingDraft {
	const models: Partial<Record<AiRole, string>> = {};
	for (const [role, ref] of Object.entries(routing.models)) models[role as AiRole] = ref.modelId;
	return { models, default: routing.default?.modelId ?? "", embeddings: routing.embeddingsMode };
}

/**
 * The PATCH body for the routing card: only what changed. An emptied role
 * picker sends null (falls back to the default). Picking an embedding model
 * means `embeddings: "gateway"`; without one the admin's choice stands.
 */
export function routingPatch(before: RoutingDraft, after: RoutingDraft, roles: readonly AiRole[]): RoutingPatch {
	const patch: RoutingPatch = {};
	const models: Partial<Record<AiRole, string | null>> = {};
	for (const role of roles) {
		const a = before.models[role] ?? "";
		const b = after.models[role] ?? "";
		if (a !== b) models[role] = b || null;
	}
	if (Object.keys(models).length) patch.models = models;
	if (before.default !== after.default) patch.default = after.default || null;
	// "gateway" with no embedding model is not a choice; leave it for the admin to make.
	const embeddings: EmbeddingsMode = after.models.embeddings ? "gateway" : after.embeddings;
	if (embeddings !== before.embeddings && !(embeddings === "gateway" && !after.models.embeddings)) {
		patch.embeddings = embeddings;
	}
	return patch;
}

/**
 * What stops `draft` from serving every role on a gateway, in role order:
 * the client-side twin of the server's activation check, so the routing card
 * can explain each row before a round trip.
 */
export function draftProblems(
	draft: RoutingDraft,
	models: CatalogModel[],
	wire: Wire,
	roles: readonly AiRole[],
): RoleProblem[] {
	const byId = new Map(models.map((m) => [m.id, m]));
	const out: RoleProblem[] = [];
	for (const role of roles) {
		if (role === "injection_scanner") continue;
		const picked = draft.models[role] || null;
		if (role === "embeddings" && !picked) {
			if (draft.embeddings === "workers-ai" || draft.embeddings === "off") continue;
			out.push({ role, reason: "Pick an embedding model, Workers AI, or turn semantic search off." });
			continue;
		}
		const id = picked ?? (draft.default || null);
		if (!id) {
			out.push({ role, reason: "Pick a model." });
			continue;
		}
		const verdict = checkRoleModel(role, byId.get(id), wire);
		if (!verdict.ok) out.push({ role, reason: verdict.reason });
	}
	return out;
}

export function problemsByRole(problems: readonly RoleProblem[]): Partial<Record<AiRole, string>> {
	const out: Partial<Record<AiRole, string>> = {};
	for (const p of problems) out[p.role] ??= p.reason;
	return out;
}

// ── Providers list and the built-in provider ───────────────────────

export type ProviderStatus = "active" | "inactive" | "paused" | "failing" | "off";

/**
 * A provider card's status. Paused: the breaker is open. Failing: discovery
 * or a call reported an auth failure. The built-in provider is active
 * whenever no gateway is.
 */
export function providerStatus(
	p: Pick<ProviderView, "enabled" | "breaker" | "catalogue"> | null,
	active: boolean,
): ProviderStatus {
	if (!p) return active ? "active" : "inactive";
	if (!p.enabled) return "off";
	if (p.breaker.state === "open") return "paused";
	if (p.breaker.state === "half-open" || p.catalogue.status === "auth-failed") return "failing";
	return active ? "active" : "inactive";
}

export const STATUS_LABELS: Record<ProviderStatus, string> = {
	active: "Active",
	inactive: "Inactive",
	paused: "Paused",
	failing: "Failing",
	off: "Off",
};

/** "1,204 calls this month", or null when there were none. */
export function usageLabel(calls: number | undefined): string | null {
	if (!calls) return null;
	return `${calls.toLocaleString("en-US")} call${calls === 1 ? "" : "s"} this month`;
}
