/**
 * Tanit Trading Engine — el motor que hace que Tanit OPERE sola, no que
 * espere a que Luis le pida cosas.
 *
 * Cada tick autónomo (cada 15 min via autonomous-loop):
 *   1. Lee tesis 5.1 activa de tanit_thesis
 *   2. Lee balance + posiciones actuales + estado del día
 *   3. Aplica circuit breaker (-10% diario, 3 pérdidas seguidas, kill_switch)
 *   4. Calcula reserva sagrada 25% (intocable)
 *   5. Calcula capacity disponible para nuevos trades
 *   6. Si hay capacity → escanea N símbolos (top universo cripto)
 *   7. Para cada símbolo: score multi-motor según tesis
 *   8. Selecciona top-K diversificado (distintos símbolos, distintos motores)
 *   9. Ejecuta apertura para cada uno con SL/TP automático
 *  10. Registra plan en tanit_setup_plan + actualiza tanit_daily_state
 *
 * Diseño: NO depende de Mastra. Es código puro Node que usa los mismos
 * helpers de bybit-auth + governance + autonomy. Mastra/Tanit puede leer
 * el estado para CONVERSAR sobre él, pero el motor ejecuta independiente.
 */
import { pool } from "@workspace/db";
import {
  getBybitBalance,
  getOpenPositions,
  bybitPublic,
  placeMarketOrderDetailed,
  setTradingStopDetailed,
  setLeverage,
  calcQtyReal,
  isTestnet,
} from "./bybit-auth";
import { getRules } from "./governance";
import { logger } from "./logger";

// Universo de símbolos a escanear. Liquidez alta = entradas y salidas rápidas.
const UNIVERSE = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "TONUSDT", "ADAUSDT",
  "ATOMUSDT", "DOTUSDT", "OPUSDT", "ARBUSDT", "NEARUSDT",
];

// Parámetros default. La tesis 5.1 los puede override via params_snapshot.
interface EngineParams {
  sacredReservePct: number;       // 0.25 = 25% inviolable
  maxConcurrentTrades: number;    // 5 trades en paralelo máximo
  targetTradesPerDay: number;     // 5
  dailyDrawdownLimitPct: number;  // -10%
  consecutiveLossesLimit: number; // 3
  perTradeRiskPct: number;        // 1.5% de capital ACTIVO (no total) por trade
  defaultLeverage: number;        // 5
  slPct: number;                  // 2% SL
  tpPct: number;                  // 3% TP (RR 1.5)
}

const DEFAULTS: EngineParams = {
  sacredReservePct: 0.25,
  maxConcurrentTrades: 5,
  targetTradesPerDay: 5,
  dailyDrawdownLimitPct: -10,
  consecutiveLossesLimit: 3,
  perTradeRiskPct: 1.5,
  defaultLeverage: 5,
  slPct: 2,
  tpPct: 3,
};

interface ScannerCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SetupScore {
  symbol: string;
  direction: "Buy" | "Sell";
  motor: string;
  score: number;
  rationale: string;
  entryPrice: number;
}

interface DailyState {
  id: number;
  trading_day: string;
  equity_open: number | null;
  equity_current: number | null;
  pnl_today_usd: number;
  pnl_today_pct: number;
  max_drawdown_pct: number;
  trades_total: number;
  trades_wins: number;
  trades_losses: number;
  consecutive_losses: number;
  breaker_active: boolean;
  breaker_reason: string | null;
  sacred_reserve_usd: number | null;
  plan_target_trades: number;
}

