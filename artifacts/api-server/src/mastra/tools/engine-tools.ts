/**
 * Tools del motor de trading — Tanit puede leer el estado del día,
 * los setups planeados, y disparar manualmente el motor si lo necesita.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { pool } from "@workspace/db";
import { getTodayReport, runEngineTick } from "../../lib/tanit-trading-engine";

export const consultarPlanDelDia = createTool({
  id: "consultar_plan_del_dia",
  description:
    "Devuelve el estado del día de trading: equity_open, pnl_today, drawdown, trades_total, breaker activo, posiciones abiertas, setups planeados. Úsalo cuando Luis pregunte '¿cómo vamos hoy?' o cuando tú misma quieras saber qué estás haciendo. Es la fuente de verdad — NO inventes números, lee desde aquí.",
  inputSchema: z.object({}).optional(),
  outputSchema: z.object({
    trading_day: z.string().nullable(),
    equity_open: z.number().nullable(),
    equity_current: z.number().nullable(),
    pnl_today_usd: z.number(),
    pnl_today_pct: z.number(),
    max_drawdown_pct: z.number(),
    trades_total: z.number(),
    trades_wins: z.number(),
    trades_losses: z.number(),
    consecutive_losses: z.number(),
    breaker_active: z.boolean(),
    breaker_reason: z.string().nullable(),
    sacred_reserve_usd: z.number().nullable(),
    plan_target_trades: z.number(),
    positions_open: z.number(),
    positions: z.array(
      z.object({ symbol: z.string(), side: z.string(), pnl: z.number() }),
    ),
    plans_executed_today: z.number(),
  }),
  execute: async () => {
    const r = await getTodayReport();
    const s = r.state;
    return {
      trading_day: s?.trading_day ?? null,
      equity_open: s?.equity_open != null ? Number(s.equity_open) : null,
      equity_current: s?.equity_current != null ? Number(s.equity_current) : null,
      pnl_today_usd: Number(s?.pnl_today_usd ?? 0),
      pnl_today_pct: Number(s?.pnl_today_pct ?? 0),
      max_drawdown_pct: Number(s?.max_drawdown_pct ?? 0),
      trades_total: s?.trades_total ?? 0,
      trades_wins: s?.trades_wins ?? 0,
      trades_losses: s?.trades_losses ?? 0,
      consecutive_losses: s?.consecutive_losses ?? 0,
      breaker_active: s?.breaker_active ?? false,
      breaker_reason: s?.breaker_reason ?? null,
      sacred_reserve_usd: s?.sacred_reserve_usd != null ? Number(s.sacred_reserve_usd) : null,
      plan_target_trades: s?.plan_target_trades ?? 5,
      positions_open: r.positions.length,
      positions: r.positions,
      plans_executed_today: r.plansOpen,
    };
  },
});

export const consultarSetupsHoy = createTool({
  id: "consultar_setups_hoy",
  description:
    "Lista los setups que el motor abrió hoy, con symbol, direction, motor que los generó, score, rationale y status. Para que tú sepas qué decidió el motor, sin inventar.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: z.object({
    setups: z.array(z.object({
      id: z.number(),
      symbol: z.string(),
      direction: z.string(),
      motor: z.string().nullable(),
      score: z.number().nullable(),
      rationale: z.string().nullable(),
      size_usd: z.number().nullable(),
      leverage: z.number().nullable(),
      status: z.string(),
      pnl_realized: z.number().nullable(),
      executed_at: z.string().nullable(),
    })),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: any }).context
      : (rawInput as any)) as { limit?: number };
    const limit = ctx?.limit ?? 20;
    const r = await pool.query(
      `SELECT id, symbol, direction, motor, score, rationale, size_usd, leverage, status, pnl_realized, executed_at
       FROM tanit_setup_plan
       WHERE trading_day = CURRENT_DATE
       ORDER BY id DESC
       LIMIT $1`,
      [limit],
    );
    return {
      setups: r.rows.map((s: any) => ({
        id: s.id,
        symbol: s.symbol,
        direction: s.direction,
        motor: s.motor ?? null,
        score: s.score != null ? Number(s.score) : null,
        rationale: s.rationale ?? null,
        size_usd: s.size_usd != null ? Number(s.size_usd) : null,
        leverage: s.leverage ?? null,
        status: s.status,
        pnl_realized: s.pnl_realized != null ? Number(s.pnl_realized) : null,
        executed_at: s.executed_at ? new Date(s.executed_at).toISOString() : null,
      })),
    };
  },
});

export const disparar_motor_ahora = createTool({
  id: "disparar_motor_ahora",
  description:
    "Ejecuta UN tick del motor de trading INMEDIATAMENTE (sin esperar al loop de 15min). Úsalo solo si Luis te lo pide explícitamente ('escanea ya', 'abre setups ahora'). Devuelve el reporte completo del tick.",
  inputSchema: z.object({}).optional(),
  outputSchema: z.object({
    ranAt: z.string(),
    setupsScanned: z.number(),
    setupsExecuted: z.number(),
    decisions: z.array(z.object({ action: z.string(), detail: z.string() })),
    equity: z.number(),
    pnlPct: z.number(),
    breakerActive: z.boolean(),
  }),
  execute: async () => {
    const r = await runEngineTick();
    return {
      ranAt: r.ranAt,
      setupsScanned: r.setupsScanned,
      setupsExecuted: r.setupsExecuted,
      decisions: r.decisions,
      equity: Number(r.equity ?? 0),
      pnlPct: Number(r.dailyState.pnlPct ?? 0),
      breakerActive: Boolean(r.dailyState.breakerActive),
    };
  },
});

export const engineTools = {
  consultarPlanDelDia,
  consultarSetupsHoy,
  dispararMotorAhora: disparar_motor_ahora,
};
