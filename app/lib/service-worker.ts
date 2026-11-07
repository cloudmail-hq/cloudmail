/**
 * Service worker registration. See `public/sw.js` for what it caches (the app
 * shell and hashed assets, never `/api`).
 *
 * Called from `root.tsx` in production builds only.
 */

export function registerServiceWorker(): void {
	if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
	// After load, so registering never competes with the first paint.
	const register = () => {
		navigator.serviceWorker
			.register("/sw.js", { scope: "/" })
			.catch((error) => console.warn("Service worker registration failed:", error));
	};
	if (document.readyState === "complete") register();
	else window.addEventListener("load", register, { once: true });
}

/**
 * Drop the worker's caches. Called on sign-out so a shared device does not
 * keep the previous session's shell. Best effort: a missing worker or a
 * browser without the Cache API is not an error.
 */
export async function clearServiceWorkerCaches(): Promise<void> {
	if (typeof window === "undefined") return;
	try {
		navigator.serviceWorker?.controller?.postMessage({ type: "tt:clear-caches" });
		if ("caches" in window) {
			for (const key of await caches.keys()) {
				if (key.startsWith("tt-")) await caches.delete(key);
			}
		}
	} catch {
		// Nothing to clear.
	}
}
