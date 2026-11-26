/**
 * Browser entry. The same as React Router's default, except that the public
 * demo build (`--mode demo`, see scripts/demo-site) starts its in-page backend
 * before the app renders. In every other build `DEMO` is the constant `false`
 * and the demo code is not in the bundle.
 */

import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { DEMO } from "~/demo/flag";

function hydrate() {
	startTransition(() => {
		hydrateRoot(
			document,
			<StrictMode>
				<HydratedRouter />
			</StrictMode>,
		);
	});
}

if (DEMO) {
	void import("~/demo/install").then((m) => m.installDemo()).then(hydrate);
} else {
	hydrate();
}
