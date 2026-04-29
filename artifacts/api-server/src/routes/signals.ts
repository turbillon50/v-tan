import { Router } from "express";
import { GetSignalResponse, GetAiAnalysisResponse } from "@workspace/api-zod";
import { generateSignalScore, generateCandles, calcRSI, calcEMA, calcMACD, calcBollingerBands, calcATR } from "../lib/demo-data";
import { bybitPublic } from "../lib/bybit-auth";

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcRSISeries(closes: number[], period = 14): number[] {
  const out: number[] = [];
  for (let i = period + 1; i <= closes.length; i++) {
    out.push(calcRSI(closes.slice(0, i), period));
  }
  return out;
}

// ─── RSI Divergence ───────────────────────────────────────────────────────────
function detectDivergence(closes: number[], rsiSeries: number[]): { score: number; reason: string } {
  if (closes.length < 20 || rsiSeries.length < 10) return { score: 0, reason: "" };

  const n = Math.min(rsiSeries.length, closes.length);
  const prices = closes.slice(-n);
  const rsis   = rsiSeries.slice(-n);

  const half = Math.floor(n / 2);
  const prevP = Math.min(...prices.slice(0, half));
  const currP = Math.min(...prices.slice(half));
  const prevR = rsis[prices.slice(0, half).indexOf(prevP)] ?? rsis[0];
  const currR = rsis[half + prices.slice(half).indexOf(currP)] ?? rsis[rsis.length - 1];

  const prevH = Math.max(...prices.slice(0, half));
  const currH = Math.max(...prices.slice(half));
  const prevRH = rsis[prices.slice(0, half).indexOf(prevH)] ?? rsis[0];
  const currRH = rsis[half + prices.slice(half).indexOf(currH)] ?? rsis[rsis.length - 1];

  // Bullish: price lower low, RSI higher low
  if (currP < prevP * 0.998 && currR > prevR + 2 && currR < 55) {
    return { score: 18, reason: "Divergencia alcista RSI — precio baja pero RSI sube: reversal fuerte" };
  }
  // Bearish: price higher high, RSI lower high
  if (currH > prevH * 1.002 && currRH < prevRH - 2 && currRH > 45) {
    return { score: -18, reason: "Divergencia bajista RSI — precio sube pero RSI baja: trampa alcista" };
  }
  return { score: 0, reason: "" };
}

// ─── Candlestick Patterns ─────────────────────────────────────────────────────
interface OHLCCandle { open: number; high: number; low: number; close: number; volume: number }

function detectPatterns(candles: OHLCCandle[]): { score: number; reasons: string[] } {
  if (candles.length < 3) return { score: 0, reasons: [] };
  const reasons: string[] = [];
  let score = 0;

  const c  = candles[candles.length - 1]; // current
  const p  = candles[candles.length - 2]; // previous
  const pp = candles[candles.length - 3]; // two back

  const body    = Math.abs(c.close - c.open);
  const range   = c.high - c.low;
  const upperW  = c.high - Math.max(c.open, c.close);
  const lowerW  = Math.min(c.open, c.close) - c.low;
  const isBull  = c.close > c.open;

  // Doji
  if (body < range * 0.1 && range > 0) {
    reasons.push("Doji — indecision, posible cambio de direccion");
  }

  // Hammer (bullish) — long lower wick, body in upper third
  if (lowerW > body * 2 && upperW < body * 0.5 && isBull) {
    score += 12; reasons.push("Martillo — reversal alcista fuerte");
  }

  // Shooting Star (bearish)
  if (upperW > body * 2 && lowerW < body * 0.5 && !isBull) {
    score -= 12; reasons.push("Estrella fugaz — reversal bajista fuerte");
  }

  // Bullish Engulfing
  const pBody = p.close - p.open;
  const cBody = c.close - c.open;
  if (pBody < 0 && cBody > 0 && c.open < p.close && c.close > p.open) {
    score += 15; reasons.push("Engulfing alcista — vela envuelve la bajista anterior");
  }

  // Bearish Engulfing
  if (pBody > 0 && cBody < 0 && c.open > p.close && c.close < p.open) {
    score -= 15; reasons.push("Engulfing bajista — vela envuelve la alcista anterior");
  }

  // Marubozu bullish (strong candle, tiny wicks)
  if (isBull && upperW < body * 0.05 && lowerW < body * 0.05 && body > range * 0.9) {
    score += 10; reasons.push("Marubozu alcista — fuerza maxima, compradores dominaron");
  }

  // Three consecutive bull candles (momentum)
  if (c.close > c.open && p.close > p.open && pp.close > pp.open && c.close > p.close && p.close > pp.close) {
    score += 8; reasons.push("Tres velas alcistas consecutivas — momentum al alza");
  }

  // Three consecutive bear candles
  if (c.close < c.open && p.close < p.open && pp.close < pp.open && c.close < p.close && p.close < pp.close) {
    score -= 8; reasons.push("Tres velas bajistas consecutivas — presion vendedora");
  }

  return { score, reasons };
}

