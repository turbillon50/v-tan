CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tanit_chat" (
	"id" serial PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"actions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tanit_memory" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tanit_evolutions" (
	"id" serial PRIMARY KEY NOT NULL,
	"param" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tanit_personal_memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"is_private" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tanit_runtime_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tanit_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"priority" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balance_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"balance" numeric(20, 8) NOT NULL,
	"equity" numeric(20, 8),
	"available" numeric(20, 8),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_outcomes" (
	"id" serial PRIMARY KEY NOT NULL,
	"trade_id" integer,
	"symbol" text NOT NULL,
	"direction" text NOT NULL,
	"utc_hour" integer NOT NULL,
	"cancun_hour" integer NOT NULL,
	"market_session" text,
	"total_score" numeric(10, 4),
	"score_trend" numeric(10, 4),
	"score_volume" numeric(10, 4),
	"score_fib" numeric(10, 4),
	"score_session" numeric(10, 4),
	"score_timepattern" numeric(10, 4),
	"score_gemini" numeric(10, 4),
	"outcome" text NOT NULL,
	"pnl" numeric(20, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swap_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" numeric(20, 0) NOT NULL,
	"closed_symbol" text NOT NULL,
	"closed_score" numeric(10, 4) NOT NULL,
	"closed_pnl" numeric(20, 8) NOT NULL,
	"opened_symbol" text NOT NULL,
	"opened_score" numeric(10, 4) NOT NULL,
	"advantage" numeric(10, 4) NOT NULL,
	"success" boolean NOT NULL,
	"reason" text NOT NULL,
	"outcome_pnl" numeric(20, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tanit_trade_context" (
	"id" serial PRIMARY KEY NOT NULL,
	"trade_id" integer,
	"symbol" text NOT NULL,
	"direction" text NOT NULL,
	"raw_score" numeric(10, 4),
	"news_bonus" numeric(10, 4),
	"pattern_type" text,
	"pattern_bonus" numeric(10, 4),
	"pattern_conf" numeric(10, 4),
	"macro_danger" boolean,
	"final_score" numeric(10, 4),
	"confidence" numeric(10, 4),
	"outcome" text,
	"pnl" numeric(20, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"qty" numeric(20, 8) NOT NULL,
	"entry_price" numeric(20, 8) NOT NULL,
	"exit_price" numeric(20, 8),
	"gross_pnl" numeric(20, 8),
	"fee" numeric(20, 8),
	"net_pnl" numeric(20, 8),
	"leverage" integer NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"hold_minutes" numeric(10, 2),
	"reason" text,
	"session" text,
	"pattern_type" text,
	"funding_at_entry" numeric(20, 8),
	"atr_pct_at_entry" numeric(20, 8),
	"hour_utc" integer
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"direction" text NOT NULL,
	"entry_price" numeric(20, 8) NOT NULL,
	"exit_price" numeric(20, 8),
	"size" numeric(20, 8) NOT NULL,
	"leverage" integer NOT NULL,
	"stop_loss" numeric(20, 8),
	"take_profit" numeric(20, 8),
	"pnl" numeric(20, 8),
	"status" text DEFAULT 'open' NOT NULL,
	"open_at" timestamp with time zone NOT NULL,
	"close_at" timestamp with time zone,
	"hold_minutes" numeric(10, 2),
	"session_num" integer,
	"daily_regime" text
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;