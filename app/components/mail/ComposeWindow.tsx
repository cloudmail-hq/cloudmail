/**
 * Window chrome for the composer.
 *
 * The composer is a non-modal window: the mail list behind it stays clickable,
 * so writing a message never blocks looking something up. That only works if
 * the window can be got out of the way without being thrown away, hence three
 * states rather than the two it had before — minimised keeps the draft alive as
 * a docked title bar, compact is the default corner panel, fullscreen is for
 * long messages.
 *
 * Geometry lives here rather than in `Composer` so the states can't drift out of
 * step with the buttons that switch between them.
 */

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import { cn } from "~/lib/utils";

export type ComposeWindowState = "compact" | "minimized" | "fullscreen";

export interface DropHandlers {
	onDragOver: (e: React.DragEvent) => void;
	onDragLeave: () => void;
	onDrop: (e: React.DragEvent) => void;
}

interface ComposeWindowProps {
	title: string;
	/** Recipient summary, shown after the title and in the minimised bar. */
	subtitle?: string;
	icon: ReactNode;
	state: ComposeWindowState;
	onStateChange: (next: ComposeWindowState) => void;
	onClose: () => void;
	closeDisabled?: boolean;
	/** Draws attention to the frame while files are dragged over it. */
	isDropTarget?: boolean;
	dropHandlers?: DropHandlers;
	/** Short status ("Saving…", "Draft saved 12:04") shown when minimised. */
	minimizedStatus?: string;
	children: ReactNode;
}

/**
 * Full-width sheet on phones, corner panel from `sm` up. The panel is taller and
 * wider than the old fixed 560px box: at that size a quoted reply left about
 * four visible lines to type into.
 */
const GEOMETRY: Record<ComposeWindowState, string> = {
	minimized:
		"bottom-0 right-0 w-full rounded-t-[12px] pb-safe sm:right-6 sm:w-[340px] sm:pb-0",
	/*
	  Full screen on a phone, as in every mobile mail app. The old 88vh sheet left
	  a strip of list showing above it that did nothing but look tappable, and
	  `vh` on iOS is the height with the toolbar hidden, so the sheet's own
	  footer (Send) slid under the browser chrome. `h-dvh` follows the visible
	  viewport, and the safe-area padding keeps the title bar below the notch and
	  Send above the home indicator. The window is portalled to <body> (below)
	  so it can cover the top bar, which sits in a higher stacking context.
	*/
	compact:
		"inset-0 h-dvh w-full rounded-none border-0 pt-safe pb-safe sm:inset-auto sm:bottom-0 sm:right-6 sm:h-[600px] sm:max-h-[calc(100vh-4rem)] sm:w-[580px] sm:max-w-[calc(100vw-3rem)] sm:rounded-t-[12px] sm:border sm:pt-0 sm:pb-0",
	// `top-14` clears the fixed top navigation (48px), which is also z-50: an
	// inset-3 fullscreen sat on top of it and hid the app's own chrome.
	// On a phone, the same as compact: there is no larger size to grow into.
	fullscreen:
		"inset-0 h-dvh w-full rounded-none border-0 pt-safe pb-safe sm:inset-x-8 sm:bottom-8 sm:top-16 sm:h-auto sm:w-auto sm:rounded-[12px] sm:border sm:pt-0 sm:pb-0",
};

function WindowButton({
	label,
	onClick,
	disabled,
	children,
	keyshortcuts,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	children: ReactNode;
	keyshortcuts?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={label}
			aria-label={label}
			aria-keyshortcuts={keyshortcuts}
			className="inline-flex h-7 w-7 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
		>
			{children}
		</button>
	);
}

