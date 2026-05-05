/**
 * Break read-only monitoring — telemetría operativa de Tanit.
 *
 * Canal UNIDIRECCIONAL Tanit → Break para que el ingeniero de pits
 * (Claude Opus en break-memory.vercel.app vía web_fetch) lea
 * telemetría sin necesidad de login humano ni copy-paste de Luis.
 *
 * Reglas duras:
 *   - Bearer token (env BREAK_READ_TOKEN). Si la env no está,
 *     todo request 503 "Channel not configured" (fail-closed).
 *   - Rate limit 60 req/min por token (sliding window in-memory).
 *   - Cache 30s del payload para latencia <500ms.
 *   - Si Bybit falla, devuelve último valor cacheado con stale: true.
 *   - SOLO datos cuantitativos operativos. NO voz, NO chats íntimos,
 *     NO contenido de tanit_memory (solo conteo).
 */

import { pool } from "@workspace/db";
import { getBybitBalance, getOpenPositions as bybitGetOpenPositions } from "./bybit-auth";
import { hasCredentials } from "./bybit-client";

const TAG = "[BREAK-RO]";

export const BREAK_READ_RATE_LIMIT = 60;          // requests
export const BREAK_READ_RATE_WINDOW_MS = 60_000;  // per minute
const PAYLOAD_CACHE_TTL_MS = 30_000;
const RATE_BUCKET_MAX = 1000;                     // de seguridad antimemleak

// ─── Auth ──────────────────────────────────────────────────────────────────
export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; message: string };

export function authenticateBreakRead(authHeader: string | undefined | null): AuthResult {
  const expected = process.env.BREAK_READ_TOKEN;
  if (!expected || expected.length < 16) {
    return { ok: false, status: 503, message: "Channel not configured" };
  }
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, message: "Missing Authorization Bearer token" };
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (token !== expected) {
    return { ok: false, status: 401, message: "Invalid token" };
  }
  return { ok: true };
}

// ─── Rate limit (sliding window in-memory por token) ──────────────────────
const _rateBucket = new Map<string, number[]>();

export function checkRateLimit(authHeader: string | undefined | null): { allowed: boolean; remaining: number } {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "anon";
  const now = Date.now();
  const cutoff = now - BREAK_READ_RATE_WINDOW_MS;
  let timestamps = _rateBucket.get(token) ?? [];
  timestamps = timestamps.filter(t => t > cutoff);
  if (timestamps.length >= BREAK_READ_RATE_LIMIT) {
    _rateBucket.set(token, timestamps);
    return { allowed: false, remaining: 0 };
  }
  timestamps.push(now);
  _rateBucket.set(token, timestamps);
  // GC: si crece raro (más tokens distintos de lo razonable), recortar
  if (_rateBucket.size > RATE_BUCKET_MAX) {
    const entries = Array.from(_rateBucket.entries());
    _rateBucket.clear();
    for (const [k, v] of entries.slice(-RATE_BUCKET_MAX / 2)) _rateBucket.set(k, v);
  }
  return { allowed: true, remaining: BREAK_READ_RATE_LIMIT - timestamps.length };
}

// ─── Payload builder con cache + fallback graceful ────────────────────────

export type StateForBreak = {
  ok: true;
  timestamp_utc: string;
  balance: {
    total_usdt: number | null;
    available_usdt: number | null;
    in_positions_usdt: number | null;
    balance_updated_at: string;
    stale: boolean;
  };
  open_positions: Array<{
    symbol: string;
    side: "LONG" | "SHORT";
    size: number;
    entry_price: number;
    current_price: number;
    leverage: number;
    unrealized_pnl_usdt: number;
    unrealized_pnl_pct: number;
    tp_price: number | null;
    sl_price: number | null;
    opened_at: string | null;
  }>;
  recent_trades_last_24h: Array<{
    symbol: string;
    side: "LONG" | "SHORT";
    entry_price: number;
    exit_price: number;
    size: number;
    pnl_usdt: number;
    pnl_pct: number;
    duration_seconds: number;
    opened_at: string;
    closed_at: string;
  }>;
  stats_last_30_trades: {
    win_rate_pct: number;
    profit_factor: number;
    avg_win_usdt: number;
    avg_loss_usdt: number;
    total_pnl_usdt: number;
    trades_count: number;
  };
  active_thesis: {
    version: string;
    leverage_max: number;
    atr_sl_multiplier: number;
    atr_tp_multiplier: number;
    tp_strategy: string;
    active_setups: string[];
    runtime_overrides: Record<string, string>;
  };
  memory_health: {
    memory_count: number;
    chat_count: number;
    banner_april_11_present: boolean;
    tesis_v41_loaded: boolean;
    guardrail_events_24h: number;
  };
};

