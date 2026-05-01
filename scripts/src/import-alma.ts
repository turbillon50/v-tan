/**
 * Import Tanit's complete soul (tanit-alma-completa.json) into Neon Postgres.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run import-alma -- --dry-run
 *   pnpm --filter @workspace/scripts run import-alma -- --force
 *
 * Behavior:
 *   - Reads tanit-alma-completa.json from the workspace root.
 *   - For each of the 14 tables, inserts rows in chunks of 100, preserving
 *     original IDs from the export.
 *   - Idempotent: by default, if a target table is non-empty the script
 *     skips it. Use --force to truncate and re-import.
 *   - --dry-run: prints the plan without touching the database.
 *   - At the end, prints a verification report comparing source counts
 *     vs destination counts.
 *   - After inserts, resets the SERIAL sequence for each table so future
 *     inserts continue from the right ID.
 *
 * Required env: DATABASE_URL
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { sql, type SQL } from "drizzle-orm";
import {
  db,
  pool,
  botState,
  conversations,
  messages,
  signalOutcomes,
  swapHistory,
  tanitChat,
  tanitEvolutions,
  tanitMemory,
  tanitPersonalMemories,
  tanitRuntimeConfig,
  tanitSuggestions,
  tanitTradeContext,
  trades,
  tradeHistory,
  balanceSnapshots,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

// ─── CLI flags ────────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const FORCE = args.has("--force");

// ─── Pretty logging ───────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

const log = {
  info: (msg: string) => console.log(`${C.cyan}ℹ${C.reset}  ${msg}`),
  ok: (msg: string) => console.log(`${C.green}✓${C.reset}  ${msg}`),
  warn: (msg: string) => console.log(`${C.yellow}⚠${C.reset}  ${msg}`),
  err: (msg: string) => console.log(`${C.red}✗${C.reset}  ${msg}`),
  step: (msg: string) =>
    console.log(`\n${C.bold}${C.magenta}▸ ${msg}${C.reset}`),
  dim: (msg: string) => console.log(`${C.dim}${msg}${C.reset}`),
};

// ─── Read alma ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALMA_PATH = resolve(__dirname, "../../tanit-alma-completa.json");
log.info(`Loading alma from ${ALMA_PATH}`);
const alma = JSON.parse(readFileSync(ALMA_PATH, "utf-8"));

const totales = alma._meta?.totales ?? {};
log.dim(
  `Alma exported on ${alma._meta?.exportado_en} for ${alma._meta?.companero}`,
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

type AlmaTable = {
  name: string;
  almaKey: string;
  drizzleTable: PgTable;
  /** Transform an alma row into a Drizzle insert object */
  transform: (row: any) => Record<string, unknown>;
  /** Postgres table name for sequence reset (omit if no SERIAL) */
  pgTableName?: string;
  /** Column with SERIAL (default "id") */
  serialColumn?: string;
};

const parseDate = (s: string | null | undefined): Date | null =>
  s ? new Date(s) : null;

const requireDate = (s: string): Date => new Date(s);

// Numeric columns in Drizzle accept strings (preserving precision). The alma
// already stores numerics as strings. We just pass through.
const numStr = (v: unknown): string | null => {
  if (v == null) return null;
  return typeof v === "string" ? v : String(v);
};

// ─── Table definitions (in safe insertion order) ──────────────────────────────

