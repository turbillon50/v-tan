import { Router } from "express";
import { sendSignalAlert } from "./alerts";
import {
  placeMarketOrder as bybitPlaceOrder,
  closePosition    as bybitClosePos,
  calcQtyReal, setLeverage, getBybitBalance, bybitPublic,
} from "../lib/bybit-auth";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const router = Router();

const USD_MXN = 20;
const SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","ARBUSDT","OPUSDT"];
const API_BASE = `http://localhost:${process.env.PORT || 8080}/api`;

const MODE_CFG: Record<string, { scoreMin: number; leverage: number; capitalPct: number; tp1: number; tp2: number; tp3: number; sl: number; scanMs: number }> = {
  conservative: { scoreMin: 65, leverage: 10,  capitalPct: 3,  tp1: 3,  tp2: 7,  tp3: 15, sl: 2.0, scanMs: 45000 },
  risky:        { scoreMin: 58, leverage: 20,  capitalPct: 5,  tp1: 5,  tp2: 10, tp3: 20, sl: 2.5, scanMs: 35000 },
  ultra:        { scoreMin: 50, leverage: 75,  capitalPct: 10, tp1: 8,  tp2: 15, tp3: 30, sl: 1.5, scanMs: 25000 },
  tiburon:      { scoreMin: 45, leverage: 100, capitalPct: 15, tp1: 5,  tp2: 12, tp3: 25, sl: 1.0, scanMs: 20000 },
  megalodon:    { scoreMin: 40, leverage: 125, capitalPct: 20, tp1: 2,  tp2: 5,  tp3: 12, sl: 0.5, scanMs: 15000 },
};

export interface FurtivoPosition {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  size: number;         // qty in base asset (for real orders)
  capitalMXN: number;
  leverage: number;
  tp1: number; tp2: number; tp3: number; sl: number;
  tp1Hit: boolean;
  openedAt: number;
  pnlMXN: number;
  pnlPct: number;
  bybitOrderId?: string; // set when real mode is on
  isReal?: boolean;
}

export interface FurtivoTrade {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  capitalMXN: number;
  pnlMXN: number;
  pnlPct: number;
  result: "WIN" | "LOSS";
  closedBy: string;
  durationMs: number;
  closedAt: number;
  mode?: string;
  isReal?: boolean;
  botName?: string;
}

export interface FurtivoBot {
  id: string;
  name: string;
  mode: string;
  emoji: string;
  capitalMXN: number;
  currentBalanceMXN: number;
  isRunning: boolean;
  sessionDurationMs: number;
  sessionStartedAt?: number;
  sessionEndsAt?: number;
  positions: FurtivoPosition[];
  trades: FurtivoTrade[];
  totalPnlMXN: number;
  totalPnlPct: number;
  wins: number;
  losses: number;
  scanTimer?: ReturnType<typeof setInterval>;
  sessionTimer?: ReturnType<typeof setTimeout>;
}

const BOT_EMOJIS: Record<string, string> = {
  conservative: "🛡️", risky: "⚡", ultra: "🚀", tiburon: "🦈", megalodon: "🦈⚡"
};

const BOT_NAMES: Record<string, string[]> = {
  conservative: ["Centinela", "Escudo", "Guardián"],
  risky: ["Rayo", "Trueno", "Voltaje"],
  ultra: ["Cohete", "Órbita", "Plasma"],
  tiburon: ["Depredador", "Colmillo", "Abismo"],
  megalodon: ["Megalodón", "Extintor", "Leviatán"],
};

let botCounter = 0;
const bots = new Map<string, FurtivoBot>();
let globalBalanceMXN = 10000;
let recommendations: string[] = [];
let lastRecommendationUpdate = 0;
let recommendationIntervalMs = 3600000;
let realMode = false;
let bybitLiveBalance: { available: number; total: number } | null = null;

// ─── Hourly snapshots ─────────────────────────────────────────────────────────
const HISTORY_FILE = join(process.cwd(), "furtivo-history.json");
interface HourlySnapshot { ts: number; label: string; balanceMXN: number; pnlMXN: number; }
let hourlySnapshots: HourlySnapshot[] = [];

try {
  if (existsSync(HISTORY_FILE)) {
    hourlySnapshots = JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
  }
} catch {}