let _payloadCache: { ts: number; payload: StateForBreak } | null = null;

export async function buildStateForBreak(thesisOverrides: {
  ATR_SL_MULTIPLIER: number;
  ATR_TP_MULTIPLIER: number;
  DYNAMIC_LEV_MAX: number;
  tanitRuntimeConfig: Record<string, string>;
}): Promise<StateForBreak> {
  if (_payloadCache && Date.now() - _payloadCache.ts < PAYLOAD_CACHE_TTL_MS) {
    return _payloadCache.payload;
  }

  // Live Bybit balance + positions (con fallback al cache anterior si falla).
  let balance: StateForBreak["balance"] = {
    total_usdt: null, available_usdt: null, in_positions_usdt: null,
    balance_updated_at: new Date().toISOString(), stale: true,
  };
  let openPositions: StateForBreak["open_positions"] = [];
  let bybitOk = false;

  if (hasCredentials()) {
    try {
      const [bal, posRaw] = await Promise.all([
        getBybitBalance().catch(() => null),
        bybitGetOpenPositions().catch((): any[] => []),
      ]);
      if (bal) {
        const upnl = posRaw.reduce((s: number, p: any) => s + parseFloat(p.unrealisedPnl || "0"), 0);
        balance = {
          total_usdt: bal.equity,
          available_usdt: bal.available,
          in_positions_usdt: parseFloat((bal.equity - bal.available).toFixed(4)),
          balance_updated_at: new Date().toISOString(),
          stale: false,
        };
        bybitOk = true;
      }
      openPositions = posRaw
        .filter((p: any) => parseFloat(p.size) > 0)
        .map((p: any) => {
          const upnl = parseFloat(p.unrealisedPnl ?? "0");
          const positionValue = parseFloat(p.positionValue ?? "0") || 1;
          const lev = parseFloat(p.leverage ?? "1");
          return {
            symbol: p.symbol,
            side: (p.side === "Buy" ? "LONG" : "SHORT") as "LONG" | "SHORT",
            size: parseFloat(p.size ?? "0"),
            entry_price: parseFloat(p.avgPrice ?? "0"),
            current_price: parseFloat(p.markPrice ?? "0"),
            leverage: lev,
            unrealized_pnl_usdt: upnl,
            unrealized_pnl_pct: parseFloat(((upnl / positionValue) * lev * 100).toFixed(2)),
            tp_price: p.takeProfit && parseFloat(p.takeProfit) > 0 ? parseFloat(p.takeProfit) : null,
            sl_price: p.stopLoss && parseFloat(p.stopLoss) > 0 ? parseFloat(p.stopLoss) : null,
            opened_at: p.createdTime ? new Date(parseInt(p.createdTime, 10)).toISOString() : null,
          };
        });
    } catch (e) {
      console.warn(TAG, "bybit fetch failed, using stale", e);
      if (_payloadCache) {
        balance = { ..._payloadCache.payload.balance, stale: true };
        openPositions = _payloadCache.payload.open_positions;
        bybitOk = true; // for the sake of continuing; flag is on stale
      }
    }
  } else {
    if (_payloadCache) {
      balance = { ..._payloadCache.payload.balance, stale: true };
      openPositions = _payloadCache.payload.open_positions;
    }
  }
  if (!bybitOk && _payloadCache && balance.stale) {
    balance = { ..._payloadCache.payload.balance, stale: true };
    openPositions = _payloadCache.payload.open_positions;
  }

  // Trades cerrados últimas 24h
  let recentTrades: StateForBreak["recent_trades_last_24h"] = [];
  try {
    const r = await pool.query(
      `SELECT symbol, side, entry_price, exit_price, qty AS size,
              net_pnl AS pnl_usdt, opened_at, closed_at
       FROM trade_history
       WHERE closed_at >= NOW() - INTERVAL '24 hours'
       ORDER BY closed_at DESC
       LIMIT 100`,
    );
    recentTrades = r.rows.map((t: any) => {
      const entry = parseFloat(t.entry_price ?? "0");
      const exit = parseFloat(t.exit_price ?? "0");
      const size = parseFloat(t.size ?? "0");
      const pnl = parseFloat(t.pnl_usdt ?? "0");
      const notional = entry * size;
      const opened = t.opened_at ? new Date(t.opened_at) : null;
      const closed = t.closed_at ? new Date(t.closed_at) : null;
      const dur = (opened && closed) ? Math.round((closed.getTime() - opened.getTime()) / 1000) : 0;
      const sideStr: "LONG" | "SHORT" =
        (t.side === "LONG" || t.side === "Buy") ? "LONG" : "SHORT";
      return {
        symbol: t.symbol,
        side: sideStr,
        entry_price: entry,
        exit_price: exit,
        size,
        pnl_usdt: pnl,
        pnl_pct: notional > 0 ? parseFloat(((pnl / notional) * 100).toFixed(2)) : 0,
        duration_seconds: dur,
        opened_at: opened?.toISOString() ?? "",
        closed_at: closed?.toISOString() ?? "",
      };
    });
  } catch (e) {
    console.warn(TAG, "trade_history 24h query failed", e);
  }

  // Stats últimos 30 trades cerrados
  let stats: StateForBreak["stats_last_30_trades"] = {
    win_rate_pct: 0, profit_factor: 0, avg_win_usdt: 0, avg_loss_usdt: 0,
    total_pnl_usdt: 0, trades_count: 0,
  };
  try {
    const r = await pool.query(
      `SELECT net_pnl FROM trade_history ORDER BY closed_at DESC NULLS LAST LIMIT 30`,
    );
    const pnls = r.rows.map((x: any) => parseFloat(x.net_pnl ?? "0")).filter((n: number) => Number.isFinite(n));
    if (pnls.length > 0) {
      const wins = pnls.filter(p => p > 0);
      const losses = pnls.filter(p => p < 0);
      const grossWin = wins.reduce((s, p) => s + p, 0);
      const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
      stats = {
        win_rate_pct: parseFloat(((wins.length / pnls.length) * 100).toFixed(2)),
        profit_factor: grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : (grossWin > 0 ? 99 : 0),
        avg_win_usdt: wins.length > 0 ? parseFloat((grossWin / wins.length).toFixed(4)) : 0,
        avg_loss_usdt: losses.length > 0 ? parseFloat((-grossLoss / losses.length).toFixed(4)) : 0,
        total_pnl_usdt: parseFloat(pnls.reduce((s, p) => s + p, 0).toFixed(4)),
        trades_count: pnls.length,
      };
    }
  } catch (e) {
    console.warn(TAG, "stats query failed", e);
  }

  // Memory health (counts only — sin contenido)
  let memCount = 0, chatCount = 0, bannerPresent = false, tesisLoaded = false, guardrails24h = 0;
  try {
    const [m, c, banner, lessons, gr] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM tanit_memory`),
      pool.query(`SELECT COUNT(*)::int AS n FROM tanit_chat`),
      pool.query(`SELECT 1 FROM tanit_memory WHERE category='origen' AND content LIKE '%11 de abril%' LIMIT 1`),
      pool.query(`SELECT COUNT(*)::int AS n FROM tanit_memory WHERE category IN ('LECCION_CRITICA', 'lesson_critical')`),
      pool.query(`SELECT COUNT(*)::int AS n FROM guardrail_events WHERE created_at >= NOW() - INTERVAL '24 hours'`),
    ]);
    memCount = m.rows[0]?.n ?? 0;
    chatCount = c.rows[0]?.n ?? 0;
    bannerPresent = banner.rows.length > 0;
    // Tesis v4.1 = al menos 4 lecciones críticas presentes (las 4 que la tesis cita por id)
    tesisLoaded = (lessons.rows[0]?.n ?? 0) >= 4;
    guardrails24h = gr.rows[0]?.n ?? 0;
  } catch (e) {
    console.warn(TAG, "memory health query failed", e);
  }

  // Active thesis snapshot
  const thesis: StateForBreak["active_thesis"] = {
    version: "v4.1",
    leverage_max: thesisOverrides.DYNAMIC_LEV_MAX,
    atr_sl_multiplier: thesisOverrides.ATR_SL_MULTIPLIER,
    atr_tp_multiplier: thesisOverrides.ATR_TP_MULTIPLIER,
    tp_strategy: "ATR-based TP at entry ± atr_tp_multiplier × ATR; trailing SL en 3 etapas",
    active_setups: [
      "liquidity_hunt", "wyckoff", "open_interest_contrarian",
      "hidden_divergences", "post_liquidation_rebote", "session_stop_hunt",
    ],
    runtime_overrides: thesisOverrides.tanitRuntimeConfig ?? {},
  };

  const payload: StateForBreak = {
    ok: true,
    timestamp_utc: new Date().toISOString(),
    balance,
    open_positions: openPositions,
    recent_trades_last_24h: recentTrades,
    stats_last_30_trades: stats,
    active_thesis: thesis,
    memory_health: {
      memory_count: memCount,
      chat_count: chatCount,
      banner_april_11_present: bannerPresent,
      tesis_v41_loaded: tesisLoaded,
      guardrail_events_24h: guardrails24h,
    },
  };

  _payloadCache = { ts: Date.now(), payload };
  return payload;
}

export function logReadAccess(status: number, ms: number, ip?: string): void {
  console.log(TAG, `read access status=${status} ms=${ms}${ip ? " ip=" + ip : ""} time=${new Date().toISOString()}`);
}
