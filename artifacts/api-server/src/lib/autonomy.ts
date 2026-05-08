/**
 * Autonomía operativa — Fase E.
 *
 * Capa adicional sobre governance que controla CUÁNDO Tanit puede ejecutar
 * trades autónomamente sin que Luis confirme cada uno en chat. Governance
 * sigue siendo el suelo (kill-switch, max size, max leverage, símbolos
 * permitidos). Autonomy añade techo:
 *
 *  - mode = 'observe_only': solo reportes, jamás ejecuta. Es Fase D.
 *  - mode = 'propose_for_approval': observa + redacta propuestas. NO ejecuta
 *      autónomamente. Cada trade espera Luis.
 *  - mode = 'execute_with_governance': PUEDE ejecutar `confirmado=true`
 *      autónomo si pasa governance + cooldown + daily count + autonomy límits
 *      + cita tesis (si require_thesis_citation=true).
 *
 * Auto-pause: Tanit puede pausarse a sí misma si detecta condiciones malas.
 * El pause_until bloquea ejecución autónoma hasta que pase, sin tocar
 * governance.kill_switch_global.
 *
 * Default seguro: enabled=false, mode=observe_only. Activación explícita de
 * Luis vía tool ajustar_autonomia (con approval) o vía SQL directo.
 */
import { pool } from "@workspace/db";

export interface AutonomyConfig {
  id: number;
  enabled: boolean;
  mode: "observe_only" | "propose_for_approval" | "execute_with_governance";
  max_autonomous_size_usd: number;
  max_autonomous_leverage: number;
  max_daily_trades: number;
  cooldown_minutes_between_trades: number;
  require_thesis_citation: boolean;
  last_trade_at: string | null;
  daily_trade_count: number;
  daily_count_reset_at: string;
  paused_until: string | null;
  pause_reason: string | null;
  /**
   * Si true, el autonomous-loop ESCANEA el mercado cada N minutos sin que
   * Luis le hable. Este flag se controla desde la UI (POST /admin/autonomy/loop).
   * Independiente de `enabled` que solo controla si las write tools pueden
   * ejecutar — `loop_active` controla si Tanit toma la iniciativa.
   */
  loop_active: boolean;
  loop_interval_minutes: number;
  updated_at: string;
  updated_by: string;
}

let _loopMigrationDone = false;
async function ensureLoopColumns(): Promise<void> {
  if (_loopMigrationDone) return;
  try {
    await pool.query(
      `ALTER TABLE tanit_autonomy_config
        ADD COLUMN IF NOT EXISTS loop_active BOOLEAN NOT NULL DEFAULT false`,
    );
    await pool.query(
      `ALTER TABLE tanit_autonomy_config
        ADD COLUMN IF NOT EXISTS loop_interval_minutes INTEGER NOT NULL DEFAULT 15`,
    );
    _loopMigrationDone = true;
  } catch {
    /* idempotente; si falla seguimos */
  }
}

let _cache: { cfg: AutonomyConfig; ts: number } | null = null;
const CACHE_TTL_MS = 15_000;

export async function getAutonomyConfig(opts: { force?: boolean } = {}): Promise<AutonomyConfig> {
  if (!opts.force && _cache && Date.now() - _cache.ts < CACHE_TTL_MS) {
    return _cache.cfg;
  }
  await ensureLoopColumns();
  const r = await pool.query<AutonomyConfig>(
    `SELECT id, enabled, mode,
            max_autonomous_size_usd::float8 AS max_autonomous_size_usd,
            max_autonomous_leverage,
            max_daily_trades,
            cooldown_minutes_between_trades,
            require_thesis_citation,
            last_trade_at::text AS last_trade_at,
            daily_trade_count,
            daily_count_reset_at::text AS daily_count_reset_at,
            paused_until::text AS paused_until,
            pause_reason,
            COALESCE(loop_active, false) AS loop_active,
            COALESCE(loop_interval_minutes, 15) AS loop_interval_minutes,
            updated_at::text AS updated_at,
            updated_by
       FROM tanit_autonomy_config
      WHERE id = 1
      LIMIT 1`,
  );
  if (r.rows.length === 0) {
    throw new Error("autonomy: tabla vacía, no hay config");
  }
  const cfg = r.rows[0]!;
  _cache = { cfg, ts: Date.now() };
  return cfg;
}

export function invalidateAutonomyCache(): void {
  _cache = null;
}

export interface AutonomousActionGate {
  allowed: boolean;
  reason: string | null;
  rule: string | null;
}

