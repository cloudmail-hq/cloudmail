import { describe, expect, it } from "vitest";
import {
	DEFAULT_SENDER_PICTURES,
	dmarcEnforces,
	isFreeMailDomain,
	isSafeSvgLogo,
	normalizeAddress,
	normalizeSenderPictures,
	parseBimiRecord,
	parseSenderPictureMask,
	senderPictureMask,
	senderPictureUrl,
} from "../shared/sender-pictures";
import { mergePrivacySettings, normalizePrivacySettings, buildPrivacyNotice } from "../shared/privacy";
import { senderAuthFlag } from "../workers/durableObject/derived";
import {
	handleSenderPicture,
	resolveSenderPicture,
	type PictureDeps,
} from "../workers/lib/sender-pictures";

const ALL = { brandLogos: true, websiteIcons: true, gravatar: true, generated: true };
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** A fake network: BIMI + DMARC answers by name, HTTP answers by URL prefix. */
function world(options: {
	txt?: Record<string, string[]>;
	http?: Record<string, { status?: number; type: string; body: string | Uint8Array }>;
}) {
	const calls: string[] = [];
	const deps: PictureDeps = {
		txt: async (name) => {
			calls.push(`dns:${name}`);
			return options.txt?.[name] ?? [];
		},
		fetcher: async (request) => {
			calls.push(request.url);
			const hit = Object.entries(options.http ?? {}).find(([prefix]) => request.url.startsWith(prefix));
			if (!hit) return new Response("no", { status: 404, headers: { "content-type": "image/png" } });
			const [, r] = hit;
			return new Response(r.body as BodyInit, { status: r.status ?? 200, headers: { "content-type": r.type } });
		},
	};
	return { deps, calls };
}

const BRAND = {
	txt: {
		"default._bimi.acme.com": ["v=BIMI1; l=https://cdn.acme.com/logo.svg; a=https://cdn.acme.com/vmc.pem"],
		"_dmarc.acme.com": ["v=DMARC1; p=reject; rua=mailto:d@acme.com"],
	},
	http: {
		"https://cdn.acme.com/logo.svg": { type: "image/svg+xml", body: LOGO },
		"https://www.google.com/s2/favicons": { type: "image/png", body: PNG },
		"https://gravatar.com/avatar/": { type: "image/jpeg", body: PNG },
	},
};

describe("settings", () => {
	it("is all on by default and survives junk", () => {
		expect(normalizeSenderPictures(null)).toEqual(DEFAULT_SENDER_PICTURES);
		expect(normalizeSenderPictures({ enabled: "no", gravatar: false })).toEqual({
			...DEFAULT_SENDER_PICTURES,
			gravatar: false,
		});
		expect(normalizePrivacySettings({}).senderPictures.enabled).toBe(true);
	});

	it("merges a partial patch without resetting the other switches", () => {
		const base = normalizePrivacySettings({ senderPictures: { gravatar: false } });
		const next = mergePrivacySettings(base, { senderPictures: { websiteIcons: false } }, 1);
		expect(next.senderPictures).toEqual({ ...DEFAULT_SENDER_PICTURES, gravatar: false, websiteIcons: false });
	});

	it("round-trips the mask", () => {
		const s = { ...DEFAULT_SENDER_PICTURES, websiteIcons: false };
		expect(senderPictureMask(s)).toBe("1011");
		expect(parseSenderPictureMask("1011")).toEqual({ brandLogos: true, websiteIcons: false, gravatar: true, generated: true });
		expect(parseSenderPictureMask("10")).toBeNull();
		expect(parseSenderPictureMask("10x1")).toBeNull();
	});

	it("lists only the switched-on lookups in the privacy notice", () => {
		const find = (s: ReturnType<typeof normalizePrivacySettings>) =>
			buildPrivacyNotice(s, { appName: "x" }).find((x) => x.heading === "Sender pictures");
		expect(find(normalizePrivacySettings({}))?.bullets).toHaveLength(4);
		const some = find(normalizePrivacySettings({ senderPictures: { websiteIcons: false, gravatar: false } }));
		expect(some?.bullets?.join(" ")).not.toMatch(/Google|Gravatar/);
		expect(find(normalizePrivacySettings({ senderPictures: { enabled: false } }))).toBeUndefined();
	});
});

