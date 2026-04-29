import { Router } from "express";

const router = Router();

// ─── In-memory alert config (persists while server runs) ─────────────────────
let alertConfig = {
  telegram: {
    enabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId:   process.env.TELEGRAM_CHAT_ID   ?? "",
  },
};

// ─── Telegram sender ──────────────────────────────────────────────────────────
async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json() as any;
    return data.ok === true;
  } catch {
    return false;
  }
}

// ─── Auto-alert on strong signals (called from bot or signal engine) ──────────
export async function sendSignalAlert(opts: {
  symbol: string; score: number; direction: string;
  mode: string; reasons: string[];
}) {
  if (!alertConfig.telegram.enabled) return;
  const { symbol, score, direction, mode, reasons } = opts;
  const coin = symbol.replace("USDT", "");
  const emoji = direction === "LONG" ? "🟢📈" : direction === "SHORT" ? "🔴📉" : "⚪";
  const modeEmoji = mode === "tiburon" ? "🦈" : mode === "ultra" ? "🚀" : mode === "risky" ? "⚡" : "🛡️";

  const text = [
    `${emoji} *SEÑAL ALL TRADING — ${coin}/USDT*`,
    ``,
    `*Score:* ${score}/100`,
    `*Dirección:* ${direction}`,
    `*Modo activo:* ${modeEmoji} ${mode.toUpperCase()}`,
    ``,
    `*Razones:*`,
    ...reasons.slice(0, 5).map(r => `• ${r.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&")}`),
    ``,
    `_${new Date().toLocaleTimeString("es-MX")} — ALL Trading Studio_`
  ].join("\n");

  await sendTelegram(alertConfig.telegram.botToken, alertConfig.telegram.chatId, text);
}

// ─── Captured chat ID storage ─────────────────────────────────────────────────
let capturedChatId: { chatId: string; name: string } | null = null;

// ─── POST /alerts/telegram/webhook — receives Telegram updates ────────────────
router.post("/alerts/telegram/webhook", async (req, res) => {
  const update = req.body as any;
  const msg = update?.message;
  const chat = msg?.chat;

  if (chat?.id) {
    capturedChatId = {
      chatId: String(chat.id),
      name: chat.first_name || chat.username || "Usuario",
    };
    console.log(`[Telegram] Chat ID capturado: ${capturedChatId.chatId} (${capturedChatId.name})`);

    const token = alertConfig.telegram.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
    if (token) {
      try {
        const sigRes = await fetch("http://localhost:" + (process.env.PORT || 8080) + "/api/signals/BTCUSDT", { signal: AbortSignal.timeout(4000) });
        const sig = await sigRes.json() as any;
        const score = sig?.score ?? "—";
        const dir = sig?.direction ?? "—";
        const price = sig?.price ? `$${Number(sig.price).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—";
        const tier = score >= 82 ? "🏆 PLATINUM" : score >= 68 ? "⭐ ORO" : score >= 58 ? "🥈 PLATA" : "⏳ ESPERAR";
        const dirEmoji = dir === "LONG" ? "🟢📈" : dir === "SHORT" ? "🔴📉" : "⚪";
        const reply = [
          `🦈 *ALL Trading Studio — En línea*`,
          ``,
          `*BTC/USDT* ${dirEmoji} ${price}`,
          `*Score:* ${score}/100 — ${tier}`,
          ``,
          `_Te avisaré cuando haya una entrada de alta convicción._`,
          `_${new Date().toLocaleTimeString("es-MX")} MX_`,
        ].join("\n");
        await sendTelegram(token, String(chat.id), reply);
      } catch {
        await sendTelegram(token, String(chat.id), `🦈 *ALL Trading Studio* — Estoy en línea. Te aviso cuando haya señal.`);
      }
    }
  }
  res.sendStatus(200);
});

// ─── GET /alerts/telegram/chatid — returns captured chat ID ──────────────────
router.get("/alerts/telegram/chatid", (_req, res) => {
  if (capturedChatId) {
    res.json({ ok: true, ...capturedChatId });
  } else {
    res.json({ ok: false, error: "Aún no se ha recibido ningún mensaje. Envía cualquier mensaje al bot." });
  }
});

// ─── GET /alerts/status ────────────────────────────────────────────────────────
router.get("/alerts/status", (_req, res) => {
  res.json({
    telegram: {
      enabled: alertConfig.telegram.enabled,
      configured: !!(alertConfig.telegram.botToken && alertConfig.telegram.chatId),
      instructions: alertConfig.telegram.enabled
        ? "Telegram configurado y activo."
        : "Para activar: crea un bot con @BotFather en Telegram, obtén el token y tu Chat ID, luego agrega TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID como secrets.",
    }
  });
});

// ─── POST /alerts/telegram/test ───────────────────────────────────────────────
router.post("/alerts/telegram/test", async (req, res): Promise<void> => {
  const { botToken, chatId } = req.body as { botToken?: string; chatId?: string };

  const token = botToken || alertConfig.telegram.botToken;
  const chat  = chatId  || alertConfig.telegram.chatId;

  if (!token || !chat) {
    res.status(400).json({ ok: false, error: "Falta botToken o chatId. Pásalos en el body o configura los secrets TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID." });
    return;
  }

  const text = [
    `🦈 *ALL Trading Studio — Test de Alertas*`,
    ``,
    `✅ Conexión exitosa. Recibirás alertas aquí cuando:`,
    `• El bot detecte señal Tiburón 🦈 (score >85)`,
    `• Señal Ultra 🚀 muy fuerte (score >80)`,
    `• Divergencia RSI crítica detectada`,
    ``,
    `_Conectado correctamente • ${new Date().toLocaleDateString("es-MX")}_`
  ].join("\n");

  const ok = await sendTelegram(token, chat, text);

  if (ok) {
    // Save config if provided in body
    if (botToken && chatId) {
      alertConfig.telegram = { enabled: true, botToken, chatId };
    }
    res.json({ ok: true, message: "Mensaje enviado. Revisa tu Telegram." });
  } else {
    res.status(500).json({ ok: false, error: "No se pudo enviar. Verifica que el token y chat ID son correctos." });
  }
});

// ─── POST /alerts/telegram/configure ─────────────────────────────────────────
router.post("/alerts/telegram/configure", (req, res) => {
  const { botToken, chatId } = req.body as { botToken: string; chatId: string };
  if (!botToken || !chatId) {
    res.status(400).json({ error: "Se requiere botToken y chatId" });
    return;
  }
  alertConfig.telegram = { enabled: true, botToken, chatId };
  res.json({ ok: true, message: "Configuración guardada. Usa /alerts/telegram/test para verificar." });
});

// ─── POST /alerts/send (manual signal push) ───────────────────────────────────
router.post("/alerts/send", async (req, res): Promise<void> => {
  const { symbol = "BTCUSDT", score = 85, direction = "LONG", mode = "tiburon", reasons = [] } = req.body;
  await sendSignalAlert({ symbol, score, direction, mode, reasons });
  res.json({ ok: true });
});

export default router;
