#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# nemoclaw-telegram-bot — Deploy OpenClaw + Paperclip + Postgres to GCP (full stack)
#
# Syncs this repo + DreamRise/paperclip (build context), writes .env, runs:
#   docker compose up -d --build
#
# Expect a long first build on the VM (Paperclip pnpm). e2-micro may OOM — use e2-small if needed.
#
# Usage:
#   source ~/.zshrc
#   bash scripts/gcp-deploy-with-paperclip.sh
#
# Optional:
#   PAPERCLIP_ROOT=/path/to/DreamRise/paperclip   (default: ../DreamRise/paperclip from this repo)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

GCP_PROJECT_ID="${GCP_PROJECT_ID:-tradetalkapp-492904}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
GCP_VM_NAME="${GCP_VM_NAME:-dreamrise-gcp}"
GCP_VM_SSH_USER="${GCP_VM_SSH_USER:-}"
if [ -n "$GCP_VM_SSH_USER" ]; then
  GCE_TARGET="${GCP_VM_SSH_USER}@${GCP_VM_NAME}"
else
  GCE_TARGET="${GCP_VM_NAME}"
fi
REMOTE_DIR="${NEMOCLAW_REMOTE_DIR:-nemoclaw-telegram-bot}"
PAPERCLIP_REMOTE_NAME="${PAPERCLIP_REMOTE_NAME:-DreamRise-paperclip-src}"
DEFAULT_PC="$(cd "${REPO_ROOT}/../DreamRise/paperclip" 2>/dev/null && pwd || true)"
PAPERCLIP_ROOT="${PAPERCLIP_ROOT:-${DEFAULT_PC}}"

load_from_zsh() {
  command -v zsh >/dev/null 2>&1 || return 0
  if [ -z "${GOOGLE_API_KEY:-}" ]; then
    GOOGLE_API_KEY="$(zsh -lic 'echo -n "${GOOGLE_API_KEY:-}"' 2>/dev/null || true)"
  fi
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    TELEGRAM_BOT_TOKEN="$(zsh -lic 'echo -n "${TELEGRAM_BOT_TOKEN:-}"' 2>/dev/null || true)"
  fi
  if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    OPENCLAW_GATEWAY_TOKEN="$(zsh -lic 'echo -n "${OPENCLAW_GATEWAY_TOKEN:-}"' 2>/dev/null || true)"
  fi
}

load_from_zsh

if [ -z "${GOOGLE_API_KEY:-}" ] || [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "Set GOOGLE_API_KEY and TELEGRAM_BOT_TOKEN (e.g. source ~/.zshrc)." >&2
  exit 1
fi
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
  echo "Generated OPENCLAW_GATEWAY_TOKEN (save for Control UI): ${OPENCLAW_GATEWAY_TOKEN}"
fi
if [ ! -d "${PAPERCLIP_ROOT}" ]; then
  echo "Paperclip source not found at: ${PAPERCLIP_ROOT}" >&2
  echo "Set PAPERCLIP_ROOT to your DreamRise/paperclip checkout." >&2
  exit 1
fi

if [ -z "${BETTER_AUTH_SECRET:-}" ]; then
  BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
  echo "Generated BETTER_AUTH_SECRET for Paperclip (persist in a password manager if you need stable sessions)."
fi

ENV_LOCAL="$(mktemp)"
chmod 600 "$ENV_LOCAL"
{
  echo "OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}"
  echo "GEMINI_API_KEY=${GOOGLE_API_KEY}"
  echo "GOOGLE_API_KEY=${GOOGLE_API_KEY}"
  echo "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}"
  echo "BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}"
} >"$ENV_LOCAL"

echo "→ Syncing nemoclaw repo to ${GCE_TARGET}:~/${REMOTE_DIR}/ ..."
gcloud compute ssh "${GCE_TARGET}" --zone="${GCP_ZONE}" --project="${GCP_PROJECT_ID}" \
  --command "rm -rf ~/'${REMOTE_DIR}' && mkdir -p ~/'${REMOTE_DIR}'"

export COPYFILE_DISABLE=1
tar -C "${REPO_ROOT}" -czf - \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='.env.*' \
  . | gcloud compute ssh "${GCE_TARGET}" --zone="${GCP_ZONE}" --project="${GCP_PROJECT_ID}" \
  --command "tar xzf - -C ~/'${REMOTE_DIR}'"

echo "→ Syncing Paperclip source to ~/${PAPERCLIP_REMOTE_NAME}/ ..."
gcloud compute ssh "${GCE_TARGET}" --zone="${GCP_ZONE}" --project="${GCP_PROJECT_ID}" \
  --command "rm -rf ~/'${PAPERCLIP_REMOTE_NAME}' && mkdir -p ~/'${PAPERCLIP_REMOTE_NAME}'"

tar -C "${PAPERCLIP_ROOT}" -czf - \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.pnpm-store' \
  . | gcloud compute ssh "${GCE_TARGET}" --zone="${GCP_ZONE}" --project="${GCP_PROJECT_ID}" \
  --command "tar xzf - -C ~/'${PAPERCLIP_REMOTE_NAME}'"

gcloud compute scp "$ENV_LOCAL" "${GCE_TARGET}:~/${REMOTE_DIR}/.env" \
  --zone="${GCP_ZONE}" --project="${GCP_PROJECT_ID}" --quiet
rm -f "$ENV_LOCAL"

RD_B64="$(printf '%s' "$REMOTE_DIR" | base64 | tr -d '\n')"
PC_B64="$(printf '%s' "$PAPERCLIP_REMOTE_NAME" | base64 | tr -d '\n')"

echo "→ Docker: stop single-service stack if present; build full compose (long run)..."
gcloud compute ssh "${GCE_TARGET}" --zone="${GCP_ZONE}" --project="${GCP_PROJECT_ID}" --command "
set -euo pipefail
RD=\"\$(printf '%s' '$RD_B64' | base64 -d)\"
PC=\"\$(printf '%s' '$PC_B64' | base64 -d)\"
cd \"\$HOME/\$RD\"
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 \
    || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-plugin
fi
if ! sudo docker compose version >/dev/null 2>&1; then
  echo 'docker compose missing' >&2
  exit 1
fi
sudo docker compose -f docker-compose.openclaw.yml down 2>/dev/null || true
export PAPERCLIP_SOURCE_DIR=\"\$HOME/\$PC\"
sudo chmod 600 .env 2>/dev/null || true
echo \"PAPERCLIP_SOURCE_DIR=\$PAPERCLIP_SOURCE_DIR\"
sudo docker compose build --pull
sudo docker compose up -d
sudo docker compose ps
echo ''
echo 'Tunnels from Mac:'
echo \"  gcloud compute ssh ${GCE_TARGET} --zone=${GCP_ZONE} --project=${GCP_PROJECT_ID} -- -L 8080:127.0.0.1:8080 -L 3100:127.0.0.1:3100\"
echo '  OpenClaw: http://127.0.0.1:8080/   Paperclip: http://127.0.0.1:3100/'
"

echo ""
echo "Done. Paperclip first boot may take several minutes — watch: sudo docker compose logs -f paperclip"
