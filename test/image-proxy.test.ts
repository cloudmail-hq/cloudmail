/**
 * The remote-image proxy fetches URLs a stranger wrote into an email, so most of
 * these tests are about what it refuses: unsigned or altered URLs, internal
 * hosts in every disguise, redirects into the network, oversized and non-image
 * bodies, and slow upstreams.
 */

import { describe, expect, it, vi } from "vitest";
import {
	buildImageProxyMap,
	findImageSources,
	imageProxyExpiry,
	IMAGE_PROXY_TTL_SECONDS,
	normalizeRemoteImageUrl,
	signImageUrl,
	verifyImageUrl,
} from "../shared/image-proxy";
import {
	fetchRemoteImage,
	handleImageProxy,
	imageUrlProblem,
	IMAGE_PROXY_MAX_BYTES,
	type ProxyFetch,
} from "../workers/lib/image-proxy";
import type { Env } from "../workers/types";

const SECRET = "test-secret";
const env = {} as Env;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function image(type = "image/png", body: BodyInit = PNG, extra: Record<string, string> = {}): Response {
	return new Response(body, { status: 200, headers: { "content-type": type, ...extra } });
}

/** A fetcher that records every request and answers from a table. */
function stub(routes: Record<string, () => Response>) {
	const seen: Request[] = [];
	const fetcher: ProxyFetch = async (req) => {
		seen.push(req);
		const handler = routes[req.url];
		if (!handler) throw new Error(`unexpected fetch ${req.url}`);
		return handler();
	};
	return { fetcher, seen };
}

const EXP = imageProxyExpiry();

async function proxyRequest(url: string, sig?: string, exp = EXP) {
	const s = sig ?? (await signImageUrl(SECRET, url, exp));
	return new Request(`https://mailer.example/img/${s}?e=${exp}&u=${encodeURIComponent(url)}`, {
		headers: { cookie: "__Host-tt_session=abc", referer: "https://mailer.example/mail/inbox" },
	});
}