// ─── Market Sessions ──────────────────────────────────────────────────────────
function getMarketSession(): { name: string; bonus: number; reason: string } {
  const h = new Date().getUTCHours();
  const m = new Date().getUTCMinutes();
  const t = h + m / 60;

  if (t >= 13 && t < 16) {
    return { name: "Londres+NY Overlap", bonus: 8, reason: "Sesión de máxima liquidez (Londres+NY) — señales más fiables ahora" };
  }
  if (t >= 13 && t < 22) {
    return { name: "Nueva York", bonus: 5, reason: "Sesión New York activa — alta liquidez y volumen institucional" };
  }
  if (t >= 7 && t < 16) {
    return { name: "Londres", bonus: 5, reason: "Sesión Londres activa — segunda más líquida del día" };
  }
  if (t >= 0 && t < 8) {
    return { name: "Asia", bonus: 0, reason: "Sesión Asia — volatilidad moderada, espera confirmación" };
  }
  return { name: "Pre-mercado", bonus: -3, reason: "Volumen bajo — señales menos confiables en este horario" };
}

// ─── BTC Dominance ────────────────────────────────────────────────────────────
async function getBTCDominanceFactor(symbol: string): Promise<{ score: number; reason: string }> {
  if (symbol === "BTCUSDT") return { score: 0, reason: "" };
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/global", { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { score: 0, reason: "" };
    const data = await r.json() as any;
    const dom: number = data?.data?.market_cap_percentage?.btc ?? 52;
    if (dom > 55) return { score: -6, reason: `BTC Dominance alta (${dom.toFixed(1)}%) — altcoins bajo presion` };
    if (dom < 48) return { score:  6, reason: `BTC Dominance baja (${dom.toFixed(1)}%) — altseason activa, favorece ${symbol.replace("USDT","")}` };
    return { score: 0, reason: "" };
  } catch {
    return { score: 0, reason: "" };
  }
}

// ─── Gemini AI ────────────────────────────────────────────────────────────────
async function callGemini(symbol: string, score: number, reasons: string[]): Promise<{ narrative: string; recommendation: string; sentiment: "BULLISH" | "BEARISH" | "NEUTRAL" } | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  try {
    const coin = symbol.replace("USDT", "");
    const direction = score >= 60 ? "ALCISTA" : score <= 40 ? "BAJISTA" : "NEUTRAL";
    const prompt = `Eres un trader experto en criptomonedas. Analiza esta situación para ${coin}/USDT en futuros perpetuos:

Score algorítmico: ${score}/100 (${direction})
Señales detectadas: ${reasons.slice(0, 6).join(". ")}

Escribe en español:
1. Un análisis narrativo de 2-3 oraciones sobre la situación actual del mercado
2. Una recomendación concreta de trading (LONG/SHORT/ESPERAR con niveles)

Sé directo, profesional y específico. No más de 150 palabras en total.`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 300 }
        }),
        signal: AbortSignal.timeout(10000)
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) return null;

    const lines = text.trim().split("\n").filter(Boolean);
    const narrative    = lines.slice(0, -1).join(" ");
    const recommendation = lines[lines.length - 1] ?? lines[0];

    return {
      narrative:      narrative || text,
      recommendation: recommendation || "Ver análisis arriba.",
      sentiment:      score >= 60 ? "BULLISH" : score <= 40 ? "BEARISH" : "NEUTRAL"
    };
  } catch {
    return null;
  }
}

