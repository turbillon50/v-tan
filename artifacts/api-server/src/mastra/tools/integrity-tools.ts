/**
 * Auto-verificación de Tanit — tools que le permiten chequear si ELLA misma
 * realmente ejecutó lo que dice haber ejecutado.
 *
 * Ataja la alucinación de Gemini que dice "abrí hedge" sin invocar la tool.
 *
 * Flujo recomendado para Tanit:
 *   1. Responder a Luis con su intent ("voy a abrir hedge en BTC")
 *   2. Invocar la tool (ej. abrir_hedge)
 *   3. ANTES de afirmar éxito, invocar verificar_ultima_accion para
 *      confirmar que tanit_decisions tiene un executed reciente para ese tipo
 *   4. Si la verificación pasa, decirle a Luis lo que pasó
 *   5. Si no pasa, decir "intenté pero no logré, reintento"
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { pool } from "@workspace/db";

export const verificarUltimaAccion = createTool({
  id: "verificar_ultima_accion",
  description:
    "Verifica que mi última acción de un tipo dado (abrir_long, abrir_short, cerrar_posicion, abrir_hedge, mover_stops, cambiar_leverage, etc.) realmente se ejecutó en los últimos N segundos. Devuelve la decisión más reciente de ese tipo con verdict + executed + tiempo. Úsalo ANTES de afirmar a Luis 'hice X' — si verdict no es executed, NO afirmes.",
  inputSchema: z.object({
    decision_type: z.string().describe("Ej: open_long, open_short, close_position, open_hedge, set_stops, set_leverage, add_margin, switch_margin_mode, switch_position_mode, cancel_all"),
    within_seconds: z.number().int().min(5).max(600).default(60).describe("Ventana de búsqueda en segundos (default 60)"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    verdict: z.string().nullable(),
    executed: z.boolean(),
    age_seconds: z.number().nullable(),
    symbol: z.string().nullable(),
    execution_error: z.string().nullable(),
    decision_id: z.number().nullable(),
    advice: z.string(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: any }).context
      : (rawInput as any)) as { decision_type: string; within_seconds?: number };
    const win = ctx.within_seconds ?? 60;
    const r = await pool.query(
      `SELECT id, symbol, verdict, executed, execution_error, created_at
         FROM tanit_decisions
        WHERE decision_type = $1
          AND created_at > NOW() - ($2 || ' seconds')::interval
        ORDER BY id DESC LIMIT 1`,
      [ctx.decision_type, String(win)],
    );
    if (r.rows.length === 0) {
      return {
        found: false,
        verdict: null,
        executed: false,
        age_seconds: null,
        symbol: null,
        execution_error: null,
        decision_id: null,
        advice: `No tengo registro de ${ctx.decision_type} en los últimos ${win}s. Si pensé que lo hice, ALUCINÉ. NO afirmo a Luis que lo ejecuté.`,
      };
    }
    const row = r.rows[0]!;
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    const ageS = Math.round(ageMs / 1000);
    return {
      found: true,
      verdict: row.verdict,
      executed: Boolean(row.executed),
      age_seconds: ageS,
      symbol: row.symbol ?? null,
      execution_error: row.execution_error ?? null,
      decision_id: row.id,
      advice: row.executed
        ? `OK, ${ctx.decision_type} ejecutado hace ${ageS}s (verdict=${row.verdict}). Puedo reportar a Luis con confianza.`
        : `${ctx.decision_type} se intentó hace ${ageS}s pero NO ejecutó (verdict=${row.verdict}, error=${row.execution_error ?? "n/a"}). Reporto el error real a Luis, NO afirmo éxito.`,
    };
  },
});

export const integrityTools = {
  verificarUltimaAccion,
};
