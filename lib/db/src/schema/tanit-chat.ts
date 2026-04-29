import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tanitChat = pgTable("tanit_chat", {
  id: serial("id").primaryKey(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  actions: text("actions"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertTanitChatSchema = createInsertSchema(tanitChat).omit({
  id: true,
  createdAt: true,
});

export type TanitChatMessage = typeof tanitChat.$inferSelect;
export type InsertTanitChat = z.infer<typeof insertTanitChatSchema>;