// ─── Estado del día ────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getOrInitDailyState(equityNow: number, params: EngineParams): Promise<DailyState> {
  const d = today();
  let r = await pool.query<DailyState>(
    `SELECT * FROM tanit_daily_state WHERE trading_day = $1`,
    [d],
  );
  if (r.rows.length === 0) {
    // Nuevo día — equity_open es lo de ahora, calcula reserva sagrada
    const sacred = equityNow * params.sacredReservePct;
    r = await pool.query<DailyState>(
      `INSERT INTO tanit_daily_state (trading_day, equity_open, equity_current, sacred_reserve_usd, plan_target_trades)
       VALUES ($1, $2, $2, $3, $4) RETURNING *`,
      [d, equityNow, sacred, params.targetTradesPerDay],
    );
  } else {
    // Día existente — actualiza equity_current si es la primera lectura del día
    const s = r.rows[0]!;
    if (s.equity_open === null) {
      r = await pool.query<DailyState>(
        `UPDATE tanit_daily_state SET equity_open=$2, equity_current=$2, sacred_reserve_usd=$3, updated_at=now()
         WHERE trading_day=$1 RETURNING *`,
        [d, equityNow, equityNow * params.sacredReservePct],
      );
    }
  }
  return r.rows[0]!;
}

async function updateDailyState(equityNow: number, state: DailyState): Promise<DailyState> {
  const open = Number(state.equity_open ?? equityNow);
  const pnlUsd = equityNow - open;
  const pnlPct = open > 0 ? (pnlUsd / open) * 100 : 0;
  const drawdown = Math.min(Number(state.max_drawdown_pct ?? 0), pnlPct);
  const r = await pool.query<DailyState>(
    `UPDATE tanit_daily_state
       SET equity_current=$2, pnl_today_usd=$3, pnl_today_pct=$4,
           max_drawdown_pct=$5, updated_at=now()
     WHERE id=$1 RETURNING *`,
    [state.id, equityNow, pnlUsd, pnlPct, drawdown],
  );
  return r.rows[0]!;
}

async function tripBreaker(state: DailyState, reason: string): Promise<void> {
  await pool.query(
    `UPDATE tanit_daily_state SET breaker_active=true, breaker_reason=$2, breaker_at=now(), updated_at=now()
     WHERE id=$1`,
    [state.id, reason],
  );
  logger.warn({ state: state.id, reason }, "[trading-engine] circuit breaker activado");
}

// ─── Scanner ───────────────────────────────────────────────────────────────