describe("senderPictureUrl", () => {
	it("is null when off, for a bad address, or when nothing could apply", () => {
		expect(senderPictureUrl("a@b.com", true, { ...DEFAULT_SENDER_PICTURES, enabled: false })).toBeNull();
		expect(senderPictureUrl("not an address", true, DEFAULT_SENDER_PICTURES)).toBeNull();
		expect(senderPictureUrl("a@b.com", false, { ...DEFAULT_SENDER_PICTURES, generated: false })).toBeNull();
	});

	it("carries the verdict and the mask", () => {
		expect(senderPictureUrl("Maya@Acme.com ", true, DEFAULT_SENDER_PICTURES)).toBe(
			"/api/v1/sender-picture?a=maya%40acme.com&m=1111&v=1",
		);
		expect(senderPictureUrl("maya@acme.com", false, DEFAULT_SENDER_PICTURES)).toBe(
			"/api/v1/sender-picture?a=maya%40acme.com&m=1111",
		);
	});

	it("normalises addresses", () => {
		expect(normalizeAddress("a@b")).toBe("");
		expect(normalizeAddress("a b@c.com")).toBe("");
		expect(normalizeAddress("@c.com")).toBe("");
		expect(normalizeAddress("A@Sub.C.com")).toBe("a@sub.c.com");
	});
});

describe("DNS records", () => {
	it("reads a BIMI record", () => {
		expect(parseBimiRecord("v=BIMI1; l=https://a.com/l.svg; a=https://a.com/c.pem;")).toEqual({
			logoUrl: "https://a.com/l.svg",
			certificateUrl: "https://a.com/c.pem",
		});
		expect(parseBimiRecord("v=BIMI1; l=https://a.com/l.svg")?.certificateUrl).toBeNull();
	});

	it("refuses opt-outs, http and other records", () => {
		expect(parseBimiRecord("v=BIMI1; l=; a=")).toBeNull();
		expect(parseBimiRecord("v=BIMI1; l=http://a.com/l.svg")).toBeNull();
		expect(parseBimiRecord("v=spf1 -all")).toBeNull();
	});

	it("wants an enforcing DMARC policy on all mail", () => {
		expect(dmarcEnforces("v=DMARC1; p=reject")).toBe(true);
		expect(dmarcEnforces("v=DMARC1; p=quarantine; pct=100")).toBe(true);
		expect(dmarcEnforces("v=DMARC1; p=quarantine; pct=20")).toBe(false);
		expect(dmarcEnforces("v=DMARC1; p=none")).toBe(false);
		expect(dmarcEnforces("p=reject")).toBe(false);
	});

	it("knows personal mail providers", () => {
		expect(isFreeMailDomain("Gmail.com")).toBe(true);
		expect(isFreeMailDomain("acme.com")).toBe(false);
	});
});

describe("isSafeSvgLogo", () => {
	it("accepts a plain logo", () => expect(isSafeSvgLogo(LOGO)).toBe(true));
	it.each([
		`<svg><script>alert(1)</script></svg>`,
		`<svg onload="x()"></svg>`,
		`<svg><foreignObject><p>hi</p></foreignObject></svg>`,
		`<svg><a href="javascript:x()">y</a></svg>`,
		`<svg><image href="https://evil.example/t.png"/></svg>`,
		`<!DOCTYPE svg [<!ENTITY x "y">]><svg/>`,
		`<html></html>`,
	])("refuses %s", (svg) => expect(isSafeSvgLogo(svg)).toBe(false));
});

