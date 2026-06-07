const TELEGRAM_API = "https://api.telegram.org";
const VERSION = "0.6.0";
const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const MAX_MEMORY_ITEMS = 30;
const MAX_REMINDERS = 50;
const MAX_TODOS = 50;
const MAX_BOOKMARKS = 50;
const MAX_LOGS = 120;
const MAX_BACKUPS = 5;
const MAX_SEARCH_RESULTS = 20;
const MAX_PAGE_CHARS = 12000;

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
        timeZone: env.TIME_ZONE || DEFAULT_TIME_ZONE
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
  if (!isAllowedChat(env, chatId)) {
    await sendTelegramMessage(env, chatId, "这个智能体当前只允许指定会话使用。");
    return json({ ok: true, ignored: "unauthorized_chat" });
  }

  const text = normalizeMessage(message.text);
  if (!text) {
    return json({ ok: true, ignored: "empty_text" });
  }

  try {
    ctx?.waitUntil?.(runScheduledJobs(env));
    await sendTelegramChatAction(env, chatId, "typing");

    const response = await routeMessage(env, chatId, text);
    await sendTelegramMessage(env, chatId, response);
    return json({ ok: true });
  } catch (error) {
    console.error(error);
    await sendTelegramMessage(env, chatId, "处理失败了，请稍后再试。");
    return json({ ok: false, error: "agent_failed" }, 500);
  }
}

async function routeMessage(env, chatId, text) {
  const body = stripBotMention(text);

  if (isCommand(body, ["帮助", "help", "start", "开始"])) {
    return helpText(env);
  }

  if (isCommand(body, ["状态", "status"])) {
    return statusText(env, chatId);
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
    "",
    `状态：记忆/提醒存储 ${storage}，搜索 ${search}。`
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
            "可用命令包括：帮助、状态、记住、记忆、忘记、提醒、提醒列表、取消提醒、待办、待办列表、完成、删除待办、收藏、收藏夹、删除收藏、复盘、日志、日志列表、日报、周报、订阅日报、订阅周报、查找、备份、备份列表、恢复备份、删除备份、搜索、网页。",
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

function isAllowedChat(env, chatId) {
  const allowed = String(env.ALLOWED_CHAT_ID || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return !allowed.length || allowed.includes(chatId);
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
