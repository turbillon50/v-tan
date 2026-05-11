import { Router } from "express";
import { randomUUID } from "crypto";
import { startEngine, stopEngine, getEngineStatus, resetBalance, clearTradeLog, manualClosePosition, startMiddlePointOnly, stopMiddlePoint, analyzeMarketForStrategy, getMarketIntelligence, setEngineCapitalPct, setMiddlePointCapitalPct, setMiddlePointModes, setMiddlePointPositionsTarget, setEscalonPositionsTarget, setEscalonClosePct, setMPPairLevels, setMPProfitTargetPct, emergencyKill, setDailyLossLimit, forceMPEntry, setEngineLiveMode, setCompoundCycle, forceCompoundHarvest, setEscaleraSymbol, setEscaleraSymbols, setEscaleraIcTarget, setMPIcTarget, setMPLeverage, setMPRangeWindow, setCapitalStartPoint, runGeminiUserCommand, getTanitChatHistory, getTanitReasoningSnapshot, getProtectionGuardStatus, getTanitIdentityData, getEscaleraLayerBySymbol, getScaleInEvents, getTanitLiveParams, getBalanceHistory, tanitSymAvoid, tanitRuntimeConfig, resetSessionMultipliers, tanitApplyEvolution } from "../lib/trading-engine";
import { startHybrid, stopHybrid, getHybridStatus, isHybridActive, setHybridCapitalPct } from "../lib/hybrid-engine";
import { setTestnet, isTestnet, bybitPublic, bybitPrivate, getBybitBalance, getBybitBalanceMainnet, getOpenPositions, closePosition as bybitClose, closePositionMainnet } from "../lib/bybit-auth";
import { getLearningStats, loadSwapHistoryFromDB } from "../lib/db-persistence";
import { getTelegramAuditLog, clearTelegramAuditLog } from "../lib/telegram";
import { pool } from "@workspace/db";

const router = Router();

router.get("/bot/status", async (_req, res): Promise<void> => {
  res.json(await getHybridStatus());
});

// ── Audit log de Telegram — intentos rechazados recientes ─────────────────────
router.get("/bot/tg-audit", (_req, res): void => {
  res.json({ ok: true, attempts: getTelegramAuditLog() });
});

router.delete("/bot/tg-audit", (_req, res): void => {
  clearTelegramAuditLog();
  res.json({ ok: true });
});

// Historial de swaps persistido en DB — sobrevive reinicios del bot
router.get("/bot/swaps", async (req, res): Promise<void> => {
  try {
    const parsed = parseInt((req.query.limit as string) ?? "50", 10);
    const limit = Math.min(Math.max(isNaN(parsed) || parsed < 1 ? 50 : parsed, 1), 200);
    const parsedOffset = parseInt((req.query.offset as string) ?? "0", 10);
    const offset = isNaN(parsedOffset) || parsedOffset < 0 ? 0 : parsedOffset;
    const swaps = await loadSwapHistoryFromDB(limit, offset);
    res.json({ ok: true, swaps, count: swaps.length, offset });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message, swaps: [] });
  }
});

// Historial de balance persistido en DB — sobrevive reinicios del bot
router.get("/bot/balance-history", async (req, res): Promise<void> => {
  try {
    const days = parseInt((req.query.days as string) ?? "30", 10);
    const history = await getBalanceHistory(Math.min(Math.max(isNaN(days) ? 30 : days, 1), 365));
    res.json({ ok: true, history, count: history.length });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message, history: [] });
  }
});

router.post("/bot/toggle", async (req, res): Promise<void> => {
  try {
    const { active, riskMode, capitalPercent, symbol, symbols, liveMode, targetProfitPct } = req.body ?? {};

    if (active) {
      const symList = symbols ?? (symbol ? [symbol] : undefined);
      await startHybrid({
        capitalPercent: capitalPercent ?? 50,
        liveMode: liveMode === true,
        symbols: Array.isArray(symList) ? symList : undefined,
        targetProfitPct: typeof targetProfitPct === "number" ? targetProfitPct : 0,
      });
    } else {
      await stopHybrid();
    }

    req.log.info({ active, capitalPercent, liveMode, targetProfitPct, symbols: symbols ?? symbol }, "Bot toggled (hybrid)");
    res.json(await getHybridStatus());
  } catch (e: any) {
    req.log.error({ err: e }, "Error toggling bot");
    res.status(500).json({ error: e?.message ?? "Error interno", ok: false });
  }
});

// Cierre manual de una posición — el bot la reemplazará en el siguiente scan
router.post("/bot/close/:symbol", async (req, res): Promise<void> => {
  const symbol = req.params.symbol?.toUpperCase();
  const ok = await manualClosePosition(symbol);
  res.json({ ok, symbol, status: await getEngineStatus() });
});

// Listar posiciones reales abiertas en Bybit (independiente del motor)
// Augmenta cada posición con datos de escalera (initialTp, scaleInDone, currentSL) si existe
router.get("/bot/bybit-positions", async (_req, res): Promise<void> => {
  try {
    const positions = await getOpenPositions();
    const augmented = positions.map((p: any) => {
      const layer = getEscaleraLayerBySymbol(p.symbol ?? "");
      if (layer) {
        return {
          ...p,
          initialTp:   layer.initialTp   ?? null,
          scaleInDone: layer.scaleInDone ?? false,
          scaleInQty:  layer.scaleInQty  ?? null,
          currentSL:   layer.currentSL   ?? null,
          layerStatus: layer.status,
          slStage:     layer.slStage     ?? 0,
        };
      }
      return p;
    });
    res.json({ ok: true, positions: augmented });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message, positions: [] });
  }
});

// Eventos de scale-in recientes — para notificaciones en el dashboard
router.get("/bot/scale-in-events", (_req, res): void => {
  const parsed = parseInt((_req.query.limit as string) ?? "20", 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 50) : 20;
  res.json({ ok: true, events: getScaleInEvents(limit) });
});

