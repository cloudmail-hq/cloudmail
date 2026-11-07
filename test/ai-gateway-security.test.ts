// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Bring-your-own AI gateway security (research doc section 4): the outbound
 * URL guard's ai-gateway rules, the guarded fetch every gateway call goes
 * through, error redaction, and token encryption at rest.
 */

import { describe, expect, it, vi } from "vitest";
import { validatePublicHttpsUrl, type OutboundUrlOptions } from "../shared/outbound-url";
import { validateWebhookUrl } from "../shared/webhooks";
import {
	describeGatewayError,
	gatewayFetch,
	GatewayFetchError,
	readJsonCapped,
	redactGatewayText,
} from "../workers/lib/ai-gateway-fetch";
import {
	openProviderHeader,
	openProviderSecrets,
	openProviderToken,
	sealProviderHeader,
	sealProviderToken,
} from "../workers/lib/ai-provider-secrets";
import { decryptSecret } from "../workers/auth/crypto";
import { AiProviderSchema } from "../shared/ai-providers";

const KEY = "test-key-material-not-a-secret";
const OTHER_KEY = "other-key-material-not-a-secret";
const TOKEN = "sk-test-0123456789abcdef";

// ── URL guard ──────────────────────────────────────────────────────

describe("validatePublicHttpsUrl (ai-gateway)", () => {
	const ai = (raw: string, extra: Partial<OutboundUrlOptions> = {}) =>
		validatePublicHttpsUrl(raw, { purpose: "ai-gateway", ownHosts: ["mail.example.com", "*.tapetide.test2"], ...extra });

	it("refuses this deployment's own hosts", () => {
		expect(ai("https://mail.example.com/v1").ok).toBe(false);
		expect(ai("https://MAIL.example.com./v1").ok).toBe(false);
		expect(ai("https://a.tapetide.test2/v1").ok).toBe(false);
		expect(ai("https://tapetide.test2/v1").ok).toBe(false);
		expect(ai("https://other.example.com/v1").ok).toBe(true);
	});

	it("refuses any workers.dev host", () => {
		const r = ai("https://someone-else.acct.workers.dev/v1");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/workers\.dev/);
	});

	it("port 443 only unless custom ports are allowed", () => {
		expect(ai("https://llm.example.com:8443/v1").ok).toBe(false);
		expect(ai("https://llm.example.com:8443/v1", { allowCustomPorts: true }).ok).toBe(true);
		expect(ai("https://llm.example.com:443/v1")).toEqual({ ok: true, url: "https://llm.example.com/v1" });
	});

	it("the Cloudflare API only with the AI Gateway preset", () => {
		const url = "https://api.cloudflare.com/client/v4/accounts/abc/ai/run";
		expect(ai(url).ok).toBe(false);
		expect(ai("https://api.cloudflare.com/Client/V4/accounts").ok).toBe(false);
		expect(ai(url, { allowCloudflareApi: true }).ok).toBe(true);
	});

	it("refuses http and userinfo", () => {
		const r = ai("http://api.openai.com/v1");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/Gateway URLs must use https/);
		expect(ai("https://user:pass@api.openai.com/v1").ok).toBe(false);
		expect(ai("https://user@api.openai.com/v1").ok).toBe(false);
	});

	it.each([
		"https://localhost/v1",
		"https://127.0.0.1/v1",
		"https://10.1.2.3/v1",
		"https://169.254.169.254/latest/meta-data",
		"https://[::1]/v1",
		"https://[fd12:3456::1]/v1",
		"https://[::ffff:127.0.0.1]/v1",
		"https://2130706433/v1",
		"https://llm.internal/v1",
	])("refuses private %s", (url) => {
		expect(ai(url).ok).toBe(false);
	});

	it.each(["https://api.openai.com/v1", "https://openrouter.ai/api/v1", "https://gateway.ai.cloudflare.com/v1/a/g/openai"])(
		"allows public %s",
		(url) => {
			expect(ai(url).ok).toBe(true);
		},
	);

	it("webhooks keep their own rules: https required, no port rule", () => {
		const r = validateWebhookUrl("http://hooks.example.com/x");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("https");
		expect(validateWebhookUrl("https://hooks.example.com:8443/x").ok).toBe(true);
		expect(validateWebhookUrl("https://x.workers.dev/hook").ok).toBe(true);
	});
});