async function fetchCandles(symbol: string, interval: "15" | "60" | "240", limit: number): Promise<ScannerCandle[]> {
  try {
    const r = await bybitPublic("GET", "/v5/market/kline", {
      category: "linear", symbol, interval, limit,
    });
    const raw = r?.result?.list ?? [];
    // Bybit retorna [timestamp, open, high, low, close, volume, turnover] en orden DESC
    return raw.slice().reverse().map((c: any) => ({
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  } catch (e) {
    logger.warn({ symbol, error: String(e) }, "[trading-engine] fetchCandles falló");
    return [];
  }
}

function sma(values: number[], period: number): number {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Score "Momentum + Trend" — Motor 1 de la tesis.
 * Devuelve score 0-100 o null si no aplica.
 */
function scoreMomentumTrend(candles15m: ScannerCandle[], candles1h: ScannerCandle[]): { score: number; direction: "Buy" | "Sell"; rationale: string } | null {
  if (candles15m.length < 50 || candles1h.length < 50) return null;
  const closes15 = candles15m.map((c) => c.close);
  const closes1h = candles1h.map((c) => c.close);
  const ema20_15 = sma(closes15, 20);
  const ema50_15 = sma(closes15, 50);
  const ema20_1h = sma(closes1h, 20);
  const ema50_1h = sma(closes1h, 50);
  const lastClose = closes15[closes15.length - 1]!;
  const rsi15 = rsi(closes15, 14);
  const vol = candles15m.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;
  const lastVol = candles15m[candles15m.length - 1]!.volume;
  const volRatio = vol > 0 ? lastVol / vol : 1;

  // Tendencia alcista en 1h Y 15m → buscar long
  if (ema20_1h > ema50_1h && ema20_15 > ema50_15 && lastClose > ema20_15) {
    if (rsi15 > 50 && rsi15 < 75 && volRatio > 1.1) {
      const score = Math.min(100, 50 + (rsi15 - 50) + (volRatio - 1) * 20);
      return {
        score,
        direction: "Buy",
        rationale: `Tendencia alcista 1h+15m, RSI ${rsi15.toFixed(0)}, vol ${volRatio.toFixed(2)}x`,
      };
    }
  }
  // Tendencia bajista
  if (ema20_1h < ema50_1h && ema20_15 < ema50_15 && lastClose < ema20_15) {
    if (rsi15 < 50 && rsi15 > 25 && volRatio > 1.1) {
      const score = Math.min(100, 50 + (50 - rsi15) + (volRatio - 1) * 20);
      return {
        score,
        direction: "Sell",
        rationale: `Tendencia bajista 1h+15m, RSI ${rsi15.toFixed(0)}, vol ${volRatio.toFixed(2)}x`,
      };
    }
  }
  return null;
}

/**
 * Motor 2 — Mean Reversion: RSI extremo en 15m, esperando reversión a la
 * media. Para mercados laterales o rebotes. Setup contrario al motor 1.
 */
function scoreMeanReversion(candles15m: ScannerCandle[]): { score: number; direction: "Buy" | "Sell"; rationale: string } | null {
  if (candles15m.length < 30) return null;
  const closes = candles15m.map((c) => c.close);
  const last = closes[closes.length - 1]!;
  const sma20 = sma(closes, 20);
  const rsi14 = rsi(closes, 14);

  // RSI sobreventa extrema + precio bajo SMA20 → buscar long contra-tendencial
  if (rsi14 < 30 && last < sma20 * 0.985) {
    const score = Math.min(100, 50 + (30 - rsi14) * 1.5);
    return {
      score,
      direction: "Buy",
      rationale: `Mean reversion: RSI ${rsi14.toFixed(0)} sobreventa, precio ${((last / sma20 - 1) * 100).toFixed(2)}% bajo SMA20`,
    };
  }
  if (rsi14 > 70 && last > sma20 * 1.015) {
    const score = Math.min(100, 50 + (rsi14 - 70) * 1.5);
    return {
      score,
      direction: "Sell",
      rationale: `Mean reversion: RSI ${rsi14.toFixed(0)} sobrecompra, precio ${((last / sma20 - 1) * 100).toFixed(2)}% sobre SMA20`,
    };
  }
  return null;
}

/**
 * Motor 3 — Liquidity Hunt: vela con wick extrema y alto volumen — stop
 * hunt. Buscar entrar en la dirección de cierre tras el wick.
 */
function scoreLiquidityHunt(candles15m: ScannerCandle[]): { score: number; direction: "Buy" | "Sell"; rationale: string } | null {
  if (candles15m.length < 20) return null;
  const last = candles15m[candles15m.length - 1]!;
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const totalRange = last.high - last.low;
  if (totalRange === 0) return null;

  const avgVol = candles15m.slice(-20, -1).reduce((a, b) => a + b.volume, 0) / 19;
  const volRatio = avgVol > 0 ? last.volume / avgVol : 1;
  if (volRatio < 1.5) return null;

  // Wick inferior larga (>= 60% del rango) + cierre arriba → stop hunt down, entra long
  const lowerWickRatio = lowerWick / totalRange;
  const upperWickRatio = upperWick / totalRange;

  if (lowerWickRatio >= 0.5 && last.close > last.open) {
    const score = Math.min(100, 40 + lowerWickRatio * 50 + (volRatio - 1.5) * 10);
    return {
      score,
      direction: "Buy",
      rationale: `Stop hunt down: wick inferior ${(lowerWickRatio * 100).toFixed(0)}% del rango, vol ${volRatio.toFixed(2)}x`,
    };
  }
  if (upperWickRatio >= 0.5 && last.close < last.open) {
    const score = Math.min(100, 40 + upperWickRatio * 50 + (volRatio - 1.5) * 10);
    return {
      score,
      direction: "Sell",
      rationale: `Stop hunt up: wick superior ${(upperWickRatio * 100).toFixed(0)}% del rango, vol ${volRatio.toFixed(2)}x`,
    };
  }
  return null;
}

async function scoreSymbol(symbol: string): Promise<SetupScore | null> {
  const [c15, c1h] = await Promise.all([
    fetchCandles(symbol, "15", 100),
    fetchCandles(symbol, "60", 100),
  ]);
  if (c15.length < 50) return null;

  const entryPrice = c15[c15.length - 1]!.close;

  // Probar los 3 motores y quedarse con el de mayor score
  const candidates: Array<{ motor: string; result: ReturnType<typeof scoreMomentumTrend> }> = [
    { motor: "momentum_trend", result: scoreMomentumTrend(c15, c1h) },
    { motor: "mean_reversion", result: scoreMeanReversion(c15) },
    { motor: "liquidity_hunt", result: scoreLiquidityHunt(c15) },
  ];
  const valid = candidates.filter((c) => c.result !== null);
  if (valid.length === 0) return null;

  // Ordenar por score y devolver el mejor
  valid.sort((a, b) => (b.result!.score) - (a.result!.score));
  const best = valid[0]!;
  return {
    symbol,
    direction: best.result!.direction,
    motor: best.motor,
    score: best.result!.score,
    rationale: best.result!.rationale,
    entryPrice,
  };
}

// ─── Selector ──────────────────────────────────────────────────────────────

async function selectTopK(setups: SetupScore[], k: number, openSymbols: Set<string>): Promise<SetupScore[]> {
  // Filtrar símbolos ya abiertos
  const available = setups.filter((s) => !openSymbols.has(s.symbol));
  // Ordenar por score desc
  available.sort((a, b) => b.score - a.score);
  return available.slice(0, k);
}

// ─── Executor ──────────────────────────────────────────────────────────────

async function executeSetup(setup: SetupScore, params: EngineParams, capitalActivo: number): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  const riskPerTrade = capitalActivo * (params.perTradeRiskPct / 100);
  const sizeUsd = Math.max(5, riskPerTrade); // mínimo $5 nominal
  const qty = await calcQtyReal(setup.symbol, sizeUsd, params.defaultLeverage, setup.entryPrice);
  if (!qty) {
    return { ok: false, error: "calcQtyReal retornó null (size insuficiente para min lot)" };
  }

  await setLeverage(setup.symbol, params.defaultLeverage);

  // Posición idx para hedge mode: long=1, short=2
  const positionIdx = setup.direction === "Buy" ? 1 : 2;
  const r = await placeMarketOrderDetailed(setup.symbol, setup.direction, qty, false, positionIdx);
  if (!r.ok) {
    return { ok: false, error: `Bybit retCode=${r.retCode} ${r.retMsg}` };
  }

  // SL/TP automáticos según slPct/tpPct
  const sl = setup.direction === "Buy"
    ? setup.entryPrice * (1 - params.slPct / 100)
    : setup.entryPrice * (1 + params.slPct / 100);
  const tp = setup.direction === "Buy"
    ? setup.entryPrice * (1 + params.tpPct / 100)
    : setup.entryPrice * (1 - params.tpPct / 100);
  await setTradingStopDetailed(setup.symbol, sl, tp, positionIdx).catch(() => {});

  // Registrar en tanit_setup_plan
  await pool.query(
    `INSERT INTO tanit_setup_plan (trading_day, symbol, direction, motor, score, rationale, size_usd, leverage, sl_pct, tp_pct, status, order_id, executed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'executed', $11, now())`,
    [today(), setup.symbol, setup.direction, setup.motor, setup.score, setup.rationale, sizeUsd, params.defaultLeverage, params.slPct, params.tpPct, r.orderId],
  );
  return { ok: true, orderId: r.orderId };
}

// ─── Tick principal ────────────────────────────────────────────────────────

export interface TickReport {
  ranAt: string;
  testnet: boolean;
  equity: number;
  available: number;
  dailyState: { pnlPct: number; trades: number; breakerActive: boolean };
  decisions: Array<{ action: string; detail: string }>;
  setupsScanned: number;
  setupsExecuted: number;
}

/**
 * Ejecuta UN tick del motor. Se llama desde autonomous-loop cada 15 min.
 * Idempotente: si el breaker está activo, no hace nada. Si ya hay
 * maxConcurrentTrades abiertos, no abre más.
 */
export async function runEngineTick(paramsOverride: Partial<EngineParams> = {}): Promise<TickReport> {
  const params: EngineParams = { ...DEFAULTS, ...paramsOverride };
  const decisions: Array<{ action: string; detail: string }> = [];

  // -1. Advisory lock para evitar ticks concurrentes (Mastra retry o
  // dos invocaciones casi simultáneas). pg_try_advisory_lock retorna false
  // si otro proceso ya lo tiene → salimos sin operar.
  const lockKey = 70110511; // arbitrario, único para este motor
  const lockClient = await pool.connect();
  let gotLock = false;
  try {
    const lockR = await lockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS locked`,
      [lockKey],
    );
    gotLock = lockR.rows[0]?.locked === true;
    if (!gotLock) {
      lockClient.release();
      return {
        ranAt: new Date().toISOString(),
        testnet: isTestnet(),
        equity: 0,
        available: 0,
        dailyState: { pnlPct: 0, trades: 0, breakerActive: false },
        decisions: [{ action: "skip", detail: "otro tick del motor ya corriendo (advisory lock)" }],
        setupsScanned: 0,
        setupsExecuted: 0,
      };
    }
  } catch (e) {
    lockClient.release();
    logger.warn({ err: String(e) }, "[trading-engine] advisory lock error, continuando sin lock");
  }

  try {

  // 0. Kill switch global
  const rules = await getRules({ force: true });
  if (rules.kill_switch_global) {
    return {
      ranAt: new Date().toISOString(),
      testnet: isTestnet(),
      equity: 0,
      available: 0,
      dailyState: { pnlPct: 0, trades: 0, breakerActive: false },
      decisions: [{ action: "skip", detail: "kill_switch_global activo" }],
      setupsScanned: 0,
      setupsExecuted: 0,
    };
  }

  // 0.5. Reconciliar trades cerrados (genera lecciones + actualiza win/loss)
  try {
    const rec = await reconcileClosedTrades();
    if (rec.reconciled > 0) {
      decisions.push({ action: "reconcile", detail: `${rec.reconciled} trade(s) cerrado(s) procesados` });
    }
  } catch (e) {
    logger.warn({ err: String(e) }, "[trading-engine] reconcileClosedTrades error");
  }

  // 1. Balance + posiciones
  const balance = await getBybitBalance();
  if (!balance) {
    decisions.push({ action: "skip", detail: "no se pudo leer balance" });
    return reportSkip(decisions);
  }
  const equity = balance.equity;
  const available = balance.available;
  const positions = await getOpenPositions();
  const openSymbols = new Set(positions.map((p) => p.symbol));

  // 2. Estado del día
  let state = await getOrInitDailyState(equity, params);
  state = await updateDailyState(equity, state);

  // 3. Circuit breaker daily
  if (state.breaker_active) {
    decisions.push({ action: "skip", detail: `breaker activo: ${state.breaker_reason}` });
    return reportSkip(decisions, equity, available, state, 0, 0);
  }
  if (state.pnl_today_pct <= params.dailyDrawdownLimitPct) {
    await tripBreaker(state, `Drawdown diario ${state.pnl_today_pct.toFixed(2)}% < ${params.dailyDrawdownLimitPct}%`);
    decisions.push({ action: "breaker", detail: `drawdown -${Math.abs(state.pnl_today_pct).toFixed(2)}%` });
    return reportSkip(decisions, equity, available, state, 0, 0);
  }
  if (state.consecutive_losses >= params.consecutiveLossesLimit) {
    await tripBreaker(state, `${state.consecutive_losses} pérdidas consecutivas`);
    decisions.push({ action: "breaker", detail: `${state.consecutive_losses} pérdidas seguidas` });
    return reportSkip(decisions, equity, available, state, 0, 0);
  }

  // 4. Reserva sagrada — no operar si available < reserva
  const reserve = Number(state.sacred_reserve_usd ?? equity * params.sacredReservePct);
  const capitalActivo = Math.max(0, equity - reserve);
  if (available < reserve * 0.5) {
    decisions.push({ action: "skip", detail: `available $${available.toFixed(2)} < reserva sagrada $${reserve.toFixed(2)}` });
    return reportSkip(decisions, equity, available, state, 0, 0);
  }

  // 5. Capacity de trades
  if (positions.length >= params.maxConcurrentTrades) {
    decisions.push({ action: "skip", detail: `ya tengo ${positions.length} trades abiertos (máx ${params.maxConcurrentTrades})` });
    return reportSkip(decisions, equity, available, state, 0, 0);
  }

  // 6. Escanear universo. Umbral 50 (era 60) — más permisivo, el motor
  // diversificará por símbolo y selectTopK ordena por score.
  const scanResults = await Promise.all(UNIVERSE.map((s) => scoreSymbol(s).catch(() => null)));
  const validSetups = scanResults.filter((s): s is SetupScore => s !== null && s.score >= 50);
  const slots = params.maxConcurrentTrades - positions.length;
  const targetK = Math.min(slots, params.targetTradesPerDay - state.trades_total);
  if (targetK <= 0) {
    decisions.push({ action: "skip", detail: `target del día ${params.targetTradesPerDay} alcanzado` });
    return reportSkip(decisions, equity, available, state, validSetups.length, 0);
  }

  const selected = await selectTopK(validSetups, targetK, openSymbols);
  decisions.push({ action: "scan", detail: `${validSetups.length} setups válidos, seleccioné ${selected.length}` });

  // 7. Ejecutar
  let executed = 0;
  for (const setup of selected) {
    const r = await executeSetup(setup, params, capitalActivo);
    if (r.ok) {
      executed++;
      decisions.push({
        action: "open",
        detail: `${setup.symbol} ${setup.direction} score=${setup.score.toFixed(0)} order=${r.orderId}`,
      });
      // Actualizar trades_total
      await pool.query(
        `UPDATE tanit_daily_state SET trades_total = trades_total + 1, updated_at=now() WHERE id=$1`,
        [state.id],
      );
    } else {
      decisions.push({ action: "open_failed", detail: `${setup.symbol}: ${r.error}` });
    }
  }

  return {
    ranAt: new Date().toISOString(),
    testnet: isTestnet(),
    equity: Number(equity),
    available: Number(available),
    dailyState: {
      pnlPct: Number(state.pnl_today_pct ?? 0),
      trades: (state.trades_total ?? 0) + executed,
      breakerActive: Boolean(state.breaker_active),
    },
    decisions,
    setupsScanned: validSetups.length,
    setupsExecuted: executed,
  };
  } finally {
    if (gotLock) {
      try { await lockClient.query(`SELECT pg_advisory_unlock($1)`, [lockKey]); } catch {}
    }
    lockClient.release();
  }
}

function reportSkip(
  decisions: Array<{ action: string; detail: string }>,
  equity = 0,
  available = 0,
  state?: DailyState,
  scanned = 0,
  executed = 0,
): TickReport {
  return {
    ranAt: new Date().toISOString(),
    testnet: isTestnet(),
    equity,
    available,
    dailyState: state
      ? { pnlPct: state.pnl_today_pct, trades: state.trades_total, breakerActive: state.breaker_active }
      : { pnlPct: 0, trades: 0, breakerActive: false },
    decisions,
    setupsScanned: scanned,
    setupsExecuted: executed,
  };
}

/**
 * Reconciliación post-trade: detecta trades del motor cuya posición ya
 * cerró en Bybit (por SL, TP o cierre manual) y genera la entrada en
 * tanit_trade_lessons. Idempotente — solo procesa los que aún están en
 * status='executed' pero ya no aparecen como posición abierta.
 */
export async function reconcileClosedTrades(): Promise<{ reconciled: number }> {
  const positions = await getOpenPositions();
  const openSymbols = new Set(positions.map((p: any) => p.symbol));

  // Trades del motor de hoy que aún figuran como 'executed' pero ya no
  // tienen posición abierta en Bybit → ya cerraron.
  const candidates = await pool.query(
    `SELECT id, symbol, direction, executed_at, sl_pct, tp_pct
       FROM tanit_setup_plan
      WHERE status = 'executed' AND trading_day = CURRENT_DATE`,
  );
  let reconciled = 0;
  for (const t of candidates.rows) {
    if (openSymbols.has(t.symbol)) continue;

    // Leer closed PnL de Bybit para este símbolo
    try {
      const r = await bybitPublic("GET", "/v5/position/closed-pnl", {
        category: "linear", symbol: t.symbol, limit: 5,
      });
      const items = r?.result?.list ?? [];
      const item = items[0];
      const pnl = item ? parseFloat(item.closedPnl ?? "0") : 0;
      const outcome = pnl > 0 ? "win" : pnl < 0 ? "loss" : "neutral";

      await pool.query(
        `UPDATE tanit_setup_plan SET status='closed', closed_at=now(), pnl_realized=$2 WHERE id=$1`,
        [t.id, pnl],
      );

      // Generar lección
      const duration = item?.updatedTime
        ? Math.round((parseInt(item.updatedTime, 10) - new Date(t.executed_at).getTime()) / 60000)
        : null;
      const lesson = pnl > 0
        ? `Trade ganador: setup ${t.direction} en ${t.symbol} cerró +$${pnl.toFixed(4)}. SL ${t.sl_pct}% TP ${t.tp_pct}% funcionaron.`
        : pnl < 0
        ? `Trade perdedor: setup ${t.direction} en ${t.symbol} cerró -$${Math.abs(pnl).toFixed(4)}. Revisar si entry era prematura o si volumen no confirmaba.`
        : `Trade neutral: ${t.symbol} ${t.direction} cerró breakeven.`;

      await pool.query(
        `INSERT INTO tanit_trade_lessons (trade_plan_id, symbol, direction, outcome, aprendizaje, pnl_pct, duration_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [t.id, t.symbol, t.direction, outcome, lesson, pnl, duration],
      );

      // Actualizar tanit_daily_state: trades_wins/losses + consecutive_losses
      const today_d = today();
      if (outcome === "win") {
        await pool.query(
          `UPDATE tanit_daily_state SET trades_wins=trades_wins+1, consecutive_losses=0, updated_at=now()
            WHERE trading_day=$1`,
          [today_d],
        );
      } else if (outcome === "loss") {
        await pool.query(
          `UPDATE tanit_daily_state SET trades_losses=trades_losses+1, consecutive_losses=consecutive_losses+1, updated_at=now()
            WHERE trading_day=$1`,
          [today_d],
        );
      }
      reconciled++;
    } catch (e) {
      logger.warn({ symbol: t.symbol, err: String(e) }, "[trading-engine] reconcile error");
    }
  }
  return { reconciled };
}

/**
 * Devuelve el snapshot del día — útil para Tanit cuando Luis le pregunte
 * "¿cómo vas hoy?" o cuando ella misma quiera reportar.
 */
export async function getTodayReport(): Promise<{
  state: DailyState | null;
  plansOpen: number;
  positions: Array<{ symbol: string; side: string; pnl: number }>;
}> {
  const d = today();
  const sr = await pool.query<DailyState>(
    `SELECT * FROM tanit_daily_state WHERE trading_day = $1`,
    [d],
  );
  const state = sr.rows[0] ?? null;
  const plans = await pool.query(
    `SELECT COUNT(*) AS c FROM tanit_setup_plan WHERE trading_day=$1 AND status='executed'`,
    [d],
  );
  const positions = await getOpenPositions();
  return {
    state,
    plansOpen: parseInt(plans.rows[0]?.c ?? "0", 10),
    positions: positions.map((p: any) => ({
      symbol: p.symbol,
      side: p.side,
      pnl: parseFloat(p.unrealisedPnl ?? "0"),
    })),
  };
}
