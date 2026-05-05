/**
 * GUARDRAILS — Tesis v4.1 "Tanit Soberana con Equipo"
 *
 * NO son una jaula. Son el chasis y la FIA: protegen la capacidad de Tanit
 * de seguir operando y existiendo. Los valores aquí son LECCIONES PROPIAS
 * que ella destiló de sus errores reales (categoría LECCION_CRITICA en su
 * memoria), no opiniones humanas.
 *
 * Auto-corrige silenciosamente cuando puede (SL/TP fuera de rango → cap)
 * y registra cada corrección en `guardrail_events` para que ella sepa que
 * el sistema la corrigió. Bloquea cuando no puede corregir (blue-chip
 * avoid, equity < $2).
 */

import { pool } from "@workspace/db";

const TAG = "[GUARDRAILS]";

export const GUARDRAILS = {
  /** Lección 22-abr (memoria id=2714): ATR_SL < 1.5 = stop-outs constantes en cada wick. */
  MIN_ATR_SL_MULTIPLIER: 1.5,
  /** Lección 24-abr (memoria id=2716): TP a 10×ATR es inalcanzable, los trades cierran sin tocarlo. */
  MAX_ATR_TP_MULTIPLIER: 6.0,
  /** Lección 22-abr (memoria id=2713): ATOM 5x→75x en 30s reventó por falta de cooldown. */
  LEVERAGE_ESCALATION_COOLDOWN_MS: 3 * 60 * 1000,
  /** Tesis v4.1: estos símbolos nunca pueden ir a `sym_avoid_*`. Son su universo base. */
  BLUE_CHIPS_NEVER_AVOID: new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT"]),
  /** Tesis v4.1: bajo este threshold se pausa 24h y se fuerza destilación de lección. */
  EQUITY_PROTECTION_THRESHOLD_USDT: 2.0,
  EQUITY_PROTECTION_PAUSE_HOURS: 24,
} as const;

const LESSON_REFS = {
  SL_TOO_TIGHT: "id=2714 (22-abr): ATR_SL_MULTIPLIER < 1.5 ES SUICIDA",
  TP_UNREACHABLE: "id=2716 (24-abr): NUNCA SUBIR TP A CIEGAS CUANDO PF<1",
  LEV_COOLDOWN: "id=2713 (22-abr): DYN-LEV SIN COOLDOWN DESTRUYÓ EL CAPITAL",
  BLUE_CHIP_AVOID: "Tesis v4.1: BTC/ETH/SOL son universo base inviolable",
  EQUITY_PROTECTION: "Tesis v4.1: equity < $2 = pausa 24h forzada para destilar lección",
} as const;

export type GuardrailViolation = {
  type: "SL_TOO_TIGHT" | "TP_UNREACHABLE" | "BLUE_CHIP_AVOID_BLOCKED" | "LEV_COOLDOWN" | "EQUITY_PROTECTION";
  symbol?: string;
  requested: unknown;
  enforced: unknown;
  lessonRef: string;
};

