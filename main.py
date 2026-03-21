import os
import requests
from fastapi import FastAPI, Request
from gradio_client import Client

app = FastAPI()

TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

print("Connecting to Nemoclaw HF Space...")
hf_client = Client("TradetalkApp/finance-agent-backend-tta")
print("Connected!")


def send_message(chat_id: int, text: str):
          requests.post(f"{TELEGRAM_API}/sendMessage", json={"chat_id": chat_id, "text": text})


@app.post("/webhook")
async def webhook(request: Request):
          data = await request.json()
          message = data.get("message", {})
          chat_id = message.get("chat", {}).get("id")
          text = message.get("text", "")

    if not chat_id or not text:
                  return {"ok": True}

    if text.strip() == "/start":
                  send_message(chat_id, "Hello! I am Nemoclaw, powered by Nemotron Super. Ask me anything about finance!")
                  return {"ok": True}

    thinking_resp = requests.post(f"{TELEGRAM_API}/sendMessage", json={"chat_id": chat_id, "text": "Thinking..."})
    thinking_msg_id = thinking_resp.json().get("result", {}).get("message_id")

    try:
                  result = hf_client.predict(user_input=text, history=[], api_name="/chat")
                  history = result[1]
                  if history and isinstance(history[-1], dict) and "content" in history[-1]:
                                    response_text = history[-1]["content"]
    else:
            response_text = str(history)
    except Exception as e:
        response_text = f"Error: {str(e)}"

    if thinking_msg_id:
                  requests.post(f"{TELEGRAM_API}/editMessageText", json={"chat_id": chat_id, "message_id": thinking_msg_id, "text": response_text})
else:
              send_message(chat_id, response_text)

    return {"ok": True}


@app.get("/")
def health():
          return {"status": "Nemoclaw Telegram Bot is running"}
      
