/**
 * Motor Ejecutor Determinista — el "musculo" que ejecuta lo que Tanit dicta.
 *
 * FILOSOFÍA: cero LLM. Cero scoring. Cero decisiones propias. Solo cumple
 * instrucciones de Tanit con precisión militar. Si Tanit no instruye, NO
 * opera. Esto es lo que da velocidad real (segundos por trade) sin pasar
 * cada uno por una llamada a Gemini de 30+ segundos.
 *
 * MODELO:
 *  - Tanit invoca `instruir_motor_ejecutor(...)` con parámetros concretos.
 *  - El motor guarda esa "campaign" activa.
 *  - El motor late cada N segundos según la campaign:
 *    - Si frecuencia=30s, abre/escala/cierra cada 30s siguiendo la campaign.
 *    - Cada acción usa SL/TP explícitos de la campaign.
 *    - Cuando la campaign expira o Tanit la pausa, motor para.
 *  - Si kill_switch_global está ON, motor NO opera.
 *
 * CAMPAIGN — qué contiene:
 *  - symbol: BTCUSDT, ETHUSDT, etc.
 *  - direction: long | short
 *  - leverage: 5-20
 *  - sl_price: precio absoluto del SL (Motor 5 tesis)
 *  - tp1_price, tp2_price, tp3_price: precios escalonados
 *  - size_per_entry_usd: cuánto invertir por entrada
 *  - max_concurrent: cuántas posiciones de esta campaign abrir simultáneas
 *  - frequency_seconds: cada cuántos segundos evaluar reentrada
 *  - duration_minutes: por cuánto tiempo correr la campaign
 *  - max_trades: cap de total trades en la campaign
 *  - reason: razonamiento de Tanit (audit)
 *
 * Una campaign vive en memoria del proceso. Si Railway redeploya, se pierde
 * (correcto — al boot Tanit decide si quiere re-emitir).
 */

import { logger } from "./logger";
import { getRules } from "./governance";
import {
  placeMarketOrderWithSL,
  getOpenPositions,
  getMarkPrice,
  invalidateBalanceCache,
  getBybitBalance,
  calcQtyReal,
  setLeverage,
} from "./bybit-auth";

export type EjecutorDirection = "long" | "short";

export interface EjecutorCampaign {
  id: string;
  symbol: string;
  direction: EjecutorDirection;
  leverage: number;
  slPrice: number;
  tp1Price: number | null;
  tp2Price: number | null;
  tp3Price: number | null;
  sizePerEntryUsd: number;
  maxConcurrent: number;
  frequencySeconds: number;
  durationMinutes: number;
  maxTrades: number;
  reason: string;
  startedAt: number;
  endsAt: number;
  tradesExecuted: number;
  tradesFailed: number;
  lastTickTs: number;
  status: "active" | "paused" | "completed" | "killed";
  killReason: string | null;
}

let _activeCampaign: EjecutorCampaign | null = null;
let _tickTimer: NodeJS.Timeout | null = null;

/**
 * Tanit instruye al motor. Sobrescribe campaign activa (si la hay).
 */
export function instruir(args: {
  symbol: string;
  direction: EjecutorDirection;
  leverage: number;
  slPrice: number;
  tp1Price?: number;
  tp2Price?: number;
  tp3Price?: number;
  sizePerEntryUsd: number;
  maxConcurrent: number;
  frequencySeconds: number;
  durationMinutes: number;
  maxTrades: number;
  reason: string;
}): { ok: true; campaignId: string } | { ok: false; error: string } {
  // Validación mínima — no son "reglas duras de Luis", son sanity checks
  // del motor para no romperse a sí mismo.
  if (args.leverage < 1 || args.leverage > 100) {
    return { ok: false, error: `leverage fuera de rango: ${args.leverage}` };
  }
  if (args.slPrice <= 0) {
    return { ok: false, error: "slPrice debe ser > 0 (precio absoluto USD)" };
  }
  if (args.frequencySeconds < 5 || args.frequencySeconds > 3600) {
    return { ok: false, error: `frequencySeconds fuera de rango (5-3600): ${args.frequencySeconds}` };
  }
  if (args.durationMinutes < 1 || args.durationMinutes > 720) {
    return { ok: false, error: `durationMinutes fuera de rango (1-720): ${args.durationMinutes}` };
  }
  if (args.maxTrades < 1 || args.maxTrades > 500) {
    return { ok: false, error: `maxTrades fuera de rango (1-500): ${args.maxTrades}` };
  }

  const id = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  _activeCampaign = {
    id,
    symbol: args.symbol,
    direction: args.direction,
    leverage: args.leverage,
    slPrice: args.slPrice,
    tp1Price: args.tp1Price ?? null,
    tp2Price: args.tp2Price ?? null,
    tp3Price: args.tp3Price ?? null,
    sizePerEntryUsd: args.sizePerEntryUsd,
    maxConcurrent: args.maxConcurrent,
    frequencySeconds: args.frequencySeconds,
    durationMinutes: args.durationMinutes,
    maxTrades: args.maxTrades,
    reason: args.reason,
    startedAt: now,
    endsAt: now + args.durationMinutes * 60_000,
    tradesExecuted: 0,
    tradesFailed: 0,
    lastTickTs: 0,
    status: "active",
    killReason: null,
  };
  logger.info({ campaign: _activeCampaign }, "[motor-ejecutor] campaña activada por Tanit");
  ensureTimer();
  return { ok: true, campaignId: id };
}

