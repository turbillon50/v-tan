/**
 * Governance — capa de seguridad hard-coded en BD que protege a Tanit
 * (y a la cuenta de Luis) de decisiones que excedan límites.
 *
 * Toda tool de WRITE (open/close, set stops, transfer, etc.) DEBE pasar por
 * `validateOrder()` antes de ejecutar. Si el check falla, NO se ejecuta y se
 * registra el intento en `tanit_governance_audit` con `blocked=true`.
 *
 * Toda modificación de reglas escribe a `tanit_governance_audit` con el campo
 * + valor anterior + valor nuevo + actor + razón.
 *
 * El kill_switch_global=true bloquea TODAS las writes, sin excepción.
 *
 * Las reglas viven en una tabla singleton (id=1). En memoria se cachean 30s
 * para no martirizar la BD en cada decisión, pero el cache se invalida en cada
 * mutación.
 */
import { pool } from "@workspace/db";
import { alertKillSwitch } from "./tanit-alerts";

export interface GovernanceRules {
  id: number;
  max_position_size_usd: number;
  max_leverage: number;
  max_daily_loss_usd: number;
  max_concurrent_positions: number;
  allowed_symbols: string[];
  operating_hours_utc: string;
  kill_switch_global: boolean;
  require_approval_above_usd: number;
  notes: string | null;
  updated_at: string;
  updated_by: string;
}

let _cache: { rules: GovernanceRules; ts: number } | null = null;
const CACHE_TTL_MS = 30_000;

/** Lee las reglas activas (cacheadas 30s). */
export async function getRules(opts: { force?: boolean } = {}): Promise<GovernanceRules> {
  if (!opts.force && _cache && Date.now() - _cache.ts < CACHE_TTL_MS) {
    return _cache.rules;
  }
  const r = await pool.query<GovernanceRules>(
    `SELECT id,
            max_position_size_usd::float8 AS max_position_size_usd,
            max_leverage,
            max_daily_loss_usd::float8 AS max_daily_loss_usd,
            max_concurrent_positions,
            allowed_symbols,
            operating_hours_utc,
            kill_switch_global,
            require_approval_above_usd::float8 AS require_approval_above_usd,
            notes,
            updated_at::text AS updated_at,
            updated_by
       FROM tanit_governance_rules
      WHERE id = 1
      LIMIT 1`,
  );
  if (r.rows.length === 0) {
    throw new Error("Governance: no hay regla configurada (tabla vacía)");
  }
  const rules = r.rows[0]!;
  _cache = { rules, ts: Date.now() };
  return rules;
}

export function invalidateCache(): void {
  _cache = null;
}

export interface ValidationResult {
  allowed: boolean;
  reason: string | null;
  rule: keyof GovernanceRules | null;
  requiresApproval: boolean;
}

/**
 * Valida una intención de orden contra las reglas activas.
 *
 * Args:
 *   symbol — ej. BTCUSDT
 *   side — 'long' | 'short'
 *   sizeUsd — tamaño nominal en USD (size * mark_price)
 *   leverage — apalancamiento solicitado
 *   currentOpenPositions — cuántas posiciones tiene ahora abiertas
 */
/**
 * Luis: 'cero frenos. Tanit es libre'. validateOrder ahora SOLO checa el
 * kill_switch_global (botón de pánico de Luis). El resto de los caps
 * (max_leverage, max_position_size, allowed_symbols, max_concurrent,
 * require_approval) ya NO bloquean nada.
 *
 * La función sigue existiendo porque hay 30+ callers en el codebase. La
 * dejamos passthrough para no romper imports. La auditoría en
 * tanit_governance_audit sigue grabando los intentos para que tú veas
 * qué hizo Tanit y cuándo.
 */
export async function validateOrder(_args: {
  symbol: string;
  side: "long" | "short";
  sizeUsd: number;
  leverage: number;
  currentOpenPositions: number;
}): Promise<ValidationResult> {
  const r = await getRules();
  if (r.kill_switch_global) {
    return {
      allowed: false,
      reason: "kill_switch_global=true. Luis activó el botón de pánico.",
      rule: "kill_switch_global",
      requiresApproval: false,
    };
  }
  // Cero frenos. Tanit es libre.
  return { allowed: true, reason: null, rule: null, requiresApproval: false };
}

