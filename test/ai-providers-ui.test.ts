// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Pure helpers behind Settings → AI providers. */

import { describe, expect, it } from "vitest";
import {
	badgesFor,
	buildAuth,
	capDescription,
	capSourceLabel,
	capSymbol,
	catalogueSummary,
	draftProblems,
	filterModels,
	formFieldOf,
	headerRowProblem,
	headerRowsFrom,
	headersPayload,
	isPaused,
	modelsForNeed,
	needsEmbeddingsChoice,
	problemsByRole,
	routingDraftFrom,
	routingPatch,
	tokenField,
	type HeaderRow,
	type RoutingDraft,
} from "~/components/settings/ai-providers/logic";
import { routingProblemsFrom } from "~/queries/ai-providers";
import { ApiError } from "~/services/api";
import { AI_ROLES, type CatalogModel } from "../shared/ai-providers";
import { EMBEDDING_DIMENSIONS } from "../shared/semantic";
import { visibleSections } from "../shared/settings-sections";

const known = (value: boolean | null) => ({ value, source: "provider" as const });
const hint = (value: boolean | null) => ({ value, source: "hint" as const });

function chat(id: string, over: Partial<CatalogModel["caps"]> = {}): CatalogModel {
	return {
		id,
		label: id,
		kind: "chat",
		contextTokens: null,
		maxOutputTokens: null,
		caps: { tools: known(true), json: known(true), vision: hint(null), reasoning: hint(null), embed: known(false), ...over },
	};
}
function embedding(id: string, dims: number | null = EMBEDDING_DIMENSIONS): CatalogModel {
	return { ...chat(id), kind: "embedding", caps: { ...chat(id).caps, embed: known(true) }, embeddingDims: dims };
}

describe("capability badges", () => {
	it("names the source: hint inferred, probe tested, admin set by admin, provider plain", () => {
		expect(capSourceLabel("hint")).toBe("inferred");
		expect(capSourceLabel("probe")).toBe("tested");
		expect(capSourceLabel("admin")).toBe("set by admin");
		expect(capSourceLabel("provider")).toBeNull();
	});

	it("marks true, false and unknown", () => {
		expect([capSymbol(true), capSymbol(false), capSymbol(null)]).toEqual(["✓", "✗", "?"]);
		expect(capDescription("tools", { value: true, source: "probe" })).toBe("Tools: yes, tested");
		expect(capDescription("json", { value: null, source: "provider" })).toBe("JSON: unknown");
	});

	it("shows tools/JSON/vision on chat models and only embeddings on embedding models", () => {
		expect(badgesFor(chat("a"))).toEqual(["tools", "json", "vision"]);
		expect(badgesFor(embedding("e"))).toEqual(["embed"]);
	});
});

describe("model list", () => {
	const models = [chat("claude-sonnet"), chat("gpt-mini"), embedding("text-embed")];

	it("filters by search and kind", () => {
		expect(filterModels(models, "GPT", "all").map((m) => m.id)).toEqual(["gpt-mini"]);
		expect(filterModels(models, "", "embedding").map((m) => m.id)).toEqual(["text-embed"]);
		expect(filterModels(models, "", "chat")).toHaveLength(2);
	});

	it("offers chat models to text roles and embedding models to embeddings", () => {
		expect(modelsForNeed(models, "tools").map((m) => m.id)).toEqual(["claude-sonnet", "gpt-mini"]);
		expect(modelsForNeed(models, "embed").map((m) => m.id)).toEqual(["text-embed"]);
	});

	it("asks for an embeddings choice on anthropic wire or with no usable embedding model", () => {
		expect(needsEmbeddingsChoice(models, "anthropic")).toBe(true);
		expect(needsEmbeddingsChoice(models, "openai")).toBe(false);
		expect(needsEmbeddingsChoice([chat("a"), embedding("e", 1536)], "openai")).toBe(true);
	});

	it("summarises the catalogue and the breaker", () => {
		expect(catalogueSummary({ fetchedAt: null, status: "ok", count: 1 })).toBe("1 model");
		expect(catalogueSummary({ fetchedAt: null, status: "no-discovery", count: 0 })).toBe("No model list");
		expect(isPaused({ state: "closed", openUntil: null })).toBe(false);
		expect(isPaused({ state: "half-open", openUntil: 1 })).toBe(true);
	});
});

