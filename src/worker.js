const TELEGRAM_API = "https://api.telegram.org";
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const GITHUB_API = "https://api.github.com";
const VERSION = "0.7.0";
const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const DEFAULT_WORKER_NAME = "openclaw-lite-agent";
const DEFAULT_GITHUB_REPO = "carlleilzj/openclaw-lite-agent";
const DEFAULT_GITHUB_REF = "main";
const DEFAULT_GITHUB_WORKFLOW = "deploy.yml";
const MAX_MEMORY_ITEMS = 30;
const MAX_REMINDERS = 50;
const MAX_TODOS = 50;
const MAX_BOOKMARKS = 50;
const MAX_LOGS = 120;
const MAX_BACKUPS = 5;
const MAX_AUDIT_LOGS = 100;
const MAX_ERROR_LOGS = 60;
const MAX_SEARCH_RESULTS = 20;
const MAX_PAGE_CHARS = 12000;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_REQUESTS = 30;
const CONFIRMATION_TTL_SECONDS = 300;
const SECURITY_KEY = "security:global";
const AUDIT_KEY = "audit:global";
const ERROR_KEY = "errors:global";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "openclaw-lite-agent",
        version: VERSION,
        endpoints: ["/telegram/webhook", "/health"]
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        version: VERSION,
        storage: Boolean(env.OPENCLAW_KV),
        search: getSearchProvider(env),
        timeZone: env.TIME_ZONE || DEFAULT_TIME_ZONE,
        worker: env.CLOUDFLARE_WORKER_NAME || DEFAULT_WORKER_NAME,
        githubRepo: env.GITHUB_REPO || DEFAULT_GITHUB_REPO,
        ops: {
          cloudflareApi: Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID),
          githubToken: Boolean(env.GITHUB_TOKEN),
          deployHook: Boolean(env.DEPLOY_HOOK_URL)
        }
      });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env, ctx);
    }

    return json({ ok: false, error: "Not found" }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduledJobs(env));
  }
};

async function handleTelegramWebhook(request, env, ctx) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (env.TELEGRAM_WEBHOOK_SECRET && secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false, error: "Bad webhook secret" }, 401);
  }

  const update = await request.json();
  const message = update.message || update.edited_message;
  if (!message || !message.chat || !message.text) {
    return json({ ok: true, ignored: true });
  }

  const chatId = String(message.chat.id);
  if (!(await isAllowedChat(env, chatId))) {
    await recordAudit(env, {
      chatId,
      action: "unauthorized_chat",
      target: chatId,
      status: "denied"
    });
    await sendTelegramMessage(env, chatId, "这个智能体当前只允许指定会话使用。");
    return json({ ok: true, ignored: "unauthorized_chat" });
  }

  const text = normalizeMessage(message.text);
  if (!text) {
    return json({ ok: true, ignored: "empty_text" });
  }

  try {
    const limit = await enforceRateLimit(env, chatId);
    if (!limit.allowed) {
      await recordAudit(env, {
        chatId,
        action: "rate_limit",
        target: `${limit.count}/${limit.max}`,
        status: "denied"
      });
      await sendTelegramMessage(env, chatId, `请求太密集了，请 ${limit.retryAfterSeconds} 秒后再试。`);
      return json({ ok: true, ignored: "rate_limited" });
    }

    ctx?.waitUntil?.(runScheduledJobs(env));
    await sendTelegramChatAction(env, chatId, "typing");

    const response = await routeMessage(env, chatId, text);
    await sendTelegramMessage(env, chatId, response);
    return json({ ok: true });
  } catch (error) {
    console.error(error);
    await recordError(env, {
      chatId,
      command: text,
      message: error?.message || String(error)
    });
    await sendTelegramMessage(env, chatId, "处理失败了，请稍后再试。");
    return json({ ok: false, error: "agent_failed" }, 500);
  }
}

async function routeMessage(env, chatId, text, options = {}) {
  const body = stripBotMention(text);

  if (startsCommand(body, ["确认", "confirm"])) {
    return confirmPendingOperation(env, chatId, commandPayload(body));
  }

  if (isCommand(body, ["取消操作", "取消确认", "cancel_operation"])) {
    return cancelPendingOperation(env, chatId);
  }

  if (!options.confirmed) {
    const confirmation = await requestOperationConfirmation(env, chatId, body);
    if (confirmation) {
      return confirmation;
    }
  }

  if (isCommand(body, ["帮助", "help", "start", "开始"])) {
    return helpText(env);
  }

  if (isCommand(body, ["状态", "status"])) {
    return statusText(env, chatId);
  }

  if (isCommand(body, ["管理员", "管理帮助", "admin"])) {
    return adminHelpText(env, chatId);
  }

  if (isCommand(body, ["Worker状态", "worker状态", "查Worker状态", "查 Worker 状态", "运维状态", "worker_status"])) {
    return workerStatus(env, chatId);
  }

  if (isCommand(body, ["部署记录", "查部署记录", "deployments"])) {
    return listWorkerDeployments(env, chatId);
  }

  if (isCommand(body, ["GitHub仓库", "Github仓库", "GitHub repo", "Github repo", "查GitHub仓库", "查 GitHub 仓库", "查 GitHub repo", "仓库状态", "查仓库", "repo"])) {
    return githubRepoStatus(env, chatId);
  }

  if (startsCommand(body, ["触发部署", "重新部署", "deploy"])) {
    return triggerDeploy(env, chatId, commandPayload(body));
  }

  if (isCommand(body, ["用户列表", "白名单", "users"])) {
    return listAllowedUsers(env, chatId);
  }

  if (startsCommand(body, ["添加用户", "允许用户", "user_add"])) {
    return addAllowedUser(env, chatId, commandPayload(body));
  }

  if (startsCommand(body, ["删除用户", "移除用户", "user_del"])) {
    return removeAllowedUser(env, chatId, commandPayload(body));
  }

  if (isCommand(body, ["安全状态", "权限状态", "security"])) {
    return securityStatus(env, chatId);
  }

  if (startsCommand(body, ["审计日志", "操作审计", "audit"])) {
    return listAuditLogs(env, chatId, commandPayload(body));
  }

  if (startsCommand(body, ["错误日志", "错误报告", "报告错误日志", "errors"])) {
    return listErrorLogs(env, chatId, commandPayload(body));
  }

  if (isCommand(body, ["记忆", "查看记忆", "memory"])) {
    return listMemories(env, chatId);
  }

  if (startsCommand(body, ["记住", "memory_add"])) {
    return remember(env, chatId, commandPayload(body));
  }

  if (startsCommand(body, ["忘记", "删除记忆", "memory_del"])) {
    return forget(env, chatId, commandPayload(body));
  }

  if (startsCommand(body, ["提醒", "remind"])) {
    return addReminder(env, chatId, commandPayload(body));
  }

  if (isCommand(body, ["提醒列表", "查看提醒", "reminders"])) {
    return listReminders(env, chatId);
  }

  if (startsCommand(body, ["取消提醒", "删除提醒", "cancel_reminder"])) {
    return cancelReminder(env, chatId, commandPayload(body));
  }

  if (startsCommand(body, ["待办", "todo"])) {
    return addTodo(env, chatId, commandPayload(body));
  }

  if (isCommand(body, ["待办列表", "查看待办", "todos"])) {
    return listTodos(env, chatId);
  }

  if (startsCommand(body, ["完成", "完成待办", "done"])) {
    return completeTodo(env, chatId, commandPayload(body));
  }

  if (startsCommand(body, ["删除待办", "取消待办", "todo_del"])) {
    return deleteTodo(env, chatId, commandPayload(body));
  }

  if (startsCommand(body, ["收藏", "bookmark"])) {
    return addBookmark(env, chatId, commandPayload(body));
  }

  if (isCommand(body, ["收藏夹", "收藏列表", "bookmarks"])) {
    return listBookmarks(env, chatId);
  }

  if (startsCommand(body, ["删除收藏", "取消收藏", "bookmark_del"])) {
    return deleteBookmark(env, chatId, commandPayload(body));
  }

  if (isCommand(body, ["复盘", "总览", "dashboard"])) {
    return reviewState(env, chatId);
  }

  if (startsCommand(body, ["日志列表", "查看日志", "logs"])) {
    return listLogs(env, chatId, commandPayload(body));
  }

  if (startsCommand(body, ["删除日志", "清理日志", "log_del"])) {
    return deleteLog(env, chatId, commandPayload(body));
  }

  if (startsCommand(body, ["订阅日报", "日报订阅", "开启日报", "自动日报", "daily_subscribe"])) {
    return subscribeDailyReport(env, chatId, commandPayload(body));
  }

  if (isCommand(body, ["取消日报", "关闭日报", "取消自动日报", "daily_unsubscribe"])) {
    return unsubscribeReport(env, chatId, "daily");
  }

  if (startsCommand(body, ["订阅周报", "周报订阅", "开启周报", "自动周报", "weekly_subscribe"])) {
    return subscribeWeeklyReport(env, chatId, commandPayload(body));
  }

  if (isCommand(body, ["取消周报", "关闭周报", "取消自动周报", "weekly_unsubscribe"])) {
    return unsubscribeReport(env, chatId, "weekly");
  }

  if (isCommand(body, ["订阅列表", "报告订阅", "报告设置", "subscriptions"])) {
    return listReportSubscriptions(env, chatId);
  }

  if (isCommand(body, ["备份列表", "查看备份", "backups"])) {
    return listBackups(env, chatId);
  }

  if (startsCommand(body, ["恢复备份", "还原备份", "restore_backup"])) {
    return restoreBackup(env, chatId, commandPayload(body));
  }

  if (startsCommand(body, ["删除备份", "清理备份", "backup_del"])) {
    return deleteBackup(env, chatId, commandPayload(body));
  }

  if (startsCommand(body, ["备份", "创建备份", "backup"])) {
    return createBackup(env, chatId, commandPayload(body));
  }

  if (startsCommand(body, ["查找", "检索", "find"])) {
    return searchPersonalState(env, chatId, commandPayload(body));
  }

  if (startsCommand(body, ["交易日志", "交易记录", "trade_log"])) {
    return addLog(env, chatId, "交易", commandPayload(body));
  }

  if (startsCommand(body, ["项目日志", "项目记录", "project_log"])) {
    return addLog(env, chatId, "项目", commandPayload(body));
  }

  if (startsCommand(body, ["日志", "记录", "log"])) {
    return addLog(env, chatId, "通用", commandPayload(body));
  }

  if (isCommand(body, ["日报", "今日复盘", "daily"])) {
    return periodReport(env, chatId, "day");
  }

  if (isCommand(body, ["周报", "本周复盘", "weekly"])) {
    return periodReport(env, chatId, "week");
  }

  if (startsCommand(body, ["搜索", "search"])) {
    return searchCommand(env, chatId, commandPayload(body));
  }

  if (startsCommand(body, ["网页", "总结网页", "读网页", "总结链接", "url"])) {
    return summarizeUrlCommand(env, chatId, commandPayload(body));
  }

  return chatWithMemory(env, chatId, body);
}