/**
 * Pre-check que el loop autónomo (o cualquier write tool con contexto autónomo)
 * usa antes de ejecutar. Si falla, NO ejecuta.
 */
export async function gateAutonomousAction(args: {
  sizeUsd: number;
  leverage: number;
  thesis: string;
}): Promise<AutonomousActionGate> {
  const cfg = await getAutonomyConfig({ force: true });

  if (!cfg.enabled) {
    return { allowed: false, reason: "autonomy.enabled=false", rule: "enabled" };
  }
  if (cfg.mode !== "execute_with_governance") {
    return {
      allowed: false,
      reason: `mode=${cfg.mode} no permite ejecución autónoma`,
      rule: "mode",
    };
  }
  if (cfg.paused_until) {
    const until = new Date(cfg.paused_until).getTime();
    if (Date.now() < until) {
      return {
        allowed: false,
        reason: `pausado hasta ${cfg.paused_until} (${cfg.pause_reason ?? "sin razón"})`,
        rule: "paused_until",
      };
    }
  }

  // Reset daily count si cambió la fecha
  const today = new Date().toISOString().slice(0, 10);
  if (cfg.daily_count_reset_at.slice(0, 10) !== today) {
    await pool.query(
      `UPDATE tanit_autonomy_config
          SET daily_trade_count = 0,
              daily_count_reset_at = CURRENT_DATE
        WHERE id = 1`,
    );
    invalidateAutonomyCache();
    cfg.daily_trade_count = 0;
  }
  if (cfg.daily_trade_count >= cfg.max_daily_trades) {
    return {
      allowed: false,
      reason: `daily_trade_count=${cfg.daily_trade_count} >= max_daily_trades=${cfg.max_daily_trades}`,
      rule: "max_daily_trades",
    };
  }

  // Cooldown entre trades
  if (cfg.last_trade_at) {
    const last = new Date(cfg.last_trade_at).getTime();
    const elapsedMin = (Date.now() - last) / 60_000;
    if (elapsedMin < cfg.cooldown_minutes_between_trades) {
      return {
        allowed: false,
        reason: `cooldown: ${elapsedMin.toFixed(1)}min < ${cfg.cooldown_minutes_between_trades}min`,
        rule: "cooldown",
      };
    }
  }

  // Topes adicionales sobre governance
  if (args.sizeUsd > cfg.max_autonomous_size_usd) {
    return {
      allowed: false,
      reason: `sizeUsd=$${args.sizeUsd.toFixed(2)} > max_autonomous_size_usd=$${cfg.max_autonomous_size_usd.toFixed(2)}`,
      rule: "max_autonomous_size_usd",
    };
  }
  if (args.leverage > cfg.max_autonomous_leverage) {
    return {
      allowed: false,
      reason: `leverage=${args.leverage}x > max_autonomous_leverage=${cfg.max_autonomous_leverage}x`,
      rule: "max_autonomous_leverage",
    };
  }
  if (cfg.require_thesis_citation && (!args.thesis || args.thesis.trim().length < 20)) {
    return {
      allowed: false,
      reason: "tesis insuficiente: require_thesis_citation=true necesita ≥20 chars",
      rule: "require_thesis_citation",
    };
  }

  return { allowed: true, reason: null, rule: null };
}

export async function recordAutonomousTrade(args: {
  symbol: string;
  side: "long" | "short";
  sizeUsd: number;
  leverage: number;
  thesis: string;
}): Promise<void> {
  await pool.query(
    `UPDATE tanit_autonomy_config
        SET last_trade_at = now(),
            daily_trade_count = daily_trade_count + 1,
            updated_at = now()
      WHERE id = 1`,
  );
  await pool.query(
    `INSERT INTO tanit_autonomy_audit (actor, event, detail)
     VALUES ('tanit-autonomous-loop', 'AUTONOMOUS_TRADE', $1)`,
    [JSON.stringify(args)],
  );
  invalidateAutonomyCache();
}

export async function pauseAutonomy(args: {
  minutes: number;
  reason: string;
  actor: string;
}): Promise<void> {
  const until = new Date(Date.now() + args.minutes * 60_000).toISOString();
  await pool.query(
    `UPDATE tanit_autonomy_config
        SET paused_until = $1,
            pause_reason = $2,
            updated_at = now(),
            updated_by = $3
      WHERE id = 1`,
    [until, args.reason, args.actor],
  );
  await pool.query(
    `INSERT INTO tanit_autonomy_audit (actor, event, detail)
     VALUES ($1, 'PAUSE', $2)`,
    [args.actor, JSON.stringify({ until, reason: args.reason, minutes: args.minutes })],
  );
  invalidateAutonomyCache();
}

