# OpenClaw Lite Agent

Lightweight Telegram agent for Cloudflare Workers. Commands are shown in Chinese for the Telegram user experience.

## Chinese commands

- `帮助` - show command help
- `状态` - show agent status
- `记住 <内容>` - save long-term memory
- `记忆` - list saved memories
- `忘记 <编号|全部>` - delete memories
- `提醒 <时间> <内容>` - add a reminder
- `提醒列表` - list pending reminders
- `取消提醒 <编号|全部>` - cancel reminders
- `待办 <内容>` - add a todo
- `待办列表` - list active todos
- `完成 <编号|全部>` - mark todos done
- `删除待办 <编号|全部>` - delete todos
- `收藏 <链接> [备注]` - save a link
- `收藏夹` - list saved links
- `删除收藏 <编号|全部>` - delete saved links
- `复盘` - summarize memories, todos, reminders, and bookmarks
- `搜索 <关键词>` - lightweight web search and summary
- `网页 <链接>` - fetch and summarize a web page

Reminder examples:

```text
提醒 10分钟后 喝水
提醒 明天 9:00 看部署状态
提醒 2026-06-09 20:30 复盘策略
```

Todo and bookmark examples:

```text
待办 检查 Cloudflare 日志
完成 1
收藏 https://developers.cloudflare.com/workers/ Workers 文档
复盘
```

## Required Cloudflare secrets

Set these as Worker secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `MODEL_API_KEY`

## Required Cloudflare bindings

Bind a Workers KV namespace as:

- `OPENCLAW_KV`

The agent uses KV for memories, reminders, and reminder delivery state.

## Optional search secrets

Search works in a lightweight DuckDuckGo fallback mode without a key. For better search, set one of:

- `BRAVE_API_KEY`
- `SERPER_API_KEY`

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
