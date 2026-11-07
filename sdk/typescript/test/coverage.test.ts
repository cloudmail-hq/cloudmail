/**
 * Every operation in openapi.json has a client method, or a reason it has
 * none in EXCLUDED.
 *
 * Rather than trusting names, it calls every public method of every resource
 * with placeholder arguments against a recording fetch, then maps each request
 * (method and path) back to an operation in the spec. A method that hits a
 * route the spec does not have fails the test too.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Tapetide } from "../src/index.js";

/** Operations an API token cannot use, so the SDK leaves them out. */
const EXCLUDED: Record<string, string> = {
	// Need a browser session that re-confirmed its password or passkey in the
	// last 15 minutes; a token gets 403 session_required / reauth_required.
	putCloudflareConnection: "browser session with recent re-authentication (403 session_required for tokens)",
	deleteCloudflareConnection: "browser session with recent re-authentication (403 session_required for tokens)",
	verifyCloudflareConnection: "browser session with recent re-authentication (403 session_required for tokens)",
	applyCloudflareSetup: "browser session with recent re-authentication (403 session_required for tokens)",
	revertCloudflareChange: "browser session with recent re-authentication (403 session_required for tokens)",
	deleteAccount: "browser session with recent re-authentication (403 session_required for tokens)",
	createAccountExport: "browser session with recent re-authentication (403 session_required for tokens)",
	// Licence changes are session-only.
	activateLicence: "browser session only (403 session_required for tokens)",
	deactivateLicence: "browser session only (403 session_required for tokens)",
	// Web Push devices belong to a browser; a token gets 409 no_identity.
	listPushSubscriptions: "per-browser Web Push device (409 no_identity for tokens)",
	createPushSubscription: "per-browser Web Push device (409 no_identity for tokens)",
	deletePushSubscription: "per-browser Web Push device (409 no_identity for tokens)",
	getPushPreferences: "per-browser Web Push device (409 no_identity for tokens)",
	updatePushPreferences: "per-browser Web Push device (409 no_identity for tokens)",
	sendTestPush: "per-browser Web Push device (409 no_identity for tokens)",
	// AI provider and routing changes need a person in the app.
	createAiProvider: "person only (403 person_required for tokens and OAuth apps)",
	updateAiProvider: "person only (403 person_required for tokens and OAuth apps)",
	deleteAiProvider: "person only (403 person_required for tokens and OAuth apps)",
	updateAiProviderModels: "person only (403 person_required for tokens and OAuth apps)",
	updateAiRouting: "person only (403 person_required for tokens and OAuth apps)",
	updateWorkersAiRouting: "person only (403 person_required for tokens and OAuth apps)",
};

type Spec = { paths: Record<string, Record<string, { operationId?: string }>> };
const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;

interface Route {
	id: string;
	method: string;
	re: RegExp;
	literals: number;
}

const routes: Route[] = [];
for (const [path, item] of Object.entries(spec.paths)) {
	for (const method of ["get", "post", "put", "patch", "delete"]) {
		const id = item[method]?.operationId;
		if (!id) continue;
		const segments = path.split("/");
		const re = new RegExp(`^${segments.map((s) => (/^\{.+\}$/.test(s) ? "[^/]+" : s.replace(/[.*+?^$()|[\]\\]/g, "\\$&"))).join("/")}$`);
		routes.push({ id, method: method.toUpperCase(), re, literals: segments.filter((s) => !s.startsWith("{")).length });
	}
}
// The most specific template wins: /approvals/count before /approvals/{id}.
routes.sort((a, b) => b.literals - a.literals);

function operationFor(method: string, url: string): string | undefined {
	const path = new URL(url).pathname;
	return routes.find((r) => r.method === method && r.re.test(path))?.id;
}

/** Answers every call with a body each method can unwrap. */
function recorder() {
	const calls: { method: string; url: string }[] = [];
	const fetch = async (input: string, init: RequestInit): Promise<Response> => {
		calls.push({ method: init.method ?? "GET", url: input });
		const body = {
			approval: { id: "a1", status: "sent" },
			approvals: [],
			pending: 0,
			webhook: { id: "w1" },
			webhooks: [],
			delivery: null,
			deliveries: [],
			agent_inbox: {},
			agent_inboxes: [],
			emails: [],
			totalCount: 0,
		};
		// A 401 ends the subscription after one request (an empty 200 would reconnect forever).
		if (input.includes("/events/sse")) return new Response(JSON.stringify({ error: "revoked" }), { status: 401 });
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	};
	return { calls, fetch };
}

/** Not resources: the transport, and the event stream (exercised separately). */
const SKIP_PROPS = new Set(["http", "events"]);
/** Private helpers that show up on a prototype. */
const SKIP_METHODS = new Set(["constructor", "post"]);

async function exercise(): Promise<{ covered: Map<string, string>; unmatched: string[] }> {
	const rec = recorder();
	const t = new Tapetide({ baseUrl: "https://mail.example.com", token: "ttk_test_secret", fetch: rec.fetch, sleep: async () => {}, maxRetries: 0 });
	const covered = new Map<string, string>();
	const unmatched: string[] = [];
	const note = (label: string) => {
		for (const call of rec.calls.splice(0)) {
			const op = operationFor(call.method, call.url);
			if (op) covered.set(op, covered.get(op) ?? label);
			else unmatched.push(`${label}: ${call.method} ${call.url}`);
		}
	};

	for (const [prop, resource] of Object.entries(t)) {
		if (SKIP_PROPS.has(prop)) continue;
		const proto = Object.getPrototypeOf(resource) as Record<string, unknown>;
		for (const name of Object.getOwnPropertyNames(proto)) {
			const fn = proto[name];
			if (SKIP_METHODS.has(name) || typeof fn !== "function") continue;
			const args = Array.from({ length: fn.length }, (_, i) => `arg${i + 1}`);
			await (fn as (...a: unknown[]) => Promise<unknown>).apply(resource, args);
			note(`${prop}.${name}`);
		}
	}

	// The event stream: SSE over fetch, and the WebSocket transport.
	const sse = t.events.subscribe({ mailboxes: ["s@example.com"], sleep: async () => {}, onError: () => {} }, () => {});
	await sse.closed;
	note("events.subscribe");
	const ws = t.events.subscribe(
		{
			transport: "websocket",
			sleep: async () => {},
			onError: () => {},
			webSocket: (url) => {
				rec.calls.push({ method: "GET", url: url.replace(/^ws/, "http") });
				const sock = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
				return sock;
			},
		},
		() => {},
	);
	await new Promise((r) => setTimeout(r, 10));
	ws.close();
	note("events.subscribe (websocket)");

	return { covered, unmatched };
}

describe("OpenAPI coverage", () => {
	it("has a client method for every operation that is not excluded", async () => {
		const { covered, unmatched } = await exercise();
		expect(unmatched, "methods calling routes the spec does not have").toEqual([]);
		const missing = routes.map((r) => r.id).filter((id) => !covered.has(id) && !(id in EXCLUDED));
		expect(missing, "operations without a client method: add one, or an EXCLUDED entry with a reason").toEqual([]);
	});

	it("keeps the exclusion list honest", async () => {
		const { covered } = await exercise();
		const ids = new Set(routes.map((r) => r.id));
		for (const [id, reason] of Object.entries(EXCLUDED)) {
			expect(ids.has(id), `${id} is not in openapi.json`).toBe(true);
			expect(covered.has(id), `${id} is excluded but has a method (${covered.get(id)})`).toBe(false);
			expect(reason.length).toBeGreaterThan(10);
		}
	});
});
