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

export type TanitEvolution = typeof tanitEvolutions.$inferSelect;
export type GuardrailEvent = typeof guardrailEvents.$inferSelect;
export type LeverageCooldown = typeof leverageCooldowns.$inferSelect;
export type TanitSuggestion = typeof tanitSuggestions.$inferSelect;
export type TanitRuntimeConfigEntry = typeof tanitRuntimeConfig.$inferSelect;
export type TanitPersonalMemory = typeof tanitPersonalMemories.$inferSelect;
