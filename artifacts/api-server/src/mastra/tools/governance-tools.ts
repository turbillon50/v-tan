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

const editableFieldEnum = z.enum([
  "max_position_size_usd",
  "max_leverage",
  "max_daily_loss_usd",
  "max_concurrent_positions",
  "allowed_symbols",
  "operating_hours_utc",
  "require_approval_above_usd",
  "notes",
]);

export const ajustarGovernance = createTool({
  id: "ajustar_governance",
  description:
    "Modifica una regla de gobernanza. Requiere aprobación explícita del humano. Usar cuando Luis te pida cambiar un límite (ej. subir leverage máximo a 10x, agregar XRPUSDT a símbolos permitidos, ajustar pérdida diaria). Tú propones el cambio, Mastra le pide a Luis que lo confirme.",
  inputSchema: z.object({
    field: editableFieldEnum.describe("Nombre exacto del campo a modificar."),
    new_value: z
      .union([z.number(), z.string(), z.array(z.string()), z.boolean()])
      .describe("Nuevo valor. Tipo según el campo (number, string, string[], bool)."),
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
    const result = await updateRule({
      field: context.field as keyof GovernanceRules,
      newValue: context.new_value as number | string | string[] | boolean,
      actor: "luis",
      reason: context.reason,
    });
    return {
      ok: result.ok,
      field: context.field,
      previous: result.previous,
      new_value: context.new_value,
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