// ─── AI Narratives (demo fallback) ────────────────────────────────────────────
const AI_NARRATIVES = {
  BULLISH: {
    narrative: "El mercado muestra señales técnicas alcistas significativas. RSI en zona de momentum sin sobrecompra, MACD con cruce alcista y EMAs perfectamente alineadas (9>21>50). El Open Interest sigue creciendo indicando entrada de capital fresco. El índice Fear & Greed en zona de codicia moderada históricamente favorece continuación alcista. Las ballenas han estado acumulando en los últimos movimientos.",
    sentiment: "BULLISH" as const,
    recommendation: "LONG en retroceso al soporte más cercano. SL bajo mínimo reciente. Objetivos en TP1, TP2 y TP3 escalonados. Confirmar con volumen creciente."
  },
  BEARISH: {
    narrative: "Señales técnicas apuntan a presión vendedora dominante. RSI con divergencia bajista detectada. MACD bajo línea de señal con histograma negativo creciente. EMAs en configuración bajista. CVD acumulado negativo indica volumen neto vendedor. Funding rate elevado presiona longs hacia la baja.",
    sentiment: "BEARISH" as const,
    recommendation: "SHORT en rebote a resistencia. SL sobre máximo reciente. Reducir exposición o esperar confirmación de ruptura de soporte con volumen."
  },
  NEUTRAL: {
    narrative: "Mercado en consolidación sin dirección clara. Indicadores en equilibrio: RSI cerca de 50, MACD con histograma plano, precio entre bandas de Bollinger. Volumen por debajo del promedio indica falta de convicción. Esta fase típicamente precede a un movimiento fuerte.",
    sentiment: "NEUTRAL" as const,
    recommendation: "ESPERAR confirmación de ruptura de rango con volumen antes de tomar posición. Preparar órdenes en ambos extremos del rango."
  }
};

// ─── Direction ────────────────────────────────────────────────────────────────
function getDirection(score: number) {
  if (score >= 75) return { direction: "LONG"  as const, strength: "STRONG"   as const };
  if (score >= 60) return { direction: "LONG"  as const, strength: "MODERATE" as const };
  if (score >= 50) return { direction: "LONG"  as const, strength: "WEAK"     as const };
  if (score <= 25) return { direction: "SHORT" as const, strength: "STRONG"   as const };
  if (score <= 40) return { direction: "SHORT" as const, strength: "MODERATE" as const };
  return { direction: "NEUTRAL" as const, strength: "WEAK" as const };
}