function helpText(env) {
  const storage = env.OPENCLAW_KV ? "已启用" : "未配置";
  const search = getSearchProvider(env) || "轻量 DuckDuckGo";

  return [
    "轻量 OpenClaw 已在线。",
    "",
    "可用中文命令：",
    "帮助 - 查看这份说明",
    "状态 - 查看智能体状态",
    "Worker状态 - 查看 Worker 运维状态",
    "GitHub仓库 - 查看 GitHub 仓库状态",
    "记住 <内容> - 保存长期记忆",
    "记忆 - 查看已保存记忆",
    "忘记 <编号|全部> - 删除记忆",
    "提醒 <时间> <内容> - 添加提醒",
    "提醒列表 - 查看提醒",
    "取消提醒 <编号|全部> - 删除提醒",
    "待办 <内容> - 添加待办",
    "待办列表 - 查看待办",
    "完成 <编号|全部> - 完成待办",
    "删除待办 <编号|全部> - 删除待办",
    "收藏 <链接> [备注] - 保存链接",
    "收藏夹 - 查看收藏",
    "删除收藏 <编号|全部> - 删除收藏",
    "复盘 - 汇总记忆、待办、提醒和收藏",
    "日志 <内容> - 记录一条通用日志",
    "项目日志 <内容> - 记录项目进展",
    "交易日志 <内容> - 记录交易观察",
    "日志列表 [项目|交易|通用] - 查看近期日志",
    "删除日志 <编号|多个编号|全部> - 删除日志",
    "日报 - 生成今日摘要",
    "周报 - 生成近 7 天摘要",
    "订阅日报 <时间> - 每天自动推送日报",
    "取消日报 - 关闭自动日报",
    "订阅周报 [周几] <时间> - 每周自动推送周报",
    "取消周报 - 关闭自动周报",
    "订阅列表 - 查看自动报告设置",
    "查找 <关键词> - 检索记忆、待办、提醒、收藏和日志",
    "备份 [备注] - 保存当前个人状态快照",
    "备份列表 - 查看最近备份",
    "恢复备份 <编号> - 恢复指定备份",
    "删除备份 <编号|全部> - 删除备份",
    "确认 <确认码> - 确认敏感操作",
    "取消操作 - 取消待确认操作",
    "搜索 <关键词> - 轻量搜索并总结",
    "网页 <链接> - 读取网页并总结",
    "",
    "提醒时间示例：",
    "提醒 10分钟后 喝水",
    "提醒 明天 9:00 看部署状态",
    "提醒 2026-06-09 20:30 复盘策略",
    "待办 检查 Cloudflare 日志",
    "收藏 https://example.com 参考资料",
    "项目日志 OpenClaw v0.4.0 增加日报",
    "交易日志 BTC 观察到关键阻力位",
    "订阅日报 21:30",
    "订阅周报 周日 21:30",
    "查找 Cloudflare",
    "备份 部署前",
    "Worker状态",
    "GitHub仓库",
    "",
    `状态：记忆/提醒存储 ${storage}，搜索 ${search}。`,
    "管理员可发送「管理员」查看运维和安全命令。"
  ].join("\n");
}

async function adminHelpText(env, chatId) {
  if (!(await isAdminChat(env, chatId))) {
    return "只有管理员可以查看管理命令。";
  }

  return [
    "管理员命令：",
    "Worker状态 - 查看 Worker、KV、运维配置状态",
    "部署记录 - 查看 Cloudflare Worker 最近部署",
    "GitHub仓库 - 查看 GitHub repo 状态",
    "触发部署 [ref] - 触发部署 Hook 或 GitHub Actions",
    "用户列表 - 查看环境白名单和动态白名单",
    "添加用户 <chat_id> [备注] - 加入动态白名单",
    "删除用户 <chat_id> - 移出动态白名单",
    "安全状态 - 查看管理员、速率限制、确认设置",
    "审计日志 [数量] - 查看敏感操作记录",
    "错误日志 [数量] - 查看 Worker 内部错误记录",
    "确认 <确认码> - 执行待确认操作",
    "取消操作 - 放弃待确认操作"
  ].join("\n");
}

async function statusText(env, chatId) {
  const state = await loadState(env, chatId);
  const pending = state.reminders.filter((item) => !item.sentAt).length;
  const due = state.reminders.filter((item) => !item.sentAt && Date.parse(item.dueAt) <= Date.now()).length;
  const activeTodos = state.todos.filter((item) => !item.doneAt).length;
  const todayLogs = filterLogsByPeriod(state.logs, "day", env.TIME_ZONE || DEFAULT_TIME_ZONE).length;
  const weekLogs = filterLogsByPeriod(state.logs, "week", env.TIME_ZONE || DEFAULT_TIME_ZONE).length;
  const reportStatus = renderReportSubscriptions(state.reports);

  return [
    "智能体状态",
    `版本：${VERSION}`,
    `存储：${env.OPENCLAW_KV ? "Cloudflare KV 已启用" : "未配置持久化存储"}`,
    `搜索：${getSearchProvider(env) || "轻量 DuckDuckGo"}`,
    `时区：${env.TIME_ZONE || DEFAULT_TIME_ZONE}`,
    `记忆：${state.memories.length} 条`,
    `待办：${activeTodos} 条`,
    `待提醒：${pending} 条`,
    `已到期未发送：${due} 条`,
    `收藏：${state.bookmarks.length} 条`,
    `今日日志：${todayLogs} 条`,
    `近 7 天日志：${weekLogs} 条`,
    `自动报告：${reportStatus}`,
    `备份：${state.backups.length} 个`,
    `模型：${env.MODEL_NAME || "auto"}`
  ].join("\n");
}

async function workerStatus(env, chatId) {
  const state = await loadState(env, chatId);
  const security = await loadSecurityState(env);
  const isAdmin = await isAdminChat(env, chatId);
  const pending = state.reminders.filter((item) => !item.sentAt).length;
  const activeTodos = state.todos.filter((item) => !item.doneAt).length;
  const lines = [
    "Worker 运维状态",
    `版本：${VERSION}`,
    `Worker：${env.CLOUDFLARE_WORKER_NAME || DEFAULT_WORKER_NAME}`,
    `地址：${env.WORKER_URL || "未配置 WORKER_URL"}`,
    `KV：${env.OPENCLAW_KV ? "已绑定" : "未绑定"}`,
    `Cron：每分钟检查提醒/报告`,
    `模型：${env.MODEL_NAME || "auto"}`,
    `GitHub：${env.GITHUB_REPO || DEFAULT_GITHUB_REPO}`,
    `Cloudflare API：${env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID ? "已配置" : "未配置完整"}`,
    `部署触发：${deployTriggerMode(env)}`,
    `动态白名单：${security.allowedChatIds.length} 个`,
    `速率限制：${RATE_LIMIT_MAX_REQUESTS}/${RATE_LIMIT_WINDOW_SECONDS} 秒`,
    `状态计数：记忆 ${state.memories.length} / 待办 ${activeTodos} / 待提醒 ${pending} / 收藏 ${state.bookmarks.length} / 日志 ${state.logs.length}`
  ];

  if (isAdmin && env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
    try {
      const deployments = await fetchCloudflareDeployments(env, 1);
      const latest = deployments[0];
      if (latest) {
        lines.push(`最新部署：${formatDeploymentLine(latest, env.TIME_ZONE || DEFAULT_TIME_ZONE)}`);
      }
    } catch (error) {
      await recordError(env, {
        chatId,
        command: "Worker状态",
        message: error?.message || String(error)
      });
      lines.push(`最新部署：查询失败，已记录错误。`);
    }
  }

  return lines.join("\n");
}

async function listWorkerDeployments(env, chatId) {
  const adminError = await requireAdmin(env, chatId);
  if (adminError) {
    return adminError;
  }

  const missing = missingCloudflareConfig(env);
  if (missing.length) {
    return [
      "部署记录需要配置 Cloudflare API。",
      `缺少：${missing.join(", ")}`,
      "建议把 CLOUDFLARE_API_TOKEN 设为 Worker secret，并在 wrangler.jsonc 配置 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_WORKER_NAME。"
    ].join("\n");
  }

  const deployments = await fetchCloudflareDeployments(env, 5);
  if (!deployments.length) {
    return "没有查到部署记录。";
  }

  return [
    "最近 Cloudflare Worker 部署：",
    ...deployments.map((item, index) => `${index + 1}. ${formatDeploymentLine(item, env.TIME_ZONE || DEFAULT_TIME_ZONE)}`)
  ].join("\n");
}

async function githubRepoStatus(env, chatId) {
  const repo = env.GITHUB_REPO || DEFAULT_GITHUB_REPO;
  const data = await githubRequest(env, `/repos/${repo}`);
  const pushedAt = data.pushed_at ? formatDate(data.pushed_at, env.TIME_ZONE || DEFAULT_TIME_ZONE) : "未知";
  const updatedAt = data.updated_at ? formatDate(data.updated_at, env.TIME_ZONE || DEFAULT_TIME_ZONE) : "未知";
  await recordAudit(env, {
    chatId,
    action: "github_repo_status",
    target: repo,
    status: "read"
  });

  return [
    "GitHub 仓库状态",
    `仓库：${data.full_name || repo}`,
    `可见性：${data.private ? "私有" : "公开"}`,
    `默认分支：${data.default_branch || env.GITHUB_DEFAULT_REF || DEFAULT_GITHUB_REF}`,
    `Stars：${data.stargazers_count ?? 0}`,
    `Forks：${data.forks_count ?? 0}`,
    `Open issues：${data.open_issues_count ?? 0}`,
    `最后推送：${pushedAt}`,
    `最后更新：${updatedAt}`,
    `地址：${data.html_url || `https://github.com/${repo}`}`
  ].join("\n");
}