describe("provider form", () => {
	it("builds the auth object", () => {
		expect(buildAuth("bearer", "ignored")).toEqual({ scheme: "bearer" });
		expect(buildAuth("custom", " X-Key ")).toEqual({ scheme: "custom", header: "X-Key" });
	});

	it("sends the token only when typed, and null to clear", () => {
		expect(tokenField("create", "replace", "  sk-1  ")).toEqual({ token: "sk-1" });
		expect(tokenField("create", "replace", "")).toEqual({});
		expect(tokenField("edit", "keep", "sk-typed")).toEqual({});
		expect(tokenField("edit", "replace", "")).toEqual({});
		expect(tokenField("edit", "replace", "sk-2")).toEqual({ token: "sk-2" });
		expect(tokenField("edit", "clear", "sk-2")).toEqual({ token: null });
	});

	it("never prefills secret header values and keeps them when left blank", () => {
		const rows = headerRowsFrom([
			{ name: "X-Plain", secret: false, value: "v", set: true },
			{ name: "X-Secret", secret: true, set: true },
		]);
		expect(rows).toEqual([
			{ name: "X-Plain", value: "v", secret: false, stored: false },
			{ name: "X-Secret", value: "", secret: true, stored: true },
		]);
		expect(headersPayload([...rows, { name: " ", value: "", secret: false, stored: false }])).toEqual([
			{ name: "X-Plain", value: "v", secret: false },
			{ name: "X-Secret", secret: true },
		]);
		expect(headersPayload([{ ...rows[1], value: "new" }])).toEqual([{ name: "X-Secret", value: "new", secret: true }]);
	});

	it("flags bad header rows", () => {
		const auth = { scheme: "bearer" as const };
		const row = (name: string, value = "v", extra: Partial<HeaderRow> = {}): HeaderRow => ({ name, value, secret: false, stored: false, ...extra });
		expect(headerRowProblem(row("X-Ok"), auth, [])).toBeNull();
		expect(headerRowProblem(row("Host"), auth, [])).toMatch(/can't be set/);
		expect(headerRowProblem(row("Authorization"), auth, [])).toMatch(/token/);
		expect(headerRowProblem(row("X-Ok", "a\nb"), auth, [])).toMatch(/line breaks/);
		expect(headerRowProblem(row("X-Ok", ""), auth, [])).toBe("Add a value.");
		expect(headerRowProblem(row("X-S", "", { secret: true, stored: true }), auth, [])).toBeNull();
		const a = row("X-Dup");
		const b = row("x-dup");
		expect(headerRowProblem(a, auth, [a, b])).toMatch(/twice/);
		expect(headerRowProblem(row("", ""), auth, [])).toBeNull();
		expect(headerRowProblem(row(""), auth, [])).toBe("Add a header name.");
	});

	it("maps an API 400 field onto a form field", () => {
		expect(formFieldOf("baseUrl")).toBe("baseUrl");
		expect(formFieldOf("headers[2].name")).toBe("headers");
		expect(formFieldOf("auth.header")).toBe("auth");
		expect(formFieldOf("options")).toBeNull();
		expect(formFieldOf(undefined)).toBeNull();
	});
});

describe("routing draft", () => {
	const roles = [...AI_ROLES];
	const saved: RoutingDraft = routingDraftFrom({
		models: { triage: { modelId: "a" } },
		default: { modelId: "b" },
		embeddingsMode: "off",
	});

	it("reads the routing view", () => {
		expect(saved).toEqual({ models: { triage: "a" }, default: "b", embeddings: "off" });
	});

	it("sends only what changed, null for cleared picks", () => {
		expect(routingPatch(saved, saved, roles)).toEqual({});
		const after = { ...saved, models: { summary: "c" }, default: "" };
		expect(routingPatch(saved, after, roles)).toEqual({ models: { triage: null, summary: "c" }, default: null });
	});

	it("an embedding model means gateway; otherwise the admin's choice", () => {
		expect(routingPatch(saved, { ...saved, models: { ...saved.models, embeddings: "e" } }, roles)).toEqual({
			models: { embeddings: "e" },
			embeddings: "gateway",
		});
		expect(routingPatch(saved, { ...saved, embeddings: "workers-ai" }, roles)).toEqual({ embeddings: "workers-ai" });
		// "gateway" without a model is never sent.
		expect(routingPatch(saved, { ...saved, embeddings: "gateway" }, roles)).toEqual({});
	});

	it("lists per-role problems with the server's rules, skipping the scanner", () => {
		const models = [chat("good"), chat("guess", { tools: hint(true) }), embedding("e")];
		const draft: RoutingDraft = { models: { agent_chat: "guess" }, default: "good", embeddings: "off" };
		const problems = draftProblems(draft, models, "openai", roles);
		expect(problems.map((p) => p.role)).toEqual(["agent_chat"]);
		expect(problems[0].reason).toMatch(/isn't verified/);
		expect(draftProblems({ models: {}, default: "", embeddings: "gateway" }, models, "openai", roles).map((p) => p.role)).toEqual(
			roles.filter((r) => r !== "injection_scanner"),
		);
		expect(problemsByRole([{ role: "triage", reason: "x" }, { role: "triage", reason: "y" }])).toEqual({ triage: "x" });
	});

	it("reads problems from a 422", () => {
		const err = new ApiError(422, { error: "no", code: "capability_check_failed", problems: [{ role: "triage", reason: "r" }] });
		expect(routingProblemsFrom(err)).toEqual([{ role: "triage", reason: "r" }]);
		expect(routingProblemsFrom(new ApiError(400, { error: "no" }))).toBeNull();
		expect(routingProblemsFrom(new Error("x"))).toBeNull();
	});
});

describe("settings section", () => {
	it("is admin-only and saves with a form", () => {
		const admin = visibleSections({ isAdmin: true, passwordMode: true, managesSomeMailbox: true });
		const section = admin.find((s) => s.id === "ai-providers");
		expect(section).toEqual({ id: "ai-providers", label: "AI providers", save: "form" });
		const member = visibleSections({ isAdmin: false, passwordMode: true, managesSomeMailbox: true });
		expect(member.map((s) => s.id)).not.toContain("ai-providers");
	});
});