// ─── GET /signals/:symbol ─────────────────────────────────────────────────────
router.get("/signals/:symbol", async (req, res): Promise<void> => {
  const symbol = String(req.params.symbol);

  let candles: OHLCCandle[] = [];
  try {
    const data = await bybitPublic("GET", "/v5/market/kline", { category: "linear", symbol, interval: "5", limit: "80" });
    const list = data?.result?.list;
    if (Array.isArray(list) && list.length > 0) {
      candles = list.reverse().map((c: string[]) => ({
        open: parseFloat(c[1]), high: parseFloat(c[2]),
        low:  parseFloat(c[3]), close: parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }));
    }
  } catch { /* fallback below */ }

  if (candles.length < 20) {
    const gen = generateCandles(symbol, 5, 80);
    candles = gen.map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  }

  const closes = candles.map(c => c.close);
  const rsi    = calcRSI(closes);
  const macd   = calcMACD(closes);
  const ema9   = calcEMA(closes, 9);
  const ema21  = calcEMA(closes, 21);
  const ema50  = calcEMA(closes, 50);
  const bb     = calcBollingerBands(closes);
  const price  = closes[closes.length - 1];

  // Volumes
  const vols   = candles.map(c => c.volume);
  const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const curVol = vols[vols.length - 1] ?? avgVol;
  const volRatio = curVol / avgVol;

  let score = 50;
  const reasons: string[] = [];

  // ── RSI ──
  if (rsi < 30)      { score += 15; reasons.push("RSI oversold — rebote alcista probable"); }
  else if (rsi > 70) { score -= 15; reasons.push("RSI sobrecomprado — corrección probable"); }
  else if (rsi > 55) { score +=  7; reasons.push("RSI con momentum alcista"); }
  else if (rsi < 45) { score -=  7; reasons.push("RSI con momentum bajista"); }

  // ── MACD ──
  if (macd.histogram > 0) { score += 10; reasons.push("MACD histograma positivo — bulls en control"); }
  else                     { score -= 10; reasons.push("MACD histograma negativo — bears en control"); }

  // ── EMAs ──
  if (ema9 > ema21 && ema21 > ema50) { score += 12; reasons.push("EMAs alineadas alcistas (9>21>50)"); }
  else if (ema9 < ema21 && ema21 < ema50) { score -= 12; reasons.push("EMAs alineadas bajistas (9<21<50)"); }
  else { reasons.push("EMAs mixtas — mercado en consolidación"); }

  // ── Price vs EMA21 ──
  if (price > ema21)  { score += 6; reasons.push("Precio sobre EMA21 — tendencia alcista"); }
  else                { score -= 6; reasons.push("Precio bajo EMA21 — tendencia bajista"); }

  // ── Bollinger Bands ──
  if (price < bb.lower)  { score += 10; reasons.push("Precio bajo banda Bollinger inferior — oversold extremo"); }
  else if (price > bb.upper) { score -= 10; reasons.push("Precio sobre banda Bollinger superior — overbought"); }

  // ── Volume ──
  if (volRatio > 1.5) { score += 5; reasons.push(`Volumen ${volRatio.toFixed(1)}x sobre promedio — confirmación de movimiento`); }

  // ── RSI Divergence ──
  const rsiSeries = calcRSISeries(closes);
  const div = detectDivergence(closes, rsiSeries);
  if (div.score !== 0) { score += div.score; reasons.push(div.reason); }

  // ── Candlestick Patterns ──
  const { score: patScore, reasons: patReasons } = detectPatterns(candles);
  score += patScore;
  reasons.push(...patReasons);

  // ── Market Session ──
  const session = getMarketSession();
  score += session.bonus;
  reasons.push(`${session.reason}`);

  // ── BTC Dominance ──
  const btcFactor = await getBTCDominanceFactor(symbol);
  if (btcFactor.score !== 0) { score += btcFactor.score; reasons.push(btcFactor.reason); }

  score = Math.max(1, Math.min(100, Math.round(score)));

  // Add session info as first contextual reason
  reasons.unshift(`Sesión: ${session.name}`);

  const { direction, strength } = getDirection(score);

  res.json(GetSignalResponse.parse({ symbol, score, direction, strength, reasons, updatedAt: Date.now() }));
});

// ─── GET /signals/:symbol/ai-analysis ────────────────────────────────────────
router.get("/signals/:symbol/ai-analysis", async (req, res): Promise<void> => {
  const symbol = String(req.params.symbol);

  // Calculate a real score for the narrative
  let score = 50;
  try {
    const klineData = await bybitPublic("GET", "/v5/market/kline", { category: "linear", symbol, interval: "5", limit: "60" });
    const list = klineData?.result?.list;
    if (Array.isArray(list) && list.length > 0) {
      const candles = list.reverse().map((c: string[]) => ({
        open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5])
      }));
      const closes = candles.map((c: any) => c.close);
      const rsi  = calcRSI(closes);
      const macd = calcMACD(closes);
      const ema9 = calcEMA(closes, 9); const ema21 = calcEMA(closes, 21); const ema50 = calcEMA(closes, 50);
      const price = closes[closes.length - 1];
      if (rsi < 30) score += 15; else if (rsi > 70) score -= 15;
      if (macd.histogram > 0) score += 10; else score -= 10;
      if (ema9 > ema21 && ema21 > ema50) score += 12; else if (ema9 < ema21 && ema21 < ema50) score -= 12;
      if (price > ema21) score += 6; else score -= 6;

      const rsiSeries = calcRSISeries(closes);
      const div = detectDivergence(closes, rsiSeries);
      score += div.score;
      const { score: ps } = detectPatterns(candles.map((c: any) => c));
      score += ps;
      score = Math.max(1, Math.min(100, Math.round(score)));

      const reasons = [div.reason, ...(ps > 0 ? ["Patrón de vela detectado"] : [])].filter(Boolean);
      const gemini = await callGemini(symbol, score, reasons);
      if (gemini) {
        res.json(GetAiAnalysisResponse.parse({ symbol, narrative: gemini.narrative, sentiment: gemini.sentiment, recommendation: gemini.recommendation, updatedAt: Date.now(), summary: gemini.recommendation }));
        return;
      }
    }
  } catch { /* fallback */ }

  const template = score >= 65 ? AI_NARRATIVES.BULLISH : score <= 35 ? AI_NARRATIVES.BEARISH : AI_NARRATIVES.NEUTRAL;
  const { score: fallbackScore } = generateSignalScore(symbol);
  const template2 = fallbackScore >= 65 ? AI_NARRATIVES.BULLISH : fallbackScore <= 35 ? AI_NARRATIVES.BEARISH : AI_NARRATIVES.NEUTRAL;
  const t = score !== 50 ? template : template2;

  res.json(GetAiAnalysisResponse.parse({ symbol, narrative: t.narrative, sentiment: t.sentiment, recommendation: t.recommendation, updatedAt: Date.now(), summary: t.recommendation }));
});

