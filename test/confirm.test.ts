/**
 * app/lib/confirm.ts: the promise side of the confirm dialog. The dialog
 * itself (`ConfirmHost`) is a thin renderer over these requests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONFIRM_EVENT,
	confirmAction,
	isConfirmOpen,
	registerConfirmHost,
	type ConfirmRequest,
} from "~/lib/confirm";

const QUESTION = { title: "Delete the label \"Billing\"?", description: "The messages carrying it are kept.", confirmLabel: "Delete label" };

/** A stand-in for the browser window: events, and the native dialog. */
function fakeWindow() {
	const target = new EventTarget() as EventTarget & { confirm: ReturnType<typeof vi.fn> };
	target.confirm = vi.fn(() => true);
	return target;
}

describe("confirmAction", () => {
	let win: ReturnType<typeof fakeWindow>;
	let requests: ConfirmRequest[];
	let unregister: (() => void) | null;

	beforeEach(() => {
		win = fakeWindow();
		vi.stubGlobal("window", win);
		requests = [];
		win.addEventListener(CONFIRM_EVENT, (e) => requests.push((e as CustomEvent<ConfirmRequest>).detail));
		unregister = null;
	});
	afterEach(() => {
		for (const request of requests) request.resolve(false);
		unregister?.();
		vi.unstubAllGlobals();
	});

	it("answers no on the server, where there is nobody to ask", async () => {
		vi.unstubAllGlobals();
		expect(await confirmAction(QUESTION)).toBe(false);
	});

	it("falls back to the browser's dialog when no host is mounted", async () => {
		expect(await confirmAction(QUESTION)).toBe(true);
		expect(win.confirm).toHaveBeenCalledWith("Delete the label \"Billing\"? The messages carrying it are kept.");
		expect(requests).toHaveLength(0);
		win.confirm.mockReturnValue(false);
		expect(await confirmAction(QUESTION)).toBe(false);
	});

	it("hands the question to the host and resolves to its answer", async () => {
		unregister = registerConfirmHost();
		const yes = confirmAction(QUESTION);
		expect(win.confirm).not.toHaveBeenCalled();
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject(QUESTION);
		expect(isConfirmOpen()).toBe(true);
		requests[0]!.resolve(true);
		expect(await yes).toBe(true);
		expect(isConfirmOpen()).toBe(false);

		const no = confirmAction(QUESTION);
		requests[1]!.resolve(false);
		expect(await no).toBe(false);
	});

	it("counts each question once, however often it is answered", async () => {
		unregister = registerConfirmHost();
		const first = confirmAction(QUESTION);
		const second = confirmAction(QUESTION);
		expect(isConfirmOpen()).toBe(true);
		requests[0]!.resolve(false);
		requests[0]!.resolve(true);
		expect(await first).toBe(false);
		expect(isConfirmOpen()).toBe(true);
		requests[1]!.resolve(true);
		expect(await second).toBe(true);
		expect(isConfirmOpen()).toBe(false);
	});

	it("goes back to the browser's dialog once the host is gone", async () => {
		registerConfirmHost()();
		expect(await confirmAction(QUESTION)).toBe(true);
		expect(win.confirm).toHaveBeenCalledTimes(1);
	});
});
