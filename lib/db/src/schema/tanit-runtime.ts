import { boolean, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const tanitEvolutions = pgTable("tanit_evolutions", {
  id: serial("id").primaryKey(),
  param: text("param").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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
export type TanitSuggestion = typeof tanitSuggestions.$inferSelect;
export type TanitRuntimeConfigEntry = typeof tanitRuntimeConfig.$inferSelect;
export type TanitPersonalMemory = typeof tanitPersonalMemories.$inferSelect;