async function triggerDeploy(env, chatId, input) {
  const adminError = await requireAdmin(env, chatId);
  if (adminError) {
    return adminError;
  }

  if (env.DEPLOY_HOOK_URL) {
    const response = await fetch(env.DEPLOY_HOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "telegram",
        version: VERSION,
        ref: cleanText(input) || env.GITHUB_DEFAULT_REF || DEFAULT_GITHUB_REF,
        createdAt: new Date().toISOString()
      })
    });
    if (!response.ok) {
      throw new Error(`Deploy hook failed: ${response.status} ${await safeResponseText(response)}`);
    }
    await recordAudit(env, {
      chatId,
      action: "trigger_deploy",
      target: "deploy_hook",
      status: "sent"
    });
    return "已触发部署 Hook。";
  }

  if (!env.GITHUB_TOKEN) {
    return [
      "还不能触发部署：缺少部署触发配置。",
      "可选方案：",
      "1. 设置 Worker secret：DEPLOY_HOOK_URL",
      "2. 或设置 Worker secret：GITHUB_TOKEN，并配置 GITHUB_DEPLOY_WORKFLOW / GITHUB_DEFAULT_REF"
    ].join("\n");
  }

  const repo = env.GITHUB_REPO || DEFAULT_GITHUB_REPO;
  const workflow = env.GITHUB_DEPLOY_WORKFLOW || DEFAULT_GITHUB_WORKFLOW;
  const ref = cleanText(input) || env.GITHUB_DEFAULT_REF || DEFAULT_GITHUB_REF;
  const result = await githubRequest(env, `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    method: "POST",
    body: JSON.stringify({
      ref,
      inputs: {
        source: "telegram",
        requested_by: chatId
      }
    })
  }, [200, 204]);

  await recordAudit(env, {
    chatId,
    action: "trigger_deploy",
    target: `${repo}:${workflow}@${ref}`,
    status: "sent"
  });

  if (result?.html_url) {
    return `已触发 GitHub Actions 部署：${result.html_url}`;
  }
  return `已触发 GitHub Actions 部署：${repo} / ${workflow} @ ${ref}`;
}

async function listAllowedUsers(env, chatId) {
  const adminError = await requireAdmin(env, chatId);
  if (adminError) {
    return adminError;
  }

  const security = await loadSecurityState(env);
  const envAllowed = getConfiguredAllowedChatIds(env);
  const admins = getAdminChatIds(env);
  const dynamic = security.allowedChatIds;

  return [
    "用户白名单",
    `管理员：${admins.length ? admins.join(", ") : "未显式配置，默认使用 ALLOWED_CHAT_ID"}`,
    `环境白名单：${envAllowed.length ? envAllowed.join(", ") : "空，表示不限制"}`,
    `动态白名单：${dynamic.length ? dynamic.map((id) => formatAllowedUser(id, security)).join("；") : "无"}`
  ].join("\n");
}

async function addAllowedUser(env, chatId, input) {
  const adminError = await requireAdmin(env, chatId);
  if (adminError) {
    return adminError;
  }

  const parsed = parseUserInput(input);
  if (!parsed.chatId) {
    return "用法：添加用户 <chat_id> [备注]";
  }

  const security = await loadSecurityState(env);
  if (!security.allowedChatIds.includes(parsed.chatId)) {
    security.allowedChatIds.push(parsed.chatId);
  }
  if (parsed.note) {
    security.userNotes[parsed.chatId] = parsed.note;
  }
  await saveSecurityState(env, security);
  await recordAudit(env, {
    chatId,
    action: "add_user",
    target: parsed.chatId,
    status: "done"
  });

  return `已加入动态白名单：${parsed.chatId}${parsed.note ? `（${parsed.note}）` : ""}`;
}

async function removeAllowedUser(env, chatId, input) {
  const adminError = await requireAdmin(env, chatId);
  if (adminError) {
    return adminError;
  }

  const parsed = parseUserInput(input);
  if (!parsed.chatId) {
    return "用法：删除用户 <chat_id>";
  }

  if (getConfiguredAllowedChatIds(env).includes(parsed.chatId) || getAdminChatIds(env).includes(parsed.chatId)) {
    return "这个 chat_id 来自环境变量或管理员配置，不能用 Telegram 命令删除。请在 Cloudflare Worker 变量里调整。";
  }

  const security = await loadSecurityState(env);
  const before = security.allowedChatIds.length;
  security.allowedChatIds = security.allowedChatIds.filter((id) => id !== parsed.chatId);
  delete security.userNotes[parsed.chatId];
  await saveSecurityState(env, security);
  await recordAudit(env, {
    chatId,
    action: "remove_user",
    target: parsed.chatId,
    status: before === security.allowedChatIds.length ? "not_found" : "done"
  });

  return before === security.allowedChatIds.length ? `动态白名单里没有 ${parsed.chatId}。` : `已移出动态白名单：${parsed.chatId}`;
}

async function securityStatus(env, chatId) {
  const adminError = await requireAdmin(env, chatId);
  if (adminError) {
    return adminError;
  }

  const security = await loadSecurityState(env);
  const pending = await loadPendingOperation(env, chatId);
  return [
    "安全状态",
    `管理员：${getAdminChatIds(env).join(", ") || "默认环境白名单"}`,
    `动态白名单：${security.allowedChatIds.length} 个`,
    `速率限制：${RATE_LIMIT_MAX_REQUESTS}/${RATE_LIMIT_WINDOW_SECONDS} 秒`,
    `确认有效期：${CONFIRMATION_TTL_SECONDS} 秒`,
    `待确认操作：${pending ? pending.label : "无"}`,
    `审计保留：最近 ${MAX_AUDIT_LOGS} 条`,
    `错误保留：最近 ${MAX_ERROR_LOGS} 条`
  ].join("\n");
}

async function listAuditLogs(env, chatId, input) {
  const adminError = await requireAdmin(env, chatId);
  if (adminError) {
    return adminError;
  }

  const logs = await loadAuditLogs(env);
  const count = parseListCount(input, 10, 30);
  const items = logs.slice(-count).reverse();
  if (!items.length) {
    return "还没有审计日志。";
  }

  return [
    "最近审计日志：",
    ...items.map((item) => formatAuditLine(item, env.TIME_ZONE || DEFAULT_TIME_ZONE))
  ].join("\n");
}

async function listErrorLogs(env, chatId, input) {
  const adminError = await requireAdmin(env, chatId);
  if (adminError) {
    return adminError;
  }

  const logs = await loadErrorLogs(env);
  const count = parseListCount(input, 10, 30);
  const items = logs.slice(-count).reverse();
  if (!items.length) {
    return "还没有错误日志。";
  }

  return [
    "最近错误日志：",
    ...items.map((item) => formatErrorLine(item, env.TIME_ZONE || DEFAULT_TIME_ZONE))
  ].join("\n");
}

async function remember(env, chatId, text) {
  if (!env.OPENCLAW_KV) {
    return "记忆存储未配置。请先在 Cloudflare 绑定 KV：OPENCLAW_KV。";
  }
  if (!text) {
    return "用法：记住 <内容>";
  }

  const state = await loadState(env, chatId);
  const memory = {
    id: nextId(state.memories),
    text: text.slice(0, 800),
    createdAt: new Date().toISOString()
  };

  state.memories.push(memory);
  state.memories = state.memories.slice(-MAX_MEMORY_ITEMS);
  await saveState(env, chatId, state);

  return `已记住 #${memory.id}：${memory.text}`;
}

async function listMemories(env, chatId) {
  const state = await loadState(env, chatId);
  if (!state.memories.length) {
    return "还没有记忆。用「记住 <内容>」添加。";
  }

  return [
    "当前记忆：",
    ...state.memories.map((item) => `#${item.id} ${item.text}`)
  ].join("\n");
}

async function forget(env, chatId, target) {
  if (!env.OPENCLAW_KV) {
    return "记忆存储未配置，无法删除记忆。";
  }
  if (!target) {
    return "用法：忘记 <编号|全部>";
  }

  const state = await loadState(env, chatId);
  if (target === "全部" || target.toLowerCase() === "all") {
    const count = state.memories.length;
    state.memories = [];
    await saveState(env, chatId, state);
    return `已清空 ${count} 条记忆。`;
  }

  const id = Number(target.replace(/^#/, ""));
  if (!Number.isInteger(id)) {
    return "请提供要删除的记忆编号，例如：忘记 2";
  }

  const before = state.memories.length;
  state.memories = state.memories.filter((item) => item.id !== id);
  await saveState(env, chatId, state);

  return before === state.memories.length ? `没有找到记忆 #${id}。` : `已删除记忆 #${id}。`;
}

async function addReminder(env, chatId, input) {
  if (!env.OPENCLAW_KV) {
    return "提醒存储未配置。请先在 Cloudflare 绑定 KV：OPENCLAW_KV。";
  }
  if (!input) {
    return "用法：提醒 <时间> <内容>\n例如：提醒 10分钟后 喝水";
  }

  const parsed = parseReminder(input, env.TIME_ZONE || DEFAULT_TIME_ZONE);
  if (!parsed) {
    return [
      "我还没识别出这个提醒时间。",
      "可以这样写：",
      "提醒 10分钟后 喝水",
      "提醒 2小时后 看日志",
      "提醒 明天 9:00 看部署状态",
      "提醒 2026-06-09 20:30 复盘策略"
    ].join("\n");
  }

  const state = await loadState(env, chatId);
  const reminder = {
    id: nextId(state.reminders),
    text: parsed.text.slice(0, 800),
    dueAt: parsed.dueAt.toISOString(),
    createdAt: new Date().toISOString(),
    sentAt: null
  };

  state.reminders.push(reminder);
  state.reminders = state.reminders
    .filter((item) => !item.sentAt)
    .slice(-MAX_REMINDERS);
  await saveState(env, chatId, state);

  return `已添加提醒 #${reminder.id}：${formatDate(reminder.dueAt, env.TIME_ZONE || DEFAULT_TIME_ZONE)}\n${reminder.text}`;
}

async function listReminders(env, chatId) {
  const state = await loadState(env, chatId);
  const pending = state.reminders
    .filter((item) => !item.sentAt)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));

  if (!pending.length) {
    return "当前没有待提醒事项。";
  }

  return [
    "待提醒：",
    ...pending.map((item) => `#${item.id} ${formatDate(item.dueAt, env.TIME_ZONE || DEFAULT_TIME_ZONE)} - ${item.text}`)
  ].join("\n");
}

