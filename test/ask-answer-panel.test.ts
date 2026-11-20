// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The "Ask my inbox" answer panel renders citations as deep links built from
 * ids, and never renders model text as HTML.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import AskAnswerPanel, { askQueryKey } from "~/components/mail/AskAnswerPanel";
import type { AskInboxResponse } from "~/services/api";

function render(question: string, data?: AskInboxResponse) {
	const client = new QueryClient();
	if (data) client.setQueryData(askQueryKey(question, "*"), data);
	return renderToStaticMarkup(
		h(MemoryRouter, null, h(QueryClientProvider, { client }, h(AskAnswerPanel, { question, onDismiss: () => {} }))),
	);
}

const base: AskInboxResponse = {
	question: "when is my flight",
	answer: "You fly on 3 November [1]. <img src=x onerror=alert(1)>",
	insufficient: false,
	semantic: true,
	citations: [
		{
			n: 1,
			mailbox: "me@x.com",
			email_id: "e1",
			thread_id: "t1",
			folder: "inbox",
			subject: "Booking confirmed",
			from: "Acme <a@acme.com>",
			date: "2026-10-01",
			href: "/mail/me%40x.com/inbox?m=e1",
		},
	],
	sources: [],
	mailboxes: ["me@x.com"],
};

describe("AskAnswerPanel", () => {
	it("links each citation to the message with ?m=", () => {
		const html = render("when is my flight", base);
		expect(html).toContain('href="/mail/me%40x.com/inbox?m=e1"');
		expect(html).toContain("Booking confirmed");
		expect(html).toContain('aria-label="Source 1: Booking confirmed"');
	});

	it("escapes answer text rather than rendering it as HTML", () => {
		const html = render("when is my flight", base);
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});

	it("shows the insufficient-evidence message with no sources", () => {
		const html = render("what is the contract value", {
			...base,
			answer: "I couldn't find enough in your mail to answer that.",
			insufficient: true,
			citations: [],
		});
		expect(html).toContain("couldn&#x27;t find enough");
		expect(html).not.toContain('aria-label="Sources"');
	});

	it("shows a loading state before the answer arrives, and nothing for an empty question", () => {
		expect(render("when is my flight")).toContain("Reading your mail");
		expect(render("   ")).toBe("");
	});
});
