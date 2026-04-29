/**
 * db-persistence.ts
 * Capa de persistencia PostgreSQL para el motor de trading.
 * Reemplaza el archivo .sandbox-state.json con almacenamiento real.
 */

import { pool } from "@workspace/db";

const TAG = "[db]";

// ── Estado global del bot ────────────────────────────────────────────────────

export async function saveStateToDB(stateData: Record<string, unknown>): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO bot_state (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      ["main", JSON.stringify(stateData)]
    );
  } catch (e) {
    console.error(TAG, "saveStateToDB error:", e);
  }
}

export async function loadStateFromDB(): Promise<Record<string, unknown> | null> {
  try {
    const r = await pool.query(`SELECT value FROM bot_state WHERE key = $1`, ["main"]);
    return r.rows[0]?.value ?? null;
  } catch (e) {
    console.error(TAG, "loadStateFromDB error:", e);
    return null;
  }
}

// ── Trades ───────────────────────────────────────────────────────────────────

export async function saveOpenTradeToDB(trade: {
  symbol: string; direction: string; entryPrice: number; size: number;
  leverage: number; stopLoss: number; takeProfit: number;
  openedAt: string; sessionNum?: number; dailyRegime?: string;
}): Promise<number | null> {
  try {
    const r = await pool.query(
      `INSERT INTO trades
         (symbol, direction, entry_price, size, leverage, stop_loss, take_profit,
          open_at, session_num, daily_regime, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open')
       RETURNING id`,
      [
        trade.symbol, trade.direction, trade.entryPrice, trade.size,
        trade.leverage, trade.stopLoss, trade.takeProfit,
        new Date(trade.openedAt), trade.sessionNum ?? null, trade.dailyRegime ?? null,
      ]
    );
    return r.rows[0]?.id ?? null;
  } catch (e) {
    console.error(TAG, "saveOpenTradeToDB error:", e);
    return null;
  }
}

export async function closeTradeInDB(params: {
  dbId: number; exitPrice: number; pnl: number; holdMinutes?: number;
}): Promise<void> {
  try {
    await pool.query(
      `UPDATE trades
       SET exit_price = $1, pnl = $2, status = $3, close_at = NOW(), hold_minutes = $4
       WHERE id = $5`,
      [
        params.exitPrice, params.pnl,
        params.pnl >= 0 ? "win" : "loss",
        params.holdMinutes ?? null, params.dbId,
      ]
    );
  } catch (e) {
    console.error(TAG, "closeTradeInDB error:", e);
  }
}

// ── Señales y resultados — base del auto-aprendizaje ─────────────────────────

export async function saveSignalOutcome(outcome: {
  tradeId?: number | null;
  symbol: string; direction: string;
  utcHour: number; cancunHour: number;
  marketSession?: string;
  totalScore: number;
  scoreTrend?: number; scoreVolume?: number; scoreFib?: number;
  scoreSession?: number; scoreTimePattern?: number; scoreGemini?: number;
  outcome: "win" | "loss";
  pnl: number;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO signal_outcomes
         (trade_id, symbol, direction, utc_hour, cancun_hour, market_session,
          total_score, score_trend, score_volume, score_fib,
          score_session, score_timepattern, score_gemini, outcome, pnl)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        outcome.tradeId ?? null,
        outcome.symbol, outcome.direction,
        outcome.utcHour, outcome.cancunHour,
        outcome.marketSession ?? null,
        outcome.totalScore,
        outcome.scoreTrend ?? null, outcome.scoreVolume ?? null,
        outcome.scoreFib ?? null, outcome.scoreSession ?? null,
        outcome.scoreTimePattern ?? null, outcome.scoreGemini ?? null,
        outcome.outcome, outcome.pnl,
      ]
    );
  } catch (e) {
    console.error(TAG, "saveSignalOutcome error:", e);
  }
}

// ── Sesiones ─────────────────────────────────────────────────────────────────

