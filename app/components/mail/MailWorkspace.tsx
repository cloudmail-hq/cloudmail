/**
 * List + reading pane, shared by every mail listing route.
 *
 * The list stays mounted while a message is open so selection, paging and
 * scroll position survive reading — below `lg` the pane takes over the width
 * instead, because two columns at 400px are two unusable columns.
 *
 * Where the pane sits is the reader's choice (`display.readingPanePosition`):
 * beside the list, under it, or nowhere at all. The three are one flex container
 * with a different axis and a different list size rather than three separate
 * trees, so the list is never unmounted when the setting changes — remounting it
 * would drop the open selection and reset the scroll position on every switch.
 */

import { useParams } from "react-router";
import { LazyComposer } from "~/components/lazy";
import MessageView from "~/components/mail/MessageView";
import { useUIStore } from "~/hooks/useUIStore";
import { cn } from "~/lib/utils";
import { usePreferenceValues } from "~/queries/preferences";

interface MailWorkspaceProps {
	mailboxId: string;
	/** The listing for this route. */
	children: React.ReactNode;
}

export default function MailWorkspace({
	mailboxId,
	children,
}: MailWorkspaceProps) {
	const { folder } = useParams<{ folder?: string }>();
	const { selectedEmailId, isComposing } = useUIStore();
	const { display } = usePreferenceValues();
	const paneOpen = selectedEmailId !== null;
	const position = display.readingPanePosition;

	/**
	 * With no pane, an open message takes the whole width and the list is hidden.
	 *
	 * That is the same shape as the sub-`lg` behaviour, which is why it reuses it
	 * rather than routing to a separate read view: a route change would unmount
	 * the list, losing the selection and scroll position that make Back useful.
	 */
	const listOnly = position === "off";
	const split = paneOpen && !listOnly;

	return (
		<>
			<div
				className={cn(
					"flex h-full min-h-0",
					// Column only when split at the bottom. The sub-`lg` case is always
					// one full-width child, so its axis does not matter.
					split && position === "bottom" ? "flex-col" : "flex-row",
				)}
			>
				<div
					className={cn(
						"min-w-0",
						split && position === "right" && "border-r border-border",
						split && position === "bottom" && "border-b border-border",
						paneOpen
							? split
								? position === "right"
									? /*
										 The list grows with the window instead of staying at 380px.
										
										 A single fixed width has to be chosen for the narrowest
										 screen it will meet, so it was leaving truncated subject
										 lines on a display with room for the whole thing — while
										 handing every extra pixel to a reading pane that was
										 already wide enough. Stepping it up by breakpoint keeps the
										 list readable at 1280px and lets it show most of a subject
										 at 1920px, which is where Gmail and Outlook put theirs.
										
										 The ladder starts at `lg`, not `md`, and one step lower
										 than it used to. Two panes appeared from 768px, where the
										 208px folder rail and a 360px `shrink-0` list left the
										 message around 200px wide — narrower than a single
										 newsletter column, and the list was not gaining anything
										 from the split either. The rest of the ladder came down a
										 step for the same reason one tier up: at 1024px a 400px
										 list left the message about 400px, which is under the
										 600px that bulk mail is designed against and forced every
										 newsletter through the frame's scale-to-fit path.
										*/
										"hidden lg:block lg:w-[340px] lg:shrink-0 xl:w-[400px] 2xl:w-[460px]"
									: // A fixed pixel height would leave a phone-sized list on a
										// tall monitor and a two-row list on a laptop, so the bottom
										// split is proportional with a floor.
										"hidden min-h-[200px] lg:block lg:h-[42%] lg:shrink-0"
								: "hidden"
							: "flex-1",
					)}
				>
					{children}
				</div>

				<div className={cn("min-w-0 flex-1", paneOpen ? "block" : "hidden")}>
					{selectedEmailId && (
						<MessageView
							mailboxId={mailboxId}
							emailId={selectedEmailId}
							folderId={folder}
						/>
					)}
				</div>
			</div>

			{isComposing && <LazyComposer mailboxId={mailboxId} folderId={folder} />}
		</>
	);
}
