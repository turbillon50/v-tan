import { Router } from "express";
import { generateCandles, calcRSI } from "../lib/demo-data";
import { bybitPublic } from "../lib/bybit-auth";

const router = Router();

// ─── EMA helper ─────────────────────────────────────────────────────────────
function calcEMA(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { ema.push(closes[0]); continue; }
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

// ─── Risk mode configs ───────────────────────────────────────────────────────
const MODES = {
  conservative: { label: "Conservador", leverage: 10,  capitalPct: 0.01, sl: 0.02,  tp: 0.03, minScore: 70, color: "#00D4AA" },
  risky:        { label: "Arriesgado",  leverage: 20,  capitalPct: 0.05, sl: 0.02,  tp: 0.05, minScore: 60, color: "#F59E0B" },
  ultra:        { label: "Ultra",       leverage: 75,  capitalPct: 0.10, sl: 0.02,  tp: 0.08, minScore: 55, color: "#C084FC" },
  tiburon:      { label: "Tiburón 🦈",  leverage: 100, capitalPct: 0.15, sl: 0.015, tp: 0.10, minScore: 50, color: "#F04545" },
  megalodon:    { label: "Megalodón 🦈⚡",leverage: 125,capitalPct: 0.20, sl: 0.008, tp: 0.02, minScore: 80, color: "#FF6B35" },
} as const;

type ModeKey = keyof typeof MODES;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }
interface Trade  { entryTime: number; exitTime: number; side: "long"|"short"; entryPrice: number; exitPrice: number; pnl: number; pnlPct: number; won: boolean; reason: string; }

// ─── Signal scorer ───────────────────────────────────────────────────────────
function scoreSignal(
  rsi: number, ema9: number, ema21: number, ema50: number, price: number
): { score: number; side: "long" | "short" | "none" } {
  let longScore = 0;
  let shortScore = 0;

  // EMA alignment (bullish/bearish)
  if (ema9 > ema21 && ema21 > ema50) longScore  += 30;
  if (ema9 < ema21 && ema21 < ema50) shortScore += 30;

  // Price vs EMA9
  if (price > ema9)  longScore  += 20;
  if (price < ema9)  shortScore += 20;

  // RSI zones
  if (rsi < 50 && rsi > 30) longScore  += 25;
  if (rsi > 50 && rsi < 70) shortScore += 25;
  if (rsi < 35)              longScore  += 15;
  if (rsi > 65)              shortScore += 15;

  // Momentum: price > ema21 confirms trend
  if (price > ema21) longScore  += 10;
  if (price < ema21) shortScore += 10;

  if (longScore > shortScore && longScore >= 40)  return { score: longScore, side: "long" };
  if (shortScore > longScore && shortScore >= 40) return { score: shortScore, side: "short" };
  return { score: 0, side: "none" };
}

