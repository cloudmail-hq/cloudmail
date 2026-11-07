/**
 * Keyboard shortcut reference, opened with `?`.
 *
 * Radix rather than the hand-rolled overlay this replaced. The old version was
 * a bare `div` with `role="dialog"`: Escape only closed it because the shortcut
 * hook special-cased the key, focus stayed wherever it had been so Tab walked
 * the list behind the scrim, and nothing returned focus on close. Radix's Dialog
 * traps focus, restores it, marks the rest of the page inert, and handles Escape
 * itself — so the hook no longer needs to.
 *
 * Rows come from `SHORTCUT_HELP`, which is the same table the bindings are
 * declared beside, grouped the way Gmail groups its own help.
 */

import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { SHORTCUT_HELP } from "~/lib/shortcuts";

export default function ShortcutHelp({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent className="max-h-[80vh] gap-0 overflow-hidden p-0 sm:max-w-lg">
				<DialogHeader className="border-b border-border px-4 py-3">
					<DialogTitle className="text-sm font-bold">
						Keyboard shortcuts
					</DialogTitle>
				</DialogHeader>

				<div className="max-h-[60vh] overflow-y-auto px-4 py-2">
					{SHORTCUT_HELP.map((section) => (
						<section key={section.group} className="py-2">
							<h3 className="mb-1 text-xs font-medium text-text-secondary">
								{section.group}
							</h3>
							<dl className="divide-y divide-border/70">
								{section.rows.map((row) => (
									<div
										key={row.keys}
										className="flex items-center justify-between gap-4 py-1.5"
									>
										<dt className="text-xs text-text-secondary">
											{row.description}
										</dt>
										<dd className="shrink-0">
											<kbd className="rounded-[4px] border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-text-primary">
												{row.keys}
											</kbd>
										</dd>
									</div>
								))}
							</dl>
						</section>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
