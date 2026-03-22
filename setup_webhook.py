"""
Run this ONCE after deploying to Render to register your webhook URL with Telegram.
Usage:
    TELEGRAM_BOT_TOKEN=xxx RENDER_URL=https://your-service.onrender.com python setup_webhook.py
"""
import os
import requests

token = os.environ["TELEGRAM_BOT_TOKEN"]
render_url = os.environ["RENDER_URL"].rstrip("/")
webhook_url = f"{render_url}/webhook"

resp = requests.post(
    f"https://api.telegram.org/bot{token}/setWebhook",
    json={"url": webhook_url}
)
print(resp.json())
