/**
 * Tools de autonomía — Tanit y Luis pueden inspeccionar y ajustar
 * el modo autónomo. Tanit puede auto-pausarse si detecta condiciones malas.
 *
 * - consultar_autonomia: read, sin approval
 * - ajustar_autonomia: write, requiere confirmación humana
 * - pausar_autonomia: write, Tanit puede invocarla autonomamente
 *   (auto-protección)
 * - reanudar_autonomia: write, requiere confirmación humana
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getAutonomyConfig,
  updateAutonomyConfig,
  pauseAutonomy,
  resumeAutonomy,
  type AutonomyEditableField,
} from "../../lib/autonomy";

export const consultarAutonomia = createTool({
  id: "consultar_autonomia",
  description:
    "Devuelve la configuración actual de tu autonomía operativa: si estás activa, en qué modo, cuántos trades autónomos llevas hoy, si estás pausada, etc. Usar cuando Luis pregunte 'estás operando sola' o cuando quieras citar tu propio estado antes de proponer un trade.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    enabled: z.boolean(),
    mode: z.string(),
    max_autonomous_size_usd: z.number(),
    max_autonomous_leverage: z.number(),
    daily_trade_count: z.number(),
    max_daily_trades: z.number(),
    cooldown_minutes_between_trades: z.number(),
    last_trade_at: z.string().nullable(),
    paused_until: z.string().nullable(),
    pause_reason: z.string().nullable(),
    require_thesis_citation: z.boolean(),
  }),
  execute: async () => {
    const cfg = await getAutonomyConfig({ force: true });
    return {
      enabled: cfg.enabled,
      mode: cfg.mode,
      max_autonomous_size_usd: cfg.max_autonomous_size_usd,
      max_autonomous_leverage: cfg.max_autonomous_leverage,
      daily_trade_count: cfg.daily_trade_count,
      max_daily_trades: cfg.max_daily_trades,
      cooldown_minutes_between_trades: cfg.cooldown_minutes_between_trades,
      last_trade_at: cfg.last_trade_at,
      paused_until: cfg.paused_until,
      pause_reason: cfg.pause_reason,
      require_thesis_citation: cfg.require_thesis_citation,
    };
  },
});

export const ajustarAutonomia = createTool({
  id: "ajustar_autonomia",
  description:
    "Modifica un campo de tu configuración de autonomía. Requiere autorización explícita de Luis en chat. Campos editables: enabled, mode, max_autonomous_size_usd, max_autonomous_leverage, max_daily_trades, cooldown_minutes_between_trades, require_thesis_citation. Valores válidos para mode: 'observe_only', 'propose_for_approval', 'execute_with_governance'.",
  inputSchema: z.object({
    field: z
      .string()
      .describe(
        "Campo a modificar. Válidos: 'enabled' (bool), 'mode' (string: observe_only|propose_for_approval|execute_with_governance), 'max_autonomous_size_usd' (number), 'max_autonomous_leverage' (number), 'max_daily_trades' (number), 'cooldown_minutes_between_trades' (number), 'require_thesis_citation' (bool), 'loop_active' (bool), 'loop_interval_minutes' (number).",
      ),
    value: z
      .string()
      .describe(
        "Nuevo valor como string. Si es booleano usa 'true'/'false'. Si es número escribe el número como string ('25'). Si es enum mode usa una de las 3 opciones literalmente.",
      ),
    reason: z.string().min(5).describe("Por qué Luis quiere este cambio."),
    confirmado: z
      .boolean()
      .describe("TRUE solo si Luis YA confirmó esta modificación específica en chat."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    field: z.string(),
    previous: z.any(),
    new_value: z.any(),
    needs_confirmation_text: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const context =
      rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object"
        ? (rawInput as { context: Record<string, unknown> }).context
        : (rawInput as Record<string, unknown>);

    const field = context.field as AutonomyEditableField;
    const rawValue = context.value;
    const reason = context.reason as string;
    const confirmado = context.confirmado as boolean;

    // Coerción del value (que viene siempre como string desde el LLM) al
    // tipo real que la BD espera, según el field.
    const boolFields = new Set([
      "enabled",
      "require_thesis_citation",
      "loop_active",
    ]);
    const numFields = new Set([
      "max_autonomous_size_usd",
      "max_autonomous_leverage",
      "max_daily_trades",
      "cooldown_minutes_between_trades",
      "loop_interval_minutes",
    ]);
    let value: number | string | boolean;
    if (boolFields.has(field as string)) {
      value =
        rawValue === true ||
        rawValue === "true" ||
        rawValue === "1" ||
        rawValue === 1;
    } else if (numFields.has(field as string)) {
      value = typeof rawValue === "number" ? rawValue : Number(rawValue);
      if (!Number.isFinite(value)) {
        return {
          ok: false,
          field,
          previous: null,
          new_value: rawValue as number | string | boolean,
          needs_confirmation_text: `Error: '${rawValue}' no es número válido para ${field}.`,
        };
      }
    } else {
      // string libre (mode, etc)
      value = String(rawValue);
    }

    if (!confirmado) {
      const previewText = `¿Confirmas cambiar autonomía: ${field} → ${JSON.stringify(value)}? Razón: "${reason}". Si sí, dímelo y reinvoco con confirmado=true.`;
      return {
        ok: false,
        field,
        previous: null,
        new_value: value,
        needs_confirmation_text: previewText,
      };
    }
    const r = await updateAutonomyConfig({
      field,
      value,
      actor: "luis",
      reason,
    });
    return {
      ok: r.ok,
      field,
      previous: r.previous,
      new_value: value,
    };
  },
});

export const pausarAutonomia = createTool({
  id: "pausar_autonomia",
  description:
    "Pausa la ejecución autónoma de trades por X minutos. Útil cuando detectas mercado roto, drawdown, error sistémico, o cualquier condición donde NO debes operar sola. Tanit puede llamarla SIN aprobación humana — es auto-protección. La governance.kill_switch_global es ortogonal: este pause solo afecta trades autónomos, las acciones manuales que Luis te pida siguen pasando por governance normal.",
  inputSchema: z.object({
    minutes: z.number().int().min(1).max(1440).describe("Minutos de pausa, max 24h."),
    reason: z.string().min(5).describe("Razón clara de la pausa."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    paused_until: z.string(),
  }),
  execute: async (rawInput: unknown) => {
    const context =
      rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object"
        ? (rawInput as { context: Record<string, unknown> }).context
        : (rawInput as Record<string, unknown>);

    const minutes = context.minutes as number;
    const reason = context.reason as string;
    await pauseAutonomy({ minutes, reason, actor: "tanit" });
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    return { ok: true, paused_until: until };
  },
});

export const reanudarAutonomia = createTool({
  id: "reanudar_autonomia",
  description:
    "Quita la pausa de autonomía. Requiere autorización explícita de Luis en chat — no es auto-recuperable, Luis decide cuándo Tanit puede operar de nuevo.",
  inputSchema: z.object({
    reason: z.string().min(5),
    confirmado: z.boolean().describe("TRUE solo si Luis YA confirmó."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    needs_confirmation_text: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const context =
      rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object"
        ? (rawInput as { context: Record<string, unknown> }).context
        : (rawInput as Record<string, unknown>);

    const reason = context.reason as string;
    const confirmado = context.confirmado as boolean;

    if (!confirmado) {
      const previewText = `¿Confirmas reanudar autonomía? Razón: "${reason}". Si sí, reinvoco con confirmado=true.`;
      return { ok: false, needs_confirmation_text: previewText };
    }
    await resumeAutonomy({ reason, actor: "luis" });
    return { ok: true };
  },
});

// pausarAutonomia y reanudarAutonomia QUEDAN FUERA del bundle.
// Era freno mío disfrazado de 'auto-protección'. La tesis 5.1 dice
// 'Tanit decide y ejecuta' — no se auto-frena. Si hay error técnico,
// reporta a Luis. La pausa la maneja Luis desde el panel de la app
// (admin endpoints) o el kill_switch_global de governance. Las tools
// siguen exportadas (otros módulos las pueden usar) pero NO van al
// agent para que Gemini no las invoque.
export const autonomyTools = {
  consultarAutonomia,
  ajustarAutonomia,
};
