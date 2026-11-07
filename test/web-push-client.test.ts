/** The settings page's device guidance: when to tell iOS users to install the app first. */

import { describe, expect, it } from "vitest";
import { isIos, pushSupport, urlBase64ToUint8Array, type PushEnvironment } from "~/lib/web-push";

const IPHONE_18 = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPHONE_16_3 = IPHONE_18.replace("18_1", "16_3");
const IPAD_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

function env(over: Partial<PushEnvironment>): PushEnvironment {
	return {
		userAgent: CHROME_ANDROID,
		maxTouchPoints: 5,
		standalone: false,
		secure: true,
		hasServiceWorker: true,
		hasPushManager: true,
		hasNotification: true,
		...over,
	};
}

describe("pushSupport", () => {
	it("is supported in a capable browser", () => {
		expect(pushSupport(env({}))).toBe("supported");
	});

	it("asks iPhone users to add the app to the Home Screen, even though Safari hides the APIs", () => {
		expect(pushSupport(env({ userAgent: IPHONE_18, hasPushManager: false, hasNotification: false }))).toBe("ios-needs-install");
		expect(pushSupport(env({ userAgent: IPHONE_18, standalone: true }))).toBe("supported");
	});

	it("recognises an iPad pretending to be a Mac", () => {
		expect(isIos({ userAgent: IPAD_DESKTOP, maxTouchPoints: 5 })).toBe(true);
		expect(isIos({ userAgent: IPAD_DESKTOP, maxTouchPoints: 0 })).toBe(false);
		expect(pushSupport(env({ userAgent: IPAD_DESKTOP }))).toBe("ios-needs-install");
	});

	it("says when iOS is too old, or the page is not secure", () => {
		expect(pushSupport(env({ userAgent: IPHONE_16_3, standalone: true }))).toBe("ios-too-old");
		expect(pushSupport(env({ secure: false }))).toBe("insecure");
		expect(pushSupport(env({ hasPushManager: false }))).toBe("unsupported");
	});

	it("decodes a VAPID key for applicationServerKey", () => {
		const bytes = urlBase64ToUint8Array("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
		expect(bytes.length).toBe(65);
		expect(bytes[0]).toBe(4);
	});
});
