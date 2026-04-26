#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# nemoclaw-telegram-bot — Build and smoke-test the OpenClaw image in isolation
#
# Local policy (no access to your Mac files or apps beyond Docker):
#   • No bind mounts from the host — only Docker named volumes + tmpfs for /tmp
#   • Container root filesystem read-only (writable paths are Docker volumes only)
#   • Gateway bound inside the container; published only to 127.0.0.1 on the host
#   • Secrets must be passed in the current shell environment (not read from ~/.zshrc)
#
# Required env: GOOGLE_API_KEY, TELEGRAM_BOT_TOKEN
# Optional: OPENCLAW_GATEWAY_TOKEN (defaults to a random hex string for this run)
#
# Optional push (after a successful test):
#   PUSH_IMAGE=1 DOCKER_PUSH_TARGET=ghcr.io/ORG/nemoclaw-openclaw:TAG bash scripts/docker-test-restricted.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LOCAL_TAG="${LOCAL_TAG:-nemoclaw-openclaw:local-test}"
HOST_PORT="${HOST_PORT:-18080}"
CID=""
VOL_ST=""
VOL_WS=""

cleanup() {
  if [ -n "${CID}" ]; then
    docker rm -f "${CID}" >/dev/null 2>&1 || true
  fi
  if [ -n "${VOL_ST}" ]; then
    docker volume rm -f "${VOL_ST}" >/dev/null 2>&1 || true
  fi
  if [ -n "${VOL_WS}" ]; then
    docker volume rm -f "${VOL_WS}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found in PATH." >&2
  exit 1
fi

if [ -z "${GOOGLE_API_KEY:-}" ] || [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "Set GOOGLE_API_KEY and TELEGRAM_BOT_TOKEN in this shell (this script does not read ~/.zshrc or any .env file)." >&2
  exit 1
fi

if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 24)"
  echo "Using ephemeral OPENCLAW_GATEWAY_TOKEN for this test (not saved)."
fi

SUF="$(openssl rand -hex 4)"
VOL_ST="nemoclaw-test-state-${SUF}"
VOL_WS="nemoclaw-test-ws-${SUF}"
docker volume create "${VOL_ST}" >/dev/null
docker volume create "${VOL_WS}" >/dev/null

echo "→ Building ${LOCAL_TAG} (no cache mount from host beyond build context)..."
docker build -t "${LOCAL_TAG}" .

READONLY_ARGS=(--read-only)
if [ "${DOCKER_READ_ONLY_ROOT:-1}" = "0" ]; then
  READONLY_ARGS=()
fi

echo "→ Starting isolated container (no host bind mounts; root read-only unless DOCKER_READ_ONLY_ROOT=0)..."
CID="$(
  docker run -d \
    "${READONLY_ARGS[@]}" \
    --security-opt=no-new-privileges \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    -v "${VOL_ST}:/home/node/.openclaw" \
    -v "${VOL_WS}:/home/node/workspace" \
    -p "127.0.0.1:${HOST_PORT}:8080" \
    -e "OPENCLAW_GATEWAY_PORT=8080" \
    -e "OPENCLAW_STATE_DIR=/home/node/.openclaw" \
    -e "OPENCLAW_WORKSPACE_DIR=/home/node/workspace" \
    -e "OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}" \
    -e "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}" \
    -e "GEMINI_API_KEY=${GOOGLE_API_KEY}" \
    -e "GOOGLE_API_KEY=${GOOGLE_API_KEY}" \
    "${LOCAL_TAG}"
)"

echo "   container=${CID}"
echo "→ Waiting for /healthz (up to 120s)..."
ok=0
for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null; then
    ok=1
    break
  fi
  sleep 3
done

if [ "$ok" != 1 ]; then
  echo "❌ healthz failed. Last logs:" >&2
  docker logs "${CID}" 2>&1 | tail -60 >&2
  exit 1
fi

echo "✅ healthz OK at http://127.0.0.1:${HOST_PORT}/healthz"
echo "   Control UI uses OPENCLAW_GATEWAY_TOKEN from this test (see above if ephemeral)."

if [ "${PUSH_IMAGE:-0}" = "1" ]; then
  if [ -z "${DOCKER_PUSH_TARGET:-}" ]; then
    echo "PUSH_IMAGE=1 requires DOCKER_PUSH_TARGET, e.g. ghcr.io/myorg/nemoclaw-openclaw:v1" >&2
    exit 1
  fi
  echo "→ Tagging and pushing to ${DOCKER_PUSH_TARGET}..."
  docker tag "${LOCAL_TAG}" "${DOCKER_PUSH_TARGET}"
  docker push "${DOCKER_PUSH_TARGET}"
  echo "✅ Pushed ${DOCKER_PUSH_TARGET}"
fi

echo "→ Stopping test container and removing test volumes..."
# trap cleanup will run
