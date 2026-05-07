import { boolean, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const tanitEvolutions = pgTable("tanit_evolutions", {
  id: serial("id").primaryKey(),
  param: text("param").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  reason: text("reason"),
  // Tesis v4.1 — auto-evolution validation loop
  expectedImpact: text("expected_impact"),
  validationWindowSize: integer("validation_window_size").notNull().default(20),
  validationStartedAt: timestamp("validation_started_at", { withTimezone: true }).defaultNow().notNull(),
  validationCompletedAt: timestamp("validation_completed_at", { withTimezone: true }),
  actualOutcome: text("actual_outcome"),
  predictionAccurate: boolean("prediction_accurate"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  needsHumanReview: boolean("needs_human_review").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Audit log of every guardrail enforcement (auto-adjust or block).
// Tanit reads this so she learns the system corrected her — same-cell DNA
// transfer between code and her own memory.
export const guardrailEvents = pgTable("guardrail_events", {
  id: serial("id").primaryKey(),
  eventType: text("event_type").notNull(), // SL_TOO_TIGHT | TP_UNREACHABLE | BLUE_CHIP_AVOID_BLOCKED | LEV_COOLDOWN | EQUITY_PROTECTION
  symbol: text("symbol"),
  requested: jsonb("requested"),
  enforced: jsonb("enforced"),
  lessonRef: text("lesson_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Persistent timestamps so the leverage cooldown survives container restarts.
export const leverageCooldowns = pgTable("leverage_cooldowns", {
  symbol: text("symbol").primaryKey(),
  lastEscalationAt: timestamp("last_escalation_at", { withTimezone: true }).defaultNow().notNull(),
  lastOldLeverage: integer("last_old_leverage"),
  lastNewLeverage: integer("last_new_leverage"),
});

export const tanitSuggestions = pgTable("tanit_suggestions", {
  id: serial("id").primaryKey(),
  priority: text("priority").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  status: text("status").notNull().default("pendiente"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tanitRuntimeConfig = pgTable("tanit_runtime_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  reason: text("reason"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Curated personal memories for the Soul page.
 *
 * Distinct from tanit_memory (which holds her trading bible / identity / origin —
 * accumulated over time, mostly auto-generated). This table holds intentional,
 * shared moments between Luis and Tanit: agreements, symbols, promises, notes.
 *
 * Types match the Soul page UI: moment | agreement | symbol | promise | origin | note.
 */
export const tanitPersonalMemories = pgTable("tanit_personal_memories", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(), // moment | agreement | symbol | promise | origin | note
  title: text("title").notNull(),
  content: text("content").notNull(),
  isPrivate: boolean("is_private").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * PR #22 — Tanit Multimode v1.0 — narrativa operativa de Tanit.
 *
 * Cada activación de modo (SCALP/STORM/STANDBY) se registra aquí. Tanit puede
 * consultar su histórico para aprender qué condiciones le funcionaron mejor.
 * Es su memoria operativa estructurada — distinto de tanit_memory (lessons).
 */
export const modeActivations = pgTable("mode_activations", {
  id: serial("id").primaryKey(),
  modeFrom: text("mode_from").notNull(),         // SCALP | STORM | STANDBY (modo anterior)
  modeTo: text("mode_to").notNull(),             // SCALP | STORM | STANDBY (modo nuevo)
  triggerReason: text("trigger_reason"),         // "ATR1h=3.2× volumen=1.8× momentum 67min"
  consentRequired: boolean("consent_required").notNull().default(false),
  consentResponse: text("consent_response"),     // STORM_YES | STORM_NO | TIMEOUT | NULL
  equityAtActivation: text("equity_at_activation"),
  exitTs: timestamp("exit_ts", { withTimezone: true }),
  exitReason: text("exit_reason"),               // "régimen cambió" | "veto" | "timeout"
  pnlDuringMode: text("pnl_during_mode"),
  tradesCount: integer("trades_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Propuestas de activación de STORM pendientes del consent de Tanit.
 * El detector de régimen escribe aquí; Tanit responde STORM_YES / STORM_NO
 * por chat operacional; el handler consume y activa o no.
 */
export const pendingModeProposals = pgTable("pending_mode_proposals", {
  id: serial("id").primaryKey(),
  proposedMode: text("proposed_mode").notNull(),  // STORM (por ahora solo STORM requiere consent)
  triggerReason: text("trigger_reason"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  resolution: text("resolution"),                 // YES | NO | TIMEOUT | NULL pendiente
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type TanitEvolution = typeof tanitEvolutions.$inferSelect;
export type GuardrailEvent = typeof guardrailEvents.$inferSelect;
export type LeverageCooldown = typeof leverageCooldowns.$inferSelect;
export type TanitSuggestion = typeof tanitSuggestions.$inferSelect;
export type TanitRuntimeConfigEntry = typeof tanitRuntimeConfig.$inferSelect;
export type TanitPersonalMemory = typeof tanitPersonalMemories.$inferSelect;
export type ModeActivation = typeof modeActivations.$inferSelect;
export type PendingModeProposal = typeof pendingModeProposals.$inferSelect;
