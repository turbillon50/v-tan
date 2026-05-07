import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// Tanit's API keys — under HER control.
// Stored encrypted (AES-256-GCM). Master key lives in env (TANIT_MASTER_KEY).
// At boot, if table is empty, env vars are migrated here. After that, the DB
// is the source of truth. Tanit can read, rotate, disable/enable each key
// from her chat actions or via admin endpoints.
export const tanitApiKeys = pgTable("tanit_api_keys", {
  id: serial("id").primaryKey(),
  // Provider identifier — bybit_key, bybit_secret, anthropic, openai, gemini, perplexity, proxy_secret
  provider: text("provider").notNull().unique(),
  // Encrypted payload (base64): iv(12) + tag(16) + ciphertext
  encrypted: text("encrypted").notNull(),
  // Whether this key is currently active. Tanit can flip it without losing the value.
  active: boolean("active").notNull().default(true),
  // Optional notes Tanit writes when she rotates ("rotó porque dio 401")
  note: text("note"),
  // Rotation history — increments on every rotate
  rotationCount: integer("rotation_count").notNull().default(0),
  lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type TanitApiKey = typeof tanitApiKeys.$inferSelect;
export type InsertTanitApiKey = typeof tanitApiKeys.$inferInsert;