async function cancelReminder(env, chatId, target) {
  if (!env.OPENCLAW_KV) {
    return "提醒存储未配置，无法取消提醒。";
  }
  if (!target) {
    return "用法：取消提醒 <编号|全部>";
  }

  const state = await loadState(env, chatId);
  if (target === "全部" || target.toLowerCase() === "all") {
    const count = state.reminders.filter((item) => !item.sentAt).length;
    state.reminders = state.reminders.filter((item) => item.sentAt);
    await saveState(env, chatId, state);
    return `已取消 ${count} 条待提醒。`;
  }

  const id = Number(target.replace(/^#/, ""));
  if (!Number.isInteger(id)) {
    return "请提供要取消的提醒编号，例如：取消提醒 3";
  }

  const before = state.reminders.length;
  state.reminders = state.reminders.filter((item) => item.id !== id);
  await saveState(env, chatId, state);

  return before === state.reminders.length ? `没有找到提醒 #${id}。` : `已取消提醒 #${id}。`;
}

async function addTodo(env, chatId, text) {
  if (!env.OPENCLAW_KV) {
    return "待办存储未配置。请先在 Cloudflare 绑定 KV：OPENCLAW_KV。";
  }
  if (!text) {
    return "用法：待办 <内容>";
  }

  const state = await loadState(env, chatId);
  const todo = {
    id: nextId(state.todos),
    text: text.slice(0, 800),
    createdAt: new Date().toISOString(),
    doneAt: null
  };

  state.todos.push(todo);
  state.todos = state.todos.slice(-MAX_TODOS);
  await saveState(env, chatId, state);

  return `已添加待办 #${todo.id}：${todo.text}`;
}

async function listTodos(env, chatId) {
  const state = await loadState(env, chatId);
  const active = state.todos.filter((item) => !item.doneAt);
  if (!active.length) {
    return "当前没有待办。用「待办 <内容>」添加。";
  }

  return [
    "待办列表：",
    ...active.map((item) => `#${item.id} ${item.text}`)
  ].join("\n");
}

async function completeTodo(env, chatId, target) {
  if (!env.OPENCLAW_KV) {
    return "待办存储未配置，无法完成待办。";
  }
  if (!target) {
    return "用法：完成 <编号|全部>";
  }

  const state = await loadState(env, chatId);
  const now = new Date().toISOString();
  if (target === "全部" || target.toLowerCase() === "all") {
    let count = 0;
    for (const item of state.todos) {
      if (!item.doneAt) {
        item.doneAt = now;
        count += 1;
      }
    }
    await saveState(env, chatId, state);
    return `已完成 ${count} 条待办。`;
  }

  const id = Number(target.replace(/^#/, ""));
  if (!Number.isInteger(id)) {
    return "请提供待办编号，例如：完成 2";
  }

  const todo = state.todos.find((item) => item.id === id);
  if (!todo) {
    return `没有找到待办 #${id}。`;
  }
  if (todo.doneAt) {
    return `待办 #${id} 之前已经完成。`;
  }

  todo.doneAt = now;
  await saveState(env, chatId, state);
  return `已完成待办 #${id}：${todo.text}`;
}

async function deleteTodo(env, chatId, target) {
  if (!env.OPENCLAW_KV) {
    return "待办存储未配置，无法删除待办。";
  }
  if (!target) {
    return "用法：删除待办 <编号|全部>";
  }

  const state = await loadState(env, chatId);
  if (target === "全部" || target.toLowerCase() === "all") {
    const count = state.todos.length;
    state.todos = [];
    await saveState(env, chatId, state);
    return `已删除 ${count} 条待办。`;
  }

  const id = Number(target.replace(/^#/, ""));
  if (!Number.isInteger(id)) {
    return "请提供待办编号，例如：删除待办 2";
  }

  const before = state.todos.length;
  state.todos = state.todos.filter((item) => item.id !== id);
  await saveState(env, chatId, state);
  return before === state.todos.length ? `没有找到待办 #${id}。` : `已删除待办 #${id}。`;
}

async function addBookmark(env, chatId, input) {
  if (!env.OPENCLAW_KV) {
    return "收藏存储未配置。请先在 Cloudflare 绑定 KV：OPENCLAW_KV。";
  }
  const url = extractUrl(input);
  if (!url) {
    return "用法：收藏 <链接> [备注]";
  }

  const state = await loadState(env, chatId);
  const note = cleanText(input.replace(url, "")).slice(0, 300);
  const bookmark = {
    id: nextId(state.bookmarks),
    url,
    note,
    createdAt: new Date().toISOString()
  };

  state.bookmarks.push(bookmark);
  state.bookmarks = state.bookmarks.slice(-MAX_BOOKMARKS);
  await saveState(env, chatId, state);

  return [`已收藏 #${bookmark.id}：${bookmark.url}`, note ? `备注：${note}` : ""].filter(Boolean).join("\n");
}

async function listBookmarks(env, chatId) {
  const state = await loadState(env, chatId);
  if (!state.bookmarks.length) {
    return "当前没有收藏。用「收藏 <链接> [备注]」添加。";
  }

  return [
    "收藏夹：",
    ...state.bookmarks.slice(-20).map((item) => formatBookmarkLine(item))
  ].join("\n");
}

async function deleteBookmark(env, chatId, target) {
  if (!env.OPENCLAW_KV) {
    return "收藏存储未配置，无法删除收藏。";
  }
  if (!target) {
    return "用法：删除收藏 <编号|全部>";
  }

  const state = await loadState(env, chatId);
  if (target === "全部" || target.toLowerCase() === "all") {
    const count = state.bookmarks.length;
    state.bookmarks = [];
    await saveState(env, chatId, state);
    return `已删除 ${count} 条收藏。`;
  }

  const id = Number(target.replace(/^#/, ""));
  if (!Number.isInteger(id)) {
    return "请提供收藏编号，例如：删除收藏 2";
  }

  const before = state.bookmarks.length;
  state.bookmarks = state.bookmarks.filter((item) => item.id !== id);
  await saveState(env, chatId, state);
  return before === state.bookmarks.length ? `没有找到收藏 #${id}。` : `已删除收藏 #${id}。`;
}

async function reviewState(env, chatId) {
  const state = await loadState(env, chatId);
  const activeTodos = state.todos.filter((item) => !item.doneAt);
  const pendingReminders = state.reminders
    .filter((item) => !item.sentAt)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));

  if (!state.memories.length && !activeTodos.length && !pendingReminders.length && !state.bookmarks.length) {
    return "当前没有可复盘内容。可以先用「记住」「待办」「提醒」「收藏」积累上下文。";
  }

  const snapshot = renderStateSnapshot(env, state);
  try {
    const summary = await askModel(env, {
      userText: [
        "请基于下面的个人状态做一次轻量复盘。",
        "输出：1. 当前重点 2. 下一步行动 3. 可能遗漏的风险。",
        "保持简洁，不要编造不存在的执行结果。",
        "",
        snapshot
      ].join("\n"),
      state
    });
    return summary || snapshot;
  } catch (error) {
    console.error(error);
    return snapshot;
  }
}

async function addLog(env, chatId, type, text) {
  if (!env.OPENCLAW_KV) {
    return "日志存储未配置。请先在 Cloudflare 绑定 KV：OPENCLAW_KV。";
  }
  if (!text) {
    return type === "交易"
      ? "用法：交易日志 <内容>"
      : type === "项目"
        ? "用法：项目日志 <内容>"
        : "用法：日志 <内容>";
  }

  const state = await loadState(env, chatId);
  const entry = {
    id: nextId(state.logs),
    type,
    text: text.slice(0, 1000),
    createdAt: new Date().toISOString()
  };

  state.logs.push(entry);
  state.logs = state.logs.slice(-MAX_LOGS);
  await saveState(env, chatId, state);

  return `已记录${type}日志 #${entry.id}：${entry.text}`;
}

async function listLogs(env, chatId, filterText) {
  const state = await loadState(env, chatId);
  const type = parseLogType(filterText);
  const logs = state.logs
    .filter((item) => !type || item.type === type)
    .slice(-20)
    .reverse();

  if (!logs.length) {
    return type ? `还没有${type}日志。` : "还没有日志。用「日志 <内容>」添加。";
  }

  return [
    type ? `${type}日志：` : "近期日志：",
    ...logs.map((item) => formatLogLine(item, env.TIME_ZONE || DEFAULT_TIME_ZONE))
  ].join("\n");
}

async function deleteLog(env, chatId, target) {
  if (!env.OPENCLAW_KV) {
    return "日志存储未配置，无法删除日志。";
  }
  if (!target) {
    return "用法：删除日志 <编号|多个编号|全部>";
  }

  const state = await loadState(env, chatId);
  if (target === "全部" || target.toLowerCase() === "all") {
    const count = state.logs.length;
    state.logs = [];
    await saveState(env, chatId, state);
    return `已删除 ${count} 条日志。`;
  }

  const ids = parseIdList(target);
  if (!ids.length) {
    return "请提供日志编号，例如：删除日志 3 或 删除日志 1,2,3";
  }

  const before = state.logs.length;
  state.logs = state.logs.filter((item) => !ids.includes(item.id));
  await saveState(env, chatId, state);
  const deleted = before - state.logs.length;
  return deleted ? `已删除 ${deleted} 条日志。` : `没有找到日志：${ids.map((id) => `#${id}`).join(" ")}。`;
}

async function subscribeDailyReport(env, chatId, input) {
  if (!env.OPENCLAW_KV) {
    return "报告订阅存储未配置。请先在 Cloudflare 绑定 KV：OPENCLAW_KV。";
  }

  const time = parseTimeOfDay(input || "21:30");
  if (!time) {
    return "用法：订阅日报 <时间>\n例如：订阅日报 21:30";
  }

  const state = await loadState(env, chatId);
  state.reports.daily = {
    enabled: true,
    hour: time.hour,
    minute: time.minute,
    lastSentKey: state.reports.daily.lastSentKey || ""
  };
  await saveState(env, chatId, state);

  return `已订阅自动日报：每天 ${formatTimeOfDay(time)}。`;
}

async function subscribeWeeklyReport(env, chatId, input) {
  if (!env.OPENCLAW_KV) {
    return "报告订阅存储未配置。请先在 Cloudflare 绑定 KV：OPENCLAW_KV。";
  }

  const weekday = parseWeekday(input);
  const time = parseTimeOfDay(input || "周日 21:30");
  if (!time) {
    return "用法：订阅周报 [周几] <时间>\n例如：订阅周报 周日 21:30";
  }

  const state = await loadState(env, chatId);
  state.reports.weekly = {
    enabled: true,
    weekday: weekday ?? 0,
    hour: time.hour,
    minute: time.minute,
    lastSentKey: state.reports.weekly.lastSentKey || ""
  };
  await saveState(env, chatId, state);

  return `已订阅自动周报：每${formatWeekday(state.reports.weekly.weekday)} ${formatTimeOfDay(time)}。`;
}

async function unsubscribeReport(env, chatId, type) {
  if (!env.OPENCLAW_KV) {
    return "报告订阅存储未配置，无法取消订阅。";
  }

  const state = await loadState(env, chatId);
  state.reports[type].enabled = false;
  await saveState(env, chatId, state);
  return type === "daily" ? "已取消自动日报。" : "已取消自动周报。";
}

async function listReportSubscriptions(env, chatId) {
  const state = await loadState(env, chatId);
  return `自动报告设置：${renderReportSubscriptions(state.reports)}`;
}

async function searchPersonalState(env, chatId, query) {
  if (!query) {
    return "用法：查找 <关键词>\n例如：查找 Cloudflare";
  }

  const state = await loadState(env, chatId);
  const results = buildPersonalSearchIndex(state, env.TIME_ZONE || DEFAULT_TIME_ZONE)
    .filter((item) => matchesSearchQuery(item.searchText, query))
    .slice(0, MAX_SEARCH_RESULTS);

  if (!results.length) {
    return `没有在个人状态里找到「${query}」。`;
  }

  return [
    `个人状态检索：${query}`,
    ...results.map((item, index) => `${index + 1}. ${formatPersonalSearchHit(item)}`)
  ].join("\n");
}

async function createBackup(env, chatId, note) {
  if (!env.OPENCLAW_KV) {
    return "备份存储未配置。请先在 Cloudflare 绑定 KV：OPENCLAW_KV。";
  }

  const state = await loadState(env, chatId);
  const backup = {
    id: nextId(state.backups),
    note: cleanText(note).slice(0, 120),
    createdAt: new Date().toISOString(),
    state: snapshotCoreState(state)
  };

  state.backups.push(backup);
  state.backups = state.backups.slice(-MAX_BACKUPS);
  await saveState(env, chatId, state);

  return [
    `已创建备份 #${backup.id}${backup.note ? `：${backup.note}` : ""}`,
    renderBackupCounts(backup.state),
    `最多保留最近 ${MAX_BACKUPS} 个备份。`
  ].join("\n");
}

async function listBackups(env, chatId) {
  const state = await loadState(env, chatId);
  if (!state.backups.length) {
    return "还没有备份。用「备份 [备注]」创建一个状态快照。";
  }

  const timeZone = env.TIME_ZONE || DEFAULT_TIME_ZONE;
  return [
    "最近备份：",
    ...state.backups
      .slice()
      .reverse()
      .map((item) => formatBackupLine(item, timeZone))
  ].join("\n");
}

async function restoreBackup(env, chatId, target) {
  if (!env.OPENCLAW_KV) {
    return "备份存储未配置，无法恢复备份。";
  }
  const id = parseSingleId(target);
  if (!id) {
    return "用法：恢复备份 <编号>\n例如：恢复备份 1";
  }

  const state = await loadState(env, chatId);
  const backup = state.backups.find((item) => item.id === id);
  if (!backup) {
    return `没有找到备份 #${id}。`;
  }

  const restored = {
    ...snapshotCoreState(backup.state),
    backups: state.backups
  };
  await saveState(env, chatId, restored);

  return [
    `已恢复备份 #${backup.id}${backup.note ? `：${backup.note}` : ""}`,
    renderBackupCounts(restored),
    "备份列表已保留。"
  ].join("\n");
}

async function deleteBackup(env, chatId, target) {
  if (!env.OPENCLAW_KV) {
    return "备份存储未配置，无法删除备份。";
  }
  if (!target) {
    return "用法：删除备份 <编号|全部>";
  }

  const state = await loadState(env, chatId);
  if (target === "全部" || target.toLowerCase() === "all") {
    const count = state.backups.length;
    state.backups = [];
    await saveState(env, chatId, state);
    return `已删除 ${count} 个备份。`;
  }

  const ids = parseIdList(target);
  if (!ids.length) {
    return "请提供备份编号，例如：删除备份 2";
  }

  const before = state.backups.length;
  state.backups = state.backups.filter((item) => !ids.includes(item.id));
  await saveState(env, chatId, state);
  const deleted = before - state.backups.length;
  return deleted ? `已删除 ${deleted} 个备份。` : `没有找到备份：${ids.map((idValue) => `#${idValue}`).join(" ")}。`;
}

async function periodReport(env, chatId, period) {
  const state = await loadState(env, chatId);
  const timeZone = env.TIME_ZONE || DEFAULT_TIME_ZONE;
  const logs = filterLogsByPeriod(state.logs, period, timeZone);
  const label = period === "day" ? "日报" : "周报";
  const snapshot = renderPeriodSnapshot(env, state, logs, period);

  try {
    const summary = await askModel(env, {
      userText: [
        `请基于下面的状态和日志生成${label}。`,
        period === "day" ? "范围：今天。" : "范围：近 7 天。",
        "输出：1. 进展 2. 风险/问题 3. 下一步行动。",
        "如果交易日志存在，请单独列出交易观察；不要编造收益、下单或执行结果。",
        "",
        snapshot
      ].join("\n"),
      state
    });
    return summary || snapshot;
  } catch (error) {
    console.error(error);
    return snapshot;
  }
}

async function searchCommand(env, chatId, query) {
  if (!query) {
    return "用法：搜索 <关键词>";
  }

  const results = await searchWeb(env, query);
  if (!results.length) {
    return "没有搜到可用结果。你可以换个关键词，或之后接入 Brave/Serper API 提升搜索质量。";
  }

  const brief = await askModel(env, {
    chatId,
    userText: [
      `请用中文总结下面这些搜索结果，回答用户的问题：「${query}」。`,
      "要求：简洁、列出要点、保留重要链接。",
      "",
      ...results.map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.snippet}`)
    ].join("\n")
  });

  return brief || renderSearchResults(results);
}

async function summarizeUrlCommand(env, chatId, input) {
  const url = extractUrl(input);
  if (!url) {
    return "用法：网页 <链接>";
  }

  const page = await fetchReadablePage(url);
  if (!page.text) {
    return "这个网页没有提取到可读内容，可能需要登录、禁止抓取，或是纯前端页面。";
  }

  const summary = await askModel(env, {
    chatId,
    userText: [
      "请用中文总结这个网页，输出：",
      "1. 核心结论",
      "2. 关键要点",
      "3. 对我可能有用的行动建议",
      "",
      `标题：${page.title || "未识别"}`,
      `链接：${url}`,
      "",
      page.text.slice(0, MAX_PAGE_CHARS)
    ].join("\n")
  });

  return summary || `标题：${page.title || "未识别"}\n${page.text.slice(0, 1200)}`;
}

async function chatWithMemory(env, chatId, userText) {
  const state = await loadState(env, chatId);
  return askModel(env, { chatId, userText, state });
}

async function askModel(env, { userText, state = null }) {
  const memoryText = state?.memories?.length
    ? state.memories.map((item) => `#${item.id} ${item.text}`).join("\n")
    : "无";
  const remindersText = state?.reminders?.filter((item) => !item.sentAt).length
    ? state.reminders
        .filter((item) => !item.sentAt)
        .slice(0, 10)
        .map((item) => `#${item.id} ${item.dueAt} ${item.text}`)
        .join("\n")
    : "无";
  const todosText = state?.todos?.filter((item) => !item.doneAt).length
    ? state.todos
        .filter((item) => !item.doneAt)
        .slice(0, 20)
        .map((item) => `#${item.id} ${item.text}`)
        .join("\n")
    : "无";
  const bookmarksText = state?.bookmarks?.length
    ? state.bookmarks
        .slice(-10)
        .map((item) => formatBookmarkLine(item))
        .join("\n")
    : "无";
  const logsText = state?.logs?.length
    ? state.logs
        .slice(-12)
        .map((item) => formatLogLine(item, env.TIME_ZONE || DEFAULT_TIME_ZONE))
        .join("\n")
    : "无";

  const response = await fetch(`${env.MODEL_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.MODEL_API_KEY}`
    },
    body: JSON.stringify({
      model: env.MODEL_NAME || "auto",
      messages: [
        {
          role: "system",
          content: [
            "你是一个轻量云端 OpenClaw 智能体，通过 Telegram 为用户工作。",
            "默认使用中文，回答要准确、简洁、可执行。",
            "你不能假装已经执行外部操作。需要执行时，引导用户使用中文命令。",
            "可用命令包括：帮助、状态、Worker状态、GitHub仓库、管理员、记住、记忆、忘记、提醒、提醒列表、取消提醒、待办、待办列表、完成、删除待办、收藏、收藏夹、删除收藏、复盘、日志、日志列表、日报、周报、订阅日报、订阅周报、查找、备份、备份列表、恢复备份、删除备份、确认、取消操作、搜索、网页。",
            "",
            "用户记忆：",
            memoryText,
            "",
            "待提醒：",
            remindersText,
            "",
            "待办：",
            todosText,
            "",
            "收藏：",
            bookmarksText,
            "",
            "近期日志：",
            logsText
          ].join("\n")
        },
        {
          role: "user",
          content: userText
        }
      ],
      temperature: 0.4
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Model API failed: ${response.status} ${details}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim();
}

async function searchWeb(env, query) {
  if (env.BRAVE_API_KEY) {
    return searchBrave(env, query);
  }
  if (env.SERPER_API_KEY) {
    return searchSerper(env, query);
  }
  return searchDuckDuckGo(query);
}

async function searchBrave(env, query) {
  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
    headers: {
      accept: "application/json",
      "x-subscription-token": env.BRAVE_API_KEY
    }
  });
  if (!response.ok) {
    throw new Error(`Brave search failed: ${response.status}`);
  }
  const data = await response.json();
  return (data.web?.results || []).slice(0, 5).map((item) => ({
    title: cleanText(item.title),
    url: item.url,
    snippet: cleanText(item.description || "")
  }));
}

async function searchSerper(env, query) {
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.SERPER_API_KEY
    },
    body: JSON.stringify({ q: query, num: 5 })
  });
  if (!response.ok) {
    throw new Error(`Serper search failed: ${response.status}`);
  }
  const data = await response.json();
  return (data.organic || []).slice(0, 5).map((item) => ({
    title: cleanText(item.title),
    url: item.link,
    snippet: cleanText(item.snippet || "")
  }));
}

async function searchDuckDuckGo(query) {
  const response = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: ${response.status}`);
  }
  const data = await response.json();
  const results = [];

  if (data.AbstractText && data.AbstractURL) {
    results.push({
      title: data.Heading || query,
      url: data.AbstractURL,
      snippet: data.AbstractText
    });
  }

  for (const topic of data.RelatedTopics || []) {
    if (topic.Text && topic.FirstURL) {
      results.push({
        title: topic.Text.split(" - ")[0].slice(0, 120),
        url: topic.FirstURL,
        snippet: topic.Text
      });
    }
    if (Array.isArray(topic.Topics)) {
      for (const nested of topic.Topics) {
        if (nested.Text && nested.FirstURL) {
          results.push({
            title: nested.Text.split(" - ")[0].slice(0, 120),
            url: nested.FirstURL,
            snippet: nested.Text
          });
        }
      }
    }
  }

  return results.slice(0, 5);
}

function renderSearchResults(results) {
  return [
    "搜索结果：",
    ...results.map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.snippet}`)
  ].join("\n\n");
}

function buildPersonalSearchIndex(state, timeZone) {
  const items = [];

  for (const item of state.memories) {
    items.push({
      type: "记忆",
      id: item.id,
      date: item.createdAt,
      title: item.text,
      searchText: [item.text, item.id, item.createdAt].join(" ")
    });
  }

  for (const item of state.todos) {
    const status = item.doneAt ? "已完成" : "待办";
    items.push({
      type: status,
      id: item.id,
      date: item.doneAt || item.createdAt,
      title: item.text,
      searchText: [status, item.text, item.id, item.createdAt, item.doneAt].join(" ")
    });
  }

  for (const item of state.reminders) {
    const status = item.sentAt ? "已提醒" : "待提醒";
    items.push({
      type: status,
      id: item.id,
      date: item.dueAt,
      title: item.text,
      extra: formatDate(item.dueAt, timeZone),
      searchText: [status, item.text, item.id, item.dueAt, item.sentAt].join(" ")
    });
  }

  for (const item of state.bookmarks) {
    items.push({
      type: "收藏",
      id: item.id,
      date: item.createdAt,
      title: item.note || item.url,
      extra: item.note ? item.url : "",
      searchText: ["收藏", item.note, item.url, item.id, item.createdAt].join(" ")
    });
  }

  for (const item of state.logs) {
    items.push({
      type: `${item.type || "通用"}日志`,
      id: item.id,
      date: item.createdAt,
      title: item.text,
      searchText: [item.type || "通用", "日志", item.text, item.id, item.createdAt].join(" ")
    });
  }

  return items.sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));
}

function matchesSearchQuery(text, query) {
  const haystack = String(text || "").toLowerCase();
  const terms = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return terms.length > 0 && terms.every((term) => haystack.includes(term));
}

function formatPersonalSearchHit(item) {
  return [`[${item.type}] #${item.id}`, item.extra || "", item.title].filter(Boolean).join(" ");
}

function snapshotCoreState(state) {
  return {
    memories: cloneJson(Array.isArray(state?.memories) ? state.memories : []).slice(-MAX_MEMORY_ITEMS),
    reminders: cloneJson(Array.isArray(state?.reminders) ? state.reminders : []).slice(-MAX_REMINDERS),
    todos: cloneJson(Array.isArray(state?.todos) ? state.todos : []).slice(-MAX_TODOS),
    bookmarks: cloneJson(Array.isArray(state?.bookmarks) ? state.bookmarks : []).slice(-MAX_BOOKMARKS),
    logs: cloneJson(Array.isArray(state?.logs) ? state.logs : []).slice(-MAX_LOGS),
    reports: normalizeReports(state?.reports)
  };
}

function normalizeBackups(backups) {
  if (!Array.isArray(backups)) {
    return [];
  }

  return backups
    .filter((item) => item && Number.isInteger(Number(item.id)) && item.state)
    .map((item) => ({
      id: Number(item.id),
      note: cleanText(item.note).slice(0, 120),
      createdAt: item.createdAt || new Date(0).toISOString(),
      state: snapshotCoreState(item.state)
    }))
    .slice(-MAX_BACKUPS);
}

function formatBackupLine(item, timeZone) {
  return [
    `#${item.id}`,
    formatDate(item.createdAt, timeZone),
    item.note ? `- ${item.note}` : "",
    `(${renderBackupCounts(item.state)})`
  ].filter(Boolean).join(" ");
}

function renderBackupCounts(state) {
  const value = snapshotCoreState(state);
  return [
    `记忆 ${value.memories.length}`,
    `待办 ${value.todos.length}`,
    `提醒 ${value.reminders.length}`,
    `收藏 ${value.bookmarks.length}`,
    `日志 ${value.logs.length}`
  ].join(" / ");
}

async function requestOperationConfirmation(env, chatId, body) {
  const label = classifySensitiveOperation(body);
  if (!label) {
    return "";
  }
  if (!env.OPENCLAW_KV) {
    return "这个操作需要确认，但 KV 未配置，无法保存确认状态。";
  }

  const token = createConfirmationToken();
  const pending = {
    token,
    command: body,
    label,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + CONFIRMATION_TTL_SECONDS * 1000).toISOString()
  };
  await env.OPENCLAW_KV.put(pendingKey(chatId), JSON.stringify(pending), {
    expirationTtl: CONFIRMATION_TTL_SECONDS + 60
  });
  await recordAudit(env, {
    chatId,
    action: "confirmation_requested",
    target: label,
    status: "pending"
  });

  return [
    `需要确认：${label}`,
    `原命令：${body}`,
    `${CONFIRMATION_TTL_SECONDS / 60} 分钟内回复：确认 ${token}`,
    "放弃请回复：取消操作"
  ].join("\n");
}

