#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# nemoclaw-telegram-bot — Pack repo + .env, ship to a GCP VM, run Docker OpenClaw
#
# Uses GOOGLE_API_KEY from your environment for Gemini (written as GEMINI_API_KEY
# and GOOGLE_API_KEY in the VM .env). Loads missing vars from login zsh if needed.
#
# Prereqs: gcloud auth, SSH to VM works, project/zone/name below (or env overrides).
#
# Usage:
#   source ~/.zshrc
#   bash scripts/gcp-deploy-from-local.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

GCP_PROJECT_ID="${GCP_PROJECT_ID:-tradetalkapp-492904}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
GCP_VM_NAME="${GCP_VM_NAME:-dreamrise-gcp}"
# Linux user on the VM for ssh/scp. Leave unset to use gcloud default (OS Login name, e.g. silwal_saroj44).
# Stock Ubuntu images without OS Login: export GCP_VM_SSH_USER=ubuntu
GCP_VM_SSH_USER="${GCP_VM_SSH_USER:-}"
REMOTE_DIR="${NEMOCLAW_REMOTE_DIR:-nemoclaw-telegram-bot}"
if [ -n "$GCP_VM_SSH_USER" ]; then
  GCE_TARGET="${GCP_VM_SSH_USER}@${GCP_VM_NAME}"
else
  GCE_TARGET="${GCP_VM_NAME}"
fi

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

if [ -z "${GOOGLE_API_KEY:-}" ]; then
  echo "GOOGLE_API_KEY is not set (Gemini / Google AI). Add to ~/.zshrc and: source ~/.zshrc" >&2
  exit 1
fi
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "TELEGRAM_BOT_TOKEN is not set. Add to ~/.zshrc and: source ~/.zshrc" >&2
  exit 1
fi

if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
  echo ""
  echo "Generated OPENCLAW_GATEWAY_TOKEN for this deploy (save for Control UI login):"
  echo "  ${OPENCLAW_GATEWAY_TOKEN}"
  echo ""
fi

ENV_LOCAL="$(mktemp)"
chmod 600 "$ENV_LOCAL"
{
  echo "OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}"
  echo "GEMINI_API_KEY=${GOOGLE_API_KEY}"
  echo "GOOGLE_API_KEY=${GOOGLE_API_KEY}"
  echo "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}"
} >"$ENV_LOCAL"

echo "→ SSH target: ${GCE_TARGET}  (override with GCP_VM_SSH_USER=ubuntu or your OS Login name)"
echo "→ Syncing repo to ${GCE_TARGET}:~/${REMOTE_DIR}/ (excluding .git)..."
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

gcloud compute scp "$ENV_LOCAL" "${GCE_TARGET}:~/${REMOTE_DIR}/.env" \
  --zone="${GCP_ZONE}" --project="${GCP_PROJECT_ID}" --quiet
rm -f "$ENV_LOCAL"

echo "→ Installing Docker (if needed) and starting OpenClaw..."
REMOTE_B64="$(printf '%s' "$REMOTE_DIR" | base64 | tr -d '\n')"
gcloud compute ssh "${GCE_TARGET}" --zone="${GCP_ZONE}" --project="${GCP_PROJECT_ID}" --command "
set -euo pipefail
RD=\"\$(printf '%s' '$REMOTE_B64' | base64 -d)\"
cd \"\$HOME/\$RD\"
if ! command -v docker >/dev/null 2>&1; then
  echo 'Installing docker.io...'
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 \
    || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-plugin
fi
if ! sudo docker compose version >/dev/null 2>&1; then
  echo 'docker compose is not available. Install docker-compose-v2 on the VM.' >&2
  exit 1
fi
sudo chmod 600 .env 2>/dev/null || true
sudo docker compose -f docker-compose.openclaw.yml build --pull
sudo docker compose -f docker-compose.openclaw.yml up -d
sudo docker compose -f docker-compose.openclaw.yml ps
echo ''
echo 'OpenClaw listens on VM loopback :8080. From your Mac:'
echo \"  gcloud compute ssh ${GCE_TARGET} --zone=${GCP_ZONE} --project=${GCP_PROJECT_ID} -- -L 8080:127.0.0.1:8080\"
echo 'Then open http://127.0.0.1:8080/ and sign in with OPENCLAW_GATEWAY_TOKEN (printed on your Mac if generated).'
"

echo ""
echo "Done."
