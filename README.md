# OpenClaw Lite Agent

Lightweight Telegram agent for Cloudflare Workers.

## Required Cloudflare secrets

Set these as Worker secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `MODEL_API_KEY`

## Deploy

```sh
npx wrangler deploy
```

## Telegram webhook

After deploy, set:

```sh
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -F "url=https://YOUR_WORKER_DOMAIN/telegram/webhook" \
  -F "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```