// ─── GET /signals/:symbol/conviction — One trade per cycle, max conviction ────
router.get("/signals/:symbol/conviction", async (req, res): Promise<void> => {
  const symbol = String(req.params.symbol);

  const BASE_PRICES: Record<string, number> = {
    BTCUSDT: 83000, ETHUSDT: 3200, SOLUSDT: 180, BNBUSDT: 600,
    XRPUSDT: 0.62, DOGEUSDT: 0.18, AVAXUSDT: 38, LINKUSDT: 18,
    ARBUSDT: 1.2, OPUSDT: 2.5,
  };

  let candles: OHLCCandle[] = [];
  try {
    const kd = await bybitPublic("GET", "/v5/market/kline", { category: "linear", symbol, interval: "5", limit: "80" });
    const list = kd?.result?.list;
    if (Array.isArray(list) && list.length > 0) {
      candles = (list as string[][]).reverse().map(c => ({
        open: parseFloat(c[1]), high: parseFloat(c[2]),
        low: parseFloat(c[3]),  close: parseFloat(c[4]), volume: parseFloat(c[5]),
      }));
    }
  } catch { /* fallback */ }

  if (candles.length < 20) {
    const gen = generateCandles(symbol, 5, 80);
    candles = gen.map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  }

  const closes  = candles.map(c => c.close);
  const price   = closes[closes.length - 1] || (BASE_PRICES[symbol] ?? 100);
  const rsi     = calcRSI(closes);
  const macd    = calcMACD(closes);
  const ema9    = calcEMA(closes, 9);
  const ema21   = calcEMA(closes, 21);
  const ema50   = calcEMA(closes, 50);
  const atrRaw  = calcATR(candles.map(c => ({ high: c.high, low: c.low, close: c.close })), 14);
  const atrPct  = (atrRaw / price) * 100;

  // Score
  let score = 50;
  if (rsi < 30)      score += 15; else if (rsi > 70) score -= 15;
  else if (rsi > 55) score +=  7; else if (rsi < 45) score -=  7;
  if (macd.histogram > 0) score += 10; else score -= 10;
  if (ema9 > ema21 && ema21 > ema50) score += 12;
  else if (ema9 < ema21 && ema21 < ema50) score -= 12;
  if (price > ema21) score += 6; else score -= 6;

  const { score: patScore, reasons: patReasons } = detectPatterns(candles);
  score += patScore;
  const session   = getMarketSession();
  score += session.bonus;
  const rsiSeries = calcRSISeries(closes);
  const div       = detectDivergence(closes, rsiSeries);
  score += div.score;
  score = Math.max(1, Math.min(100, Math.round(score)));

  const direction    = score >= 65 ? "LONG" : score <= 35 ? "SHORT" : "NEUTRAL";
  const isPrime      = session.name.includes("Londres") || session.name.includes("Nueva York") || session.name.includes("Overlap");
  const conviction   = Math.abs(score - 50) * 2;
  const patConfirmed = direction === "SHORT" ? patScore < 0 : patScore > 0;
  const atrOk        = atrPct >= 0.20;
  const scoreGold    = conviction >= 36;
  const scorePlat    = conviction >= 64;
  const divBonus     = div.score !== 0;

  type Tier = "platinum" | "gold" | "silver" | "wait";
  let tier: Tier;
  let capPct: number; let lev: number;

  if (scorePlat && patConfirmed && isPrime && atrOk)          { tier = "platinum"; capPct = 20; lev = 125; }
  else if (scoreGold && isPrime && atrOk)                     { tier = "gold";     capPct = 12; lev = 100; }
  else if (conviction >= 16 && atrOk)                         { tier = "silver";   capPct = 5;  lev = 20;  }
  else                                                        { tier = "wait";     capPct = 0;  lev = 0;   }

  // 20% target: 20 = capPct * lev/100 * movePct → movePct = 20/(capPct*lev/100)
  const movePct20  = lev > 0 ? parseFloat((20 / (capPct * lev / 100)).toFixed(3)) : 0;
  const moveUSD20  = parseFloat((price * movePct20 / 100).toFixed(2));
  const slPct      = lev > 0 ? Math.max(atrPct * (tier === "platinum" ? 0.30 : tier === "gold" ? 0.50 : 1.0), 0.08) : 0;
  const slCapLoss  = lev > 0 ? parseFloat((slPct * lev * capPct / 100).toFixed(2)) : 0;

  const tp1p = tier === "platinum" ? 2  : tier === "gold" ? 3  : 5;
  const tp2p = tier === "platinum" ? 5  : tier === "gold" ? 8  : 12;
  const tp3p = tier === "platinum" ? 15 : tier === "gold" ? 20 : 30;
  const g1   = parseFloat((tp1p * lev * capPct / 100).toFixed(1));
  const g2   = parseFloat((tp2p * lev * capPct / 100).toFixed(1));
  const g3   = parseFloat((tp3p * lev * capPct / 100).toFixed(1));

  const sideLabel = direction === "SHORT" ? "SHORT" : "LONG";
  const labels: Record<Tier, string> = {
    platinum: "PLATINUM", gold: "ORO", silver: "REDUCIDA", wait: "ESPERA",
  };
  const actions: Record<Tier, string> = {
    platinum: `${sideLabel} COMPLETO — ${capPct}% · ${lev}x · Para +20%: precio mueve ${movePct20}%`,
    gold:     `${sideLabel} MODERADO — ${capPct}% · ${lev}x · Sal en TP1 y asegura`,
    silver:   `${sideLabel} MÍNIMO — ${capPct}% · ${lev}x · Convicción baja, tamaño reducido`,
    wait:     "SIN SEÑAL — El ciclo que no pierdes también suma. Espera.",
  };

  res.json({
    symbol, score, direction, tier, tierLabel: labels[tier],
    canEnter: tier !== "wait",
    action: actions[tier],
    entry: {
      side: direction, capPct, leverage: lev,
      slPercent: parseFloat(slPct.toFixed(3)),
      slCapitalLoss: slCapLoss,
      tp1: tp1p, tp2: tp2p, tp3: tp3p,
      gainTp1: g1, gainTp2: g2, gainTp3: g3,
      movePct20, moveUSD20,
      rrRatio: slPct > 0 ? parseFloat((tp1p / slPct).toFixed(1)) : 0,
    },
    conditions: [
      { id: "score",   label: `Convicción fuerte (${direction === "SHORT" ? "≤18 Plat · ≤32 Gold" : "≥82 Plat · ≥68 Gold"})`, met: scorePlat, metGold: scoreGold, value: `${score}/100 (${conviction}%)`, weight: "critical"  },
      { id: "pattern", label: `Patrón de vela ${direction === "SHORT" ? "bajista" : "alcista"} confirmado`, met: patConfirmed, value: patReasons[0] ?? "Ninguno", weight: "critical"  },
      { id: "session", label: "Sesión prime (London / NY / Overlap)",     met: isPrime,  value: session.name,                            weight: "critical"  },
      { id: "atr",     label: "Volatilidad ATR suficiente (≥0.20%)",      met: atrOk,    value: `${atrPct.toFixed(2)}%`,                 weight: "important" },
      { id: "div",     label: "Divergencia RSI confirmada (bonus)",        met: divBonus, value: div.score > 0 ? "Alcista" : div.score < 0 ? "Bajista" : "—", weight: "bonus" },
    ],
    session: { name: session.name, isPrime },
    atrPercent: parseFloat(atrPct.toFixed(3)),
    updatedAt: Date.now(),
  });
});