function saveHistory() {
  try { writeFileSync(HISTORY_FILE, JSON.stringify(hourlySnapshots.slice(-168))); } catch {}
}

function takeSnapshot() {
  const botList = [...bots.values()];
  const current = botList.reduce((s, b) => s + b.currentBalanceMXN, 0) || globalBalanceMXN;
  const base    = botList.reduce((s, b) => s + b.capitalMXN, 0) || globalBalanceMXN;
  const pnl     = current - base;
  const now = Date.now();
  const label   = new Date(now).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: false });
  hourlySnapshots.push({ ts: now, label, balanceMXN: current, pnlMXN: pnl });
  if (hourlySnapshots.length > 168) hourlySnapshots.shift();
  saveHistory();
}

setInterval(takeSnapshot, 3600000);

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

async function fetchSignal(symbol: string): Promise<{ score: number; direction: string; price: number } | null> {
  try {
    const [sigRes, priceData] = await Promise.all([
      fetch(`${API_BASE}/signals/${symbol}`, { signal: AbortSignal.timeout(5000) }),
      bybitPublic("GET", "/v5/market/tickers", { category: "linear", symbol }),
    ]);
    const sig = await sigRes.json() as any;
    const price = parseFloat(priceData?.result?.list?.[0]?.lastPrice ?? "0");
    return { score: sig.score, direction: sig.direction, price: price || 0 };
  } catch { return null; }
}

async function fetchPrice(symbol: string): Promise<number | null> {
  try {
    const d = await bybitPublic("GET", "/v5/market/tickers", { category: "linear", symbol });
    const p = parseFloat(d?.result?.list?.[0]?.lastPrice ?? "0");
    return p || null;
  } catch { return null; }
}

function calcPnl(pos: FurtivoPosition, currentPrice: number): { pnlMXN: number; pnlPct: number } {
  const priceDiff = pos.direction === "LONG"
    ? (currentPrice - pos.entryPrice) / pos.entryPrice
    : (pos.entryPrice - currentPrice) / pos.entryPrice;
  const pnlPct = priceDiff * pos.leverage * 100;
  const pnlMXN = (pos.capitalMXN * pnlPct) / 100;
  return { pnlMXN, pnlPct };
}

async function closePositionReal(pos: FurtivoPosition): Promise<void> {
  if (!pos.isReal) return;
  try {
    const qty = pos.size.toFixed(
      pos.symbol.includes("BTC") ? 3 :
      pos.symbol.includes("ETH") || pos.symbol.includes("BNB") ? 2 : 1
    );
    await bybitClosePos(pos.symbol, pos.direction, qty);
    console.log(`[furtivo-real] Posición cerrada en Bybit: ${pos.symbol} ${pos.direction} qty=${qty}`);
  } catch (e) {
    console.error("[furtivo-real] Error cerrando posición real:", e);
  }
}

function closePosition(bot: FurtivoBot, pos: FurtivoPosition, exitPrice: number, reason: string) {
  if (pos.isReal) closePositionReal(pos).catch(() => {});
  const { pnlMXN, pnlPct } = calcPnl(pos, exitPrice);
  const trade: FurtivoTrade = {
    id: uid(),
    symbol: pos.symbol,
    direction: pos.direction,
    entryPrice: pos.entryPrice,
    exitPrice,
    capitalMXN: pos.capitalMXN,
    pnlMXN,
    pnlPct,
    result: pnlMXN >= 0 ? "WIN" : "LOSS",
    closedBy: reason,
    durationMs: Date.now() - pos.openedAt,
    closedAt: Date.now(),
  };
  bot.trades.unshift(trade);
  if (bot.trades.length > 50) bot.trades.pop();
  bot.currentBalanceMXN += pnlMXN;
  bot.totalPnlMXN += pnlMXN;
  bot.totalPnlPct = ((bot.currentBalanceMXN - bot.capitalMXN) / bot.capitalMXN) * 100;
  if (trade.result === "WIN") bot.wins++; else bot.losses++;
  bot.positions = bot.positions.filter(p => p.id !== pos.id);

  const coin = pos.symbol.replace("USDT", "");
  const sign = pnlMXN >= 0 ? "+" : "";
  sendSignalAlert({
    symbol: pos.symbol,
    score: trade.result === "WIN" ? 90 : 30,
    direction: pos.direction,
    mode: bot.mode,
    reasons: [
      `Bot ${bot.name} cerró ${pos.direction} ${coin} (${reason})`,
      `PnL: ${sign}$${pnlMXN.toFixed(0)} MXN (${sign}${pnlPct.toFixed(1)}%)`,
      `Balance: $${bot.currentBalanceMXN.toFixed(0)} MXN`,
    ],
  }).catch(() => {});
}

