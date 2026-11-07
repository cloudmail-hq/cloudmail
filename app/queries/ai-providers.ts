// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Bring-your-own AI gateway: `/api/v1/ai/providers` and `/api/v1/ai/routing`
 * (workers/routes/ai-providers.ts). Admin only.
 *
 * Tokens are write-only. They travel in a mutation body and nowhere else: never
 * in a query key, and each mutation that can carry one is reset on success so
 * the mutation cache doesn't keep the variables around.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiProviderAuth, AiRole, CatalogModel, WorkersAiTested } from "../../shared/ai-providers";
import type { WorkersAiModel } from "../../shared/workers-ai";
import type { RoleNeed, RoleProblem, Wire } from "../../shared/ai-gateway";
import { ApiError, request } from "~/services/api";

// ── Wire types (see ~/.tapetide-plan/byo-pr-c-contract.md) ─────────

export type EmbeddingsMode = "gateway" | "workers-ai" | "off";

export interface ProviderOptions {
	structuredOutputs: "auto" | "on" | "off";
	includeUsage: boolean;
	timeoutScale: number;
	allowCustomPorts: boolean;
	litellmInfo: boolean;
}

export interface ProviderHeaderView {
	name: string;
	secret: boolean;
	/** Plain headers only. */
	value?: string;
	set: boolean;
}

export interface ProviderView {
	id: string;
	label: string;
	wire: Wire;
	baseUrl: string;
	exactBaseUrl: boolean;
	apiBase: string;
	auth: AiProviderAuth;
	tokenSet: boolean;
	/** "…a1b2". The token itself is never returned. */
	tokenHint: string | null;
	headers: ProviderHeaderView[];
	options: ProviderOptions;
	enabled: boolean;
	catalogue: {
		fetchedAt: string | null;
		status: "never" | "ok" | "no-discovery" | "auth-failed" | "error";
		detail?: string | null;
		count: number;
	};
	models: CatalogModel[];
	needsCustomIds: boolean;
	breaker: { state: "closed" | "open" | "half-open"; openUntil: number | null };
	createdAt?: string;
	updatedAt?: string;
}

export interface RoleInfo {
	role: AiRole;
	label: string;
	needs: RoleNeed;
	pinned: boolean;
}

export interface RoutingView {
	gatewayProviderId: string | null;
	models: Record<string, { providerId?: string; modelId: string }>;
	default?: { providerId?: string; modelId: string };
	fallbackToWorkersAi: boolean;
	workersAiExceptions: string[];
	disabledRoles: string[];
	embeddingsMode: EmbeddingsMode;
}

export interface WorkersAiRoleView {
	role: AiRole;
	modelId: string;
	defaultModelId: string;
	/** admin: picked in settings. env: `SUMMARY_MODEL`. default: built in. */
	source: "admin" | "env" | "default";
	/** The injection scanner: shown, never changeable. */
	locked: boolean;
}

export interface WorkersAiView {
	id: "workers-ai";
	label: string;
	builtIn: true;
	roles: WorkersAiRoleView[];
	tested: Record<string, WorkersAiTested>;
}

export interface AiStatusView {
	mode: "workers-ai" | "gateway";
	activeProviderId: string;
	activeLabel: string;
	line: string;
	exceptions: { role: AiRole | null; text: string }[];
}

export interface ProviderUsage {
	providerId: string;
	calls: number;
	inputTokens: number | null;
	outputTokens: number | null;
	costUsd: number | null;
}

export interface ProvidersResponse {
	providers: ProviderView[];
	routing: RoutingView;
	problems: RoleProblem[];
	roles: RoleInfo[];
	authSecretSet: boolean;
	workersAi: WorkersAiView;
	status: AiStatusView;
	usage: { month: string; byProvider: ProviderUsage[] };
}

export interface WorkersAiCatalogueResponse {
	source: "live" | "fallback";
	fetchedAt: string;
	detail: string | null;
	count: number;
	models: WorkersAiModel[];
	roles: { role: AiRole; modelId: string; unlisted: { successor: string | null } | null }[];
}

export interface ProviderHeaderInput {
	name: string;
	value?: string;
	secret?: boolean;
}

export interface ProviderInput {
	label: string;
	wire: Wire;
	baseUrl: string;
	exactBaseUrl?: boolean;
	auth: AiProviderAuth;
	/** Create: the token. Patch: string = replace, null = clear, absent = keep. */
	token?: string | null;
	headers?: ProviderHeaderInput[];
	options?: Partial<ProviderOptions>;
}

export type ProviderPatch = Partial<ProviderInput> & { enabled?: boolean };

export interface ModelsPatch {
	add?: { id: string; label?: string; kind?: "chat" | "embedding" }[];
	remove?: string[];
	caps?: { id: string; tools?: boolean | null; json?: boolean | null; vision?: boolean | null; embed?: boolean | null }[];
}

export type TestCheck = "text" | "json" | "tools" | "embed";

export interface TestResult {
	check: TestCheck;
	ok: boolean;
	ms: number;
	/** Redacted by the server. */
	error?: string;
	dims?: number;
}

export interface RoutingPatch {
	gatewayProviderId?: string | null;
	models?: Partial<Record<AiRole, string | null>>;
	default?: string | null;
	fallbackToWorkersAi?: boolean;
	embeddings?: EmbeddingsMode;
}

// ── Client ─────────────────────────────────────────────────────────

const BASE = "/api/v1/ai/providers";
const json = (method: string, body: unknown, headers?: Record<string, string>): RequestInit => ({
	method,
	body: JSON.stringify(body),
	headers,
});

