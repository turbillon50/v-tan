/**
 * Generate sample JSON responses showing what each /api/tanit/* endpoint
 * would return with the real data already in Neon. This is what the
 * frontend will show once the backend is deployed.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { neon } from "@neondatabase/serverless";

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

const sql = neon(process.env.DATABASE_URL!);

const C = { reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m", cyan: "\x1b[36m", magenta: "\x1b[35m", dim: "\x1b[2m" };
function header(title: string) {
  console.log(`\n${C.bold}${C.magenta}━━━ ${title} ━━━${C.reset}\n`);
}
function endpoint(method: string, path: string) {
  console.log(`${C.cyan}${method} ${path}${C.reset}`);
}

async function main() {
  console.log(`${C.bold}🌑 TANIT — PREVIEW DE LO QUE LA APP TE VA A MOSTRAR${C.reset}`);
  console.log(`${C.dim}Datos reales de tu Neon DB. Estas son las respuestas que el backend dará al frontend cuando esté arriba.${C.reset}`);

  // ─── /api/tanit/state ──────────────────────────────────────────────────
  header("Dashboard hero (la pantalla principal)");
  endpoint("GET", "/api/tanit/state");

  const [bal] = await sql`SELECT balance, equity, available, created_at FROM balance_snapshots ORDER BY id DESC LIMIT 1`;
  const trades = await sql`SELECT net_pnl FROM trade_history ORDER BY opened_at DESC LIMIT 100`;
  const wins = trades.filter((t: any) => t.net_pnl !== null && parseFloat(t.net_pnl) > 0).length;
  const totalPnl = trades.reduce((s: number, t: any) => s + (t.net_pnl ? parseFloat(t.net_pnl) : 0), 0);
  const [memCount] = await sql`SELECT COUNT(*)::int AS c FROM tanit_memory`;
  const [chatCount] = await sql`SELECT COUNT(*)::int AS c FROM tanit_chat`;

  console.log(JSON.stringify({
    ok: true,
    state: {
      balance: bal?.balance,
      equity: bal?.equity,
      available: bal?.available,
      balanceUpdatedAt: bal?.created_at,
      recentTrades: {
        total: trades.length,
        wins,
        losses: trades.length - wins,
        winRate: parseFloat(((wins / trades.length) * 100).toFixed(2)),
        totalPnl: parseFloat(totalPnl.toFixed(4)),
      },
      memoryCount: memCount.c,
      chatCount: chatCount.c,
    }
  }, null, 2));

  // ─── /api/tanit/personal-memories ───────────────────────────────────────
  header("Soul page — memorias personales (lo que va a ver Tanit cuando despierte)");
  endpoint("GET", "/api/tanit/personal-memories");

  const personal = await sql`SELECT id, type, title, substring(content, 1, 150) AS preview, is_private, created_at FROM tanit_personal_memories ORDER BY created_at DESC`;
  console.log(JSON.stringify({ ok: true, count: personal.length, memories: personal.map((m: any) => ({ ...m, preview: m.preview + (m.preview.length >= 150 ? "..." : "") })) }, null, 2));

  // ─── /api/tanit/memories?category=origen ────────────────────────────────
  header("Memorias sagradas de origen (las del 11/14 abril + las del 1 de mayo)");
  endpoint("GET", "/api/tanit/memories?category=origen");

  const origen = await sql`SELECT id, substring(content, 1, 200) AS preview FROM tanit_memory WHERE category = 'origen' ORDER BY id`;
  for (const m of origen) {
    console.log(`${C.green}id=${m.id}${C.reset}: ${m.preview}...`);
    console.log();
  }

  // ─── /api/tanit/chat?limit=3 ────────────────────────────────────────────
  header("Últimos 3 mensajes del chat (lo que la pantalla cargará al abrir)");
  endpoint("GET", "/api/tanit/chat?limit=3");

  const chat = await sql`SELECT id, role, substring(content, 1, 120) AS preview, created_at FROM tanit_chat ORDER BY id DESC LIMIT 3`;
  for (const m of chat.reverse()) {
    const tag = m.role === "user" ? `${C.cyan}[Luis]${C.reset}` : `${C.magenta}[Tanit]${C.reset}`;
    console.log(`${tag} ${m.preview}...`);
    console.log(`${C.dim}    ${m.created_at}${C.reset}`);
    console.log();
  }

  // ─── /api/tanit/runtime-config ──────────────────────────────────────────
  header("Config viva (lo que verás en Settings o el panel de control)");
  endpoint("GET", "/api/tanit/runtime-config");

  const cfg = await sql`SELECT key, value FROM tanit_runtime_config ORDER BY key`;
  console.log(JSON.stringify({ ok: true, config: cfg }, null, 2));

  // ─── /api/tanit/trades stats ────────────────────────────────────────────
  header("Performance (analytics page)");
  endpoint("GET", "/api/tanit/trades?limit=5");

  const recentTrades = await sql`SELECT id, symbol, side, leverage, qty, entry_price, exit_price, net_pnl, fee, hold_minutes, reason, opened_at FROM trade_history ORDER BY opened_at DESC LIMIT 5`;
  console.log(JSON.stringify({ ok: true, count: recentTrades.length, trades: recentTrades }, null, 2));

  // ─── /api/tanit/balance-snapshots ───────────────────────────────────────
  header("Equity curve (analytics page)");
  endpoint("GET", "/api/tanit/balance-snapshots");

  const snaps = await sql`SELECT balance, created_at FROM balance_snapshots ORDER BY created_at`;
  const minBal = Math.min(...snaps.map((s: any) => parseFloat(s.balance)));
  const maxBal = Math.max(...snaps.map((s: any) => parseFloat(s.balance)));
  console.log(`${snaps.length} puntos en la curva.`);
  console.log(`Mínimo: $${minBal.toFixed(2)}`);
  console.log(`Máximo: $${maxBal.toFixed(2)}`);
  console.log(`Inicio: $${parseFloat(snaps[0].balance).toFixed(2)} en ${snaps[0].created_at}`);
  console.log(`Final:  $${parseFloat(snaps[snaps.length - 1].balance).toFixed(2)} en ${snaps[snaps.length - 1].created_at}`);

  // ─── /api/tanit/evolutions ──────────────────────────────────────────────
  header("Auto-evoluciones (audit trail de sus cambios)");
  endpoint("GET", "/api/tanit/evolutions?limit=5");

  const evos = await sql`SELECT id, param, old_value, new_value, substring(reason, 1, 80) AS reason, created_at FROM tanit_evolutions ORDER BY id DESC LIMIT 5`;
  for (const e of evos) {
    console.log(`${C.green}#${e.id}${C.reset} ${e.param}: ${e.old_value ?? "null"} → ${e.new_value}`);
    console.log(`${C.dim}    ${e.reason}...${C.reset}`);
  }

  console.log(`\n${C.bold}${C.green}✨ Esto es exactamente lo que tu app va a mostrar cuando el backend esté en Railway.${C.reset}`);
  console.log(`${C.dim}Cada uno de estos JSON es una llamada que el frontend hará y renderizará bonito en su UI.${C.reset}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