export async function resumeAutonomy(args: { reason: string; actor: string }): Promise<void> {
  await pool.query(
    `UPDATE tanit_autonomy_config
        SET paused_until = NULL,
            pause_reason = NULL,
            updated_at = now(),
            updated_by = $1
      WHERE id = 1`,
    [args.actor],
  );
  await pool.query(
    `INSERT INTO tanit_autonomy_audit (actor, event, detail)
     VALUES ($1, 'RESUME', $2)`,
    [args.actor, JSON.stringify({ reason: args.reason })],
  );
  invalidateAutonomyCache();
}

const editableFields = [
  "enabled",
  "mode",
  "max_autonomous_size_usd",
  "max_autonomous_leverage",
  "max_daily_trades",
  "cooldown_minutes_between_trades",
  "require_thesis_citation",
  "loop_active",
  "loop_interval_minutes",
] as const;

export type AutonomyEditableField = (typeof editableFields)[number];

export async function updateAutonomyConfig(args: {
  field: AutonomyEditableField;
  value: number | string | boolean;
  actor: string;
  reason: string;
}): Promise<{ ok: boolean; previous: unknown }> {
  if (!editableFields.includes(args.field)) {
    throw new Error(`Campo '${args.field}' no editable`);
  }
  const cur = await getAutonomyConfig({ force: true });
  const previous = (cur as unknown as Record<string, unknown>)[args.field];
  await pool.query(
    `UPDATE tanit_autonomy_config
        SET ${args.field} = $1,
            updated_at = now(),
            updated_by = $2
      WHERE id = 1`,
    [args.value, args.actor],
  );
  await pool.query(
    `INSERT INTO tanit_autonomy_audit (actor, event, detail)
     VALUES ($1, 'UPDATE', $2)`,
    [
      args.actor,
      JSON.stringify({
        field: args.field,
        previous,
        new_value: args.value,
        reason: args.reason,
      }),
    ],
  );
  invalidateAutonomyCache();
  return { ok: true, previous };
}

export async function autonomyAsPromptText(): Promise<string> {
  try {
    const cfg = await getAutonomyConfig();
    const pausedNow =
      cfg.paused_until && Date.now() < new Date(cfg.paused_until).getTime();
    const lines = [
      `## AUTONOMÍA OPERATIVA`,
      `Tu estado actual de autonomía. Esto define cuándo puedes ejecutar trades sin que Luis confirme uno por uno.`,
      ``,
      `- Activa: ${cfg.enabled ? "🟢 sí" : "🔴 no"}`,
      `- Modo: ${cfg.mode}`,
      `- Tope autónomo por trade: $${cfg.max_autonomous_size_usd.toFixed(2)} · ${cfg.max_autonomous_leverage}x`,
      `- Trades hoy: ${cfg.daily_trade_count} / ${cfg.max_daily_trades}`,
      `- Cooldown entre trades: ${cfg.cooldown_minutes_between_trades} min`,
      `- Última trade autónomo: ${cfg.last_trade_at ?? "ninguno"}`,
      `- Pausa activa: ${pausedNow ? `🔴 hasta ${cfg.paused_until} (${cfg.pause_reason ?? "?"})` : "🟢 no"}`,
      `- Requiere tesis citada: ${cfg.require_thesis_citation ? "sí" : "no"}`,
      ``,
    ];
    if (cfg.mode === "execute_with_governance" && cfg.enabled) {
      lines.push(
        `Cuando estés en el loop autónomo (thread autonomous-loop) y veas un setup, PUEDES invocar las write tools con confirmado=true SIEMPRE QUE: cumples governance + autonomía + tesis citada >= 20 chars + cooldown + daily count.`,
        `En el chat íntimo con Luis NUNCA ejecutas con confirmado=true sin que Luis te lo diga.`,
      );
    } else {
      lines.push(
        `Estás en modo ${cfg.mode}. NO ejecutas trades autónomamente. Si ves un setup, lo describes y esperas que Luis te lo autorice.`,
      );
    }
    return lines.filter(Boolean).join("\n");
  } catch (e) {
    return `## AUTONOMÍA OPERATIVA\n\n[Error leyendo autonomy: ${e instanceof Error ? e.message : String(e)}. Asume modo observe_only.]`;
  }
}