describe("resolveSenderPicture", () => {
	it("prefers the certified brand logo", async () => {
		const { deps } = world(BRAND);
		const p = await resolveSenderPicture("news@acme.com", true, ALL, deps);
		expect(p?.source).toBe("bimi-certified");
		expect(p?.contentType).toBe("image/svg+xml");
	});

	it("labels a logo without a certificate", async () => {
		const { deps } = world({
			...BRAND,
			txt: { ...BRAND.txt, "default._bimi.acme.com": ["v=BIMI1; l=https://cdn.acme.com/logo.svg"] },
		});
		expect((await resolveSenderPicture("news@acme.com", true, ALL, deps))?.source).toBe("bimi");
	});

	it("finds the organisation's record for a subdomain", async () => {
		const { deps } = world(BRAND);
		expect((await resolveSenderPicture("x@mail.acme.com", true, ALL, deps))?.source).toBe("bimi-certified");
	});

	it("skips the logo when DMARC does not enforce, and uses the website icon", async () => {
		const { deps } = world({ ...BRAND, txt: { ...BRAND.txt, "_dmarc.acme.com": ["v=DMARC1; p=none"] } });
		expect((await resolveSenderPicture("news@acme.com", true, ALL, deps))?.source).toBe("favicon");
	});

	it("skips an unsafe logo", async () => {
		const { deps } = world({
			...BRAND,
			http: { ...BRAND.http, "https://cdn.acme.com/logo.svg": { type: "image/svg+xml", body: `<svg><script/></svg>` } },
		});
		expect((await resolveSenderPicture("news@acme.com", true, ALL, deps))?.source).toBe("favicon");
	});

	it("falls to Gravatar, then a generated face, on a company domain", async () => {
		const noIcon = { "https://gravatar.com/avatar/": BRAND.http["https://gravatar.com/avatar/"] };
		expect((await resolveSenderPicture("maya@small.studio", true, ALL, world({ http: noIcon }).deps))?.source).toBe("gravatar");
		const face = await resolveSenderPicture("maya@small.studio", true, ALL, world({}).deps);
		expect(face?.source).toBe("generated");
		expect(new TextDecoder().decode(face!.body)).toMatch(/^<svg/);
	});

	it("never asks for a logo or icon for personal mail providers", async () => {
		const { deps, calls } = world(BRAND);
		const p = await resolveSenderPicture("someone@gmail.com", true, ALL, deps);
		expect(p?.source).toBe("gravatar");
		expect(calls.some((c) => c.startsWith("dns:") || c.includes("favicons"))).toBe(false);
	});

	it("sends Gravatar a hash, not the address", async () => {
		const { deps, calls } = world(BRAND);
		await resolveSenderPicture("someone@gmail.com", true, ALL, deps);
		const call = calls.find((c) => c.includes("gravatar.com"))!;
		expect(call).toMatch(/\/avatar\/[0-9a-f]{64}\?/);
		expect(call).not.toContain("someone");
	});

	it("makes no lookups at all for an unverified message", async () => {
		const { deps, calls } = world(BRAND);
		const p = await resolveSenderPicture("news@acme.com", false, ALL, deps);
		expect(p?.source).toBe("generated");
		expect(calls).toEqual([]);
	});

	it("honours each switch", async () => {
		const pick = async (off: Partial<typeof ALL>) =>
			(await resolveSenderPicture("news@acme.com", true, { ...ALL, ...off }, world(BRAND).deps))?.source ?? null;
		expect(await pick({ brandLogos: false })).toBe("favicon");
		expect(await pick({ brandLogos: false, websiteIcons: false })).toBe("gravatar");
		expect(await pick({ brandLogos: false, websiteIcons: false, gravatar: false })).toBe("generated");
		expect(await pick({ brandLogos: false, websiteIcons: false, gravatar: false, generated: false })).toBeNull();
	});

	it("draws the same face for the same address and does not embed it", async () => {
		const a = await resolveSenderPicture("maya@small.studio", false, ALL, world({}).deps);
		const b = await resolveSenderPicture("maya@small.studio", false, ALL, world({}).deps);
		const c = await resolveSenderPicture("ben@small.studio", false, ALL, world({}).deps);
		const text = (p: typeof a) => new TextDecoder().decode(p!.body);
		expect(text(a)).toBe(text(b));
		expect(text(a)).not.toBe(text(c));
		expect(text(a)).not.toContain("maya");
	});
});

