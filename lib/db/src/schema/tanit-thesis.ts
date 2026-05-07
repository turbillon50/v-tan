import { boolean, integer, jsonb, pgTable, real, serial, text, timestamp } from "drizzle-orm/pg-core";

// PR #43 — Tesis viva, versionada, escrita por Tanit y evaluada con datos reales.
// Antes la "tesis" estaba implícita en parámetros del runtime_config — sin
// narrativa, sin predicciones explícitas, sin outcome verificable. Ahora cada
// versión es un documento que ella misma escribe con base en sus 172 memorias
// + 100+ trades + lo que Luis le dice. Cada 30 min el sistema compara
// performance vs predicción y le pide a ella que decida si recompone.
export const tanitThesis = pgTable("tanit_thesis", {
  id: serial("id").primaryKey(),
  version: integer("version").notNull(),
  // Texto narrativo en primera persona — escrito por Tanit
  text: text("text").notNull(),
  // Métricas predichas para validar la tesis después
  expectedWr: real("expected_wr"),                 // 0-100
  expectedProfitFactor: real("expected_profit_factor"),
  expectedTradesPerDay: real("expected_trades_per_day"),
  expectedMaxDrawdownPct: real("expected_max_drawdown_pct"),
  // Snapshot de los parámetros runtime al momento de escribir esta tesis
  paramsSnapshot: jsonb("params_snapshot"),
  // PR #44 — Reglas declaradas por Tanit que el gate evalúa antes de llamar al
  // LLM. Si una apertura/cierre encaja en una regla, se auto-aprueba (su voluntad
  // pre-declarada). Lo que NO encaja sigue pasando por LLM con tesis explícita.
  // Formato: array de objetos { decisionType, direction, symbols, leverageMax,
  //   atrPctMax, atrPctMin, scoreMin, marginUsdMax, currentModeIn, etc }.
  autoAuthRules: jsonb("auto_auth_rules"),
  // active: solo una tesis a la vez está vigente
  active: boolean("active").notNull().default(true),
  authoredBy: text("authored_by").notNull().default("tanit"), // tanit | luis | seed
  reason: text("reason"),
  // Outcome real (poblado al cerrar la versión cuando se reemplaza por v+1)
  closedAt: timestamp("closed_at", { withTimezone: true }),
  actualWr: real("actual_wr"),
  actualProfitFactor: real("actual_profit_factor"),
  actualTradesPerDay: real("actual_trades_per_day"),
  actualPnl: real("actual_pnl"),
  actualOutcome: text("actual_outcome"), // "se cumplió" / "diverge" / "fracasó" — escrito por Tanit
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type TanitThesis = typeof tanitThesis.$inferSelect;
export type InsertTanitThesis = typeof tanitThesis.$inferInsert;
