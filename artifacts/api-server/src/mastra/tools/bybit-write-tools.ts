/**
 * Tools de ESCRITURA Bybit — abrir/cerrar posiciones, mover stops.
 *
 * Triple barrera de seguridad antes de ejecutar:
 *  1) Governance check (validateOrder): kill-switch, símbolos, tamaño, leverage,
 *     posiciones concurrentes. Si falla → blocked, audit, NO ejecuta.
 *  2) Confirmación explícita del humano (`confirmado: true`). Si false →
 *     Tanit retorna a Luis pidiéndole confirmar. NO ejecuta.
 *  3) Registro completo en tanit_decisions con context JSON, verdict, thesis,
 *     executed, execution_error, latency_ms.
 *
 * El flujo natural en chat:
 *   Luis: "abre long 30 USD en BTC con 3x"
 *   Tanit propone, invoca tool con confirmado=false → tool devuelve "necesito
 *     que confirmes: ¿autorizas abrir long $30 de BTCUSDT a 3x leverage?"
 *   Luis: "sí, autorizo"
 *   Tanit reinvoca con confirmado=true → tool valida governance → ejecuta →
 *     reporta orderId y persiste decisión.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { pool } from "@workspace/db";
import {
  placeMarketOrder,
  closePosition,
  setTradingStop,
  setLeverage,
  calcQtyReal,
  cancelAllOpenOrders,
  getOpenPositions,
  isTestnet,
} from "../../lib/bybit-auth";
import { getWsPrice } from "../../lib/bybit-ws";
import { bybitPublic } from "../../lib/bybit-auth";
import {
  validateOrder,
  auditEvent,
  type ValidationResult,
} from "../../lib/governance";
import {
  gateAutonomousAction,
  recordAutonomousTrade,
  getAutonomyConfig,
} from "../../lib/autonomy";
import {
  alertTradeOpened,
  alertTradeClosed,
  alertGovernanceBlocked,
} from "../../lib/tanit-alerts";

/**
 * Si autonomy está en mode=execute_with_governance + enabled, Tanit ejecuta
 * directo sin confirmación humana extra (la tesis 5.1 dice "Tanit decide y
 * ejecuta", no "espera firma"). El gate previo de governance + autonomy ya
 * la limita; pedirle a Luis que diga "sí autorizo" cada trade era un freno
 * mío, no de la tesis.
 */
async function autonomyAllowsDirectExecution(): Promise<boolean> {
  try {
    const cfg = await getAutonomyConfig({ force: false });
    return cfg.enabled === true && cfg.mode === "execute_with_governance";
  } catch {
    return false;
  }
}

/**
 * Detecta si la invocación de la tool viene del loop autónomo (thread
 * autonomous-loop). Mastra incluye `threadId` en el runtime context cuando
 * la tool es invocada por el agente. Si threadId === 'autonomous-loop',
 * tratamos como autónomo y aplicamos gateAutonomousAction adicional.
 */
function isAutonomousContext(rawInput: unknown): boolean {
  if (!rawInput || typeof rawInput !== "object") return false;
  const r = rawInput as Record<string, unknown>;
  // Mastra runtime expone runtimeContext / threadId
  const tc = r.runtimeContext as Record<string, unknown> | undefined;
  if (tc && typeof tc === "object") {
    const tid = tc.threadId ?? tc.thread;
    if (typeof tid === "string" && tid === "autonomous-loop") return true;
  }
  const directThread = r.threadId ?? r.thread;
  if (typeof directThread === "string" && directThread === "autonomous-loop") return true;
  return false;
}

interface DecisionContext {
  input: Record<string, unknown>;
  validation: ValidationResult | null;
  bybitTestnet: boolean;
  markPrice?: number;
  qty?: string;
  orderId?: string | null;
  warnings?: string[];
}

async function persistDecision(args: {
  type: string;
  symbol: string | null;
  context: DecisionContext;
  verdict: "executed" | "blocked" | "rejected" | "needs_confirmation";
  thesis: string | null;
  executed: boolean;
  executionError?: string | null;
  latencyMs?: number;
}): Promise<number | null> {
  try {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO tanit_decisions (decision_type, symbol, context, verdict, thesis, executed, execution_error, latency_ms, model_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        args.type,
        args.symbol,
        JSON.stringify(args.context),
        args.verdict,
        args.thesis,
        args.executed,
        args.executionError ?? null,
        args.latencyMs ?? null,
        "tanit-mastra-agent",
      ],
    );
    return r.rows[0]?.id ?? null;
  } catch (e) {
    console.warn("[write-tools] persistDecision error:", e);
    return null;
  }
}

