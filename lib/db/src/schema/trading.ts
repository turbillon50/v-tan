import { pgTable, serial, text, timestamp, numeric, integer, jsonb, boolean } from "drizzle-orm/pg-core";

export const botState = pgTable("bot_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),
  entryPrice: numeric("entry_price", { precision: 20, scale: 8 }).notNull(),
  exitPrice: numeric("exit_price", { precision: 20, scale: 8 }),
  size: numeric("size", { precision: 20, scale: 8 }).notNull(),
  leverage: integer("leverage").notNull(),
  stopLoss: numeric("stop_loss", { precision: 20, scale: 8 }),
  takeProfit: numeric("take_profit", { precision: 20, scale: 8 }),
  pnl: numeric("pnl", { precision: 20, scale: 8 }),
  status: text("status").notNull().default("open"),
  openAt: timestamp("open_at", { withTimezone: true }).notNull(),
  closeAt: timestamp("close_at", { withTimezone: true }),
  holdMinutes: numeric("hold_minutes", { precision: 10, scale: 2 }),
  sessionNum: integer("session_num"),
  dailyRegime: text("daily_regime"),
});

export const swapHistory = pgTable("swap_history", {
  id: serial("id").primaryKey(),
  ts: numeric("ts", { precision: 20, scale: 0 }).notNull(),
  closedSymbol: text("closed_symbol").notNull(),
  closedScore: numeric("closed_score", { precision: 10, scale: 4 }).notNull(),
  closedPnl: numeric("closed_pnl", { precision: 20, scale: 8 }).notNull(),
  openedSymbol: text("opened_symbol").notNull(),
  openedScore: numeric("opened_score", { precision: 10, scale: 4 }).notNull(),
  advantage: numeric("advantage", { precision: 10, scale: 4 }).notNull(),
  success: boolean("success").notNull(),
  reason: text("reason").notNull(),
  outcomePnl: numeric("outcome_pnl", { precision: 20, scale: 8 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const signalOutcomes = pgTable("signal_outcomes", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id"),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),
  utcHour: integer("utc_hour").notNull(),
  cancunHour: integer("cancun_hour").notNull(),
  marketSession: text("market_session"),
  totalScore: numeric("total_score", { precision: 10, scale: 4 }),
  scoreTrend: numeric("score_trend", { precision: 10, scale: 4 }),
  scoreVolume: numeric("score_volume", { precision: 10, scale: 4 }),
  scoreFib: numeric("score_fib", { precision: 10, scale: 4 }),
  scoreSession: numeric("score_session", { precision: 10, scale: 4 }),
  scoreTimePattern: numeric("score_timepattern", { precision: 10, scale: 4 }),
  scoreGemini: numeric("score_gemini", { precision: 10, scale: 4 }),
  outcome: text("outcome").notNull(),
  pnl: numeric("pnl", { precision: 20, scale: 8 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
