import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { migrate } from "../workers/routes/migrate";
import type { Env } from "../workers/types";

/**
 * Regression cover for the migration router's mount path.
 *
 * `migrate` gates itself with a `use("*")` middleware that 404s when
 * MIGRATION_TOKEN is unset — the normal state for a production deploy. Hono
 * scopes a sub-app's middleware to its mount path, so mounting the router at
 * "/" applied that gate to every request and shadowed the React Router
 * catch-all in `workers/app.ts`: the entire UI answered
 * `{"error":"Not found"}` while the API, whose handlers register earlier, kept
 * working.
 *
 * These tests reproduce the real mount from `workers/index.ts` plus the
 * catch-all from `workers/app.ts` and assert non-migration paths fall through.
 */

const MOUNT = "/api/v1/_migrate";

/** The composition under test: migration router, then the SPA catch-all. */
function buildApp(env: Partial<Env>) {
	const app = new Hono<{ Bindings: Env }>();
	app.get("/api/v1/config", (c) => c.json({ config: true }));
	app.route(MOUNT, migrate);
	app.all("*", (c) => c.text("SPA_HTML"));

	return (path: string, init?: RequestInit) =>
		app.fetch(new Request(`https://mailer.tapetide.com${path}`, init), env as Env);
}

describe("migration router mounting", () => {
	it("leaves the SPA catch-all reachable when MIGRATION_TOKEN is unset", async () => {
		const request = buildApp({});

		// The paths a signed-in teammate actually loads.
		for (const path of ["/", "/inbox", "/people", "/settings"]) {
			const res = await request(path);
			expect(res.status, `${path} should render the SPA`).toBe(200);
			await expect(res.text()).resolves.toBe("SPA_HTML");
		}
	});

	it("leaves other API routes reachable", async () => {
		const res = await buildApp({})("/api/v1/config");
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ config: true });
	});

	it("still hides its own routes when MIGRATION_TOKEN is unset", async () => {
		const request = buildApp({});

		const status = await request(`${MOUNT}/mailboxes/a@tapetide.com/status`);
		expect(status.status).toBe(404);
		await expect(status.json()).resolves.toEqual({ error: "Not found" });

		const copy = await request(`${MOUNT}/mailboxes/a@tapetide.com`, { method: "POST" });
		expect(copy.status).toBe(404);
	});

	it("rejects a wrong token once MIGRATION_TOKEN is configured", async () => {
		const request = buildApp({ MIGRATION_TOKEN: "s3cret-token" });

		// Same length, wrong value — exercises the constant-time comparison path.
		const res = await request(`${MOUNT}/mailboxes/a@tapetide.com/status`, {
			headers: { "x-migration-token": "s3cret-tokeX" },
		});
		expect(res.status).toBe(403);
	});

	it("admits a correct token and then requires the LEGACY_MAILBOX binding", async () => {
		const request = buildApp({ MIGRATION_TOKEN: "s3cret-token" });

		// Past the gate: the 409 proves the route matched at its mounted path
		// rather than being swallowed by the token middleware or the catch-all.
		const res = await request(`${MOUNT}/mailboxes/a@tapetide.com/status`, {
			headers: { "x-migration-token": "s3cret-token" },
		});
		expect(res.status).toBe(409);
		await expect(res.json()).resolves.toEqual({
			error: "LEGACY_MAILBOX binding is not configured on this deployment",
		});
	});

	it("does not answer migration paths outside its mount prefix", async () => {
		const request = buildApp({ MIGRATION_TOKEN: "s3cret-token" });

		const res = await request("/mailboxes/a@tapetide.com/status", {
			headers: { "x-migration-token": "s3cret-token" },
		});
		expect(res.status).toBe(200);
		await expect(res.text()).resolves.toBe("SPA_HTML");
	});
});
