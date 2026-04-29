/**
 * pattern-detector.ts
 * Detecta patrones técnicos en velas de 5m usando klines de Bybit.
 * Retorna un bonus/penalty (-10 a +10) para el pipeline de señales.
 */

import { bybitPublic } from "./bybit-auth";
import { calcRSI, calcATR } from "./demo-data";
import { getWsKlineBuffer } from "./bybit-ws";

export type PatternType =
  | "BREAKOUT_LONG"
  | "BREAKOUT_SHORT"
  | "RSI_DIVERGENCE_BULL"
  | "RSI_DIVERGENCE_BEAR"
  | "FLAG_BULL"
  | "FLAG_BEAR"
  | "DOUBLE_TOP"
  | "DOUBLE_BOTTOM"
  | "CHANNEL_BULL"
  | "CHANNEL_BEAR"
  | "MACD_CROSS_BULL"
  | "MACD_CROSS_BEAR"
  | "STOP_HUNT_REVERSAL_LONG"
  | "STOP_HUNT_REVERSAL_SHORT"
  | "NONE";

export interface PatternResult {
  pattern:     PatternType;
  confidence:  number;     // 0-1
  bonus:       number;     // -10 a +10 aplicado al signal score
  description: string;
}

interface Kline {
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

// Cache corto: 30s por símbolo para no duplicar llamadas durante el mismo scan
const _klineCache: Record<string, { data: Kline[]; cachedAt: number }> = {};
const KLINE_CACHE_TTL = 30_000;

async function getKlines5m(symbol: string, limit: number): Promise<Kline[]> {
  const key = `${symbol}:${limit}`;
  const cached = _klineCache[key];
  if (cached && Date.now() - cached.cachedAt < KLINE_CACHE_TTL) return cached.data;

  try {
    const d = await bybitPublic("GET", "/v5/market/kline", {
      category: "linear", symbol, interval: "5", limit: String(limit)
    });
    const raw: string[][] = d?.result?.list ?? [];
    // Bybit retorna en orden descendente [newest first] — invertir para [oldest first]
    const klines = raw.reverse().map((c) => ({
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
    if (klines.length > 0) _klineCache[key] = { data: klines, cachedAt: Date.now() };
    return klines;
  } catch {
    return [];
  }
}

// ── BONUS BASE FIJOS (antes de calibración) — valor constante por tipo de patrón ─────────
const BONUS_BREAKOUT     = 8;   // ±8 para breakouts de consolidación
const BONUS_RSI_DIV      = 6;   // ±6 para divergencias RSI
const BONUS_FLAG         = 7;   // ±7 para flags de continuación
const BONUS_DOUBLE_TOP   = 7;   // ±7 para doble techo/suelo
const BONUS_CHANNEL      = 5;   // ±5 para canal alcista/bajista
const BONUS_MACD_CROSS   = 6;   // ±6 para cruce MACD
const BONUS_STOP_HUNT    = 10;  // ±10 para stop hunt reversal — la entrada más fiable

/** Patrón A: Breakout de consolidación (últimas 20 velas, rango < 0.8%) */
function detectBreakout(klines: Kline[]): PatternResult {
  if (klines.length < 22) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  const consolidation = klines.slice(-22, -2);  // 20 velas de consolidación
  const last2 = klines.slice(-2);               // 2 velas finales para confirmar

  const consHigh  = Math.max(...consolidation.map(k => k.high));
  const consLow   = Math.min(...consolidation.map(k => k.low));
  const consRange = (consHigh - consLow) / ((consHigh + consLow) / 2);

  if (consRange > 0.008) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  const avgVol = consolidation.reduce((s, k) => s + k.volume, 0) / consolidation.length;
  const breakoutCandle = last2[last2.length - 1];
  const volRatio = breakoutCandle.volume / Math.max(avgVol, 1);

  if (breakoutCandle.close > consHigh && volRatio > 1.2) {
    const conf = Math.min(0.95, 0.65 + (volRatio - 1.2) * 0.15 + (0.008 - consRange) * 20);
    const rangePct = (consRange * 100).toFixed(2);
    return {
      pattern: "BREAKOUT_LONG",
      confidence: conf,
      bonus: BONUS_BREAKOUT,   // valor fijo, no variable
      description: `Breakout alcista: rango ${rangePct}% → ruptura con vol +${Math.round((volRatio - 1) * 100)}% (conf ${Math.round(conf * 100)}%)`,
    };
  }

  if (breakoutCandle.close < consLow && volRatio > 1.2) {
    const conf = Math.min(0.95, 0.65 + (volRatio - 1.2) * 0.15 + (0.008 - consRange) * 20);
    const rangePct = (consRange * 100).toFixed(2);
    return {
      pattern: "BREAKOUT_SHORT",
      confidence: conf,
      bonus: -BONUS_BREAKOUT,  // valor fijo negativo
      description: `Breakout bajista: rango ${rangePct}% → ruptura con vol +${Math.round((volRatio - 1) * 100)}% (conf ${Math.round(conf * 100)}%)`,
    };
  }

  return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };
}

/** Patrón B: Divergencia RSI vs Precio */
function detectRsiDivergence(klines: Kline[]): PatternResult {
  if (klines.length < 30) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  const closes     = klines.map(k => k.close);
  const recent     = klines.slice(-20);
  const recentClose = recent.map(k => k.close);

  // RSI en los últimos 20 puntos usando ventanas de 14
  const rsiPoints: number[] = [];
  for (let i = 14; i < closes.length; i++) {
    rsiPoints.push(calcRSI(closes.slice(0, i + 1), 14));
  }
  if (rsiPoints.length < 10) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  const rsiRecent = rsiPoints.slice(-10);
  const priceRecent = recentClose.slice(-10);

  // Divergencia alcista: precio hace new low pero RSI hace higher low
  const priceMin1 = Math.min(...priceRecent.slice(0, 5));
  const priceMin2 = Math.min(...priceRecent.slice(5));
  const rsiMin1   = Math.min(...rsiRecent.slice(0, 5));
  const rsiMin2   = Math.min(...rsiRecent.slice(5));

  if (priceMin2 < priceMin1 * 0.999 && rsiMin2 > rsiMin1 + 2) {
    const priceDrop = ((priceMin1 - priceMin2) / priceMin1) * 100;
    const rsiRise   = rsiMin2 - rsiMin1;
    const conf      = Math.min(0.90, 0.55 + rsiRise * 0.02 + priceDrop * 0.05);
    return {
      pattern: "RSI_DIVERGENCE_BULL",
      confidence: conf,
      bonus: BONUS_RSI_DIV,    // valor fijo +6
      description: `Divergencia RSI alcista: precio -${priceDrop.toFixed(2)}% pero RSI +${rsiRise.toFixed(1)}pts (conf ${Math.round(conf * 100)}%)`,
    };
  }

  // Divergencia bajista: precio hace new high pero RSI hace lower high
  const priceMax1 = Math.max(...priceRecent.slice(0, 5));
  const priceMax2 = Math.max(...priceRecent.slice(5));
  const rsiMax1   = Math.max(...rsiRecent.slice(0, 5));
  const rsiMax2   = Math.max(...rsiRecent.slice(5));

  if (priceMax2 > priceMax1 * 1.001 && rsiMax2 < rsiMax1 - 2) {
    const priceRise = ((priceMax2 - priceMax1) / priceMax1) * 100;
    const rsiDrop   = rsiMax1 - rsiMax2;
    const conf      = Math.min(0.90, 0.55 + rsiDrop * 0.02 + priceRise * 0.05);
    return {
      pattern: "RSI_DIVERGENCE_BEAR",
      confidence: conf,
      bonus: -BONUS_RSI_DIV,   // valor fijo -6
      description: `Divergencia RSI bajista: precio +${priceRise.toFixed(2)}% pero RSI -${rsiDrop.toFixed(1)}pts (conf ${Math.round(conf * 100)}%)`,
    };
  }

  return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };
}

/** Patrón C: Flag / Continuation — trend fuerte + consolidación + ruptura */
function detectFlag(klines: Kline[]): PatternResult {
  if (klines.length < 16) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  const flagpole       = klines.slice(-16, -6);  // 10 velas del asta
  const consolidation  = klines.slice(-6, -1);    // 5 velas de consolidación
  const breakout       = klines[klines.length - 1]; // vela de ruptura

  const poleStart = flagpole[0].close;
  const poleEnd   = flagpole[flagpole.length - 1].close;
  const poleMoveP  = (poleEnd - poleStart) / poleStart;

  if (Math.abs(poleMoveP) < 0.015) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  const consRange = Math.max(...consolidation.map(k => k.high)) - Math.min(...consolidation.map(k => k.low));
  const consRangePct = consRange / ((poleEnd + poleStart) / 2);

  if (consRangePct > 0.006) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  if (poleMoveP > 0 && breakout.close > Math.max(...consolidation.map(k => k.close))) {
    const conf = Math.min(0.88, 0.60 + poleMoveP * 5);
    return {
      pattern: "FLAG_BULL",
      confidence: conf,
      bonus: BONUS_FLAG,       // valor fijo +7
      description: `Flag alcista: asta +${(poleMoveP * 100).toFixed(2)}% → ruptura al alza (conf ${Math.round(conf * 100)}%)`,
    };
  }

  if (poleMoveP < 0 && breakout.close < Math.min(...consolidation.map(k => k.close))) {
    const conf = Math.min(0.88, 0.60 + Math.abs(poleMoveP) * 5);
    return {
      pattern: "FLAG_BEAR",
      confidence: conf,
      bonus: -BONUS_FLAG,      // valor fijo -7
      description: `Flag bajista: asta ${(poleMoveP * 100).toFixed(2)}% → ruptura a la baja (conf ${Math.round(conf * 100)}%)`,
    };
  }

  return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };
}

/** Patrón D: Doble techo / Doble suelo — reversión de tendencia */
function detectDoubleTopBottom(klines: Kline[]): PatternResult {
  if (klines.length < 40) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  const last40 = klines.slice(-40);
  const closes = last40.map(k => k.close);
  const highs  = last40.map(k => k.high);
  const lows   = last40.map(k => k.low);

  // Doble techo: dos picos similares con valle en medio → bajista
  const peak1Idx = highs.slice(0, 20).reduce((m, v, i) => v > highs[m] ? i : m, 0);
  const peak2Idx = 20 + highs.slice(20).reduce((m, v, i) => v > highs[20 + m] ? i : m, 0);
  const valleyHigh = Math.min(...highs.slice(peak1Idx, peak2Idx));
  const peak1H = highs[peak1Idx], peak2H = highs[peak2Idx];
  const peakSim = Math.abs(peak1H - peak2H) / ((peak1H + peak2H) / 2);

  if (peakSim < 0.012 && peak2Idx > peak1Idx + 5 && (peak1H - valleyHigh) / peak1H > 0.005) {
    const currentClose = closes[closes.length - 1];
    if (currentClose < valleyHigh) {
      const conf = Math.min(0.85, 0.60 + (1 - peakSim) * 5);
      return {
        pattern: "DOUBLE_TOP",
        confidence: conf,
        bonus: -BONUS_DOUBLE_TOP,
        description: `Doble techo: pico ${peak1H.toFixed(4)}≈${peak2H.toFixed(4)} con ruptura del cuello (conf ${Math.round(conf * 100)}%)`,
      };
    }
  }

  // Doble suelo: dos valles similares con pico en medio → alcista
  const val1Idx = lows.slice(0, 20).reduce((m, v, i) => v < lows[m] ? i : m, 0);
  const val2Idx = 20 + lows.slice(20).reduce((m, v, i) => v < lows[20 + m] ? i : m, 0);
  const val1L = lows[val1Idx], val2L = lows[val2Idx];
  const valSim = Math.abs(val1L - val2L) / ((val1L + val2L) / 2);
  const neckLine = Math.max(...highs.slice(val1Idx, val2Idx));

  if (valSim < 0.012 && val2Idx > val1Idx + 5 && (neckLine - val1L) / val1L > 0.005) {
    const currentClose = closes[closes.length - 1];
    if (currentClose > neckLine) {
      const conf = Math.min(0.85, 0.60 + (1 - valSim) * 5);
      return {
        pattern: "DOUBLE_BOTTOM",
        confidence: conf,
        bonus: BONUS_DOUBLE_TOP,
        description: `Doble suelo: piso ${val1L.toFixed(4)}≈${val2L.toFixed(4)} con ruptura del cuello (conf ${Math.round(conf * 100)}%)`,
      };
    }
  }

  return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };
}