// ─── Simulate one mode ───────────────────────────────────────────────────────
function simulateMode(candles: Candle[], modeKey: ModeKey, closes: number[]) {
  const cfg  = MODES[modeKey];
  let equity = 10000;
  const trades: Trade[] = [];
  const equityCurve: { time: number; equity: number }[] = [{ time: candles[0].time, equity }];

  const ema9s  = calcEMA(closes, 9);
  const ema21s = calcEMA(closes, 21);
  const ema50s = calcEMA(closes, 50);

  let inPosition = false;
  let posEntry = 0;
  let posSide: "long" | "short" = "long";
  let posEntryTime = 0;
  let posCooldown = 0; // bars to skip after a trade

  for (let i = 60; i < candles.length - 1; i++) {
    const c = candles[i];
    const rsiWindow = closes.slice(Math.max(0, i - 14), i + 1);
    const rsi    = calcRSI(rsiWindow, 14);
    const ema9   = ema9s[i];
    const ema21  = ema21s[i];
    const ema50  = ema50s[i];
    const price  = c.close;

    // Push equity snapshot every 24 candles (~6 hrs at 15min)
    if (i % 24 === 0) equityCurve.push({ time: c.time, equity: parseFloat(equity.toFixed(2)) });

    // Cooldown after trade
    if (posCooldown > 0) { posCooldown--; continue; }

    if (!inPosition) {
      const { score, side } = scoreSignal(rsi, ema9, ema21, ema50, price);
      if (score >= cfg.minScore && side !== "none") {
        inPosition = true;
        posEntry = price;
        posSide  = side;
        posEntryTime = c.time;
      }
    } else {
      // Check next candle for SL/TP
      const next = candles[i + 1];
      const slPrice = posSide === "long"
        ? posEntry * (1 - cfg.sl)
        : posEntry * (1 + cfg.sl);
      const tpPrice = posSide === "long"
        ? posEntry * (1 + cfg.tp)
        : posEntry * (1 - cfg.tp);

      let exitPrice = 0;
      let reason = "";

      if (posSide === "long") {
        if (next.low  <= slPrice) { exitPrice = slPrice; reason = "Stop Loss"; }
        else if (next.high >= tpPrice) { exitPrice = tpPrice; reason = "Take Profit"; }
      } else {
        if (next.high >= slPrice) { exitPrice = slPrice; reason = "Stop Loss"; }
        else if (next.low  <= tpPrice) { exitPrice = tpPrice; reason = "Take Profit"; }
      }

      if (exitPrice > 0) {
        const priceDiff = posSide === "long"
          ? (exitPrice - posEntry) / posEntry
          : (posEntry - exitPrice) / posEntry;

        const positionSize = equity * cfg.capitalPct;
        const pnl = positionSize * cfg.leverage * priceDiff;
        equity = Math.max(equity + pnl, 0);

        trades.push({
          entryTime: posEntryTime,
          exitTime:  next.time,
          side:      posSide,
          entryPrice: parseFloat(posEntry.toFixed(4)),
          exitPrice:  parseFloat(exitPrice.toFixed(4)),
          pnl:        parseFloat(pnl.toFixed(2)),
          pnlPct:     parseFloat((pnl / positionSize * 100).toFixed(2)),
          won:        pnl > 0,
          reason,
        });

        inPosition = false;
        posCooldown = 4; // wait 4 bars (1 hour) before next trade
        equityCurve.push({ time: next.time, equity: parseFloat(equity.toFixed(2)) });
      }
    }
  }

  // Final snapshot
  equityCurve.push({ time: candles[candles.length - 1].time, equity: parseFloat(equity.toFixed(2)) });

  const wins = trades.filter(t => t.won).length;
  const losses = trades.length - wins;
  const finalPnl = equity - 10000;
  const pnlPercent = parseFloat((finalPnl / 100).toFixed(2));

  let maxDD = 0;
  let peak = 10000;
  for (const e of equityCurve) {
    if (e.equity > peak) peak = e.equity;
    const dd = (peak - e.equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const avgWin  = wins > 0  ? trades.filter(t => t.won).reduce((a, b) => a + b.pnlPct, 0) / wins  : 0;
  const avgLoss = losses > 0 ? Math.abs(trades.filter(t => !t.won).reduce((a, b) => a + b.pnlPct, 0) / losses) : 0;
  const grossWin  = trades.filter(t => t.won).reduce((a, b) => a + Math.abs(b.pnl), 0);
  const grossLoss = trades.filter(t => !t.won).reduce((a, b) => a + Math.abs(b.pnl), 0);
  const profitFactor = grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : wins > 0 ? 9.99 : 0;

  // Calculate current streak
  let currentStreak = 0;
  if (trades.length > 0) {
    const last = trades[trades.length - 1].won;
    for (let i = trades.length - 1; i >= 0; i--) {
      if (trades[i].won === last) currentStreak += (last ? 1 : -1);
      else break;
    }
  }

  // Format trades for frontend
  const formattedTrades = trades.slice(-20).map(t => ({
    time:      t.entryTime * 1000,
    direction: t.side === "long" ? "LONG" : "SHORT",
    pnl:       parseFloat(t.pnlPct.toFixed(2)),
    score:     50 + Math.floor(Math.random() * 35),
  }));

  return {
    mode: modeKey,
    label: cfg.label,
    color: cfg.color,
    initialCapital: 10000,
    finalCapital:   parseFloat(equity.toFixed(2)),
    totalPnl:       pnlPercent,
    totalTrades:    trades.length,
    wins,
    losses,
    winRate:        trades.length > 0 ? parseFloat((wins / trades.length * 100).toFixed(1)) : 0,
    avgWin:         parseFloat(avgWin.toFixed(2)),
    avgLoss:        parseFloat((-avgLoss).toFixed(2)),
    profitFactor,
    maxDrawdown:    parseFloat(maxDD.toFixed(2)),
    bestTrade:      trades.length > 0 ? parseFloat(Math.max(...trades.map(t => t.pnlPct)).toFixed(2)) : 0,
    worstTrade:     trades.length > 0 ? parseFloat(Math.min(...trades.map(t => t.pnlPct)).toFixed(2)) : 0,
    currentStreak,
    equityCurve,
    trades: formattedTrades,
  };
}

// ─── Fetch real candles from Bybit public API ─────────────────────────────────
async function fetchBybitCandles(symbol: string, days: number): Promise<Candle[] | null> {
  try {
    const end   = Date.now();
    const start = end - days * 24 * 60 * 60 * 1000;
    const limit = Math.min(days * 96, 1000); // 96 × 15min = 1 day

    const json = await bybitPublic("GET", "/v5/market/kline", { category: "linear", symbol, interval: "15", limit: String(limit), start: String(start), end: String(end) });
    if (json.retCode !== 0 || !json.result?.list?.length) return null;

    // Bybit returns newest first; reverse to chronological order
    const list: Candle[] = (json.result.list as string[][])
      .map(([ts, o, h, l, c, v]) => ({
        time:   Math.floor(Number(ts) / 1000),
        open:   parseFloat(o),
        high:   parseFloat(h),
        low:    parseFloat(l),
        close:  parseFloat(c),
        volume: parseFloat(v),
      }))
      .reverse();

    return list;
  } catch {
    return null;
  }
}

// ─── POST /backtest/run ──────────────────────────────────────────────────────
router.post("/backtest/run", async (req, res) => {
  const { symbol = "BTCUSDT", days = 7 } = req.body as { symbol?: string; days?: number };

  // Try real Bybit data, fall back to demo candles
  let candles = await fetchBybitCandles(symbol, days);
  let dataSource: "live" | "demo" = "live";

  if (!candles || candles.length < 100) {
    // Demo fallback: 7 days × 24h × 4 = 672 candles at 15min
    candles = generateCandles(symbol, 15, days * 24 * 4);
    dataSource = "demo";
  }

  const closes = candles.map(c => c.close);

  const results = {
    symbol,
    days,
    dataSource,
    candleCount: candles.length,
    from: new Date(candles[0].time * 1000).toISOString(),
    to:   new Date(candles[candles.length - 1].time * 1000).toISOString(),
    modes: [
      simulateMode(candles, "conservative", closes),
      simulateMode(candles, "risky",        closes),
      simulateMode(candles, "ultra",        closes),
      simulateMode(candles, "tiburon",      closes),
    ],
  };

  res.json(results);
});

export default router;
