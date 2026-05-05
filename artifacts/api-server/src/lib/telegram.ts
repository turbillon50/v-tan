const TAG = "[telegram]";

// ── Debounced batch sender for parameter-change notifications ─────────────────
interface ParamChangeEntry {
  emoji:  string;
  label:  string;
  param:  string;
  value:  string;
  reason: string;
}

let _paramBatch:   ParamChangeEntry[] = [];
let _paramFlushTimer: ReturnType<typeof setTimeout> | null = null;
const PARAM_DEBOUNCE_MS = 2000;

export function queueParamChange(
  type:   "evolución" | "estrategia" | "reset",
  param:  string,
  value:  string,
  reason: string,
): void {
  let entry: ParamChangeEntry;
  if (type === "evolución") {
    entry = { emoji: "✨", label: "EVOLUCIÓN", param, value, reason };
  } else if (type === "reset") {
    entry = { emoji: "🔄", label: "RESET", param, value, reason };
  } else {
    entry = { emoji: "⚙️", label: "ESTRATEGIA", param, value, reason };
  }

  _paramBatch.push(entry);

  if (_paramFlushTimer !== null) clearTimeout(_paramFlushTimer);

  _paramFlushTimer = setTimeout(() => {
    _paramFlushTimer = null;
    const batch = _paramBatch.splice(0);
    if (batch.length === 0) return;

    let msg: string;
    if (batch.length === 1) {
      const e = batch[0];
      msg = `${e.emoji} TANIT ${e.label}: ${e.param} = ${e.value}\nRazón: ${e.reason}`;
    } else {
      const lines = [`🔧 TANIT ACTUALIZACIÓN DE PARÁMETROS (${batch.length})`];
      for (const e of batch) {
        lines.push(`${e.emoji} ${e.label}: ${e.param} = ${e.value}`);
        if (e.reason) lines.push(`   Razón: ${e.reason}`);
      }
      msg = lines.join("\n");
    }

    sendTelegram(msg).catch(() => {});
  }, PARAM_DEBOUNCE_MS);
}
// ─────────────────────────────────────────────────────────────────────────────

export async function sendTelegram(msg: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "HTML" }),
      signal:  AbortSignal.timeout(6000),
    });
  } catch (e) {
    console.error(TAG, "Error enviando Telegram:", e);
  }
}

export function fmtTgTrade(
  event:       "OPEN" | "CLOSE",
  symbol:      string,
  side:        string,
  price:       number,
  leverage:    number,
  pnl?:        number,
  reason?:     string,
  score?:      number,
  mainReason?: string,
  holdMin?:    number,
): string {
  const coin = symbol.replace("USDT", "");
  const dir  = side === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const lev  = `${leverage}x`;

  if (event === "OPEN") {
    const scoreStr = score != null ? `Score: ${score}` : null;
    const razonStr = mainReason
      ? mainReason.replace(/[+-]?\d+pts?\.?/gi, "").replace(/\s{2,}/g, " ").trim()
      : null;
    const lines: string[] = [
      `⚡️ <b>NUEVA POSICIÓN</b>`,
      `${dir} <b>${coin}</b> @ $${price.toFixed(2)} · ${lev}`,
    ];
    if (scoreStr) lines.push(scoreStr);
    if (razonStr) lines.push(`📌 ${razonStr}`);
    return lines.join("\n");
  }

  const pnlStr = pnl != null
    ? (pnl >= 0 ? `+$${pnl.toFixed(2)} ✅` : `-$${Math.abs(pnl).toFixed(2)} ❌`)
    : "—";
  const durStr = holdMin != null
    ? (holdMin >= 60
        ? `${Math.floor(holdMin / 60)}h ${holdMin % 60}m`
        : `${holdMin}m`)
    : null;

  const lines: string[] = [
    `🏁 <b>POSICIÓN CERRADA</b>`,
    `${dir} <b>${coin}</b> · ${lev}`,
    `PnL: <b>${pnlStr}</b>`,
  ];
  if (durStr) lines.push(`Duración: ${durStr}`);
  if (reason) lines.push(`Razón: ${reason}`);
  return lines.join("\n");
}

