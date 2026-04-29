import {
  startEngine, stopEngine, getEngineStatus,
  startMiddlePointOnly, stopMiddlePoint,
  setEngineCapitalPct, setEngineLiveMode,
  setEscaleraSymbols, setMiddlePointCapitalPct,
  emergencyKill, manualClosePosition,
  resetBalance, setCapitalStartPoint,
  setDailyLossLimit, setCompoundCycle, forceCompoundHarvest,
  setEscalonPositionsTarget, setEscalonClosePct,
  setEscaleraIcTarget, setMPIcTarget, setMPLeverage, setMPRangeWindow,
  setMiddlePointPositionsTarget,
} from "./trading-engine";
import { bybitPublic } from "./bybit-auth";
import { getAdaptiveThreshold } from "./db-persistence";

const TAG = "[hybrid]";

type Regime = "trending" | "lateral" | "transition";

const ESC_SHARE = 0.6;
const MP_SHARE  = 0.4;
const HYSTERESIS_SCANS = 3;

interface HybridState {
  active: boolean;
  regime: Regime;
  regimeConfidence: number;
  regimeHistory: { ts: number; regime: Regime; adx: number; bbSqueeze: boolean }[];
  lastRegimeScanAt: number;
  escaleraDriving: boolean;
  mpDriving: boolean;
  learnBonus: Record<string, number>;
  scanCount: number;
  totalCapitalPct: number;
  pendingRegime: Regime | null;
  pendingRegimeCount: number;
  liveMode: boolean;
}

const hybrid: HybridState = {
  active: false,
  regime: "transition",
  regimeConfidence: 0,
  regimeHistory: [],
  lastRegimeScanAt: 0,
  escaleraDriving: false,
  mpDriving: false,
  learnBonus: {},
  scanCount: 0,
  totalCapitalPct: 50,
  pendingRegime: null,
  pendingRegimeCount: 0,
  liveMode: false,
};

let hybridScanTimer: ReturnType<typeof setInterval> | null = null;
const HYBRID_SCAN_MS = 60_000;
const REGIME_SYMBOLS = ["ETHUSDT", "SOLUSDT", "LINKUSDT"];

function calcEMA(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
  return ema;
}

function calcADXLocal(highs: number[], lows: number[], closes: number[], period: number): number {
  if (highs.length < period + 2) return 25;
  let atrSum = 0, plusDmSum = 0, minusDmSum = 0;
  for (let i = 1; i <= period; i++) {
    const idx = highs.length - period - 1 + i;
    const tr = Math.max(
      highs[idx] - lows[idx],
      Math.abs(highs[idx] - closes[idx - 1]),
      Math.abs(lows[idx] - closes[idx - 1])
    );
    atrSum += tr;
    const plusDm = highs[idx] - highs[idx - 1];
    const minusDm = lows[idx - 1] - lows[idx];
    plusDmSum += plusDm > minusDm && plusDm > 0 ? plusDm : 0;
    minusDmSum += minusDm > plusDm && minusDm > 0 ? minusDm : 0;
  }
  if (atrSum === 0) return 25;
  const plusDi = (plusDmSum / atrSum) * 100;
  const minusDi = (minusDmSum / atrSum) * 100;
  const diSum = plusDi + minusDi;
  if (diSum === 0) return 0;
  return Math.abs(plusDi - minusDi) / diSum * 100;
}

async function getKlines(symbol: string, interval: string, limit: number): Promise<any[]> {
  try {
    const d = await bybitPublic("GET", "/v5/market/kline", {
      category: "linear", symbol, interval, limit: String(limit),
    });
    return d?.result?.list ?? [];
  } catch { return []; }
}