async function scanBot(bot: FurtivoBot) {
  if (!bot.isRunning) return;
  const cfg = MODE_CFG[bot.mode];

  for (const pos of [...bot.positions]) {
    const price = await fetchPrice(pos.symbol);
    if (!price) continue;
    const { pnlMXN, pnlPct } = calcPnl(pos, price);
    pos.pnlMXN = pnlMXN;
    pos.pnlPct = pnlPct;

    const moveDir = pos.direction === "LONG"
      ? (price - pos.entryPrice) / pos.entryPrice * 100
      : (pos.entryPrice - price) / pos.entryPrice * 100;

    if (moveDir <= -cfg.sl) {
      closePosition(bot, pos, price, "SL"); continue;
    }
    if (!pos.tp1Hit && moveDir >= cfg.tp1) {
      pos.tp1Hit = true;
    }
    if (pos.tp1Hit && moveDir >= cfg.tp2) {
      closePosition(bot, pos, price, "TP2"); continue;
    }
    if (moveDir >= cfg.tp3) {
      closePosition(bot, pos, price, "TP3"); continue;
    }
  }

  if (bot.positions.length >= 3) return;

  const symbolsInUse = new Set(bot.positions.map(p => p.symbol));
  const candidates = SYMBOLS.filter(s => !symbolsInUse.has(s));
  const shuffled = candidates.sort(() => Math.random() - 0.5).slice(0, 4);

  for (const sym of shuffled) {
    if (!bot.isRunning) break;
    const sig = await fetchSignal(sym);
    if (!sig || sig.score < cfg.scoreMin || !sig.price) continue;

    const capitalMXN = bot.currentBalanceMXN * (cfg.capitalPct / 100);
    if (capitalMXN < 10) continue;

    const priceDir = sig.direction === "LONG" ? 1 : sig.direction === "SHORT" ? -1 : 0;
    if (priceDir === 0) continue;

    const entryPrice = sig.price;
    const tp1 = priceDir === 1 ? entryPrice * (1 + cfg.tp1 / 100) : entryPrice * (1 - cfg.tp1 / 100);
    const tp2 = priceDir === 1 ? entryPrice * (1 + cfg.tp2 / 100) : entryPrice * (1 - cfg.tp2 / 100);
    const tp3 = priceDir === 1 ? entryPrice * (1 + cfg.tp3 / 100) : entryPrice * (1 - cfg.tp3 / 100);
    const sl  = priceDir === 1 ? entryPrice * (1 - cfg.sl  / 100) : entryPrice * (1 + cfg.sl  / 100);

    const capitalUSDT = capitalMXN / USD_MXN;
    const qty = await calcQtyReal(sym, capitalUSDT, cfg.leverage, entryPrice);
    if (!qty) continue;

    const pos: FurtivoPosition = {
      id: uid(),
      symbol: sym,
      direction: sig.direction as "LONG" | "SHORT",
      entryPrice,
      size: parseFloat(qty),
      capitalMXN,
      leverage: cfg.leverage,
      tp1, tp2, tp3, sl,
      tp1Hit: false,
      openedAt: Date.now(),
      pnlMXN: 0,
      pnlPct: 0,
      isReal: false,
    };

    if (realMode) {
      try {
        await setLeverage(sym, cfg.leverage);
        const side = sig.direction === "LONG" ? "Buy" : "Sell";
        const orderId = await bybitPlaceOrder(sym, side, qty);
        if (!orderId) {
          console.warn(`[furtivo-real] Orden rechazada por Bybit: ${sym} ${side} ${qty}`);
          continue;
        }
        pos.bybitOrderId = orderId;
        pos.isReal = true;
        console.log(`[furtivo-real] Orden REAL abierta: ${orderId} ${sym} ${side} ${qty}`);
      } catch (e) {
        console.error("[furtivo-real] Error al abrir orden real:", e);
        continue;
      }
    }

    bot.positions.push(pos);

    const coin = sym.replace("USDT","");
    sendSignalAlert({
      symbol: sym,
      score: sig.score,
      direction: sig.direction,
      mode: bot.mode,
      reasons: [
        `🤖 Bot ${bot.name} abrió ${sig.direction} ${coin}`,
        `Score: ${sig.score}/100 • ${cfg.leverage}x`,
        `Capital: $${capitalMXN.toFixed(0)} MXN`,
        `TP1: $${tp1.toFixed(2)} • SL: $${sl.toFixed(2)}`,
      ],
    }).catch(() => {});
    break;
  }
}

