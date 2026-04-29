import type { Request } from "express";

declare module "express-session" {
  interface SessionData {
    authenticated: boolean;
  }
}

export const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "ARBUSDT", "OPUSDT"];

export const BASE_PRICES: Record<string, number> = {
  BTCUSDT: 83500,
  ETHUSDT: 3150,
  SOLUSDT: 148,
  BNBUSDT: 605,
  XRPUSDT: 2.21,
  DOGEUSDT: 0.178,
  AVAXUSDT: 36.5,
  LINKUSDT: 14.8,
  ARBUSDT: 0.92,
  OPUSDT: 1.84,
};

function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

export function getLivePrice(symbol: string): number {
  const base = BASE_PRICES[symbol] ?? 100;
  const tick = Math.floor(Date.now() / 3000);
  const noise = (seededRandom(tick + symbol.charCodeAt(0)) - 0.5) * 0.004;
  return base * (1 + noise);
}

export function generateCandles(symbol: string, interval: number, limit: number = 100) {
  const base = BASE_PRICES[symbol] ?? 100;
  const intervalMs = interval * 60 * 1000;
  const now = Math.floor(Date.now() / intervalMs) * intervalMs;
  const candles = [];

  let price = base * 0.97;
  for (let i = limit; i >= 0; i--) {
    const time = Math.floor((now - i * intervalMs) / 1000);
    const change = (seededRandom(time + symbol.length) - 0.48) * 0.012;
    const open = price;
    const close = open * (1 + change);
    const high = Math.max(open, close) * (1 + seededRandom(time * 3) * 0.004);
    const low = Math.min(open, close) * (1 - seededRandom(time * 7) * 0.004);
    const volume = base * (100 + seededRandom(time * 11) * 500);
    candles.push({ time, open, high, low, close: parseFloat(close.toFixed(6)), volume: parseFloat(volume.toFixed(2)) });
    price = close;
  }
  return candles;
}

export function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function calcEMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

export function calcMACD(closes: number[]) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12 - ema26;
  const signal = macdLine * 0.9;
  return { macd: macdLine, signal, histogram: macdLine - signal };
}

