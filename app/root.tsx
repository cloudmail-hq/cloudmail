// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
} from "react-router";
import BrandingHead from "~/components/BrandingHead";
import Toaster from "~/components/Toaster";
import { initThemeSync, themeInitScript } from "~/hooks/useThemeStore";
import { registerServiceWorker } from "~/lib/service-worker";
import { ApiError } from "~/services/api";
import "./index.css";

function makeQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				refetchOnWindowFocus: false,
				retry: (failureCount, error) => {
					// Don't retry 4xx errors (not found, unauthorized, etc.)
					if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
						return false;
					}
					return failureCount < 2;
				},
			},
		},
		mutationCache: new MutationCache({
			onError: (error) => {
				// Global fallback for mutations that don't handle errors themselves.
				// Consumers using mutateAsync + try/catch handle their own errors.
				console.error("Mutation failed:", error);
			},
		}),
	});
}

// Lazy singleton for the browser — avoids module-scope instantiation that
// leaks cache across SSR requests.
let browserQueryClient: QueryClient | undefined;
function getQueryClient() {
	if (typeof window === "undefined") {
		// SSR: always create a fresh client per request to prevent cross-user cache leaks
		return makeQueryClient();
	}
	// Browser: reuse the same client across navigations
	if (!browserQueryClient) browserQueryClient = makeQueryClient();
	return browserQueryClient;
}

export function Layout({ children }: { children: React.ReactNode }) {
	return (
		// The theme class is written onto <html> by the script below, i.e. after
		// the server rendered this markup. React would otherwise flag the extra
		// class as a hydration mismatch.
		<html lang="en" suppressHydrationWarning>
			<head>
				<meta charSet="UTF-8" />
				{/*
					Applies the saved theme before the first paint.

					It has to be inline and ahead of <Links />: anything async, or any
					attempt to do this from an effect, paints the light theme first and
					then snaps to dark on hydration.
				*/}
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: fixed, build-time literal with no interpolated input. */}
				<script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
				<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
				<link
					rel="icon"
					type="image/x-icon"
					href="/favicon.ico"
					sizes="48x48 32x32 16x16"
				/>
				{/* Fonts: Inter from Google Fonts */}
				<link
					rel="preconnect"
					href="https://fonts.googleapis.com"
				/>
				<link
					rel="preconnect"
					href="https://fonts.gstatic.com"
					crossOrigin="anonymous"
				/>
				<link
					rel="stylesheet"
					href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300..700&display=swap"
				/>
				{/*
					`use-credentials` is load-bearing, not decoration.

					A manifest is fetched anonymously by default. This one is behind
					Cloudflare Access, which is enforced at the edge, so an anonymous
					fetch is bounced before it reaches the Worker and the browser
					silently reports the app as non-installable. See the route in
					`workers/index.ts`.
				*/}
				<link
					rel="manifest"
					href="/manifest.webmanifest"
					crossOrigin="use-credentials"
				/>
				{/*
					`viewport-fit=cover` so an installed app on a notched phone draws edge to
					edge; the chrome pads itself with `env(safe-area-inset-*)` (the `*-safe`
					utilities in index.css) so nothing lands under the notch or the home
					indicator.
				*/}
				<meta
					name="viewport"
					content="width=device-width, initial-scale=1.0, viewport-fit=cover"
				/>
				{/*
					Browser chrome colour per OS theme, matching the top bar (`bg-card`) in
					each. The manifest's single `theme_color` cannot follow the theme, so
					these are what a phone's status bar actually uses while the app is open.
				*/}
				<meta
					name="theme-color"
					media="(prefers-color-scheme: light)"
					content="#ffffff"
				/>
				<meta
					name="theme-color"
					media="(prefers-color-scheme: dark)"
					content="#14171f"
				/>
				{/* iOS ignores manifest icons for the home screen and reads this instead. */}
				<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
				<meta name="apple-mobile-web-app-capable" content="yes" />
				<meta name="mobile-web-app-capable" content="yes" />
				<meta
					name="apple-mobile-web-app-status-bar-style"
					content="default"
				/>
				{/* Pre-hydration default. The configured app name replaces this via
				    `BrandingHead`, which reads the stored branding record. */}
				<title>cloudmail</title>
				<Meta />
				<Links />
			</head>
			<body className="bg-background text-foreground antialiased">
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export function HydrateFallback() {
	return (
		<div className="flex h-screen items-center justify-center">
			<Loader2 className="h-6 w-6 animate-spin text-text-tertiary" />
		</div>
	);
}

export default function App() {
	// useState so each SSR request gets a fresh client while the browser reuses
	// the same singleton across navigations.
	const [queryClient] = useState(getQueryClient);

	// Keeps the "System" preference live: without this, the OS flipping to dark
	// while the tab is open would not be picked up until a reload.
	useEffect(() => initThemeSync(), []);
	// Production only: a service worker in dev would cache Vite's modules and
	// serve stale code across HMR reloads.
	useEffect(() => {
		if (import.meta.env.PROD) registerServiceWorker();
	}, []);
	return (
		<QueryClientProvider client={queryClient}>
			{/* Inside the provider: it reads the branding query. Renders nothing. */}
			<BrandingHead />
			<Outlet />
			{/* Mounted at the root so toasts survive route changes — the undo-send
			    window in particular has to outlive navigating away from the composer. */}
			<Toaster />
		</QueryClientProvider>
	);
}

export function ErrorBoundary({ error }: { error: unknown }) {
	let title = "Something went wrong";
	let description = "An unexpected error occurred. Please try again.";
	let status: number | null = null;

	if (isRouteErrorResponse(error)) {
		status = error.status;
		if (error.status === 404) {
			title = "Page not found";
			description =
				"The page you're looking for doesn't exist or has been moved.";
		} else {
			title = `Error ${error.status}`;
			description = error.statusText || description;
		}
	} else if (error instanceof Error && import.meta.env.DEV) {
		description = error.message;
	}

	return (
		<div className="flex min-h-screen items-center justify-center p-8">
			<div className="flex max-w-md flex-col items-center rounded-[10px] border border-border bg-card px-6 py-10 text-center">
				<AlertTriangle
					className="mb-4 h-10 w-10 text-text-tertiary"
					strokeWidth={1.25}
					aria-hidden
				/>
				<h1 className="mb-1.5 text-base font-bold text-text-primary">
					{status === 404 ? "404 — Page not found" : title}
				</h1>
				<p className="mb-5 text-sm font-light text-text-secondary">
					{description}
				</p>
				<button
					type="button"
					onClick={() => {
						window.location.href = "/";
					}}
					className="rounded-[6px] bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
				>
					Go to mail
				</button>
			</div>
		</div>
	);
}