// ── gatewayFetch ───────────────────────────────────────────────────

const ok = () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });

function guarded(fake: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
	return gatewayFetch({
		apiBase: "https://api.example.com/v1",
		ownHosts: ["mail.example.com"],
		secrets: [TOKEN],
		fetch: fake as unknown as typeof fetch,
		...extra,
	});
}

async function rejection(p: Promise<unknown>): Promise<GatewayFetchError> {
	try {
		await p;
	} catch (e) {
		return e as GatewayFetchError;
	}
	throw new Error("expected a rejection");
}

describe("gatewayFetch", () => {
	it("(a) re-validates every call", async () => {
		const fake = vi.fn(async () => ok());
		const f = guarded(fake, { apiBase: "https://api.example.com/v1" });
		expect((await f("https://api.example.com/v1/models")).status).toBe(200);
		expect(fake).toHaveBeenCalledTimes(1);

		const e = await rejection(f("https://10.0.0.1/v1/models"));
		expect(e).toBeInstanceOf(GatewayFetchError);
		expect(e.code).toBe("blocked");
		expect(fake).toHaveBeenCalledTimes(1);

		// Even a private apiBase is refused at call time.
		const priv = vi.fn(async () => ok());
		const g = guarded(priv, { apiBase: "https://10.0.0.1/v1" });
		expect((await rejection(g("https://10.0.0.1/v1/models"))).code).toBe("blocked");
		expect(priv).not.toHaveBeenCalled();
	});

	it("(b) refuses URLs outside the API base", async () => {
		const fake = vi.fn(async () => ok());
		const f = guarded(fake);
		for (const url of [
			"https://evil.example.com/v1/models",
			"https://api.example.com/v1x/models",
			"https://api.example.com/v2/models",
			"https://api.example.com:8443/v1/models",
		]) {
			expect((await rejection(f(url))).code).toBe("blocked");
		}
		expect(fake).not.toHaveBeenCalled();
		// The base itself and anything under it pass.
		await f("https://api.example.com/v1");
		await f(new URL("https://api.example.com/v1/chat/completions"), { method: "POST" });
		expect(fake).toHaveBeenCalledTimes(2);
	});

	it("(c) passes redirect: manual and never follows a 3xx", async () => {
		const fake = vi.fn(async (_url: string, init?: RequestInit) => {
			expect(init?.redirect).toBe("manual");
			return fake.mock.calls.length === 1
				? ok()
				: new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } });
		});
		const f = guarded(fake);
		await f("https://api.example.com/v1/models", { redirect: "follow" });
		const e = await rejection(f("https://api.example.com/v1/models"));
		expect(e.code).toBe("redirect");
		expect(e.statusCode).toBe(302);
		expect(fake).toHaveBeenCalledTimes(2);
		for (const call of fake.mock.calls) expect(String(call[0])).not.toContain("evil");
	});

	it("(d) times out", async () => {
		const fake = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_, reject) => {
					init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
				}),
		);
		const e = await rejection(guarded(fake, { timeoutMs: 50 })("https://api.example.com/v1/models"));
		expect(e).toBeInstanceOf(GatewayFetchError);
		expect(e.code).toBe("timeout");
	});

	it("(e) honours the caller's AbortSignal", async () => {
		const fake = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_, reject) => {
					if (init!.signal!.aborted) return reject(init!.signal!.reason);
					init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
				}),
		);
		const controller = new AbortController();
		const p = guarded(fake, { timeoutMs: 60_000 })("https://api.example.com/v1/models", { signal: controller.signal });
		controller.abort();
		const e = await rejection(p);
		expect((e as Error).name).toBe("AbortError");
		expect(e).not.toBeInstanceOf(GatewayFetchError);
	});

	it("(f) redacts the token from a network error", async () => {
		const fake = vi.fn(async () => {
			throw new TypeError(`connect failed for Authorization: Bearer ${TOKEN} (key ${TOKEN})`);
		});
		const e = await rejection(guarded(fake)("https://api.example.com/v1/models"));
		expect(e.code).toBe("network");
		expect(e.message).toMatch(/Could not reach the gateway/);
		expect(e.message).not.toContain(TOKEN);
	});

	it("(g) accepts a Request input, guarded the same way", async () => {
		const fake = vi.fn(async (req: Request) => {
			expect(req).toBeInstanceOf(Request);
			expect(req.redirect).toBe("manual");
			expect(req.method).toBe("POST");
			expect(await req.text()).toBe('{"a":1}');
			return ok();
		});
		const f = guarded(fake);
		const res = await f(new Request("https://api.example.com/v1/chat/completions", { method: "POST", body: '{"a":1}' }));
		expect(res.status).toBe(200);
		expect(fake).toHaveBeenCalledTimes(1);

		const e = await rejection(f(new Request("https://evil.example.com/v1/chat/completions")));
		expect(e.code).toBe("blocked");
		expect(fake).toHaveBeenCalledTimes(1);
	});
});

