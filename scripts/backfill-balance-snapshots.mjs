/**
 * Backfill balance_snapshots — 6-may-2026
 *
 * Reportado por Luis hoy 21:38: la pantalla "Analytics" del frontend
 * muestra "Sin datos en esta ventana — ventana 6.0h · 1 pts" porque
 * la tabla balance_snapshots solo tiene ~47 filas en 21 días, todas
 * espaciadas. La curva sale como un palo recto $4.71 → $176, sin
 * granularidad intermedia. "Es una chingadera, hace ver mal a Tanit".
 *
 * Solución:
 *   A) Cron in-memory que cada 60s escribe snapshot SIN throttle (ya
 *      implementado en trading-engine.ts startEngine).
 *   B) ESTE SCRIPT — backfill histórico: reconstruye snapshot por minuto
 *      en las últimas N horas (default 72) caminando trade_history desde
 *      el equity actual.
 *
 * Algoritmo:
 *   1. Tomar equity actual (último snapshot real)
 *   2. SELECT trade_history WHERE closed_at >= NOW() - Nh ORDER BY ASC
 *   3. equity_inicial = equity_actual − sum(net_pnl de los trades)
 *   4. Caminar hacia adelante acumulando net_pnl en cada cierre →
 *      lista de (timestamp, equity)
 *   5. Para cada minuto del rango, equity_minuto = último slot ≤ minuto
 *   6. INSERT sintético si no existe ya un snapshot en ese minuto
 *
 * Uso:
 *   DATABASE_URL='postgresql://...' node scripts/backfill-balance-snapshots.mjs
 *   DATABASE_URL='...' HOURS=72 node scripts/backfill-balance-snapshots.mjs
 */
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  console.error("ABORT: DATABASE_URL no está seteada.");
  process.exit(1);
}

const HOURS = parseInt(process.env.HOURS ?? "72", 10);
const sql = neon(process.env.DATABASE_URL);

async function run() {
  console.log(`== BACKFILL balance_snapshots — últimas ${HOURS}h ==\n`);

  // 1. Equity actual (último snapshot real)
  const latest = await sql`
    SELECT equity, balance, created_at
    FROM balance_snapshots
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const currentEquity = parseFloat(latest[0]?.equity ?? latest[0]?.balance ?? 0);
  if (!(currentEquity > 0)) {
    console.error("ABORT: no hay un equity actual válido en balance_snapshots.");
    process.exit(1);
  }
  console.log(`Equity actual (último snapshot): $${currentEquity.toFixed(4)}`);

  // 2. Trades en ventana
  const trades = await sql`
    SELECT closed_at, net_pnl
    FROM trade_history
    WHERE closed_at >= NOW() - (${HOURS} || ' hours')::interval
      AND net_pnl IS NOT NULL
    ORDER BY closed_at ASC
  `;
  const sumPnl = trades.reduce((s, t) => s + parseFloat(t.net_pnl ?? 0), 0);
  const startingEquity = currentEquity - sumPnl;
  console.log(`Trades en ventana: ${trades.length} | suma net_pnl: $${sumPnl.toFixed(4)}`);
  console.log(`Equity reconstruida al inicio del rango: $${startingEquity.toFixed(4)}`);

  if (startingEquity <= 0) {
    console.warn(`⚠️  startingEquity ≤ 0 — la suma de PnL excede el equity actual; los slots tempranos saldrán muy bajos pero no negativos.`);
  }

  // 3. Construir slots (timestamp, equity) caminando trades desde el inicio
  const windowStartMs = Date.now() - HOURS * 3600 * 1000;
  let runningEquity = startingEquity;
  const slots = [{ ts: windowStartMs, equity: runningEquity }];
  for (const t of trades) {
    runningEquity += parseFloat(t.net_pnl);
    slots.push({ ts: new Date(t.closed_at).getTime(), equity: runningEquity });
  }
  slots.push({ ts: Date.now(), equity: currentEquity });

  // 4. Helper — equity en un timestamp dado (último slot ≤ ts, lineal forward)
  function equityAt(targetMs) {
    let last = slots[0];
    for (const s of slots) {
      if (s.ts > targetMs) break;
      last = s;
    }
    return last.equity;
  }

  // 5. Existing minutes (para no duplicar)
  const existing = await sql`
    SELECT DISTINCT (EXTRACT(EPOCH FROM date_trunc('minute', created_at))::bigint * 1000) AS minute_ms
    FROM balance_snapshots
    WHERE created_at >= NOW() - (${HOURS} || ' hours')::interval
  `;
  const existingSet = new Set(existing.map(r => Number(r.minute_ms)));
  console.log(`Minutos con snapshot ya presente: ${existingSet.size}`);

  // 6. Construir filas a insertar
  const nowMs = Date.now();
  const startMs = Math.ceil(windowStartMs / 60_000) * 60_000;
  const rows = [];
  for (let t = startMs; t < nowMs; t += 60_000) {
    if (existingSet.has(t)) continue;
    const eq = Math.max(0.01, equityAt(t));
    rows.push({ ts: new Date(t).toISOString(), eq: parseFloat(eq.toFixed(6)) });
  }
  console.log(`Filas sintéticas a insertar: ${rows.length}`);

  if (rows.length === 0) {
    console.log("Nada que insertar — ya hay snapshot por minuto en la ventana.");
    return;
  }

  // 7. Bulk insert con unnest (más rápido que loop de inserts)
  const tss = rows.map(r => r.ts);
  const eqs = rows.map(r => r.eq);
  await sql`
    INSERT INTO balance_snapshots
      (balance, equity, available, num_positions, margin_heat_pct, created_at)
    SELECT eq, eq, eq, 0, 0, ts::timestamptz
    FROM unnest(${eqs}::numeric[], ${tss}::text[]) AS u(eq, ts)
  `;
  console.log(`✅ Insertadas ${rows.length} filas sintéticas.`);

  // 8. Verificar
  const totalNow = await sql`SELECT COUNT(*)::int AS n FROM balance_snapshots`;
  console.log(`\nTotal balance_snapshots ahora: ${totalNow[0].n}`);

  const inLastHour = await sql`
    SELECT COUNT(*)::int AS n
    FROM balance_snapshots
    WHERE created_at >= NOW() - INTERVAL '1 hour'
  `;
  console.log(`Filas en la última hora: ${inLastHour[0].n}`);

  const inLast6h = await sql`
    SELECT COUNT(*)::int AS n
    FROM balance_snapshots
    WHERE created_at >= NOW() - INTERVAL '6 hours'
  `;
  console.log(`Filas en las últimas 6h: ${inLast6h[0].n}`);

  console.log("\n== DONE ==");
}

run().catch(e => { console.error("FAILED:", e); process.exit(1); });
