#!/usr/bin/env bash
# Builds a fresh local demo instance and screenshots it. Run from the repo root
# after `npm ci` (and `npm i --no-save playwright-core`):
#
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
serve) exec npx vite dev --config "$CONFIG" --host 127.0.0.1 --port "$PORT" --strictPort ;; # foreground
capture) shift; node scripts/demo/capture.mjs --out "${1:-launch-shots}" "${@:2}" ;;
stop) stop ;;
*) echo "usage: $0 all|seed|serve|capture|stop" >&2; exit 2 ;;
esac
