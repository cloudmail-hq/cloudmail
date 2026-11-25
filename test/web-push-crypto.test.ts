/**
 * Web Push encryption against RFC 8291 Appendix A, and VAPID (RFC 8292).
 *
 * Every intermediate value the RFC lists is checked, not only the final body,
 * so a regression points at the step that broke.
 */

import { describe, expect, it } from "vitest";
import {
	MAX_PUSH_PLAINTEXT,
	b64urlDecode,
	b64urlEncode,
	encryptPushPayload,
	generateP256KeyPair,
	isP256PrivateKey,
	isP256PublicKey,
	signVapidJwt,
	vapidAudience,
	vapidAuthorization,
	verifyVapidJwt,
} from "../shared/web-push";

// RFC 8291 section 5 and Appendix A. Whitespace in the RFC's wrapped values is
// removed by `b64urlDecode`.
const V = {
	plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
	asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
	ecdh: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
	ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
	prk: "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc",
	cek: "oIhVW04MRdy2XN9CiKLxTg",
	nonce: "4h_95klXJ5E_qnoN",
	body:
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
		"mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
		"pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function rfcVector() {
	return encryptPushPayload({
		plaintext: b64urlDecode(V.plaintext),
		uaPublic: V.uaPublic,
		authSecret: V.auth,
		salt: b64urlDecode(V.salt),
		senderKeys: { publicKey: V.asPublic, privateKey: V.asPrivate },
	});
}

describe("RFC 8291 encryption", () => {
	it("derives every intermediate value in Appendix A", async () => {
		const { debug } = await rfcVector();
		expect(b64urlEncode(debug.ecdhSecret)).toBe(V.ecdh);
		expect(b64urlEncode(debug.ikm)).toBe(V.ikm);
		expect(b64urlEncode(debug.prk)).toBe(V.prk);
		expect(b64urlEncode(debug.cek)).toBe(V.cek);
		expect(b64urlEncode(debug.nonce)).toBe(V.nonce);
	});

	it("produces the exact body of section 5", async () => {
		const { body } = await rfcVector();
		// The RFC's example says Content-Length: 145, but its own body decodes to
		// 144 bytes (86 header + 41 plaintext + 1 delimiter + 16 tag).
		expect(body.length).toBe(b64urlDecode(V.body).length);
		expect(body.length).toBe(144);
		expect(b64urlEncode(body)).toBe(V.body);
	});

	it("writes the 86-byte header: salt, rs 4096, keyid length and key", async () => {
		const { body } = await rfcVector();
		expect(b64urlEncode(body.slice(0, 16))).toBe(V.salt);
		expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
		expect(body[20]).toBe(65);
		expect(b64urlEncode(body.slice(21, 86))).toBe(V.asPublic);
	});

	it("decrypts with the receiver's key (round trip with random keys)", async () => {
		// Receiver side, as a browser would do it.
		const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
		const uaRaw = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
		const auth = crypto.getRandomValues(new Uint8Array(16));
		const message = new TextEncoder().encode(JSON.stringify({ title: "Ada", body: "Lunch?" }));
		const { body, debug } = await encryptPushPayload({
			plaintext: message,
			uaPublic: b64urlEncode(uaRaw),
			authSecret: b64urlEncode(auth),
		});
		const key = await crypto.subtle.importKey("raw", debug.cek as BufferSource, "AES-GCM", false, ["decrypt"]);
		const record = new Uint8Array(
			await crypto.subtle.decrypt({ name: "AES-GCM", iv: debug.nonce as BufferSource }, key, body.slice(86)),
		);
		expect(record[record.length - 1]).toBe(0x02);
		expect(new TextDecoder().decode(record.slice(0, -1))).toBe(JSON.stringify({ title: "Ada", body: "Lunch?" }));
		// A fresh salt and sender key every time.
		const again = await encryptPushPayload({ plaintext: message, uaPublic: b64urlEncode(uaRaw), authSecret: b64urlEncode(auth) });
		expect(b64urlEncode(again.body.slice(0, 16))).not.toBe(b64urlEncode(body.slice(0, 16)));
	});

	it("refuses a payload that does not fit one record", async () => {
		await expect(
			encryptPushPayload({
				plaintext: new Uint8Array(MAX_PUSH_PLAINTEXT + 1),
				uaPublic: V.uaPublic,
				authSecret: V.auth,
			}),
		).rejects.toThrow(/too large/);
	});
});

describe("VAPID (RFC 8292)", () => {
	it("generates keys in the applicationServerKey format", async () => {
		const keys = await generateP256KeyPair();
		expect(isP256PublicKey(keys.publicKey)).toBe(true);
		expect(isP256PrivateKey(keys.privateKey)).toBe(true);
		expect(isP256PublicKey("not-a-key")).toBe(false);
		expect(isP256PrivateKey(keys.publicKey)).toBe(false);
	});

	it("signs an ES256 JWT with the right header and claims", async () => {
		const keys = await generateP256KeyPair();
		const claims = { aud: "https://push.example.net", exp: 1453523768, sub: "mailto:push@example.com" };
		const jwt = await signVapidJwt(claims, keys);
		const [header, payload, sig] = jwt.split(".");
		expect(JSON.parse(new TextDecoder().decode(b64urlDecode(header!)))).toEqual({ typ: "JWT", alg: "ES256" });
		expect(JSON.parse(new TextDecoder().decode(b64urlDecode(payload!)))).toEqual(claims);
		// P1363 r||s, not DER.
		expect(b64urlDecode(sig!).length).toBe(64);
		expect(await verifyVapidJwt(jwt, keys.publicKey)).toEqual(claims);
	});

	it("does not verify under another key, or when tampered with", async () => {
		const keys = await generateP256KeyPair();
		const other = await generateP256KeyPair();
		const jwt = await signVapidJwt({ aud: "https://a.example", exp: 1, sub: "mailto:x@y.z" }, keys);
		expect(await verifyVapidJwt(jwt, other.publicKey)).toBeNull();
		const [h, , s] = jwt.split(".");
		const forged = `${h}.${b64urlEncode(new TextEncoder().encode(JSON.stringify({ aud: "https://b.example", exp: 1, sub: "x" })))}.${s}`;
		expect(await verifyVapidJwt(forged, keys.publicKey)).toBeNull();
	});

	it("verifies the RFC 8292 example token with its key", async () => {
		const token =
			"eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA";
		const key = "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs";
		expect(await verifyVapidJwt(token, key)).toEqual({
			aud: "https://push.example.net",
			exp: 1453523768,
			sub: "mailto:push@example.com",
		});
	});

	it("builds the Authorization header for the endpoint's origin, capped at 24h", async () => {
		const keys = await generateP256KeyPair();
		const endpoint = "https://fcm.googleapis.com/fcm/send/abc:def";
		expect(vapidAudience(endpoint)).toBe("https://fcm.googleapis.com");
		const header = await vapidAuthorization(endpoint, keys, "mailto:ops@example.com", 1_000, 48 * 3600);
		const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
		expect(m?.[2]).toBe(keys.publicKey);
		const claims = await verifyVapidJwt(m![1]!, keys.publicKey);
		expect(claims).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_000 + 24 * 3600, sub: "mailto:ops@example.com" });
	});
});
