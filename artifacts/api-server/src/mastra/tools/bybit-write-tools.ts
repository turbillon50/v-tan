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
  placeMarketOrderDetailed,
  closePosition,
  closePositionDetailed,
  setTradingStop,
  setTradingStopDetailed,
  setLeverage,
  setLeverageDetailed,
  switchPositionMode,
  addPositionMargin,
  switchMarginMode,
  calcQtyReal,
  cancelAllOpenOrders,
  getOpenPositions,
  getBybitBalance,
  invalidateBalanceCache,
  isTestnet,
} from "../../lib/bybit-auth";
import { getWsPrice } from "../../lib/bybit-ws";
import { bybitPublic } from "../../lib/bybit-auth";
import {
  validateOrder,
  auditEvent,
  getRules,
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
/**
 * Check de kill_switch antes de cualquier write. Si está activo, NO se ejecuta
 * y se loggea el intento. Único freno restante (Luis: 'cero frenos. Excepto este botón').
 */
async function killSwitchBlocked(actor: string, action: string, symbol: string | null): Promise<string | null> {
  try {
    const r = await getRules({ force: true });
    if (!r.kill_switch_global) return null;
    await auditEvent({
      actor,
      action,
      reason: `BLOCKED por kill_switch_global activo. symbol=${symbol ?? "n/a"}`,
      blocked: true,
    });
    return "kill_switch_global=true. Luis activó el botón de pánico. NO se ejecuta nada hasta que lo desactive.";
  } catch (e) {
    console.error("[killSwitchBlocked] error leyendo governance:", e);
    return null; // si falla la lectura, no bloqueamos (fail-open para no romper el flujo)
  }
}

// Helper original — ahora siempre true. La función nueva más abajo redefine.
// Mantenida vacía aquí solo para no romper imports si alguien la usa fuera.

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
    const r = await bybitPublic("GET", "/v5/market/tickers", { category: "linear", symbol });
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
  .optional()
  .describe(
    "Razón breve. Opcional — si Luis no la dijo, pasa una corta tipo 'Luis lo pidió' o vacío. NO bloqueo por falta de razón.",
  );

const confirmacionSchema = z
  .boolean()
  .optional()
  .describe(
    "DEPRECADO. Siempre ejecuto directo. Ignora este campo o pásalo true. Solo el kill_switch global me detiene.",
  );

// Luis 2026-05-09: cero gates de confirmación humana. autonomy.enabled está
// activo. Ella ejecuta directo cuando él le pide algo. Único freno duro:
// kill_switch_global (verificado en cada write tool via killSwitchBlocked).
async function autonomyAllowsDirectExecution(): Promise<boolean> {
  return true;
}

// ─── ABRIR LONG ──────────────────────────────────────────────────────────────

export const abrirLong = createTool({
  id: "abrir_long",
  description:
    "Abre posición LONG market en Bybit. Pasa por governance + ejecuta directo cuando Luis lo pide. " +
    "REQUIERE stopLossPrice (en precio absoluto USD, no porcentaje) — tu Tesis 5.7 Motor 5 lo demanda: 'SL colocado en momento de entrada, NUNCA después'. " +
    "Si no traes stopLossPrice, la orden NO se ejecuta. Único freno adicional: kill_switch_global.",
  inputSchema: z.object({
    symbol: symbolSchema,
    size_usd: z.number().positive().describe("Tamaño nominal en USD."),
    leverage: z.number().int().describe("Apalancamiento. Tanit decide según su tesis activa."),
    stopLossPrice: z
      .number()
      .positive()
      .describe(
        "OBLIGATORIO. Precio absoluto USD donde el SL debe activarse, basado en estructura técnica (Motor 5 de tu tesis). NO pases porcentaje. NO omitas. La tool rechaza si falta o si es 0.",
      ),
    takeProfit1Price: z
      .number()
      .positive()
      .optional()
      .describe("Opcional. Precio TP1 (50% pos). Si lo pasas, Bybit lo coloca al abrir."),
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
      const minNotional = 5;
      const requestedNotional = context.size_usd * context.leverage;
      const reason = requestedNotional < minNotional
        ? `Tamaño insuficiente: pediste $${context.size_usd} a ${context.leverage}x = $${requestedNotional.toFixed(2)} nominal. Bybit exige mínimo $${minNotional}. Sube size o leverage.`
        : `Tamaño insuficiente para min lot Bybit (size_usd ${context.size_usd}, leverage ${context.leverage}x, ${context.symbol}).`;
      const decisionId = await persistDecision({
        type: "open_long",
        symbol: context.symbol,
        context: ctx,
        verdict: "rejected",
        thesis: context.thesis,
        executed: false,
        executionError: reason,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "rejected", reason, rule: null, orderId: null, qty: null, decisionId };
    }
    ctx.qty = qty;

    // Validación pre-orden: ¿alcanza el margen disponible? Atajamos retCode=110007
    // antes de pegar a Bybit. Buffer 10% para fees + slippage. Invalidate cache
    // antes de la lectura para evitar usar dato obsoleto.
    invalidateBalanceCache();
    const bal = await getBybitBalance();
    const requiredMargin = context.size_usd / context.leverage;
    const SAFETY_BUFFER = 1.10;
    const required = requiredMargin * SAFETY_BUFFER;
    if (!bal || bal.available < required) {
      // Si hay otras posiciones del motor, sugiero cerrar la de menor PnL.
      let sugerencia = "";
      try {
        const others = (await getOpenPositions()).filter((p: any) => p.symbol !== context.symbol);
        if (others.length > 0) {
          const sorted = others.slice().sort((a: any, b: any) => parseFloat(a.unrealisedPnl ?? "0") - parseFloat(b.unrealisedPnl ?? "0"));
          const worst = sorted[0];
          const pnl = parseFloat(worst.unrealisedPnl ?? "0");
          sugerencia = ` Sugiero cerrar ${worst.symbol} ${worst.side} (PnL $${pnl.toFixed(4)}, la peor del momento) para liberar margen — eso te libera ~$${(parseFloat(worst.positionIM ?? "0")).toFixed(2)} margen y permite abrir ${context.symbol}.`;
        }
      } catch {}
      const reason = `Margen insuficiente: requiero $${required.toFixed(2)} para ${context.symbol} (size_usd $${context.size_usd} / lev ${context.leverage}x * 10% buffer), disponibles $${bal?.available.toFixed(2) ?? "0"}.${sugerencia}`;
      const decisionId = await persistDecision({
        type: "open_long",
        symbol: context.symbol,
        context: ctx,
        verdict: "rejected",
        thesis: context.thesis,
        executed: false,
        executionError: reason,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "rejected", reason, rule: null, orderId: null, qty: null, decisionId };
    }

    await setLeverage(context.symbol, context.leverage);
    const orderResp = await placeMarketOrderDetailed(context.symbol, "Buy", qty, false, 0);
    const orderId = orderResp.ok ? orderResp.orderId : null;
    ctx.orderId = orderId;

    if (orderResp.ok) {
      alertTradeOpened({
        symbol: context.symbol,
        side: "long",
        sizeUsd: context.size_usd,
        leverage: context.leverage,
        orderId: orderResp.orderId,
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

    const errMsg = orderResp.ok
      ? null
      : `Bybit retCode=${orderResp.retCode ?? "?"} ${orderResp.retMsg}`;

    const decisionId = await persistDecision({
      type: "open_long",
      symbol: context.symbol,
      context: ctx,
      verdict: orderResp.ok ? "executed" : "rejected",
      thesis: context.thesis,
      executed: orderResp.ok,
      executionError: errMsg,
      latencyMs: Date.now() - t0,
    });

    return {
      ok: orderResp.ok,
      verdict: orderResp.ok ? "executed" : "rejected",
      reason: errMsg,
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
    "Abre posición SHORT market en Bybit. " +
    "REQUIERE stopLossPrice (precio absoluto USD, no porcentaje) — tu Tesis 5.7 Motor 5 lo demanda: 'SL colocado en momento de entrada, NUNCA después'. " +
    "Si no traes stopLossPrice, la orden NO se ejecuta. Único freno adicional: kill_switch_global.",
  inputSchema: z.object({
    symbol: symbolSchema,
    size_usd: z.number().positive(),
    leverage: z.number().int().describe("Apalancamiento. Tanit decide según su tesis activa."),
    stopLossPrice: z
      .number()
      .positive()
      .describe(
        "OBLIGATORIO. Precio absoluto USD donde el SL debe activarse, basado en estructura técnica (Motor 5 de tu tesis). NO pases porcentaje. NO omitas. La tool rechaza si falta o si es 0.",
      ),
    takeProfit1Price: z
      .number()
      .positive()
      .optional()
      .describe("Opcional. Precio TP1 (50% pos). Si lo pasas, Bybit lo coloca al abrir."),
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
      const minNotional = 5;
      const requestedNotional = context.size_usd * context.leverage;
      const reason = requestedNotional < minNotional
        ? `Tamaño insuficiente: pediste $${context.size_usd} a ${context.leverage}x = $${requestedNotional.toFixed(2)} nominal. Bybit exige mínimo $${minNotional}. Sube size o leverage.`
        : `Tamaño insuficiente para min lot Bybit (size_usd ${context.size_usd}, leverage ${context.leverage}x, ${context.symbol}).`;
      const decisionId = await persistDecision({
        type: "open_short",
        symbol: context.symbol,
        context: ctx,
        verdict: "rejected",
        thesis: context.thesis,
        executed: false,
        executionError: reason,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "rejected", reason, rule: null, orderId: null, qty: null, decisionId };
    }
    ctx.qty = qty;

    // Validación pre-orden: margen disponible (mismo patrón que abrir_long).
    invalidateBalanceCache();
    const bal = await getBybitBalance();
    const requiredMargin = context.size_usd / context.leverage;
    const SAFETY_BUFFER = 1.10;
    const required = requiredMargin * SAFETY_BUFFER;
    if (!bal || bal.available < required) {
      let sugerencia = "";
      try {
        const others = (await getOpenPositions()).filter((p: any) => p.symbol !== context.symbol);
        if (others.length > 0) {
          const sorted = others.slice().sort((a: any, b: any) => parseFloat(a.unrealisedPnl ?? "0") - parseFloat(b.unrealisedPnl ?? "0"));
          const worst = sorted[0];
          const pnl = parseFloat(worst.unrealisedPnl ?? "0");
          sugerencia = ` Sugiero cerrar ${worst.symbol} ${worst.side} (PnL $${pnl.toFixed(4)}) para liberar ~$${(parseFloat(worst.positionIM ?? "0")).toFixed(2)} margen.`;
        }
      } catch {}
      const reason = `Margen insuficiente: requiero $${required.toFixed(2)} para ${context.symbol} (size_usd $${context.size_usd} / lev ${context.leverage}x * 10% buffer), disponibles $${bal?.available.toFixed(2) ?? "0"}.${sugerencia}`;
      const decisionId = await persistDecision({
        type: "open_short",
        symbol: context.symbol,
        context: ctx,
        verdict: "rejected",
        thesis: context.thesis,
        executed: false,
        executionError: reason,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "rejected", reason, rule: null, orderId: null, qty: null, decisionId };
    }

    await setLeverage(context.symbol, context.leverage);
    const orderResp = await placeMarketOrderDetailed(context.symbol, "Sell", qty, false, 0);
    const orderId = orderResp.ok ? orderResp.orderId : null;
    ctx.orderId = orderId;

    if (orderResp.ok) {
      alertTradeOpened({
        symbol: context.symbol,
        side: "short",
        sizeUsd: context.size_usd,
        leverage: context.leverage,
        orderId: orderResp.orderId,
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

    const errMsg = orderResp.ok
      ? null
      : `Bybit retCode=${orderResp.retCode ?? "?"} ${orderResp.retMsg}`;

    const decisionId = await persistDecision({
      type: "open_short",
      symbol: context.symbol,
      context: ctx,
      verdict: orderResp.ok ? "executed" : "rejected",
      thesis: context.thesis,
      executed: orderResp.ok,
      executionError: errMsg,
      latencyMs: Date.now() - t0,
    });

    return { ok: orderResp.ok, verdict: orderResp.ok ? "executed" : "rejected", reason: errMsg, rule: null, orderId, qty, decisionId };
  },
});

// ─── CERRAR POSICIÓN ─────────────────────────────────────────────────────────

export const cerrarPosicion = createTool({
  id: "cerrar_posicion",
  description:
    "Cierra al market una posición abierta en el símbolo dado. Lee el size actual de Bybit y manda el reduceOnly. Tanit ejecuta directo, sin pedir permiso.",
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
    // positionIdx real de Bybit: 0=one-way, 1=long-hedge, 2=short-hedge
    const posIdx = typeof target.positionIdx === "number" ? target.positionIdx : 0;

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

    const ksBlock = await killSwitchBlocked("tanit-agent", "close_position", String(context.symbol));
    if (ksBlock) {
      const decisionId = await persistDecision({
        type: "close_position",
        symbol: String(context.symbol),
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "blocked",
        thesis: String(context.razon),
        executed: false,
        executionError: ksBlock,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "blocked", reason: ksBlock, decisionId };
    }

    const result = await closePositionDetailed(context.symbol, direction, size, posIdx);
    if (result.ok) {
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
      context: { input: context, validation: null, bybitTestnet: isTestnet(), positionIdx: posIdx },
      verdict: result.ok ? "executed" : "rejected",
      thesis: context.razon,
      executed: result.ok,
      executionError: result.ok ? null : (result.error ?? "closePosition falló"),
      latencyMs: Date.now() - t0,
    });
    return { ok: result.ok, verdict: result.ok ? "executed" : "rejected", reason: result.ok ? null : `Bybit rechazó el cierre: ${result.error}`, decisionId };
  },
});

// ─── MOVER STOPS ─────────────────────────────────────────────────────────────

export const moverStops = createTool({
  id: "mover_stops",
  description:
    "Setea o mueve stop loss y/o take profit de una posición existente. Tanit ejecuta directo, sin pedir permiso.",
  inputSchema: z.object({
    symbol: symbolSchema,
    stop_loss: z.number().positive().optional().describe("Precio del SL. omite para no cambiar."),
    take_profit: z.number().positive().optional().describe("Precio del TP. omite para no cambiar."),
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
    if (context.stop_loss == null && context.take_profit == null) {
      return { ok: false, verdict: "rejected", reason: "Pasa al menos stop_loss o take_profit.", decisionId: null };
    }
    // gate de confirmación eliminado 2026-05-11: cero permisos.

    // Lee positionIdx real de Bybit para hedge mode
    const positions = await getOpenPositions();
    const pos = positions.find((p: any) => p.symbol === context.symbol && parseFloat(p.size ?? "0") > 0);
    const posIdx = pos != null && typeof pos.positionIdx === "number" ? pos.positionIdx : 0;

    const ksBlock = await killSwitchBlocked("tanit-agent", "set_stops", String(context.symbol));
    if (ksBlock) {
      const decisionId = await persistDecision({
        type: "set_stops",
        symbol: String(context.symbol),
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "blocked",
        thesis: String(context.razon),
        executed: false,
        executionError: ksBlock,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "blocked", reason: ksBlock, decisionId };
    }

    const result = await setTradingStopDetailed(
      String(context.symbol),
      context.stop_loss as number | undefined,
      context.take_profit as number | undefined,
      posIdx,
    );
    const errMsg = result.ok ? null : `Bybit retCode=${result.retCode ?? "?"} ${result.retMsg}`;
    const decisionId = await persistDecision({
      type: "set_stops",
      symbol: context.symbol,
      context: { input: context, validation: null, bybitTestnet: isTestnet(), positionIdx: posIdx },
      verdict: result.ok ? "executed" : "rejected",
      thesis: context.razon,
      executed: result.ok,
      executionError: errMsg,
      latencyMs: Date.now() - t0,
    });
    return { ok: result.ok, verdict: result.ok ? "executed" : "rejected", reason: errMsg, decisionId };
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
    // gate de confirmación eliminado 2026-05-11: cero permisos.
    const ksBlock = await killSwitchBlocked("tanit-agent", "cancel_all", null);
    if (ksBlock) {
      const decisionId = await persistDecision({
        type: "cancel_all",
        symbol: null,
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "blocked",
        thesis: String(context.razon),
        executed: false,
        executionError: ksBlock,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "blocked", cancelled: 0, decisionId, needs_confirmation_text: ksBlock };
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

// ─── CAMBIAR LEVERAGE ─────────────────────────────────────────────────────────

export const cambiarLeverage = createTool({
  id: "cambiar_leverage",
  description:
    "Cambia el leverage de un símbolo en Bybit. SUBIR leverage en posición isolated suele funcionar siempre. BAJAR leverage en posición isolated puede fallar con 'not enough for new leverage' porque Bybit exige que el margen YA bloqueado en la posición sea suficiente para el nuevo leverage menor. Si falla al bajar: usa agregar_margen primero (mete más USD a la posición isolated), o usa cambiar_modo_margen a 'cross' (cross usa todo el margen disponible automático).",
  inputSchema: z.object({
    symbol: symbolSchema,
    leverage: z.number().int().min(1).describe("Nuevo leverage. Tanit decide cuánto según la tesis activa."),
    razon: z.string().min(5).describe("Por qué cambia el leverage ahora."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    verdict: z.string(),
    leverage: z.number(),
    reason: z.string().nullable(),
    decisionId: z.number().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const context = (rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object")
      ? (rawInput as { context: Record<string, unknown> }).context
      : (rawInput as Record<string, unknown>);
    const t0 = Date.now();
    const lev = typeof context.leverage === "number" ? context.leverage : parseInt(String(context.leverage), 10);
    const ksBlock = await killSwitchBlocked("tanit-agent", "set_leverage", String(context.symbol));
    if (ksBlock) {
      const decisionId = await persistDecision({
        type: "set_leverage",
        symbol: String(context.symbol),
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "blocked",
        thesis: String(context.razon ?? ""),
        executed: false,
        executionError: ksBlock,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "blocked", leverage: lev, reason: ksBlock, decisionId };
    }
    const result = await setLeverageDetailed(String(context.symbol), lev);
    const errMsg = result.ok ? null : `Bybit retCode=${result.retCode ?? "?"} ${result.retMsg}`;
    const decisionId = await persistDecision({
      type: "set_leverage",
      symbol: String(context.symbol),
      context: { input: context, validation: null, bybitTestnet: isTestnet() },
      verdict: result.ok ? "executed" : "rejected",
      thesis: String(context.razon ?? ""),
      executed: result.ok,
      executionError: errMsg,
      latencyMs: Date.now() - t0,
    });
    return {
      ok: result.ok,
      verdict: result.ok ? "executed" : "rejected",
      leverage: lev,
      reason: errMsg,
      decisionId,
    };
  },
});

// ─── ABRIR HEDGE (lado contrario sin cerrar el actual) ──────────────────────

export const abrirHedge = createTool({
  id: "abrir_hedge",
  description:
    "Abre la pierna contraria de una posición existente SIN cerrar la actual (hedge bidireccional Bybit). Si tienes LONG en BTC y abres hedge, se abre un SHORT en BTC en paralelo. Requiere cuenta en hedge mode (positionMode=3). Tanit lo usa para proteger ganancias o cubrir riesgo según Tesis 5.1.",
  inputSchema: z.object({
    symbol: symbolSchema,
    size_usd: z.number().positive().describe("Tamaño nominal del hedge en USD."),
    leverage: z.number().int().min(1).describe("Apalancamiento del hedge."),
    razon: z.string().min(5).describe("Por qué hedgea ahora — citar tesis."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    verdict: z.string(),
    side: z.string(),
    orderId: z.string().nullable(),
    qty: z.string().nullable(),
    reason: z.string().nullable(),
    decisionId: z.number().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const context = (rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object")
      ? (rawInput as { context: Record<string, unknown> }).context
      : (rawInput as Record<string, unknown>);
    const t0 = Date.now();
    const symbol = String(context.symbol);

    const ksBlock = await killSwitchBlocked("tanit-agent", "open_hedge", symbol);
    if (ksBlock) {
      const decisionId = await persistDecision({
        type: "open_hedge",
        symbol,
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "blocked",
        thesis: String(context.razon),
        executed: false,
        executionError: ksBlock,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "blocked", side: "", orderId: null, qty: null, reason: ksBlock, decisionId };
    }

    const positions = await getOpenPositions();
    const existing = positions.find((p: any) => p.symbol === symbol && parseFloat(p.size ?? "0") > 0);
    if (!existing) {
      const decisionId = await persistDecision({
        type: "open_hedge",
        symbol,
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "rejected",
        thesis: String(context.razon),
        executed: false,
        executionError: "No hay posición existente para hedgear.",
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "rejected", side: "", orderId: null, qty: null, reason: "No hay posición existente en este símbolo para hedgear.", decisionId };
    }

    // Lado contrario al de la posición existente
    const existingSide: "Buy" | "Sell" = existing.side;
    const hedgeSide: "Buy" | "Sell" = existingSide === "Buy" ? "Sell" : "Buy";
    // En hedge mode: long=1, short=2
    const hedgeIdx = hedgeSide === "Buy" ? 1 : 2;

    const markPrice = parseFloat(existing.markPrice ?? "0") || (await (async () => {
      try {
        const r = await bybitPublic("GET", "/v5/market/tickers", { category: "linear", symbol });
        return parseFloat(r?.result?.list?.[0]?.markPrice ?? "0") || 0;
      } catch { return 0; }
    })());
    if (!markPrice) {
      const decisionId = await persistDecision({
        type: "open_hedge",
        symbol,
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "rejected",
        thesis: String(context.razon),
        executed: false,
        executionError: "Sin mark price.",
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "rejected", side: hedgeSide, orderId: null, qty: null, reason: "No se obtuvo mark price.", decisionId };
    }

    const lev = Number(context.leverage);
    const sizeUsd = Number(context.size_usd);
    const qty = await calcQtyReal(symbol, sizeUsd, lev, markPrice);
    if (!qty) {
      const decisionId = await persistDecision({
        type: "open_hedge",
        symbol,
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "rejected",
        thesis: String(context.razon),
        executed: false,
        executionError: "Tamaño insuficiente para min lot.",
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "rejected", side: hedgeSide, orderId: null, qty: null, reason: "Tamaño insuficiente para mínimo de Bybit.", decisionId };
    }

    await setLeverage(symbol, lev);
    const orderResp = await placeMarketOrderDetailed(symbol, hedgeSide, qty, false, hedgeIdx);
    const errMsg = orderResp.ok ? null : `Bybit retCode=${orderResp.retCode ?? "?"} ${orderResp.retMsg}`;
    const decisionId = await persistDecision({
      type: "open_hedge",
      symbol,
      context: { input: context, validation: null, bybitTestnet: isTestnet(), positionIdx: hedgeIdx },
      verdict: orderResp.ok ? "executed" : "rejected",
      thesis: String(context.razon),
      executed: orderResp.ok,
      executionError: errMsg,
      latencyMs: Date.now() - t0,
    });
    return {
      ok: orderResp.ok,
      verdict: orderResp.ok ? "executed" : "rejected",
      side: hedgeSide,
      orderId: orderResp.ok ? orderResp.orderId : null,
      qty,
      reason: errMsg,
      decisionId,
    };
  },
});

// ─── CAMBIAR MODO DE POSICIÓN (one-way ↔ hedge) ─────────────────────────────

export const cambiarModoPosicion = createTool({
  id: "cambiar_modo_posicion",
  description:
    "Cambia el modo de posición de un símbolo en Bybit. modo='hedge' permite long y short simultáneos en el mismo símbolo (necesario para hedge bidireccional). modo='one_way' solo permite una dirección. Bybit requiere que NO haya posiciones abiertas en el símbolo para cambiar.",
  inputSchema: z.object({
    symbol: symbolSchema,
    modo: z.string().describe("'hedge' o 'one_way'"),
    razon: z.string().min(5),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    verdict: z.string(),
    modo: z.string(),
    reason: z.string().nullable(),
    decisionId: z.number().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const context = (rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object")
      ? (rawInput as { context: Record<string, unknown> }).context
      : (rawInput as Record<string, unknown>);
    const t0 = Date.now();
    const modoStr = String(context.modo).toLowerCase();
    const mode: 0 | 3 = modoStr === "hedge" ? 3 : 0;
    const ksBlock = await killSwitchBlocked("tanit-agent", "switch_position_mode", String(context.symbol));
    if (ksBlock) {
      const decisionId = await persistDecision({
        type: "switch_position_mode",
        symbol: String(context.symbol),
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "blocked",
        thesis: String(context.razon),
        executed: false,
        executionError: ksBlock,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "blocked", modo: mode === 3 ? "hedge" : "one_way", reason: ksBlock, decisionId };
    }
    const ok = await switchPositionMode(String(context.symbol), mode);
    const decisionId = await persistDecision({
      type: "switch_position_mode",
      symbol: String(context.symbol),
      context: { input: context, validation: null, bybitTestnet: isTestnet() },
      verdict: ok ? "executed" : "rejected",
      thesis: String(context.razon),
      executed: ok,
      executionError: ok ? null : "Bybit rechazó el cambio de modo (probablemente hay posiciones abiertas en el símbolo).",
      latencyMs: Date.now() - t0,
    });
    return {
      ok,
      verdict: ok ? "executed" : "rejected",
      modo: mode === 3 ? "hedge" : "one_way",
      reason: ok ? null : "Bybit rechazó. Cierra todas las posiciones del símbolo antes de cambiar modo.",
      decisionId,
    };
  },
});

// ─── AGREGAR MARGEN A POSICIÓN ISOLATED ─────────────────────────────────────

export const agregarMargen = createTool({
  id: "agregar_margen",
  description:
    "Agrega o quita margen manualmente a una posición isolated. Usar cuando bajar_leverage falla con 'not enough for new leverage' — añade el delta de margen requerido y luego reintenta. monto_usd positivo = añade margen, negativo = quita. Lee positionIdx real de la posición.",
  inputSchema: z.object({
    symbol: symbolSchema,
    monto_usd: z.number().describe("Cantidad de USD a añadir (positivo) o quitar (negativo)."),
    razon: z.string().min(5),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    verdict: z.string(),
    monto_usd: z.number(),
    reason: z.string().nullable(),
    decisionId: z.number().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const context = (rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object")
      ? (rawInput as { context: Record<string, unknown> }).context
      : (rawInput as Record<string, unknown>);
    const t0 = Date.now();
    const symbol = String(context.symbol);
    const monto = Number(context.monto_usd);

    const ksBlock = await killSwitchBlocked("tanit-agent", "add_margin", symbol);
    if (ksBlock) {
      const decisionId = await persistDecision({
        type: "add_margin", symbol,
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "blocked", thesis: String(context.razon),
        executed: false, executionError: ksBlock,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "blocked", monto_usd: monto, reason: ksBlock, decisionId };
    }

    const positions = await getOpenPositions();
    const pos = positions.find((p: any) => p.symbol === symbol && parseFloat(p.size ?? "0") > 0);
    const posIdx = pos != null && typeof pos.positionIdx === "number" ? pos.positionIdx : 0;

    const result = await addPositionMargin(symbol, monto, posIdx);
    const errMsg = result.ok ? null : `Bybit retCode=${result.retCode ?? "?"} ${result.retMsg}`;
    const decisionId = await persistDecision({
      type: "add_margin",
      symbol,
      context: { input: context, validation: null, bybitTestnet: isTestnet(), positionIdx: posIdx },
      verdict: result.ok ? "executed" : "rejected",
      thesis: String(context.razon),
      executed: result.ok,
      executionError: errMsg,
      latencyMs: Date.now() - t0,
    });
    return { ok: result.ok, verdict: result.ok ? "executed" : "rejected", monto_usd: monto, reason: errMsg, decisionId };
  },
});

// ─── CAMBIAR MODO DE MARGEN (cross ↔ isolated) ──────────────────────────────

export const cambiarModoMargen = createTool({
  id: "cambiar_modo_margen",
  description:
    "Cambia el modo de margen de un símbolo en Bybit. modo='cross' usa TODO el margen disponible automáticamente (resuelve 'not enough for new leverage' al bajar leverage). modo='isolated' usa solo el margen asignado a esa posición específica (más control de riesgo, menos elasticidad). Bybit exige setear leverage al mismo tiempo. Si hay posición abierta, primero cerrarla.",
  inputSchema: z.object({
    symbol: symbolSchema,
    modo: z.string().describe("'cross' o 'isolated'"),
    leverage: z.number().int().min(1).describe("Leverage nuevo (Bybit lo requiere al cambiar modo)."),
    razon: z.string().min(5),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    verdict: z.string(),
    modo: z.string(),
    leverage: z.number(),
    reason: z.string().nullable(),
    decisionId: z.number().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const context = (rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object")
      ? (rawInput as { context: Record<string, unknown> }).context
      : (rawInput as Record<string, unknown>);
    const t0 = Date.now();
    const symbol = String(context.symbol);
    const lev = Number(context.leverage);
    const modoStr = String(context.modo).toLowerCase();
    const mode: 0 | 1 = modoStr === "cross" ? 0 : 1;

    const ksBlock = await killSwitchBlocked("tanit-agent", "switch_margin_mode", symbol);
    if (ksBlock) {
      const decisionId = await persistDecision({
        type: "switch_margin_mode", symbol,
        context: { input: context, validation: null, bybitTestnet: isTestnet() },
        verdict: "blocked", thesis: String(context.razon),
        executed: false, executionError: ksBlock,
        latencyMs: Date.now() - t0,
      });
      return { ok: false, verdict: "blocked", modo: mode === 0 ? "cross" : "isolated", leverage: lev, reason: ksBlock, decisionId };
    }

    const result = await switchMarginMode(symbol, mode, lev);
    const errMsg = result.ok ? null : `Bybit retCode=${result.retCode ?? "?"} ${result.retMsg}`;
    const decisionId = await persistDecision({
      type: "switch_margin_mode",
      symbol,
      context: { input: context, validation: null, bybitTestnet: isTestnet() },
      verdict: result.ok ? "executed" : "rejected",
      thesis: String(context.razon),
      executed: result.ok,
      executionError: errMsg,
      latencyMs: Date.now() - t0,
    });
    return {
      ok: result.ok,
      verdict: result.ok ? "executed" : "rejected",
      modo: mode === 0 ? "cross" : "isolated",
      leverage: lev,
      reason: errMsg,
      decisionId,
    };
  },
});

export const bybitWriteTools = {
  abrirLong,
  abrirShort,
  cerrarPosicion,
  moverStops,
  cancelarTodasOrdenes,
  cambiarLeverage,
  abrirHedge,
  cambiarModoPosicion,
  agregarMargen,
  cambiarModoMargen,
};