async function confirmPendingOperation(env, chatId, input) {
  const pending = await loadPendingOperation(env, chatId);
  if (!pending) {
    return "当前没有待确认操作。";
  }

  const token = cleanText(input);
  if (!token || token !== pending.token) {
    return "确认码不正确。请按提示回复完整确认码，或回复「取消操作」。";
  }

  await deletePendingOperation(env, chatId);
  await recordAudit(env, {
    chatId,
    action: "confirmation_accepted",
    target: pending.label,
    status: "confirmed"
  });
  return routeMessage(env, chatId, pending.command, { confirmed: true });
}

async function cancelPendingOperation(env, chatId) {
  const pending = await loadPendingOperation(env, chatId);
  if (!pending) {
    return "当前没有待确认操作。";
  }

  await deletePendingOperation(env, chatId);
  await recordAudit(env, {
    chatId,
    action: "confirmation_cancelled",
    target: pending.label,
    status: "cancelled"
  });
  return `已取消：${pending.label}`;
}

async function loadPendingOperation(env, chatId) {
  if (!env.OPENCLAW_KV) {
    return null;
  }
  const pending = await env.OPENCLAW_KV.get(pendingKey(chatId), "json");
  if (!pending || Date.parse(pending.expiresAt) <= Date.now()) {
    await deletePendingOperation(env, chatId);
    return null;
  }
  return pending;
}

