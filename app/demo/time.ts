/**
 * Dates in the demo data are stored as offsets from the moment the snapshot
 * was taken (scripts/demo-site/snapshot.mjs), and turned back into dates
 * relative to the moment the page loads. The newest mail is always a few
 * minutes old, whenever the demo is opened.
 *
 *   {$t: ms}  ISO timestamp           {$ms: ms}  epoch milliseconds
 *   {$s: s}   epoch seconds           {$d: days} calendar day, YYYY-MM-DD (UTC)
 *   {$q: ms}  "YYYY-MM-DD HH:MM:SS" (UTC), the form SQLite writes
 */
export function revive<T>(value: unknown, now: number): T {
	return walk(value, now) as T;
}

function walk(value: unknown, now: number): unknown {
	if (Array.isArray(value)) return value.map((v) => walk(v, now));
	if (!value || typeof value !== "object") return value;
	const o = value as Record<string, unknown>;
	const keys = Object.keys(o);
	if (keys.length === 1 && typeof o[keys[0]] === "number") {
		const n = o[keys[0]] as number;
		switch (keys[0]) {
			case "$t":
				return new Date(now + n).toISOString();
			case "$ms":
				return now + n;
			case "$s":
				return Math.round(now / 1000) + n;
			case "$d":
				return new Date(now + n * 86_400_000).toISOString().slice(0, 10);
			case "$q":
				return new Date(now + n).toISOString().replace("T", " ").slice(0, 19);
		}
	}
	const out: Record<string, unknown> = {};
	for (const k of keys) out[k] = walk(o[k], now);
	return out;
}
