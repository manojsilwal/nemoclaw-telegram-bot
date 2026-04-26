#!/usr/bin/env bash
# =============================================================================
# gcp-setup.sh — One-shot bootstrap for OpenClaw + Paperclip on a GCP Debian 12 VM
# Run as the default (non-root) user after SSH-ing in:
#   gcloud compute ssh openclaw-gateway --zone=us-central1-a
#   bash <(curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/nemoclaw-telegram-bot/main/scripts/gcp-setup.sh)
# =============================================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/YOUR_ORG/nemoclaw-telegram-bot.git}"
DREAMRISE_URL="${DREAMRISE_URL:-https://github.com/YOUR_ORG/DreamRise.git}"
REPO_DIR="${HOME}/nemoclaw-telegram-bot"
DREAMRISE_DIR="${HOME}/DreamRise"
ZONE="${ZONE:-us-central1-a}"

step() { echo -e "\n\033[1;36m▶ $*\033[0m"; }
ok()   { echo -e "\033[1;32m✔ $*\033[0m"; }
warn() { echo -e "\033[1;33m⚠ $*\033[0m"; }

# ---------------------------------------------------------------------------
step "1/6 System update"
sudo apt-get update -qq && sudo apt-get upgrade -y -qq
sudo apt-get install -y -qq curl git ca-certificates gnupg lsb-release
ok "System updated"

# ---------------------------------------------------------------------------
step "2/6 Docker install"
if ! command -v docker &>/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/debian \
    $(lsb_release -cs) stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo usermod -aG docker "$USER"
  ok "Docker installed"
else
  ok "Docker already present — skipping"
fi



step "4/7 Validate OpenClaw repo"
if [ ! -d "$REPO_DIR" ]; then
  warn "Error: $REPO_DIR not found. SCP the tarball first!"
  exit 1
fi
cd "$REPO_DIR"
ok "OpenClaw repo ready at $REPO_DIR"

# ---------------------------------------------------------------------------
step "5/7 Validate DreamRise repo"
if [ ! -d "$DREAMRISE_DIR" ]; then
  warn "Error: $DREAMRISE_DIR not found. SCP the tarball first!"
  exit 1
fi
ok "DreamRise repo ready at $DREAMRISE_DIR"

# ---------------------------------------------------------------------------
step "6/7 Configure secrets"
cd "$REPO_DIR"
if [ ! -f .env ]; then
  cp .env.example .env

  # Auto-generate one-time secrets
  GATEWAY_TOKEN=$(openssl rand -hex 32)
  AUTH_SECRET=$(openssl rand -hex 32)
  sed -i "s|^OPENCLAW_GATEWAY_TOKEN=.*|OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}|" .env
  sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=${AUTH_SECRET}|" .env

  # Point compose at the cloned DreamRise paperclip source
  echo "" >> .env
  echo "PAPERCLIP_SOURCE_DIR=${DREAMRISE_DIR}/paperclip" >> .env

  echo ""
  warn "Fill in the remaining secrets in .env:"
  warn "  nano $REPO_DIR/.env"
  warn ""
  warn "Required:"
  warn "  GEMINI_API_KEY          — from Google AI Studio"
  warn "  TELEGRAM_BOT_TOKEN      — from @BotFather"
  warn ""
  warn "Pre-filled:"
  warn "  OPENCLAW_GATEWAY_TOKEN  ✔ (auto-generated)"
  warn "  BETTER_AUTH_SECRET      ✔ (auto-generated)"
  warn "  PAPERCLIP_COMPANY_ID    ✔ DreamRise"
  warn "  PAPERCLIP_CEO_AGENT_ID  ✔ DreamRise Chief"
  echo ""
  warn "NOTE: Please review $REPO_DIR/.env on the VM to insert your GEMINI_API_KEY and TELEGRAM_BOT_TOKEN later."
  echo ""
else
  ok ".env already exists — skipping"
fi

# ---------------------------------------------------------------------------
step "7/7 Start services"
# Docker group membership requires a new shell; use sg to avoid needing logout
sg docker -c "docker compose up -d --build"

echo ""
ok "All services started."
echo ""
echo "  OpenClaw UI  → http://localhost:8080  (or http://$(tailscale ip -4 2>/dev/null || echo '<tailscale-ip>'):8080)"
echo "  Paperclip UI → http://localhost:3100  (or http://$(tailscale ip -4 2>/dev/null || echo '<tailscale-ip>'):3100)"
echo ""
echo "SSH tunnel from your laptop:"
echo "  gcloud compute ssh openclaw-gateway --zone=${ZONE} -- \\"
echo "    -L 8080:127.0.0.1:8080 -L 3100:127.0.0.1:3100"
echo ""
echo "Watch logs:"
echo "  docker compose logs -f"
