/**
 * Alertas de Tanit por Telegram — eventos críticos llegan al teléfono
 * de Luis al instante, sin necesidad de tener la app abierta.
 *
 * Eventos cableados:
 *  - Trade abierto (long/short con tesis)
 *  - Trade cerrado (con PnL)
 *  - Decisión bloqueada por governance (qué intentó, qué regla violó)
 *  - Kill-switch activado/desactivado
 *  - Reporte diario (resumen de decisiones + PnL del día)
 *
 * Todas son fire-and-forget — si Telegram falla, no rompe el flujo.
 * El error se loguea pero la operación sigue.
 */
import { sendTelegram } from "./telegram";
import { isTestnet } from "./bybit-auth";
import { pool } from "@workspace/db";
import { logger } from "./logger";

function envBadge(): string {
  return isTestnet() ? "🧪 TESTNET" : "💵 MAINNET";
}

function safeSend(msg: string): void {
  sendTelegram(msg).catch((e) =>
    logger.warn({ err: e?.message ?? String(e) }, "[alerts] Telegram falló (no crítico)"),
  );
}

export function alertTradeOpened(args: {
  symbol: string;
  side: "long" | "short";
  sizeUsd: number;
  leverage: number;
  orderId: string;
  qty: string;
  thesis: string;
}): void {
  const arrow = args.side === "long" ? "🟢 LONG" : "🔴 SHORT";
  const msg = [
    `${arrow} <b>abierto</b> · ${envBadge()}`,
    ``,
    `<b>${args.symbol}</b>  $${args.sizeUsd.toFixed(2)} · ${args.leverage}x`,
    `qty: <code>${args.qty}</code>`,
    `order: <code>${args.orderId}</code>`,
    ``,
    `<i>Tesis:</i> ${args.thesis}`,
  ].join("\n");
  safeSend(msg);
}

export function alertTradeClosed(args: {
  symbol: string;
  side: "long" | "short";
  pnl: number | null;
  razon: string;
}): void {
  const arrow = args.side === "long" ? "🟢→⚫" : "🔴→⚫";
  const pnlStr =
    args.pnl !== null
      ? args.pnl >= 0
        ? `<b>+$${args.pnl.toFixed(4)}</b>  ✨`
        : `<b>-$${Math.abs(args.pnl).toFixed(4)}</b>  💧`
      : "PnL pendiente de actualizar";
  const msg = [
    `${arrow} <b>cerrado</b> · ${envBadge()}`,
    ``,
    `<b>${args.symbol}</b>  ${pnlStr}`,
    ``,
    `<i>Razón:</i> ${args.razon}`,
  ].join("\n");
  safeSend(msg);
}

export function alertGovernanceBlocked(args: {
  symbol: string;
  side: "long" | "short";
  sizeUsd: number;
  leverage: number;
  rule: string;
  reason: string;
}): void {
  const msg = [
    `🛡️ <b>Governance bloqueó orden</b>`,
    ``,
    `${args.side.toUpperCase()} ${args.symbol} $${args.sizeUsd.toFixed(2)} · ${args.leverage}x`,
    `Regla: <code>${args.rule}</code>`,
    `${args.reason}`,
  ].join("\n");
  safeSend(msg);
}

export function alertKillSwitch(args: { on: boolean; reason: string; actor: string }): void {
  const msg = args.on
    ? [
        `🔴 <b>KILL-SWITCH ACTIVADO</b>`,
        ``,
        `Toda escritura a Bybit BLOQUEADA hasta desactivar.`,
        ``,
        `<i>Por:</i> ${args.actor}`,
        `<i>Razón:</i> ${args.reason}`,
      ].join("\n")
    : [
        `🟢 <b>Kill-switch desactivado</b>`,
        ``,
        `Operación reanudada.`,
        ``,
        `<i>Por:</i> ${args.actor}`,
        `<i>Razón:</i> ${args.reason}`,
      ].join("\n");
  safeSend(msg);
}