export function calcBollingerBands(closes: number[], period = 20, stdDev = 2) {
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((acc, v) => acc + Math.pow(v - middle, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: middle + stdDev * std, middle, lower: middle - stdDev * std };
}

export function calcATR(candles: { high: number; low: number; close: number }[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs = candles.slice(-period - 1).map((c, i, arr) => {
    if (i === 0) return c.high - c.low;
    const prevClose = arr[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  return trs.slice(1).reduce((a, b) => a + b, 0) / trs.slice(1).length;
}

// ADX — Average Directional Index (Wilder smoothing)
// Mide la FUERZA de la tendencia, no su dirección
// ADX < 20 = mercado en rango (señales mienten) — no entrar
// ADX 20-40 = tendencia moderada, operar
// ADX > 40 = tendencia fuerte, alta confianza
export function calcADX(highs: number[], lows: number[], closes: number[], period = 14): {
  adx: number; plusDI: number; minusDI: number;
} {
  const n = Math.min(highs.length, lows.length, closes.length);
  if (n < period * 2 + 1) return { adx: 0, plusDI: 0, minusDI: 0 };

  const trs: number[] = [], plusDMs: number[] = [], minusDMs: number[] = [];
  for (let i = 1; i < n; i++) {
    const tr   = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    const upMove   = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    const plusDM  = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
    trs.push(tr); plusDMs.push(plusDM); minusDMs.push(minusDM);
  }

  const wilderSmooth = (arr: number[], p: number) => {
    let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; out.push(s); }
    return out;
  };

  const wilderAvg = (arr: number[], p: number) => {
    let s = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
    const out = [s];
    for (let i = p; i < arr.length; i++) { s = (s * (p - 1) + arr[i]) / p; out.push(s); }
    return out;
  };

  const sTR   = wilderSmooth(trs,     period);
  const sPlusDM  = wilderSmooth(plusDMs,  period);
  const sMinusDM = wilderSmooth(minusDMs, period);

  const dxArr: number[] = [];
  for (let i = 0; i < sTR.length; i++) {
    if (sTR[i] === 0) { dxArr.push(0); continue; }
    const pDI = 100 * sPlusDM[i]  / sTR[i];
    const mDI = 100 * sMinusDM[i] / sTR[i];
    const sum = pDI + mDI;
    dxArr.push(sum === 0 ? 0 : 100 * Math.abs(pDI - mDI) / sum);
  }
  const sDX = wilderAvg(dxArr, period);
  const lastIdx = sTR.length - 1;
  const lastTR  = sTR[lastIdx] || 1;
  return {
    adx:     sDX[sDX.length - 1] ?? 0,
    plusDI:  100 * sPlusDM[lastIdx]  / lastTR,
    minusDI: 100 * sMinusDM[lastIdx] / lastTR,
  };
}

// VWAP — Volume Weighted Average Price
// El nivel de precio más respetado por instituciones
// Sobre VWAP = sesgo alcista, bajo VWAP = sesgo bajista
export function calcVWAP(highs: number[], lows: number[], closes: number[], volumes: number[], lookback = 48): number {
  const len = Math.min(highs.length, lows.length, closes.length, volumes.length);
  const from = Math.max(0, len - lookback);
  let sumTPV = 0, sumVol = 0;
  for (let i = from; i < len; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    sumTPV += tp * volumes[i];
    sumVol += volumes[i];
  }
  return sumVol === 0 ? closes[len - 1] : sumTPV / sumVol;
}

export function calcCVD(candles: { open: number; close: number; volume: number }[]): number {
  return candles.slice(-20).reduce((cvd, c) => {
    return cvd + (c.close > c.open ? c.volume : -c.volume);
  }, 0);
}

export function generateSignalScore(symbol: string): { score: number; reasons: string[] } {
  const candles = generateCandles(symbol, 5, 50);
  const closes = candles.map(c => c.close);
  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);
  const bb = calcBollingerBands(closes);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const price = closes[closes.length - 1];

  let score = 50;
  const reasons: string[] = [];

  if (rsi < 30) { score += 15; reasons.push("RSI oversold — posible rebote alcista"); }
  else if (rsi > 70) { score -= 15; reasons.push("RSI sobrecomprado — posible corrección"); }
  else if (rsi > 50) { score += 5; reasons.push("RSI momentum alcista"); }
  else { score -= 5; reasons.push("RSI momentum bajista"); }

  if (macd.histogram > 0) { score += 10; reasons.push("MACD cruce alcista"); }
  else { score -= 10; reasons.push("MACD cruce bajista"); }

  if (price < bb.lower) { score += 12; reasons.push("Precio bajo banda inferior — reversión probable"); }
  else if (price > bb.upper) { score -= 12; reasons.push("Precio sobre banda superior — sobrecomprado"); }

  if (ema9 > ema21 && ema21 > ema50) { score += 10; reasons.push("EMAs alineadas alcistas (9>21>50)"); }
  else if (ema9 < ema21 && ema21 < ema50) { score -= 10; reasons.push("EMAs alineadas bajistas (9<21<50)"); }

  if (score > 75) reasons.push("Confluencia de señales alcistas — LONG FUERTE");
  else if (score < 25) reasons.push("Confluencia de señales bajistas — SHORT FUERTE");

  return { score: Math.max(1, Math.min(100, Math.round(score))), reasons };
}

export const DEMO_TRADES = [
  { id: "t1", symbol: "BTCUSDT", side: "Buy" as const, size: 0.05, entryPrice: 81200, exitPrice: 83900, pnl: 135, pnlPercent: 11.7, leverage: 20, duration: 7200000, closedAt: Date.now() - 3600000, riskMode: "risky" as const },
  { id: "t2", symbol: "ETHUSDT", side: "Sell" as const, size: 0.5, entryPrice: 3280, exitPrice: 3150, pnl: 65, pnlPercent: 8.8, leverage: 15, duration: 10800000, closedAt: Date.now() - 14400000, riskMode: "conservative" as const },
  { id: "t3", symbol: "SOLUSDT", side: "Buy" as const, size: 5, entryPrice: 138, exitPrice: 152, pnl: 70, pnlPercent: 14.5, leverage: 25, duration: 5400000, closedAt: Date.now() - 86400000, riskMode: "risky" as const },
  { id: "t4", symbol: "BTCUSDT", side: "Buy" as const, size: 0.02, entryPrice: 84200, exitPrice: 83100, pnl: -22, pnlPercent: -2.6, leverage: 10, duration: 1800000, closedAt: Date.now() - 172800000, riskMode: "conservative" as const },
  { id: "t5", symbol: "AVAXUSDT", side: "Sell" as const, size: 10, entryPrice: 38.5, exitPrice: 35.2, pnl: 33, pnlPercent: 12.4, leverage: 20, duration: 21600000, closedAt: Date.now() - 259200000, riskMode: "risky" as const },
  { id: "t6", symbol: "XRPUSDT", side: "Buy" as const, size: 500, entryPrice: 2.05, exitPrice: 2.28, pnl: 115, pnlPercent: 15.7, leverage: 30, duration: 43200000, closedAt: Date.now() - 345600000, riskMode: "ultra" as const },
  { id: "t7", symbol: "BNBUSDT", side: "Buy" as const, size: 0.5, entryPrice: 590, exitPrice: 612, pnl: 11, pnlPercent: 5.2, leverage: 10, duration: 9000000, closedAt: Date.now() - 432000000, riskMode: "conservative" as const },
];

export const DEMO_BALANCE = {
  totalEquity: 12450.83,
  availableBalance: 9800.00,
  unrealizedPnl: 287.45,
  totalWalletBalance: 12163.38,
  demoMode: true,
};

export const DEMO_POSITION = {
  symbol: "BTCUSDT",
  side: "Buy" as const,
  size: 0.03,
  entryPrice: 82100,
  markPrice: 83500,
  leverage: 20,
  unrealizedPnl: 287.45,
  unrealizedPnlPercent: 11.68,
  liquidationPrice: 77995,
  stopLoss: 80458,
  takeProfit1: 84563,
  takeProfit2: 87847,
  takeProfit3: 94415,
  openedAt: Date.now() - 7200000,
};

export const BOT_STATE = {
  active: false,
  settings: {
    riskMode: "conservative" as const,
    capitalPercent: 10,
    stopLossPercent: 2,
    tp1Percent: 3,
    tp2Percent: 7,
    tp3Percent: 15,
    moveSlToEntryOnTp1: true,
  },
  lastAction: null as string | null,
  tradesExecuted: 0,
};

// Risk Profiles — calibrados para perps reales Bybit
// R:R objetivo >= 2.5:1 ANTES de fees. Fees round-trip = 0.11% del nocional.
// Con leverage X: fee en margen = 0.11% × X
// conservative(10x): fee ~1.1% del margen — TP1 ROI = 30%, SL ROI = -15% → R:R = 2:1 neto
// moderate(25x):     fee ~2.75% del margen — TP1 ROI = 100%, SL ROI = -30% → R:R = 3.3:1 neto
// aggressive(50x):   fee ~5.5% del margen  — TP1 ROI = 200%, SL ROI = -50% → R:R = 4:1 neto
// killer(100x):      fee ~11% del margen   — TP1 ROI = 250%, SL ROI = -70% → R:R = 3.6:1 neto
// megalodon(125x):   fee ~13.75% del margen — TP1 ROI = 187%, SL ROI = -56% → R:R = 3.3:1 neto
// FÓRMULA GANADORA — SL recalibrado para sobrevivir ruido de mercado, TP ≥ 2.5:1 R:R
// Regla de liquidación: SL% debe ser < (1/leverage * 100) con margen de seguridad.
// conservative:  10x,  liq ≈10%  → SL 2.5%  → puede sobrevivir volatilidad diaria normal
// moderate:      25x,  liq ≈ 4%  → SL 1.8%  → margen decente para 25x
// aggressive:    50x,  liq ≈ 2%  → SL 1.3%  → equilibrio ruido/liquidación
// killer:       100x,  liq ≈ 1%  → SL 0.75% → ajustado (antes 0.7% — muy borde)
// megalodon:    125x,  liq ≈0.8% → SL 0.60% → +0.15% vs antes (menos stops por ruido)
export const RISK_PROFILES: Record<string, { leverage: number; slPercent: number; tp1: number; tp2: number; tp3: number; scanSec: number; atrMultiplier: number; trailingStop: boolean; partialExit: boolean; capitalPercent?: number }> = {
  conservative: { leverage: 10,  slPercent: 2.5,  tp1: 6.5,  tp2: 12, tp3: 22, scanSec: 30, atrMultiplier: 2.0, trailingStop: false, partialExit: false },
  moderate:     { leverage: 25,  slPercent: 1.8,  tp1: 5.0,  tp2: 9,  tp3: 18, scanSec: 20, atrMultiplier: 1.5, trailingStop: false, partialExit: false },
  aggressive:   { leverage: 50,  slPercent: 1.3,  tp1: 3.8,  tp2: 7,  tp3: 14, scanSec: 12, atrMultiplier: 1.0, trailingStop: true,  partialExit: true  },
  killer:       { leverage: 100, slPercent: 0.75, tp1: 2.2,  tp2: 4,  tp3: 8,  scanSec: 6,  atrMultiplier: 0.5, trailingStop: true,  partialExit: true  },
  megalodon:    { leverage: 125, slPercent: 0.60, tp1: 1.8,  tp2: 3,  tp3: 6,  scanSec: 5,  atrMultiplier: 0.3, trailingStop: true,  partialExit: true  },
  escalon:      { leverage: 50,  slPercent: 1.3,  tp1: 4.0,  tp2: 7,  tp3: 14, scanSec: 3,   atrMultiplier: 1.0, trailingStop: true,  partialExit: false },
};

export function generateCapitalHistory() {
  const history = [];
  let capital = 10000;
  const now = new Date();
  for (let i = 30; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const date = d.toISOString().split("T")[0];
    const dayChange = (seededRandom(i * 137 + 42) - 0.42) * 0.04;
    capital = capital * (1 + dayChange);
    history.push({ date, value: parseFloat(capital.toFixed(2)) });
  }
  return history;
}

export function isAuthenticated(req: Request): boolean {
  return req.session?.authenticated === true;
}