/** Tanit pausa el motor — campaign queda paused. */
export function pausar(reason: string): { ok: boolean; previousStatus: string | null } {
  if (!_activeCampaign) return { ok: false, previousStatus: null };
  const prev = _activeCampaign.status;
  _activeCampaign.status = "paused";
  _activeCampaign.killReason = reason;
  logger.info({ campaignId: _activeCampaign.id, reason }, "[motor-ejecutor] pausada por Tanit");
  return { ok: true, previousStatus: prev };
}

/** Tanit consulta status del motor. */
export function status(): {
  hasCampaign: boolean;
  campaign: EjecutorCampaign | null;
  killSwitch: boolean;
  timeLeftMinutes: number | null;
} {
  if (!_activeCampaign) {
    return { hasCampaign: false, campaign: null, killSwitch: false, timeLeftMinutes: null };
  }
  const timeLeft = Math.max(0, _activeCampaign.endsAt - Date.now()) / 60_000;
  return {
    hasCampaign: true,
    campaign: _activeCampaign,
    killSwitch: false, // se actualiza en el tick real
    timeLeftMinutes: Math.round(timeLeft * 100) / 100,
  };
}

function ensureTimer(): void {
  if (_tickTimer) return;
  _tickTimer = setInterval(tick, 1_000);
  _tickTimer.unref?.();
}

