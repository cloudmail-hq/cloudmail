// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The slice of `node:crypto` that `crypto.ts` uses.
 *
 * workerd implements it under `nodejs_compat`, but the Worker tsconfig loads
 * only `@cloudflare/workers-types`; pulling in all of `@types/node` there would
 * put Node globals (Buffer, process, timers) in scope for code that must not
 * rely on them. Declaring just these two functions keeps the surface explicit.
 */
declare module "node:crypto" {
	export function scrypt(
		password: string | ArrayBufferView,
		salt: string | ArrayBufferView,
		keylen: number,
		options: { N?: number; r?: number; p?: number; maxmem?: number },
		callback: (err: Error | null, derivedKey: ArrayBufferView & ArrayLike<number>) => void,
	): void;
	export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
}
