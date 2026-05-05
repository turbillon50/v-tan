import { pgTable, serial, text, timestamp, varchar, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tanitChat = pgTable(
  "tanit_chat",
  {
    id: serial("id").primaryKey(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    actions: text("actions"),
    channel: varchar("channel", { length: 20 }).notNull().default("intimate"),
    senderType: varchar("sender_type", { length: 30 }).notNull().default("human_luis"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    channelCreatedIdx: index("idx_tanit_chat_channel_created").on(t.channel, t.createdAt),
  }),
);

export const insertTanitChatSchema = createInsertSchema(tanitChat).omit({
  id: true,
  createdAt: true,
});

export type TanitChatMessage = typeof tanitChat.$inferSelect;
export type InsertTanitChat = z.infer<typeof insertTanitChatSchema>;

export type TanitChatChannel = "intimate" | "operational";
export type TanitChatSenderType =
  | "human_luis"
  | "tanit_reply"
  | "tanit_self"
  | "ai_break"
  | "ai_other"
  | "system";
