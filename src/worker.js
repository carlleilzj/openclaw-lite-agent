const TELEGRAM_API = "https://api.telegram.org";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "openclaw-lite-agent",
        endpoints: ["/telegram/webhook", "/health"]
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env);
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
};

async function handleTelegramWebhook(request, env) {
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
  if (env.ALLOWED_CHAT_ID && chatId !== String(env.ALLOWED_CHAT_ID)) {
    await sendTelegramMessage(env, chatId, "这个机器人当前只允许指定会话使用。");
    return json({ ok: true, ignored: "unauthorized_chat" });
  }

  const text = message.text.trim();
  if (text === "/start" || text === "/help") {
    await sendTelegramMessage(
      env,
      chatId,
      "我已经在线。直接发消息给我，我会调用云端模型回复。"
    );
    return json({ ok: true });
  }

  try {
    await sendTelegramChatAction(env, chatId, "typing");
    const answer = await askModel(env, text);
    await sendTelegramMessage(env, chatId, answer || "模型没有返回内容。");
    return json({ ok: true });
  } catch (error) {
    console.error(error);
    await sendTelegramMessage(env, chatId, "处理失败了，请稍后再试。");
    return json({ ok: false, error: "agent_failed" }, 500);
  }
}

async function askModel(env, userText) {
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
          content:
            "你是一个轻量云端智能体，回答要准确、简洁、可执行。默认使用中文。"
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

function splitTelegramMessage(text) {
  const maxLength = 3900;
  const chunks = [];
  for (let index = 0; index < text.length; index += maxLength) {
    chunks.push(text.slice(index, index + maxLength));
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
