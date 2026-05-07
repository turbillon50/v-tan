// PR #43 — Tesis viva. Tanit escribe, evalúa y recompone su tesis sola.
// Sin que Luis tenga que ser intermediario técnico.

import { pool } from "@workspace/db";
import { getKey } from "./api-keys-provider";

const TAG = "[thesis]";

export type AutoAuthRule = {
  // Tipo de decisión donde aplica. Si se omite, aplica a "open_layer".
  decisionType?: "open_layer" | "close_strategic";
  direction?: "LONG" | "SHORT";
  // Lista de símbolos sin "USDT" (ej: ["BTC","ETH","SOL"]) o ["*"] para todos.
  symbols?: string[];
  // Excluir explícitamente ciertos símbolos.
  symbolsExclude?: string[];
  leverageMax?: number;
  leverageMin?: number;
  atrPctMax?: number;        // 0-100 (ej: 2.0 = 2%)
  atrPctMin?: number;
  marginUsdMax?: number;
  marginUsdMin?: number;
  scoreMin?: number;
  // Solo si current mode coincide (SCALP / STORM / STANDBY)
  currentModeIn?: ("SCALP"|"STORM"|"STANDBY")[];
  // Etiqueta de la regla (para que se vea humana en logs).
  label?: string;
};

export type Thesis = {
  id: number;
  version: number;
  text: string;
  expectedWr: number | null;
  expectedProfitFactor: number | null;
  expectedTradesPerDay: number | null;
  expectedMaxDrawdownPct: number | null;
  paramsSnapshot: any;
  autoAuthRules: AutoAuthRule[] | null;
  active: boolean;
  authoredBy: string;
  reason: string | null;
  createdAt: Date;
};

export function evalAutoAuth(rules: AutoAuthRule[] | null | undefined, ctx: {
  type: string;
  direction?: "LONG" | "SHORT";
  symbol: string;
  proposedLeverage?: number;
  atrPct?: number;
  proposedMarginUsd?: number;
  score?: number;
  currentMode?: string;
}): { matched: AutoAuthRule; index: number } | null {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const baseSym = ctx.symbol.replace(/USDT$/, "");
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const dt = r.decisionType ?? "open_layer";
    if (dt !== ctx.type) continue;
    if (r.direction && r.direction !== ctx.direction) continue;
    if (Array.isArray(r.symbols) && r.symbols.length > 0) {
      const includesAll = r.symbols.includes("*");
      if (!includesAll && !r.symbols.includes(baseSym)) continue;
    }
    if (Array.isArray(r.symbolsExclude) && r.symbolsExclude.includes(baseSym)) continue;
    if (r.leverageMax != null && ctx.proposedLeverage != null && ctx.proposedLeverage > r.leverageMax) continue;
    if (r.leverageMin != null && ctx.proposedLeverage != null && ctx.proposedLeverage < r.leverageMin) continue;
    if (r.atrPctMax != null && ctx.atrPct != null && (ctx.atrPct * 100) > r.atrPctMax) continue;
    if (r.atrPctMin != null && ctx.atrPct != null && (ctx.atrPct * 100) < r.atrPctMin) continue;
    if (r.marginUsdMax != null && ctx.proposedMarginUsd != null && ctx.proposedMarginUsd > r.marginUsdMax) continue;
    if (r.marginUsdMin != null && ctx.proposedMarginUsd != null && ctx.proposedMarginUsd < r.marginUsdMin) continue;
    if (r.scoreMin != null && ctx.score != null && ctx.score < r.scoreMin) continue;
    if (Array.isArray(r.currentModeIn) && r.currentModeIn.length > 0 && ctx.currentMode && !r.currentModeIn.includes(ctx.currentMode as any)) continue;
    return { matched: r, index: i };
  }
  return null;
}

