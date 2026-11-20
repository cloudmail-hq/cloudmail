import { describe, expect, it } from "vitest";
import { CF_TOKEN_PERMISSION_GROUPS, cfTokenTemplateUrl } from "../shared/cf-token-template";

function keysOf(url: string): { key: string; type: string }[] {
	const raw = new URL(url).searchParams.get("permissionGroupKeys");
	return JSON.parse(raw!);
}

describe("cfTokenTemplateUrl", () => {
	it("builds the account-token dashboard link with every permission group", () => {
		const url = cfTokenTemplateUrl();
		expect(url.startsWith("https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=")).toBe(true);
		expect(new URL(url).searchParams.get("name")).toBe("cloudmail");
		const keys = keysOf(url);
		expect(keys).toHaveLength(12);
		expect(keys).toContainEqual({ key: "c8fed203ed3043cba015a93ad1616f1f", type: "read" }); // Zone Read
		expect(keys).toContainEqual({ key: "4755a26eedb94da69e1066d98aa820be", type: "edit" }); // DNS Write
		expect(keys).toContainEqual({ key: "5df633d6b41c42bcaf5b4a62b9d14b64", type: "edit" }); // Email Sending Write
		expect(keys).toContainEqual({ key: "c1fde68c7bcc44588cbb6ddbc16d6480", type: "read" }); // Account Settings Read
	});

	it("maps Write groups to edit and Read groups to read", () => {
		for (const g of CF_TOKEN_PERMISSION_GROUPS) {
			expect(g.type).toBe(g.name.endsWith("Write") ? "edit" : "read");
			expect(g.id).toMatch(/^[a-f0-9]{32}$/);
		}
		expect(new Set(CF_TOKEN_PERMISSION_GROUPS.map((g) => g.id)).size).toBe(CF_TOKEN_PERMISSION_GROUPS.length);
	});

	it("URL-encodes the JSON and the name", () => {
		const url = cfTokenTemplateUrl({ name: "My mail & co" });
		expect(url).not.toContain("[{");
		expect(url).toContain("%5B%7B%22key%22");
		expect(url.endsWith("&name=My%20mail%20%26%20co")).toBe(true);
	});

	it("uses a valid account id and ignores anything else", () => {
		const id = "0123456789abcdef0123456789abcdef";
		expect(cfTokenTemplateUrl({ accountId: id })).toContain(`?to=/${id}/api-tokens`);
		expect(cfTokenTemplateUrl({ accountId: "../evil" })).toContain("?to=/:account/api-tokens");
	});
});