export const aiProvidersApi = {
	list: () => request<ProvidersResponse>(BASE),
	create: (input: ProviderInput, idempotencyKey: string) =>
		request<{ provider: ProviderView }>(BASE, json("POST", input, { "Idempotency-Key": idempotencyKey })),
	update: (id: string, patch: ProviderPatch) =>
		request<{ provider: ProviderView }>(`${BASE}/${encodeURIComponent(id)}`, json("PATCH", patch)),
	remove: (id: string) => request<void>(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" }),
	discover: (id: string) =>
		request<{ provider: ProviderView }>(`${BASE}/${encodeURIComponent(id)}/discover`, { method: "POST" }),
	models: (id: string, patch: ModelsPatch) =>
		request<{ provider: ProviderView }>(`${BASE}/${encodeURIComponent(id)}/models`, json("PATCH", patch)),
	test: (id: string, modelId: string, checks?: TestCheck[]) =>
		request<{ results: TestResult[]; provider: ProviderView }>(
			`${BASE}/${encodeURIComponent(id)}/test`,
			json("POST", checks ? { modelId, checks } : { modelId }),
		),
	routing: (patch: RoutingPatch) =>
		request<{ routing: RoutingView; problems: RoleProblem[] }>("/api/v1/ai/routing", json("PATCH", patch)),
	workersAiModels: (refresh = false) =>
		request<WorkersAiCatalogueResponse>(`${BASE}/workers-ai/models${refresh ? "?refresh=1" : ""}`),
	workersAiRouting: (models: Partial<Record<AiRole, string | null>>, confirmReindex?: boolean) =>
		request<{ workersAi: WorkersAiView; status: AiStatusView; reindex: boolean }>(
			`${BASE}/workers-ai/routing`,
			json("PATCH", confirmReindex ? { models, confirmReindex } : { models }),
		),
	workersAiTest: (modelId: string, checks?: TestCheck[]) =>
		request<{ results: TestResult[]; tested: WorkersAiTested | null }>(
			`${BASE}/workers-ai/test`,
			json("POST", checks ? { modelId, checks } : { modelId }),
		),
};

/** `{ problems }` from a 422 `capability_check_failed`, else null. */
export function routingProblemsFrom(error: unknown): RoleProblem[] | null {
	if (!(error instanceof ApiError) || error.status !== 422) return null;
	const problems = error.body.problems;
	return Array.isArray(problems) ? (problems as RoleProblem[]) : null;
}

// ── Hooks ──────────────────────────────────────────────────────────

const keys = { all: ["ai-providers"] as const };

export function useAiProviders(options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: keys.all,
		queryFn: aiProvidersApi.list,
		enabled: options?.enabled ?? true,
		retry: false,
	});
}

function useInvalidate() {
	const qc = useQueryClient();
	return () => qc.invalidateQueries({ queryKey: keys.all });
}

export function useCreateAiProvider() {
	const invalidate = useInvalidate();
	const m = useMutation({
		mutationFn: ({ input, idempotencyKey }: { input: ProviderInput; idempotencyKey: string }) =>
			aiProvidersApi.create(input, idempotencyKey),
		// The body may hold a token: drop the mutation's variables once it lands.
		onSuccess: () => {
			void invalidate();
			queueMicrotask(() => m.reset());
		},
	});
	return m;
}

export function useUpdateAiProvider() {
	const invalidate = useInvalidate();
	const m = useMutation({
		mutationFn: ({ id, patch }: { id: string; patch: ProviderPatch }) => aiProvidersApi.update(id, patch),
		onSuccess: () => {
			void invalidate();
			queueMicrotask(() => m.reset());
		},
	});
	return m;
}

export function useDeleteAiProvider() {
	const invalidate = useInvalidate();
	return useMutation({ mutationFn: (id: string) => aiProvidersApi.remove(id), onSuccess: () => invalidate() });
}

export function useDiscoverAiModels() {
	const invalidate = useInvalidate();
	return useMutation({ mutationFn: (id: string) => aiProvidersApi.discover(id), onSuccess: () => invalidate() });
}

export function usePatchAiModels() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: ({ id, patch }: { id: string; patch: ModelsPatch }) => aiProvidersApi.models(id, patch),
		onSuccess: () => invalidate(),
	});
}

export function useTestAiModel() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: ({ id, modelId, checks }: { id: string; modelId: string; checks?: TestCheck[] }) =>
			aiProvidersApi.test(id, modelId, checks),
		onSuccess: () => invalidate(),
	});
}

/** The live Workers AI catalogue (cached an hour on the server). */
export function useWorkersAiModels(options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: [...keys.all, "workers-ai-models"],
		queryFn: () => aiProvidersApi.workersAiModels(),
		enabled: options?.enabled ?? true,
		staleTime: 5 * 60_000,
		retry: false,
	});
}

export function usePatchWorkersAiRouting() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: ({ models, confirmReindex }: { models: Partial<Record<AiRole, string | null>>; confirmReindex?: boolean }) =>
			aiProvidersApi.workersAiRouting(models, confirmReindex),
		onSettled: () => invalidate(),
	});
}

export function useTestWorkersAiModel() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: ({ modelId, checks }: { modelId: string; checks?: TestCheck[] }) => aiProvidersApi.workersAiTest(modelId, checks),
		onSuccess: () => invalidate(),
	});
}

export function usePatchAiRouting() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: (patch: RoutingPatch) => aiProvidersApi.routing(patch),
		// A 422 changes nothing, but refetch anyway so problems stay current.
		onSettled: () => invalidate(),
	});
}