export async function saveSessionToDB(session: {
  number: number; trades: number; wins: number; losses: number;
  pnl: number; durationMin: number; startedAt?: Date;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO sessions (number, trades, wins, losses, pnl, duration_min, started_at, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
       ON CONFLICT DO NOTHING`,
      [
        session.number, session.trades, session.wins, session.losses,
        session.pnl, session.durationMin,
        session.startedAt ?? new Date(),
      ]
    );
  } catch (e) {
    console.error(TAG, "saveSessionToDB error:", e);
  }
}

// ── Aprendizaje adaptativo — analiza resultados para optimizar parámetros ──

export async function getAdaptiveThreshold(): Promise<{
  optimalThreshold: number;
  winRateByScoreBucket: { bucket: string; minScore: number; maxScore: number; winRate: number; avgPnl: number; count: number }[];
  bestHours: number[];
  worstHours: number[];
  bestSymbols: string[];
  worstSymbols: string[];
  totalSamples: number;
  confidence: number;
}> {
  const defaults = {
    optimalThreshold: 78,
    winRateByScoreBucket: [],
    bestHours: [],
    worstHours: [],
    bestSymbols: [],
    worstSymbols: [],
    totalSamples: 0,
    confidence: 0,
  };
  try {
    const [buckets, hours, symbols, total] = await Promise.all([
      pool.query(`
        SELECT
          CASE
            WHEN total_score >= 90 THEN '90-100'
            WHEN total_score >= 85 THEN '85-89'
            WHEN total_score >= 80 THEN '80-84'
            WHEN total_score >= 75 THEN '75-79'
            WHEN total_score >= 70 THEN '70-74'
            ELSE '60-69'
          END as bucket,
          MIN(total_score) as min_score,
          MAX(total_score) as max_score,
          COUNT(*) as count,
          SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) * 100 as win_rate,
          AVG(pnl) as avg_pnl
        FROM signal_outcomes
        WHERE total_score > 0
        GROUP BY bucket ORDER BY min_score DESC
      `),
      pool.query(`
        SELECT cancun_hour,
               COUNT(*) as count,
               SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) * 100 as win_rate,
               AVG(pnl) as avg_pnl
        FROM signal_outcomes
        GROUP BY cancun_hour
        HAVING COUNT(*) >= 3
        ORDER BY win_rate DESC
      `),
      pool.query(`
        SELECT symbol,
               COUNT(*) as count,
               SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) * 100 as win_rate,
               AVG(pnl) as avg_pnl
        FROM signal_outcomes
        GROUP BY symbol
        HAVING COUNT(*) >= 3
        ORDER BY win_rate DESC
      `),
      pool.query(`SELECT COUNT(*) as total FROM signal_outcomes`),
    ]);

    const totalSamples = parseInt(total.rows[0]?.total ?? "0");
    const confidence = Math.min(1, totalSamples / 50);

    const winRateByScoreBucket = buckets.rows.map(r => ({
      bucket: r.bucket,
      minScore: parseInt(r.min_score),
      maxScore: parseInt(r.max_score),
      winRate: parseFloat(parseFloat(r.win_rate ?? "0").toFixed(1)),
      avgPnl: parseFloat(parseFloat(r.avg_pnl ?? "0").toFixed(4)),
      count: parseInt(r.count),
    }));

    let optimalThreshold = 78;
    for (const b of winRateByScoreBucket) {
      if (b.count >= 5 && b.winRate >= 55 && b.avgPnl > 0) {
        optimalThreshold = Math.min(optimalThreshold, b.minScore);
      }
    }
    optimalThreshold = Math.max(70, Math.min(88, optimalThreshold));

    const hourRows = hours.rows;
    const bestHours = hourRows.filter((r: any) => parseFloat(r.win_rate) >= 60).map((r: any) => r.cancun_hour);
    const worstHours = hourRows.filter((r: any) => parseFloat(r.win_rate) < 40).map((r: any) => r.cancun_hour);

    const symRows = symbols.rows;
    const bestSymbols = symRows.filter((r: any) => parseFloat(r.win_rate) >= 55).map((r: any) => r.symbol);
    const worstSymbols = symRows.filter((r: any) => parseFloat(r.win_rate) < 40).map((r: any) => r.symbol);

    return {
      optimalThreshold: confidence >= 0.5 ? optimalThreshold : 78,
      winRateByScoreBucket,
      bestHours,
      worstHours,
      bestSymbols,
      worstSymbols,
      totalSamples,
      confidence,
    };
  } catch (e) {
    console.error(TAG, "getAdaptiveThreshold error:", e);
    return defaults;
  }
}

// ── Tanit Evolution System — auto-reprogramación ────────────────────────────

export async function initTanitEvolutionTables(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tanit_runtime_config (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        reason      TEXT,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tanit_evolutions (
        id          SERIAL PRIMARY KEY,
        param       TEXT NOT NULL,
        old_value   TEXT,
        new_value   TEXT NOT NULL,
        reason      TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) {
    console.error(TAG, "initTanitEvolutionTables error:", e);
  }
}

export async function saveTanitRuntimeConfig(key: string, value: string, reason: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO tanit_runtime_config (key, value, reason, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$2, reason=$3, updated_at=NOW()`,
      [key, value, reason]
    );
  } catch (e) {
    console.error(TAG, "saveTanitRuntimeConfig error:", e);
  }
}

