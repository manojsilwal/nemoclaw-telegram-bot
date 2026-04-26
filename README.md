# OpenClaw + Gemini (Telegram)

This repository deploys [OpenClaw](https://openclaw.ai) on [Render](https://render.com) with **Google Gemini** as the default model, **Telegram** as a channel, and **Chromium** pre-installed for the bundled [browser tool](https://docs.openclaw.ai/tools/browser).

The previous Nemoclaw stack (FastAPI webhook → Hugging Face Gradio) has been removed in favor of OpenClaw’s gateway, which owns Telegram, tools, and sessions.

## Local isolated Docker test (then push)

[`scripts/docker-test-restricted.sh`](scripts/docker-test-restricted.sh) builds the image and runs a **short smoke test** with tight Docker-only isolation:

- **No bind mounts** from your machine — only Docker **named volumes** (for OpenClaw state/workspace) plus a **`tmpfs`** for `/tmp`
- **Read-only container root** by default (set `DOCKER_READ_ONLY_ROOT=0` if the gateway fails to start)
- **`no-new-privileges`**, port **`127.0.0.1:18080`** only
- Secrets come **only** from the **current shell** (the script does **not** read `~/.zshrc` or `.env`)

```bash
cd /path/to/nemoclaw-telegram-bot
export GOOGLE_API_KEY="..." TELEGRAM_BOT_TOKEN="..."
# optional: export OPENCLAW_GATEWAY_TOKEN="..."
bash scripts/docker-test-restricted.sh
```

**Push the image** after a green test (`docker login` to your registry first):

```bash
export GOOGLE_API_KEY="..." TELEGRAM_BOT_TOKEN="..."
PUSH_IMAGE=1 DOCKER_PUSH_TARGET=ghcr.io/YOUR_ORG/nemoclaw-openclaw:v1 \
  bash scripts/docker-test-restricted.sh
```

Outbound network from the container is still allowed so **Gemini** and **Telegram** APIs can be reached during the test; nothing outside Docker is mounted into the container.

### Telegram smoke test (local Docker)

After `docker compose -f docker-compose.openclaw.yml up -d` and `healthz` is **200**:

1. In Telegram, open your bot (from @BotFather) and send **any message**.
2. List pairing codes:  
   `docker compose -f docker-compose.openclaw.yml exec openclaw openclaw pairing list telegram`
3. Approve:  
   `docker compose -f docker-compose.openclaw.yml exec openclaw openclaw pairing approve telegram <CODE>`

### OpenClaw + Paperclip on GCP

After OpenClaw-only is healthy on the VM, deploy **Postgres + Paperclip + OpenClaw** (long build; prefer **e2-small** if the VM runs out of memory):

```bash
source ~/.zshrc
bash scripts/gcp-deploy-with-paperclip.sh
```

This uploads **DreamRise/paperclip** (default `../DreamRise/paperclip` relative to this repo) and runs the root [`docker-compose.yml`](docker-compose.yml).

## Deploy

### GCP (Compute Engine + Docker)

Use this when you want **OpenClaw + Telegram + Gemini** on a small VM, with **`GOOGLE_API_KEY` from your Mac `~/.zshrc`** (same key is written to the VM as **`GEMINI_API_KEY`** and **`GOOGLE_API_KEY`**).

1. **SSH to the VM works** (`gcloud compute ssh …`; firewall / IAP as needed).
2. On your Mac, from this repo:

   ```bash
   source ~/.zshrc   # GOOGLE_API_KEY, TELEGRAM_BOT_TOKEN
   bash scripts/gcp-deploy-from-local.sh
   ```

   Overrides: `GCP_PROJECT_ID`, `GCP_ZONE`, `GCP_VM_NAME`, `NEMOCLAW_REMOTE_DIR`, `GCP_VM_SSH_USER`.

   **VM Linux user:** With OS Login, files land under **`/home/<your_login>/`**. Leave `GCP_VM_SSH_USER` unset so `gcloud` uses the same account as your Mac. For a stock Ubuntu image **without** OS Login, use **`GCP_VM_SSH_USER=ubuntu`**.

3. **Gateway token**: if `OPENCLAW_GATEWAY_TOKEN` is not set locally, the script generates one and prints it — save it for the Control UI.
4. **Tunnel** from the script’s printed `gcloud compute ssh … -L 8080:127.0.0.1:8080`, then open `http://127.0.0.1:8080/`.
5. **Telegram pairing (GCP only):** use **one** gateway with this bot token — **stop local** OpenClaw first (`docker compose -f docker-compose.openclaw.yml down` on your Mac). On the **VM**:

   ```bash
   cd ~/nemoclaw-telegram-bot
   bash scripts/gcp-telegram-vm.sh status
   # Message your bot in Telegram, then:
   bash scripts/gcp-telegram-vm.sh list
   bash scripts/gcp-telegram-vm.sh approve '<CODE>'
   ```

   `gcp-telegram-vm.sh` uses `docker exec` so pairing over SSH does not hang like some `compose exec` paths. See [OpenClaw Telegram docs](https://docs.openclaw.ai/channels/telegram).

If you change secrets in `.env` and the gateway ignores them, reset persisted config:  
`sudo docker compose -f docker-compose.openclaw.yml down -v` (destructive to OpenClaw state volume), then re-run the deploy script.

### Render

1. Push this repo to GitHub and create a **Web Service** from the included [`render.yaml`](render.yaml), or use **Blueprint** deploy.
2. In the Render Dashboard, set:
   - **`GEMINI_API_KEY`** — from [Google AI Studio](https://aistudio.google.com/apikey) (or use **`GOOGLE_API_KEY`**; see [Google (Gemini) provider](https://docs.openclaw.ai/providers/google)).
   - **`TELEGRAM_BOT_TOKEN`** — from [@BotFather](https://t.me/BotFather).
3. Set **`OPENCLAW_GATEWAY_TOKEN`** in Environment (e.g. `openssl rand -hex 32`); it is not auto-generated. It protects the Control UI and gateway APIs.
4. After the first deploy, open `https://<your-service>.onrender.com/` and sign in with the gateway token.

## Telegram pairing

OpenClaw uses **long polling** for Telegram by default (no `setWebhook` to this repo). For DM access, approve pairing from the host or CLI:

- [Telegram channel](https://docs.openclaw.ai/channels/telegram) — `dmPolicy` defaults to `pairing`; use `openclaw pairing approve telegram <CODE>` in a [Render Shell](https://render.com/docs/sh) if needed.

To use an allowlist instead of pairing, edit `/data/.openclaw/openclaw.json` on the persistent disk (or adjust the seed in [`config/openclaw.json`](config/openclaw.json) before first boot) and set `channels.telegram.allowFrom` to your numeric Telegram user id.

## Configuration

- **First run:** [`docker-entrypoint.sh`](docker-entrypoint.sh) writes `$OPENCLAW_STATE_DIR/openclaw.json` once from [`config/openclaw.json`](config/openclaw.json), injecting **`OPENCLAW_GATEWAY_TOKEN`** and **`TELEGRAM_BOT_TOKEN`** from the environment (e.g. `.env` / Render / GCP deploy). Later changes persist on disk and are not overwritten by redeploys unless you remove the volume.
- **Local reference:** [`.env.example`](.env.example) lists common variables.

## Browser automation on Render

Chromium is installed in the image for the default browser tool. Heavy or login-dependent flows (airlines, Google properties) may still need [remote CDP / Browserless](https://docs.openclaw.ai/tools/browser) or a gateway on your own machine—see the OpenClaw browser docs.

## Optional: Composio

If you use the Composio OpenClaw plugin for hosted MCP connectors, follow [Composio’s install steps](https://docs.openclaw.ai/) and set `plugins.entries.composio.config.consumerKey` via `openclaw config set` in the container. Native **`GEMINI_API_KEY`** is enough for Gemini as the model provider without Composio.

## Docs

- [Install on Render](https://docs.openclaw.ai/install/render)
- [Gateway configuration](https://docs.openclaw.ai/gateway/configuration)
- [Updating OpenClaw](https://docs.openclaw.ai/install/updating)
