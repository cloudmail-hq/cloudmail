/**
 * Code-split entry points for the heavy, opt-in surfaces.
 *
 * The composer and the signature editor carry TipTap and ProseMirror (about
 * 115 KB Brotli), and the agent panel carries the agents SDK and its chat UI
 * (about 45 KB). None of them is on screen when a mail, People or settings page
 * first renders, so they load on demand instead of with the route.
 *
 * Each `preload*` function starts the download without rendering anything and
 * is safe to call repeatedly: the dynamic import is memoised, and `React.lazy`
 * reuses the same promise, so a hover that preloads and the click that renders
 * share one request.
 */

import { lazy, Suspense, type ComponentProps } from "react";

function once<T>(load: () => Promise<T>): () => Promise<T> {
	let promise: Promise<T> | null = null;
	return () => {
		if (!promise) {
			promise = load().catch((error) => {
				// A failed chunk (offline, a deploy replaced it) must not poison
				// later attempts.
				promise = null;
				throw error;
			});
		}
		return promise;
	};
}

const loadComposer = once(() => import("~/components/mail/Composer"));
const loadEditor = once(() => import("~/components/mail/Editor"));
const loadAgentPanel = once(() => import("~/components/EnhancedAgentPanel"));

/** Start fetching the composer (and the editor it imports). */
export function preloadComposer(): void {
	loadComposer().catch(() => {});
}

/** Start fetching the agent panel. */
export function preloadAgentPanel(): void {
	loadAgentPanel().catch(() => {});
}

/**
 * Preload the agent panel (and optionally the composer) once the page has
 * settled, so opening them is instant without putting them on the critical
 * path. Returns a cancel function for an effect cleanup.
 *
 * "Settled" is the window `load` event plus a delay, then an idle callback.
 * An idle callback alone is not enough: the main thread is idle while the
 * list request is still in flight, so it fired before first content and the
 * ~160 KB of chunks competed with the request the page was waiting on.
 */
export function preloadAgentPanelWhenIdle(
	options: { alsoComposer?: boolean } = {},
): () => void {
	if (typeof window === "undefined") return () => {};
	const run = () => {
		preloadAgentPanel();
		if (options.alsoComposer) preloadComposer();
	};
	const w = window as Window & {
		requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
		cancelIdleCallback?: (id: number) => void;
	};
	let idleId: number | undefined;
	let timer: number | undefined;
	const schedule = () => {
		timer = window.setTimeout(() => {
			if (w.requestIdleCallback) idleId = w.requestIdleCallback(run, { timeout: 5_000 });
			else run();
		}, SETTLE_DELAY_MS);
	};
	if (document.readyState === "complete") schedule();
	else window.addEventListener("load", schedule, { once: true });
	return () => {
		window.removeEventListener("load", schedule);
		if (timer !== undefined) window.clearTimeout(timer);
		if (idleId !== undefined) w.cancelIdleCallback?.(idleId);
	};
}

/** After `load`, how long to leave the network to the page itself. */
const SETTLE_DELAY_MS = 2_000;

/**
 * Hover and focus handlers for a button that opens the composer, so the chunk
 * is usually in by the time the click lands.
 */
export const composerPreloadProps = {
	onPointerEnter: preloadComposer,
	onFocus: preloadComposer,
} as const;

const ComposerImpl = lazy(loadComposer);
const EditorImpl = lazy(loadEditor);
const AgentPanelImpl = lazy(loadAgentPanel);

export function LazyComposer(props: ComponentProps<typeof ComposerImpl>) {
	// No fallback: the compose window is an overlay, and a placeholder frame
	// flashing for the few milliseconds a cached chunk takes would be noise.
	return (
		<Suspense fallback={null}>
			<ComposerImpl {...props} />
		</Suspense>
	);
}

export function LazyEditor(props: ComponentProps<typeof EditorImpl>) {
	return (
		<Suspense
			fallback={
				<div
					className="min-h-[200px] rounded-[6px] border border-border bg-card"
					aria-busy="true"
					aria-label="Loading editor"
				/>
			}
		>
			<EditorImpl {...props} />
		</Suspense>
	);
}

export function LazyAgentPanel(props: ComponentProps<typeof AgentPanelImpl>) {
	return (
		<Suspense
			fallback={
				<div
					className="flex h-full items-center justify-center text-sm text-text-secondary"
					aria-busy="true"
				>
					Loading agent…
				</div>
			}
		>
			<AgentPanelImpl {...props} />
		</Suspense>
	);
}