/** Patrón E: Canal alcista / bajista — estructura de máximos y mínimos progresivos */
function detectChannel(klines: Kline[]): PatternResult {
  if (klines.length < 20) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  const last20 = klines.slice(-20);
  const closes = last20.map(k => k.close);

  // Calcular pendiente de la línea de regresión lineal de los cierres
  const n  = closes.length;
  const xs = Array.from({ length: n }, (_, i) => i);
  const sumX  = xs.reduce((a, x) => a + x, 0);
  const sumY  = closes.reduce((a, y) => a + y, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * closes[i], 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const meanY = sumY / n;
  const slopePct = slope / meanY;

  // Verificar que los precios estén ajustados al canal (R² alto = canal limpio)
  const intercept = (sumY - slope * sumX) / n;
  const predicted = xs.map(x => intercept + slope * x);
  const ssRes = closes.reduce((a, y, i) => a + (y - predicted[i]) ** 2, 0);
  const ssTot = closes.reduce((a, y) => a + (y - meanY) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  if (r2 < 0.75) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  if (slopePct > 0.0008) {
    const conf = Math.min(0.85, 0.60 + r2 * 0.25);
    return {
      pattern: "CHANNEL_BULL",
      confidence: conf,
      bonus: BONUS_CHANNEL,
      description: `Canal alcista: pendiente +${(slopePct * 100).toFixed(3)}%/vela R²=${r2.toFixed(2)} (conf ${Math.round(conf * 100)}%)`,
    };
  }
  if (slopePct < -0.0008) {
    const conf = Math.min(0.85, 0.60 + r2 * 0.25);
    return {
      pattern: "CHANNEL_BEAR",
      confidence: conf,
      bonus: -BONUS_CHANNEL,
      description: `Canal bajista: pendiente ${(slopePct * 100).toFixed(3)}%/vela R²=${r2.toFixed(2)} (conf ${Math.round(conf * 100)}%)`,
    };
  }
  return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };
}

/** Patrón F: Cruce MACD (12,26,9) — señal de cambio de momentum */
function detectMacdCross(klines: Kline[]): PatternResult {
  if (klines.length < 35) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  const closes = klines.map(k => k.close);

  // EMA rápida y lenta usando alpha = 2/(n+1)
  function calcEMA(data: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const emas: number[] = [data[0]];
    for (let i = 1; i < data.length; i++) {
      emas.push(data[i] * k + emas[i - 1] * (1 - k));
    }
    return emas;
  }

  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (ema12.length < 26 || ema26.length < 26) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  const macd = ema12.map((v, i) => v - ema26[i]);
  const signal = calcEMA(macd.slice(-20), 9);
  if (signal.length < 3) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  const macdRecent = macd.slice(-signal.length);
  const lastMACD   = macdRecent[macdRecent.length - 1];
  const prevMACD   = macdRecent[macdRecent.length - 2];
  const lastSig    = signal[signal.length - 1];
  const prevSig    = signal[signal.length - 2];

  // Cruce alcista: MACD cruza por encima de la señal
  if (prevMACD <= prevSig && lastMACD > lastSig) {
    const strength = Math.abs(lastMACD - lastSig) / (Math.abs(lastMACD) + 0.0001);
    const conf = Math.min(0.88, 0.55 + strength * 2);
    return {
      pattern: "MACD_CROSS_BULL",
      confidence: conf,
      bonus: BONUS_MACD_CROSS,
      description: `Cruce MACD alcista: MACD(${lastMACD.toFixed(4)}) cruza Signal(${lastSig.toFixed(4)}) al alza (conf ${Math.round(conf * 100)}%)`,
    };
  }

  // Cruce bajista: MACD cruza por debajo de la señal
  if (prevMACD >= prevSig && lastMACD < lastSig) {
    const strength = Math.abs(lastMACD - lastSig) / (Math.abs(lastMACD) + 0.0001);
    const conf = Math.min(0.88, 0.55 + strength * 2);
    return {
      pattern: "MACD_CROSS_BEAR",
      confidence: conf,
      bonus: -BONUS_MACD_CROSS,
      description: `Cruce MACD bajista: MACD(${lastMACD.toFixed(4)}) cruza Signal(${lastSig.toFixed(4)}) a la baja (conf ${Math.round(conf * 100)}%)`,
    };
  }

  return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };
}

