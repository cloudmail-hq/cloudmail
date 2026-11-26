/**
 * The demo's state: the mail in memory, the files made from it, and the
 * backend that answers the app. Built once per page load from the recorded
 * snapshot, so a reload starts over. No browser APIs here, so tests use it too.
 */

import { seedAgentDraft, seedSummaries } from "./ai";
import { DemoBackend } from "./backend";
import { DemoFiles } from "./files";
import { type DemoSnapshot, DemoStore } from "./store";

export interface DemoRuntime {
	store: DemoStore;
	files: DemoFiles;
	backend: DemoBackend;
}

export function createDemo(snapshot: DemoSnapshot, opts: { clock?: () => number; timeZone?: string } = {}): DemoRuntime {
	const store = new DemoStore(snapshot, opts.clock);
	seedSummaries(store);
	seedAgentDraft(store);
	const files = new DemoFiles();
	return { store, files, backend: new DemoBackend(store, files, opts.timeZone) };
}
