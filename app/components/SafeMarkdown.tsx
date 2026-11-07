// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Markdown for model output, with nothing that loads or navigates by itself.
 *
 * Use this anywhere model-written text is rendered (the agent panel, and any
 * summary or preview of agent output). See `app/lib/safe-links.ts` for why:
 * images are never fetched (they render as a link with a warning), links are
 * limited to http/https/mailto and always show their real host, and raw HTML
 * in the markdown is not rendered (react-markdown's default, kept on purpose).
 */

import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageOff } from "lucide-react";
import { linkDestination, markdownUrlTransform, safeHref } from "~/lib/safe-links";

const components: Components = {
	a: ({ href, children }) => {
		const safe = safeHref(href);
		if (!safe) return <span className="text-text-primary">{children}</span>;
		const host = linkDestination(safe);
		return (
			<span className="inline">
				<a
					href={safe}
					target="_blank"
					rel="noopener noreferrer nofollow"
					referrerPolicy="no-referrer"
					className="text-accent underline"
					title={safe}
				>
					{children}
				</a>
				{host ? (
					<span className="ml-1 rounded-[3px] bg-bg-muted px-1 py-px font-mono text-[10px] text-text-secondary" aria-label={`link to ${host}`}>
						{host}
					</span>
				) : null}
			</span>
		);
	},
	/**
	 * Never an <img>. Loading it is the exfiltration, so the image is shown as
	 * an inert notice with the destination, and only opens if the user clicks.
	 */
	img: ({ src, alt }) => {
		const safe = typeof src === "string" ? safeHref(src) : null;
		const host = safe ? linkDestination(safe) : "";
		return (
			<span
				role="note"
				className="my-1 inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-[6px] bg-warning-bg px-2 py-1 text-xs text-warning-text"
			>
				<ImageOff size={12} aria-hidden />
				<span>Image not loaded{alt ? `: ${alt}` : ""}.</span>
				{safe ? (
					<a
						href={safe}
						target="_blank"
						rel="noopener noreferrer nofollow"
						referrerPolicy="no-referrer"
						className="underline"
						title={safe}
					>
						Open from {host || "link"} (may tell that site you viewed it)
					</a>
				) : null}
			</span>
		);
	},
	p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
	strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
	ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-4 last:mb-0">{children}</ul>,
	ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-4 last:mb-0">{children}</ol>,
	li: ({ children }) => <li>{children}</li>,
	h1: ({ children }) => <h3 className="mb-1 text-sm font-semibold">{children}</h3>,
	h2: ({ children }) => <h4 className="mb-1 text-[13px] font-semibold">{children}</h4>,
	h3: ({ children }) => <h5 className="mb-0.5 text-[13px] font-semibold">{children}</h5>,
	code: ({ children }) => <code className="rounded bg-bg-subtle px-1 py-0.5 text-xs">{children}</code>,
	table: ({ children }) => (
		<div className="my-2 overflow-x-auto">
			<table className="w-full border-collapse text-xs">{children}</table>
		</div>
	),
	thead: ({ children }) => <thead className="border-b border-border bg-bg-subtle/30">{children}</thead>,
	th: ({ children }) => <th className="px-2 py-1 text-left font-semibold text-text-primary">{children}</th>,
	td: ({ children }) => <td className="border-b border-border/50 px-2 py-1">{children}</td>,
};

export default function SafeMarkdown({ children }: { children: string }) {
	return (
		<Markdown remarkPlugins={[remarkGfm]} urlTransform={markdownUrlTransform} skipHtml components={components}>
			{children}
		</Markdown>
	);
}
