/**
 * Measure the app chrome on the current page: run in the browser console (or
 * evaluate from any browser driver) on each route, at each width and theme,
 * and compare the results. The top bar (with its section links) and tab bar should report the
 * same boxes and the same control list everywhere; only `active` differs.
 *
 * `test/app-shell.test.ts` checks the same thing on rendered markup. This is
 * the real-layout version, used for the numbers in the PR.
 */
(() => {
	const visible = (el) => {
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
	};
	const box = (el) => {
		if (!el || !visible(el)) return null;
		const r = el.getBoundingClientRect();
		return [r.x, r.y, r.width, r.height].map(Math.round).join(",");
	};
	const name = (el) =>
		(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.textContent || "")
			.trim()
			.replace(/\s+/g, " ")
			.replace(/\d+\+?/g, "#");
	const controls = (root) =>
		root ? [...root.querySelectorAll("a,button,input")].filter(visible).map((el) => `${el.tagName.toLowerCase()}:${name(el)}`) : [];
	const bar = document.querySelector("[data-app-topbar]");
	const sections = document.querySelector("[data-app-sections]");
	const tabbar = document.querySelector("[data-app-tabbar]");
	const current = document.querySelector("[data-app-sections] [aria-current=page], [data-app-tabbar] [aria-current=page]");
	return {
		path: location.pathname,
		viewport: `${innerWidth}x${innerHeight}`,
		theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
		topbar: box(bar),
		topbarControls: controls(bar),
		sections: box(sections),
		sectionItems: controls(sections),
		tabbar: box(tabbar),
		tabItems: controls(tabbar),
		modulePane: box([...document.querySelectorAll("[data-module-pane]")].find(visible)),
		moduleBar: box([...document.querySelectorAll("[data-module-bar]")].find(visible)),
		active: current ? name(current) : null,
	};
})();