describe("readJsonCapped", () => {
	it("reads JSON under the cap", async () => {
		expect(await readJsonCapped(new Response('{"data":[1,2]}'), 100)).toEqual({ data: [1, 2] });
	});

	it("refuses an oversized declared content-length", async () => {
		const res = new Response("{}", { headers: { "content-length": "5000" } });
		const e = await rejection(readJsonCapped(res, 100));
		expect(e.code).toBe("too-large");
	});

	it("refuses an oversized stream with no content-length", async () => {
		const chunk = new TextEncoder().encode("x".repeat(64));
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent++ < 10) controller.enqueue(chunk);
				else controller.close();
			},
		});
		const e = await rejection(readJsonCapped(new Response(body), 100));
		expect(e.code).toBe("too-large");
		expect(sent).toBeLessThan(10);
	});
});

// ── Redaction ──────────────────────────────────────────────────────

describe("redaction", () => {
	it.each([
		[`the key ${"mysecretvalue"} leaked`, "mysecretvalue"],
		["Authorization: Bearer xyz", "xyz"],
		["x-api-key: abc", "abc"],
		['{"api-key":"abc"}', "abc"],
		["key sk-proj-AbCdEf123456_-zz rejected", "sk-proj-AbCdEf123456_-zz"],
		["cf-aig-authorization: Bearer gwtoken123", "gwtoken123"],
	])("removes the secret from %s", (text, secret) => {
		const out = redactGatewayText(text, ["mysecretvalue"]);
		expect(out).not.toContain(secret);
		expect(out).toContain("•••");
	});

	it("describeGatewayError keeps only status and a one-line redacted message", () => {
		const apiCallError = {
			name: "AI_APICallError",
			message: `Incorrect API key provided: ${TOKEN}\nfull request dump follows`,
			statusCode: 401,
			url: "https://api.example.com/v1/chat/completions",
			requestBodyValues: { messages: [{ role: "user", content: "mail body: quarterly numbers" }] },
			responseBody: JSON.stringify({ error: { message: `bad key ${TOKEN}` } }),
			responseHeaders: { "x-request-id": "req_1", "set-cookie": "s=1" },
			isRetryable: false,
		};
		const result = describeGatewayError(apiCallError, [TOKEN]);
		expect(Object.keys(result).sort()).toEqual(["message", "status"]);
		expect(result.status).toBe(401);
		const json = JSON.stringify(result);
		expect(json).not.toContain("mail body");
		expect(json).not.toContain(TOKEN);
		expect(json).not.toContain("api.example.com");
		expect(json).not.toContain("full request dump");
		expect(result.message).toMatch(/^Incorrect API key provided/);
	});

	it("describeGatewayError copes with non-errors", () => {
		expect(describeGatewayError("boom")).toEqual({ status: null, message: "boom" });
		expect(describeGatewayError({ status: 503, message: "busy" })).toEqual({ status: 503, message: "busy" });
	});
});

