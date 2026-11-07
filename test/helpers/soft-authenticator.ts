// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A software WebAuthn authenticator (ES256, "none" attestation) built on
 * `node:crypto`, so tests can drive the real `@simplewebauthn/server`
 * verification with genuine signatures instead of stubbing it.
 *
 * It produces exactly what a browser's `PublicKeyCredential.toJSON()` would:
 * `clientDataJSON`, an `authenticatorData` with the right flags and counter,
 * a CBOR attestation object on registration, and a DER ECDSA signature over
 * `authenticatorData || SHA-256(clientDataJSON)` on assertion.
 */

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const b64url = (buf: Uint8Array) => Buffer.from(buf).toString("base64url");
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();

const FLAG_UP = 1 << 0;
const FLAG_UV = 1 << 2;
const FLAG_BE = 1 << 3;
const FLAG_BS = 1 << 4;
const FLAG_AT = 1 << 6;

export interface SoftAuthenticatorOptions {
	origin: string;
	rpID: string;
	/** Report user verification (default true). */
	userVerified?: boolean;
	/** Starting signature counter; 0 = "does not count" like synced passkeys. */
	counter?: number;
	/** Counter step per assertion (0 keeps it at its starting value). */
	counterStep?: number;
}

export class SoftAuthenticator {
	readonly credentialId = randomBytes(16);
	private readonly privateKey: KeyObject;
	private readonly publicJwk: { x: string; y: string };
	counter: number;
	userHandle: string | null = null;

	constructor(readonly opts: SoftAuthenticatorOptions) {
		const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		this.privateKey = privateKey;
		const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
		this.publicJwk = jwk;
		this.counter = opts.counter ?? 0;
	}

	get id(): string {
		return b64url(this.credentialId);
	}

	private flags(extra: number): number {
		const uv = this.opts.userVerified === false ? 0 : FLAG_UV;
		// Backup eligible and backed up: a synced passkey.
		return FLAG_UP | uv | FLAG_BE | FLAG_BS | extra;
	}

	private clientData(type: string, challenge: string, origin = this.opts.origin): Buffer {
		return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
	}

	/** COSE_Key for the public key (kty EC2, alg ES256, crv P-256). */
	private coseKey(): Uint8Array {
		const key = new Map<number, unknown>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, new Uint8Array(Buffer.from(this.publicJwk.x, "base64url"))],
			[-3, new Uint8Array(Buffer.from(this.publicJwk.y, "base64url"))],
		]);
		return isoCBOR.encode(key as never);
	}

	private counterBytes(): Buffer {
		const buf = Buffer.alloc(4);
		buf.writeUInt32BE(this.counter);
		return buf;
	}

	/** Respond to `navigator.credentials.create()` options. */
	register(options: { challenge: string; user?: { id: string } }, overrides: { origin?: string } = {}) {
		this.userHandle = options.user?.id ?? null;
		const clientDataJSON = this.clientData("webauthn.create", options.challenge, overrides.origin);
		const credIdLen = Buffer.alloc(2);
		credIdLen.writeUInt16BE(this.credentialId.length);
		const authData = Buffer.concat([
			sha256(Buffer.from(this.opts.rpID)),
			Buffer.from([this.flags(FLAG_AT)]),
			this.counterBytes(),
			Buffer.alloc(16), // AAGUID: all zeros, as "none" attestation usually reports
			credIdLen,
			this.credentialId,
			Buffer.from(this.coseKey()),
		]);
		const attestationObject = isoCBOR.encode(
			new Map<string, unknown>([
				["fmt", "none"],
				["attStmt", new Map()],
				["authData", new Uint8Array(authData)],
			]) as never,
		);
		return {
			id: this.id,
			rawId: this.id,
			type: "public-key" as const,
			clientExtensionResults: {},
			authenticatorAttachment: "platform" as const,
			response: {
				clientDataJSON: b64url(clientDataJSON),
				attestationObject: b64url(attestationObject),
				transports: ["internal", "hybrid"],
			},
		};
	}

	/** Respond to `navigator.credentials.get()` options. */
	authenticate(options: { challenge: string }, overrides: { origin?: string; userHandle?: string | null } = {}) {
		this.counter += this.opts.counterStep ?? 0;
		const clientDataJSON = this.clientData("webauthn.get", options.challenge, overrides.origin);
		const authData = Buffer.concat([
			sha256(Buffer.from(this.opts.rpID)),
			Buffer.from([this.flags(0)]),
			this.counterBytes(),
		]);
		const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
		const userHandle = overrides.userHandle === undefined ? this.userHandle : overrides.userHandle;
		return {
			id: this.id,
			rawId: this.id,
			type: "public-key" as const,
			clientExtensionResults: {},
			authenticatorAttachment: "platform" as const,
			response: {
				clientDataJSON: b64url(clientDataJSON),
				authenticatorData: b64url(authData),
				signature: b64url(signature),
				...(userHandle ? { userHandle } : {}),
			},
		};
	}
}
