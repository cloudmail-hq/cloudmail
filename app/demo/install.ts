/**
 * Starts the demo before the app renders: loads the data, puts the in-page
 * backend in front of `fetch`, and fills the hooks for URLs the browser loads
 * on its own (images, downloads). Called once from entry.client.tsx.
 *
 * After this, no request for `/api/*` or `/agents/*` reaches the network, and
 * nothing a visitor types or changes is sent anywhere: the only requests left
 * are GETs for the site's own static files.
 */

import "./demo.css";
import { showToast } from "../lib/toast";
import { READ_ONLY } from "./backend";
import { demoHooks } from "./hooks";
import { createDemo, type DemoRuntime } from "./runtime";
import type { DemoSnapshot } from "./store";

let runtime: DemoRuntime | null = null;

/** The running demo. Only valid after `installDemo()`. */
export function demo(): DemoRuntime {
	if (!runtime) throw new Error("the demo is not installed");
	return runtime;
}

/** Where other parts of a real deployment live, for links that leave the app. */
const SITE = "https://trycloudmail.com";
const PUBLIC_AUTH = /^\/(login|setup|forgot|recover|invite\/.*|reset\/.*)?$/;

function jsonResponse(status: number, body: unknown): Response {
	if (status === 204) return new Response(null, { status });
	return new Response(JSON.stringify(body ?? null), { status, headers: { "content-type": "application/json" } });
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
	let raw: unknown = init?.body;
	if (raw == null && input instanceof Request && input.method !== "GET" && input.method !== "HEAD") {
		raw = await input.clone().text().catch(() => "");
	}
	if (typeof raw !== "string" || raw === "") return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function installFetch(rt: DemoRuntime): void {
	const network = window.fetch.bind(window);
	window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");

		// Files made in the page (attachments).
		const file = rt.files.fromUrl(href);
		if (file) return new Response(file, { status: 200, headers: { "content-type": file.type } });

		const url = new URL(href, window.location.href);
		const local = url.origin === window.location.origin;
		if (local && /^\/(api|agents)\//.test(url.pathname)) {
			const res = rt.backend.handle(method, url, await readBody(input, init));
			// One turn of the event loop, so loading states behave as they do over a network.
			await new Promise((r) => setTimeout(r, 0));
			if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
			if (res.blob) return new Response(res.blob, { status: res.status, headers: { "content-type": res.blob.type } });
			return jsonResponse(res.status, res.body);
		}
		// What is left is the site's own static files. Anything else would carry
		// data off the page, so it is refused here rather than sent.
		if (local && (method === "GET" || method === "HEAD")) return network(input, init);
		return jsonResponse(403, { error: READ_ONLY, code: "demo_read_only" });
	};
}

/** Links that a real deployment serves from its Worker. */
function installLinks(): void {
	document.addEventListener(
		"click",
		(event) => {
			const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
			if (!anchor) return;
			const path = anchor.getAttribute("href") ?? "";
			if (/^\/(docs|privacy)(\/|$|\?|#)/.test(path)) {
				event.preventDefault();
				window.open(SITE + path, "_blank", "noopener,noreferrer");
			} else if (path.startsWith("/api/")) {
				// A download the server would build (the mailbox export).
				event.preventDefault();
				showToast({ kind: "error", message: "Exports are turned off in the demo." });
			}
		},
		true,
	);
}

export async function installDemo(): Promise<void> {
	if (runtime) return;
	const { default: snapshot } = await import("./data/snapshot.json");
	const rt = createDemo(snapshot as unknown as DemoSnapshot, {
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
	});
	runtime = rt;

	demoHooks.attachmentUrl = (mailboxId, emailId, attachmentId) => {
		const attachment = (rt.store.getEmail(mailboxId, emailId).attachments ?? []).find((a: { id: string }) => a.id === attachmentId);
		return attachment ? rt.files.url(attachment) : "about:blank";
	};
	demoHooks.pictureUrl = (address, generated) => (generated ? rt.files.face(address) : null);

	installFetch(rt);
	installLinks();

	// No sign-in: the visitor starts in the owner's inbox.
	if (PUBLIC_AUTH.test(window.location.pathname)) {
		window.history.replaceState(null, "", `/mail/${encodeURIComponent(rt.store.owner)}/inbox`);
	}
}
