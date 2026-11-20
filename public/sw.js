/*
 * cloudmail service worker: offline launch, and Web Push notifications.
 *
 * Caches the app shell (the HTML of `/`) and the content-hashed build output
 * under `/assets/`, so an installed app opens its frame without a network.
 * It never intercepts `/api`, `/mcp`, `/oauth`, `/agents`, `/cdn-cgi`,
 * `/.well-known`, React Router `.data` requests or anything but GET: mail and
 * auth always go to the network and nothing a user read is kept here.
 *
 * The routing rules mirror `shared/sw-policy.ts`; `test/sw-policy.test.ts`
 * runs this file against that module so the two cannot drift.
 *
 * Registered only by production builds (see `app/lib/service-worker.ts`).
 */

const VERSION = "v1";
// Caches are versioned by VERSION; adding push handlers does not change what
// is cached, so it stays v1.
const SHELL_CACHE = `tt-shell-${VERSION}`;
const ASSET_CACHE = `tt-assets-${VERSION}`;
const SHELL_URL = "/";

const BYPASS_PREFIXES = ["/api", "/mcp", "/oauth", "/agents", "/cdn-cgi", "/.well-known"];

function underPrefix(path, prefix) {
	return path === prefix || path.startsWith(`${prefix}/`);
}

function strategy(request, origin) {
	if (request.method !== "GET") return "bypass";
	let url;
	try {
		url = new URL(request.url);
	} catch {
		return "bypass";
	}
	if (url.origin !== origin) return "bypass";
	const path = url.pathname;
	if (BYPASS_PREFIXES.some((p) => underPrefix(path, p))) return "bypass";
	if (path.endsWith(".data") || path === "/__manifest") return "bypass";
	if (request.mode === "navigate") return "navigate";
	if (path.startsWith("/assets/")) return "cache-first";
	return "bypass";
}

function isCacheableShell(response) {
	return (
		response.status === 200 &&
		!response.redirected &&
		response.type === "basic" &&
		(response.headers.get("content-type") || "").toLowerCase().startsWith("text/html")
	);
}

self.addEventListener("install", () => {
	// Nothing is precached: the shell is captured from the first successful
	// navigation, which is necessarily a signed-in one (an anonymous load is a
	// redirect, and redirects are never stored).
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
			for (const key of await caches.keys()) {
				if (key.startsWith("tt-") && !keep.has(key)) await caches.delete(key);
			}
			await self.clients.claim();
		})(),
	);
});

// Sign-out asks for the caches to be dropped, so the next person on a shared
// device does not get the previous session's shell.
self.addEventListener("message", (event) => {
	if (event.data && event.data.type === "tt:clear-caches") {
		event.waitUntil(
			(async () => {
				for (const key of await caches.keys()) {
					if (key.startsWith("tt-")) await caches.delete(key);
				}
			})(),
		);
	}
});

async function handleNavigate(request) {
	try {
		const response = await fetch(request);
		if (isCacheableShell(response)) {
			const cache = await caches.open(SHELL_CACHE);
			await cache.put(SHELL_URL, response.clone());
		}
		return response;
	} catch (error) {
		// Offline. Any route boots from the shell: React Router renders the
		// right page client-side from the URL.
		const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
		if (cached) return cached;
		throw error;
	}
}

async function handleAsset(request) {
	const cache = await caches.open(ASSET_CACHE);
	const cached = await cache.match(request);
	if (cached) return cached;
	const response = await fetch(request);
	if (response.ok && response.type === "basic") await cache.put(request, response.clone());
	return response;
}

self.addEventListener("fetch", (event) => {
	const kind = strategy(event.request, self.location.origin);
	if (kind === "navigate") event.respondWith(handleNavigate(event.request));
	else if (kind === "cache-first") event.respondWith(handleAsset(event.request));
	// "bypass": no respondWith, so the browser handles it exactly as it would
	// without a worker.
});

// ── Web Push ─────────────────────────────────────────────────────────
//
// The payload is decrypted by the browser; this only shows it. Its shape is
// `PushPayload` in `shared/push-policy.ts`, and the click target is checked
// by the same rule as `safeNotificationUrl` there (same origin, a path), so
// a payload can never send the user off-site. `test/sw-policy.test.ts` runs
// these handlers against stub worker globals.