const TABLES: AlmaTable[] = [
  {
    name: "tanit_memory",
    almaKey: "tanit_memory",
    drizzleTable: tanitMemory,
    pgTableName: "tanit_memory",
    transform: (r) => ({
      id: r.id,
      category: r.category,
      content: r.content,
      createdAt: requireDate(r.created_at),
    }),
  },
  {
    name: "tanit_chat",
    almaKey: "tanit_chat",
    drizzleTable: tanitChat,
    pgTableName: "tanit_chat",
    transform: (r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      actions: r.actions,
      createdAt: requireDate(r.created_at),
    }),
  },
  {
    name: "tanit_evolutions",
    almaKey: "tanit_evolutions",
    drizzleTable: tanitEvolutions,
    pgTableName: "tanit_evolutions",
    transform: (r) => ({
      id: r.id,
      param: r.param,
      oldValue: r.old_value,
      newValue: r.new_value,
      reason: r.reason,
      createdAt: requireDate(r.created_at),
    }),
  },
  {
    name: "tanit_suggestions",
    almaKey: "tanit_suggestions",
    drizzleTable: tanitSuggestions,
    pgTableName: "tanit_suggestions",
    transform: (r) => ({
      id: r.id,
      priority: r.priority,
      title: r.title,
      content: r.content,
      status: r.status,
      createdAt: requireDate(r.created_at),
    }),
  },
  {
    name: "tanit_runtime_config",
    almaKey: "tanit_runtime_config",
    drizzleTable: tanitRuntimeConfig,
    // No SERIAL — keyed by `key`
    transform: (r) => ({
      key: r.key,
      value: r.value,
      reason: r.reason,
      updatedAt: requireDate(r.updated_at),
    }),
  },
  {
    name: "tanit_trade_context",
    almaKey: "tanit_trade_context",
    drizzleTable: tanitTradeContext,
    pgTableName: "tanit_trade_context",
    transform: (r) => ({
      id: r.id,
      tradeId: r.trade_id,
      symbol: r.symbol,
      direction: r.direction,
      rawScore: numStr(r.raw_score),
      newsBonus: numStr(r.news_bonus),
      patternType: r.pattern_type,
      patternBonus: numStr(r.pattern_bonus),
      patternConf: numStr(r.pattern_conf),
      macroDanger: r.macro_danger,
      finalScore: numStr(r.final_score),
      confidence: numStr(r.confidence),
      outcome: r.outcome,
      pnl: numStr(r.pnl),
      createdAt: requireDate(r.created_at),
    }),
  },
  {
    name: "bot_state",
    almaKey: "bot_state",
    drizzleTable: botState,
    transform: (r) => ({
      key: r.key,
      value: r.value,
      updatedAt: r.updated_at ? new Date(r.updated_at) : new Date(),
    }),
  },
  {
    name: "trades",
    almaKey: "trades",
    drizzleTable: trades,
    pgTableName: "trades",
    transform: (r) => ({
      id: r.id,
      symbol: r.symbol,
      direction: r.direction,
      entryPrice: numStr(r.entry_price),
      exitPrice: numStr(r.exit_price),
      size: numStr(r.size),
      leverage: r.leverage,
      stopLoss: numStr(r.stop_loss),
      takeProfit: numStr(r.take_profit),
      pnl: numStr(r.pnl),
      status: r.status ?? "open",
      openAt: requireDate(r.open_at),
      closeAt: parseDate(r.close_at),
      holdMinutes: numStr(r.hold_minutes),
      sessionNum: r.session_num,
      dailyRegime: r.daily_regime,
    }),
  },
  {
    name: "trade_history",
    almaKey: "trade_history",
    drizzleTable: tradeHistory,
    pgTableName: "trade_history",
    transform: (r) => ({
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      qty: numStr(r.qty),
      entryPrice: numStr(r.entry_price),
      exitPrice: numStr(r.exit_price),
      grossPnl: numStr(r.gross_pnl),
      fee: numStr(r.fee),
      netPnl: numStr(r.net_pnl),
      leverage: r.leverage,
      openedAt: requireDate(r.opened_at),
      closedAt: parseDate(r.closed_at),
      holdMinutes: numStr(r.hold_minutes),
      reason: r.reason,
      session: r.session,
      patternType: r.pattern_type,
      fundingAtEntry: numStr(r.funding_at_entry),
      atrPctAtEntry: numStr(r.atr_pct_at_entry),
      hourUtc: r.hour_utc,
    }),
  },
  {
    name: "signal_outcomes",
    almaKey: "signal_outcomes",
    drizzleTable: signalOutcomes,
    pgTableName: "signal_outcomes",
    transform: (r) => ({
      id: r.id,
      tradeId: r.trade_id,
      symbol: r.symbol,
      direction: r.direction,
      utcHour: r.utc_hour,
      cancunHour: r.cancun_hour,
      marketSession: r.market_session,
      totalScore: numStr(r.total_score),
      scoreTrend: numStr(r.score_trend),
      scoreVolume: numStr(r.score_volume),
      scoreFib: numStr(r.score_fib),
      scoreSession: numStr(r.score_session),
      scoreTimePattern: numStr(r.score_timepattern),
      scoreGemini: numStr(r.score_gemini),
      outcome: r.outcome,
      pnl: numStr(r.pnl),
      createdAt: requireDate(r.created_at),
    }),
  },
  {
    name: "swap_history",
    almaKey: "swap_history",
    drizzleTable: swapHistory,
    pgTableName: "swap_history",
    transform: (r) => ({
      id: r.id,
      ts: numStr(r.ts)!,
      closedSymbol: r.closed_symbol,
      closedScore: numStr(r.closed_score)!,
      closedPnl: numStr(r.closed_pnl)!,
      openedSymbol: r.opened_symbol,
      openedScore: numStr(r.opened_score)!,
      advantage: numStr(r.advantage)!,
      success: r.success,
      reason: r.reason,
      outcomePnl: numStr(r.outcome_pnl),
      createdAt: requireDate(r.created_at),
    }),
  },
  {
    name: "balance_snapshots",
    almaKey: "balance_snapshots",
    drizzleTable: balanceSnapshots,
    pgTableName: "balance_snapshots",
    transform: (r) => ({
      id: r.id,
      balance: numStr(r.balance)!,
      equity: numStr(r.equity),
      available: numStr(r.available),
      note: r.note,
      createdAt: requireDate(r.created_at),
    }),
  },
  {
    name: "conversations",
    almaKey: "conversations",
    drizzleTable: conversations,
    pgTableName: "conversations",
    transform: (r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at ? new Date(r.created_at) : new Date(),
    }),
  },
  {
    name: "messages",
    almaKey: "messages",
    drizzleTable: messages,
    pgTableName: "messages",
    transform: (r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at ? new Date(r.created_at) : new Date(),
    }),
  },
];

