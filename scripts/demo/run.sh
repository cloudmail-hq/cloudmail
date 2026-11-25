#!/usr/bin/env bash
# Builds a fresh local demo instance and screenshots it. Run from the repo root
# after `npm ci` (and `npm i --no-save playwright-core`):
#
#   scripts/demo/run.sh dev              # seed once, then serve (no Playwright); `npm run dev:demo`
#   scripts/demo/run.sh reset            # throw the seeded state away
#   scripts/demo/run.sh all  [out-dir]   # reset, seed, capture everything
#   scripts/demo/run.sh serve            # dev server on the seeded state (foreground)
#   scripts/demo/run.sh capture [out-dir] [--only a,b]
#   scripts/demo/run.sh stop
#
# Everything runs against .wrangler/demo-state; nothing leaves this machine.
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT=5173
LOG=${DEMO_LOG:-/tmp/cloudmail-demo-dev.log}
CONFIG=scripts/demo/vite.demo.config.ts
OUT=${2:-launch-shots}
# Written when both seed phases have finished, so a half-seeded state is redone.
SEEDED=.wrangler/demo-state/.seeded

stop() {
	pkill -f "vite dev --config $CONFIG" 2>/dev/null || true
	for _ in $(seq 1 30); do
		pgrep -f "vite dev --config $CONFIG" >/dev/null || return 0
		sleep 1
	done
	pkill -9 -f "vite dev --config $CONFIG" 2>/dev/null || true
}

start() {
	nohup npx vite dev --config "$CONFIG" --host 127.0.0.1 --port "$PORT" --strictPort >"$LOG" 2>&1 &
	for _ in $(seq 1 90); do
		if curl -fsS -m 30 "http://127.0.0.1:$PORT/api/auth/state" >/dev/null 2>&1; then
			# Warm the client bundle so the first capture doesn't hit a dep re-optimise reload.
			curl -fsS -m 120 "http://127.0.0.1:$PORT/login" >/dev/null 2>&1 || true
			return 0
		fi
		sleep 2
	done
	echo "dev server did not start; see $LOG" >&2
	exit 1
}

case "${1:-all}" in
all)
	stop
	rm -rf .wrangler/demo-state scripts/demo/.generated/seed-manifest.json
	start
	node scripts/demo/capture.mjs --phase pre --out "$OUT"
	node scripts/demo/seed-demo.mjs api
	stop
	node scripts/demo/seed-demo.mjs db
	start
	node scripts/demo/capture.mjs --out "$OUT"
	stop
	;;
seed)
	stop
	rm -rf .wrangler/demo-state scripts/demo/.generated/seed-manifest.json
	start
	node scripts/demo/capture.mjs --phase pre --out "$OUT"
	node scripts/demo/seed-demo.mjs api
	stop
	node scripts/demo/seed-demo.mjs db
	;;
dev)
	# For working on the app: needs no Cloudflare login, no licence key and no
	# browser automation. Seeds on the first run, then serves in the foreground.
	stop
	if [ ! -f "$SEEDED" ]; then
		echo "Seeding the demo instance (first run, about a minute)..."
		rm -rf .wrangler/demo-state scripts/demo/.generated/seed-manifest.json
		# The seed runs against a background server: don't leave it behind on Ctrl-C.
		trap 'stop; exit 130' INT TERM
		start
		node scripts/demo/seed-demo.mjs api >"$LOG.seed" 2>&1 || { tail -20 "$LOG.seed" >&2; stop; exit 1; }
		stop
		node scripts/demo/seed-demo.mjs db >>"$LOG.seed" 2>&1 || { tail -20 "$LOG.seed" >&2; exit 1; }
		trap - INT TERM
		touch "$SEEDED"
	fi
	node --input-type=module -e 'import { DEMO_OWNER as o, DEMO_BASE_URL as u } from "./scripts/demo/demo-constants.mjs"; console.log(`\nDemo instance: ${u}\nSign in as ${o.email} with the password ${o.password}\n`)'
	exec npx vite dev --config "$CONFIG" --host 127.0.0.1 --port "$PORT" --strictPort
	;;
reset)
	stop
	rm -rf .wrangler/demo-state scripts/demo/.generated/seed-manifest.json
	;;
serve) exec npx vite dev --config "$CONFIG" --host 127.0.0.1 --port "$PORT" --strictPort ;; # foreground
capture) shift; node scripts/demo/capture.mjs --out "${1:-launch-shots}" "${@:2}" ;;
stop) stop ;;
*) echo "usage: $0 dev|reset|all|seed|serve|capture|stop" >&2; exit 2 ;;
esac