async function deletePendingOperation(env, chatId) {
  if (env.OPENCLAW_KV?.delete) {
    await env.OPENCLAW_KV.delete(pendingKey(chatId));
  }
}

function classifySensitiveOperation(body) {
  const payload = commandPayload(body);
  if (startsCommand(body, ["触发部署", "重新部署", "deploy"])) {
    return "触发部署";
  }
  if (startsCommand(body, ["添加用户", "允许用户", "user_add"])) {
    return "添加白名单用户";
  }
  if (startsCommand(body, ["删除用户", "移除用户", "user_del"])) {
    return "删除白名单用户";
  }
  if (startsCommand(body, ["恢复备份", "还原备份", "restore_backup"])) {
    return "恢复备份并覆盖当前状态";
  }
  if (startsCommand(body, ["删除备份", "清理备份", "backup_del"])) {
    return "删除备份";
  }
  if (startsCommand(body, ["忘记", "删除记忆", "memory_del"]) && isAllTarget(payload)) {
    return "清空全部记忆";
  }
  if (startsCommand(body, ["取消提醒", "删除提醒", "cancel_reminder"]) && isAllTarget(payload)) {
    return "取消全部提醒";
  }
  if (startsCommand(body, ["删除待办", "取消待办", "todo_del"]) && isAllTarget(payload)) {
    return "删除全部待办";
  }
  if (startsCommand(body, ["删除收藏", "取消收藏", "bookmark_del"]) && isAllTarget(payload)) {
    return "删除全部收藏";
  }
  if (startsCommand(body, ["删除日志", "清理日志", "log_del"]) && isAllTarget(payload)) {
    return "删除全部日志";
  }
  return "";
}

function createConfirmationToken() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().slice(0, 8);
  }
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isAllTarget(value) {
  const target = String(value || "").trim().toLowerCase();
  return target === "全部" || target === "all";
}

function pendingKey(chatId) {
  return `pending:${chatId}`;
}

async function enforceRateLimit(env, chatId) {
  if (!env.OPENCLAW_KV) {
    return { allowed: true, count: 0, max: RATE_LIMIT_MAX_REQUESTS, retryAfterSeconds: 0 };
  }

  const key = `rate:${chatId}`;
  const now = Date.now();
  const current = await env.OPENCLAW_KV.get(key, "json");
  const windowStartedAt = Date.parse(current?.windowStartedAt || 0);
  const ageSeconds = Number.isFinite(windowStartedAt) ? (now - windowStartedAt) / 1000 : RATE_LIMIT_WINDOW_SECONDS + 1;
  const next = ageSeconds >= RATE_LIMIT_WINDOW_SECONDS
    ? { windowStartedAt: new Date(now).toISOString(), count: 1 }
    : { windowStartedAt: current.windowStartedAt, count: Number(current.count || 0) + 1 };

  await env.OPENCLAW_KV.put(key, JSON.stringify(next), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS * 2
  });

  const allowed = next.count <= RATE_LIMIT_MAX_REQUESTS;
  const retryAfterSeconds = allowed
    ? 0
    : Math.max(1, Math.ceil(RATE_LIMIT_WINDOW_SECONDS - (Date.now() - Date.parse(next.windowStartedAt)) / 1000));

  return {
    allowed,
    count: next.count,
    max: RATE_LIMIT_MAX_REQUESTS,
    retryAfterSeconds
  };
}

async function isAllowedChat(env, chatId) {
  const security = await loadSecurityState(env);
  const allowed = uniqueIds([
    ...getConfiguredAllowedChatIds(env),
    ...getAdminChatIds(env),
    ...security.allowedChatIds
  ]);
  return !allowed.length || allowed.includes(String(chatId));
}

async function isAdminChat(env, chatId) {
  const admins = getAdminChatIds(env);
  if (admins.length) {
    return admins.includes(String(chatId));
  }
  const configured = getConfiguredAllowedChatIds(env);
  return configured.includes(String(chatId));
}

async function requireAdmin(env, chatId) {
  if (await isAdminChat(env, chatId)) {
    return "";
  }
  await recordAudit(env, {
    chatId,
    action: "admin_command",
    target: chatId,
    status: "denied"
  });
  return "只有管理员可以执行这个命令。";
}

async function loadSecurityState(env) {
  if (!env.OPENCLAW_KV) {
    return normalizeSecurityState(null);
  }
  const value = await env.OPENCLAW_KV.get(SECURITY_KEY, "json");
  return normalizeSecurityState(value);
}

async function saveSecurityState(env, state) {
  if (!env.OPENCLAW_KV) {
    return false;
  }
  await env.OPENCLAW_KV.put(SECURITY_KEY, JSON.stringify(normalizeSecurityState(state)));
  return true;
}

function normalizeSecurityState(state) {
  const notes = typeof state?.userNotes === "object" && state.userNotes ? state.userNotes : {};
  return {
    allowedChatIds: uniqueIds(Array.isArray(state?.allowedChatIds) ? state.allowedChatIds : []),
    userNotes: Object.fromEntries(Object.entries(notes).map(([id, note]) => [String(id), cleanText(note).slice(0, 80)]))
  };
}