async function tick(): Promise<void> {
  if (!_activeCampaign || _activeCampaign.status !== "active") return;

  const now = Date.now();

  // ¿Expiró duración?
  if (now >= _activeCampaign.endsAt) {
    _activeCampaign.status = "completed";
    _activeCampaign.killReason = "duración cumplida";
    logger.info({ campaignId: _activeCampaign.id }, "[motor-ejecutor] campaña completada por duración");
    return;
  }

  // ¿Alcanzó max trades?
  if (_activeCampaign.tradesExecuted >= _activeCampaign.maxTrades) {
    _activeCampaign.status = "completed";
    _activeCampaign.killReason = "max_trades alcanzado";
    logger.info({ campaignId: _activeCampaign.id }, "[motor-ejecutor] campaña completada por max_trades");
    return;
  }

  // ¿Kill switch global ON?
  try {
    const rules = await getRules({ force: false });
    if (rules.kill_switch_global === true) {
      _activeCampaign.status = "killed";
      _activeCampaign.killReason = "kill_switch_global ON";
      logger.warn({ campaignId: _activeCampaign.id }, "[motor-ejecutor] kill_switch global activado — motor detenido");
      return;
    }
  } catch (e) {
    // si no podemos leer governance, mejor pausamos para no operar a ciegas
    _activeCampaign.status = "paused";
    _activeCampaign.killReason = `error leyendo governance: ${e instanceof Error ? e.message : String(e)}`;
    return;
  }

  // ¿Toca operar (frecuencia respetada)?
  const secondsSinceLastTick = (now - _activeCampaign.lastTickTs) / 1_000;
  if (_activeCampaign.lastTickTs > 0 && secondsSinceLastTick < _activeCampaign.frequencySeconds) {
    return;
  }
  _activeCampaign.lastTickTs = now;

  // ═══ EJECUCIÓN REAL ═══
  try {
    // 1) ¿ya hay posición abierta de esta campaign?
    const positions = await getOpenPositions();
    const samePositions = positions.filter((p: { symbol: string; side: string; size?: string }) => {
      if (p.symbol !== _activeCampaign!.symbol) return false;
      const sideMatch = _activeCampaign!.direction === "long" ? p.side === "Buy" : p.side === "Sell";
      return sideMatch && parseFloat(p.size ?? "0") > 0;
    });
    if (samePositions.length >= _activeCampaign.maxConcurrent) {
      // Llenas el cap — espera tick siguiente.
      return;
    }

    // 2) verificar margen disponible
    invalidateBalanceCache();
    const bal = await getBybitBalance();
    const requiredMargin = _activeCampaign.sizePerEntryUsd / _activeCampaign.leverage * 1.10;
    if (!bal || bal.available < requiredMargin) {
      logger.warn(
        { campaignId: _activeCampaign.id, required: requiredMargin, available: bal?.available },
        "[motor-ejecutor] margen insuficiente — skip tick",
      );
      _activeCampaign.tradesFailed++;
      return;
    }

    // 3) obtener mark price
    const markPrice = await getMarkPrice(_activeCampaign.symbol);
    if (!markPrice) {
      logger.warn({ campaignId: _activeCampaign.id, symbol: _activeCampaign.symbol }, "[motor-ejecutor] no mark price");
      _activeCampaign.tradesFailed++;
      return;
    }

    // 4) verificar que SL está al lado correcto del mark
    if (_activeCampaign.direction === "long" && _activeCampaign.slPrice >= markPrice) {
      logger.warn({ campaignId: _activeCampaign.id, sl: _activeCampaign.slPrice, mark: markPrice }, "[motor-ejecutor] SL inválido para LONG (SL >= mark)");
      _activeCampaign.tradesFailed++;
      _activeCampaign.status = "paused";
      _activeCampaign.killReason = `SL ${_activeCampaign.slPrice} inválido para LONG con mark ${markPrice}`;
      return;
    }
    if (_activeCampaign.direction === "short" && _activeCampaign.slPrice <= markPrice) {
      logger.warn({ campaignId: _activeCampaign.id, sl: _activeCampaign.slPrice, mark: markPrice }, "[motor-ejecutor] SL inválido para SHORT (SL <= mark)");
      _activeCampaign.tradesFailed++;
      _activeCampaign.status = "paused";
      _activeCampaign.killReason = `SL ${_activeCampaign.slPrice} inválido para SHORT con mark ${markPrice}`;
      return;
    }

    // 5) calcular qty
    const qty = await calcQtyReal(_activeCampaign.symbol, _activeCampaign.sizePerEntryUsd, _activeCampaign.leverage, markPrice);
    if (!qty) {
      logger.warn({ campaignId: _activeCampaign.id }, "[motor-ejecutor] no se pudo calcular qty");
      _activeCampaign.tradesFailed++;
      return;
    }

    // 6) setear leverage
    await setLeverage(_activeCampaign.symbol, _activeCampaign.leverage).catch(() => {});

    // 7) abrir con SL inline
    const result = await placeMarketOrderWithSL({
      symbol: _activeCampaign.symbol,
      side: _activeCampaign.direction === "long" ? "Buy" : "Sell",
      qty,
      stopLossPrice: _activeCampaign.slPrice,
      takeProfitPrice: _activeCampaign.tp1Price ?? undefined,
    });

    if (result.ok) {
      _activeCampaign.tradesExecuted++;
      logger.info(
        {
          campaignId: _activeCampaign.id,
          orderId: result.orderId,
          symbol: _activeCampaign.symbol,
          side: _activeCampaign.direction,
          qty,
          sl: _activeCampaign.slPrice,
          tp: _activeCampaign.tp1Price,
          tradesExecuted: _activeCampaign.tradesExecuted,
        },
        "[motor-ejecutor] ✅ trade ejecutado",
      );
    } else {
      _activeCampaign.tradesFailed++;
      logger.warn(
        { campaignId: _activeCampaign.id, retCode: result.retCode, retMsg: result.retMsg },
        "[motor-ejecutor] ❌ trade rechazado por Bybit",
      );
    }
  } catch (e) {
    _activeCampaign.tradesFailed++;
    logger.error({ campaignId: _activeCampaign.id, err: e instanceof Error ? e.message : String(e) }, "[motor-ejecutor] tick error");
  }
}