// ── Polling de comandos entrantes ─────────────────────────────────────────────

interface TgMessage {
  chat: { id: number };
  from?: { id: number; username?: string };
  text?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

interface TgGetUpdatesResponse {
  ok: boolean;
  result: TgUpdate[];
}

type CommandHandler = (command: string, chatId: string) => Promise<string>;

let _commandHandler: CommandHandler | null = null;
let _lastUpdateId = 0;
let _pollingTimer: ReturnType<typeof setInterval> | null = null;
let _pollInFlight = false; // guard: prevent concurrent poll calls overlapping

// ── Audit ring buffer — últimos N intentos rechazados ─────────────────────────
export interface RejectedAttempt {
  ts:        number;   // epoch ms
  reason:    "chat_id_mismatch" | "user_id_not_allowed" | "rate_limited";
  chatId:    string;
  userId:    string;
  username?: string;
}
const AUDIT_MAX = 50;
const _auditBuffer: RejectedAttempt[] = [];

export function getTelegramAuditLog(): RejectedAttempt[] {
  return [..._auditBuffer];
}

export function clearTelegramAuditLog(): void {
  _auditBuffer.length = 0;
}

function pushAudit(entry: RejectedAttempt): void {
  _auditBuffer.unshift(entry);
  if (_auditBuffer.length > AUDIT_MAX) _auditBuffer.length = AUDIT_MAX;
}

// ── Rate limiting & audit log ────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS  = 60_000;
const RATE_LIMIT_DEFAULT    = 10;
function parseRateLimitMax(): number {
  const raw = process.env.TELEGRAM_RATE_LIMIT_PER_MIN;
  if (raw == null || raw === "") return RATE_LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 1000) {
    console.warn(TAG, `TELEGRAM_RATE_LIMIT_PER_MIN inválido (${raw}); usando ${RATE_LIMIT_DEFAULT}`);
    return RATE_LIMIT_DEFAULT;
  }
  return n;
}
const RATE_LIMIT_MAX        = parseRateLimitMax();
const _commandTimestamps: number[] = [];
let _rateLimitNotified = false;

// Throttle "rejected sender" log spam: at most one log per sender per 5 min
const REJECT_LOG_COOLDOWN_MS = 5 * 60_000;
const REJECT_LOG_MAX_ENTRIES = 500;
const _rejectLogLastAt = new Map<string, number>();

function pruneRejectLog(now: number): void {
  // Remove expired entries
  for (const [k, t] of _rejectLogLastAt) {
    if (now - t >= REJECT_LOG_COOLDOWN_MS) _rejectLogLastAt.delete(k);
  }
  // Hard cap: drop oldest if still oversized
  if (_rejectLogLastAt.size > REJECT_LOG_MAX_ENTRIES) {
    const sorted = [..._rejectLogLastAt.entries()].sort((a, b) => a[1] - b[1]);
    const toDrop = sorted.length - REJECT_LOG_MAX_ENTRIES;
    for (let i = 0; i < toDrop; i++) _rejectLogLastAt.delete(sorted[i][0]);
  }
}

function logRejectedSender(reason: "chat_id_mismatch" | "user_id_not_allowed", fromChatId: string, fromUserId: string, username: string | undefined): void {
  const key = `${reason}:${fromChatId}:${fromUserId}`;
  const now = Date.now();
  // Always push to audit buffer (every occurrence, not debounced)
  pushAudit({ ts: now, reason, chatId: fromChatId, userId: fromUserId, username });
  const last = _rejectLogLastAt.get(key) ?? 0;
  if (now - last < REJECT_LOG_COOLDOWN_MS) return;
  _rejectLogLastAt.set(key, now);
  if (_rejectLogLastAt.size > REJECT_LOG_MAX_ENTRIES) pruneRejectLog(now);
  const userPart = username ? ` (@${username})` : "";
  console.warn(TAG, `Rechazado [${reason}] chat_id=${fromChatId} user_id=${fromUserId}${userPart}`);
}

