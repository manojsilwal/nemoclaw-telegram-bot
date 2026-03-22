"""
Nemoclaw Telegram Bot — Render Web Service
Receives Telegram webhook updates and forwards them to the Nemoclaw HF Space via Gradio API.
"""
from __future__ import annotations

import os
import requests
from typing import Optional
from fastapi import FastAPI, Request
from gradio_client import Client

app = FastAPI()

# ── Environment variables (set in Render Dashboard) ───────────────────────────
TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

# Lazy HF client so Uvicorn binds to $PORT before any external Gradio handshake (Render deploy health).
_hf_client: Optional[Client] = None


def get_hf_client() -> Client:
    global _hf_client
    if _hf_client is None:
        print("Connecting to Nemoclaw HF Space...")
        _hf_client = Client("TradetalkApp/finance-agent-backend-tta")
        print("Connected!")
    return _hf_client

# ── Helper: send a Telegram message ───────────────────────────────────────────
def send_message(chat_id: int, text: str):
    requests.post(f"{TELEGRAM_API}/sendMessage", json={
        "chat_id": chat_id,
        "text": text
    })

# ── Webhook endpoint — Telegram calls this for every new message ───────────────
@app.post("/webhook")
async def webhook(request: Request):
    data = await request.json()

    message = data.get("message", {})
    chat_id = message.get("chat", {}).get("id")
    text = message.get("text", "")

    if not chat_id or not text:
        return {"ok": True}

    if text.strip() == "/start":
        send_message(chat_id, "🚀 Hello! I am Nemoclaw, powered by Nemotron Super. Ask me anything about finance and investing!")
        return {"ok": True}

    # Send "Thinking..." first
    thinking_resp = requests.post(f"{TELEGRAM_API}/sendMessage", json={
        "chat_id": chat_id,
        "text": "🤔 Thinking..."
    })
    thinking_msg_id = thinking_resp.json().get("result", {}).get("message_id")

    try:
        result = get_hf_client().predict(
            user_input=text,
            history=[],
            api_name="/chat"
        )
        history = result[1]
        if history and isinstance(history[-1], dict) and "content" in history[-1]:
            response_text = history[-1]["content"]
        else:
            response_text = str(history)
    except Exception as e:
        response_text = f"❌ Error: {str(e)}"

    # Edit the "Thinking..." message with the real response
    if thinking_msg_id:
        requests.post(f"{TELEGRAM_API}/editMessageText", json={
            "chat_id": chat_id,
            "message_id": thinking_msg_id,
            "text": response_text
        })
    else:
        send_message(chat_id, response_text)

    return {"ok": True}

# ── Health check ───────────────────────────────────────────────────────────────
@app.get("/")
def health():
    return {"status": "Nemoclaw Telegram Bot is running ✅"}
