// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
	cleanSenderName,
	decodeMimeWords,
	parseFromHeader,
	senderNameFromOutbound,
	senderNameFromRawHeaders,
} from "../shared/sender-name";
import { senderDisplayName, senderInitials } from "../app/lib/sender-display";

describe("parseFromHeader", () => {
	it("reads the quoted name Cloudflare emitted on a production send", () => {
		expect(parseFromHeader('"Tapetide tech team" <tech@tapetide.com>')).toEqual({
			name: "Tapetide tech team",
			address: "tech@tapetide.com",
		});
	});

	it("handles unquoted names, commas inside quotes and bare addresses", () => {
		expect(parseFromHeader("Priya Sharma <Priya@Example.com>")).toEqual({
			name: "Priya Sharma",
			address: "priya@example.com",
		});
		expect(parseFromHeader('"Sharma, Priya" <p@example.com>').name).toBe("Sharma, Priya");
		expect(parseFromHeader("p@example.com")).toEqual({ name: null, address: "p@example.com" });
	});

	it("reads the obsolete comment form", () => {
		expect(parseFromHeader("p@example.com (Priya S)")).toEqual({
			name: "Priya S",
			address: "p@example.com",
		});
	});

	it("unfolds a folded header", () => {
		expect(parseFromHeader("Very Long\r\n Name <a@b.co>").name).toBe("Very Long Name");
	});

	it("returns nothing for empty input", () => {
		expect(parseFromHeader(undefined)).toEqual({ name: null, address: null });
	});
});

describe("decodeMimeWords", () => {
	it("decodes B and Q words and joins adjacent ones without a space", () => {
		expect(decodeMimeWords("=?UTF-8?B?SMOpbMOobmU=?=")).toBe("Hélène");
		expect(decodeMimeWords("=?iso-8859-1?Q?Andr=E9_Martin?=")).toBe("André Martin");
		expect(decodeMimeWords("=?UTF-8?Q?Jo=C3=A3o?= =?UTF-8?Q?_Silva?=")).toBe("João Silva");
	});

	it("leaves a word with an unknown charset as written", () => {
		expect(decodeMimeWords("=?x-unknown?B?SGk=?=")).toBe("=?x-unknown?B?SGk=?=");
	});
});

describe("cleanSenderName", () => {
	it("drops a name that is just the address again", () => {
		expect(cleanSenderName("bob@x.com", "bob@x.com")).toBeNull();
		expect(cleanSenderName('"<BOB@x.com>"', "bob@x.com")).toBeNull();
		expect(cleanSenderName("other@y.com", "bob@x.com")).toBeNull();
	});

	it("strips quotes and control characters", () => {
		expect(cleanSenderName('"Bob \\"The Builder\\""')).toBe('Bob "The Builder"');
		expect(cleanSenderName("Bob\u0000\nSmith")).toBe("Bob Smith");
		expect(cleanSenderName("   ")).toBeNull();
	});
});

describe("senderNameFromRawHeaders", () => {
	it("backfills from a stored inbound header array", () => {
		const raw = JSON.stringify([
			{ key: "subject", value: "Hi" },
			{ key: "from", value: "=?UTF-8?Q?Ren=C3=A9e?= <renee@example.com>" },
		]);
		expect(senderNameFromRawHeaders(raw, "renee@example.com")).toBe("Renée");
	});

	it("backfills the name a sent row recorded", () => {
		const raw = JSON.stringify([{ key: "from", value: "Tapetide tech team <tech@tapetide.com>" }]);
		expect(senderNameFromRawHeaders(raw, "tech@tapetide.com")).toBe("Tapetide tech team");
	});

	it("refuses a From that names a different address than the row", () => {
		const raw = JSON.stringify([{ key: "from", value: "Mallory <m@evil.example>" }]);
		expect(senderNameFromRawHeaders(raw, "alice@example.com")).toBeNull();
	});

	it("never throws on junk", () => {
		expect(senderNameFromRawHeaders("not json", "a@b.c")).toBeNull();
		expect(senderNameFromRawHeaders('{"from":"x"}', "a@b.c")).toBeNull();
		expect(senderNameFromRawHeaders("[null, 1, {}]", "a@b.c")).toBeNull();
	});
});

describe("senderNameFromOutbound", () => {
	it("takes the name from an object or a formatted string", () => {
		expect(senderNameFromOutbound({ email: "t@tapetide.com", name: "Tapetide" })).toBe("Tapetide");
		expect(senderNameFromOutbound("Tapetide <t@tapetide.com>")).toBe("Tapetide");
		expect(senderNameFromOutbound("t@tapetide.com")).toBeNull();
	});
});

describe("senderDisplayName with a stored name", () => {
	it("prefers the stored name, and falls back to humanising", () => {
		expect(senderDisplayName("noreply@github.com", "GitHub Notifications")).toBe(
			"GitHub Notifications",
		);
		expect(senderDisplayName("noreply@github.com", null)).toBe("GitHub");
		expect(senderDisplayName("priya.sharma@x.com", "  ")).toBe("Priya Sharma");
		expect(senderInitials("x9271@x.com", "Ada Lovelace")).toBe("AL");
	});
});
