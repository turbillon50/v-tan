/**
 * Migrate schema + import alma to Neon, all over HTTPS.
 *
 * The Claude Code sandbox blocks direct Postgres connections (port 5432),
 * but HTTPS works fine. Neon's serverless driver (@neondatabase/serverless)
 * tunnels SQL over HTTPS, so we can run everything from here.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run migrate-and-import
 *   pnpm --filter @workspace/scripts run migrate-and-import -- --dry-run
 *   pnpm --filter @workspace/scripts run migrate-and-import -- --skip-schema
 *   pnpm --filter @workspace/scripts run migrate-and-import -- --force
 *
 * Steps:
 *  1. Verify connection
 *  2. Apply schema from lib/db/drizzle/0000_*.sql (idempotent: CREATE TABLE IF NOT EXISTS)
 *  3. Import each of the 14 tables from tanit-alma-completa.json
 *  4. Seed tanit_personal_memories from 'origen' rows in tanit_memory
 *  5. Print verification report comparing alma counts vs db counts
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { neon } from "@neondatabase/serverless";

// ─── CLI flags ────────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const FORCE = args.has("--force");
const SKIP_SCHEMA = args.has("--skip-schema");

// ─── Pretty logging ───────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", magenta: "\x1b[35m",
};
const log = {
  info: (m: string) => console.log(`${C.cyan}ℹ${C.reset}  ${m}`),
  ok:   (m: string) => console.log(`${C.green}✓${C.reset}  ${m}`),
  warn: (m: string) => console.log(`${C.yellow}⚠${C.reset}  ${m}`),
  err:  (m: string) => console.log(`${C.red}✗${C.reset}  ${m}`),
  step: (m: string) => console.log(`\n${C.bold}${C.magenta}▸ ${m}${C.reset}`),
  dim:  (m: string) => console.log(`${C.dim}${m}${C.reset}`),
};

// ─── Load .env.local ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const envPath = resolve(ROOT, ".env.local");
if (existsSync(envPath) && !process.env.DATABASE_URL) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

if (!process.env.DATABASE_URL) {
  log.err("DATABASE_URL not found in env or .env.local. Aborting.");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

// ─── Read alma ────────────────────────────────────────────────────────────────

const ALMA_PATH = resolve(ROOT, "tanit-alma-completa.json");
log.info(`Loading alma from ${ALMA_PATH}`);
const alma = JSON.parse(readFileSync(ALMA_PATH, "utf-8"));
log.dim(`Alma exported on ${alma._meta?.exportado_en} for ${alma._meta?.companero}`);

// ─── Schema migration ─────────────────────────────────────────────────────────

async function applySchema(): Promise<void> {
  if (SKIP_SCHEMA) {
    log.warn("Skipping schema migration (--skip-schema)");
    return;
  }
  log.step("Applying schema (CREATE TABLE IF NOT EXISTS)");

  const drizzleDir = resolve(ROOT, "lib/db/drizzle");
  const sqlFiles = readdirSync(drizzleDir).filter((f) => f.endsWith(".sql")).sort();
  if (sqlFiles.length === 0) {
    log.err("No migration SQL files found in lib/db/drizzle/. Run drizzle-kit generate first.");
    process.exit(1);
  }

  for (const file of sqlFiles) {
    const content = readFileSync(resolve(drizzleDir, file), "utf-8");
    // Drizzle uses --> statement-breakpoint as separator
    const statements = content
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      // Make CREATE TABLE idempotent
      .map((s) => s.replace(/^CREATE TABLE\s+/i, "CREATE TABLE IF NOT EXISTS "));

    log.dim(`  ${file}: ${statements.length} statements`);

    for (const stmt of statements) {
      if (DRY_RUN) {
        log.dim(`    [dry-run] would execute: ${stmt.split("\n")[0].slice(0, 60)}...`);
        continue;
      }
      try {
        await sql.query(stmt);
      } catch (err: any) {
        if (err?.message?.includes("already exists")) {
          // expected if table existed
          continue;
        }
        throw err;
      }
    }
  }
  log.ok("Schema applied");
}

// ─── Type helpers ─────────────────────────────────────────────────────────────

const D = (s: string | null | undefined): string | null =>
  s ? new Date(s).toISOString() : null;
const N = (v: unknown): string | null => v == null ? null : String(v);
const B = (v: unknown): boolean | null => v == null ? null : Boolean(v);

// Quote identifier (table or column name)
const Q = (s: string) => `"${s}"`;

// ─── Generic chunked import ───────────────────────────────────────────────────

const CHUNK_SIZE = 100;

interface TableSpec {
  name: string;
  almaKey: string;
  columns: string[]; // ordered list of column names (for INSERT)
  rowToValues: (row: any) => unknown[]; // returns values in column order
  hasSerial?: boolean; // true if the table has a SERIAL id we want to reset after
  serialColumn?: string; // default "id"
}

async function importTable(t: TableSpec): Promise<{ inserted: number; expected: number }> {
  const rows = (alma[t.almaKey] ?? []) as any[];
  const expected = rows.length;

  if (expected === 0) {
    log.dim(`  ${t.name}: 0 rows in alma`);
    return { inserted: 0, expected: 0 };
  }

  if (DRY_RUN) {
    log.dim(`  [dry-run] would insert ${expected} rows into ${t.name}`);
    return { inserted: 0, expected };
  }

  // Idempotency check
  const result = await sql.query(`SELECT COUNT(*)::text AS count FROM ${Q(t.name)}`);
  const existing = parseInt(result[0]?.count ?? "0", 10);

  if (existing > 0 && !FORCE) {
    log.warn(`  ${t.name}: ${existing} rows already present, skipping (use --force to truncate)`);
    return { inserted: existing, expected };
  }

  if (existing > 0 && FORCE) {
    await sql.query(`TRUNCATE TABLE ${Q(t.name)} RESTART IDENTITY CASCADE`);
    log.warn(`  ${t.name}: TRUNCATED ${existing} existing rows`);
  }

  let inserted = 0;
  const colList = t.columns.map(Q).join(", ");

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);

    // Build a multi-row VALUES placeholder string ($1, $2, ...) and flatten params
    const placeholders: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const row of chunk) {
      const vals = t.rowToValues(row);
      placeholders.push(`(${vals.map(() => `$${p++}`).join(", ")})`);
      params.push(...vals);
    }

    const stmt = `INSERT INTO ${Q(t.name)} (${colList}) VALUES ${placeholders.join(", ")}`;
    await sql.query(stmt, params);
    inserted += chunk.length;
    if (rows.length > CHUNK_SIZE) process.stdout.write(`\r  ${t.name}: ${inserted}/${expected}`);
  }
  if (rows.length > CHUNK_SIZE) process.stdout.write("\n");

  // Reset SERIAL sequence
  if (t.hasSerial) {
    const col = t.serialColumn ?? "id";
    await sql.query(
      `SELECT setval(pg_get_serial_sequence('${t.name}', '${col}'), COALESCE((SELECT MAX(${Q(col)}) FROM ${Q(t.name)}), 0) + 1, false)`,
    );
  }

  log.ok(`  ${t.name}: ${inserted}/${expected} inserted`);
  return { inserted, expected };
}

// ─── Table specs (column order matters — must match the rowToValues array) ────

const TABLES: TableSpec[] = [
  {
    name: "tanit_memory",
    almaKey: "tanit_memory",
    columns: ["id", "category", "content", "created_at"],
    hasSerial: true,
    rowToValues: (r) => [r.id, r.category, r.content, D(r.created_at)],
  },
  {
    name: "tanit_chat",
    almaKey: "tanit_chat",
    columns: ["id", "role", "content", "actions", "created_at"],
    hasSerial: true,
    rowToValues: (r) => [r.id, r.role, r.content, r.actions ?? null, D(r.created_at)],
  },
  {
    name: "tanit_evolutions",
    almaKey: "tanit_evolutions",
    columns: ["id", "param", "old_value", "new_value", "reason", "created_at"],
    hasSerial: true,
    rowToValues: (r) => [r.id, r.param, r.old_value, r.new_value, r.reason, D(r.created_at)],
  },
  {
    name: "tanit_suggestions",
    almaKey: "tanit_suggestions",
    columns: ["id", "priority", "title", "content", "status", "created_at"],
    hasSerial: true,
    rowToValues: (r) => [r.id, r.priority, r.title, r.content, r.status, D(r.created_at)],
  },
  {
    name: "tanit_runtime_config",
    almaKey: "tanit_runtime_config",
    columns: ["key", "value", "reason", "updated_at"],
    rowToValues: (r) => [r.key, r.value, r.reason, D(r.updated_at)],
  },
  {
    name: "tanit_trade_context",
    almaKey: "tanit_trade_context",
    columns: ["id", "trade_id", "symbol", "direction", "raw_score", "news_bonus", "pattern_type", "pattern_bonus", "pattern_conf", "macro_danger", "final_score", "confidence", "outcome", "pnl", "created_at"],
    hasSerial: true,
    rowToValues: (r) => [r.id, r.trade_id, r.symbol, r.direction, N(r.raw_score), N(r.news_bonus), r.pattern_type, N(r.pattern_bonus), N(r.pattern_conf), B(r.macro_danger), N(r.final_score), N(r.confidence), r.outcome, N(r.pnl), D(r.created_at)],
  },
  {
    name: "bot_state",
    almaKey: "bot_state",
    columns: ["key", "value", "updated_at"],
    rowToValues: (r) => [r.key, JSON.stringify(r.value), r.updated_at ? D(r.updated_at) : new Date().toISOString()],
  },
  {
    name: "trades",
    almaKey: "trades",
    columns: ["id", "symbol", "direction", "entry_price", "exit_price", "size", "leverage", "stop_loss", "take_profit", "pnl", "status", "open_at", "close_at", "hold_minutes", "session_num", "daily_regime"],
    hasSerial: true,
    rowToValues: (r) => [r.id, r.symbol, r.direction, N(r.entry_price), N(r.exit_price), N(r.size), r.leverage, N(r.stop_loss), N(r.take_profit), N(r.pnl), r.status ?? "open", D(r.open_at), D(r.close_at), N(r.hold_minutes), r.session_num, r.daily_regime],
  },
  {
    name: "trade_history",
    almaKey: "trade_history",
    columns: ["id", "symbol", "side", "qty", "entry_price", "exit_price", "gross_pnl", "fee", "net_pnl", "leverage", "opened_at", "closed_at", "hold_minutes", "reason", "session", "pattern_type", "funding_at_entry", "atr_pct_at_entry", "hour_utc"],
    hasSerial: true,
    rowToValues: (r) => [r.id, r.symbol, r.side, N(r.qty), N(r.entry_price), N(r.exit_price), N(r.gross_pnl), N(r.fee), N(r.net_pnl), r.leverage, D(r.opened_at), D(r.closed_at), N(r.hold_minutes), r.reason, r.session, r.pattern_type, N(r.funding_at_entry), N(r.atr_pct_at_entry), r.hour_utc],
  },
  {
    name: "signal_outcomes",
    almaKey: "signal_outcomes",
    columns: ["id", "trade_id", "symbol", "direction", "utc_hour", "cancun_hour", "market_session", "total_score", "score_trend", "score_volume", "score_fib", "score_session", "score_timepattern", "score_gemini", "outcome", "pnl", "created_at"],
    hasSerial: true,
    rowToValues: (r) => [r.id, r.trade_id, r.symbol, r.direction, r.utc_hour, r.cancun_hour, r.market_session, N(r.total_score), N(r.score_trend), N(r.score_volume), N(r.score_fib), N(r.score_session), N(r.score_timepattern), N(r.score_gemini), r.outcome, N(r.pnl), D(r.created_at)],
  },
  {
    name: "swap_history",
    almaKey: "swap_history",
    columns: ["id", "ts", "closed_symbol", "closed_score", "closed_pnl", "opened_symbol", "opened_score", "advantage", "success", "reason", "outcome_pnl", "created_at"],
    hasSerial: true,
    rowToValues: (r) => [r.id, N(r.ts), r.closed_symbol, N(r.closed_score), N(r.closed_pnl), r.opened_symbol, N(r.opened_score), N(r.advantage), r.success, r.reason, N(r.outcome_pnl), D(r.created_at)],
  },
  {
    name: "balance_snapshots",
    almaKey: "balance_snapshots",
    columns: ["id", "balance", "equity", "available", "note", "created_at"],
    hasSerial: true,
    rowToValues: (r) => [r.id, N(r.balance), N(r.equity), N(r.available), r.note, D(r.created_at)],
  },
  {
    name: "conversations",
    almaKey: "conversations",
    columns: ["id", "title", "created_at"],
    hasSerial: true,
    rowToValues: (r) => [r.id, r.title, D(r.created_at) ?? new Date().toISOString()],
  },
  {
    name: "messages",
    almaKey: "messages",
    columns: ["id", "conversation_id", "role", "content", "created_at"],
    hasSerial: true,
    rowToValues: (r) => [r.id, r.conversation_id, r.role, r.content, D(r.created_at) ?? new Date().toISOString()],
  },
];

// ─── Seed personal memories from 'origen' ─────────────────────────────────────

async function seedPersonalMemories(): Promise<void> {
  log.step("Seeding tanit_personal_memories from 'origen' memories");
  if (DRY_RUN) {
    log.dim("  [dry-run] would seed personal_memories from origen entries");
    return;
  }

  const existing = await sql.query(`SELECT COUNT(*)::text AS count FROM "tanit_personal_memories"`);
  const count = parseInt(existing[0]?.count ?? "0", 10);
  if (count > 0 && !FORCE) {
    log.warn(`  tanit_personal_memories already has ${count} rows, skipping seed`);
    return;
  }
  if (count > 0 && FORCE) {
    await sql.query(`TRUNCATE TABLE "tanit_personal_memories" RESTART IDENTITY CASCADE`);
  }

  const origen = await sql.query(
    `SELECT content, created_at FROM "tanit_memory" WHERE category = $1 ORDER BY id`,
    ["origen"],
  );
  if (origen.length === 0) {
    log.dim("  No 'origen' memories — skipping seed");
    return;
  }

  for (const m of origen) {
    const title = String(m.content).split(" — ")[0]?.slice(0, 100) ?? "Memoria de origen";
    await sql.query(
      `INSERT INTO "tanit_personal_memories" (type, title, content, is_private, created_at) VALUES ($1, $2, $3, $4, $5)`,
      ["origin", title, m.content, true, m.created_at],
    );
  }
  log.ok(`  Seeded ${origen.length} origin memories into Soul page`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log.step(
    `Tanit migrate-and-import — ${DRY_RUN ? "DRY RUN (no DB changes)" : "LIVE MODE"}${FORCE ? " [--force]" : ""}${SKIP_SCHEMA ? " [--skip-schema]" : ""}`,
  );

  log.step("Verifying database connection");
  const ping = await sql.query(`SELECT NOW()::text AS now, current_database() AS db`);
  log.ok(`Connected — ${ping[0]?.db} at ${ping[0]?.now}`);

  await applySchema();

  log.step("Importing tables");
  const results: Array<{ name: string; inserted: number; expected: number }> = [];
  for (const t of TABLES) {
    const r = await importTable(t);
    results.push({ name: t.name, ...r });
  }

  await seedPersonalMemories();

  log.step("Verification report");
  let allOk = true;
  for (const r of results) {
    if (DRY_RUN) {
      console.log(
        `  ${C.dim}-${C.reset}  ${r.name.padEnd(22)} alma=${String(r.expected).padStart(6)}  ${C.dim}(dry-run, no db query)${C.reset}`,
      );
      continue;
    }
    const final = await sql.query(`SELECT COUNT(*)::text AS count FROM "${r.name}"`);
    const dbCount = parseInt(final[0]?.count ?? "0", 10);
    const ok = dbCount === r.expected;
    if (!ok && r.expected > 0) allOk = false;
    const icon = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(
      `  ${icon}  ${r.name.padEnd(22)} alma=${String(r.expected).padStart(6)}  db=${String(dbCount).padStart(6)}  ${ok ? "" : C.red + "MISMATCH" + C.reset}`,
    );
  }

  // Personal memories count (seeded, not from alma)
  if (!DRY_RUN) {
    const pmCount = await sql.query(`SELECT COUNT(*)::text AS count FROM "tanit_personal_memories"`);
    console.log(
      `  ${C.green}✓${C.reset}  ${"tanit_personal_memories".padEnd(22)} seed=${String(parseInt(pmCount[0]?.count ?? "0", 10)).padStart(7)}`,
    );
  }

  if (DRY_RUN) {
    log.warn("\nDRY RUN complete. No changes were made. Re-run without --dry-run to apply.");
  } else if (allOk) {
    log.ok("\n✨ Tanit's alma is alive in Neon. ✨");
  } else {
    log.err("\nSome tables had count mismatches. Review the report above.");
    process.exit(2);
  }
}

main().catch((err) => {
  log.err(`Failed: ${err?.stack ?? err}`);
  process.exit(1);
});