// ── Tokens at rest ─────────────────────────────────────────────────

describe("provider token encryption", () => {
	it("round-trips and the ciphertext hides the plaintext", async () => {
		const enc = await sealProviderToken(TOKEN, KEY, "gw");
		expect(enc).not.toContain(TOKEN);
		expect(enc.startsWith("v1.")).toBe(true);
		expect(await openProviderToken(enc, KEY, "gw")).toBe(TOKEN);
	});

	it("is bound to the provider id (AAD)", async () => {
		const enc = await sealProviderToken(TOKEN, KEY, "gw");
		await expect(openProviderToken(enc, KEY, "other")).rejects.toThrow();
	});

	it("fails under a different key", async () => {
		const enc = await sealProviderToken(TOKEN, KEY, "gw");
		await expect(openProviderToken(enc, OTHER_KEY, "gw")).rejects.toThrow();
	});

	it("uses its own HKDF info, separate from TOTP", async () => {
		const enc = await sealProviderToken(TOKEN, KEY, "gw");
		await expect(decryptSecret(enc, KEY)).rejects.toThrow();
	});

	it("header ciphertexts are bound to provider and header name", async () => {
		const enc = await sealProviderHeader("hdr-secret-value", KEY, "gw", "cf-aig-authorization");
		expect(await openProviderHeader(enc, KEY, "gw", "cf-aig-authorization")).toBe("hdr-secret-value");
		expect(await openProviderHeader(enc, KEY, "gw", "CF-AIG-Authorization")).toBe("hdr-secret-value");
		await expect(openProviderToken(enc, KEY, "gw")).rejects.toThrow();
		await expect(openProviderHeader(enc, KEY, "gw", "x-title")).rejects.toThrow();
		await expect(openProviderHeader(enc, KEY, "other", "cf-aig-authorization")).rejects.toThrow();
		// And a token can't be opened as a header.
		const tok = await sealProviderToken(TOKEN, KEY, "gw");
		await expect(openProviderHeader(tok, KEY, "gw", "token")).rejects.toThrow();
	});

	it("two seals of the same token differ (random IV)", async () => {
		const a = await sealProviderToken(TOKEN, KEY, "gw");
		const b = await sealProviderToken(TOKEN, KEY, "gw");
		expect(a).not.toBe(b);
	});

	it("openProviderSecrets returns the token and plain and secret header values", async () => {
		const provider = AiProviderSchema.parse({
			id: "gw",
			label: "Gateway",
			wire: "openai",
			baseUrl: "https://api.example.com",
			auth: { scheme: "bearer" },
			tokenEnc: await sealProviderToken(TOKEN, KEY, "gw"),
			headers: [
				{ name: "X-Title", value: "Tapetide" },
				{ name: "cf-aig-authorization", secret: true, valueEnc: await sealProviderHeader("Bearer gwtok", KEY, "gw", "cf-aig-authorization") },
			],
		});
		expect(await openProviderSecrets(provider, KEY)).toEqual({
			token: TOKEN,
			headers: { "X-Title": "Tapetide", "cf-aig-authorization": "Bearer gwtok" },
		});
	});

	it("openProviderSecrets with no token gives null", async () => {
		const provider = AiProviderSchema.parse({ id: "gw", label: "G", wire: "openai", baseUrl: "https://x.example.com", auth: { scheme: "none" } });
		expect(await openProviderSecrets(provider, KEY)).toEqual({ token: null, headers: {} });
	});
});