export async function loadTanitRuntimeConfig(): Promise<Record<string, string>> {
  try {
    const r = await pool.query(`SELECT key, value FROM tanit_runtime_config`);
    return Object.fromEntries(r.rows.map((row: any) => [row.key, row.value]));
  } catch { return {}; }
}

export async function saveTanitEvolution(ev: {
  param: string; oldValue: string | null; newValue: string; reason: string;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO tanit_evolutions (param, old_value, new_value, reason) VALUES ($1,$2,$3,$4)`,
      [ev.param, ev.oldValue ?? null, ev.newValue, ev.reason]
    );
  } catch (e) {
    console.error(TAG, "saveTanitEvolution error:", e);
  }
}

export async function loadTanitEvolutions(limit = 20): Promise<{
  param: string; oldValue: string | null; newValue: string; reason: string; createdAt: string;
}[]> {
  try {
    const r = await pool.query(
      `SELECT param, old_value, new_value, reason, created_at FROM tanit_evolutions
       ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return r.rows.map((row: any) => ({
      param: row.param, oldValue: row.old_value, newValue: row.new_value,
      reason: row.reason, createdAt: row.created_at,
    }));
  } catch { return []; }
}

export async function getTanitPerformanceBySymbol(): Promise<{
  symbol: string; wins: number; losses: number; winRate: number; netPnl: number; avgPnl: number; count: number;
}[]> {
  try {
    const r = await pool.query(`
      SELECT symbol,
             COUNT(*) as count,
             SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
             SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
             SUM(pnl) as net_pnl,
             AVG(pnl) as avg_pnl
      FROM trades
      WHERE status IN ('win','loss') AND pnl IS NOT NULL
      GROUP BY symbol
      ORDER BY net_pnl DESC
    `);
    return r.rows.map((row: any) => ({
      symbol:  row.symbol,
      wins:    parseInt(row.wins),
      losses:  parseInt(row.losses),
      count:   parseInt(row.count),
      winRate: parseInt(row.count) > 0 ? parseFloat((parseInt(row.wins) / parseInt(row.count) * 100).toFixed(1)) : 0,
      netPnl:  parseFloat(parseFloat(row.net_pnl).toFixed(4)),
      avgPnl:  parseFloat(parseFloat(row.avg_pnl).toFixed(4)),
    }));
  } catch { return []; }
}

// ── Tanit Trade Context — memoria causal de cada entrada ─────────────────────

export async function initTanitContextTable(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tanit_trade_context (
        id             SERIAL PRIMARY KEY,
        trade_id       INTEGER,
        symbol         TEXT NOT NULL,
        direction      TEXT NOT NULL,
        raw_score      NUMERIC(10,4),
        news_bonus     NUMERIC(10,4),
        pattern_type   TEXT,
        pattern_bonus  NUMERIC(10,4),
        pattern_conf   NUMERIC(10,4),
        macro_danger   BOOLEAN DEFAULT FALSE,
        final_score    NUMERIC(10,4),
        confidence     NUMERIC(10,4),
        outcome        TEXT,
        pnl            NUMERIC(20,8),
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) {
    console.error(TAG, "initTanitContextTable error:", e);
  }
}

