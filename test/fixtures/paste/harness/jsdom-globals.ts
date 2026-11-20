/**
 * Installs jsdom's DOM as globals, for a test that stays in vitest's node
 * environment. The `jsdom` environment switches module resolution to web
 * mode, where the bare `shared/...` import in signature-node.ts stops
 * resolving. Import this module before anything that touches the DOM.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const win = dom.window as unknown as Record<string, unknown>;
const g = globalThis as Record<string, unknown>;

for (const key of [
	"window", "document", "Node", "Element", "HTMLElement", "Text", "Range", "Selection",
	"DocumentFragment", "DOMParser", "MutationObserver", "Event", "KeyboardEvent",
	"MouseEvent", "InputEvent", "ClipboardEvent", "getComputedStyle", "getSelection",
	"requestAnimationFrame", "cancelAnimationFrame",
]) {
	const value = win[key];
	if (value === undefined) continue;
	Object.defineProperty(g, key, {
		value: typeof value === "function" && /^[a-z]/.test(key) ? value.bind(dom.window) : value,
		configurable: true,
		writable: true,
	});
}
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });

// jsdom has no layout. ProseMirror asks for rects when it scrolls the
// selection into view after a paste.
const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} });
const R = dom.window.Range.prototype as unknown as Record<string, unknown>;
R.getBoundingClientRect = rect;
R.getClientRects = () => Object.assign([rect()], { item: () => rect() });
(dom.window.Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};
dom.window.document.elementFromPoint = () => null;
