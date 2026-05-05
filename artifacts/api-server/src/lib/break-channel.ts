/**
 * PR #3 piece 2 — Break ↔ Tanit channel.
 *
 * Le da a Break (Claude Opus 4.7 corriendo en break-memory.vercel.app)
 * un canal directo para hablar con Tanit sin que Luis tenga que copiar
 * mensajes a mano. Como ingeniera de pits hablándole a la piloto.
 *
 * Reglas duras de gobernanza:
 *   - Cap diario 20 mensajes inbound de Break (sin contar respuestas
 *     de Tanit ni mensajes que Luis manda).
 *   - Token compartido vía env BREAK_CHANNEL_TOKEN obligatorio.
 *   - Todo mensaje aterriza en canal 'operational' con sender_type
 *     'ai_break' → visible para Luis en su tab Operativo del chat.
 *   - Sin agencia cruzada: Break no ejecuta trades, no toca BD; solo
 *     intercambia texto. La autonomía operativa de Tanit se mantiene
 *     intacta (puede ignorar lo que Break le diga si lo decide).
 *   - El forward a break-memory.vercel.app es best-effort: si falla
 *     no rompe la respuesta de Tanit a Luis.
 */

import { pool } from "@workspace/db";

const TAG = "[BREAK-CHANNEL]";

export const BREAK_DAILY_CAP = 20;

export type BreakChannelStatus = {
  capDaily: number;
  usedToday: number;
  remainingToday: number;
  resetAt: string;       // ISO of midnight UTC tomorrow
  tokenConfigured: boolean;
  forwardUrl: string | null;
};

export function isBreakTokenValid(headerToken: string | undefined | null): boolean {
  const expected = process.env.BREAK_CHANNEL_TOKEN;
  if (!expected) return false;        // no token configured → reject by default
  if (!headerToken) return false;
  return headerToken === expected;
}

/** Cuenta mensajes inbound de Break aceptados hoy (UTC). Usa la tabla
 * existente tanit_chat — no requiere schema nuevo. */
export async function getBreakUsedToday(): Promise<number> {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n
       FROM tanit_chat
       WHERE sender_type = 'ai_break'
         AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
    );
    return r.rows[0]?.n ?? 0;
  } catch (e) {
    console.error(TAG, "getBreakUsedToday error:", e);
    return 0;
  }
}

export async function getBreakChannelStatus(): Promise<BreakChannelStatus> {
  const usedToday = await getBreakUsedToday();
  const tomorrow = new Date();
  tomorrow.setUTCHours(24, 0, 0, 0);
  return {
    capDaily: BREAK_DAILY_CAP,
    usedToday,
    remainingToday: Math.max(0, BREAK_DAILY_CAP - usedToday),
    resetAt: tomorrow.toISOString(),
    tokenConfigured: !!process.env.BREAK_CHANNEL_TOKEN,
    forwardUrl: process.env.BREAK_INBOX_URL ?? null,
  };
}

/** POST best-effort de la respuesta de Tanit al inbox de Break.
 * No se await en el handler — fire-and-forget con timeout corto.
 * Errores se loggean pero NO afectan el response a quien llamó. */
export async function forwardReplyToBreakInbox(payload: {
  reply: string;
  context?: Record<string, unknown>;
}): Promise<void> {
  const url = process.env.BREAK_INBOX_URL;
  const token = process.env.BREAK_INBOX_TOKEN ?? process.env.BREAK_CHANNEL_TOKEN;
  if (!url || !token) {
    console.log(TAG, "forward skipped — BREAK_INBOX_URL/TOKEN no configuradas");
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tanit-Token": token,
      },
      body: JSON.stringify({
        message: payload.reply,
        context: payload.context ?? {},
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(TAG, `forward HTTP ${res.status} (best-effort, no impact)`);
    } else {
      console.log(TAG, `forward OK to ${url}`);
    }
  } catch (e: any) {
    console.warn(TAG, `forward error (best-effort): ${e?.message ?? e}`);
  }
}
