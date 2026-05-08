/**
 * GET /api/system/status — health check completo de todas las integraciones
 * que el frontend necesita para mostrar el estado del sistema.
 *
 * Cada componente:
 *   ok: boolean
 *   latencyMs: number | null
 *   message?: string  (detalle si !ok)
 *   needsAttention?: boolean  (true → frontend muestra alerta visual)
 *
 * Las verificaciones tienen timeouts cortos (3s c/u) y se hacen en paralelo
 * para que el endpoint responda rápido aunque alguno cuelgue.
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { isWsConnected, getWsPrice } from "../lib/bybit-ws";
import { isTestnet } from "../lib/bybit-auth";
import { hasCredentials } from "../lib/bybit-client";
import { getRules } from "../lib/governance";
import { getAutonomyConfig } from "../lib/autonomy";

const router = Router();

interface ComponentStatus {
  name: string;
  ok: boolean;
  latencyMs: number | null;
  message?: string | undefined;
  needsAttention?: boolean | undefined;
  meta?: Record<string, unknown>;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms),
    ),
  ]);
}

async function checkNeon(): Promise<ComponentStatus> {
  const t0 = Date.now();
  try {
    const r = await withTimeout(
      pool.query<{ now: string }>(`SELECT now()::text AS now`),
      3000,
    );
    return {
      name: "Neon Postgres",
      ok: true,
      latencyMs: Date.now() - t0,
      meta: { ts: r.rows[0]?.now },
    };
  } catch (e) {
    return {
      name: "Neon Postgres",
      ok: false,
      latencyMs: Date.now() - t0,
      message: e instanceof Error ? e.message : String(e),
      needsAttention: true,
    };
  }
}

async function checkBybitWs(): Promise<ComponentStatus> {
  const connected = isWsConnected();
  const btcPrice = getWsPrice("BTCUSDT");
  return {
    name: "Bybit WebSocket",
    ok: connected,
    latencyMs: null,
    message: connected
      ? `precios live recibiéndose (${btcPrice ? `BTC ${btcPrice}` : "sin tickers aún"})`
      : "WebSocket desconectado — fallback REST. revisar logs Railway",
    needsAttention: !connected,
    meta: { btcPrice, testnet: isTestnet(), hasCreds: hasCredentials() },
  };
}

async function checkOpenAI(): Promise<ComponentStatus> {
  const t0 = Date.now();
  const key = process.env["OPENAI_API_KEY"];
  if (!key) {
    return {
      name: "OpenAI (Whisper + TTS)",
      ok: false,
      latencyMs: null,
      message: "OPENAI_API_KEY no configurada",
      needsAttention: true,
    };
  }
  try {
    // Tocamos /v1/audio/speech con texto mínimo (~1 token). Esto sí consume
    // cuota real; si la cuenta está sin saldo, OpenAI devuelve 429 con
    // insufficient_quota — antes /v1/models pasaba aunque la cuenta estuviera
    // vacía y el panel mentía diciendo "auth válida".
    const r = await withTimeout(
      fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          voice: "nova",
          input: ".",
          response_format: "mp3",
        }),
        signal: AbortSignal.timeout(2500),
      }),
      3000,
    );
    if (r.ok) {
      await r.arrayBuffer().catch(() => null);
      return {
        name: "OpenAI (Whisper + TTS)",
        ok: true,
        latencyMs: Date.now() - t0,
        message: "voz disponible",
        needsAttention: false,
      };
    }
    if (r.status === 429) {
      const txt = await r.text().catch(() => "");
      const isQuota = /insufficient_quota|quota|billing/i.test(txt);
      return {
        name: "OpenAI (Whisper + TTS)",
        ok: false,
        latencyMs: Date.now() - t0,
        message: isQuota
          ? "sin saldo OpenAI — recargar en platform.openai.com/billing"
          : "rate limit OpenAI (429) — esperar",
        needsAttention: true,
      };
    }
    if (r.status === 401) {
      return {
        name: "OpenAI (Whisper + TTS)",
        ok: false,
        latencyMs: Date.now() - t0,
        message: "API key inválida o revocada",
        needsAttention: true,
      };
    }
    return {
      name: "OpenAI (Whisper + TTS)",
      ok: false,
      latencyMs: Date.now() - t0,
      message: `OpenAI ${r.status}`,
      needsAttention: true,
    };
  } catch (e) {
    return {
      name: "OpenAI (Whisper + TTS)",
      ok: false,
      latencyMs: Date.now() - t0,
      message: e instanceof Error ? e.message : String(e),
      needsAttention: true,
    };
  }
}

async function checkGemini(): Promise<ComponentStatus> {
  const t0 = Date.now();
  const key = process.env["GEMINI_API_KEY"];
  if (!key) {
    return {
      name: "Gemini (cerebro de Tanit)",
      ok: false,
      latencyMs: null,
      message: "GEMINI_API_KEY no configurada",
      needsAttention: true,
    };
  }
  try {
    const r = await withTimeout(
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
        { signal: AbortSignal.timeout(2500) },
      ),
      3000,
    );
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return {
        name: "Gemini (cerebro de Tanit)",
        ok: false,
        latencyMs: Date.now() - t0,
        message: `Gemini ${r.status}: ${txt.slice(0, 120)}`,
        needsAttention: true,
      };
    }
    return {
      name: "Gemini (cerebro de Tanit)",
      ok: true,
      latencyMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      name: "Gemini (cerebro de Tanit)",
      ok: false,
      latencyMs: Date.now() - t0,
      message: e instanceof Error ? e.message : String(e),
      needsAttention: true,
    };
  }
}

async function checkBreak(): Promise<ComponentStatus> {
  const t0 = Date.now();
  const url = "https://break-runtime-production.up.railway.app/api/break/status";
  try {
    const r = await withTimeout(
      fetch(url, { signal: AbortSignal.timeout(2500) }),
      3000,
    );
    if (!r.ok) {
      return {
        name: "Break runtime",
        ok: false,
        latencyMs: Date.now() - t0,
        message: `${r.status}`,
        needsAttention: false,
      };
    }
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      name: "Break runtime",
      ok: true,
      latencyMs: Date.now() - t0,
      message: (j.soulSource as { ok?: boolean })?.ok
        ? "alma cargada desde breack.life"
        : "vivo pero sin acceso a su alma — revisar breack.life",
      meta: j,
    };
  } catch (e) {
    return {
      name: "Break runtime",
      ok: false,
      latencyMs: Date.now() - t0,
      message: e instanceof Error ? e.message : String(e),
      needsAttention: false, // Break es opcional
    };
  }
}

async function checkTelegram(): Promise<ComponentStatus> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (!token || !chatId) {
    return {
      name: "Telegram alerts",
      ok: false,
      latencyMs: null,
      message: "TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID faltante",
      needsAttention: false,
    };
  }
  return {
    name: "Telegram alerts",
    ok: true,
    latencyMs: null,
    message: "configurado",
  };
}

async function checkGovernanceAndAutonomy(): Promise<ComponentStatus[]> {
  const out: ComponentStatus[] = [];
  try {
    const t0 = Date.now();
    const rules = await getRules({ force: true });
    out.push({
      name: "Governance",
      ok: true,
      latencyMs: Date.now() - t0,
      message: rules.kill_switch_global
        ? "🔴 kill-switch ACTIVO — todas las writes bloqueadas"
        : `🟢 ${rules.allowed_symbols.length} símbolos permitidos · max $${rules.max_position_size_usd}/pos · ${rules.max_leverage}x leverage`,
      needsAttention: rules.kill_switch_global,
      meta: { kill_switch: rules.kill_switch_global },
    });
  } catch (e) {
    out.push({
      name: "Governance",
      ok: false,
      latencyMs: null,
      message: e instanceof Error ? e.message : String(e),
      needsAttention: true,
    });
  }
  try {
    const t0 = Date.now();
    const cfg = await getAutonomyConfig({ force: true });
    const pausedNow =
      !!cfg.paused_until && Date.now() < new Date(cfg.paused_until).getTime();
    out.push({
      name: "Autonomía",
      ok: true,
      latencyMs: Date.now() - t0,
      message: !cfg.enabled
        ? "apagada — solo observa"
        : cfg.mode === "execute_with_governance"
          ? pausedNow
            ? `pausada hasta ${cfg.paused_until}`
            : `🟢 operando según Tesis 5.1 · ${cfg.daily_trade_count}/${cfg.max_daily_trades} trades hoy`
          : `solo observa`,
      needsAttention: pausedNow,
      meta: { mode: cfg.mode, enabled: cfg.enabled },
    });
  } catch (e) {
    out.push({
      name: "Autonomía",
      ok: false,
      latencyMs: null,
      message: e instanceof Error ? e.message : String(e),
      needsAttention: true,
    });
  }
  return out;
}

router.get("/system/status", async (_req, res): Promise<void> => {
  const t0 = Date.now();
  try {
    const [neon, ws, openai, gemini, brk, tg, govAuto] = await Promise.all([
      checkNeon(),
      checkBybitWs(),
      checkOpenAI(),
      checkGemini(),
      checkBreak(),
      checkTelegram(),
      checkGovernanceAndAutonomy(),
    ]);
    const components: ComponentStatus[] = [neon, ws, openai, gemini, brk, tg, ...govAuto];
    const needsAttention = components.some((c) => c.needsAttention);
    const allOk = components.every((c) => c.ok);
    res.json({
      ok: true,
      allOk,
      needsAttention,
      ts: new Date().toISOString(),
      latencyMs: Date.now() - t0,
      components,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

export default router;
