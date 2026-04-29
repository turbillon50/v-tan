import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const tanitMemory = pgTable("tanit_memory", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type TanitMemoryEntry = typeof tanitMemory.$inferSelect;