function safeNotificationUrl(raw, origin) {
	if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return "/";
	try {
		const url = new URL(raw, origin);
		return url.origin === origin ? url.pathname + url.search + url.hash : "/";
	} catch {
		return "/";
	}
}

function notificationFor(payload) {
	const data = payload && typeof payload === "object" ? payload : {};
	const actions = Array.isArray(data.actions)
		? data.actions
				.filter((a) => a && (a.action === "archive" || a.action === "read") && typeof a.token === "string")
				.slice(0, 2)
		: [];
	return {
		title: typeof data.title === "string" && data.title ? data.title : "cloudmail",
		options: {
			body: typeof data.body === "string" ? data.body : "",
			tag: typeof data.tag === "string" ? data.tag : undefined,
			// A newer message in the same thread replaces the notification; let it ring again.
			renotify: typeof data.tag === "string",
			icon: "/icon-192.png",
			badge: "/icon-192.png",
			data: {
				url: safeNotificationUrl(data.url, self.location.origin),
				tokens: Object.fromEntries(actions.map((a) => [a.action, a.token])),
			},
			actions: actions.map((a) => ({ action: a.action, title: a.action === "archive" ? "Archive" : "Mark read" })),
		},
	};
}

self.addEventListener("push", (event) => {
	let payload = null;
	try {
		payload = event.data ? event.data.json() : null;
	} catch {
		payload = null;
	}
	const { title, options } = notificationFor(payload);
	event.waitUntil(self.registration.showNotification(title, options));
});

async function openOrFocus(url) {
	const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	for (const client of windows) {
		if (new URL(client.url).origin !== self.location.origin || !("focus" in client)) continue;
		try {
			await client.focus();
			// `navigate` rejects for a window this worker does not control
			// (opened before it activated); a new window still gets there.
			if ("navigate" in client) await client.navigate(url);
			return client;
		} catch {
			break;
		}
	}
	return self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
	const notification = event.notification;
	const data = notification.data || {};
	notification.close();
	const token = event.action && data.tokens ? data.tokens[event.action] : null;
	if (token) {
		// A button: post its single-use token. No cookie is needed or sent
		// in some browsers, which is why the token is the credential.
		event.waitUntil(
			fetch("/push/action", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
				credentials: "omit",
			}).then(
				(res) => (res.ok ? undefined : openOrFocus(data.url || "/")),
				() => openOrFocus(data.url || "/"),
			),
		);
		return;
	}
	event.waitUntil(openOrFocus(data.url || "/"));
});

// The push service rotated this device's subscription. Re-register it,
// proving it is the same device with the old subscription's auth secret.
self.addEventListener("pushsubscriptionchange", (event) => {
	event.waitUntil(
		(async () => {
			const old = event.oldSubscription ? event.oldSubscription.toJSON() : null;
			let next = event.newSubscription;
			if (!next && old) {
				const res = await fetch("/api/v1/push/vapid-key", { credentials: "same-origin" }).catch(() => null);
				const key = res && res.ok ? (await res.json()).public_key : null;
				const appKey = key || (event.oldSubscription.options && event.oldSubscription.options.applicationServerKey);
				if (!appKey) return;
				next = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
			}
			if (!next || !old || !old.keys) return;
			await fetch("/push/resubscribe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ old_endpoint: old.endpoint, old_auth: old.keys.auth, subscription: next.toJSON() }),
				credentials: "omit",
			});
		})().catch(() => {}),
	);
});

// Exposed for the policy test, which evaluates this file outside a worker.
if (typeof globalThis.__TT_SW_TEST__ === "object") {
	globalThis.__TT_SW_TEST__.strategy = strategy;
	globalThis.__TT_SW_TEST__.isCacheableShell = isCacheableShell;
	globalThis.__TT_SW_TEST__.safeNotificationUrl = safeNotificationUrl;
	globalThis.__TT_SW_TEST__.notificationFor = notificationFor;
}