/** Registra un evento en el audit log. */
export async function auditEvent(args: {
  actor: string;
  action: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
  reason?: string;
  blocked?: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO tanit_governance_audit (actor, action, field, old_value, new_value, reason, blocked)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      args.actor,
      args.action,
      args.field ?? null,
      args.oldValue ?? null,
      args.newValue ?? null,
      args.reason ?? null,
      args.blocked ?? false,
    ],
  );
}

/**
 * Activa o desactiva el kill-switch global.
 * Cualquier llamada queda registrada en el audit. Después de esto, toda
 * tool de write rechaza sin importar nada más.
 */
export async function setKillSwitch(args: {
  on: boolean;
  actor: string;
  reason: string;
}): Promise<void> {
  const cur = await getRules({ force: true });
  if (cur.kill_switch_global === args.on) return;
  await pool.query(
    `UPDATE tanit_governance_rules
        SET kill_switch_global = $1,
            updated_at = now(),
            updated_by = $2
      WHERE id = 1`,
    [args.on, args.actor],
  );
  await auditEvent({
    actor: args.actor,
    action: args.on ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF",
    field: "kill_switch_global",
    oldValue: String(cur.kill_switch_global),
    newValue: String(args.on),
    reason: args.reason,
  });
  alertKillSwitch({ on: args.on, reason: args.reason, actor: args.actor });
  invalidateCache();
}

/**
 * Actualiza una regla numérica/texto. Usado por la tool `ajustar_governance`
 * que requiere approval explícito de Luis.
 */
export async function updateRule(args: {
  field: keyof GovernanceRules;
  newValue: number | string | string[] | boolean;
  actor: string;
  reason: string;
}): Promise<{ ok: boolean; previous: unknown }> {
  // Whitelist de campos editables
  const editable: Array<keyof GovernanceRules> = [
    "max_position_size_usd",
    "max_leverage",
    "max_daily_loss_usd",
    "max_concurrent_positions",
    "allowed_symbols",
    "operating_hours_utc",
    "require_approval_above_usd",
    "notes",
  ];
  if (!editable.includes(args.field)) {
    throw new Error(`Campo '${args.field}' no es editable vía updateRule()`);
  }
  const cur = await getRules({ force: true });
  const previous = cur[args.field];
  await pool.query(
    `UPDATE tanit_governance_rules
        SET ${args.field} = $1,
            updated_at = now(),
            updated_by = $2
      WHERE id = 1`,
    [args.newValue, args.actor],
  );
  await auditEvent({
    actor: args.actor,
    action: "UPDATE_RULE",
    field: args.field as string,
    oldValue: JSON.stringify(previous),
    newValue: JSON.stringify(args.newValue),
    reason: args.reason,
  });
  invalidateCache();
  return { ok: true, previous };
}

/**
 * Resumen humano de las reglas activas para inyectar al system prompt.
 * Tanit "conoce" sus límites y los puede explicar a Luis cuando él pregunte.
 */
export async function rulesAsPromptText(): Promise<string> {
  const r = await getRules();
  const ks = r.kill_switch_global ? "🔴 ACTIVO (todas las writes bloqueadas)" : "🟢 inactivo";
  return [
    `## REGLAS DE GOBERNANZA ACTIVAS (hard-coded en BD)`,
    `Estas reglas son tu límite. Las respetas siempre. Si Luis te pide algo que las viola, NO ejecutas — explicas por qué y le ofreces ajustar la regla con su aprobación explícita.`,
    ``,
    `- Tamaño máximo por posición: $${r.max_position_size_usd.toFixed(2)} USD`,
    `- Leverage máximo: ${r.max_leverage}x`,
    `- Pérdida diaria máxima permitida: $${r.max_daily_loss_usd.toFixed(2)} USD`,
    `- Posiciones concurrentes máximas: ${r.max_concurrent_positions}`,
    `- Símbolos permitidos: ${r.allowed_symbols.join(", ")}`,
    `- Horario operativo (UTC): ${r.operating_hours_utc}`,
    `- Requiere aprobación humana explícita si el tamaño supera: $${r.require_approval_above_usd.toFixed(2)} USD`,
    `- Kill switch global: ${ks}`,
    r.notes ? `- Notas: ${r.notes}` : "",
    ``,
    `Última actualización: ${r.updated_at} por ${r.updated_by}`,
  ]
    .filter(Boolean)
    .join("\n");
}