export default function ComposeWindow({
	title,
	subtitle,
	icon,
	state,
	onStateChange,
	onClose,
	closeDisabled,
	isDropTarget,
	dropHandlers,
	minimizedStatus,
	children,
}: ComposeWindowProps) {
	const minimized = state === "minimized";
	const fullscreen = state === "fullscreen";

	const frame = (
		<div
			// Drag-drop is only wired while the window is open; dropping a file on a
			// collapsed title bar has nowhere visible to land.
			{...(minimized ? {} : dropHandlers)}
			role="dialog"
			aria-modal="false"
			aria-label={title}
			className={cn(
				"compose-window fixed z-50 flex flex-col overflow-hidden border border-border bg-card shadow-[0_24px_60px_-15px_rgba(15,23,42,0.35)]",
				"transition-[height,width,inset,border-radius] duration-200 ease-out",
				GEOMETRY[state],
				isDropTarget && !minimized && "ring-2 ring-violet",
			)}
		>
			<div
				className={cn(
					// Light, like the window, rather than a near-black strip: Gmail's
					// compose header is a tint of its surface, not a second theme.
					"flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-bg-subtle px-2 pl-4 touch:h-12 touch:px-1 touch:pl-4",
					// The bar is the only way back from minimised, so make the whole
					// thing the target rather than just the restore icon.
					minimized && "cursor-pointer",
				)}
				onClick={minimized ? () => onStateChange("compact") : undefined}
			>
				<div className="flex min-w-0 items-center gap-2">
					<span className="shrink-0 text-text-secondary">{icon}</span>
					<h2 className="truncate text-sm font-medium text-text-primary">
						{title}
						{subtitle ? (
							<span className="font-normal text-text-secondary"> · {subtitle}</span>
						) : null}
					</h2>
				</div>

				<div className="flex shrink-0 items-center gap-0.5">
					{minimized && minimizedStatus && (
						<span className="mr-1 hidden text-xs text-text-tertiary sm:inline">
							{minimizedStatus}
						</span>
					)}

					{minimized ? (
						<WindowButton
							label="Restore composer"
							onClick={() => onStateChange("compact")}
						>
							<Maximize2 size={12} />
						</WindowButton>
					) : (
						<>
							<WindowButton
								label="Minimise composer (Esc)"
								keyshortcuts="Escape"
								onClick={() => onStateChange("minimized")}
							>
								<Minus size={13} />
							</WindowButton>
							{/* No larger size than full screen on a phone. */}
							<span className="contents max-sm:hidden">
								<WindowButton
									label={fullscreen ? "Restore size" : "Maximise composer"}
									onClick={() =>
										onStateChange(fullscreen ? "compact" : "fullscreen")
									}
								>
									{fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
								</WindowButton>
							</span>
						</>
					)}

					<WindowButton
						label="Close composer"
						onClick={onClose}
						disabled={closeDisabled}
					>
						<X size={13} className="touch:size-5" />
					</WindowButton>
				</div>
			</div>

			{/* Kept mounted while minimised: unmounting would drop the editor's
			    undo history and any attachment previews staged so far. */}
			<div className={cn("flex min-h-0 flex-1 flex-col", minimized && "hidden")}>
				{children}
			</div>
		</div>
	);

	// Portalled so a full-screen phone composer stacks above the top bar; see
	// GEOMETRY. Context still flows through a portal, so nothing else changes.
	return typeof document === "undefined" ? frame : createPortal(frame, document.body);
}

/**
 * One row of the envelope. A fixed label column keeps From / To / Cc / Bcc /
 * Subject aligned, and the field runs flush to the right edge so the whole
 * block stays under ~150px and leaves the room to the message.
 */
export function ComposeMetaRow({
	label,
	htmlFor,
	children,
	trailing,
	align = "center",
}: {
	label: string;
	htmlFor?: string;
	children: ReactNode;
	trailing?: ReactNode;
	align?: "center" | "start";
}) {
	return (
		<div
			className={cn(
				// The row is the field: a hairline under each, and the caret is the
				// focus cue, as in Gmail. An accent underline read as the top edge
				// of the next row.
				"flex gap-2 border-b border-border/70 px-4 last:border-b-0",
				align === "start" ? "items-start" : "items-center",
			)}
		>
			<label
				htmlFor={htmlFor}
				className={cn(
					"w-14 shrink-0 text-sm text-text-tertiary",
					align === "start" && "pt-2",
				)}
			>
				{label}
			</label>
			<div className="min-w-0 flex-1">{children}</div>
			{trailing ? <div className="shrink-0">{trailing}</div> : null}
		</div>
	);
}