async function classifyRegime(): Promise<{ regime: Regime; confidence: number; adx: number; bbSqueeze: boolean }> {
  const results: { adx: number; bbSq: boolean; trendAligned: boolean }[] = [];

  await Promise.allSettled(REGIME_SYMBOLS.map(async (sym) => {
    const klines = await getKlines(sym, "15", 60);
    if (klines.length < 30) return;

    const closes = klines.map((k: any) => parseFloat(k[4])).reverse();
    const highs = klines.map((k: any) => parseFloat(k[2])).reverse();
    const lows = klines.map((k: any) => parseFloat(k[3])).reverse();

    const adx = calcADXLocal(highs, lows, closes, 14);

    const bb20 = closes.slice(-20);
    const bbMid = bb20.reduce((a, b) => a + b, 0) / 20;
    const bbStd = Math.sqrt(bb20.reduce((a, b) => a + (b - bbMid) ** 2, 0) / 20);
    const bbWidth = bbMid > 0 ? (bbStd * 4 / bbMid) * 100 : 1;
    const bbSq = bbWidth < 1.5;

    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const ema50 = closes.length >= 50 ? calcEMA(closes, 50) : ema21;
    const trendAligned = (ema9 > ema21 && ema21 > ema50) || (ema9 < ema21 && ema21 < ema50);

    results.push({ adx, bbSq, trendAligned });
  }));

  if (results.length === 0) return { regime: "transition", confidence: 30, adx: 25, bbSqueeze: false };

  const avgAdx = results.reduce((s, r) => s + r.adx, 0) / results.length;
  const anyBBSqueeze = results.some(r => r.bbSq);
  const trendCount = results.filter(r => r.trendAligned).length;
  const trendPct = trendCount / results.length;

  let regime: Regime;
  let confidence: number;

  if (avgAdx >= 25 && trendPct >= 0.6) {
    regime = "trending";
    confidence = Math.min(95, 50 + avgAdx + trendPct * 20);
  } else if (avgAdx < 20 && (anyBBSqueeze || trendPct < 0.3)) {
    regime = "lateral";
    confidence = Math.min(95, 50 + (25 - avgAdx) * 2 + (anyBBSqueeze ? 10 : 0));
  } else {
    regime = "transition";
    confidence = 40 + Math.abs(avgAdx - 22) * 2;
  }

  return { regime, confidence: Math.round(confidence), adx: parseFloat(avgAdx.toFixed(1)), bbSqueeze: anyBBSqueeze };
}

async function loadLearnBonuses(): Promise<void> {
  try {
    const data = await getAdaptiveThreshold();
    if (data.confidence > 0.3 && data.totalSamples >= 10) {
      hybrid.learnBonus = {};
      for (const sym of data.bestSymbols) {
        hybrid.learnBonus[sym] = 5;
      }
      for (const sym of data.worstSymbols) {
        hybrid.learnBonus[sym] = -3;
      }
      const learnSymbols = REGIME_SYMBOLS.filter(s => (hybrid.learnBonus[s] ?? 0) >= 3);
      if (learnSymbols.length > 0) {
        setEscaleraSymbols(learnSymbols.length >= 2 ? learnSymbols : REGIME_SYMBOLS);
      }
      console.log(TAG, `[LEARN] Bonuses aplicados — best: ${data.bestSymbols.join(",")} | worst: ${data.worstSymbols.join(",")}`);
    }
  } catch (e: any) {
    console.error(TAG, "[LEARN] Error cargando bonuses:", e.message);
  }
}

function applyCapitalSplit(totalPct: number, mpActive: boolean): void {
  if (mpActive) {
    const escPct = Math.round(totalPct * ESC_SHARE);
    const mpPct  = Math.round(totalPct * MP_SHARE);
    setEngineCapitalPct(escPct);
    setMiddlePointCapitalPct(mpPct);
    console.log(TAG, `Capital split: Escalera ${escPct}% + MP ${mpPct}% = ${escPct + mpPct}% (total pool ${totalPct}%)`);
  } else {
    setEngineCapitalPct(totalPct);
    console.log(TAG, `Capital 100% Escalera: ${totalPct}%`);
  }
}