export async function saveTradeContext(ctx: {
  tradeId?: number | null;
  symbol: string;
  direction: string;
  rawScore: number;
  newsBonus: number;
  patternType: string;
  patternBonus: number;
  patternConf: number;
  macroDanger: boolean;
  finalScore: number;
  confidence: number;
}): Promise<number | null> {
  try {
    const r = await pool.query(
      `INSERT INTO tanit_trade_context
         (trade_id, symbol, direction, raw_score, news_bonus, pattern_type, pattern_bonus,
          pattern_conf, macro_danger, final_score, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        ctx.tradeId ?? null, ctx.symbol, ctx.direction, ctx.rawScore,
        ctx.newsBonus, ctx.patternType, ctx.patternBonus,
        ctx.patternConf, ctx.macroDanger, ctx.finalScore, ctx.confidence,
      ]
    );
    return r.rows[0]?.id ?? null;
  } catch (e) {
    console.error(TAG, "saveTradeContext error:", e);
    return null;
  }
}

/**
 * Cierra el contexto del trade más reciente para ese símbolo+dirección sin outcome.
 * Usa subquery para compatibilidad con PostgreSQL (no soporta UPDATE...LIMIT directo).
 */
export async function closeTradeContext(symbol: string, direction: string, outcome: "win" | "loss", pnl: number): Promise<void> {
  try {
    await pool.query(
      `UPDATE tanit_trade_context
       SET outcome=$1, pnl=$2
       WHERE id = (
         SELECT id FROM tanit_trade_context
         WHERE symbol=$3 AND direction=$4 AND outcome IS NULL
         ORDER BY created_at DESC
         LIMIT 1
       )`,
      [outcome, pnl, symbol, direction]
    );
  } catch {}
}

/**
 * Busca en los últimos 200 contextos cerrados situaciones similares (mismo rango de score ±5).
 * Retorna win rate y n para incluir en el razonamiento causal de Tanit.
 */
export async function getSimilarContextWinRate(rawScore: number, direction: string): Promise<{
  winRate: number; count: number; avgPnl: number;
}> {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) as wins,
        AVG(pnl) as avg_pnl
      FROM (
        SELECT outcome, pnl
        FROM tanit_trade_context
        WHERE outcome IS NOT NULL
          AND direction = $1
          AND raw_score BETWEEN $2 AND $3
        ORDER BY created_at DESC
        LIMIT 200
      ) sub
    `, [direction, rawScore - 5, rawScore + 5]);
    const row = r.rows[0];
    const total = parseInt(row?.total ?? "0") || 0;
    const wins  = parseInt(row?.wins ?? "0") || 0;
    const avgPnl = parseFloat(row?.avg_pnl ?? "0") || 0;
    if (total === 0) return { winRate: 50, count: 0, avgPnl: 0 };
    return { winRate: Math.round((wins / total) * 100), count: total, avgPnl };
  } catch {
    return { winRate: 50, count: 0, avgPnl: 0 };
  }
}

export interface CalibrationWeights {
  news:       { winRate: number; count: number; weight: number };
  breakout:   { winRate: number; count: number; weight: number };
  rsiDiv:     { winRate: number; count: number; weight: number };
  flag:       { winRate: number; count: number; weight: number };
  totalTrades: number;
}

const DEFAULT_WEIGHTS: CalibrationWeights = {
  news:     { winRate: 50, count: 0, weight: 1.0 },
  breakout: { winRate: 50, count: 0, weight: 1.0 },
  rsiDiv:   { winRate: 50, count: 0, weight: 1.0 },
  flag:     { winRate: 50, count: 0, weight: 1.0 },
  totalTrades: 0,
};

let _calWeightsCache: { data: CalibrationWeights; cachedAt: number } | null = null;
const CAL_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

/**
 * Calcula pesos de calibración a partir de los ÚLTIMOS 50 trades cerrados con contexto causal.
 * No agrupa por categoría en la query — extrae los 50 más recientes y los clasifica en memoria.
 */
