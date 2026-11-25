import { useEffect, useState } from "react";

/** Whether a platform string is Apple's, where the modifier is ⌘ rather than Ctrl. */
export function isApplePlatform(platform: string): boolean {
	return /mac|iphone|ipad|ipod/i.test(platform);
}

/** `⌘` on Apple platforms, `Ctrl ` elsewhere. Decided after hydration. */
export function useModKeyLabel(): string {
	const [label, setLabel] = useState("⌘");
	useEffect(() => {
		const platform =
			(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
				?.platform ?? navigator.platform;
		if (!isApplePlatform(platform)) setLabel("Ctrl ");
	}, []);
	return label;
}