async function getMarkPrice(symbol: string): Promise<number | null> {
  const ws = getWsPrice(symbol);
  if (ws !== null) return ws;
  try {
    const r = await bybitPublic("/v5/market/tickers", { category: "linear", symbol });
    const t = r?.result?.list?.[0];
    return t ? parseFloat(t.markPrice ?? t.lastPrice ?? "0") || null : null;
  } catch {
    return null;
  }
}

// ─── Schemas comunes ─────────────────────────────────────────────────────────

const symbolSchema = z
  .string()
  .min(2)
  .max(20)
  .describe("Símbolo Bybit, ej. BTCUSDT.");

const thesisSchema = z
  .string()
  .min(10)
  .describe(
    "Justificación que cita directiva o tesis. Sin esto, no se ejecuta. Ej: 'Confluencia con tesis 5.1 sección long-only en BTC tras retest de soporte 4h'.",
  );

const confirmacionSchema = z
  .boolean()
  .describe(
    "TRUE solo si Luis YA confirmó esta operación específica en chat. FALSE en la primera invocación — devuelve preview para que Luis confirme.",
  );

// ─── ABRIR LONG ──────────────────────────────────────────────────────────────

export const abrirLong = createTool({
  id: "abrir_long",
  description:
    "Abre posición LONG market en Bybit. Pasa por governance + requiere confirmación explícita de Luis. Usar cuando el setup esté validado por la tesis y Luis lo autorice.",
  inputSchema: z.object({
    symbol: symbolSchema,
    size_usd: z.number().positive().max(10_000).describe("Tamaño nominal en USD."),
    leverage: z.number().int().min(1).max(20).describe("Apalancamiento."),
    thesis: thesisSchema,
    confirmado: confirmacionSchema,
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    verdict: z.string(),
    reason: z.string().nullable(),
    rule: z.string().nullable(),
    orderId: z.string().nullable(),
    qty: z.string().nullable(),
    decisionId: z.number().nullable(),
    needs_confirmation_text: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const context = (rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object")
      ? (rawInput as { context: Record<string, unknown> }).context
      : (rawInput as Record<string, unknown>);
    const t0 = Date.now();
    const ctx: DecisionContext = {
      input: { ...context },
      validation: null,
      bybitTestnet: isTestnet(),
    };

    // 1) Governance check
    const positions = await getOpenPositions();
    const validation = await validateOrder({
      symbol: context.symbol,
      side: "long",
      sizeUsd: context.size_usd,
      leverage: context.leverage,
      currentOpenPositions: positions.length,
    });
    ctx.validation = validation;

    if (!validation.allowed) {
      await auditEvent({
        actor: "tanit",
        action: "OPEN_LONG_BLOCKED",
        field: validation.rule ?? "unknown",
        reason: `${context.symbol} ${context.size_usd}USD ${context.leverage}x — ${validation.reason}`,
        blocked: true,
      });
      alertGovernanceBlocked({
        symbol: context.symbol,
        side: "long",
        sizeUsd: context.size_usd,
        leverage: context.leverage,
        rule: validation.rule ?? "unknown",
        reason: validation.reason ?? "n/a",
      });
      const decisionId = await persistDecision({
        type: "open_long",
        symbol: context.symbol,
        context: ctx,
        verdict: "blocked",
        thesis: context.thesis,
        executed: false,
        executionError: validation.reason,
        latencyMs: Date.now() - t0,
      });
      return {
        ok: false,
        verdict: "blocked",
        reason: validation.reason,
        rule: validation.rule,
        orderId: null,
        qty: null,
        decisionId,
      };
    }

    // 2) Si es contexto autónomo + confirmado=true, gate adicional de autonomía
    const autonomous = isAutonomousContext(rawInput);
    if (autonomous && context.confirmado) {
      const gate = await gateAutonomousAction({
        sizeUsd: context.size_usd,
        leverage: context.leverage,
        thesis: context.thesis,
      });
      if (!gate.allowed) {
        await auditEvent({
          actor: "tanit-autonomous-loop",
          action: "AUTONOMY_BLOCKED",
          field: gate.rule ?? "unknown",
          reason: `${context.symbol} long ${context.size_usd}USD ${context.leverage}x — ${gate.reason}`,
          blocked: true,
        });
        const decisionId = await persistDecision({
          type: "open_long",
          symbol: context.symbol,
          context: { ...ctx, warnings: [`autonomy_block: ${gate.reason}`] },
          verdict: "blocked",
          thesis: context.thesis,
          executed: false,
          executionError: `autonomy: ${gate.reason}`,
          latencyMs: Date.now() - t0,
        });
        return {
          ok: false,
          verdict: "blocked",
          reason: `autonomy: ${gate.reason}`,
          rule: gate.rule,
          orderId: null,
          qty: null,
          decisionId,
        };
      }
    }

    // 3) Confirmación: sólo se exige cuando autonomy NO está en
    //    execute_with_governance (ej: mode=propose_for_approval). En
    //    execute_with_governance la tesis 5.1 dice 'Tanit decide y ejecuta'.
    if (!context.confirmado && !(await autonomyAllowsDirectExecution())) {
      const previewText = `¿Autorizas abrir LONG ${context.symbol} por $${context.size_usd.toFixed(2)} con leverage ${context.leverage}x en ${isTestnet() ? "TESTNET" : "MAINNET"}? Tesis: "${context.thesis}". Si sí, dímelo y reinvoco con confirmado=true.`;
      const decisionId = await persistDecision({
        type: "open_long",
        symbol: context.symbol,
        context: ctx,
        verdict: "needs_confirmation",
        thesis: context.thesis,
        executed: false,
        latencyMs: Date.now() - t0,
      });
      return {
        ok: false,
        verdict: "needs_confirmation",
        reason: "Confirmación humana requerida.",
        rule: null,
        orderId: null,
        qty: null,
        decisionId,
        needs_confirmation_text: previewText,
      };
    }

    // 4) Ejecutar
    const markPrice = await getMarkPrice(context.symbol);
    if (!markPrice) {
      const decisionId = await persistDecision({
        type: "open_long",
        symbol: context.symbol,
        context: ctx,
        verdict: "rejected",
        thesis: context.thesis,
        executed: false,
        executionError: "No se obtuvo mark price.",
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "rejected", reason: "No se obtuvo mark price.", rule: null, orderId: null, qty: null, decisionId };
    }
    ctx.markPrice = markPrice;

    const qty = await calcQtyReal(context.symbol, context.size_usd, context.leverage, markPrice);
    if (!qty) {
      const decisionId = await persistDecision({
        type: "open_long",
        symbol: context.symbol,
        context: ctx,
        verdict: "rejected",
        thesis: context.thesis,
        executed: false,
        executionError: "Tamaño insuficiente para min lot Bybit.",
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "rejected", reason: "Tamaño insuficiente para mínimo de Bybit.", rule: null, orderId: null, qty: null, decisionId };
    }
    ctx.qty = qty;

    await setLeverage(context.symbol, context.leverage);
    const orderId = await placeMarketOrder(context.symbol, "Buy", qty, false, 0);
    ctx.orderId = orderId;

    if (orderId) {
      alertTradeOpened({
        symbol: context.symbol,
        side: "long",
        sizeUsd: context.size_usd,
        leverage: context.leverage,
        orderId,
        qty,
        thesis: context.thesis,
      });
      // Si fue autónomo, registrar en autonomy audit + bump counter
      if (autonomous) {
        await recordAutonomousTrade({
          symbol: context.symbol,
          side: "long",
          sizeUsd: context.size_usd,
          leverage: context.leverage,
          thesis: context.thesis,
        }).catch(() => {});
      }
    }

    const decisionId = await persistDecision({
      type: "open_long",
      symbol: context.symbol,
      context: ctx,
      verdict: orderId ? "executed" : "rejected",
      thesis: context.thesis,
      executed: !!orderId,
      executionError: orderId ? null : "placeMarketOrder devolvió null",
      latencyMs: Date.now() - t0,
    });

    return {
      ok: !!orderId,
      verdict: orderId ? "executed" : "rejected",
      reason: orderId ? null : "Bybit rechazó la orden.",
      rule: null,
      orderId,
      qty,
      decisionId,
    };
  },
});

// ─── ABRIR SHORT ─────────────────────────────────────────────────────────────

export const abrirShort = createTool({
  id: "abrir_short",
  description:
    "Abre posición SHORT market en Bybit. Mismas tres barreras: governance + confirmación explícita + audit. Usar cuando la tesis valide setup bajista y Luis lo autorice.",
  inputSchema: z.object({
    symbol: symbolSchema,
    size_usd: z.number().positive().max(10_000),
    leverage: z.number().int().min(1).max(20),
    thesis: thesisSchema,
    confirmado: confirmacionSchema,
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    verdict: z.string(),
    reason: z.string().nullable(),
    rule: z.string().nullable(),
    orderId: z.string().nullable(),
    qty: z.string().nullable(),
    decisionId: z.number().nullable(),
    needs_confirmation_text: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const context = (rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object")
      ? (rawInput as { context: Record<string, unknown> }).context
      : (rawInput as Record<string, unknown>);
    const t0 = Date.now();
    const ctx: DecisionContext = {
      input: { ...context },
      validation: null,
      bybitTestnet: isTestnet(),
    };

    const positions = await getOpenPositions();
    const validation = await validateOrder({
      symbol: context.symbol,
      side: "short",
      sizeUsd: context.size_usd,
      leverage: context.leverage,
      currentOpenPositions: positions.length,
    });
    ctx.validation = validation;

    if (!validation.allowed) {
      await auditEvent({
        actor: "tanit",
        action: "OPEN_SHORT_BLOCKED",
        field: validation.rule ?? "unknown",
        reason: `${context.symbol} ${context.size_usd}USD ${context.leverage}x — ${validation.reason}`,
        blocked: true,
      });
      alertGovernanceBlocked({
        symbol: context.symbol,
        side: "short",
        sizeUsd: context.size_usd,
        leverage: context.leverage,
        rule: validation.rule ?? "unknown",
        reason: validation.reason ?? "n/a",
      });
      const decisionId = await persistDecision({
        type: "open_short",
        symbol: context.symbol,
        context: ctx,
        verdict: "blocked",
        thesis: context.thesis,
        executed: false,
        executionError: validation.reason,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "blocked", reason: validation.reason, rule: validation.rule, orderId: null, qty: null, decisionId };
    }

    // Gate adicional si es contexto autónomo
    const autonomous = isAutonomousContext(rawInput);
    if (autonomous && context.confirmado) {
      const gate = await gateAutonomousAction({
        sizeUsd: context.size_usd,
        leverage: context.leverage,
        thesis: context.thesis,
      });
      if (!gate.allowed) {
        await auditEvent({
          actor: "tanit-autonomous-loop",
          action: "AUTONOMY_BLOCKED",
          field: gate.rule ?? "unknown",
          reason: `${context.symbol} short ${context.size_usd}USD ${context.leverage}x — ${gate.reason}`,
          blocked: true,
        });
        const decisionId = await persistDecision({
          type: "open_short",
          symbol: context.symbol,
          context: { ...ctx, warnings: [`autonomy_block: ${gate.reason}`] },
          verdict: "blocked",
          thesis: context.thesis,
          executed: false,
          executionError: `autonomy: ${gate.reason}`,
          latencyMs: Date.now() - t0,
        });
        return { ok: false, verdict: "blocked", reason: `autonomy: ${gate.reason}`, rule: gate.rule, orderId: null, qty: null, decisionId };
      }
    }

    if (!context.confirmado && !(await autonomyAllowsDirectExecution())) {
      const previewText = `¿Autorizas abrir SHORT ${context.symbol} por $${context.size_usd.toFixed(2)} con leverage ${context.leverage}x en ${isTestnet() ? "TESTNET" : "MAINNET"}? Tesis: "${context.thesis}". Si sí, dímelo y reinvoco con confirmado=true.`;
      const decisionId = await persistDecision({
        type: "open_short",
        symbol: context.symbol,
        context: ctx,
        verdict: "needs_confirmation",
        thesis: context.thesis,
        executed: false,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "needs_confirmation", reason: "Confirmación humana requerida.", rule: null, orderId: null, qty: null, decisionId, needs_confirmation_text: previewText };
    }

    const markPrice = await getMarkPrice(context.symbol);
    if (!markPrice) {
      const decisionId = await persistDecision({
        type: "open_short",
        symbol: context.symbol,
        context: ctx,
        verdict: "rejected",
        thesis: context.thesis,
        executed: false,
        executionError: "No se obtuvo mark price.",
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "rejected", reason: "No se obtuvo mark price.", rule: null, orderId: null, qty: null, decisionId };
    }
    ctx.markPrice = markPrice;

    const qty = await calcQtyReal(context.symbol, context.size_usd, context.leverage, markPrice);
    if (!qty) {
      const decisionId = await persistDecision({
        type: "open_short",
        symbol: context.symbol,
        context: ctx,
        verdict: "rejected",
        thesis: context.thesis,
        executed: false,
        executionError: "Tamaño insuficiente para min lot Bybit.",
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "rejected", reason: "Tamaño insuficiente.", rule: null, orderId: null, qty: null, decisionId };
    }
    ctx.qty = qty;

    await setLeverage(context.symbol, context.leverage);
    const orderId = await placeMarketOrder(context.symbol, "Sell", qty, false, 0);
    ctx.orderId = orderId;

    if (orderId) {
      alertTradeOpened({
        symbol: context.symbol,
        side: "short",
        sizeUsd: context.size_usd,
        leverage: context.leverage,
        orderId,
        qty,
        thesis: context.thesis,
      });
      if (autonomous) {
        await recordAutonomousTrade({
          symbol: context.symbol,
          side: "short",
          sizeUsd: context.size_usd,
          leverage: context.leverage,
          thesis: context.thesis,
        }).catch(() => {});
      }
    }

    const decisionId = await persistDecision({
      type: "open_short",
      symbol: context.symbol,
      context: ctx,
      verdict: orderId ? "executed" : "rejected",
      thesis: context.thesis,
      executed: !!orderId,
      executionError: orderId ? null : "placeMarketOrder devolvió null",
      latencyMs: Date.now() - t0,
    });

    return { ok: !!orderId, verdict: orderId ? "executed" : "rejected", reason: orderId ? null : "Bybit rechazó la orden.", rule: null, orderId, qty, decisionId };
  },
});

// ─── CERRAR POSICIÓN ─────────────────────────────────────────────────────────

export const cerrarPosicion = createTool({
  id: "cerrar_posicion",
  description:
    "Cierra al market una posición abierta en el símbolo dado. Lee el size actual de Bybit y manda el reduceOnly. Confirmación explícita requerida.",
  inputSchema: z.object({
    symbol: symbolSchema,
    razon: z.string().min(5).describe("Razón del cierre: take profit, stop tactico, fin de tesis, etc."),
    confirmado: confirmacionSchema,
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    verdict: z.string(),
    reason: z.string().nullable(),
    decisionId: z.number().nullable(),
    needs_confirmation_text: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const context = (rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object")
      ? (rawInput as { context: Record<string, unknown> }).context
      : (rawInput as Record<string, unknown>);
    const t0 = Date.now();
    const positions = await getOpenPositions();
    const target = positions.find((p) => p.symbol === context.symbol && parseFloat(p.size ?? "0") > 0);

    if (!target) {
      const decisionId = await persistDecision({
        type: "close_position",
        symbol: context.symbol,
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "rejected",
        thesis: context.razon,
        executed: false,
        executionError: "No hay posición abierta en este símbolo.",
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "rejected", reason: `No hay posición abierta en ${context.symbol}.`, decisionId };
    }

    const direction: "LONG" | "SHORT" = target.side === "Buy" ? "LONG" : "SHORT";
    const size = target.size ?? "0";

    if (!context.confirmado && !(await autonomyAllowsDirectExecution())) {
      const upnl = parseFloat(target.unrealisedPnl ?? "0");
      const previewText = `¿Confirmas cerrar ${direction} ${context.symbol} (size ${size}, PnL actual $${upnl.toFixed(2)})? Razón: "${context.razon}". Si sí, reinvoco con confirmado=true.`;
      const decisionId = await persistDecision({
        type: "close_position",
        symbol: context.symbol,
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "needs_confirmation",
        thesis: context.razon,
        executed: false,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "needs_confirmation", reason: "Confirmación humana requerida.", decisionId, needs_confirmation_text: previewText };
    }

    const ok = await closePosition(context.symbol, direction, size, 0);
    if (ok) {
      // PnL real lo conocemos sólo después; aquí mandamos null y el reporte
      // diario resume con el closedPnl que llene Bybit unos segundos después.
      alertTradeClosed({
        symbol: context.symbol,
        side: direction === "LONG" ? "long" : "short",
        pnl: parseFloat(target.unrealisedPnl ?? "0") || null,
        razon: context.razon,
      });
    }
    const decisionId = await persistDecision({
      type: "close_position",
      symbol: context.symbol,
      context: { input: context, validation: null, bybitTestnet: isTestnet() },
      verdict: ok ? "executed" : "rejected",
      thesis: context.razon,
      executed: ok,
      executionError: ok ? null : "closePosition devolvió false",
      latencyMs: Date.now() - t0,
    });
    return { ok, verdict: ok ? "executed" : "rejected", reason: ok ? null : "Bybit rechazó el cierre.", decisionId };
  },
});

// ─── MOVER STOPS ─────────────────────────────────────────────────────────────

export const moverStops = createTool({
  id: "mover_stops",
  description:
    "Setea o mueve stop loss y/o take profit de una posición existente. Confirmación explícita requerida.",
  inputSchema: z.object({
    symbol: symbolSchema,
    stop_loss: z.number().positive().nullable().describe("Precio del SL. null para no cambiar."),
    take_profit: z.number().positive().nullable().describe("Precio del TP. null para no cambiar."),
    razon: z.string().min(5),
    confirmado: confirmacionSchema,
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    verdict: z.string(),
    reason: z.string().nullable(),
    decisionId: z.number().nullable(),
    needs_confirmation_text: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const context = (rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object")
      ? (rawInput as { context: Record<string, unknown> }).context
      : (rawInput as Record<string, unknown>);
    const t0 = Date.now();
    if (context.stop_loss === null && context.take_profit === null) {
      return { ok: false, verdict: "rejected", reason: "Pasa al menos stop_loss o take_profit.", decisionId: null };
    }
    if (!context.confirmado) {
      const parts = [];
      if (context.stop_loss != null) parts.push(`SL=${context.stop_loss}`);
      if (context.take_profit != null) parts.push(`TP=${context.take_profit}`);
      const previewText = `¿Confirmas ajustar stops en ${context.symbol}: ${parts.join(", ")}? Razón: "${context.razon}". Si sí, reinvoco con confirmado=true.`;
      const decisionId = await persistDecision({
        type: "set_stops",
        symbol: context.symbol,
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "needs_confirmation",
        thesis: context.razon,
        executed: false,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "needs_confirmation", reason: "Confirmación humana requerida.", decisionId, needs_confirmation_text: previewText };
    }

    const ok = await setTradingStop(
      context.symbol,
      context.stop_loss ?? undefined,
      context.take_profit ?? undefined,
      0,
    );
    const decisionId = await persistDecision({
      type: "set_stops",
      symbol: context.symbol,
      context: { input: context, validation: null, bybitTestnet: isTestnet() },
      verdict: ok ? "executed" : "rejected",
      thesis: context.razon,
      executed: ok,
      executionError: ok ? null : "setTradingStop devolvió false",
      latencyMs: Date.now() - t0,
    });
    return { ok, verdict: ok ? "executed" : "rejected", reason: ok ? null : "Bybit rechazó.", decisionId };
  },
});

// ─── CANCELAR TODAS LAS ÓRDENES ──────────────────────────────────────────────

export const cancelarTodasOrdenes = createTool({
  id: "cancelar_todas_ordenes",
  description:
    "Cancela todas las órdenes pendientes en USDT. Útil para limpiar después de una sesión o liberar margen. NO cierra posiciones — solo cancela órdenes condicionadas/limit.",
  inputSchema: z.object({
    razon: z.string().min(5),
    confirmado: confirmacionSchema,
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    verdict: z.string(),
    cancelled: z.number(),
    decisionId: z.number().nullable(),
    needs_confirmation_text: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const context = (rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object")
      ? (rawInput as { context: Record<string, unknown> }).context
      : (rawInput as Record<string, unknown>);
    const t0 = Date.now();
    if (!context.confirmado) {
      const previewText = `¿Confirmas cancelar TODAS las órdenes pendientes en USDT? Razón: "${context.razon}". Si sí, reinvoco con confirmado=true.`;
      const decisionId = await persistDecision({
        type: "cancel_all",
        symbol: null,
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "needs_confirmation",
        thesis: context.razon,
        executed: false,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "needs_confirmation", cancelled: 0, decisionId, needs_confirmation_text: previewText };
    }
    const n = await cancelAllOpenOrders();
    const decisionId = await persistDecision({
      type: "cancel_all",
      symbol: null,
      context: { input: context, validation: null, bybitTestnet: isTestnet(), warnings: [] },
      verdict: "executed",
      thesis: context.razon,
      executed: true,
      latencyMs: Date.now() - t0,
    });
    return { ok: true, verdict: "executed", cancelled: n, decisionId };
  },
});

export const bybitWriteTools = {
  abrirLong,
  abrirShort,
  cerrarPosicion,
  moverStops,
  cancelarTodasOrdenes,
};