export async function getCalibrationWeights(): Promise<CalibrationWeights> {
  if (_calWeightsCache && Date.now() - _calWeightsCache.cachedAt < CAL_CACHE_TTL) {
    return _calWeightsCache.data;
  }
  try {
    // Obtener los últimos 50 trades cerrados cronológicamente
    const r = await pool.query(`
      SELECT outcome, news_bonus, pattern_type, pnl
      FROM tanit_trade_context
      WHERE outcome IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 50
    `);

    let newsTotalW = 0, newsWinsW = 0;
    let breakoutWins = 0, breakoutTotal = 0;
    let rsiWins = 0, rsiTotal = 0;
    let flagWins = 0, flagTotal = 0;

    for (const row of r.rows) {
      const won = row.outcome === "win";
      const nb  = parseFloat(row.news_bonus ?? "0") || 0;
      const pt  = (row.pattern_type ?? "NONE").toUpperCase();

      // Noticias: contar solo trades donde news_bonus fue relevante (|bonus| > 3)
      if (Math.abs(nb) > 3) {
        newsTotalW++;
        if (won) newsWinsW++;
      }

      if (pt.includes("BREAKOUT"))      { breakoutTotal++; if (won) breakoutWins++; }
      else if (pt.includes("RSI"))      { rsiTotal++;  if (won) rsiWins++; }
      else if (pt.includes("FLAG"))     { flagTotal++; if (won) flagWins++; }
    }

    const wr = (wins: number, total: number) => total >= 5 ? (wins / total) * 100 : 50;
    const wt = (winRate: number) => Math.max(0.5, Math.min(1.5, winRate / 50));

    const result: CalibrationWeights = {
      news:     { winRate: wr(newsWinsW, newsTotalW), count: newsTotalW, weight: wt(wr(newsWinsW, newsTotalW)) },
      breakout: { winRate: wr(breakoutWins, breakoutTotal), count: breakoutTotal, weight: wt(wr(breakoutWins, breakoutTotal)) },
      rsiDiv:   { winRate: wr(rsiWins, rsiTotal), count: rsiTotal, weight: wt(wr(rsiWins, rsiTotal)) },
      flag:     { winRate: wr(flagWins, flagTotal), count: flagTotal, weight: wt(wr(flagWins, flagTotal)) },
      totalTrades: r.rows.length,
    };

    _calWeightsCache = { data: result, cachedAt: Date.now() };
    return result;
  } catch {
    return DEFAULT_WEIGHTS;
  }
}

