/**
 * Migración dashboard /monitor — 5-may-2026
 *
 * 1. Añade columnas faltantes a balance_snapshots (idempotente con ADD COLUMN IF NOT EXISTS):
 *    - num_positions: número de posiciones abiertas al momento del snapshot
 *    - margin_heat_pct: % del equity comprometido en posiciones
 *    - daily_pnl_usdt: PnL realizado del día UTC al momento del snapshot
 *
 * 2. Crea tabla capital_contributions si no existe:
 *    - Para que Luis registre cada depósito de capital
 *    - amount_usdt, amount_mxn, exchange_rate, notes, created_at
 *
 * Cómo ejecutar:
 *   DATABASE_URL='postgresql://...' node scripts/migrate-dashboard.mjs
 */
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  console.error("ABORT: DATABASE_URL no está seteada.");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

async function run() {
  console.log("== STEP 1: enrich balance_snapshots ==");
  await sql`ALTER TABLE balance_snapshots ADD COLUMN IF NOT EXISTS num_positions INTEGER DEFAULT 0`;
  await sql`ALTER TABLE balance_snapshots ADD COLUMN IF NOT EXISTS margin_heat_pct NUMERIC(10,4) DEFAULT 0`;
  await sql`ALTER TABLE balance_snapshots ADD COLUMN IF NOT EXISTS daily_pnl_usdt NUMERIC(20,8) DEFAULT 0`;
  await sql`ALTER TABLE balance_snapshots ADD COLUMN IF NOT EXISTS equity NUMERIC(20,8)`;
  await sql`ALTER TABLE balance_snapshots ADD COLUMN IF NOT EXISTS available NUMERIC(20,8)`;
  console.log("  ✓ balance_snapshots columns ensured");

  console.log("\n== STEP 2: create capital_contributions ==");
  await sql`
    CREATE TABLE IF NOT EXISTS capital_contributions (
      id SERIAL PRIMARY KEY,
      amount_usdt NUMERIC(20,8) NOT NULL,
      amount_mxn NUMERIC(20,4),
      exchange_rate NUMERIC(10,4),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    )
  `;
  console.log("  ✓ capital_contributions table ensured");

  console.log("\n== STEP 3: verify ==");
  const cols = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'balance_snapshots'
    ORDER BY ordinal_position
  `;
  console.log("  balance_snapshots columns:", cols.map(c => c.column_name).join(", "));

  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('balance_snapshots', 'capital_contributions', 'trade_history', 'tanit_memory')
    ORDER BY table_name
  `;
  console.log("  tables present:", tables.map(t => t.table_name).join(", "));

  const snapCount = await sql`SELECT COUNT(*)::int AS n FROM balance_snapshots`;
  console.log(`  balance_snapshots rows: ${snapCount[0].n}`);

  console.log("\n== DONE ==");
}

run().catch(e => { console.error("FAILED:", e); process.exit(1); });