describe("signing", () => {
	it("verifies its own signature and nothing else", async () => {
		const url = "https://cdn.example/a.png";
		const sig = await signImageUrl(SECRET, url, EXP);
		expect(await verifyImageUrl(SECRET, url, EXP, sig)).toBe(true);
		expect(await verifyImageUrl(SECRET, "https://cdn.example/b.png", EXP, sig)).toBe(false);
		expect(await verifyImageUrl("other-secret", url, EXP, sig)).toBe(false);
	});

	it("rejects a tampered or malformed signature", async () => {
		const url = "https://cdn.example/a.png";
		const sig = await signImageUrl(SECRET, url, EXP);
		const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
		expect(await verifyImageUrl(SECRET, url, EXP, flipped)).toBe(false);
		expect(await verifyImageUrl(SECRET, url, EXP, sig.slice(1))).toBe(false);
		expect(await verifyImageUrl(SECRET, url, EXP, "")).toBe(false);
		expect(await verifyImageUrl(SECRET, url, EXP, `${sig.slice(0, -1)}+`)).toBe(false);
	});

	it("binds the expiry: a changed, passed or far-future stamp fails", async () => {
		const url = "https://cdn.example/a.png";
		const sig = await signImageUrl(SECRET, url, EXP);
		// Extending the stamp breaks the signature.
		expect(await verifyImageUrl(SECRET, url, EXP + IMAGE_PROXY_TTL_SECONDS, sig)).toBe(false);
		// Past expiry.
		expect(await verifyImageUrl(SECRET, url, EXP, sig, (EXP + 1) * 1000)).toBe(false);
		// A correctly signed stamp beyond anything we issue (a leaked secret
		// cannot mint a URL that lives for years).
		const far = EXP + 400 * IMAGE_PROXY_TTL_SECONDS;
		expect(await verifyImageUrl(SECRET, url, far, await signImageUrl(SECRET, url, far))).toBe(false);
		expect(await verifyImageUrl(SECRET, url, Number.NaN, sig)).toBe(false);
	});

	it("keeps a URL stable within a day and valid for one to two days", () => {
		const day = IMAGE_PROXY_TTL_SECONDS * 1000;
		const t = Date.UTC(2026, 9, 26, 0, 0, 1);
		expect(imageProxyExpiry(t)).toBe(imageProxyExpiry(t + day - 2000));
		const lifetime = imageProxyExpiry(t) * 1000 - t;
		expect(lifetime).toBeGreaterThan(day);
		expect(lifetime).toBeLessThanOrEqual(2 * day);
	});

	it("normalises sources: entities, protocol-relative, http upgraded, junk refused", () => {
		expect(normalizeRemoteImageUrl("https://a.example/x?a=1&amp;b=2")).toBe("https://a.example/x?a=1&b=2");
		expect(normalizeRemoteImageUrl("//a.example/x.png")).toBe("https://a.example/x.png");
		expect(normalizeRemoteImageUrl("http://a.example/x.png")).toBe("https://a.example/x.png");
		expect(normalizeRemoteImageUrl("data:image/png;base64,AAA")).toBeNull();
		expect(normalizeRemoteImageUrl(`https://a.example/${"x".repeat(3000)}`)).toBeNull();
	});

	it("maps each raw remote src to a proxy path that verifies", async () => {
		const html = '<img src="https://a.example/1.png"><img src=\'//b.example/2.gif\'><img src="cid:x"><img src="https://a.example/1.png">';
		expect(findImageSources(html)).toEqual(["https://a.example/1.png", "//b.example/2.gif"]);
		const map = await buildImageProxyMap(SECRET, html);
		expect(Object.keys(map)).toEqual(["https://a.example/1.png", "//b.example/2.gif"]);
		const path = new URL(map["//b.example/2.gif"]!, "https://x");
		expect(path.searchParams.get("u")).toBe("https://b.example/2.gif");
		const exp = Number(path.searchParams.get("e"));
		expect(await verifyImageUrl(SECRET, "https://b.example/2.gif", exp, path.pathname.split("/")[2]!)).toBe(true);
	});
});

describe("SSRF guard", () => {
	const refused = [
		"http://cdn.example/a.png",
		"ftp://cdn.example/a.png",
		"https://user:pw@cdn.example/a.png",
		"https://localhost/a.png",
		"https://127.0.0.1/a.png",
		"https://2130706433/a.png", // 127.0.0.1 as an integer
		"https://0x7f.1/a.png",
		"https://10.0.0.5/a.png",
		"https://172.16.0.1/a.png",
		"https://192.168.1.1/a.png",
		"https://169.254.169.254/latest/meta-data/", // cloud metadata
		"https://100.64.0.1/a.png", // CGNAT
		"https://0.0.0.0/a.png",
		"https://[::1]/a.png",
		"https://[::]/a.png",
		"https://[fe80::1]/a.png",
		"https://[fd00::1]/a.png",
		"https://[::ffff:127.0.0.1]/a.png", // IPv4-mapped
		"https://[::ffff:169.254.169.254]/a.png",
		"https://[::ffff:0:10.0.0.1]/a.png", // SIIT
		"https://[64:ff9b::10.0.0.1]/a.png", // NAT64
		"https://[2002:a9fe:a9fe::]/a.png", // 6to4 wrapping 169.254.169.254
		"https://metadata.google.internal/a.png",
		"https://printer.local/a.png",
		"https://intranet/a.png",
		"https://cdn.example:8443/a.png",
	];
	for (const url of refused) {
		it(`refuses ${url}`, () => {
			expect(imageUrlProblem(url)).not.toBeNull();
		});
	}

	it("allows a plain public https URL", () => {
		expect(imageUrlProblem("https://cdn.example/a.png")).toBeNull();
		expect(imageUrlProblem("https://93.184.216.34/a.png")).toBeNull();
	});
});