export async function getLearningStats(): Promise<{
  byHour: { cancunHour: number; winRate: number; avgPnl: number; count: number }[];
  bySession: { session: string; winRate: number; avgPnl: number; count: number }[];
  bySymbol: { symbol: string; winRate: number; avgPnl: number; count: number }[];
  totalTrades: number; totalWins: number; overallWinRate: number;
}> {
  const zero = { byHour: [], bySession: [], bySymbol: [], totalTrades: 0, totalWins: 0, overallWinRate: 0 };
  try {
    const [byHour, bySession, bySymbol, totals] = await Promise.all([
      pool.query(`
        SELECT cancun_hour, COUNT(*) as count,
               SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as win_rate,
               AVG(pnl) as avg_pnl
        FROM signal_outcomes GROUP BY cancun_hour ORDER BY cancun_hour
      `),
      pool.query(`
        SELECT market_session as session, COUNT(*) as count,
               SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as win_rate,
               AVG(pnl) as avg_pnl
        FROM signal_outcomes WHERE market_session IS NOT NULL
        GROUP BY market_session ORDER BY win_rate DESC
      `),
      pool.query(`
        SELECT symbol, COUNT(*) as count,
               SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as win_rate,
               AVG(pnl) as avg_pnl
        FROM signal_outcomes GROUP BY symbol ORDER BY win_rate DESC
      `),
      pool.query(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) as wins
        FROM signal_outcomes
      `),
    ]);

    const total  = parseInt(totals.rows[0]?.total ?? "0");
    const wins   = parseInt(totals.rows[0]?.wins  ?? "0");

    return {
      byHour:   byHour.rows.map(r => ({
        cancunHour: r.cancun_hour, winRate: parseFloat(parseFloat(r.win_rate).toFixed(1)),
        avgPnl: parseFloat(parseFloat(r.avg_pnl).toFixed(4)), count: parseInt(r.count),
      })),
      bySession: bySession.rows.map(r => ({
        session: r.session, winRate: parseFloat(parseFloat(r.win_rate).toFixed(1)),
        avgPnl: parseFloat(parseFloat(r.avg_pnl).toFixed(4)), count: parseInt(r.count),
      })),
      bySymbol:  bySymbol.rows.map(r => ({
        symbol: r.symbol, winRate: parseFloat(parseFloat(r.win_rate).toFixed(1)),
        avgPnl: parseFloat(parseFloat(r.avg_pnl).toFixed(4)), count: parseInt(r.count),
      })),
      totalTrades: total, totalWins: wins,
      overallWinRate: total > 0 ? parseFloat((wins / total * 100).toFixed(1)) : 0,
    };
  } catch (e) {
    console.error(TAG, "getLearningStats error:", e);
    return zero;
  }
}

// ── Swap History ─────────────────────────────────────────────────────────────

export interface SwapEventRecord {
  ts: number;
  closedSymbol: string;
  closedScore: number;
  closedPnl: number;
  openedSymbol: string;
  openedScore: number;
  advantage: number;
  success: boolean;
  reason: string;
  outcomePnl?: number;
}

export async function saveSwapEventToDB(ev: SwapEventRecord): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO swap_history
         (ts, closed_symbol, closed_score, closed_pnl, opened_symbol, opened_score,
          advantage, success, reason, outcome_pnl)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        ev.ts, ev.closedSymbol, ev.closedScore, ev.closedPnl,
        ev.openedSymbol, ev.openedScore, ev.advantage, ev.success,
        ev.reason, ev.outcomePnl ?? null,
      ]
    );
  } catch (e) {
    console.error(TAG, "saveSwapEventToDB error:", e);
  }
}

export async function loadSwapHistoryFromDB(limit = 50, offset = 0): Promise<SwapEventRecord[]> {
  try {
    const r = await pool.query(
      `SELECT ts, closed_symbol, closed_score, closed_pnl, opened_symbol, opened_score,
              advantage, success, reason, outcome_pnl
       FROM swap_history
       ORDER BY ts DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return r.rows.map((row: any) => ({
      ts: parseInt(row.ts),
      closedSymbol: row.closed_symbol,
      closedScore: parseFloat(row.closed_score),
      closedPnl: parseFloat(row.closed_pnl),
      openedSymbol: row.opened_symbol,
      openedScore: parseFloat(row.opened_score),
      advantage: parseFloat(row.advantage),
      success: row.success,
      reason: row.reason,
      outcomePnl: row.outcome_pnl != null ? parseFloat(row.outcome_pnl) : undefined,
    }));
  } catch (e) {
    console.error(TAG, "loadSwapHistoryFromDB error:", e);
    return [];
  }
}

export interface SwapOutcomeStats {
  total: number;        // total swaps recorded
  withOutcome: number;  // swaps whose new position has already closed
  wins: number;         // outcome_pnl > 0
  losses: number;       // outcome_pnl < 0
  neutral: number;      // outcome_pnl == 0
  netPnl: number;       // sum of outcome_pnl across resolved swaps
  avgPnl: number;       // mean outcome_pnl across resolved swaps
  pending: number;      // successful swaps still open (outcome_pnl IS NULL)
}

/**
 * Tanit's swap outcome summary — used by auto-evolution to know whether
 * her recent swaps actually paid off. Considers only successful swaps
 * (failed ones never opened a new position so they have no outcome).
 */
export async function getSwapOutcomeStats(limit = 20): Promise<SwapOutcomeStats> {
  const zero: SwapOutcomeStats = {
    total: 0, withOutcome: 0, wins: 0, losses: 0, neutral: 0,
    netPnl: 0, avgPnl: 0, pending: 0,
  };
  try {
    const r = await pool.query(
      `SELECT outcome_pnl FROM swap_history
       WHERE success = true
       ORDER BY ts DESC
       LIMIT $1`,
      [limit]
    );
    if (r.rows.length === 0) return zero;
    let wins = 0, losses = 0, neutral = 0, withOutcome = 0, pending = 0, sum = 0;
    for (const row of r.rows) {
      if (row.outcome_pnl == null) { pending++; continue; }
      const pnl = parseFloat(row.outcome_pnl);
      if (!Number.isFinite(pnl)) continue;
      withOutcome++;
      sum += pnl;
      if (pnl > 0)      wins++;
      else if (pnl < 0) losses++;
      else              neutral++;
    }
    return {
      total: r.rows.length,
      withOutcome, wins, losses, neutral, pending,
      netPnl: parseFloat(sum.toFixed(4)),
      avgPnl: withOutcome > 0 ? parseFloat((sum / withOutcome).toFixed(4)) : 0,
    };
  } catch (e) {
    console.error(TAG, "getSwapOutcomeStats error:", e);
    return zero;
  }
}

export async function updateSwapOutcomePnl(ts: number, openedSymbol: string, outcomePnl: number): Promise<void> {
  try {
    await pool.query(
      `UPDATE swap_history SET outcome_pnl = $1
       WHERE ts = $2 AND opened_symbol = $3 AND outcome_pnl IS NULL`,
      [outcomePnl, ts, openedSymbol]
    );
  } catch (e) {
    console.error(TAG, "updateSwapOutcomePnl error:", e);
  }
}

/**
 * Prunes swap_history to prevent unbounded growth.
 * Removes records older than 90 days first, then trims to the most recent
 * MAX_SWAP_ROWS rows if the table still exceeds that limit.
 */
const MAX_SWAP_ROWS = 500;
const SWAP_RETENTION_DAYS = 90;
const RETENTION_DAYS = 90; // shared cutoff for other learning tables

export async function pruneSwapHistory(): Promise<void> {
  try {
    const cutoff = Date.now() - SWAP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const del = await pool.query(
      `DELETE FROM swap_history WHERE ts < $1`,
      [cutoff]
    );
    const deletedOld = del.rowCount ?? 0;

    const countRes = await pool.query(`SELECT COUNT(*) as total FROM swap_history`);
    const total = parseInt(countRes.rows[0]?.total ?? "0");

    let deletedExtra = 0;
    if (total > MAX_SWAP_ROWS) {
      const excess = total - MAX_SWAP_ROWS;
      const trimRes = await pool.query(
        `DELETE FROM swap_history
         WHERE id IN (
           SELECT id FROM swap_history
           ORDER BY ts ASC, id ASC
           LIMIT $1
         )`,
        [excess]
      );
      deletedExtra = trimRes.rowCount ?? 0;
    }

    if (deletedOld > 0 || deletedExtra > 0) {
      console.log(TAG, `[SWAP] Pruned swap_history: ${deletedOld} old (>${SWAP_RETENTION_DAYS}d), ${deletedExtra} excess (cap ${MAX_SWAP_ROWS}). Remaining: ${Math.max(0, total - deletedExtra)}`);
    }
  } catch (e) {
    console.error(TAG, "pruneSwapHistory error:", e);
  }
}

/**
 * Prunes signal_outcomes to prevent unbounded growth.
 * Removes records older than 90 days, then trims to the most recent 2000 rows.
 */
const MAX_SIGNAL_OUTCOMES_ROWS = 2000;

export async function pruneSignalOutcomes(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const del = await pool.query(
      `DELETE FROM signal_outcomes WHERE created_at < $1`,
      [cutoff]
    );
    const deletedOld = del.rowCount ?? 0;

    const countRes = await pool.query(`SELECT COUNT(*) as total FROM signal_outcomes`);
    const total = parseInt(countRes.rows[0]?.total ?? "0");

    let deletedExtra = 0;
    if (total > MAX_SIGNAL_OUTCOMES_ROWS) {
      const excess = total - MAX_SIGNAL_OUTCOMES_ROWS;
      const trimRes = await pool.query(
        `DELETE FROM signal_outcomes
         WHERE id IN (
           SELECT id FROM signal_outcomes
           ORDER BY created_at ASC, id ASC
           LIMIT $1
         )`,
        [excess]
      );
      deletedExtra = trimRes.rowCount ?? 0;
    }

    if (deletedOld > 0 || deletedExtra > 0) {
      console.log(TAG, `[PRUNE] signal_outcomes: ${deletedOld} old (>${RETENTION_DAYS}d), ${deletedExtra} excess (cap ${MAX_SIGNAL_OUTCOMES_ROWS}). Remaining: ${Math.max(0, total - deletedExtra)}`);
    }
  } catch (e) {
    console.error(TAG, "pruneSignalOutcomes error:", e);
  }
}

/**
 * Prunes tanit_trade_context to prevent unbounded growth.
 * Removes records older than 90 days, then trims to the most recent 1000 rows.
 */
const MAX_TANIT_CONTEXT_ROWS = 1000;

export async function pruneTanitTradeContext(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const del = await pool.query(
      `DELETE FROM tanit_trade_context WHERE created_at < $1`,
      [cutoff]
    );
    const deletedOld = del.rowCount ?? 0;

    const countRes = await pool.query(`SELECT COUNT(*) as total FROM tanit_trade_context`);
    const total = parseInt(countRes.rows[0]?.total ?? "0");

    let deletedExtra = 0;
    if (total > MAX_TANIT_CONTEXT_ROWS) {
      const excess = total - MAX_TANIT_CONTEXT_ROWS;
      const trimRes = await pool.query(
        `DELETE FROM tanit_trade_context
         WHERE id IN (
           SELECT id FROM tanit_trade_context
           ORDER BY created_at ASC, id ASC
           LIMIT $1
         )`,
        [excess]
      );
      deletedExtra = trimRes.rowCount ?? 0;
    }

    if (deletedOld > 0 || deletedExtra > 0) {
      console.log(TAG, `[PRUNE] tanit_trade_context: ${deletedOld} old (>${RETENTION_DAYS}d), ${deletedExtra} excess (cap ${MAX_TANIT_CONTEXT_ROWS}). Remaining: ${Math.max(0, total - deletedExtra)}`);
    }
  } catch (e) {
    console.error(TAG, "pruneTanitTradeContext error:", e);
  }
}