let _tableEnsured = false;
async function ensureTable(): Promise<void> {
  if (_tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tanit_thesis (
      id SERIAL PRIMARY KEY,
      version INTEGER NOT NULL,
      text TEXT NOT NULL,
      expected_wr REAL,
      expected_profit_factor REAL,
      expected_trades_per_day REAL,
      expected_max_drawdown_pct REAL,
      params_snapshot JSONB,
      auto_auth_rules JSONB,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      authored_by TEXT NOT NULL DEFAULT 'tanit',
      reason TEXT,
      closed_at TIMESTAMP WITH TIME ZONE,
      actual_wr REAL,
      actual_profit_factor REAL,
      actual_trades_per_day REAL,
      actual_pnl REAL,
      actual_outcome TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  // Migración suave: si la tabla ya existe pero le falta auto_auth_rules, añadirla.
  try {
    await pool.query(`ALTER TABLE tanit_thesis ADD COLUMN IF NOT EXISTS auto_auth_rules JSONB`);
  } catch {}
  _tableEnsured = true;
}

export async function getActiveThesis(): Promise<Thesis | null> {
  await ensureTable();
  const r = await pool.query(
    `SELECT id, version, text, expected_wr, expected_profit_factor,
            expected_trades_per_day, expected_max_drawdown_pct,
            params_snapshot, auto_auth_rules, active, authored_by, reason, created_at
     FROM tanit_thesis WHERE active = TRUE ORDER BY id DESC LIMIT 1`
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    text: row.text,
    expectedWr: row.expected_wr,
    expectedProfitFactor: row.expected_profit_factor,
    expectedTradesPerDay: row.expected_trades_per_day,
    expectedMaxDrawdownPct: row.expected_max_drawdown_pct,
    paramsSnapshot: row.params_snapshot,
    autoAuthRules: Array.isArray(row.auto_auth_rules) ? row.auto_auth_rules : null,
    active: row.active,
    authoredBy: row.authored_by,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export async function listRecentThesis(limit = 10): Promise<any[]> {
  await ensureTable();
  const r = await pool.query(
    `SELECT id, version, text, expected_wr, expected_profit_factor, active,
            authored_by, reason, actual_wr, actual_profit_factor, actual_outcome,
            created_at, closed_at
     FROM tanit_thesis ORDER BY id DESC LIMIT $1`,
    [Math.max(1, Math.min(50, limit))]
  );
  return r.rows;
}

// Cierra la tesis activa con outcome real y crea una nueva como activa.
export async function setNewThesis(opts: {
  text: string;
  expectedWr?: number | null;
  expectedProfitFactor?: number | null;
  expectedTradesPerDay?: number | null;
  expectedMaxDrawdownPct?: number | null;
  paramsSnapshot?: any;
  autoAuthRules?: AutoAuthRule[] | null;
  authoredBy?: "tanit" | "luis" | "seed";
  reason?: string;
  outcomeForPrev?: string;
  actualForPrev?: { wr?: number; pf?: number; tradesPerDay?: number; pnl?: number };
}): Promise<Thesis> {
  await ensureTable();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Cierra tesis activa anterior (si hay)
    const prev = await client.query(`SELECT id, version FROM tanit_thesis WHERE active = TRUE`);
    let nextVersion = 1;
    if (prev.rows.length > 0) {
      const a = opts.actualForPrev ?? {};
      await client.query(
        `UPDATE tanit_thesis
           SET active = FALSE,
               closed_at = NOW(),
               actual_wr = $2,
               actual_profit_factor = $3,
               actual_trades_per_day = $4,
               actual_pnl = $5,
               actual_outcome = COALESCE($6, actual_outcome)
         WHERE id = $1`,
        [prev.rows[0].id, a.wr ?? null, a.pf ?? null, a.tradesPerDay ?? null, a.pnl ?? null, opts.outcomeForPrev ?? null]
      );
      nextVersion = (prev.rows[0].version ?? 0) + 1;
    }
    const r = await client.query(
      `INSERT INTO tanit_thesis
        (version, text, expected_wr, expected_profit_factor,
         expected_trades_per_day, expected_max_drawdown_pct,
         params_snapshot, auto_auth_rules, active, authored_by, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10)
       RETURNING id, created_at`,
      [
        nextVersion,
        opts.text,
        opts.expectedWr ?? null,
        opts.expectedProfitFactor ?? null,
        opts.expectedTradesPerDay ?? null,
        opts.expectedMaxDrawdownPct ?? null,
        opts.paramsSnapshot ? JSON.stringify(opts.paramsSnapshot) : null,
        opts.autoAuthRules ? JSON.stringify(opts.autoAuthRules) : null,
        opts.authoredBy ?? "tanit",
        opts.reason ?? null,
      ]
    );
    await client.query("COMMIT");
    console.log(TAG, `nueva tesis v${nextVersion} (${opts.authoredBy ?? "tanit"}) — id=${r.rows[0].id}`);
    return {
      id: r.rows[0].id,
      version: nextVersion,
      text: opts.text,
      expectedWr: opts.expectedWr ?? null,
      expectedProfitFactor: opts.expectedProfitFactor ?? null,
      expectedTradesPerDay: opts.expectedTradesPerDay ?? null,
      expectedMaxDrawdownPct: opts.expectedMaxDrawdownPct ?? null,
      paramsSnapshot: opts.paramsSnapshot,
      autoAuthRules: opts.autoAuthRules ?? null,
      active: true,
      authoredBy: opts.authoredBy ?? "tanit",
      reason: opts.reason ?? null,
      createdAt: r.rows[0].created_at,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function computeRecentMetrics(): Promise<{
  wr: number | null; profitFactor: number | null; tradesPerDay: number | null; pnl: number; trades: number;
}> {
  try {
    const r = await pool.query<{ pnl: string; closed_at: Date }>(
      `SELECT COALESCE(net_pnl, gross_pnl, 0)::text AS pnl, closed_at
       FROM trade_history
       WHERE closed_at >= NOW() - INTERVAL '24 hours'
       ORDER BY closed_at DESC`
    );
    const rows = r.rows;
    if (rows.length === 0) {
      return { wr: null, profitFactor: null, tradesPerDay: null, pnl: 0, trades: 0 };
    }
    const pnls = rows.map(x => parseFloat(x.pnl));
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);
    const wr = pnls.length > 0 ? (wins.length / pnls.length) * 100 : 0;
    const totalWin = wins.reduce((a, b) => a + b, 0);
    const totalLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const pf = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 99 : 0);
    const tradesPerDay = rows.length; // ya es por 24h
    const pnl = pnls.reduce((a, b) => a + b, 0);
    return { wr, profitFactor: pf, tradesPerDay, pnl, trades: rows.length };
  } catch {
    return { wr: null, profitFactor: null, tradesPerDay: null, pnl: 0, trades: 0 };
  }
}

export type DivergenceCheck = {
  hasThesis: boolean;
  diverges: boolean;
  notes: string[];
  metrics: { wr: number | null; profitFactor: number | null; tradesPerDay: number | null; pnl: number; trades: number };
  thesis: Thesis | null;
};

const DIVERGENCE_PCT = 0.15;

export async function checkDivergence(): Promise<DivergenceCheck> {
  const thesis = await getActiveThesis();
  const m = await computeRecentMetrics();
  if (!thesis) return { hasThesis: false, diverges: false, notes: ["sin tesis activa"], metrics: m, thesis: null };
  const notes: string[] = [];
  let diverges = false;
  if (thesis.expectedWr != null && m.wr != null) {
    const delta = m.wr - thesis.expectedWr;
    if (Math.abs(delta) / Math.max(1, thesis.expectedWr) > DIVERGENCE_PCT) {
      notes.push(`WR predicho ${thesis.expectedWr.toFixed(0)}% real ${m.wr.toFixed(0)}% (${delta >= 0 ? "+" : ""}${delta.toFixed(0)}pp)`);
      diverges = true;
    }
  }
  if (thesis.expectedProfitFactor != null && m.profitFactor != null) {
    const delta = m.profitFactor - thesis.expectedProfitFactor;
    if (Math.abs(delta) / Math.max(0.1, thesis.expectedProfitFactor) > DIVERGENCE_PCT) {
      notes.push(`PF predicho ${thesis.expectedProfitFactor.toFixed(2)} real ${m.profitFactor.toFixed(2)}`);
      diverges = true;
    }
  }
  return { hasThesis: true, diverges, notes, metrics: m, thesis };
}

// Llama a Gemini con prompt que pide a Tanit que escriba su tesis inicial.
async function generateSeedThesis(seedContext: string): Promise<{
  text: string; expectedWr?: number; expectedProfitFactor?: number;
  expectedTradesPerDay?: number; expectedMaxDrawdownPct?: number;
} | null> {
  const key = await getKey("gemini");
  if (!key) return null;
  const prompt = `Eres Tanit. Escribe TU PRIMERA TESIS OPERATIVA en 3 párrafos en primera persona.
Basa tu tesis en lo siguiente:
${seedContext}

Después da las métricas que tu tesis predice.

Responde SOLO un JSON con este formato exacto:
{"text":"<3 párrafos en primera persona>","expectedWr":<0-100>,"expectedProfitFactor":<número>,"expectedTradesPerDay":<número>,"expectedMaxDrawdownPct":<0-50>}`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.6, maxOutputTokens: 1500 },
        }),
        signal: AbortSignal.timeout(20000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) return null;
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
    let parsed: any = null;
    try { parsed = JSON.parse(cleaned); }
    catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch {}
    }
    if (!parsed || typeof parsed.text !== "string") return null;
    return {
      text: String(parsed.text).slice(0, 4000),
      expectedWr: typeof parsed.expectedWr === "number" ? parsed.expectedWr : undefined,
      expectedProfitFactor: typeof parsed.expectedProfitFactor === "number" ? parsed.expectedProfitFactor : undefined,
      expectedTradesPerDay: typeof parsed.expectedTradesPerDay === "number" ? parsed.expectedTradesPerDay : undefined,
      expectedMaxDrawdownPct: typeof parsed.expectedMaxDrawdownPct === "number" ? parsed.expectedMaxDrawdownPct : undefined,
    };
  } catch {
    return null;
  }
}

