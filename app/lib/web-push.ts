// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The browser side of Web Push: can this device do it, and the subscribe and
 * unsubscribe flows. The server side is `workers/routes/push.ts`.
 *
 * The service worker is registered by production builds only
 * (`registerServiceWorker` in root.tsx). Subscribing registers it here too
 * if it is missing, so notifications work as soon as someone opts in.
 */

import { request } from "~/services/api";

export type PushSupport =
	/** Ready: permission can be asked for. */
	| "supported"
	/** iPhone or iPad in a browser tab: Web Push needs the app on the Home Screen. */
	| "ios-needs-install"
	/** iOS older than 16.4, which has no Web Push at all. */
	| "ios-too-old"
	/** Not over https (or localhost). */
	| "insecure"
	| "unsupported";

export interface PushEnvironment {
	userAgent: string;
	/** `navigator.maxTouchPoints`: iPadOS reports itself as a Mac. */
	maxTouchPoints: number;
	standalone: boolean;
	secure: boolean;
	hasServiceWorker: boolean;
	hasPushManager: boolean;
	hasNotification: boolean;
}

function iosVersion(ua: string): number | null {
	const m = /OS (\d+)[_.](\d+)/.exec(ua);
	return m ? Number(m[1]) + Number(m[2]) / 100 : null;
}

export function isIos(env: Pick<PushEnvironment, "userAgent" | "maxTouchPoints">): boolean {
	if (/iPhone|iPad|iPod/.test(env.userAgent)) return true;
	// iPadOS 13+ in desktop mode: a "Macintosh" with a touch screen.
	return /Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1;
}

/** What this device can do. Pure, so the guidance logic is testable. */
export function pushSupport(env: PushEnvironment): PushSupport {
	if (!env.secure) return "insecure";
	if (isIos(env)) {
		const version = iosVersion(env.userAgent);
		if (version !== null && version < 16.04) return "ios-too-old";
		// Safari on iOS exposes the APIs only to a Home Screen app.
		if (!env.standalone) return "ios-needs-install";
	}
	if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) {
		return isIos(env) && !env.standalone ? "ios-needs-install" : "unsupported";
	}
	return "supported";
}

export function currentPushEnvironment(): PushEnvironment | null {
	if (typeof window === "undefined") return null;
	const nav = navigator as Navigator & { standalone?: boolean };
	return {
		userAgent: nav.userAgent,
		maxTouchPoints: nav.maxTouchPoints ?? 0,
		standalone: window.matchMedia?.("(display-mode: standalone)").matches === true || nav.standalone === true,
		secure: window.isSecureContext,
		hasServiceWorker: "serviceWorker" in nav,
		hasPushManager: "PushManager" in window,
		hasNotification: "Notification" in window,
	};
}

/** base64url VAPID key to the bytes `applicationServerKey` wants. */
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
	const binary = atob(padded);
	const out = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
	if (!a) return false;
	const x = new Uint8Array(a);
	return x.length === b.length && x.every((v, i) => v === b[i]);
}

async function registration(): Promise<ServiceWorkerRegistration> {
	const existing = await navigator.serviceWorker.getRegistration("/");
	if (existing) return existing;
	await navigator.serviceWorker.register("/sw.js", { scope: "/" });
	return navigator.serviceWorker.ready;
}

/** This browser's current subscription, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
	try {
		const reg = await navigator.serviceWorker.getRegistration("/");
		return (await reg?.pushManager.getSubscription()) ?? null;
	} catch {
		return null;
	}
}

export type EnableResult = { ok: true; endpoint: string } | { ok: false; reason: "denied" | "dismissed" | "failed"; message?: string };

/**
 * Ask for permission (from the click that called this: browsers refuse a
 * prompt without a user gesture), subscribe with the server's VAPID key and
 * register the device. A subscription made under an old key is replaced.
 */
export async function enablePush(): Promise<EnableResult> {
	try {
		const permission = await Notification.requestPermission();
		if (permission === "denied") return { ok: false, reason: "denied" };
		if (permission !== "granted") return { ok: false, reason: "dismissed" };
		const { public_key } = await request<{ public_key: string }>("/api/v1/push/vapid-key");
		const key = urlBase64ToUint8Array(public_key);
		const reg = await registration();
		let sub = await reg.pushManager.getSubscription();
		if (sub && !sameKey(sub.options.applicationServerKey, key)) {
			await sub.unsubscribe().catch(() => false);
			sub = null;
		}
		sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
		await request("/api/v1/push/subscriptions", { method: "POST", body: JSON.stringify(sub.toJSON()) });
		return { ok: true, endpoint: sub.endpoint };
	} catch (e) {
		return { ok: false, reason: "failed", message: (e as Error).message };
	}
}

/** Stop this browser: unsubscribe locally and forget the device on the server. */
export async function disablePushHere(): Promise<void> {
	const sub = await currentSubscription();
	if (!sub) return;
	await request("/api/v1/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
	await sub.unsubscribe().catch(() => false);
}