/**
 * Prunes tanit_evolutions to prevent unbounded growth.
 * Removes records older than 90 days, then trims to the most recent 500 rows.
 */
const MAX_TANIT_EVOLUTIONS_ROWS = 500;

export async function pruneTanitEvolutions(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const del = await pool.query(
      `DELETE FROM tanit_evolutions WHERE created_at < $1`,
      [cutoff]
    );
    const deletedOld = del.rowCount ?? 0;

    const countRes = await pool.query(`SELECT COUNT(*) as total FROM tanit_evolutions`);
    const total = parseInt(countRes.rows[0]?.total ?? "0");

    let deletedExtra = 0;
    if (total > MAX_TANIT_EVOLUTIONS_ROWS) {
      const excess = total - MAX_TANIT_EVOLUTIONS_ROWS;
      const trimRes = await pool.query(
        `DELETE FROM tanit_evolutions
         WHERE id IN (
           SELECT id FROM tanit_evolutions
           ORDER BY created_at ASC, id ASC
           LIMIT $1
         )`,
        [excess]
      );
      deletedExtra = trimRes.rowCount ?? 0;
    }

    if (deletedOld > 0 || deletedExtra > 0) {
      console.log(TAG, `[PRUNE] tanit_evolutions: ${deletedOld} old (>${RETENTION_DAYS}d), ${deletedExtra} excess (cap ${MAX_TANIT_EVOLUTIONS_ROWS}). Remaining: ${Math.max(0, total - deletedExtra)}`);
    }
  } catch (e) {
    console.error(TAG, "pruneTanitEvolutions error:", e);
  }
}