async function applyRegimeChange(newRegime: Regime): Promise<void> {
  const prev = hybrid.regime;
  hybrid.regime = newRegime;

  if (newRegime === "lateral" && !hybrid.mpDriving) {
    applyCapitalSplit(hybrid.totalCapitalPct, true);
    startMiddlePointOnly(Math.round(hybrid.totalCapitalPct * MP_SHARE), "aggressive", "aggressive");
    hybrid.mpDriving = true;
    console.log(TAG, `MP ACTIVADO (${prev} -> lateral)`);
  }

  if (newRegime === "trending" && hybrid.mpDriving) {
    await stopMiddlePoint();
    hybrid.mpDriving = false;
    applyCapitalSplit(hybrid.totalCapitalPct, false);
    console.log(TAG, `MP DESACTIVADO (${prev} -> trending)`);
  }

  if (newRegime === "transition") {
    if (hybrid.mpDriving) {
      applyCapitalSplit(hybrid.totalCapitalPct, true);
    } else {
      applyCapitalSplit(hybrid.totalCapitalPct, false);
    }
  }
}

async function hybridScanLoop(): Promise<void> {
  if (!hybrid.active) return;
  hybrid.scanCount++;

  try {
    const { regime, confidence, adx, bbSqueeze } = await classifyRegime();

    hybrid.regimeConfidence = confidence;
    hybrid.lastRegimeScanAt = Date.now();
    hybrid.regimeHistory.push({ ts: Date.now(), regime, adx, bbSqueeze });
    if (hybrid.regimeHistory.length > 30) hybrid.regimeHistory = hybrid.regimeHistory.slice(-30);

    if (regime !== hybrid.regime) {
      if (hybrid.pendingRegime === regime) {
        hybrid.pendingRegimeCount++;
      } else {
        hybrid.pendingRegime = regime;
        hybrid.pendingRegimeCount = 1;
      }

      if (hybrid.pendingRegimeCount >= HYSTERESIS_SCANS) {
        console.log(TAG, `Régimen confirmado tras ${HYSTERESIS_SCANS} scans: ${hybrid.regime} -> ${regime}`);
        await applyRegimeChange(regime);
        hybrid.pendingRegime = null;
        hybrid.pendingRegimeCount = 0;
      } else {
        console.log(TAG, `Régimen pendiente: ${regime} (${hybrid.pendingRegimeCount}/${HYSTERESIS_SCANS})`);
      }
    } else {
      hybrid.pendingRegime = null;
      hybrid.pendingRegimeCount = 0;
    }

    if (hybrid.scanCount % 10 === 0) {
      await loadLearnBonuses();
    }

    console.log(TAG, `Scan #${hybrid.scanCount}: ${hybrid.regime} (${confidence}%) | ADX=${adx} | BB=${bbSqueeze} | esc=${hybrid.escaleraDriving} mp=${hybrid.mpDriving} | cap=${hybrid.totalCapitalPct}%`);
  } catch (e: any) {
    console.error(TAG, "Scan error:", e.message);
  }
}

interface HybridStartOpts {
  capitalPercent: number;
  liveMode: boolean;
  symbols?: string[];
  targetProfitPct?: number;
}