/**
 * Patrón G: Stop Hunt Reversal — caza de liquidez + reversión
 * Criterios:
 *   - Wick inferior > 2.5× ATR(14) → barrió stops debajo de soporte (LONG)
 *   - Wick superior > 2.5× ATR(14) → barrió stops encima de resistencia (SHORT)
 *   - Volumen de la vela de stop hunt > 2× promedio de las últimas 20 velas
 *   - El cierre de la vela de stop hunt regresa DENTRO del rango previo (no cierra en el extremo)
 * Descripción: la vela barrió stops del retail (wick extrema) + volumen spike + precio recupera el rango.
 */
function detectStopHuntReversal(klines: Kline[]): PatternResult {
  if (klines.length < 22) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  const atr = calcATR(klines, 14);
  if (atr <= 0) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  const atrThreshold = 2.5 * atr;

  // Rango de referencia: las 20 velas inmediatamente anteriores a la vela de stop hunt
  // slice(-21, -1) → índices -21..-2 = exactamente las 20 velas antes de la última
  const rangeCandles = klines.slice(-21, -1);
  const rangeHigh = Math.max(...rangeCandles.map(k => k.high));
  const rangeLow  = Math.min(...rangeCandles.map(k => k.low));

  // Volumen promedio de esas mismas 20 velas de referencia
  const avgVol = rangeCandles.reduce((s, k) => s + k.volume, 0) / rangeCandles.length;

  // Vela candidata: la última vela (recién cerrada)
  const last = klines[klines.length - 1];
  const volRatio = last.volume / Math.max(avgVol, 1);

  // ── STOP HUNT LONG: wick inferior extrema + cierre de vuelta en el rango ──
  // Wick inferior = low de la vela a close (o open, el mayor) — la cola que barrió los stops
  const lowerWick = Math.min(last.open, last.close) - last.low;
  if (lowerWick > atrThreshold && volRatio > 2.0 && last.close >= rangeLow && last.close <= rangeHigh) {
    const wickMultiple = lowerWick / atr;
    const conf = Math.min(0.93, 0.65 + (wickMultiple - 2.5) * 0.04 + (volRatio - 2.0) * 0.04);
    return {
      pattern: "STOP_HUNT_REVERSAL_LONG",
      confidence: conf,
      bonus: BONUS_STOP_HUNT,
      description: `Stop hunt LONG: wick inferior ${wickMultiple.toFixed(1)}×ATR + vol ${volRatio.toFixed(1)}×avg → cierre recuperado al rango (conf ${Math.round(conf * 100)}%)`,
    };
  }

  // ── STOP HUNT SHORT: wick superior extrema + cierre de vuelta en el rango ──
  // Wick superior = high de la vela a close (o open, el menor) — la cola que barrió los stops
  const upperWick = last.high - Math.max(last.open, last.close);
  if (upperWick > atrThreshold && volRatio > 2.0 && last.close >= rangeLow && last.close <= rangeHigh) {
    const wickMultiple = upperWick / atr;
    const conf = Math.min(0.93, 0.65 + (wickMultiple - 2.5) * 0.04 + (volRatio - 2.0) * 0.04);
    return {
      pattern: "STOP_HUNT_REVERSAL_SHORT",
      confidence: conf,
      bonus: -BONUS_STOP_HUNT,
      description: `Stop hunt SHORT: wick superior ${wickMultiple.toFixed(1)}×ATR + vol ${volRatio.toFixed(1)}×avg → cierre recuperado al rango (conf ${Math.round(conf * 100)}%)`,
    };
  }

  return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };
}

