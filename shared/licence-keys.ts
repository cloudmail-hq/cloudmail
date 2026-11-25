/**
 * The licence server's PUBLIC signing keys, bundled so tokens verify offline.
 * Keyed by `kid`, so a key can rotate: ship a release with both keys, then
 * drop the old one 37 days after the server switched (README "Licence").
 *
 * Never fetched at runtime: whoever controls the network path could serve
 * their own key.
 *
 * Rotating: generate a key with `node scripts/gen-signing-key.mjs --kid <kid>`
 * in tapetide-licence-server, add its public JWK here next to the current
 * one, and set PRODUCTION_KEY_ID once the server signs with it (README
 * "Licence"). `LICENCE_ENV=production npm test` fails while the development
 * key is the only bundled key (test/licence-gate.test.ts).
 */

import type { Ed25519PublicJwk, Jwks } from "./licence-token";

/**
 * Development key, generated with the licence server's
 * `scripts/gen-signing-key.mjs --kid dev-2026-1`. The private half lives only
 * on the developer's machine, outside any repository. Tokens it signs are for
 * local testing; never accept it in production.
 */
export const DEV_KEY_ID = "dev-2026-1";

/**
 * The production signing key, as published at
 * https://licence.tapetide.com/v1/keys (checked 2026-10-30).
 */
export const PRODUCTION_KEY_ID = "2026-10";

export const LICENCE_KEYS: Record<string, Ed25519PublicJwk> = {
	[PRODUCTION_KEY_ID]: {
		kty: "OKP",
		crv: "Ed25519",
		x: "x5OBKJi2mygfWPHZDvYOp6vrf1_aGDXHWFstuFBDE50",
		kid: PRODUCTION_KEY_ID,
		alg: "EdDSA",
		use: "sig",
	},
	[DEV_KEY_ID]: {
		kty: "OKP",
		crv: "Ed25519",
		x: "MGOvcaOW6uob74TBH8-enHoTwNMv9gidtAjqFXXASk0",
		kid: DEV_KEY_ID,
		alg: "EdDSA",
		use: "sig",
	},
};

/**
 * The keys a build accepts. A production build (`vite build`, where
 * `import.meta.env.DEV` is statically false) never accepts the development
 * key, so a token signed with it fails as `unknown_kid` in every deployed
 * Worker. Only the local dev server accepts it.
 */
export function verificationJwks(isDev: boolean, keys: Record<string, Ed25519PublicJwk> = LICENCE_KEYS): Jwks {
	return { keys: Object.values(keys).filter((k) => isDev || k.kid !== DEV_KEY_ID) };
}

/** The bundled keys as a JWKS, for `verifyLicenceToken`. */
export const LICENCE_JWKS: Jwks = verificationJwks(import.meta.env?.DEV === true);

/** True while the only bundled key is the development one. */
export function onlyDevKey(keys: Record<string, Ed25519PublicJwk> = LICENCE_KEYS): boolean {
	const ids = Object.keys(keys);
	return ids.length === 0 || ids.every((id) => id === DEV_KEY_ID);
}
