// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → AI providers with the built-in provider: the page renders the
 * Workers AI card as Active when nothing is configured, the status line,
 * per-role models with the scanner locked, the unlisted warning, and the
 * card status rules. Synthetic data, server-rendered from a seeded query
 * cache (no network).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AiProvidersSettings from "~/components/settings/AiProvidersSettings";
import { providerStatus, usageLabel } from "~/components/settings/ai-providers/logic";
import type { ProvidersResponse, WorkersAiCatalogueResponse } from "~/queries/ai-providers";
import { AI_ROLES } from "../shared/ai-providers";
import { ROLE_LABELS, ROLE_NEEDS } from "../shared/ai-gateway";
import { WORKERS_AI_DEFAULTS, normaliseCatalogue } from "../shared/workers-ai";
import { row } from "./fixtures/workers-ai-catalogue";

function emptyResponse(over: Partial<ProvidersResponse> = {}): ProvidersResponse {
	return {
		providers: [],
		routing: {
			gatewayProviderId: null,
			models: {},
			fallbackToWorkersAi: false,
			workersAiExceptions: [],
			disabledRoles: [],
			embeddingsMode: "gateway",
		},
		problems: [],
		roles: AI_ROLES.map((role) => ({ role, label: ROLE_LABELS[role], needs: ROLE_NEEDS[role], pinned: role === "injection_scanner" })),
		authSecretSet: true,
		workersAi: {
			id: "workers-ai",
			label: "Cloudflare Workers AI",
			builtIn: true,
			roles: AI_ROLES.map((role) => ({
				role,
				modelId: WORKERS_AI_DEFAULTS[role],
				defaultModelId: WORKERS_AI_DEFAULTS[role],
				source: "default" as const,
				locked: role === "injection_scanner",
			})),
			tested: {},
		},
		status: {
			mode: "workers-ai",
			activeProviderId: "workers-ai",
			activeLabel: "Cloudflare Workers AI",
			line: "All AI runs on Cloudflare Workers AI.",
			exceptions: [{ role: "injection_scanner", text: "The prompt-injection scanner always runs on Workers AI." }],
		},
		usage: { month: "2026-10", byProvider: [{ providerId: "workers-ai", calls: 1234, inputTokens: null, outputTokens: null, costUsd: null }] },
		...over,
	};
}

function catalogueResponse(): WorkersAiCatalogueResponse {
	const models = normaliseCatalogue([
		row("@cf/moonshotai/kimi-k2.6", "Text Generation", { function_calling: "true", context_window: "262144" }),
		row("@cf/meta/llama-3.1-8b-instruct-fp8", "Text Generation", { context_window: "32000" }),
		row("@cf/meta/llama-4-scout-17b-16e-instruct", "Text Generation", { function_calling: "true" }),
		row("@cf/baai/bge-m3", "Text Embeddings", {}),
	]);
	return {
		source: "live",
		fetchedAt: "2026-10-29T00:00:00.000Z",
		detail: null,
		count: models.length,
		models,
		roles: AI_ROLES.map((role) => ({
			role,
			modelId: WORKERS_AI_DEFAULTS[role],
			unlisted: WORKERS_AI_DEFAULTS[role] === "@cf/moonshotai/kimi-k2.5" ? { successor: "@cf/moonshotai/kimi-k2.6" } : null,
		})),
	};
}

function render(data: ProvidersResponse, catalogue = catalogueResponse()): string {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	qc.setQueryData(["ai-providers"], data);
	qc.setQueryData(["ai-providers", "workers-ai-models"], catalogue);
	return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(AiProvidersSettings)));
}

const text = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ");

describe("AI providers page with no external provider", () => {
	const html = render(emptyResponse());
	const t = text(html);

	it("states the mode and the scanner exception", () => {
		expect(t).toContain("All AI runs on Cloudflare Workers AI.");
		expect(t).toContain("The prompt-injection scanner always runs on Workers AI.");
	});

	it("lists the built-in provider as Active, with this month's calls", () => {
		expect(t).toMatch(/Cloudflare Workers AI\s+Active/);
		expect(t).toContain("1,234 calls this month");
		expect(t).not.toContain("No providers");
		expect(t).toContain("Add provider");
		expect(t).toContain("bring your own key");
	});

	it("shows every role's model, the scanner locked, and the unlisted warning with a successor", () => {
		expect(t).toContain("Models · Cloudflare Workers AI");
		for (const role of AI_ROLES) expect(t).toContain(ROLE_LABELS[role]);
		expect(html).toContain('aria-label="Agent chat model"');
		expect(html).not.toContain('aria-label="Prompt-injection scanner model"');
		expect(t).toContain("Always this model. Not configurable.");
		expect(t).toContain("Not in Cloudflare's current catalogue — may be retired.");
		expect(t).toContain("Use moonshotai/kimi-k2.6");
	});

	it("offers only the role's task in each picker", () => {
		const embeddings = html.slice(html.indexOf('aria-label="Embeddings model"'));
		const select = embeddings.slice(0, embeddings.indexOf("</select>"));
		expect(select).toContain("baai/bge-m3");
		expect(select).not.toContain("kimi-k2.6");
	});
});

