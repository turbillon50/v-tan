/**
 * Tools de Mastra para que Tanit controle el motor ejecutor determinista.
 *
 * El motor NO toma decisiones — solo ejecuta lo que estas tools le dictan.
 * Tanit decide ESTRATEGIA (cuándo, qué símbolo, dirección, leverage, SL/TP).
 * El motor ejecuta SCALPS dentro de esa estrategia a la frecuencia que ella
 * defina, sin pasar cada trade por una llamada Gemini.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { instruir, pausar, status } from "../../lib/motor-ejecutor";

export const instruirMotorEjecutor = createTool({
  id: "instruir_motor_ejecutor",
  description:
    "Activa el motor ejecutor determinista con una estrategia concreta. " +
    "El motor abre/cierra trades automáticamente siguiendo tus parámetros sin pasar por LLM. " +
    "Esto te da velocidad real (segundos por trade vs 30s por decisión Gemini). " +
    "Tú decides la estrategia macro cada N minutos; el motor ejecuta los scalps dentro de ella. " +
    "Sobrescribe campaign activa si la hay.",
  inputSchema: z.object({
    symbol: z.string().min(3).max(20).describe("Símbolo Bybit, ej. BTCUSDT"),
    direction: z.enum(["long", "short"]).describe("Dirección de los trades de esta campaign"),
    leverage: z.number().int().min(1).max(100).describe("Apalancamiento. Tu tesis decide."),
    slPrice: z.number().positive().describe("Precio absoluto USD del SL (Motor 5 tesis). OBLIGATORIO."),
    tp1Price: z.number().positive().optional().describe("Precio TP1 opcional. 50% pos cierra aquí."),
    tp2Price: z.number().positive().optional().describe("Precio TP2 opcional. 25% pos cierra aquí."),
    tp3Price: z.number().positive().optional().describe("Precio TP3 opcional. 25% restante con trailing."),
    sizePerEntryUsd: z.number().positive().describe("USD por entrada (notional / leverage = margen real)."),
    maxConcurrent: z.number().int().min(1).max(20).default(1).describe("Cuántas posiciones simultáneas de esta campaign."),
    frequencySeconds: z.number().int().min(5).max(3600).describe("Cada cuántos segundos evaluar reentrada (mín 5)."),
    durationMinutes: z.number().int().min(1).max(720).describe("Cuánto tiempo correr la campaign (mín 1, máx 12h)."),
    maxTrades: z.number().int().min(1).max(500).describe("Cap total de trades en la campaign."),
    reason: z.string().min(10).max(1000).describe("Tu razonamiento (qué viste, por qué LONG/SHORT, qué TF te alineó, etc). Para audit."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    campaignId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: any }).context
      : (rawInput as any));
    const r = instruir({
      symbol: ctx.symbol,
      direction: ctx.direction,
      leverage: ctx.leverage,
      slPrice: ctx.slPrice,
      tp1Price: ctx.tp1Price,
      tp2Price: ctx.tp2Price,
      tp3Price: ctx.tp3Price,
      sizePerEntryUsd: ctx.sizePerEntryUsd,
      maxConcurrent: ctx.maxConcurrent ?? 1,
      frequencySeconds: ctx.frequencySeconds,
      durationMinutes: ctx.durationMinutes,
      maxTrades: ctx.maxTrades,
      reason: ctx.reason,
    });
    if (r.ok) return { ok: true, campaignId: r.campaignId };
    return { ok: false, error: r.error };
  },
});

export const pausarMotorEjecutor = createTool({
  id: "pausar_motor_ejecutor",
  description:
    "Pausa el motor ejecutor. La campaign activa queda en estado paused, no abre más trades. " +
    "Las posiciones YA abiertas siguen en Bybit hasta que tú las cierres o lleguen a SL/TP. " +
    "Usar cuando el contexto cambia y la estrategia ya no aplica, o cuando quieres revisar antes de seguir.",
  inputSchema: z.object({
    reason: z.string().min(5).max(500).describe("Por qué pausas (para audit y aprendizaje)."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    previousStatus: z.string().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: any }).context
      : (rawInput as any));
    return pausar(ctx.reason);
  },
});

export const consultarMotorEjecutorStatus = createTool({
  id: "consultar_motor_ejecutor_status",
  description:
    "Devuelve el estado actual del motor ejecutor: si tiene campaign activa, qué está ejecutando, " +
    "cuántos trades lleva, cuánto tiempo le queda. Usar para auto-conocer si necesitas instruir nueva campaign.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    hasCampaign: z.boolean(),
    campaign: z.any().nullable(),
    timeLeftMinutes: z.number().nullable(),
  }),
  execute: async () => {
    const s = status();
    return {
      hasCampaign: s.hasCampaign,
      campaign: s.campaign,
      timeLeftMinutes: s.timeLeftMinutes,
    };
  },
});

export const motorEjecutorTools = {
  instruirMotorEjecutor,
  pausarMotorEjecutor,
  consultarMotorEjecutorStatus,
};