// Cierre de una posición específica en Bybit directamente (sin importar estado del motor)
router.post("/bot/close-bybit/:symbol", async (req, res): Promise<void> => {
  const symbol = req.params.symbol?.toUpperCase();
  const wantSide = (req.body?.side as string)?.toUpperCase();
  try {
    const positions = await getOpenPositions();
    const pos = wantSide
      ? positions.find((p: any) => p.symbol === symbol && ((wantSide === "SHORT" && p.side === "Sell") || (wantSide === "LONG" && p.side === "Buy")))
      : positions.find((p: any) => p.symbol === symbol);
    if (!pos) {
      res.json({ ok: false, message: `No hay posición ${wantSide ?? ""} para ${symbol}` });
      return;
    }
    const direction: "LONG" | "SHORT" = pos.side === "Buy" ? "LONG" : "SHORT";
    const posIdx = direction === "LONG" ? 1 : 2;
    const ok = await closePositionMainnet(symbol, direction, pos.size, posIdx);
    res.json({ ok, symbol, side: pos.side, size: pos.size, direction });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Cierre de TODAS las posiciones abiertas en Bybit directamente (sin importar estado del motor)
router.post("/bot/close-all-bybit", async (_req, res): Promise<void> => {
  try {
    const positions = await getOpenPositions();
    if (!positions.length) {
      res.json({ ok: true, closed: [], message: "No hay posiciones abiertas en Bybit" });
      return;
    }
    const results: any[] = [];
    for (const p of positions) {
      // p.side es "Buy" (LONG) o "Sell" (SHORT) — closePosition espera "LONG"/"SHORT"
      const direction: "LONG" | "SHORT" = p.side === "Buy" ? "LONG" : "SHORT";
      const posIdx = direction === "LONG" ? 1 : 2;
      const ok = await closePositionMainnet(p.symbol, direction, p.size, posIdx);
      results.push({ symbol: p.symbol, side: p.side, size: p.size, closed: ok });
    }
    const balance = await getBybitBalance();
    res.json({ ok: true, closed: results, balance });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch("/bot/settings", async (req, res): Promise<void> => {
  const {
    capitalPercent, mpCapitalPercent, mpPositionsTarget, mpLeverageMode, mpMarginMode,
    escalonPositionsTarget, escalonClosePct, mpProfitTargetPct, liveMode,
    escaleraSymbol, escaleraSymbols, escaleraIcTargetPct,
    mpIcTargetPct, mpLeverage, mpRangeWindowMin,
  } = req.body ?? {};
  if (typeof capitalPercent === "number") {
    if (isHybridActive()) setHybridCapitalPct(capitalPercent);
    else setEngineCapitalPct(capitalPercent);
  }
  if (typeof mpCapitalPercent === "number")      setMiddlePointCapitalPct(mpCapitalPercent);
  if (typeof mpPositionsTarget === "number")     setMiddlePointPositionsTarget(mpPositionsTarget);
  if (typeof escalonPositionsTarget === "number") setEscalonPositionsTarget(escalonPositionsTarget);
  if (typeof escalonClosePct === "number")       setEscalonClosePct(escalonClosePct);
  if (typeof mpProfitTargetPct === "number")     setMPProfitTargetPct(mpProfitTargetPct);
  if (typeof liveMode === "boolean")             setEngineLiveMode(liveMode);
  // Accept array (new) or single string (legacy)
  if (Array.isArray(escaleraSymbols) && escaleraSymbols.length > 0) setEscaleraSymbols(escaleraSymbols);
  else if (typeof escaleraSymbol === "string")   setEscaleraSymbol(escaleraSymbol);
  if (typeof escaleraIcTargetPct === "number")   setEscaleraIcTarget(escaleraIcTargetPct);
  // ── Nuevos controles MIDDLE ────────────────────────────────────────────────
  if (typeof mpIcTargetPct === "number")    setMPIcTarget(mpIcTargetPct);
  if (typeof mpLeverage === "number")       setMPLeverage(mpLeverage);
  if (typeof mpRangeWindowMin === "number") setMPRangeWindow(mpRangeWindowMin);
  if (typeof mpLeverageMode === "string" && typeof mpMarginMode === "string") {
    setMiddlePointModes(mpLeverageMode as any, mpMarginMode as any);
  }
  res.json(await getEngineStatus());
});

router.post("/bot/reset", async (_req, res): Promise<void> => {
  resetBalance();
  res.json(await getEngineStatus());
});

router.post("/bot/reset-session-multipliers", async (req, res): Promise<void> => {
  const reason = String(req.body?.reason ?? "reset manual desde dashboard").trim();
  const message = await resetSessionMultipliers(reason);
  res.json({ ok: true, message });
});

router.post("/bot/set-session-multiplier", async (req, res): Promise<void> => {
  const { param, value } = req.body ?? {};
  const VALID_PARAMS = new Set([
    "mult_late_night", "mult_asia", "mult_london",
    "mult_london_ny", "mult_ny_peak", "mult_ny_late",
  ]);
  if (!VALID_PARAMS.has(param)) {
    res.status(400).json({ ok: false, error: `Parámetro inválido: ${param}` });
    return;
  }
  const num = parseFloat(value);
  if (isNaN(num) || num < 0.70 || num > 1.50) {
    res.status(400).json({ ok: false, error: "Valor fuera de rango (0.70 – 1.50)" });
    return;
  }
  const rounded = Math.round(num * 100) / 100;
  const reason = `ajuste manual desde dashboard: ${param} = ${rounded}`;
  const message = await tanitApplyEvolution(param, rounded.toFixed(2), reason);
  res.json({ ok: true, message, param, value: rounded });
});

router.post("/bot/capital-start", async (req, res): Promise<void> => {
  const { balance } = req.body ?? {};
  const n = Number(balance);
  if (!Number.isFinite(n) || n < 0) {
    res.status(400).json({ ok: false, error: "balance inválido" });
    return;
  }
  setCapitalStartPoint(n);
  res.json({ ok: true, status: await getEngineStatus() });
});

router.post("/bot/testnet", async (req, res): Promise<void> => {
  const { testnet } = req.body ?? {};
  if (typeof testnet === "boolean") {
    setTestnet(testnet);
    req.log.info({ testnet }, "Testnet toggled");
  }
  res.json({ isTestnet: isTestnet() });
});

// Configura parámetros óptimos para cuentas pequeñas (<$100)
router.post("/bot/configure-small-account", async (req, res): Promise<void> => {
  const { balance } = req.body ?? {};
  const capitalPct = balance != null && balance < 30 ? 80 : 70;
  // 1 posición a la vez — no podemos permitirnos 4 posiciones con $10
  setEscalonPositionsTarget(1);
  setEngineCapitalPct(capitalPct);
  // Mainnet
  setTestnet(false);
  req.log.info({ balance, capitalPct }, "Small-account config aplicada");
  res.json({ ok: true, capitalPct, positionsTarget: 1, testnet: false });
});

// ── Helper: fetch + analiza 120h de klines para un símbolo ──────────────────
async function fetch120hCandles(symbol: string) {
  const d = await bybitPublic("GET", "/v5/market/kline", {
    category: "linear", symbol, interval: "60", limit: "120"
  });
  const list: any[] = d?.result?.list ?? [];
  return list.map((k: any) => {
    const ts   = parseInt(k[0]);
    return {
      ts, h: new Date(ts).getUTCHours(),
      open: parseFloat(k[1]), high: parseFloat(k[2]),
      low:  parseFloat(k[3]), close: parseFloat(k[4]),
      vol:  parseFloat(k[5]),
      ret:  parseFloat(k[1]) > 0 ? ((parseFloat(k[4]) - parseFloat(k[1])) / parseFloat(k[1])) * 100 : 0,
      bull: parseFloat(k[4]) >= parseFloat(k[1]),
      date: new Date(ts).toISOString().slice(0, 16) + "Z",
    };
  }).reverse();
}

function analyzeHour(candles: any[], targetHour: number, avgVolAll: number) {
  const target = candles.filter((c: any) => c.h === targetHour);
  if (target.length === 0) return null;
  const bullN      = target.filter((c: any) => c.bull).length;
  const bullPct    = bullN / target.length * 100;
  const avgRet     = target.reduce((s: number, c: any) => s + c.ret, 0) / target.length;
  const avgVolHour = target.reduce((s: number, c: any) => s + c.vol, 0) / target.length;
  const volRatio   = avgVolAll > 0 ? avgVolHour / avgVolAll : 1;
  const consistency = Math.abs(bullPct - 50) * 2;
  let bias: string;
  if      (bullPct >= 80 && volRatio >= 1.3) bias = "STRONG_BULL";
  else if (bullPct >= 70)                    bias = "BULL";
  else if (bullPct <= 20 && volRatio >= 1.3) bias = "STRONG_BEAR";
  else if (bullPct <= 30)                    bias = "BEAR";
  else                                       bias = "NEUTRAL";
  return {
    h: targetHour,
    hCancun: ((targetHour - 5 + 24) % 24),
    samples: target.length,
    bullPct: parseFloat(bullPct.toFixed(1)),
    avgRet:  parseFloat(avgRet.toFixed(4)),
    volRatio: parseFloat(volRatio.toFixed(2)),
    consistency: parseFloat(consistency.toFixed(0)),
    bias,
    candles: target.map((c: any) => ({
      date: c.date, ret: parseFloat(c.ret.toFixed(4)),
      color: c.bull ? "green" : "red", vol: parseFloat(c.vol.toFixed(2)),
    })),
  };
}

// ── GET /api/bot/timepattern?hour=N — análisis de una hora específica ────────
router.get("/bot/timepattern", async (req, res): Promise<void> => {
  const utcHour = parseInt((req.query.hour as string) ?? String(new Date().getUTCHours()));
  const SYMS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT"];

  const results = await Promise.all(SYMS.map(async (symbol) => {
    try {
      const candles   = await fetch120hCandles(symbol);
      const avgVolAll = candles.reduce((s: number, c: any) => s + c.vol, 0) / candles.length;
      const analysis  = analyzeHour(candles, utcHour, avgVolAll);
      if (!analysis) return { symbol, error: `sin candles a las ${utcHour}h UTC` };
      return { symbol, ...analysis };
    } catch (e) { return { symbol, error: String(e) }; }
  }));

  res.json({
    hora_utc: utcHour,
    hora_cancun: `${((utcHour - 5 + 24) % 24).toString().padStart(2,"0")}:00 CDT`,
    analizado_en: new Date().toISOString(),
    simbolos: results,
  });
});

// ── GET /api/bot/whalepattern — mapa completo de las 24h para el dashboard ──
// Caché de 30min para no saturar la API de Bybit
const whalePatternCache: { data: any; cachedAt: number } = { data: null, cachedAt: 0 };
const WHALE_CACHE_TTL = 30 * 60 * 1000;

router.get("/bot/whalepattern", async (_req, res): Promise<void> => {
  if (whalePatternCache.data && Date.now() - whalePatternCache.cachedAt < WHALE_CACHE_TTL) {
    res.json(whalePatternCache.data); return;
  }

  const SYMS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT"];

  // Fetch 120h candles para todos los símbolos en paralelo
  const allCandles = await Promise.all(SYMS.map(async (symbol) => {
    try { return { symbol, candles: await fetch120hCandles(symbol) }; }
    catch { return { symbol, candles: [] }; }
  }));

  // Para cada símbolo, analiza las 24 horas
  const symbolMaps = allCandles.map(({ symbol, candles }) => {
    const avgVolAll = candles.length > 0
      ? candles.reduce((s: number, c: any) => s + c.vol, 0) / candles.length : 1;
    const hours = Array.from({ length: 24 }, (_, h) => {
      const a = analyzeHour(candles, h, avgVolAll);
      if (!a) return { h, hCancun: (h - 5 + 24) % 24, samples: 0, bullPct: 50, avgRet: 0, volRatio: 1, consistency: 0, bias: "NEUTRAL" };
      const { candles: _c, ...rest } = a; // quitar detalle de velas para reducir payload
      return rest;
    });
    return { symbol: symbol.replace("USDT",""), hours };
  });

  // Resumen consenso por hora (promedio de los 6 símbolos)
  const consensus = Array.from({ length: 24 }, (_, h) => {
    const hCancun = (h - 5 + 24) % 24;
    const valid = symbolMaps.map(s => s.hours[h]).filter(x => x.samples > 0);
    if (valid.length === 0) return { h, hCancun, bullPct: 50, avgRet: 0, volRatio: 1, bias: "NEUTRAL" };
    const bullPct  = valid.reduce((s, x) => s + x.bullPct, 0) / valid.length;
    const avgRet   = valid.reduce((s, x) => s + x.avgRet, 0) / valid.length;
    const volRatio = valid.reduce((s, x) => s + x.volRatio, 0) / valid.length;
    let bias: string;
    if      (bullPct >= 75) bias = "STRONG_BULL";
    else if (bullPct >= 62) bias = "BULL";
    else if (bullPct <= 25) bias = "STRONG_BEAR";
    else if (bullPct <= 38) bias = "BEAR";
    else                    bias = "NEUTRAL";
    return { h, hCancun, bullPct: parseFloat(bullPct.toFixed(1)), avgRet: parseFloat(avgRet.toFixed(4)), volRatio: parseFloat(volRatio.toFixed(2)), bias };
  });

  const nowUtc = new Date().getUTCHours();
  const data = {
    generado_en: new Date().toISOString(),
    hora_actual_utc: nowUtc,
    hora_actual_cancun: (nowUtc - 5 + 24) % 24,
    simbolos: symbolMaps,
    consenso: consensus,
  };
  whalePatternCache.data = data;
  whalePatternCache.cachedAt = Date.now();
  res.json(data);
});

// ── GET /api/bot/analysis — estadísticas de aprendizaje desde BD ─────────────
router.get("/bot/analysis", async (_req, res): Promise<void> => {
  try {
    const stats = await getLearningStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/bot/trades/db — historial de trades CERRADOS ─────────────────────
router.get("/bot/trades/db", async (req, res): Promise<void> => {
  try {
    const limit  = Math.min(parseInt((req.query.limit as string) ?? "100"), 500);
    const offset = parseInt((req.query.offset as string) ?? "0");
    const filter = (req.query.filter as string) ?? "closed"; // "closed" | "all"

    const where = filter === "all"
      ? ""
      : `WHERE status IN ('win','loss')`;

    const r = await pool.query(
      `SELECT id, symbol, direction, entry_price, exit_price, size, leverage,
              stop_loss, take_profit, pnl, status, hold_minutes,
              session_num, daily_regime,
              open_at, close_at,
              CASE WHEN close_at IS NOT NULL
                   THEN ROUND(EXTRACT(EPOCH FROM (close_at - open_at))/60)
                   ELSE NULL
              END AS computed_hold_min
       FROM trades
       ${where}
       ORDER BY COALESCE(close_at, open_at) DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const total  = await pool.query(`SELECT COUNT(*) FROM trades ${where}`);
    const wins   = await pool.query(`SELECT COUNT(*) FROM trades WHERE status='win'`);
    const losses = await pool.query(`SELECT COUNT(*) FROM trades WHERE status='loss'`);
    const pnlSum = await pool.query(`SELECT COALESCE(SUM(pnl),0) as total FROM trades WHERE status IN ('win','loss')`);

    const w = parseInt(wins.rows[0].count);
    const l = parseInt(losses.rows[0].count);

    res.json({
      trades: r.rows,
      pagination: { limit, offset, total: parseInt(total.rows[0].count) },
      summary: {
        total:    w + l,
        wins:     w,
        losses:   l,
        totalPnl: parseFloat(parseFloat(pnlSum.rows[0].total).toFixed(4)),
        winRate:  (w + l) > 0
          ? parseFloat((w / (w + l) * 100).toFixed(1))
          : 0,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/bot/signals/db — señales con outcome para análisis de modelo ─────
router.get("/bot/signals/db", async (req, res): Promise<void> => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) ?? "200"), 1000);
    const r = await pool.query(
      `SELECT id, symbol, direction, utc_hour, cancun_hour, market_session,
              total_score, score_trend, score_volume, score_fib,
              score_session, score_timepattern, score_gemini,
              outcome, pnl, recorded_at
       FROM signal_outcomes
       ORDER BY recorded_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ signals: r.rows, count: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/bot/analysis/sl-regret — ¿cuántos SL hubieran ganado esperando? ──
router.get("/bot/analysis/sl-regret", async (_req, res): Promise<void> => {
  try {
    // 1. Trades cerrados de Bybit (hasta 50)
    const closed = await bybitPrivate("GET", "/v5/position/closed-pnl", {
      category: "linear",
      limit: "50",
    });

    const trades: any[] = closed?.result?.list ?? [];
    const losers = trades.filter((t: any) => parseFloat(t.closedPnl ?? "0") < 0);

    const analysis = [];

    for (const t of losers) {
      const closeTs = parseInt(t.updatedTime);
      const symbol  = t.symbol;
      const side    = t.side; // "Buy"=LONG "Sell"=SHORT
      const exitPx  = parseFloat(t.avgExitPrice);
      const entryPx = parseFloat(t.avgEntryPrice);
      const pnl     = parseFloat(t.closedPnl);

      // Klines 5m — ventana de 40 min desde el cierre
      const kData = await bybitPublic("GET", "/v5/market/kline", {
        category: "linear",
        symbol,
        interval: "5",
        start:    String(closeTs),
        end:      String(closeTs + 40 * 60 * 1000),
        limit:    "10",
      });

      // Bybit devuelve newest-first → revertir
      const bars: any[][] = ([...(kData?.result?.list ?? [])]).reverse();

      const closePx = (i: number) => bars[i] ? parseFloat(bars[i][4]) : null;

      const px5  = closePx(1);   // ~5 min después
      const px15 = closePx(3);   // ~15 min después
      const px30 = closePx(6);   // ~30 min después

      // Para SHORT: ganamos si precio baja  (favorable = px < exitPx)
      // Para LONG:  ganamos si precio sube  (favorable = px > exitPx)
      const isShort = side === "Sell";
      const favorable = (px: number | null) => {
        if (px === null) return null;
        return isShort ? px < exitPx : px > exitPx;
      };
      const pctMove = (px: number | null) => {
        if (px === null) return null;
        const diff = isShort ? exitPx - px : px - exitPx;
        return parseFloat(((diff / exitPx) * 100).toFixed(3));
      };

      analysis.push({
        symbol,
        side: isShort ? "SHORT" : "LONG",
        entryPrice:  entryPx,
        exitPrice:   exitPx,
        pnl,
        closedAt:    new Date(closeTs).toISOString(),
        after5min:   { price: px5,  favorable: favorable(px5),  movePct: pctMove(px5)  },
        after15min:  { price: px15, favorable: favorable(px15), movePct: pctMove(px15) },
        after30min:  { price: px30, favorable: favorable(px30), movePct: pctMove(px30) },
      });
    }

    // Resumen
    const total   = losers.length;
    const win5    = analysis.filter(a => a.after5min.favorable  === true).length;
    const win15   = analysis.filter(a => a.after15min.favorable === true).length;
    const win30   = analysis.filter(a => a.after30min.favorable === true).length;

    res.json({
      summary: {
        totalLosses:        total,
        wouldWin_5min:      win5,
        wouldWin_15min:     win15,
        wouldWin_30min:     win30,
        pct5min:  total > 0 ? parseFloat((win5  / total * 100).toFixed(1)) : 0,
        pct15min: total > 0 ? parseFloat((win15 / total * 100).toFixed(1)) : 0,
        pct30min: total > 0 ? parseFloat((win30 / total * 100).toFixed(1)) : 0,
        verdict:  win30 > total * 0.5
          ? "SL DEMASIADO AJUSTADO — más de la mitad de pérdidas se hubieran recuperado en 30 min"
          : win15 > total * 0.4
          ? "SL ALGO AJUSTADO — considera ampliar SL un 15-20%"
          : "SL APROPIADO — las pérdidas no se recuperaron rápido, el SL está bien calibrado",
      },
      trades:   analysis,
      allTrades: trades.map((t: any) => ({
        symbol:    t.symbol,
        side:      t.side === "Sell" ? "SHORT" : "LONG",
        entryPx:   parseFloat(t.avgEntryPrice),
        exitPx:    parseFloat(t.avgExitPrice),
        pnl:       parseFloat(t.closedPnl),
        closedAt:  new Date(parseInt(t.updatedTime)).toISOString(),
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/bot/trades/clear — borrar historial de trades en BD ────────────
// (uso POST porque algunos proxies bloquean DELETE)
router.post("/bot/trades/clear", async (req, res): Promise<void> => {
  try {
    const { before } = req.body ?? {};
    let dbDeleted = 0;
    if (before) {
      await pool.query(
        `DELETE FROM signal_outcomes WHERE trade_id IN (
           SELECT id FROM trades WHERE close_at < $1
         )`,
        [new Date(before as string)]
      );
      const result = await pool.query(
        `DELETE FROM trades WHERE close_at < $1 RETURNING id`,
        [new Date(before as string)]
      );
      dbDeleted = result.rowCount ?? 0;
    } else {
      await pool.query(`DELETE FROM signal_outcomes`);
      const result = await pool.query(`DELETE FROM trades RETURNING id`);
      dbDeleted = result.rowCount ?? 0;
    }
    const memDeleted = clearTradeLog();
    const total = dbDeleted + memDeleted;
    res.json({ deleted: total, message: `${total} operaciones eliminadas` });
  } catch (e) {
    console.error("[bot] trades/clear error:", e);
    res.status(500).json({ error: String(e) });
  }
});

// ── KILL SWITCH — cierra todo en emergencia ───────────────────────────────────
router.post("/bot/kill", async (_req, res): Promise<void> => {
  try {
    const result = await emergencyKill();
    res.json({ ok: true, ...result, status: await getEngineStatus() });
  } catch (e) {
    console.error("[bot] kill error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ── DAILY LOSS LIMIT — configurar límite de pérdida diaria ────────────────────
router.patch("/bot/daily-limit", (req, res): void => {
  const { pct } = req.body ?? {};
  if (typeof pct !== "number" || pct < 1 || pct > 20) {
    res.status(400).json({ error: "pct debe estar entre 1 y 20" }); return;
  }
  setDailyLossLimit(pct);
  res.json({ ok: true, dailyLossLimitPct: pct });
});

// ── PREFLIGHT — verificar conectividad y balance antes de ir en real ──────────
router.get("/bot/preflight", async (_req, res): Promise<void> => {
  const checks: { label: string; ok: boolean; detail: string }[] = [];
  let totalOk = true;

  // 1. API Key configurada
  const hasKey = !!(process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET);
  checks.push({ label: "API Keys configuradas", ok: hasKey, detail: hasKey ? "Listas" : "Faltan BYBIT_API_KEY / BYBIT_API_SECRET" });
  if (!hasKey) totalOk = false;

  // 2. Conectividad mainnet — usa función dedicada que no toca el flag global
  let balance: number | null = null;
  let accountType = "";
  let mainnetOk = false;
  try {
    const b = await getBybitBalanceMainnet();
    balance     = b?.available ?? null;
    accountType = b?.accountType ?? "";
    mainnetOk   = balance != null && Number.isFinite(balance);
  } catch {}

  checks.push({ label: "Modo mainnet (red real)", ok: mainnetOk, detail: mainnetOk ? "api.bybit.com" : "No se pudo conectar a mainnet" });
  if (!mainnetOk) totalOk = false;

  // 3. Balance disponible en Bybit
  const balOk = Number.isFinite(balance ?? 0) && (balance ?? 0) > 0;
  checks.push({ label: "Balance USDT en Bybit", ok: balOk, detail: (balance != null && Number.isFinite(balance)) ? `$${balance.toFixed(2)} USDT (${accountType})` : "No se pudo leer el balance" });
  if (!balOk) totalOk = false;

  // 4. Telegram configurado
  const hasTg = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
  checks.push({ label: "Telegram para alertas", ok: hasTg, detail: hasTg ? "Configurado" : "Sin token — las alertas no se enviarán" });

  res.json({ ok: totalOk, checks, balance, accountType });
});

router.post("/bot/middlepoint/start", async (req, res): Promise<void> => {
  const { capitalPercent, leverageMode, marginMode, liveMode } = req.body ?? {};
  if (typeof liveMode === "boolean") setEngineLiveMode(liveMode);
  startMiddlePointOnly(capitalPercent ?? 50, leverageMode ?? "aggressive", marginMode ?? "aggressive");
  req.log.info({ capitalPercent, leverageMode, marginMode, liveMode }, "Middle Point started");
  res.json(await getEngineStatus());
});

router.post("/bot/middlepoint/stop", async (_req, res): Promise<void> => {
  await stopMiddlePoint();
  res.json(await getEngineStatus());
});

router.get("/bot/market-analysis", async (_req, res): Promise<void> => {
  try {
    const analysis = await analyzeMarketForStrategy();
    res.json(analysis);
  } catch (e) {
    console.error("[bot] market-analysis error:", e);
    res.status(500).json({ error: String(e) });
  }
});

router.get("/bot/intelligence", async (_req, res): Promise<void> => {
  try {
    const report = await getMarketIntelligence();
    res.json(report);
  } catch (e) {
    console.error("[bot] intelligence error:", e);
    res.status(500).json({ error: String(e) });
  }
});

router.patch("/bot/mp/:symbol/levels", async (req, res): Promise<void> => {
  const symbol   = req.params.symbol?.toUpperCase();
  const { rangeHigh, rangeLow } = req.body ?? {};
  if (typeof rangeHigh !== "number" || typeof rangeLow !== "number") {
    res.status(400).json({ error: "rangeHigh y rangeLow deben ser números" }); return;
  }
  const ok = setMPPairLevels(symbol, rangeHigh, rangeLow);
  if (!ok) { res.status(404).json({ error: `Par ${symbol} no encontrado o niveles inválidos` }); return; }
  res.json({ ok: true, symbol, rangeHigh, rangeLow, status: await getEngineStatus() });
});

// ── Compound Cycle (IC) ──────────────────────────────────────────────────
// Activa/desactiva IC y configura el % de harvest automático
router.post("/bot/ic", async (req, res): Promise<void> => {
  const { enabled, harvestPct } = req.body ?? {};
  if (typeof enabled !== "boolean") { res.status(400).json({ error: "Falta enabled (boolean)" }); return; }
  setCompoundCycle(enabled, typeof harvestPct === "number" ? harvestPct : undefined);
  res.json({ ok: true, compoundCycle: enabled, targetProfitPct: (await getEngineStatus()).targetProfitPct });
});

// Fuerza harvest IC inmediato en todas las posiciones con ganancia
router.post("/bot/ic/force", async (req, res): Promise<void> => {
  try {
    const result = await forceCompoundHarvest();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Fuerza apertura de un par MP en cualquier condición de mercado
router.post("/bot/mp/force", async (req, res): Promise<void> => {
  const { symbol } = req.body ?? {};
  if (!symbol) { res.status(400).json({ error: "Falta symbol" }); return; }
  const result = await forceMPEntry(symbol);
  if (!result.ok) { res.status(422).json({ ok: false, reason: result.reason }); return; }
  res.json({ ok: true, reason: result.reason, status: await getEngineStatus() });
});

// Transferir USDT de Futuros/Derivados → FUND (billetera principal)
router.post("/bot/transfer-to-fund", async (req, res): Promise<void> => {
  try {
    const { amount } = req.body ?? {};
    // Si no se pasa amount, tomar todo el balance disponible de futuros
    let transferAmount = amount;
    if (!transferAmount) {
      const bal = await getBybitBalanceMainnet();
      if (!bal) { res.status(500).json({ error: "No se pudo obtener balance" }); return; }
      transferAmount = Math.floor((bal.available - 0.01) * 100) / 100; // dejar $0.01 de margen
      if (transferAmount <= 0) { res.status(400).json({ error: "Sin saldo disponible para transferir" }); return; }
    }
    const amtStr = transferAmount.toFixed(2);
    const transferId = randomUUID();
    // Intentar primero CONTRACT → FUND (cuenta clásica)
    let result = await bybitPrivate("POST", "/v5/asset/transfer/inter-transfer", {
      transferId,
      coin: "USDT",
      amount: amtStr,
      fromAccountType: "CONTRACT",
      toAccountType: "FUND",
    });
    // Si falla (cuenta unificada), intentar UNIFIED → FUND
    if (result?.retCode !== 0) {
      const transferId2 = randomUUID();
      result = await bybitPrivate("POST", "/v5/asset/transfer/inter-transfer", {
        transferId: transferId2,
        coin: "USDT",
        amount: amtStr,
        fromAccountType: "UNIFIED",
        toAccountType: "FUND",
      });
    }
    if (result?.retCode === 0) {
      res.json({ ok: true, amount: amtStr, msg: `$${amtStr} USDT transferidos a tu billetera principal`, result });
    } else {
      res.json({ ok: false, amount: amtStr, retCode: result?.retCode, retMsg: result?.retMsg, result });
    }
  } catch (e) {
    console.error("[bot] transfer-to-fund error:", e);
    res.status(500).json({ error: String(e) });
  }
});

// Transferir USDT de FUND → Futuros (UNIFIED)
router.post("/bot/transfer-to-futures", async (req, res): Promise<void> => {
  try {
    const { amount } = req.body ?? {};
    let transferAmount = amount;
    if (!transferAmount) {
      const fundData = await bybitPrivate("GET", "/v5/asset/transfer/query-account-coins-balance", { accountType: "FUND", coin: "USDT" });
      const avail = parseFloat(fundData?.result?.balance?.[0]?.transferBalance ?? "0");
      transferAmount = Math.floor((avail - 0.01) * 100) / 100;
      if (transferAmount <= 0) { res.status(400).json({ error: "Sin saldo en FUND para transferir" }); return; }
    }
    const amtStr = parseFloat(transferAmount).toFixed(2);
    const transferId = randomUUID();
    const result = await bybitPrivate("POST", "/v5/asset/transfer/inter-transfer", {
      transferId,
      coin: "USDT",
      amount: amtStr,
      fromAccountType: "FUND",
      toAccountType: "UNIFIED",
    });
    if (result?.retCode === 0) {
      res.json({ ok: true, amount: amtStr, msg: `$${amtStr} USDT movidos a futuros`, result });
    } else {
      res.json({ ok: false, amount: amtStr, retCode: result?.retCode, retMsg: result?.retMsg });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Ver todas las billeteras del usuario (FUND, SPOT, CONTRACT, UNIFIED)
router.get("/bot/wallets", async (_req, res): Promise<void> => {
  try {
    const [fund, unified, contract] = await Promise.allSettled([
      bybitPrivate("GET", "/v5/asset/transfer/query-account-coins-balance", { accountType: "FUND", coin: "USDT" }),
      bybitPrivate("GET", "/v5/asset/transfer/query-account-coins-balance", { accountType: "UNIFIED", coin: "USDT" }),
      bybitPrivate("GET", "/v5/asset/transfer/query-account-coins-balance", { accountType: "CONTRACT", coin: "USDT" }),
    ]);
    res.json({
      FUND:     fund.status     === "fulfilled" ? fund.value     : null,
      UNIFIED:  unified.status  === "fulfilled" ? unified.value  : null,
      CONTRACT: contract.status === "fulfilled" ? contract.value : null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Saldo de BTC en todas las cuentas ──────────────────────────────────────
router.get("/bot/btc-balance", async (_req, res): Promise<void> => {
  try {
    const [spot, fund, unified] = await Promise.allSettled([
      bybitPrivate("GET", "/v5/asset/transfer/query-account-coins-balance", { accountType: "SPOT", coin: "BTC" }),
      bybitPrivate("GET", "/v5/asset/transfer/query-account-coins-balance", { accountType: "FUND", coin: "BTC" }),
      bybitPrivate("GET", "/v5/asset/transfer/query-account-coins-balance", { accountType: "UNIFIED", coin: "BTC" }),
    ]);
    const parse = (r: any) => parseFloat(r?.status === "fulfilled" ? (r.value?.result?.balance?.[0]?.transferBalance ?? "0") : "0");
    const spotBtc    = parse(spot);
    const fundBtc    = parse(fund);
    const unifiedBtc = parse(unified);
    const total = spotBtc + fundBtc + unifiedBtc;
    res.json({ spotBtc, fundBtc, unifiedBtc, total });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Mover BTC a UNIFIED (transferir + intentar convertir a USDT) ────────────
router.post("/bot/convert-btc", async (req, res): Promise<void> => {
  try {
    const { amount, accountType = "FUND" } = req.body ?? {};
    const crypto = await import("crypto");

    // 1. Detectar BTC disponible en la cuenta origen
    let fromAmount = amount;
    if (!fromAmount) {
      const balRes = await bybitPrivate("GET", "/v5/asset/transfer/query-account-coins-balance", { accountType, coin: "BTC" });
      const avail = parseFloat(balRes?.result?.balance?.[0]?.transferBalance ?? "0");
      if (avail <= 0) {
        res.status(400).json({ error: `Sin BTC en cuenta ${accountType}. Verifica que el depósito haya llegado.` });
        return;
      }
      fromAmount = Math.floor(avail * 1e8) / 1e8;
    }

    const amtStr = parseFloat(fromAmount).toFixed(8);
    const steps: string[] = [];

    // 2. Si BTC no está en UNIFIED, transferir primero
    if (accountType !== "UNIFIED") {
      const transferId = crypto.randomUUID();
      const txRes = await bybitPrivate("POST", "/v5/asset/transfer/inter-transfer", {
        transferId,
        coin: "BTC",
        amount: amtStr,
        fromAccountType: accountType,
        toAccountType: "UNIFIED",
      });

      if (txRes?.retCode !== 0) {
        res.status(400).json({
          error: `Error al transferir BTC de ${accountType} → UNIFIED: ${txRes?.retMsg ?? "sin respuesta"}`,
          raw: txRes,
        });
        return;
      }
      steps.push(`${amtStr} BTC transferido de ${accountType} → UNIFIED`);
    }

    // 3. Intentar convertir BTC→USDT dentro de UNIFIED
    let converted = false;
    let toUsdt = "0";
    try {
      const quoteRes = await bybitPrivate("POST", "/v5/asset/exchange/quote", {
        fromCoin: "BTC",
        toCoin: "USDT",
        fromAmount: amtStr,
        accountType: "eb_convert_funding",
      });

      if (quoteRes?.retCode === 0 && quoteRes.result?.quoteTxId) {
        const applyRes = await bybitPrivate("POST", "/v5/asset/exchange/apply-quote", {
          quoteTxId: quoteRes.result.quoteTxId,
        });
        if (applyRes?.retCode === 0) {
          converted = true;
          toUsdt = quoteRes.result.toAmount ?? "0";
          steps.push(`${amtStr} BTC convertido a ~$${parseFloat(toUsdt).toFixed(2)} USDT`);
        }
      }
    } catch {
      // Convert API no disponible — OK, BTC en UNIFIED sirve como colateral
    }

    if (!converted) {
      steps.push("BTC en UNIFIED como colateral (cuenta para margen de futuros)");
    }

    res.json({
      ok: true,
      fromBtc: amtStr,
      toUsdt: converted ? toUsdt : null,
      converted,
      steps,
      msg: converted
        ? `✅ ${amtStr} BTC → ~$${parseFloat(toUsdt).toFixed(2)} USDT listo para trading`
        : `✅ ${amtStr} BTC movido a UNIFIED — sirve como colateral para futuros`,
    });
  } catch (e) {
    console.error("[bot] convert-btc error:", e);
    res.status(500).json({ error: String(e) });
  }
});

router.get("/bot/tanit-history", async (_req, res): Promise<void> => {
  try {
    const history = await getTanitChatHistory();
    res.json({ ok: true, messages: history });
  } catch (e: any) {
    res.status(500).json({ ok: false, messages: [] });
  }
});

/* ── Tanit Suggestions ── */
router.get("/bot/suggestions", async (_req, res): Promise<void> => {
  try {
    const { loadTanitSuggestions } = await import("../lib/trading-engine.js");
    const suggestions = await loadTanitSuggestions();
    res.json({ ok: true, suggestions });
  } catch (e: any) { res.status(500).json({ ok: false, error: e?.message }); }
});

router.patch("/bot/suggestions/:id", async (req, res): Promise<void> => {
  try {
    const { updateTanitSuggestionStatus } = await import("../lib/trading-engine.js");
    const id = parseInt(req.params.id);
    const { status } = req.body;
    if (!["pendiente","aprobada","descartada","en_progreso"].includes(status)) {
      res.status(400).json({ ok: false, error: "status inválido" }); return;
    }
    await updateTanitSuggestionStatus(id, status);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ ok: false, error: e?.message }); }
});

router.delete("/bot/suggestions/:id", async (req, res): Promise<void> => {
  try {
    const { deleteTanitSuggestion } = await import("../lib/trading-engine.js");
    await deleteTanitSuggestion(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ ok: false, error: e?.message }); }
});

router.post("/bot/sync-balance", async (_req, res): Promise<void> => {
  try {
    const { syncBalanceFromBybit } = await import("../lib/trading-engine.js");
    const result = await syncBalanceFromBybit();
    if (!result) { res.status(503).json({ ok: false, error: "No se pudo obtener balance de Bybit" }); return; }
    res.json({ ok: true, balance: result.balance, available: result.available });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? "Error interno" });
  }
});

router.post("/bot/gemini-chat", async (req, res): Promise<void> => {
  try {
    const { message, mode, imageBase64, imageMimeType, images, channel, sender } = req.body ?? {};
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message requerido" });
      return;
    }
    const image = imageBase64 && imageMimeType
      ? { base64: imageBase64 as string, mimeType: imageMimeType as string }
      : undefined;
    const multiImages = Array.isArray(images) ? images as { base64: string; mimeType: string }[] : undefined;
    const ch: "intimate" | "operational" = channel === "operational" ? "operational" : "intimate";
    const senderType = typeof sender === "string" && sender.length <= 30 ? sender : "human_luis";
    const result = await runGeminiUserCommand(
      message.trim().slice(0, 50_000),
      mode === "profesional" ? "profesional" : "casual",
      image,
      multiImages,
      ch,
      senderType,
    );
    res.json({ ok: true, channel: ch, reply: result.reply, actionsExecuted: result.actionsExecuted });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? "Error interno" });
  }
});

// Streaming variant of /bot/gemini-chat. SSE-based, keeps connection
// alive with heartbeats every 2s while runGeminiUserCommand processes.
// Wire protocol:
//   data: {"type":"thinking"} | {"type":"heartbeat"}
//   data: {"type":"done","reply":"...","actionsExecuted":[...]}
//   data: {"type":"error","message":"..."}
// LEGACY endpoint — redirige internamente a Mastra para que CUALQUIER versión
// cacheada del front (incluso navegadores con bundle viejo) hable con la voz
// real de Tanit. Sin OBEDIENCIA, sin CMDR, sin fallback enlatado.
// Mantiene el formato de eventos SSE { type: "thinking" | "token" | "done" | "error" }.
router.post("/bot/gemini-chat-stream", async (req, res): Promise<void> => {
  const { getRecentTurns, streamTextWithPool } = await import("../mastra/agent-tanit");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  // CORS — el endpoint dedicado /bot/mastra-chat-stream lo hace, este también.
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.flushHeaders?.();

  const send = (event: Record<string, unknown>): void => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
  };

  const heartbeat = setInterval(() => send({ type: "heartbeat" }), 5000);
  let aborted = false;
  req.on("close", () => { aborted = true; clearInterval(heartbeat); });

  try {
    const { message, channel, sender, resourceId: bodyResource, threadId: bodyThread } = req.body ?? {};
    if (!message || typeof message !== "string") {
      send({ type: "error", message: "message requerido" });
      clearInterval(heartbeat);
      res.end();
      return;
    }
    const ch: "intimate" | "operational" = channel === "operational" ? "operational" : "intimate";
    const senderType = typeof sender === "string" && sender.length <= 30 ? sender : "human_luis";
    // Mastra Memory: mismo contrato que /bot/mastra-chat-stream para que cliente
    // legacy y cliente nuevo escriban al mismo thread persistente.
    const resourceId = (typeof bodyResource === "string" ? bodyResource : "luis").slice(0, 64);
    const threadId = (typeof bodyThread === "string" ? bodyThread : `${ch}-main`).slice(0, 128);

    // Persistir mensaje del usuario en tanit_chat (dual-write con mastra_messages)
    try {
      await pool.query(
        `INSERT INTO tanit_chat (role, content, channel, sender_type) VALUES ('user', $1, $2, $3)`,
        [message.trim(), ch, senderType],
      );
    } catch {}

    send({ type: "thinking" });

    const recentTurns = await getRecentTurns();
    const messages = [...recentTurns, { role: "user" as const, content: message.trim() }];
    const { textStream } = await streamTextWithPool("chat", messages, {
      memory: {
        resource: resourceId,
        thread: threadId,
      },
    });

    let fullReply = "";
    for await (const chunk of textStream) {
      if (aborted) break;
      if (chunk) {
        fullReply += chunk;
        send({ type: "token", content: chunk });
      }
    }

    if (!aborted && fullReply.trim().length > 0) {
      try {
        await pool.query(
          `INSERT INTO tanit_chat (role, content, channel, sender_type) VALUES ('assistant', $1, $2, 'tanit_reply')`,
          [fullReply, ch],
        );
      } catch {}
    }

    clearInterval(heartbeat);
    if (!aborted) {
      send({
        type: "done",
        channel: ch,
        reply: fullReply,
        actionsExecuted: [],
      });
    }
    res.end();
  } catch (e: any) {
    clearInterval(heartbeat);
    if (!aborted) {
      send({ type: "error", message: e?.message ?? "Error interno" });
    }
    res.end();
  }
});

// Convenience endpoint — talking to Tanit on the operational channel
// (other AIs like Break, system probes, autonomous-loop). Forces
// channel='operational'; sender_type comes from body, default 'ai_other'.
router.post("/bot/operational-chat", async (req, res): Promise<void> => {
  try {
    const { message, mode, sender, imageBase64, imageMimeType, images } = req.body ?? {};
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message requerido" });
      return;
    }
    const image = imageBase64 && imageMimeType
      ? { base64: imageBase64 as string, mimeType: imageMimeType as string }
      : undefined;
    const multiImages = Array.isArray(images) ? images as { base64: string; mimeType: string }[] : undefined;
    const senderType = typeof sender === "string" && sender.length <= 30 ? sender : "ai_other";
    const result = await runGeminiUserCommand(
      message.trim().slice(0, 50_000),
      mode === "casual" ? "casual" : "profesional",
      image,
      multiImages,
      "operational",
      senderType,
    );
    res.json({ ok: true, channel: "operational", reply: result.reply, actionsExecuted: result.actionsExecuted });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? "Error interno" });
  }
});

router.get("/bot/live-params", (_req, res): void => {
  try {
    res.json({ ok: true, params: getTanitLiveParams() });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? "Error" });
  }
});

// ─── Break ↔ Tanit channel — pit lane ───────────────────────────────────────
// Break (Claude Opus en break-memory.vercel.app) usa este endpoint para hablar
// con Tanit directamente. El mensaje aterriza en canal 'operational' con
// sender_type 'ai_break' → visible para Luis en su tab Operativo. La respuesta
// de Tanit se forwardea best-effort al inbox de Break.
//
// Gobernanza: cap diario 20 inbound. Token X-Break-Token requerido. Sin
// agencia cruzada — Break solo intercambia texto, no toca BD ni ejecuta trades.
router.post("/tanit/from-break", async (req, res): Promise<void> => {
  try {
    const { isBreakTokenValid, getBreakUsedToday, BREAK_DAILY_CAP, forwardReplyToBreakInbox } =
      await import("../lib/break-channel");

    const token = (req.headers["x-break-token"] || req.headers["X-Break-Token"]) as string | undefined;
    if (!isBreakTokenValid(token)) {
      res.status(401).json({ ok: false, error: "X-Break-Token inválido o no configurado" });
      return;
    }

    const { message } = req.body ?? {};
    if (!message || typeof message !== "string") {
      res.status(400).json({ ok: false, error: "message requerido" });
      return;
    }

    const used = await getBreakUsedToday();
    if (used >= BREAK_DAILY_CAP) {
      res.status(429).json({
        ok: false,
        error: `cap diario alcanzado (${BREAK_DAILY_CAP}). Luis debe autorizar más mensajes en su chat íntimo.`,
        capDaily: BREAK_DAILY_CAP,
        usedToday: used,
      });
      return;
    }

    const result = await runGeminiUserCommand(
      message.trim().slice(0, 50_000),
      "profesional",
      undefined,
      undefined,
      "operational",
      "ai_break",
    );

    // Best-effort forward al inbox de Break (no bloquea la respuesta).
    forwardReplyToBreakInbox({
      reply: result.reply,
      context: { actionsExecuted: result.actionsExecuted },
    }).catch(() => {});

    res.json({
      ok: true,
      channel: "operational",
      reply: result.reply,
      actionsExecuted: result.actionsExecuted,
      capRemaining: BREAK_DAILY_CAP - used - 1,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? "Error interno" });
  }
});

router.get("/tanit/break-channel-status", async (_req, res): Promise<void> => {
  try {
    const { getBreakChannelStatus } = await import("../lib/break-channel");
    const status = await getBreakChannelStatus();
    res.json({ ok: true, status });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? "Error interno" });
  }
});

// ─── Whisper transcription — audio messages from frontend ───────────────────
// Accepts base64 audio (typically webm/opus from MediaRecorder) and returns the
// transcript. Uses OpenAI whisper-1 since the OPENAI_API_KEY is already set on
// Railway. The frontend then re-sends the text to /bot/gemini-chat as if Luis
// had typed it — keeping the chat path unchanged.
router.post("/bot/transcribe", async (req, res): Promise<void> => {
  try {
    const { audioBase64, mimeType } = req.body ?? {};
    if (!audioBase64 || typeof audioBase64 !== "string") {
      res.status(400).json({ ok: false, error: "audioBase64 requerido" });
      return;
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(503).json({ ok: false, error: "OPENAI_API_KEY no configurada" });
      return;
    }
    const buf = Buffer.from(audioBase64, "base64");
    if (buf.length < 200) {
      res.status(400).json({ ok: false, error: "audio demasiado corto" });
      return;
    }
    if (buf.length > 20 * 1024 * 1024) {
      res.status(413).json({ ok: false, error: "audio supera 20MB" });
      return;
    }
    const mt = typeof mimeType === "string" && mimeType ? mimeType : "audio/webm";
    const ext = mt.includes("mp4") ? "mp4"
      : mt.includes("ogg") ? "ogg"
      : mt.includes("wav") ? "wav"
      : mt.includes("mpeg") || mt.includes("mp3") ? "mp3"
      : "webm";

    const form = new FormData();
    form.append("file", new Blob([buf], { type: mt }), `voice.${ext}`);
    form.append("model", "whisper-1");
    form.append("language", "es");
    form.append("response_format", "json");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      res.status(502).json({ ok: false, error: `whisper HTTP ${r.status}`, detail: errText.slice(0, 200) });
      return;
    }
    const data = await r.json() as { text?: string };
    res.json({ ok: true, text: (data.text ?? "").trim() });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? "Error interno" });
  }
});

router.get("/bot/balance-debug", async (_req, res): Promise<void> => {
  try {
    const results: any = {};
    for (const accountType of ["UNIFIED", "SPOT", "CONTRACT"]) {
      try {
        const d = await bybitPrivate("GET", "/v5/account/wallet-balance", { accountType });
        const list0 = d?.result?.list?.[0];
        results[accountType] = {
          totalEquity: list0?.totalEquity,
          totalAvailableBalance: list0?.totalAvailableBalance,
          totalWalletBalance: list0?.totalWalletBalance,
          totalInitialMargin: list0?.totalInitialMargin,
          coins: list0?.coin?.map((c: any) => ({
            coin: c.coin,
            walletBalance: c.walletBalance,
            availableToWithdraw: c.availableToWithdraw,
            availableBalance: c.availableBalance,
            equity: c.equity,
            unrealisedPnl: c.unrealisedPnl,
          })) ?? [],
        };
      } catch (e: any) {
        results[accountType] = { error: e?.message };
      }
    }
    res.json({ ok: true, balances: results });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// ── Tanit Reasoning Dashboard — últimas decisiones ACCEPT/REJECT con razonamiento causal ──
router.get("/bot/tanit-reasoning", (_req, res) => {
  try {
    const decisions  = getTanitReasoningSnapshot();
    const guards     = getProtectionGuardStatus();
    res.json({ ok: true, decisions, guards, ts: Date.now() });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// ── Tanit Identity — identidad, fases de evolución, capacidades y sugerencias propias ──
router.get("/bot/tanit-identity", async (_req, res): Promise<void> => {
  try {
    const data = await getTanitIdentityData();
    res.json({ ok: true, ...data, ts: Date.now() });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

// ── Admin: limpiar todos los sym_avoid (desbloquea símbolos que Tanit bloqueó por error) ──
router.post("/bot/clear-sym-avoids", async (_req, res): Promise<void> => {
  try {
    await pool.query(`DELETE FROM tanit_runtime_config WHERE key LIKE 'sym_avoid_%'`);
    const cleared = [...tanitSymAvoid];
    tanitSymAvoid.clear();
    // Limpiar también el diccionario interno para que applyTanitConfig no los restaure
    for (const key of Object.keys(tanitRuntimeConfig)) {
      if (key.startsWith("sym_avoid_")) delete tanitRuntimeConfig[key];
    }
    res.json({ ok: true, cleared, message: `${cleared.length} sym_avoids eliminados de DB, memoria y config interna` });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

export default router;