describe("handleSenderPicture", () => {
	function memoryCache() {
		const store = new Map<string, Response>();
		return {
			store,
			match: async (key: Request) => store.get(key.url)?.clone(),
			put: async (key: Request, value: Response) => void store.set(key.url, value),
		};
	}
	const get = (query: string, deps: Parameters<typeof handleSenderPicture>[2]) => {
		const pending: Promise<unknown>[] = [];
		return handleSenderPicture(new Request(`https://mail.example/api/v1/sender-picture?${query}`), (p) => pending.push(p), deps).then(
			async (res) => {
				await Promise.all(pending);
				return res;
			},
		);
	};

	it("serves a picture with locked-down headers", async () => {
		const res = await get("a=news@acme.com&m=1111&v=1", { ...world(BRAND).deps, cache: null });
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
		expect(res.headers.get("X-Sender-Picture")).toBe("bimi-certified");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
		expect(res.headers.get("Cache-Control")).toMatch(/^private, max-age=\d+$/);
	});

	it("rejects a bad address or mask before any lookup", async () => {
		const { deps, calls } = world(BRAND);
		expect((await get("a=nope&m=1111&v=1", { ...deps, cache: null })).status).toBe(400);
		expect((await get("a=news@acme.com&m=zz&v=1", { ...deps, cache: null })).status).toBe(400);
		expect(calls).toEqual([]);
	});

	it("answers the second request from the cache", async () => {
		const cache = memoryCache();
		const first = world(BRAND);
		await get("a=news@acme.com&m=1111&v=1", { ...first.deps, cache });
		const second = world(BRAND);
		const res = await get("a=news@acme.com&m=1111&v=1", { ...second.deps, cache });
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Sender-Picture")).toBe("bimi-certified");
		expect(second.calls).toEqual([]);
	});

	it("keeps verified and unverified answers apart, and never the address in the key", async () => {
		const cache = memoryCache();
		await get("a=news@acme.com&m=1111", { ...world(BRAND).deps, cache });
		const res = await get("a=news@acme.com&m=1111&v=1", { ...world(BRAND).deps, cache });
		expect(res.headers.get("X-Sender-Picture")).toBe("bimi-certified");
		expect([...cache.store.keys()].join(" ")).not.toContain("acme");
	});

	it("keeps a fallback only briefly when a better lookup failed rather than answered", async () => {
		const cache = memoryCache();
		const flaky = world(BRAND);
		const fetcher = flaky.deps.fetcher!;
		// The logo host is down; the website icon still answers.
		flaky.deps.fetcher = async (request) => {
			if (request.url.startsWith("https://cdn.acme.com/")) throw new Error("connection reset");
			return fetcher(request);
		};
		const res = await get("a=news@acme.com&m=1111&v=1", { ...flaky.deps, cache });
		expect(res.headers.get("X-Sender-Picture")).toBe("favicon");
		expect(res.headers.get("Cache-Control")).toBe("private, max-age=600");
		expect([...cache.store.values()][0]!.headers.get("Cache-Control")).toBe("public, max-age=600");

		// A logo that is simply not there is a real answer, kept for the week.
		const settled = memoryCache();
		const gone = world({ ...BRAND, http: { ...BRAND.http, "https://cdn.acme.com/logo.svg": { status: 404, type: "image/svg+xml", body: "" } } });
		const kept = await get("a=news@acme.com&m=1111&v=1", { ...gone.deps, cache: settled });
		expect(kept.headers.get("X-Sender-Picture")).toBe("favicon");
		expect([...settled.store.values()][0]!.headers.get("Cache-Control")).toBe("public, max-age=604800");
	});

	it("retries soon after a DNS failure", async () => {
		const cache = memoryCache();
		const { deps } = world(BRAND);
		deps.txt = async () => {
			throw new Error("DoH 503");
		};
		const res = await get("a=news@acme.com&m=1001&v=1", { ...deps, cache });
		expect(res.headers.get("X-Sender-Picture")).toBe("generated");
		expect([...cache.store.values()][0]!.headers.get("Cache-Control")).toBe("public, max-age=600");
	});

	it("remembers that there is nothing, as a 404", async () => {
		const cache = memoryCache();
		expect((await get("a=news@acme.com&m=0000&v=1", { ...world(BRAND).deps, cache })).status).toBe(404);
		const again = world(BRAND);
		expect((await get("a=news@acme.com&m=0000&v=1", { ...again.deps, cache })).status).toBe(404);
		expect(again.calls).toEqual([]);
	});
});

describe("senderAuthFlag", () => {
	const headers = (value: string) => JSON.stringify([{ key: "authentication-results", value }]);
	it("is 1 only for a trusted pass", () => {
		expect(senderAuthFlag(headers("mx.cloudflare.net; dmarc=pass header.from=acme.com"), "a@acme.com")).toBe(1);
		expect(senderAuthFlag(headers("mx.cloudflare.net; dmarc=fail header.from=acme.com"), "a@acme.com")).toBe(0);
		expect(senderAuthFlag(headers("evil.example; dmarc=pass header.from=acme.com"), "a@acme.com")).toBe(0);
		expect(senderAuthFlag(null, "a@acme.com")).toBe(0);
		expect(senderAuthFlag("not json", "a@acme.com")).toBe(0);
	});
});
