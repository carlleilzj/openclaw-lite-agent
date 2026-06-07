# OpenClaw Lite Agent

Lightweight Telegram agent for Cloudflare Workers. Commands are shown in Chinese for the Telegram user experience.

## Chinese commands

- `帮助` - show command help
- `状态` - show agent status
- `Worker状态` - show Worker operations status
- `GitHub仓库` - show GitHub repository status
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
- `日志 <内容>` - add a general log entry
- `项目日志 <内容>` - add a project log entry
- `交易日志 <内容>` - add a trading observation
- `日志列表 [项目|交易|通用]` - list recent logs
- `删除日志 <编号|多个编号|全部>` - delete logs
- `日报` - summarize today's logs and state
- `周报` - summarize the last seven days
- `订阅日报 <时间>` - send the daily report automatically
- `取消日报` - stop the automatic daily report
- `订阅周报 [周几] <时间>` - send the weekly report automatically
- `取消周报` - stop the automatic weekly report
- `订阅列表` - show report subscriptions
- `查找 <关键词>` - search memories, todos, reminders, bookmarks, and logs
- `备份 [备注]` - snapshot current personal state
- `备份列表` - list recent state backups
- `恢复备份 <编号>` - restore a backup
- `删除备份 <编号|全部>` - delete backups
- `确认 <确认码>` - confirm a sensitive operation
- `取消操作` - cancel a pending sensitive operation
- `搜索 <关键词>` - lightweight web search and summary
- `网页 <链接>` - fetch and summarize a web page

## Admin commands

- `管理员` - show admin command help
- `部署记录` - list recent Cloudflare Worker deployments
- `触发部署 [ref]` - trigger a deploy hook or GitHub Actions workflow
- `用户列表` - show configured and dynamic allowlists
- `添加用户 <chat_id> [备注]` - add a dynamic allowlist user
- `删除用户 <chat_id>` - remove a dynamic allowlist user
- `安全状态` - show security settings
- `审计日志 [数量]` - show sensitive operation audit logs
- `错误日志 [数量]` - show internal Worker error logs

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

Log and report examples:

```text
日志 修复了 Telegram webhook 命令路由
项目日志 OpenClaw v0.4.0 增加日报和周报
交易日志 BTC 观察到关键阻力位，等待确认
日志列表 交易
日报
周报
订阅日报 21:30
订阅周报 周日 21:30
订阅列表
查找 Cloudflare
备份 部署前
备份列表
Worker状态
GitHub仓库
管理员
部署记录
触发部署 main
```

## Required Cloudflare secrets

Set these as Worker secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `MODEL_API_KEY`

## Optional operations secrets

Set these only if you want the Telegram agent to query or trigger external operations:

- `CLOUDFLARE_API_TOKEN` - read Worker deployments through the Cloudflare API
- `GITHUB_TOKEN` - trigger GitHub Actions workflow dispatches
- `DEPLOY_HOOK_URL` - trigger an external deployment hook instead of GitHub Actions

For the included `.github/workflows/deploy.yml`, set the GitHub repository secret:

- `CLOUDFLARE_API_TOKEN` - lets GitHub Actions deploy the Worker through Wrangler

## Required Cloudflare bindings

Bind a Workers KV namespace as:

- `OPENCLAW_KV`

The agent uses KV for memories, reminders, todos, bookmarks, logs, report subscriptions, recent state backups, dynamic user allowlists, rate limits, pending confirmations, audit logs, and error logs.

## Security

- `ALLOWED_CHAT_ID` supports comma-separated Telegram chat IDs.
- `ADMIN_CHAT_ID` supports comma-separated Telegram admin chat IDs. If omitted, admins default to `ALLOWED_CHAT_ID`.
- Sensitive operations require a short confirmation code before execution.
- Rate limiting defaults to 30 requests per 60 seconds per chat.
- Dynamic allowlist changes are stored in KV and audited.

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
