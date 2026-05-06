import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);

const total24h = await sql`SELECT COUNT(*)::int n FROM guardrail_events WHERE created_at > NOW() - INTERVAL '24 hours'`;
console.log("TOTAL guardrail_events últimas 24h:", total24h[0].n);

const byType = await sql`
  SELECT event_type, COUNT(*)::int AS n
  FROM guardrail_events
  WHERE created_at > NOW() - INTERVAL '24 hours'
  GROUP BY event_type
  ORDER BY n DESC
  LIMIT 20
`;
console.log("\nDesglose por event_type (últimas 24h):");
for (const r of byType) console.log(`  ${r.event_type.padEnd(35)} ${r.n}`);

const byHour = await sql`
  SELECT date_trunc('hour', created_at) AS h, COUNT(*)::int AS n
  FROM guardrail_events
  WHERE created_at > NOW() - INTERVAL '24 hours'
  GROUP BY h
  ORDER BY h DESC
  LIMIT 24
`;
console.log("\nDesglose por hora (últimas 24h):");
for (const r of byHour) console.log(`  ${r.h.toISOString().slice(0,16)}Z  ${String(r.n).padStart(6)}`);

const recent6 = await sql`
  SELECT event_type, symbol, lesson_ref, created_at
  FROM guardrail_events
  ORDER BY created_at DESC
  LIMIT 8
`;
console.log("\n8 más recientes:");
for (const r of recent6) console.log(`  ${r.created_at.toISOString().slice(11,19)}  ${r.event_type.padEnd(28)} ${(r.symbol ?? "—").padEnd(12)} ${r.lesson_ref ?? ""}`);