function parseAllowedUserIds(): Set<string> | null {
  const raw = process.env.TELEGRAM_ALLOWED_USER_IDS;
  if (!raw) return null;
  const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

/** Check rate limit; returns true if allowed, false if exceeded. */
function checkRateLimit(): boolean {
  const now = Date.now();
  // drop old timestamps
  while (_commandTimestamps.length > 0 && now - _commandTimestamps[0] > RATE_LIMIT_WINDOW_MS) {
    _commandTimestamps.shift();
  }
  if (_commandTimestamps.length >= RATE_LIMIT_MAX) return false;
  _commandTimestamps.push(now);
  return true;
}

/** Registra la función que se invoca cuando llega un comando de Telegram */
export function registerTelegramCommandHandler(handler: CommandHandler): void {
  _commandHandler = handler;
}

/** Inicia el polling de mensajes entrantes (llama una vez al arrancar el servidor) */
export function startTelegramPolling(): void {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn(TAG, "TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados — polling desactivado");
    return;
  }

  if (_pollingTimer) return; // ya está corriendo

  console.log(TAG, "Polling de comandos iniciado (cada 4s)");

  _pollingTimer = setInterval(() => {
    if (_pollInFlight) return; // skip if previous poll is still running
    _pollInFlight = true;

    (async () => {
      try {
        const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${_lastUpdateId + 1}&timeout=0&allowed_updates=%5B%22message%22%5D`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return;

        const data = await res.json() as TgGetUpdatesResponse;
        if (!data.ok || !Array.isArray(data.result)) return;

        const allowedUserIds = parseAllowedUserIds();

        for (const update of data.result) {
          _lastUpdateId = Math.max(_lastUpdateId, update.update_id);

          const msg = update.message;
          if (!msg?.text) continue;

          const fromChatId = String(msg.chat?.id ?? "");
          const fromUserId = String(msg.from?.id ?? "");
          const username   = msg.from?.username;

          // Solo aceptar comandos del chat autorizado
          if (fromChatId !== chatId) {
            logRejectedSender("chat_id_mismatch", fromChatId, fromUserId, username);
            continue;
          }

          // Si TELEGRAM_ALLOWED_USER_IDS está configurado, restringir por user ID
          if (allowedUserIds && !allowedUserIds.has(fromUserId)) {
            logRejectedSender("user_id_not_allowed", fromChatId, fromUserId, username);
            continue;
          }

          const rawText = msg.text.trim();
          const firstWord = rawText.toLowerCase().split(" ")[0];
          const isCommand = firstWord.startsWith("/");

          // Rate limit: como máximo N mensajes por minuto en total
          if (!checkRateLimit()) {
            pushAudit({ ts: Date.now(), reason: "rate_limited", chatId: fromChatId, userId: fromUserId, username });
            console.warn(TAG, `Rate limit excedido (${RATE_LIMIT_MAX}/min) — mensaje de user_id=${fromUserId} descartado`);
            if (!_rateLimitNotified) {
              _rateLimitNotified = true;
              await sendTelegram(`⚠️ Dame un momento, recibí muchos mensajes a la vez.`).catch(() => {});
              setTimeout(() => { _rateLimitNotified = false; }, RATE_LIMIT_WINDOW_MS);
            }
            continue;
          }

          console.log(TAG, `Mensaje recibido (${isCommand ? "cmd" : "chat"}): ${rawText.slice(0, 60)} (user_id=${fromUserId})`);

          if (_commandHandler) {
            try {
              const handlerInput = isCommand ? firstWord : rawText;
              const reply = await _commandHandler(handlerInput, chatId);
              if (reply) await sendTelegram(reply);
            } catch (e) {
              console.error(TAG, "Error procesando mensaje:", e);
              await sendTelegram("❌ Error interno. Intenta de nuevo.").catch(() => {});
            }
          }
        }
      } catch {
        // Fallos de red son esperados — no loggear en exceso
      } finally {
        _pollInFlight = false;
      }
    })();
  }, 4_000);
}

/** Detiene el polling (útil en tests o apagado limpio) */
export function stopTelegramPolling(): void {
  if (_pollingTimer) {
    clearInterval(_pollingTimer);
    _pollingTimer = null;
  }
}