describe("AI providers page with an active gateway", () => {
	it("says so, and offers the one-click switch back", () => {
		const gw = {
			id: "corp",
			label: "Corp gateway",
			wire: "openai" as const,
			baseUrl: "https://llm.example.com/v1",
			exactBaseUrl: false,
			apiBase: "https://llm.example.com/v1",
			auth: { scheme: "bearer" as const },
			tokenSet: true,
			tokenHint: "…a1b2",
			headers: [],
			options: { structuredOutputs: "auto" as const, includeUsage: true, timeoutScale: 1, allowCustomPorts: false, litellmInfo: false },
			enabled: true,
			catalogue: { fetchedAt: null, status: "ok" as const, count: 1 },
			models: [],
			needsCustomIds: false,
			breaker: { state: "closed" as const, openUntil: null },
		};
		const data = emptyResponse({
			providers: [gw],
			routing: { ...emptyResponse().routing, gatewayProviderId: "corp" },
			status: {
				mode: "gateway",
				activeProviderId: "corp",
				activeLabel: "Corp gateway",
				line: "All AI runs on Corp gateway.",
				exceptions: [{ role: "injection_scanner", text: "The prompt-injection scanner always runs on Workers AI." }],
			},
		});
		const html = render(data);
		const t = text(html);
		// Switches name the provider they act on; aria-checked carries on/off.
		expect(html).toMatch(/role="switch" aria-checked="true"[^>]*aria-label="Enable Corp gateway"/);
		expect(html).not.toMatch(/aria-label="Turn (on|off) /);
		expect(html).toContain('aria-label="Active provider: Corp gateway"');
		// Active and enabled: no note under the title, so nothing to describe the switch with.
		const switchTag = (name: RegExp) => html.match(new RegExp(`<button[^>]*role="switch"[^>]*${name.source}[^>]*>`))?.[0] ?? "";
		const activeSwitch = switchTag(/aria-label="Active provider: Corp gateway"/);
		expect(activeSwitch).not.toBe("");
		expect(activeSwitch).not.toContain("aria-describedby");
		// The fallback switch keeps its note as its description, and the id points at that note.
		const fallbackSwitch = switchTag(/aria-describedby="[^"]+"/);
		const descId = fallbackSwitch.match(/aria-describedby="([^"]+)"/)?.[1];
		expect(descId).toBeTruthy();
		expect(text(html.slice(html.indexOf(`id="${descId}"`)))).toMatch(/^[^<]*If your gateway fails/);
		// Nothing picked yet: no unsaved bar, and the live region is there but empty.
		expect(html).not.toContain("data-unsaved-bar");
		expect(html).toContain('<p role="status" class="sr-only"></p>');
		expect(t).toContain("All AI runs on Corp gateway.");
		expect(t).toMatch(/Cloudflare Workers AI\s+Inactive/);
		expect(t).toMatch(/Corp gateway\s+Active/);
		expect(t).toContain("Use built-in");
		expect(t).toContain("Mail content is sent to llm.example.com");
	});
});

describe("provider card status", () => {
	const base = { enabled: true, breaker: { state: "closed" as const, openUntil: null }, catalogue: { status: "ok" as const, fetchedAt: null, count: 0 } };
	it("built-in: active unless a gateway is", () => {
		expect(providerStatus(null, true)).toBe("active");
		expect(providerStatus(null, false)).toBe("inactive");
	});
	it("gateways: off, paused by the breaker, failing, active or inactive", () => {
		expect(providerStatus({ ...base, enabled: false }, true)).toBe("off");
		expect(providerStatus({ ...base, breaker: { state: "open", openUntil: 1 } }, true)).toBe("paused");
		expect(providerStatus({ ...base, breaker: { state: "half-open", openUntil: null } }, false)).toBe("failing");
		expect(providerStatus({ ...base, catalogue: { ...base.catalogue, status: "auth-failed" } }, false)).toBe("failing");
		expect(providerStatus(base, true)).toBe("active");
		expect(providerStatus(base, false)).toBe("inactive");
	});
	it("usage label", () => {
		expect(usageLabel(undefined)).toBeNull();
		expect(usageLabel(0)).toBeNull();
		expect(usageLabel(1)).toBe("1 call this month");
	});
});
