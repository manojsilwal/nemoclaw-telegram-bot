#!/bin/sh
set -e

STATE="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
WS="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"

mkdir -p "$STATE" "$WS"

if [ -f /opt/openclaw/openclaw.json ] && [ ! -f "$STATE/openclaw.json" ]; then
  cp /opt/openclaw/openclaw.json "$STATE/openclaw.json"
fi

exec "$@"