/** Kline raw como viene de Bybit: [time, open, high, low, close, volume] (strings) */
export type RawKline = string[];

/** Parsea klines crudas de Bybit (orden descendente, newest first) a Kline[] (oldest first) */
export function parseRawKlines(raw: RawKline[]): Kline[] {
  return raw
    .slice()
    .reverse()
    .map(c => ({
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
}

/**
 * Función pura: detecta patrones técnicos en un array de Kline (oldest first).
 * Retorna el patrón de mayor bonus absoluto. Sin efectos secundarios ni I/O.
 */
export function detectPatterns(klines: Kline[], _currentPrice?: number): PatternResult {
  if (klines.length < 22) return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };

  const breakout    = detectBreakout(klines);
  const flag        = detectFlag(klines);
  const divergence  = detectRsiDivergence(klines);
  const doubleTP    = detectDoubleTopBottom(klines);
  const channel     = detectChannel(klines);
  const macd        = detectMacdCross(klines);
  const stopHunt    = detectStopHuntReversal(klines);

  const candidates = [breakout, flag, divergence, doubleTP, channel, macd, stopHunt]
    .filter(p => p.pattern !== "NONE")
    .sort((a, b) => Math.abs(b.bonus) - Math.abs(a.bonus));

  return candidates.length > 0 ? candidates[0] : { pattern: "NONE", confidence: 0, bonus: 0, description: "" };
}

/**
 * Versión async que detecta patrones para un símbolo.
 * Prioriza el buffer WS (tiempo real, sin latencia REST) si tiene ≥30 velas acumuladas.
 * Fallback: klines REST con cache de 30s.
 */
export async function detectPatternsForSymbol(symbol: string): Promise<PatternResult> {
  try {
    // Intentar usar el buffer WS primero — más fresco, sin carga de API
    const wsBuffer = getWsKlineBuffer(symbol, 30);
    const klines = wsBuffer ?? await getKlines5m(symbol, 50);
    const source = wsBuffer ? "WS" : "REST";
    const result = detectPatterns(klines);
    if (result.pattern !== "NONE") {
      _lastPatternBySymbol[symbol] = result;
    } else {
      _lastPatternBySymbol[symbol] = result; // también guardar NONE para el snapshot
    }
    if (wsBuffer && result.pattern !== "NONE") {
      // Solo logear si usamos WS y hay patrón para no spam
      console.log(`[pattern] ${symbol} [${source}] ${result.pattern} bonus=${result.bonus >= 0 ? "+" : ""}${result.bonus}`);
    }
    return result;
  } catch {
    return { pattern: "NONE", confidence: 0, bonus: 0, description: "" };
  }
}

// Memoria de los últimos patrones detectados por símbolo (para el prompt de Tanit)
const _lastPatternBySymbol: Record<string, PatternResult> = {};

/**
 * Snapshot de patrones detectados recientemente para el prompt de Tanit.
 * Solo incluye símbolos con patrón activo (no NONE).
 */
export function getPatternSnapshotForTanit(symbols: string[]): string {
  const lines = symbols
    .map(sym => {
      const r = _lastPatternBySymbol[sym];
      if (!r || r.pattern === "NONE") return null;
      const isStopHunt = r.pattern === "STOP_HUNT_REVERSAL_LONG" || r.pattern === "STOP_HUNT_REVERSAL_SHORT";
      const emoji = isStopHunt
        ? "🚨"
        : (r.bonus > 0 ? "📈" : "📉");
      const tag = isStopHunt ? " [STOP HUNT — PRIORIDAD ALTA]" : "";
      const coin = sym.replace("USDT", "");
      return `${emoji} ${coin}: ${r.pattern}${tag} | bonus=${r.bonus >= 0 ? "+" : ""}${r.bonus} (conf ${Math.round(r.confidence * 100)}%) — ${r.description}`;
    })
    .filter(Boolean);

  return lines.length > 0
    ? lines.join("\n")
    : "Sin patrones técnicos activos detectados en este ciclo de scan";
}