export async function startHybrid(opts: HybridStartOpts): Promise<void> {
  if (hybrid.active) await stopHybrid();

  hybrid.active = true;
  hybrid.scanCount = 0;
  hybrid.regimeHistory = [];
  hybrid.totalCapitalPct = opts.capitalPercent;
  hybrid.liveMode = opts.liveMode;
  hybrid.pendingRegime = null;
  hybrid.pendingRegimeCount = 0;

  const { regime, confidence } = await classifyRegime();
  hybrid.regime = regime;
  hybrid.regimeConfidence = confidence;

  console.log(TAG, `Motor iniciado | régimen: ${regime} (${confidence}%) | capital: ${opts.capitalPercent}% | live: ${opts.liveMode}`);

  if (opts.symbols && opts.symbols.length > 0) {
    setEscaleraSymbols(opts.symbols);
  }

  const startLateral = regime === "lateral";

  if (startLateral) {
    applyCapitalSplit(opts.capitalPercent, true);
  } else {
    applyCapitalSplit(opts.capitalPercent, false);
  }

  startEngine(
    "escalon",
    startLateral ? Math.round(opts.capitalPercent * ESC_SHARE) : opts.capitalPercent,
    opts.symbols,
    opts.liveMode,
    opts.targetProfitPct ?? 0,
  );
  hybrid.escaleraDriving = true;

  if (startLateral) {
    startMiddlePointOnly(Math.round(opts.capitalPercent * MP_SHARE), "aggressive", "aggressive");
    hybrid.mpDriving = true;
  }

  await loadLearnBonuses();

  hybridScanTimer = setInterval(hybridScanLoop, HYBRID_SCAN_MS);
}

export async function stopHybrid(): Promise<void> {
  hybrid.active = false;

  if (hybridScanTimer) {
    clearInterval(hybridScanTimer);
    hybridScanTimer = null;
  }

  // Siempre detener ambas engines — aunque escaleraDriving/mpDriving sea false
  // (puede ocurrir si el engine fue auto-relanzado directamente sin pasar por startHybrid)
  try {
    await stopEngine();
  } catch (e) {
    console.error(TAG, "Error deteniendo Escalera:", e);
  } finally {
    hybrid.escaleraDriving = false;
  }

  try {
    await stopMiddlePoint();
  } catch (e) {
    console.error(TAG, "Error deteniendo MP:", e);
  } finally {
    hybrid.mpDriving = false;
  }

  hybrid.pendingRegime = null;
  hybrid.pendingRegimeCount = 0;

  console.log(TAG, "Motor detenido");
}

export async function getHybridStatus() {
  const engine = await getEngineStatus();

  return {
    ...engine,
    hybrid: {
      active: hybrid.active,
      regime: hybrid.regime,
      regimeConfidence: hybrid.regimeConfidence,
      lastRegimeScanAt: hybrid.lastRegimeScanAt,
      escaleraDriving: hybrid.escaleraDriving,
      mpDriving: hybrid.mpDriving,
      learnBonus: hybrid.learnBonus,
      scanCount: hybrid.scanCount,
      regimeHistory: hybrid.regimeHistory.slice(-10),
      totalCapitalPct: hybrid.totalCapitalPct,
      escCapitalPct: hybrid.mpDriving ? Math.round(hybrid.totalCapitalPct * ESC_SHARE) : hybrid.totalCapitalPct,
      mpCapitalPct: hybrid.mpDriving ? Math.round(hybrid.totalCapitalPct * MP_SHARE) : 0,
      pendingRegime: hybrid.pendingRegime,
      pendingRegimeCount: hybrid.pendingRegimeCount,
      hysteresisRequired: HYSTERESIS_SCANS,
    },
  };
}

export function isHybridActive(): boolean {
  return hybrid.active;
}

export function setHybridCapitalPct(pct: number): void {
  hybrid.totalCapitalPct = pct;
  applyCapitalSplit(pct, hybrid.mpDriving);
}

export {
  setEngineCapitalPct,
  setEngineLiveMode,
  setEscaleraSymbols,
  setMiddlePointCapitalPct,
  emergencyKill,
  manualClosePosition,
  resetBalance,
  setCapitalStartPoint,
  setDailyLossLimit,
  setCompoundCycle,
  forceCompoundHarvest,
  setEscalonPositionsTarget,
  setEscalonClosePct,
  setEscaleraIcTarget,
  setMPIcTarget,
  setMPLeverage,
  setMPRangeWindow,
  setMiddlePointPositionsTarget,
};
