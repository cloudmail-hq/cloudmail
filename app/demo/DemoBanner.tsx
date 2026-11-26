import { X } from "lucide-react";
import { useState } from "react";

/**
 * The notice every demo page carries: a strip above the top bar. Its height
 * is `--app-notice-h` (set in storage-script.ts, read by index.css), so the
 * app's chrome sits below it and nothing is covered. Hiding it lasts until
 * the next reload, like every other change in the demo.
 */
export default function DemoBanner() {
	const [open, setOpen] = useState(true);
	if (!open) return null;
	const link = "font-semibold underline underline-offset-2 hover:no-underline";
	return (
		<div
			role="note"
			aria-label="About this demo"
			title="Changes last until you reload the page."
			className="fixed inset-x-0 top-0 z-[70] box-content flex h-8 items-center justify-center bg-accent pl-3 pr-9 pt-[env(safe-area-inset-top,0px)] text-[11px] text-accent-foreground sm:px-10 sm:text-xs"
		>
			<p className="min-w-0 truncate">
				<span className="font-semibold">This is a demo.</span> Nothing is saved.
				<span className="mx-2 opacity-60" aria-hidden>
					|
				</span>
				<a href="https://trycloudmail.com" target="_blank" rel="noopener" className={link}>
					<span className="hidden sm:inline">Get </span>cloudmail
				</a>
				<span className="mx-1.5 opacity-60" aria-hidden>
					·
				</span>
				<a href="https://trycloudmail.com/pricing" target="_blank" rel="noopener" className={link}>
					Pricing
				</a>
			</p>
			<button
				type="button"
				onClick={() => {
					document.documentElement.style.removeProperty("--app-notice-h");
					setOpen(false);
				}}
				aria-label="Hide this notice"
				className="absolute right-1 top-[env(safe-area-inset-top,0px)] flex h-8 w-8 items-center justify-center rounded-full opacity-80 transition-opacity hover:opacity-100"
			>
				<X size={14} aria-hidden />
			</button>
		</div>
	);
}
