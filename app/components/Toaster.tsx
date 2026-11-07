import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import {
	ANNOUNCE_EVENT,
	TOAST_DISMISS_EVENT,
	TOAST_EVENT,
	UNDO_EVENT,
	type ToastInit,
	type ToastKind,
} from "~/lib/toast";
import { cn } from "~/lib/utils";

interface ToastItem extends ToastInit {
	id: string;
}

const KIND_META: Record<
	ToastKind,
	{ Icon: React.ElementType; ringClass: string; iconColor: string }
> = {
	info: { Icon: Info, ringClass: "ring-violet/30", iconColor: "#7c5cfc" },
	success: {
		Icon: CheckCircle2,
		ringClass: "ring-emerald-300/40",
		iconColor: "#047857",
	},
	warning: {
		Icon: AlertTriangle,
		ringClass: "ring-amber-300/50",
		iconColor: "#b45309",
	},
	error: { Icon: XCircle, ringClass: "ring-red-300/50", iconColor: "#b91c1c" },
};

/**
 * Renders the global toast queue. Mounted once by `DashboardLayout`.
 *
 * Anchored bottom-left so it never sits under the compose tray, which docks
 * bottom-right.
 */
export default function Toaster() {
	const [items, setItems] = useState<ToastItem[]>([]);
	/**
	 * Portals have no server equivalent, so mounting one during hydration makes
	 * React see an extra child in `body` and discard the whole tree. Wait for the
	 * first client effect instead.
	 */
	const [mounted, setMounted] = useState(false);
	/** Read by the Undo listener, which is registered once. */
	const itemsRef = useRef<ToastItem[]>([]);
	itemsRef.current = items;
	const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
		new Map(),
	);
	/**
	 * What the live region is currently saying.
	 *
	 * `nonce` is never rendered; it only forces the text node to change so a
	 * repeated message is announced again. See `onAnnounce` below.
	 */
	const [spoken, setSpoken] = useState<{ message: string; nonce: number }>({
		message: "",
		nonce: 0,
	});

	useEffect(() => setMounted(true), []);

	const dismiss = useCallback((id: string) => {
		setItems((prev) => prev.filter((item) => item.id !== id));
		const timer = timersRef.current.get(id);
		if (timer) {
			clearTimeout(timer);
			timersRef.current.delete(id);
		}
	}, []);

	useEffect(() => {
		function onToast(event: Event) {
			const detail = (event as CustomEvent<ToastInit>).detail;
			if (!detail?.id || typeof detail.message !== "string") return;
			const item = detail as ToastItem;

			// Same id replaces rather than stacks, so a rapid sequence of sends
			// shows one undo card instead of a wall of them.
			setItems((prev) => {
				const existing = prev.findIndex((t) => t.id === item.id);
				if (existing === -1) return [...prev, item];
				const next = [...prev];
				next[existing] = item;
				return next;
			});

			const previous = timersRef.current.get(item.id);
			if (previous) clearTimeout(previous);

			const ms = detail.durationMs ?? 4500;
			if (ms > 0) {
				timersRef.current.set(
					item.id,
					setTimeout(() => dismiss(item.id), ms),
				);
			} else {
				timersRef.current.delete(item.id);
			}
		}

		function onDismiss(event: Event) {
			const id = (event as CustomEvent<string>).detail;
			if (typeof id === "string") dismiss(id);
		}

		/**
		 * Announcements go through the same queue-free path as toasts, but into
		 * the live region below rather than the visible stack.
		 *
		 * The counter is what makes a repeat speak. Assistive tech announces a
		 * change in text content, so archiving two messages in a row wrote
		 * "Archived" over "Archived" and the second went unspoken; appending an
		 * invisible nonce guarantees the node's text differs every time.
		 */
		function onAnnounce(event: Event) {
			const message = (event as CustomEvent<string>).detail;
			if (typeof message !== "string" || !message) return;
			setSpoken((prev) => ({ message, nonce: prev.nonce + 1 }));
		}

		/**
		 * `z` and the palette's Undo press the newest toast's Undo button, so
		 * there is exactly one implementation of each undo: the one on the toast.
		 */
		function onUndo() {
			const newest = [...itemsRef.current]
				.reverse()
				.find((item) =>
					[item.action, ...(item.actions ?? [])].some((a) => a?.label === "Undo"),
				);
			const undo = newest
				? [newest.action, ...(newest.actions ?? [])].find((a) => a?.label === "Undo")
				: undefined;
			if (!newest || !undo) {
				setSpoken((prev) => ({ message: "Nothing to undo", nonce: prev.nonce + 1 }));
				return;
			}
			undo.onClick(() => dismiss(newest.id));
		}

		window.addEventListener(TOAST_EVENT, onToast);
		window.addEventListener(UNDO_EVENT, onUndo);
		window.addEventListener(TOAST_DISMISS_EVENT, onDismiss);
		window.addEventListener(ANNOUNCE_EVENT, onAnnounce);
		return () => {
			window.removeEventListener(TOAST_EVENT, onToast);
			window.removeEventListener(UNDO_EVENT, onUndo);
			window.removeEventListener(TOAST_DISMISS_EVENT, onDismiss);
			window.removeEventListener(ANNOUNCE_EVENT, onAnnounce);
			for (const timer of timersRef.current.values()) clearTimeout(timer);
			timersRef.current.clear();
		};
	}, [dismiss]);

	if (!mounted || typeof document === "undefined") return null;

	return createPortal(
		<>
			{/*
			  The app's single live region.

			  Separate from the toast stack and always mounted: a region created at
			  the same moment its text appears is often missed entirely, and the
			  stack itself is emptied on dismiss, which would retract the message.
			  `sr-only` rather than `hidden` — `hidden` and `display:none` remove the
			  node from the accessibility tree and nothing is announced at all.
			*/}
			<div aria-live="polite" aria-atomic="true" className="sr-only">
				{spoken.message}
			</div>

			<div
				aria-live="polite"
				className="pointer-events-none fixed bottom-4 left-4 z-[60] flex w-full max-w-[360px] flex-col gap-2 sm:bottom-6 sm:left-6"
			>
				{items.map((item) => {
					const meta = KIND_META[item.kind ?? "info"];
					// `action` first, then any extras, so adding a second button never
					// moves the one that was already there.
					const buttons = [
						...(item.action ? [item.action] : []),
						...(item.actions ?? []),
					];
					return (
						<div
							key={item.id}
							role="status"
							className={cn(
								"pointer-events-auto flex items-start gap-3 rounded-[10px] border border-border bg-card px-3.5 py-3 shadow-lg ring-1",
								meta.ringClass,
							)}
						>
							<meta.Icon
								size={16}
								className="mt-0.5 shrink-0"
								style={{ color: meta.iconColor }}
								aria-hidden
							/>
							<div className="min-w-0 flex-1">
								<p className="text-sm font-medium text-text-primary">
									{item.message}
								</p>
								{item.description && (
									<p className="mt-0.5 text-xs font-light text-text-secondary">
										{item.description}
									</p>
								)}
								{buttons.length > 0 && (
									<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
										{buttons.map((action) => (
											<button
												key={action.label}
												type="button"
												onClick={() => action.onClick(() => dismiss(item.id))}
												className="inline-flex items-center rounded-[6px] border border-border px-2 py-1 text-xs font-medium text-text-primary transition-colors hover:bg-bg-muted"
											>
												{action.label}
											</button>
										))}
									</div>
								)}
							</div>
							<button
								type="button"
								onClick={() => dismiss(item.id)}
								aria-label="Dismiss notification"
								className="shrink-0 rounded-[6px] p-1 text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
							>
								<X size={12} />
							</button>
						</div>
					);
				})}
			</div>
		</>,
		document.body,
	);
}