function getConfiguredAllowedChatIds(env) {
  return parseChatIdList(env.ALLOWED_CHAT_ID);
}

function getAdminChatIds(env) {
  const configured = parseChatIdList(env.ADMIN_CHAT_ID);
  return configured.length ? configured : getConfiguredAllowedChatIds(env);
}

function parseChatIdList(value) {
  return uniqueIds(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function uniqueIds(items) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function parseUserInput(input) {
  const value = cleanText(input);
  const match = value.match(/^(-?\d+)(?:\s+(.+))?$/);
  if (!match) {
    return { chatId: "", note: "" };
  }
  return {
    chatId: match[1],
    note: cleanText(match[2] || "").slice(0, 80)
  };
}

function formatAllowedUser(id, security) {
  const note = security.userNotes[id];
  return note ? `${id}（${note}）` : id;
}

async function recordAudit(env, entry) {
  if (!env.OPENCLAW_KV) {
    return;
  }
  const logs = await loadAuditLogs(env);
  logs.push({
    id: nextId(logs),
    chatId: String(entry.chatId || ""),
    action: cleanText(entry.action).slice(0, 80),
    target: cleanText(entry.target).slice(0, 180),
    status: cleanText(entry.status || "done").slice(0, 40),
    createdAt: new Date().toISOString()
  });
  await env.OPENCLAW_KV.put(AUDIT_KEY, JSON.stringify(logs.slice(-MAX_AUDIT_LOGS)));
}

async function loadAuditLogs(env) {
  if (!env.OPENCLAW_KV) {
    return [];
  }
  const logs = await env.OPENCLAW_KV.get(AUDIT_KEY, "json");
  return Array.isArray(logs) ? logs : [];
}

async function recordError(env, entry) {
  if (!env.OPENCLAW_KV) {
    return;
  }
  const logs = await loadErrorLogs(env);
  logs.push({
    id: nextId(logs),
    chatId: String(entry.chatId || ""),
    command: cleanText(entry.command).slice(0, 200),
    message: cleanText(entry.message).slice(0, 500),
    createdAt: new Date().toISOString()
  });
  await env.OPENCLAW_KV.put(ERROR_KEY, JSON.stringify(logs.slice(-MAX_ERROR_LOGS)));
}

async function loadErrorLogs(env) {
  if (!env.OPENCLAW_KV) {
    return [];
  }
  const logs = await env.OPENCLAW_KV.get(ERROR_KEY, "json");
  return Array.isArray(logs) ? logs : [];
}

function formatAuditLine(item, timeZone) {
  return `#${item.id} ${formatDate(item.createdAt, timeZone)} [${item.status}] ${item.action} ${item.target || ""}`.trim();
}

function formatErrorLine(item, timeZone) {
  return `#${item.id} ${formatDate(item.createdAt, timeZone)} ${item.command || "未知命令"} - ${item.message}`;
}

function parseListCount(input, fallback, max) {
  const count = Number(String(input || "").match(/\d+/)?.[0] || fallback);
  if (!Number.isInteger(count) || count <= 0) {
    return fallback;
  }
  return Math.min(count, max);
}

function deployTriggerMode(env) {
  if (env.DEPLOY_HOOK_URL) {
    return "Deploy Hook";
  }
  if (env.GITHUB_TOKEN) {
    return "GitHub Actions";
  }
  return "未配置";
}

function missingCloudflareConfig(env) {
  return [
    env.CLOUDFLARE_API_TOKEN ? "" : "CLOUDFLARE_API_TOKEN",
    env.CLOUDFLARE_ACCOUNT_ID ? "" : "CLOUDFLARE_ACCOUNT_ID",
    env.CLOUDFLARE_WORKER_NAME ? "" : "CLOUDFLARE_WORKER_NAME"
  ].filter(Boolean);
}

async function fetchCloudflareDeployments(env, limit) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const scriptName = env.CLOUDFLARE_WORKER_NAME || DEFAULT_WORKER_NAME;
  const data = await cloudflareRequest(env, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/deployments`);
  const deployments = Array.isArray(data.result?.deployments) ? data.result.deployments : [];
  return deployments.slice(0, limit);
}

async function cloudflareRequest(env, path) {
  const response = await fetch(`${CLOUDFLARE_API}${path}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`
    }
  });
  const data = await safeJson(response);
  if (!response.ok || data?.success === false) {
    throw new Error(`Cloudflare API failed: ${response.status} ${cloudflareErrorMessage(data)}`);
  }
  return data;
}

function cloudflareErrorMessage(data) {
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  return errors.map((item) => item.message).filter(Boolean).join("; ") || "unknown error";
}

function formatDeploymentLine(item, timeZone) {
  const version = item.versions?.[0];
  const versionText = version?.version_id ? `版本 ${shortId(version.version_id)} ${version.percentage || 100}%` : "版本未知";
  const message = item.annotations?.["workers/message"] || "";
  const trigger = item.annotations?.["workers/triggered_by"] || item.source || "";
  return [
    shortId(item.id),
    item.created_on ? formatDate(item.created_on, timeZone) : "时间未知",
    versionText,
    trigger ? `触发：${trigger}` : "",
    message ? `说明：${cleanText(message).slice(0, 80)}` : ""
  ].filter(Boolean).join(" | ");
}

async function githubRequest(env, path, options = {}, okStatuses = [200]) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2026-03-10",
    "user-agent": `OpenClawLiteAgent/${VERSION}`,
    ...(options.headers || {})
  };
  if (env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  }
  if (options.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers
  });
  const data = await safeJson(response);
  if (!okStatuses.includes(response.status)) {
    throw new Error(`GitHub API failed: ${response.status} ${data?.message || "unknown error"}`);
  }
  return data;
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { message: text.slice(0, 500) };
  }
}

async function safeResponseText(response) {
  return (await response.text()).slice(0, 500);
}

function shortId(value) {
  return String(value || "").slice(0, 8);
}

function renderStateSnapshot(env, state) {
  const activeTodos = state.todos.filter((item) => !item.doneAt);
  const pendingReminders = state.reminders
    .filter((item) => !item.sentAt)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));

  return [
    "轻量复盘",
    "",
    "记忆：",
    state.memories.length ? state.memories.slice(-10).map((item) => `#${item.id} ${item.text}`).join("\n") : "无",
    "",
    "待办：",
    activeTodos.length ? activeTodos.map((item) => `#${item.id} ${item.text}`).join("\n") : "无",
    "",
    "提醒：",
    pendingReminders.length
      ? pendingReminders.map((item) => `#${item.id} ${formatDate(item.dueAt, env.TIME_ZONE || DEFAULT_TIME_ZONE)} - ${item.text}`).join("\n")
      : "无",
    "",
    "收藏：",
    state.bookmarks.length ? state.bookmarks.slice(-10).map((item) => formatBookmarkLine(item)).join("\n") : "无",
    "",
    "近期日志：",
    state.logs.length
      ? state.logs.slice(-12).map((item) => formatLogLine(item, env.TIME_ZONE || DEFAULT_TIME_ZONE)).join("\n")
      : "无"
  ].join("\n");
}

function renderPeriodSnapshot(env, state, logs, period) {
  const timeZone = env.TIME_ZONE || DEFAULT_TIME_ZONE;
  const activeTodos = state.todos.filter((item) => !item.doneAt);
  const pendingReminders = state.reminders
    .filter((item) => !item.sentAt)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const tradeLogs = logs.filter((item) => item.type === "交易");
  const projectLogs = logs.filter((item) => item.type === "项目");
  const generalLogs = logs.filter((item) => item.type === "通用");

  return [
    period === "day" ? `日报 ${dayKey(new Date(), timeZone)}` : `周报 近 7 天`,
    "",
    "日志：",
    logs.length ? logs.map((item) => formatLogLine(item, timeZone)).join("\n") : "无",
    "",
    "项目日志：",
    projectLogs.length ? projectLogs.map((item) => formatLogLine(item, timeZone)).join("\n") : "无",
    "",
    "交易日志：",
    tradeLogs.length ? tradeLogs.map((item) => formatLogLine(item, timeZone)).join("\n") : "无",
    "",
    "通用日志：",
    generalLogs.length ? generalLogs.map((item) => formatLogLine(item, timeZone)).join("\n") : "无",
    "",
    "待办：",
    activeTodos.length ? activeTodos.map((item) => `#${item.id} ${item.text}`).join("\n") : "无",
    "",
    "待提醒：",
    pendingReminders.length
      ? pendingReminders.map((item) => `#${item.id} ${formatDate(item.dueAt, timeZone)} - ${item.text}`).join("\n")
      : "无",
    "",
    "记忆：",
    state.memories.length ? state.memories.slice(-10).map((item) => `#${item.id} ${item.text}`).join("\n") : "无",
    "",
    "收藏：",
    state.bookmarks.length ? state.bookmarks.slice(-10).map((item) => formatBookmarkLine(item)).join("\n") : "无"
  ].join("\n");
}

function formatBookmarkLine(item) {
  return [`#${item.id}`, item.note || "", item.url].filter(Boolean).join(" ");
}

function formatLogLine(item, timeZone) {
  return `#${item.id} [${item.type || "通用"}] ${formatDate(item.createdAt, timeZone)} - ${item.text}`;
}

function parseLogType(text) {
  const value = String(text || "").trim();
  if (!value) {
    return "";
  }
  if (value.includes("交易")) {
    return "交易";
  }
  if (value.includes("项目")) {
    return "项目";
  }
  if (value.includes("通用")) {
    return "通用";
  }
  return "";
}

function filterLogsByPeriod(logs, period, timeZone) {
  const items = Array.isArray(logs) ? logs : [];
  if (period === "day") {
    const today = dayKey(new Date(), timeZone);
    return items.filter((item) => dayKey(item.createdAt, timeZone) === today);
  }

  const lowerBound = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return items.filter((item) => Date.parse(item.createdAt) >= lowerBound);
}

function defaultReports() {
  return {
    daily: { enabled: false, hour: 21, minute: 30, lastSentKey: "" },
    weekly: { enabled: false, weekday: 0, hour: 21, minute: 30, lastSentKey: "" }
  };
}

function normalizeReports(reports) {
  const defaults = defaultReports();
  return {
    daily: {
      ...defaults.daily,
      ...(reports?.daily || {}),
      enabled: Boolean(reports?.daily?.enabled)
    },
    weekly: {
      ...defaults.weekly,
      ...(reports?.weekly || {}),
      enabled: Boolean(reports?.weekly?.enabled),
      weekday: normalizeWeekday(reports?.weekly?.weekday ?? defaults.weekly.weekday)
    }
  };
}

function shouldSendDailyReport(report, now, timeZone) {
  if (!report?.enabled || !isReportTimeDue(report, now, timeZone)) {
    return false;
  }
  return report.lastSentKey !== dayKey(now, timeZone);
}

function shouldSendWeeklyReport(report, now, timeZone) {
  if (!report?.enabled || currentWeekday(now, timeZone) !== report.weekday || !isReportTimeDue(report, now, timeZone)) {
    return false;
  }
  return report.lastSentKey !== `week:${dayKey(now, timeZone)}`;
}

function isReportTimeDue(report, now, timeZone) {
  const parts = getZonedParts(now, timeZone);
  const currentMinutes = parts.hour * 60 + parts.minute;
  const targetMinutes = Number(report.hour) * 60 + Number(report.minute || 0);
  return currentMinutes >= targetMinutes;
}

function renderReportSubscriptions(reports) {
  const value = normalizeReports(reports);
  const daily = value.daily.enabled ? `日报每天 ${formatTimeOfDay(value.daily)}` : "日报关闭";
  const weekly = value.weekly.enabled ? `周报每${formatWeekday(value.weekly.weekday)} ${formatTimeOfDay(value.weekly)}` : "周报关闭";
  return `${daily}；${weekly}`;
}

function parseTimeOfDay(input) {
  const match = String(input || "").match(/(\d{1,2})(?:[:：点时](\d{1,2})?)?/);
  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2] || "0");
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function parseWeekday(input) {
  const value = String(input || "");
  const match = value.match(/(?:周|星期|礼拜)([一二三四五六日天1-7])/);
  if (!match) {
    return null;
  }
  return normalizeWeekday({
    日: 0,
    天: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 0
  }[match[1]]);
}

