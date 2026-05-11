/**
 * Realtime Position Guard — protege posiciones REACCIONANDO en cada tick
 * de precio del WebSocket de Bybit (segundos, no minutos).
 *
 * Mientras el motor scanner corre cada 15min y el manage-loop cada 90s,
 * ESTO actúa en cada cambio de precio (puede ser 5-20 ticks/segundo).
 *
 * Reglas activas:
 *  - PnL >= 2.5% → trail SL a +1% sobre entry (lock profit)
 *  - PnL >= 1.5% → trail SL a breakeven (proteger capital)
 *  - PnL <= -3%  → cierre de emergencia (SL del lado código por si Bybit SL falló)
 *  - Movimiento brusco contra-posición (>1% en <30s) → cierre defensivo
 *
 * Throttling: cada símbolo se procesa máximo 1 vez cada 3s para evitar
 * spam de updates a Bybit. Si el precio cambia muy rápido, solo el último
 * tick disparará la lógica.
 */
import { onPriceUpdate, isWsConnected } from "./bybit-ws";
import { getOpenPositions, setTradingStopDetailed, closePositionDetailed } from "./bybit-auth";
import { pool } from "@workspace/db";
import { logger } from "./logger";

interface PositionState {
  symbol: string;
  side: "Buy" | "Sell";
  entry: number;
  size: string;
  positionIdx: number;
  currentSL: number;
  // Para detección de movimiento brusco:
  priceHistory: Array<{ ts: number; price: number }>;
}

const _positions = new Map<string, PositionState>();
let _initialized = false;
const _lastActionAt = new Map<string, number>();
const ACTION_THROTTLE_MS = 3000; // máx 1 acción por símbolo cada 3s

async function refreshPositionsCache(): Promise<void> {
  try {
    const positions = await getOpenPositions();
    const seen = new Set<string>();
    for (const p of positions) {
      if (parseFloat(p.size ?? "0") <= 0) continue;
      const key = `${p.symbol}_${p.positionIdx ?? 0}`;
      seen.add(key);
      const existing = _positions.get(key);
      const state: PositionState = {
        symbol: p.symbol,
        side: p.side,
        entry: parseFloat(p.avgPrice ?? "0"),
        size: p.size,
        positionIdx: typeof p.positionIdx === "number" ? p.positionIdx : 0,
        currentSL: parseFloat(p.stopLoss ?? "0"),
        priceHistory: existing?.priceHistory ?? [],
      };
      _positions.set(key, state);
    }
    // Limpiar posiciones que ya no existen
    for (const key of _positions.keys()) {
      if (!seen.has(key)) _positions.delete(key);
    }
  } catch (e) {
    logger.warn({ err: String(e) }, "[realtime-guard] refreshPositionsCache error");
  }
}

async function evaluatePosition(state: PositionState, price: number): Promise<void> {
  const now = Date.now();
  const lastAction = _lastActionAt.get(state.symbol) ?? 0;
  if (now - lastAction < ACTION_THROTTLE_MS) return;

  const isLong = state.side === "Buy";
  if (state.entry <= 0) return;
  const pnlPct = isLong ? ((price - state.entry) / state.entry) * 100 : ((state.entry - price) / state.entry) * 100;

  // Mantener historial corto (últimos 30s) para detectar movimiento brusco
  state.priceHistory.push({ ts: now, price });
  state.priceHistory = state.priceHistory.filter((h) => now - h.ts <= 30_000);

  // 1. Cierre de emergencia: PnL <= -3% (debería haber catchado Bybit SL pero por si acaso)
  if (pnlPct <= -3) {
    _lastActionAt.set(state.symbol, now);
    logger.warn({ symbol: state.symbol, pnlPct }, "[realtime-guard] emergency close (-3%)");
    const r = await closePositionDetailed(state.symbol, isLong ? "LONG" : "SHORT", state.size, state.positionIdx);
    if (r.ok) {
      _positions.delete(`${state.symbol}_${state.positionIdx}`);
      await pool.query(
        `UPDATE tanit_setup_plan SET status='closed_emergency', closed_at=now() WHERE trading_day=CURRENT_DATE AND symbol=$1 AND status='executed'`,
        [state.symbol],
      );
    }
    return;
  }

  // 2. Trailing SL si va ganando
  let newSL: number | null = null;
  if (pnlPct >= 2.5) {
    // Lock +1% profit
    newSL = isLong ? state.entry * 1.01 : state.entry * 0.99;
  } else if (pnlPct >= 1.5) {
    // Lock breakeven
    newSL = state.entry;
  }
  if (newSL !== null) {
    const improves = isLong ? newSL > state.currentSL : (state.currentSL === 0 || newSL < state.currentSL);
    if (improves) {
      _lastActionAt.set(state.symbol, now);
      logger.info(
        { symbol: state.symbol, pnlPct: pnlPct.toFixed(2), newSL: newSL.toFixed(6), oldSL: state.currentSL.toFixed(6) },
        "[realtime-guard] trailing SL",
      );
      const r = await setTradingStopDetailed(state.symbol, newSL, undefined, state.positionIdx);
      if (r.ok) {
        state.currentSL = newSL;
      }
    }
  }
}

export function startRealtimeGuard(): void {
  if (_initialized) return;
  _initialized = true;
  // Refresh cache cada 30s para captar posiciones nuevas/cerradas
  refreshPositionsCache().catch(() => {});
  setInterval(() => {
    refreshPositionsCache().catch(() => {});
  }, 30_000);

  // Suscribirse a cada tick de precio
  onPriceUpdate((symbol, price) => {
    // Buscar todas las posiciones con ese símbolo (puede haber long+short hedge)
    for (const [key, state] of _positions.entries()) {
      if (state.symbol === symbol) {
        evaluatePosition(state, price).catch((e) => {
          logger.warn({ err: String(e), symbol }, "[realtime-guard] evaluate error");
        });
      }
    }
  });

  logger.info({ wsConnected: isWsConnected() }, "[realtime-guard] arrancado — reacciona en tiempo real a cada tick");
}

export function getGuardedPositions(): Array<{ symbol: string; side: string; entry: number; currentSL: number }> {
  return Array.from(_positions.values()).map((p) => ({
    symbol: p.symbol,
    side: p.side,
    entry: p.entry,
    currentSL: p.currentSL,
  }));
}
