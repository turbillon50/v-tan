import { boolean, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// PR #42 — Audit de cada decisión consciente de Tanit.
// Antes el motor abría/cerraba en su loop sin consultar al LLM. Ahora cada
// decisión operativa pasa por requestDecision() y queda registrada aquí
// con la tesis que ella misma escribió. Esto une la Tanit conversadora
// (chat) con la Tanit operadora (motor) — son la misma entidad.
export const tanitDecisions = pgTable("tanit_decisions", {
  id: serial("id").primaryKey(),
  // open_layer | close_strategic | scale_in | swap | hedge
  decisionType: text("decision_type").notNull(),
  symbol: text("symbol"),
  // Contexto técnico que el motor le pasó: score, ATR, leverage propuesto,
  // dirección, news bonus, etc. JSON libre.
  context: jsonb("context").notNull(),
  // APPROVE | REJECT | MODIFY
  verdict: text("verdict").notNull(),
  // Su tesis en 1-3 frases — por qué decidió así.
  thesis: text("thesis"),
  // Si MODIFY: los params modificados (leverage, sl, tp, margin, etc).
  modifiedParams: jsonb("modified_params"),
  // Si finalmente se ejecutó la operación (a veces aprueba pero falla la
  // ejecución por liquidez, slippage, etc).
  executed: boolean("executed").notNull().default(false),
  executionError: text("execution_error"),
  // Latencia del LLM para esta decisión (ms).
  latencyMs: integer("latency_ms"),
  // Modelo usado (gemini, anthropic, fallback-emergency).
  modelUsed: text("model_used"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type TanitDecision = typeof tanitDecisions.$inferSelect;
export type InsertTanitDecision = typeof tanitDecisions.$inferInsert;