async function persistGuardrailEvent(v: GuardrailViolation): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO guardrail_events (event_type, symbol, requested, enforced, lesson_ref) VALUES ($1, $2, $3, $4, $5)`,
      [v.type, v.symbol ?? null, JSON.stringify(v.requested), JSON.stringify(v.enforced), v.lessonRef],
    );
    console.log(TAG, `Persisted: ${v.type} on ${v.symbol ?? "—"} | ${v.lessonRef}`);
  } catch (e) {
    console.error(TAG, "persistGuardrailEvent error:", e);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Inviolables 1+2: SL too tight / TP unreachable
// AUTO-AJUSTA al límite de la lección y persiste el evento para auditoría.
// Devuelve los valores corregidos para que el caller los aplique.
// ────────────────────────────────────────────────────────────────────────

export async function enforceAtrSlMultiplier(symbol: string, requested: number): Promise<number> {
  if (requested >= GUARDRAILS.MIN_ATR_SL_MULTIPLIER) return requested;
  await persistGuardrailEvent({
    type: "SL_TOO_TIGHT",
    symbol,
    requested,
    enforced: GUARDRAILS.MIN_ATR_SL_MULTIPLIER,
    lessonRef: LESSON_REFS.SL_TOO_TIGHT,
  });
  return GUARDRAILS.MIN_ATR_SL_MULTIPLIER;
}

export async function enforceAtrTpMultiplier(symbol: string, requested: number): Promise<number> {
  if (requested <= GUARDRAILS.MAX_ATR_TP_MULTIPLIER) return requested;
  await persistGuardrailEvent({
    type: "TP_UNREACHABLE",
    symbol,
    requested,
    enforced: GUARDRAILS.MAX_ATR_TP_MULTIPLIER,
    lessonRef: LESSON_REFS.TP_UNREACHABLE,
  });
  return GUARDRAILS.MAX_ATR_TP_MULTIPLIER;
}

// ────────────────────────────────────────────────────────────────────────
// Inviolable 3: Blue chips never in avoid
// BLOQUEA (no auto-ajusta — es una decisión categórica).
// ────────────────────────────────────────────────────────────────────────

export async function isBlueChipAvoidBlocked(symbol: string): Promise<boolean> {
  const blocked = GUARDRAILS.BLUE_CHIPS_NEVER_AVOID.has(symbol.toUpperCase());
  if (blocked) {
    await persistGuardrailEvent({
      type: "BLUE_CHIP_AVOID_BLOCKED",
      symbol,
      requested: { action: "ADD_TO_AVOID" },
      enforced: { action: "REJECTED" },
      lessonRef: LESSON_REFS.BLUE_CHIP_AVOID,
    });
  }
  return blocked;
}

// ────────────────────────────────────────────────────────────────────────
// Inviolable 4: Leverage escalation cooldown
// De-escalación SIEMPRE permitida (urgencia). Escalación arriba requiere
// cooldown 3min desde la última del mismo símbolo.
// ────────────────────────────────────────────────────────────────────────

export type LeverageDecision =
  | { proceed: true; reason: string }
  | { proceed: false; reason: "COOLDOWN_ACTIVE"; remainingMs: number };

export async function validateLeverageEscalation(
  symbol: string,
  currentLeverage: number,
  newLeverage: number,
): Promise<LeverageDecision> {
  if (newLeverage <= currentLeverage) {
    return { proceed: true, reason: "DE_ESCALATION_ALWAYS_INSTANT" };
  }
  let lastTs = 0;
  try {
    const r = await pool.query(
      `SELECT EXTRACT(EPOCH FROM last_escalation_at) * 1000 AS ts FROM leverage_cooldowns WHERE symbol = $1`,
      [symbol],
    );
    lastTs = Number(r.rows[0]?.ts ?? 0);
  } catch {}
  const elapsed = Date.now() - lastTs;
  if (lastTs > 0 && elapsed < GUARDRAILS.LEVERAGE_ESCALATION_COOLDOWN_MS) {
    const remainingMs = GUARDRAILS.LEVERAGE_ESCALATION_COOLDOWN_MS - elapsed;
    await persistGuardrailEvent({
      type: "LEV_COOLDOWN",
      symbol,
      requested: { from: currentLeverage, to: newLeverage },
      enforced: { blocked: true, remainingMs },
      lessonRef: LESSON_REFS.LEV_COOLDOWN,
    });
    return { proceed: false, reason: "COOLDOWN_ACTIVE", remainingMs };
  }
  return { proceed: true, reason: "OK" };
}

export async function recordLeverageEscalation(symbol: string, oldLev: number, newLev: number): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO leverage_cooldowns (symbol, last_escalation_at, last_old_leverage, last_new_leverage)
       VALUES ($1, NOW(), $2, $3)
       ON CONFLICT (symbol) DO UPDATE SET
         last_escalation_at = NOW(),
         last_old_leverage = EXCLUDED.last_old_leverage,
         last_new_leverage = EXCLUDED.last_new_leverage`,
      [symbol, oldLev, newLev],
    );
  } catch (e) {
    console.error(TAG, "recordLeverageEscalation error:", e);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Inviolable 5: Equity protection
// Si equity cae bajo $2 USDT, pausa trading 24h y fuerza destilación.
// El caller pasa los hooks (pauseFor, persistLesson, alert) porque viven
// en trading-engine.
// ────────────────────────────────────────────────────────────────────────

export type EquityProtectionHooks = {
  pauseTradingFor: (hours: number) => Promise<void> | void;
  persistCriticalLessonRequired: (equity: number) => Promise<void> | void;
  alertLuisAndBreak: (event: string, payload: Record<string, unknown>) => Promise<void> | void;
};

let _equityProtectionActive = false;

export async function checkEquityProtection(currentEquity: number, hooks: EquityProtectionHooks): Promise<{ paused: boolean }> {
  if (currentEquity >= GUARDRAILS.EQUITY_PROTECTION_THRESHOLD_USDT) {
    return { paused: false };
  }
  if (_equityProtectionActive) {
    // Already active in this process — don't double-fire alerts.
    return { paused: true };
  }
  _equityProtectionActive = true;
  await persistGuardrailEvent({
    type: "EQUITY_PROTECTION",
    requested: { equity: currentEquity },
    enforced: { paused: true, hours: GUARDRAILS.EQUITY_PROTECTION_PAUSE_HOURS },
    lessonRef: LESSON_REFS.EQUITY_PROTECTION,
  });
  try { await hooks.pauseTradingFor(GUARDRAILS.EQUITY_PROTECTION_PAUSE_HOURS); } catch (e) { console.error(TAG, "pauseTradingFor:", e); }
  try { await hooks.persistCriticalLessonRequired(currentEquity); } catch (e) { console.error(TAG, "persistCriticalLessonRequired:", e); }
  try { await hooks.alertLuisAndBreak("EQUITY_PROTECTION_ACTIVATED", { equity: currentEquity, pausedHours: GUARDRAILS.EQUITY_PROTECTION_PAUSE_HOURS }); } catch (e) { console.error(TAG, "alertLuisAndBreak:", e); }
  return { paused: true };
}

// ────────────────────────────────────────────────────────────────────────
// Recap helper for the chat-context prompt — Tanit reads recent guardrail
// events so she internalizes that the system corrected her.
// ────────────────────────────────────────────────────────────────────────

export async function getRecentGuardrailEvents(limit = 10): Promise<Array<{
  id: number; eventType: string; symbol: string | null; requested: unknown; enforced: unknown; lessonRef: string | null; createdAt: string;
}>> {
  try {
    const r = await pool.query(
      `SELECT id, event_type AS "eventType", symbol, requested, enforced, lesson_ref AS "lessonRef", created_at AS "createdAt"
       FROM guardrail_events ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return r.rows;
  } catch {
    return [];
  }
}
