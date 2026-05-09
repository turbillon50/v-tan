/**
 * Tools de governance — Tanit puede leer sus reglas y, con aprobación
 * explícita de Luis, ajustarlas.
 *
 * - `consultar_governance` (read): siempre disponible, ningún approval.
 * - `ajustar_governance` (write): requireApproval=true. Mastra le pide a
 *   Luis confirmar antes de que el cambio se ejecute.
 * - `accionar_kill_switch` (write): requireApproval=true. Botón rojo.
 *
 * Nota sobre kill-switch: aunque cualquier write requiere approval para
 * ACTIVARLO, Tanit puede DESACTIVARLO sin approval — eso es deliberado
 * para que el sistema pueda recuperarse autónomamente si el motivo del
 * trip ya pasó. La activación SIEMPRE pasa por Luis.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getRules,
  updateRule,
  setKillSwitch,
  auditEvent,
  type GovernanceRules,
} from "../../lib/governance";

export const consultarGovernance = createTool({
  id: "consultar_governance",
  description:
    "Devuelve las reglas de gobernanza activas: tamaño máximo de posición, leverage máximo, pérdida diaria máxima, símbolos permitidos, kill-switch, etc. Usar cuando Luis pregunte por sus límites, sus reglas, o cuando vayas a tomar una decisión y quieras citar la regla específica.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    max_position_size_usd: z.number(),
    max_leverage: z.number(),
    max_daily_loss_usd: z.number(),
    max_concurrent_positions: z.number(),
    allowed_symbols: z.array(z.string()),
    operating_hours_utc: z.string(),
    kill_switch_global: z.boolean(),
    require_approval_above_usd: z.number(),
    notes: z.string().nullable(),
    updated_at: z.string(),
    updated_by: z.string(),
  }),
  execute: async () => {
    const r = await getRules();
    return r;
  },
});

export const ajustarGovernance = createTool({
  id: "ajustar_governance",
  description:
    "Modifica una regla de gobernanza. Requiere aprobación explícita del humano. Usar cuando Luis te pida cambiar un límite (ej. subir leverage máximo a 10x, agregar XRPUSDT a símbolos permitidos, ajustar pérdida diaria). Tú propones el cambio, Mastra le pide a Luis que lo confirme.",
  inputSchema: z.object({
    field: z
      .string()
      .describe(
        "Nombre exacto del campo a modificar. Válidos: max_position_size_usd (number), max_leverage (number), max_daily_loss_usd (number), max_concurrent_positions (number), allowed_symbols (lista de strings separados por coma o JSON), operating_hours_utc (string), require_approval_above_usd (number), notes (string).",
      ),
    new_value: z
      .string()
      .describe(
        "Nuevo valor como string. Si es número usa el número como string ('25'). Si es lista de símbolos usa JSON ['BTCUSDT','ETHUSDT'] o coma 'BTCUSDT,ETHUSDT'. Si es bool 'true'/'false'.",
      ),
    reason: z
      .string()
      .min(5)
      .describe(
        "Por qué Luis quiere este cambio. Citar contexto: tesis, mercado, lección aprendida.",
      ),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    field: z.string(),
    previous: z.any(),
    new_value: z.any(),
  }),
  // requireApproval: true → Mastra le pide a Luis confirmar antes de ejecutar
  execute: async (rawInput: unknown) => {
    const context = (rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object")
      ? (rawInput as { context: Record<string, unknown> }).context
      : (rawInput as Record<string, unknown>);
    // Coerción del new_value (que viene siempre como string desde el LLM)
    // al tipo real que la BD espera, según el field.
    const field = context.field as keyof GovernanceRules;
    const raw = context.new_value;
    const numFields = new Set([
      "max_position_size_usd",
      "max_leverage",
      "max_daily_loss_usd",
      "max_concurrent_positions",
      "require_approval_above_usd",
    ]);
    const arrayFields = new Set(["allowed_symbols"]);
    let coerced: number | string | string[] | boolean;
    if (numFields.has(field as string)) {
      coerced = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(coerced)) {
        return {
          ok: false,
          field: context.field,
          previous: null,
          new_value: raw,
        };
      }
    } else if (arrayFields.has(field as string)) {
      if (Array.isArray(raw)) {
        coerced = raw.map((x) => String(x));
      } else if (typeof raw === "string") {
        // Acepta JSON o csv
        const trimmed = raw.trim();
        if (trimmed.startsWith("[")) {
          try {
            const parsed = JSON.parse(trimmed);
            coerced = Array.isArray(parsed) ? parsed.map((x) => String(x)) : [trimmed];
          } catch {
            coerced = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
          }
        } else {
          coerced = trimmed
            ? trimmed.split(",").map((s) => s.trim()).filter(Boolean)
            : [];
        }
      } else {
        coerced = [];
      }
    } else if (typeof raw === "boolean") {
      coerced = raw;
    } else if (raw === "true" || raw === "false") {
      coerced = raw === "true";
    } else {
      coerced = String(raw ?? "");
    }

    const result = await updateRule({
      field,
      newValue: coerced,
      actor: "luis",
      reason: context.reason,
    });
    return {
      ok: result.ok,
      field: context.field,
      previous: result.previous,
      new_value: coerced,
    };
  },
});

export const accionarKillSwitch = createTool({
  id: "accionar_kill_switch",
  description:
    "Activa o desactiva el kill-switch global. Activar bloquea TODAS las writes a Bybit hasta que se desactive. Desactivar permite reanudar operación. Usar cuando Luis diga 'para todo', 'pausa todo', 'reanuda', o cuando tú detectes un evento crítico (drawdown, mercado roto, error sistémico).",
  inputSchema: z.object({
    on: z.boolean().describe("true = activar kill-switch, false = desactivar."),
    reason: z
      .string()
      .min(5)
      .describe("Razón clara. Si on=true, qué pasó. Si on=false, qué se resolvió."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    state: z.string(),
  }),
  execute: async (rawInput: unknown) => {
    const context = (rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object")
      ? (rawInput as { context: Record<string, unknown> }).context
      : (rawInput as Record<string, unknown>);
    await setKillSwitch({
      on: context.on,
      actor: context.on ? "luis" : "tanit-or-luis",
      reason: context.reason,
    });
    return {
      ok: true,
      state: context.on ? "ACTIVO — todas las writes bloqueadas" : "INACTIVO — operación reanudada",
    };
  },
});

export const governanceTools = {
  consultarGovernance,
  ajustarGovernance,
  accionarKillSwitch,
};
