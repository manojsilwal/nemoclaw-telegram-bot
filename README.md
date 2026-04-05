# OpenClaw + Gemini (Telegram)

This repository deploys [OpenClaw](https://openclaw.ai) on [Render](https://render.com) with **Google Gemini** as the default model, **Telegram** as a channel, and **Chromium** pre-installed for the bundled [browser tool](https://docs.openclaw.ai/tools/browser).

The previous Nemoclaw stack (FastAPI webhook → Hugging Face Gradio) has been removed in favor of OpenClaw’s gateway, which owns Telegram, tools, and sessions.

## Deploy

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

- **First run:** [`docker-entrypoint.sh`](docker-entrypoint.sh) copies [`config/openclaw.json`](config/openclaw.json) to `$OPENCLAW_STATE_DIR/openclaw.json` only if that file does not exist (`/data/.openclaw` on Render). Later changes persist on disk and are not overwritten by redeploys.
- **Local reference:** [`.env.example`](.env.example) lists common variables.

## Browser automation on Render

Chromium is installed in the image for the default browser tool. Heavy or login-dependent flows (airlines, Google properties) may still need [remote CDP / Browserless](https://docs.openclaw.ai/tools/browser) or a gateway on your own machine—see the OpenClaw browser docs.

## Optional: Composio

If you use the Composio OpenClaw plugin for hosted MCP connectors, follow [Composio’s install steps](https://docs.openclaw.ai/) and set `plugins.entries.composio.config.consumerKey` via `openclaw config set` in the container. Native **`GEMINI_API_KEY`** is enough for Gemini as the model provider without Composio.

## Docs

- [Install on Render](https://docs.openclaw.ai/install/render)
- [Gateway configuration](https://docs.openclaw.ai/gateway/configuration)
- [Updating OpenClaw](https://docs.openclaw.ai/install/updating)