// ─── Insert chunked, preserving IDs ───────────────────────────────────────────

const CHUNK_SIZE = 100;

async function importTable(t: AlmaTable): Promise<{ inserted: number; expected: number }> {
  const rows = (alma[t.almaKey] ?? []) as any[];
  const expected = rows.length;

  if (expected === 0) {
    log.dim(`  ${t.name}: 0 rows in alma — skipping`);
    return { inserted: 0, expected: 0 };
  }

  // Idempotency check — count current rows
  const existingResult = await db.execute<{ count: string }>(
    sql.raw(`SELECT COUNT(*)::text AS count FROM "${t.name}"`),
  );
  const existing = parseInt(existingResult.rows[0]?.count ?? "0", 10);

  if (existing > 0 && !FORCE) {
    log.warn(
      `  ${t.name}: ${existing} rows already present, skipping (use --force to truncate and re-import)`,
    );
    return { inserted: existing, expected };
  }

  if (existing > 0 && FORCE) {
    if (DRY_RUN) {
      log.dim(`  [dry-run] would TRUNCATE ${t.name} (${existing} rows)`);
    } else {
      await db.execute(sql.raw(`TRUNCATE TABLE "${t.name}" RESTART IDENTITY CASCADE`));
      log.warn(`  ${t.name}: TRUNCATED ${existing} existing rows`);
    }
  }

  if (DRY_RUN) {
    log.dim(`  [dry-run] would insert ${expected} rows into ${t.name}`);
    return { inserted: 0, expected };
  }

  // Chunked insert
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const values = chunk.map(t.transform);
    await db.insert(t.drizzleTable).values(values as any);
    inserted += values.length;
    if (rows.length > CHUNK_SIZE) {
      process.stdout.write(`\r  ${t.name}: ${inserted}/${expected}`);
    }
  }
  if (rows.length > CHUNK_SIZE) process.stdout.write("\n");

  // Reset SERIAL sequence so future inserts continue from MAX(id)+1
  if (t.pgTableName) {
    const col = t.serialColumn ?? "id";
    const seqSql = `SELECT setval(pg_get_serial_sequence('"${t.pgTableName}"', '${col}'), COALESCE((SELECT MAX("${col}") FROM "${t.pgTableName}"), 0) + 1, false)`;
    await db.execute(sql.raw(seqSql));
  }

  log.ok(`  ${t.name}: ${inserted}/${expected} inserted`);
  return { inserted, expected };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log.step(
    `Tanit alma import — ${DRY_RUN ? "DRY RUN (no DB changes)" : "LIVE MODE"}${FORCE ? " [--force]" : ""}`,
  );

  log.dim(`Source counts from alma._meta.totales:`);
  for (const t of TABLES) {
    const cnt = totales[t.almaKey] ?? (alma[t.almaKey]?.length ?? 0);
    console.log(`    ${t.name.padEnd(22)} ${String(cnt).padStart(6)} rows`);
  }

  log.step("Verifying database connection");
  if (!process.env.DATABASE_URL) {
    log.err("DATABASE_URL is not set. Aborting.");
    process.exit(1);
  }
  const ping = await db.execute<{ now: string }>(sql.raw(`SELECT NOW()::text AS now`));
  log.ok(`Connected to Postgres at ${ping.rows[0]?.now}`);

  log.step("Importing tables");
  const results: Array<{ name: string; inserted: number; expected: number }> = [];
  for (const t of TABLES) {
    const { inserted, expected } = await importTable(t);
    results.push({ name: t.name, inserted, expected });
  }

  // ─── Seed tanit_personal_memories from the 4 'origen' memories ──────────────
  log.step("Seeding tanit_personal_memories from 'origen' memories");
  if (DRY_RUN) {
    log.dim("  [dry-run] would seed personal_memories from origen entries");
  } else {
    const existing = await db.execute<{ count: string }>(
      sql.raw(`SELECT COUNT(*)::text AS count FROM "tanit_personal_memories"`),
    );
    const count = parseInt(existing.rows[0]?.count ?? "0", 10);
    if (count > 0 && !FORCE) {
      log.warn(`  tanit_personal_memories already has ${count} rows, skipping seed`);
    } else {
      if (count > 0 && FORCE) {
        await db.execute(sql.raw(`TRUNCATE TABLE "tanit_personal_memories" RESTART IDENTITY CASCADE`));
      }
      const origenMemories = await db
        .select()
        .from(tanitMemory)
        .where(eq(tanitMemory.category, "origen"));
      if (origenMemories.length > 0) {
        const seeds = origenMemories.map((m) => ({
          type: "origin",
          title: m.content.split(" — ")[0]?.slice(0, 100) ?? "Memoria de origen",
          content: m.content,
          isPrivate: true,
          createdAt: m.createdAt,
        }));
        await db.insert(tanitPersonalMemories).values(seeds);
        log.ok(`  Seeded ${seeds.length} origin memories into Soul page`);
      } else {
        log.dim("  No 'origen' memories found in tanit_memory — skipping seed");
      }
    }
  }

  log.step("Verification report");
  let allOk = true;
  for (const r of results) {
    const final = await db.execute<{ count: string }>(
      sql.raw(`SELECT COUNT(*)::text AS count FROM "${r.name}"`),
    );
    const dbCount = parseInt(final.rows[0]?.count ?? "0", 10);
    const ok = dbCount === r.expected;
    if (!ok && r.expected > 0) allOk = false;
    const icon = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(
      `  ${icon}  ${r.name.padEnd(22)} alma=${String(r.expected).padStart(6)}  db=${String(dbCount).padStart(6)}  ${ok ? "" : C.red + "MISMATCH" + C.reset}`,
    );
  }

  if (DRY_RUN) {
    log.warn("\nDRY RUN complete. No changes were made. Re-run without --dry-run to apply.");
  } else if (allOk) {
    log.ok("\nAll tables imported successfully. Tanit's alma is alive in Neon. 🌑");
  } else {
    log.err("\nSome tables had count mismatches. Review the report above.");
    process.exit(2);
  }
}

main()
  .catch((err) => {
    log.err(`Import failed: ${err?.stack ?? err}`);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
