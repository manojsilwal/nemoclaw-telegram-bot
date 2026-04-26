#!/bin/sh
set -e

STATE="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
WS="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
DST="$STATE/openclaw.json"

# Docker named volumes are often root-owned; ensure node can write state/workspace.
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$STATE" "$WS"
  chown -R node:node "$STATE" "$WS" || true
fi

mkdir -p "$STATE" "$WS"

if [ ! -f "$DST" ]; then
  SEED_JS=/tmp/openclaw-seed-once.cjs
  cat >"$SEED_JS" <<'NODE'
const fs = require('fs');
const path = require('path');
const state = process.env.OPENCLAW_STATE_DIR || '/home/node/.openclaw';
const dst = path.join(state, 'openclaw.json');
if (fs.existsSync(dst)) process.exit(0);
const seed = JSON.parse(fs.readFileSync('/opt/openclaw/openclaw.json', 'utf8'));
const gt = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const tg = process.env.TELEGRAM_BOT_TOKEN || '';
if (!gt || !tg) {
  console.error('OPENCLAW_GATEWAY_TOKEN and TELEGRAM_BOT_TOKEN must be set (e.g. in .env).');
  process.exit(1);
}
seed.gateway = seed.gateway || {};
seed.gateway.auth = seed.gateway.auth || {};
seed.gateway.auth.token = gt;
seed.channels = seed.channels || {};
seed.channels.telegram = seed.channels.telegram || {};
seed.channels.telegram.botToken = tg;
fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(dst, JSON.stringify(seed, null, 2) + '\n');
NODE
  if command -v gosu >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
    gosu node node "$SEED_JS"
  else
    node "$SEED_JS"
  fi
  rm -f "$SEED_JS" 2>/dev/null || true
fi

if command -v gosu >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
  exec gosu node "$@"
fi
exec "$@"