// ─── GET /signals/:symbol/risk — ATR-based professional risk parameters ───────
router.get("/signals/:symbol/risk", async (req, res): Promise<void> => {
  const symbol = String(req.params.symbol);

  const BASE_PRICES: Record<string, number> = {
    BTCUSDT: 83000, ETHUSDT: 3200, SOLUSDT: 180, BNBUSDT: 600,
    XRPUSDT: 0.62,  DOGEUSDT: 0.18, AVAXUSDT: 38, LINKUSDT: 18,
    ARBUSDT: 1.2,   OPUSDT: 2.5,
  };

  let atr = 0; let price = 0; let atrPct = 0;
  let volatility: "low" | "medium" | "high" | "extreme" = "medium";

  try {
    const kd = await bybitPublic("GET", "/v5/market/kline", { category: "linear", symbol, interval: "15", limit: "20" });
    const list = kd?.result?.list;
    if (Array.isArray(list) && list.length >= 2) {
      const candles = (list as string[][]).reverse().map(c => ({
        high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4])
      }));
      atr   = calcATR(candles, Math.min(14, candles.length - 1));
      price = candles[candles.length - 1].close;
      atrPct = (atr / price) * 100;
    }
  } catch { /* fallback */ }

  if (price === 0 || atr === 0) {
    price  = BASE_PRICES[symbol] ?? 100;
    atr    = price * 0.005;
    atrPct = 0.5;
  }

  if      (atrPct < 0.2) volatility = "low";
  else if (atrPct < 0.5) volatility = "medium";
  else if (atrPct < 1.0) volatility = "high";
  else                   volatility = "extreme";

  const PROFILES = [
    { key: "conservative", label: "Conservador", leverage: 10,  capitalPct: 1,  atrMult: 2.0, tp1: 3,  tp2: 7,  tp3: 15, trailingStop: false, partialExit: false },
    { key: "risky",        label: "Arriesgado",  leverage: 20,  capitalPct: 5,  atrMult: 1.5, tp1: 5,  tp2: 10, tp3: 20, trailingStop: false, partialExit: false },
    { key: "ultra",        label: "Ultra",       leverage: 75,  capitalPct: 10, atrMult: 1.0, tp1: 8,  tp2: 15, tp3: 30, trailingStop: true,  partialExit: true  },
    { key: "tiburon",      label: "Tiburón 🦈",  leverage: 100, capitalPct: 15, atrMult: 0.5, tp1: 10, tp2: 25, tp3: 50, trailingStop: true,  partialExit: true  },
    { key: "megalodon",    label: "Megalodón 🦈⚡",leverage: 125,capitalPct: 20, atrMult: 0.3, tp1: 2,  tp2: 5,  tp3: 15, trailingStop: true,  partialExit: true  },
  ];

  const modes = PROFILES.map(p => {
    const slPct  = Math.max(parseFloat((atrPct * p.atrMult).toFixed(3)), 0.05);
    const rrRatio = parseFloat((p.tp1 / slPct).toFixed(2));
    return {
      key: p.key, label: p.label, leverage: p.leverage, capitalPct: p.capitalPct,
      slPercent: slPct, atrMultiplier: p.atrMult,
      tp1: p.tp1, tp2: p.tp2, tp3: p.tp3,
      rrRatio: Math.max(rrRatio, 0.1),
      trailingStop: p.trailingStop,
      partialExit:  p.partialExit,
    };
  });

  const recommendation =
    atrPct > 1.0 ? "Volatilidad extrema — SL amplio. Megalodón es muy arriesgado ahora. Prefiere Tiburón con trailing stop." :
    atrPct > 0.5 ? "Volatilidad alta — buen momento para Tiburón o Megalodón. Activa trailing stop siempre." :
    atrPct > 0.2 ? "Volatilidad media — condiciones óptimas para todos los modos. El SL ATR es tu mejor aliado." :
                   "Volatilidad baja — señales menos definidas. Conservative o Risky recomendado.";

  res.json({
    symbol, price: parseFloat(price.toFixed(4)),
    atr: parseFloat(atr.toFixed(4)),
    atrPercent: parseFloat(atrPct.toFixed(3)),
    volatility, modes, recommendation, updatedAt: Date.now(),
  });
});

export default router;