function stopBot(bot: FurtivoBot) {
  bot.isRunning = false;
  if (bot.scanTimer) { clearInterval(bot.scanTimer); bot.scanTimer = undefined; }
  if (bot.sessionTimer) { clearTimeout(bot.sessionTimer); bot.sessionTimer = undefined; }
  bot.sessionStartedAt = undefined;
  bot.sessionEndsAt = undefined;
}

function startBot(bot: FurtivoBot, durationMs: number) {
  stopBot(bot);
  const cfg = MODE_CFG[bot.mode];
  bot.isRunning = true;
  bot.sessionDurationMs = durationMs;
  bot.sessionStartedAt = Date.now();
  bot.sessionEndsAt = Date.now() + durationMs;

  bot.scanTimer = setInterval(() => scanBot(bot), cfg.scanMs);
  scanBot(bot);

  bot.sessionTimer = setTimeout(() => {
    for (const pos of [...bot.positions]) {
      fetchPrice(pos.symbol).then(price => {
        if (price) closePosition(bot, pos, price, "SESSION_END");
      }).catch(() => {});
    }
    stopBot(bot);
  }, durationMs);
}

async function updateRecommendations() {
  try {
    const r = await fetch(`${API_BASE}/signals/BTCUSDT/ai-analysis`, { signal: AbortSignal.timeout(10000) });
    const d = await r.json() as any;
    if (d?.narrative) {
      recommendations = [
        d.narrative.slice(0, 200),
        "Revisa BTC y ETH primero — mayor liquidez, spreads más bajos.",
        "Con score >70 en Megalodón activa un bot Ultra como respaldo.",
        "Si un bot lleva >30 min en pérdida, considera pausarlo manualmente.",
        "Las sesiones Londres/NY (13-22 UTC) concentran 70% del volumen diario.",
      ];
    }
  } catch {
    recommendations = [
      "Mercado activo — revisa señales de BTC y ETH antes de activar bots.",
      "Conservador primero, Megalodón solo cuando el score es >75.",
      "Una sesión de 1 hora es suficiente para ver resultados claros.",
    ];
  }
  lastRecommendationUpdate = Date.now();
}

router.get("/furtivo/status", (_req, res) => {
  const botList = Array.from(bots.values()).map(b => ({
    id: b.id, name: b.name, mode: b.mode, emoji: b.emoji,
    capitalMXN: b.capitalMXN, currentBalanceMXN: b.currentBalanceMXN,
    isRunning: b.isRunning, sessionDurationMs: b.sessionDurationMs,
    sessionStartedAt: b.sessionStartedAt, sessionEndsAt: b.sessionEndsAt,
    positions: b.positions,
    trades: b.trades.slice(0, 20),
    totalPnlMXN: b.totalPnlMXN, totalPnlPct: b.totalPnlPct,
    wins: b.wins, losses: b.losses,
  }));
  const totalCurrentMXN = botList.reduce((s, b) => s + b.currentBalanceMXN, 0);
  const totalPnlMXN = totalCurrentMXN - botList.reduce((s, b) => s + b.capitalMXN, 0);
  res.json({
    globalBalanceMXN,
    totalCurrentMXN,
    totalPnlMXN,
    bots: botList,
    recommendations,
    lastRecommendationUpdate,
    recommendationIntervalMs,
    realMode,
    bybitLiveBalance,
    hourlySnapshots: hourlySnapshots.slice(-24),
  });
});