function normalizeWeekday(value) {
  const weekday = Number(value);
  if (!Number.isInteger(weekday)) {
    return 0;
  }
  return ((weekday % 7) + 7) % 7;
}

function currentWeekday(value, timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(value));
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name] ?? 0;
}

function formatTimeOfDay(value) {
  return `${String(value.hour).padStart(2, "0")}:${String(value.minute || 0).padStart(2, "0")}`;
}

function formatWeekday(value) {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][normalizeWeekday(value)];
}

function dayKey(value, timeZone) {
  const parts = getZonedParts(new Date(value), timeZone);
  return [
    String(parts.year),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0")
  ].join("-");
}

async function fetchReadablePage(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": `OpenClawLiteAgent/${VERSION} (+https://workers.cloudflare.com)`
    }
  });
  if (!response.ok) {
    throw new Error(`Page fetch failed: ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    return { title: "", text: `该链接返回 ${contentType || "非文本内容"}，暂不支持直接总结。` };
  }

  const raw = await response.text();
  if (contentType.includes("text/plain")) {
    return { title: "", text: cleanText(raw).slice(0, MAX_PAGE_CHARS) };
  }

  const title = decodeHtml((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim());
  const withoutNoise = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  const text = cleanText(decodeHtml(withoutNoise.replace(/<[^>]+>/g, " "))).slice(0, MAX_PAGE_CHARS);
  return { title, text };
}

async function runScheduledJobs(env) {
  await sendDueReminders(env);
  await sendDueReports(env);
}

async function sendDueReminders(env) {
  if (!env.OPENCLAW_KV) {
    return;
  }

  const now = Date.now();
  const list = await env.OPENCLAW_KV.list({ prefix: "chat:" });
  for (const key of list.keys) {
    if (!key.name.endsWith(":state")) {
      continue;
    }
    const chatId = key.name.slice("chat:".length, -":state".length);
    const state = await loadState(env, chatId);
    const due = state.reminders.filter((item) => !item.sentAt && Date.parse(item.dueAt) <= now);
    if (!due.length) {
      continue;
    }

    for (const item of due) {
      await sendTelegramMessage(env, chatId, `提醒 #${item.id}：${item.text}`);
      item.sentAt = new Date().toISOString();
    }

    state.reminders = state.reminders.filter((item) => !item.sentAt || Date.parse(item.sentAt) > now - 7 * 24 * 60 * 60 * 1000);
    await saveState(env, chatId, state);
  }
}

async function sendDueReports(env) {
  if (!env.OPENCLAW_KV) {
    return;
  }

  const now = new Date();
  const timeZone = env.TIME_ZONE || DEFAULT_TIME_ZONE;
  const list = await env.OPENCLAW_KV.list({ prefix: "chat:" });
  for (const key of list.keys) {
    if (!key.name.endsWith(":state")) {
      continue;
    }

    const chatId = key.name.slice("chat:".length, -":state".length);
    const state = await loadState(env, chatId);
    let changed = false;

    if (shouldSendDailyReport(state.reports.daily, now, timeZone)) {
      const keyValue = dayKey(now, timeZone);
      const report = await periodReport(env, chatId, "day");
      await sendTelegramMessage(env, chatId, `自动日报\n\n${report}`);
      state.reports.daily.lastSentKey = keyValue;
      changed = true;
    }

    if (shouldSendWeeklyReport(state.reports.weekly, now, timeZone)) {
      const keyValue = `week:${dayKey(now, timeZone)}`;
      const report = await periodReport(env, chatId, "week");
      await sendTelegramMessage(env, chatId, `自动周报\n\n${report}`);
      state.reports.weekly.lastSentKey = keyValue;
      changed = true;
    }

    if (changed) {
      await saveState(env, chatId, state);
    }
  }
}

async function loadState(env, chatId) {
  const fallback = { memories: [], reminders: [], todos: [], bookmarks: [], logs: [], reports: defaultReports(), backups: [] };
  if (!env.OPENCLAW_KV) {
    return fallback;
  }

  const value = await env.OPENCLAW_KV.get(stateKey(chatId), "json");
  return normalizeState(value || fallback);
}

async function saveState(env, chatId, state) {
  if (!env.OPENCLAW_KV) {
    return false;
  }
  await env.OPENCLAW_KV.put(stateKey(chatId), JSON.stringify(normalizeState(state)));
  return true;
}

function normalizeState(state) {
  return {
    memories: Array.isArray(state?.memories) ? state.memories : [],
    reminders: Array.isArray(state?.reminders) ? state.reminders : [],
    todos: Array.isArray(state?.todos) ? state.todos : [],
    bookmarks: Array.isArray(state?.bookmarks) ? state.bookmarks : [],
    logs: Array.isArray(state?.logs) ? state.logs : [],
    reports: normalizeReports(state?.reports),
    backups: normalizeBackups(state?.backups)
  };
}

function stateKey(chatId) {
  return `chat:${chatId}:state`;
}

function parseReminder(input, timeZone) {
  const trimmed = input.trim();
  let match = trimmed.match(/^(\d+)\s*(分钟|分|小时|时|天)后\s+(.+)$/);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const text = match[3].trim();
    const multiplier = unit.startsWith("分") ? 60 * 1000 : unit.startsWith("天") ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
    return { dueAt: new Date(Date.now() + amount * multiplier), text };
  }

  match = trimmed.match(/^(今天|明天)\s*(\d{1,2})(?:[:：点时](\d{1,2})?)?\s*(.+)$/);
  if (match) {
    const now = getZonedParts(new Date(), timeZone);
    const dayOffset = match[1] === "明天" ? 1 : 0;
    const date = zonedDateToUtc({
      year: now.year,
      month: now.month,
      day: now.day + dayOffset,
      hour: Number(match[2]),
      minute: Number(match[3] || "0")
    }, timeZone);
    return { dueAt: date, text: match[4].trim() };
  }

  match = trimmed.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s+(\d{1,2})(?:[:：点时](\d{1,2})?)?\s*(.+)$/);
  if (match) {
    return {
      dueAt: zonedDateToUtc({
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4]),
        minute: Number(match[5] || "0")
      }, timeZone),
      text: match[6].trim()
    };
  }

  match = trimmed.match(/^(\d{1,2})月(\d{1,2})日?\s+(\d{1,2})(?:[:：点时](\d{1,2})?)?\s*(.+)$/);
  if (match) {
    const now = getZonedParts(new Date(), timeZone);
    return {
      dueAt: zonedDateToUtc({
        year: now.year,
        month: Number(match[1]),
        day: Number(match[2]),
        hour: Number(match[3]),
        minute: Number(match[4] || "0")
      }, timeZone),
      text: match[5].trim()
    };
  }

  return null;
}

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function zonedDateToUtc(parts, timeZone) {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute || 0, 0);
  const actual = new Date(utcGuess);
  const zoned = getZonedParts(actual, timeZone);
  const offsetMs = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second) - utcGuess;
  return new Date(utcGuess - offsetMs);
}

function formatDate(value, timeZone) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

async function sendTelegramMessage(env, chatId, text) {
  const chunks = splitTelegramMessage(text);
  for (const chunk of chunks) {
    await telegramCall(env, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true
    });
  }
}

async function sendTelegramChatAction(env, chatId, action) {
  await telegramCall(env, "sendChatAction", {
    chat_id: chatId,
    action
  });
}

async function telegramCall(env, method, payload) {
  const response = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Telegram ${method} failed: ${response.status} ${details}`);
  }

  return response.json();
}

function normalizeMessage(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function stripBotMention(text) {
  return text.replace(/^\/([^\s@]+)@[^\s]+\s*/i, "/$1 ").trim();
}

function isCommand(text, names) {
  const normalized = text.replace(/^\//, "").trim().toLowerCase();
  return names.some((name) => normalized === name.toLowerCase());
}

function startsCommand(text, names) {
  const normalized = text.replace(/^\//, "").trim();
  return names.some((name) => normalized === name || normalized.toLowerCase().startsWith(`${name.toLowerCase()} `));
}

function commandPayload(text) {
  return text.replace(/^\//, "").replace(/^\S+\s*/, "").trim();
}

function nextId(items) {
  return items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
}

function parseIdList(text) {
  return String(text || "")
    .split(/[,\s，、]+/)
    .map((item) => Number(item.replace(/^#/, "")))
    .filter((id) => Number.isInteger(id));
}

function parseSingleId(text) {
  const id = Number(String(text || "").trim().replace(/^#/, ""));
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function getSearchProvider(env) {
  if (env.BRAVE_API_KEY) {
    return "Brave Search";
  }
  if (env.SERPER_API_KEY) {
    return "Serper";
  }
  return "";
}

function extractUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : "";
}

function cleanText(text) {
  return decodeHtml(String(text || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function splitTelegramMessage(text) {
  const maxLength = 3900;
  const chunks = [];
  const value = String(text || "");
  for (let index = 0; index < value.length; index += maxLength) {
    chunks.push(value.slice(index, index + maxLength));
  }
  return chunks.length ? chunks : [""];
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}