describe("fetchRemoteImage", () => {
	it("fetches an image with no client headers and a fixed user agent", async () => {
		const { fetcher, seen } = stub({ "https://cdn.example/a.png": () => image() });
		const result = await fetchRemoteImage("https://cdn.example/a.png", fetcher);
		expect(result.status).toBe(200);
		expect(result.contentType).toBe("image/png");
		const sent = seen[0]!;
		expect(sent.headers.get("cookie")).toBeNull();
		expect(sent.headers.get("referer")).toBeNull();
		expect(sent.headers.get("authorization")).toBeNull();
		expect(sent.headers.get("user-agent")).toMatch(/MailImageProxy/);
		expect(sent.headers.get("user-agent")).not.toMatch(/tapetide/i);
		expect(sent.redirect).toBe("manual");
	});

	it("follows a public redirect but re-checks every hop", async () => {
		const ok = stub({
			"https://t.example/r": () => new Response(null, { status: 302, headers: { location: "https://cdn.example/a.png" } }),
			"https://cdn.example/a.png": () => image(),
		});
		expect((await fetchRemoteImage("https://t.example/r", ok.fetcher)).status).toBe(200);

		for (const location of ["https://169.254.169.254/latest/meta-data/", "http://cdn.example/a.png", "https://[::ffff:10.0.0.1]/x", "/../../internal"]) {
			const bad = stub({
				"https://t.example/r": () => new Response(null, { status: 301, headers: { location } }),
				"https://t.example/internal": () => image(),
			});
			const result = await fetchRemoteImage("https://t.example/r", bad.fetcher);
			if (location.startsWith("/")) {
				// A relative redirect resolves against the same public host, which is fine.
				expect(result.status).toBe(200);
			} else {
				expect(result.status, location).toBe(403);
				expect(bad.seen).toHaveLength(1);
			}
		}
	});

	it("gives up after three redirects", async () => {
		const { fetcher } = stub({
			"https://t.example/r": () => new Response(null, { status: 302, headers: { location: "https://t.example/r" } }),
		});
		expect((await fetchRemoteImage("https://t.example/r", fetcher)).status).toBe(502);
	});

	it("refuses non-image and SVG content types", async () => {
		for (const type of ["text/html", "image/svg+xml", "application/octet-stream", ""]) {
			const { fetcher } = stub({ "https://cdn.example/a": () => image(type) });
			expect((await fetchRemoteImage("https://cdn.example/a", fetcher)).status, type).toBe(415);
		}
	});

	it("accepts the raster image types", async () => {
		for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "IMAGE/PNG; charset=binary"]) {
			const { fetcher } = stub({ "https://cdn.example/a": () => image(type) });
			expect((await fetchRemoteImage("https://cdn.example/a", fetcher)).status, type).toBe(200);
		}
	});

	it("refuses a body over 5 MB by Content-Length", async () => {
		const { fetcher } = stub({
			"https://cdn.example/big": () => image("image/png", PNG, { "content-length": String(IMAGE_PROXY_MAX_BYTES + 1) }),
		});
		expect((await fetchRemoteImage("https://cdn.example/big", fetcher)).status).toBe(413);
	});

	it("refuses a body over the cap while streaming, when the length lies", async () => {
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(64 * 1024));
			},
		});
		const { fetcher } = stub({ "https://cdn.example/stream": () => image("image/png", stream) });
		expect((await fetchRemoteImage("https://cdn.example/stream", fetcher, { maxBytes: 256 * 1024 })).status).toBe(413);
	});

	it("times out a slow upstream", async () => {
		// Fake timers: no real wait. The test also holds the Request: its signal
		// follows the proxy's controller only through a weak reference in Node, so
		// a GC during a real-time wait could drop the abort and hang the test.
		vi.useFakeTimers();
		try {
			const seen: Request[] = [];
			const fetcher: ProxyFetch = (req) => {
				seen.push(req);
				return new Promise((_, reject) =>
					req.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
				);
			};
			let settled = false;
			const result = fetchRemoteImage("https://slow.example/a.png", fetcher, { timeoutMs: 20 }).finally(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(19);
			expect(settled).toBe(false);
			expect(seen[0]!.signal.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect((await result).status).toBe(504);
			expect(seen[0]!.signal.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports an upstream error", async () => {
		const { fetcher } = stub({ "https://cdn.example/404": () => new Response("no", { status: 404 }) });
		expect((await fetchRemoteImage("https://cdn.example/404", fetcher)).status).toBe(502);
	});
});

describe("handleImageProxy", () => {
	const noWait = () => {};

	it("serves a signed image with safe headers and no upstream cookies", async () => {
		const { fetcher, seen } = stub({
			"https://cdn.example/a.png": () => image("image/png", PNG, { "set-cookie": "track=1" }),
		});
		const res = await handleImageProxy(await proxyRequest("https://cdn.example/a.png"), env, noWait, { fetcher, cache: null, secret: SECRET });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
		expect(res.headers.get("set-cookie")).toBeNull();
		// The sandboxed frame is an opaque origin; same-origin would block it.
		expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
		expect(res.headers.get("cache-control")).toMatch(/^private/);
		expect(seen[0]!.headers.get("cookie")).toBeNull();
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
	});

	it("refuses a tampered signature or URL without fetching", async () => {
		const { fetcher, seen } = stub({});
		const sig = await signImageUrl(SECRET, "https://cdn.example/a.png", EXP);
		const swapped = await handleImageProxy(await proxyRequest("https://cdn.example/b.png", sig), env, noWait, { fetcher, cache: null, secret: SECRET });
		expect(swapped.status).toBe(403);
		const forged = await handleImageProxy(await proxyRequest("https://cdn.example/a.png", "x".repeat(43)), env, noWait, { fetcher, cache: null, secret: SECRET });
		expect(forged.status).toBe(403);
		expect(seen).toHaveLength(0);
	});

	it("refuses a correctly signed internal URL", async () => {
		// Defence in depth: the guard runs even when the signature is valid.
		const { fetcher, seen } = stub({});
		const res = await handleImageProxy(await proxyRequest("https://169.254.169.254/latest/meta-data/"), env, noWait, { fetcher, cache: null, secret: SECRET });
		expect(res.status).toBe(403);
		expect(seen).toHaveLength(0);
	});

	it("answers from the cache on a second open", async () => {
		const store = new Map<string, Response>();
		const cache = {
			match: async (k: Request) => store.get(k.url)?.clone(),
			put: async (k: Request, v: Response) => void store.set(k.url, v),
		};
		const pending: Promise<unknown>[] = [];
		const { fetcher, seen } = stub({ "https://cdn.example/a.png": () => image() });
		const first = await handleImageProxy(await proxyRequest("https://cdn.example/a.png"), env, (p) => pending.push(p), { fetcher, cache, secret: SECRET });
		expect(first.status).toBe(200);
		await Promise.all(pending);
		const second = await handleImageProxy(await proxyRequest("https://cdn.example/a.png"), env, noWait, { fetcher, cache, secret: SECRET });
		expect(second.status).toBe(200);
		expect(second.headers.get("cache-control")).toMatch(/^private/);
		expect(seen).toHaveLength(1);
	});

	it("refuses this deployment's own hosts, which a Worker fetch would reach at the origin", async () => {
		const { fetcher, seen } = stub({});
		for (const target of ["https://mailer.example/api/v1/me", "https://tapetide.com/x.png", "https://assets.tapetide.com/x.png"]) {
			const res = await handleImageProxy(await proxyRequest(target), env, noWait, {
				fetcher,
				cache: null,
				secret: SECRET,
				ownDomains: ["tapetide.com"],
			});
			expect(res.status, target).toBe(403);
		}
		expect(seen).toHaveLength(0);
	});

	it("needs both a signature and a URL", async () => {
		const res = await handleImageProxy(new Request("https://mailer.example/img/abc"), env, noWait, { cache: null, secret: SECRET });
		expect(res.status).toBe(400);
	});
});
