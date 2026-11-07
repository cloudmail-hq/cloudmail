/**
 * The TipTap editor, loaded on demand.
 *
 * TipTap and ProseMirror are the largest part of the client bundle, and most
 * pages that can show an editor (template editor, sequence dialogs) don't need
 * it until it renders. This keeps them in their own chunk and shows an
 * editor-shaped skeleton while it loads.
 */

import { lazy, Suspense, type ComponentProps } from "react";
import { cn } from "~/lib/utils";

const Editor = lazy(() => import("./Editor"));

export type LazyEditorProps = ComponentProps<typeof Editor>;
export type { EditorHandle } from "./Editor";

export function EditorSkeleton({ className }: { className?: string }) {
	return (
		<div
			aria-busy="true"
			aria-label="Loading editor"
			className={cn("flex min-h-[240px] flex-col overflow-hidden rounded-[8px] border border-border bg-card", className)}
		>
			<div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-bg-subtle/70 px-2">
				{Array.from({ length: 8 }, (_, i) => (
					<span key={i} className="h-5 w-5 animate-pulse rounded bg-bg-muted" />
				))}
			</div>
			<div className="space-y-2 p-4">
				<span className="block h-3 w-2/3 animate-pulse rounded bg-bg-muted" />
				<span className="block h-3 w-1/2 animate-pulse rounded bg-bg-muted/70" />
			</div>
		</div>
	);
}

export default function LazyEditor(props: LazyEditorProps) {
	return (
		<Suspense fallback={<EditorSkeleton className={props.className} />}>
			<Editor {...props} />
		</Suspense>
	);
}
