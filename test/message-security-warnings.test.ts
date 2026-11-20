import { describe, expect, it } from "vitest";
import { warningsFor } from "../workers/lib/message-security";
import { serializeSenderWarnings } from "../shared/sender-warning-types";

describe("warningsFor", () => {
	it("drops a stored name warning when both addresses share an organisation", () => {
		const stored = serializeSenderWarnings([
			{
				kind: "display_name_spoof",
				message: '"Cloudflare" usually writes from connectevent@cloudflare.com, but this came from noreply@notify.cloudflare.com.',
				detail: { name: "Cloudflare", actual: "noreply@notify.cloudflare.com", usual: "connectevent@cloudflare.com" },
			},
			{ kind: "first_time_sender", message: "First.", detail: { address: "noreply@notify.cloudflare.com" } },
		]);
		expect(warningsFor({ folder_id: "inbox", security_warnings: stored }).map((w) => w.kind)).toEqual(["first_time_sender"]);
	});

	it("keeps a stored name warning across organisations", () => {
		const stored = serializeSenderWarnings([
			{
				kind: "display_name_spoof",
				message: "x",
				detail: { name: "Cloudflare", actual: "a@evil.example", usual: "connectevent@cloudflare.com" },
			},
		]);
		expect(warningsFor({ folder_id: "inbox", security_warnings: stored })).toHaveLength(1);
	});
});
