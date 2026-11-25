import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../shared/app-version";
import { systemChecks } from "../workers/routes/system";
import type { Env } from "../workers/types";

describe("APP_VERSION", () => {
	it("is a semantic version", () => {
		expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
	});
});

describe("system status checks", () => {
	const auth = { idFromName: () => "g", get: () => ({ getAuthEpoch: async () => 1 }) };
	const bucket = { head: async () => null };

	it("passes a fully configured deployment", async () => {
		const checks = await systemChecks({
			AUTH_STORE: auth,
			BUCKET: bucket,
			AUTH_SECRET: "x".repeat(32),
			API_RATE_LIMITER: {},
			AUTH_RATE_LIMITER: {},
			MCP_RATE_LIMITER: {},
			SEMANTIC_INDEX: {},
			AI: {},
		} as unknown as Env);
		expect(checks.every((c) => c.ok)).toBe(true);
		expect(checks.map((c) => c.id)).toEqual(["auth_store", "bucket", "auth_secret", "rate_limiters", "semantic_index", "workers_ai"]);
	});

	it("says what is missing and how to fix it", async () => {
		const checks = await systemChecks({
			AUTH_STORE: { idFromName: () => "g", get: () => ({ getAuthEpoch: async () => { throw new Error("boom"); } }) },
			BUCKET: bucket,
		} as unknown as Env);
		const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
		expect(byId.auth_store).toMatchObject({ ok: false, required: true });
		expect(byId.auth_store.detail).toContain("boom");
		expect(byId.auth_secret).toMatchObject({ ok: false, required: false });
		expect(byId.rate_limiters.detail).toContain("API_RATE_LIMITER");
	});
});