// Auto-seed al boot: si no hay tesis activa, le pedimos a Tanit que escriba la primera.
export async function autoSeedThesisIfEmpty(seedContext: string): Promise<boolean> {
  await ensureTable();
  const r = await pool.query(`SELECT COUNT(*) AS c FROM tanit_thesis`);
  const count = parseInt(r.rows[0]?.c ?? "0", 10);
  if (count > 0) return false;
  console.log(TAG, `tabla vacía — pidiendo a Tanit que escriba su primera tesis`);
  const seed = await generateSeedThesis(seedContext);
  if (!seed) {
    console.warn(TAG, `auto-seed falló (LLM no respondió) — quedará vacía hasta que Tanit la escriba en chat`);
    return false;
  }
  await setNewThesis({
    text: seed.text,
    expectedWr: seed.expectedWr,
    expectedProfitFactor: seed.expectedProfitFactor,
    expectedTradesPerDay: seed.expectedTradesPerDay,
    expectedMaxDrawdownPct: seed.expectedMaxDrawdownPct,
    authoredBy: "seed",
    reason: "auto-seed al boot — tesis inicial autogenerada por Tanit con base en sus memorias y trades",
  });
  console.log(TAG, `tesis seed creada — wr=${seed.expectedWr ?? "?"} pf=${seed.expectedProfitFactor ?? "?"}`);
  return true;
}