interface DailyStats {
  totalDecisions: number;
  executed: number;
  blocked: number;
  needsConfirmation: number;
  rejected: number;
  pnlDay: number;
  topSymbols: { symbol: string; count: number }[];
}

async function fetchDailyStats(): Promise<DailyStats> {
  const r = await pool.query<{ verdict: string; n: number; symbol: string | null }>(
    `SELECT verdict, COUNT(*)::int AS n, symbol
       FROM tanit_decisions
      WHERE created_at >= now() - INTERVAL '24 hours'
        AND symbol IS NOT NULL
   GROUP BY verdict, symbol`,
  );
  let executed = 0,
    blocked = 0,
    needsConfirmation = 0,
    rejected = 0,
    total = 0;
  const symCount: Record<string, number> = {};
  for (const row of r.rows) {
    total += row.n;
    if (row.verdict === "executed") executed += row.n;
    else if (row.verdict === "blocked") blocked += row.n;
    else if (row.verdict === "needs_confirmation") needsConfirmation += row.n;
    else if (row.verdict === "rejected") rejected += row.n;
    if (row.symbol) symCount[row.symbol] = (symCount[row.symbol] ?? 0) + row.n;
  }
  const topSymbols = Object.entries(symCount)
    .map(([symbol, count]) => ({ symbol, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  // PnL del día — sum de execution events. Aproximación basada en context jsonb.
  const pnlR = await pool.query<{ pnl: string }>(
    `SELECT COALESCE(SUM((context->>'closedPnl')::numeric), 0)::text AS pnl
       FROM tanit_decisions
      WHERE verdict = 'executed'
        AND decision_type = 'close_position'
        AND created_at >= now() - INTERVAL '24 hours'`,
  );
  const pnlDay = parseFloat(pnlR.rows[0]?.pnl ?? "0") || 0;

  return { totalDecisions: total, executed, blocked, needsConfirmation, rejected, pnlDay, topSymbols };
}

export async function sendDailyReport(): Promise<void> {
  try {
    const s = await fetchDailyStats();
    const lines = [
      `📊 <b>Tanit · reporte 24h</b> · ${envBadge()}`,
      ``,
      `Decisiones: <b>${s.totalDecisions}</b>`,
      `  ✅ ejecutadas: ${s.executed}`,
      `  🛡️ bloqueadas: ${s.blocked}`,
      `  ⏸️ esperando confirmación: ${s.needsConfirmation}`,
      `  ❌ rechazadas: ${s.rejected}`,
      ``,
      `PnL cerrado en 24h: ${s.pnlDay >= 0 ? "<b>+" : "<b>"}$${s.pnlDay.toFixed(4)}</b>`,
    ];
    if (s.topSymbols.length > 0) {
      lines.push(``, `Símbolos activos: ${s.topSymbols.map((t) => `${t.symbol}(${t.count})`).join(" · ")}`);
    }
    safeSend(lines.join("\n"));
  } catch (e) {
    logger.warn({ err: e }, "[alerts] sendDailyReport falló");
  }
}

let _dailyHandle: NodeJS.Timeout | null = null;

/**
 * Arranca el reporte diario. El primer reporte sale 6h después del start
 * (no inmediato) y luego cada 24h. Idempotente.
 */
export function startDailyReports(): void {
  if (_dailyHandle !== null) return;
  const SIX_HOURS = 6 * 60 * 60_000;
  const ONE_DAY = 24 * 60 * 60_000;
  setTimeout(() => {
    sendDailyReport().catch(() => {});
    _dailyHandle = setInterval(() => {
      sendDailyReport().catch(() => {});
    }, ONE_DAY);
  }, SIX_HOURS);
  logger.info("[alerts] reportes diarios arrancados (primero en 6h)");
}

export function stopDailyReports(): void {
  if (_dailyHandle !== null) {
    clearInterval(_dailyHandle);
    _dailyHandle = null;
  }
}