router.post("/furtivo/bots", (req, res) => {
  const { mode = "megalodon", capitalMXN = 2000, sessionDurationMs = 3600000, name } = req.body as any;
  if (!MODE_CFG[mode]) { res.status(400).json({ error: "Modo inválido" }); return; }
  if (capitalMXN < 100) { res.status(400).json({ error: "Capital mínimo 100 MXN" }); return; }
  if (bots.size >= 6) { res.status(400).json({ error: "Máximo 6 bots simultáneos" }); return; }

  botCounter++;
  const names = BOT_NAMES[mode];
  const id = uid();
  const bot: FurtivoBot = {
    id, mode, emoji: BOT_EMOJIS[mode],
    name: name || names[botCounter % names.length],
    capitalMXN, currentBalanceMXN: capitalMXN,
    isRunning: false, sessionDurationMs,
    positions: [], trades: [],
    totalPnlMXN: 0, totalPnlPct: 0, wins: 0, losses: 0,
  };
  bots.set(id, bot);
  res.json({ ok: true, bot: { id: bot.id, name: bot.name, mode: bot.mode } });
});

router.post("/furtivo/bots/:id/start", (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) { res.status(404).json({ error: "Bot no encontrado" }); return; }
  const { sessionDurationMs } = req.body as any;
  startBot(bot, sessionDurationMs ?? bot.sessionDurationMs);
  res.json({ ok: true, sessionEndsAt: bot.sessionEndsAt });
});

router.post("/furtivo/bots/:id/stop", (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) { res.status(404).json({ error: "Bot no encontrado" }); return; }
  for (const pos of [...bot.positions]) {
    fetchPrice(pos.symbol).then(price => {
      if (price) closePosition(bot, pos, price, "MANUAL");
    }).catch(() => {});
  }
  stopBot(bot);
  res.json({ ok: true });
});

router.delete("/furtivo/bots/:id", (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) { res.status(404).json({ error: "Bot no encontrado" }); return; }
  stopBot(bot);
  bots.delete(req.params.id);
  res.json({ ok: true });
});

router.post("/furtivo/reset", (req, res) => {
  const { balanceMXN } = req.body as any;
  for (const bot of bots.values()) stopBot(bot);
  bots.clear();
  globalBalanceMXN = (typeof balanceMXN === "number" && balanceMXN >= 1000) ? balanceMXN : 10000;
  botCounter = 0;
  res.json({ ok: true, globalBalanceMXN });
});

router.post("/furtivo/recommendations", (req, res) => {
  const { intervalMs } = req.body as any;
  if (intervalMs) recommendationIntervalMs = Math.max(60000, Number(intervalMs));
  updateRecommendations().then(() => {
    res.json({ ok: true, recommendations, nextUpdate: Date.now() + recommendationIntervalMs });
  });
});

router.get("/furtivo/recommendations", async (_req, res) => {
  if (Date.now() - lastRecommendationUpdate > recommendationIntervalMs || recommendations.length === 0) {
    await updateRecommendations();
  }
  res.json({ recommendations, lastUpdate: lastRecommendationUpdate, intervalMs: recommendationIntervalMs });
});

updateRecommendations();

// ─── Real Mode toggle ────────────────────────────────────────────────────────
router.get("/furtivo/real-mode", (_req, res) => {
  res.json({ realMode, bybitLiveBalance });
});

router.post("/furtivo/real-mode", async (req, res): Promise<void> => {
  const { enable } = req.body as { enable: boolean };

  if (enable) {
    // Test Bybit connection before enabling
    const balance = await getBybitBalance();
    if (!balance) {
      res.status(502).json({
        ok: false,
        error: "No se pudo conectar a Bybit. Verifica que tu API Key tenga permiso de 'Trade' y esté activa.",
      });
      return;
    }
    bybitLiveBalance = balance;
    realMode = true;
    console.log("[furtivo-real] Modo REAL activado. Balance Bybit:", balance);
    res.json({ ok: true, realMode: true, bybitLiveBalance: balance });
  } else {
    realMode = false;
    bybitLiveBalance = null;
    console.log("[furtivo-real] Modo PAPEL activado");
    res.json({ ok: true, realMode: false });
  }
});

// Refresh Bybit balance every 30s when in real mode
setInterval(async () => {
  if (!realMode) return;
  try {
    const b = await getBybitBalance();
    if (b) bybitLiveBalance = b;
  } catch {}
}, 30000);

export default router;
