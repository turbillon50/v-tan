/**
 * REVERT del backfill malo + opción de re-correr con equity correcto.
 *
 * Bug del primer intento: usé el último snapshot de la DB ($16.33, de hace
 * >72h) como equity actual, pero el equity REAL ahora es $176+. Las 4320
 * filas insertadas eran falsas.
 *
 * Heurística para identificar las falsas (todas tienen):
 *   - num_positions = 0
 *   - margin_heat_pct = 0
 *   - balance = equity = available
 *   - EXTRACT(SECOND FROM created_at) = 0 (timestamp alineado al minuto)
 *   - created_at >= NOW() - 72h
 *
 * Uso:
 *   DATABASE_URL='...' node scripts/revert-backfill-and-redo.mjs            (solo revierte)
 *   DATABASE_URL='...' CURRENT_EQUITY=176.38 HOURS=72 node scripts/revert-backfill-and-redo.mjs   (revierte y re-corre)
 */
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  console.error("ABORT: DATABASE_URL no está seteada.");
  process.exit(1);
}

const HOURS = parseInt(process.env.HOURS ?? "72", 10);
const CURRENT_EQUITY = process.env.CURRENT_EQUITY ? parseFloat(process.env.CURRENT_EQUITY) : null;
const sql = neon(process.env.DATABASE_URL);

async function run() {
  console.log("== REVERT del backfill malo ==\n");

  const before = await sql`SELECT COUNT(*)::int AS n FROM balance_snapshots`;
  console.log(`Total antes del DELETE: ${before[0].n}`);

  const deleted = await sql`
    DELETE FROM balance_snapshots
    WHERE created_at >= NOW() - INTERVAL '72 hours'
      AND num_positions = 0
      AND margin_heat_pct = 0
      AND EXTRACT(SECOND FROM created_at) = 0
      AND balance = equity
      AND balance = available
    RETURNING id
  `;
  const after = await sql`SELECT COUNT(*)::int AS n FROM balance_snapshots`;
  console.log(`Filas eliminadas: ${deleted.length}`);
  console.log(`Total después del DELETE: ${after[0].n}`);

  if (CURRENT_EQUITY == null || !(CURRENT_EQUITY > 0)) {
    console.log("\n(Sin CURRENT_EQUITY env var, no se re-corre el backfill)");
    console.log("Para re-correr: CURRENT_EQUITY=176.38 HOURS=72 node scripts/revert-backfill-and-redo.mjs");
    return;
  }

  console.log(`\n== RE-CORRIENDO BACKFILL con CURRENT_EQUITY=$${CURRENT_EQUITY} ==\n`);

  // Trades en ventana
  const trades = await sql`
    SELECT closed_at, net_pnl
    FROM trade_history
    WHERE closed_at >= NOW() - (${HOURS} || ' hours')::interval
      AND net_pnl IS NOT NULL
    ORDER BY closed_at ASC
  `;
  const sumPnl = trades.reduce((s, t) => s + parseFloat(t.net_pnl ?? 0), 0);
  const startingEquity = CURRENT_EQUITY - sumPnl;
  console.log(`Trades: ${trades.length} | suma net_pnl: $${sumPnl.toFixed(4)}`);
  console.log(`Equity al inicio del rango: $${startingEquity.toFixed(4)}`);

  if (startingEquity <= 0) {
    console.warn("⚠️  startingEquity ≤ 0 — flooreando a $0.01 en slots tempranos.");
  }

  // Slots
  const windowStartMs = Date.now() - HOURS * 3600 * 1000;
  let runningEquity = Math.max(0.01, startingEquity);
  const slots = [{ ts: windowStartMs, equity: runningEquity }];
  for (const t of trades) {
    runningEquity += parseFloat(t.net_pnl);
    slots.push({ ts: new Date(t.closed_at).getTime(), equity: Math.max(0.01, runningEquity) });
  }
  slots.push({ ts: Date.now(), equity: CURRENT_EQUITY });

  function equityAt(targetMs) {
    let last = slots[0];
    for (const s of slots) {
      if (s.ts > targetMs) break;
      last = s;
    }
    return last.equity;
  }

  // Existing minutes (post-revert)
  const existing = await sql`
    SELECT DISTINCT (EXTRACT(EPOCH FROM date_trunc('minute', created_at))::bigint * 1000) AS minute_ms
    FROM balance_snapshots
    WHERE created_at >= NOW() - (${HOURS} || ' hours')::interval
  `;
  const existingSet = new Set(existing.map(r => Number(r.minute_ms)));

  // Filas a insertar
  const nowMs = Date.now();
  const startMs = Math.ceil(windowStartMs / 60_000) * 60_000;
  const rows = [];
  for (let t = startMs; t < nowMs; t += 60_000) {
    if (existingSet.has(t)) continue;
    const eq = Math.max(0.01, equityAt(t));
    rows.push({ ts: new Date(t).toISOString(), eq: parseFloat(eq.toFixed(6)) });
  }
  console.log(`Filas sintéticas a insertar: ${rows.length}`);

  if (rows.length > 0) {
    const tss = rows.map(r => r.ts);
    const eqs = rows.map(r => r.eq);
    await sql`
      INSERT INTO balance_snapshots
        (balance, equity, available, num_positions, margin_heat_pct, created_at)
      SELECT eq, eq, eq, 0, 0, ts::timestamptz
      FROM unnest(${eqs}::numeric[], ${tss}::text[]) AS u(eq, ts)
    `;
    console.log(`✅ Insertadas ${rows.length} filas sintéticas con equity REAL.`);
  }

  const final = await sql`SELECT COUNT(*)::int AS n FROM balance_snapshots`;
  const last6h = await sql`SELECT COUNT(*)::int AS n FROM balance_snapshots WHERE created_at >= NOW() - INTERVAL '6 hours'`;
  const last1h = await sql`SELECT COUNT(*)::int AS n FROM balance_snapshots WHERE created_at >= NOW() - INTERVAL '1 hour'`;
  console.log(`\nTotal final: ${final[0].n} | últimas 6h: ${last6h[0].n} | última hora: ${last1h[0].n}`);
}

run().catch(e => { console.error("FAILED:", e); process.exit(1); });
