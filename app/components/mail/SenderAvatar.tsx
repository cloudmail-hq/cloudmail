import { useState } from "react";
import { DEFAULT_SENDER_PICTURES, senderPictureUrl } from "shared/sender-pictures";
import { isRoleAddress, senderAvatarTint, senderInitials } from "~/lib/sender-display";
import { cn } from "~/lib/utils";
import { usePrivacySettings } from "~/queries/privacy";

/**
 * The round picture beside a sender: their logo or photo when one exists and
 * the message was authenticated, a generated face otherwise, and tinted
 * initials while it loads, when it fails, or when pictures are switched off.
 *
 * The initials are always drawn underneath, so a slow or missing picture never
 * leaves a hole and the row does not shift when it arrives. Which picture, and
 * why authentication gates it, is in `shared/sender-pictures.ts`.
 */
export default function SenderAvatar({
	address,
	name,
	verified,
	className,
}: {
	address: string;
	name?: string | null;
	/** The row's stored `sender_auth`: only 1 allows a real logo or photo. */
	verified?: number | boolean | null;
	className?: string;
}) {
	const { data } = usePrivacySettings();
	// Until the settings arrive nothing is requested: an operator who turned
	// pictures off must not see a lookup fire on first paint.
	const stored = data ? (data.senderPictures ?? DEFAULT_SENDER_PICTURES) : null;
	// A role mailbox gets a logo or its initials, never a drawn face.
	const settings = stored && isRoleAddress(address) ? { ...stored, generated: false } : stored;
	const src = settings ? senderPictureUrl(address, verified === 1 || verified === true, settings) : null;
	// Keyed by URL, so a recycled row never shows the previous sender's state.
	const [state, setState] = useState<{ src: string; status: "loaded" | "failed" } | null>(null);
	const status = state && state.src === src ? state.status : "loading";

	return (
		<span
			aria-hidden
			className={cn(
				"relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-[13px] font-semibold",
				senderAvatarTint(address),
				className,
			)}
		>
			{senderInitials(address || "?", name)}
			{src && status !== "failed" && (
				<img
					src={src}
					alt=""
					loading="lazy"
					decoding="async"
					draggable={false}
					onLoad={() => setState({ src, status: "loaded" })}
					onError={() => setState({ src, status: "failed" })}
					className={cn(
						// White behind it: logos and icons are often transparent and
						// drawn for a light page.
						"absolute inset-0 h-full w-full bg-white object-cover transition-opacity duration-150",
						status === "loaded" ? "opacity-100" : "opacity-0",
					)}
				/>
			)}
		</span>
	);
}
