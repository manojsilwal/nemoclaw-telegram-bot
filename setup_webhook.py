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
