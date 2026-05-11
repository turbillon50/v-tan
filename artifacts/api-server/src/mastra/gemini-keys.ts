/**
 * Gemini keys manager — 2 pools separados.
 *
 *  CHAT pool: 1 key dedicada (GEMINI_API_KEY) — solo conversación íntima
 *  con Luis. Aislada del consumo del loop para que él SIEMPRE pueda hablar
 *  con ella.
 *
 *  LIVE pool: 3 keys rotando (GEMINI_API_KEY_2, _3, _4) — para el live-loop
 *  24/7 que consume mucho. Cuando una se agota (Resource exhausted) la
 *  marcamos hasta el reset diario (medianoche UTC) y vamos a la siguiente.
 *
 * Si LIVE pool no tiene ninguna key configurada, el loop cae sobre la CHAT
 * pool — degradado, pero opera.
 */
import { Agent } from "@mastra/core/agent";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { logger } from "../lib/logger";

const CHAT_KEY_ENVS = ["GEMINI_API_KEY"] as const;
const LIVE_KEY_ENVS = [
  "GEMINI_API_KEY_2",
  "GEMINI_API_KEY_3",
  "GEMINI_API_KEY_4",
] as const;

export type Pool = "chat" | "live";

interface KeySlot {
  pool: Pool;
  envName: string;
  key: string;
  exhaustedUntilMs: number;
}

const _slots: KeySlot[] = [];
let _loaded = false;

function loadSlots(): void {
  if (_loaded) return;
  _loaded = true;
  for (const envName of CHAT_KEY_ENVS) {
    const k = process.env[envName];
    if (k && k.length > 10) _slots.push({ pool: "chat", envName, key: k, exhaustedUntilMs: 0 });
  }
  for (const envName of LIVE_KEY_ENVS) {
    const k = process.env[envName];
    if (k && k.length > 10) _slots.push({ pool: "live", envName, key: k, exhaustedUntilMs: 0 });
  }
  const summary = _slots.map((s) => ({ pool: s.pool, envName: s.envName }));
  logger.info({ count: _slots.length, summary }, "[gemini-keys] pools cargados");
}

function nextUtcMidnight(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
}

/**
 * Devuelve la primera key disponible del pool pedido, excluyendo las que
 * estén en `skip` (típicamente keys ya intentadas en este mismo request).
 *
 * Fallback policy:
 *  - pool=chat: si la(s) key(s) chat están agotadas, FALLBACK a live pool
 *    (Luis SIEMPRE debe poder hablar con ella aunque el loop tome chat).
 *  - pool=live: si las live están agotadas, NO fallback (mejor mudo el loop
 *    que que el loop se coma la única key del chat).
 */
export function pickAvailableKey(pool: Pool, skip?: Set<string>): KeySlot | null {
  loadSlots();
  const now = Date.now();
  // Primary pool
  for (const s of _slots) {
    if (s.pool !== pool) continue;
    if (s.exhaustedUntilMs > now) continue;
    if (skip?.has(s.envName)) continue;
    return s;
  }
  // Fallback: si pedías chat y no hay disponible, intenta live (degradado
  // pero permite que Luis hable cuando su única key chat está exhausted).
  if (pool === "chat") {
    for (const s of _slots) {
      if (s.pool !== "live") continue;
      if (s.exhaustedUntilMs > now) continue;
      if (skip?.has(s.envName)) continue;
      return s;
    }
  }
  return null;
}

export function markKeyExhausted(envName: string): void {
  const s = _slots.find((x) => x.envName === envName);
  if (!s) return;
  s.exhaustedUntilMs = nextUtcMidnight();
  logger.warn(
    { envName, pool: s.pool, resetAtUtc: new Date(s.exhaustedUntilMs).toISOString() },
    "[gemini-keys] key marcada exhausted hasta reset",
  );
}

/** Limpia las marcas exhausted. Para usar tras agregar keys nuevas o tras
 * sospechar falsos positivos. Las cuotas reales de Google no cambian — solo
 * permite que el sistema vuelva a intentarlas. */
export function clearAllExhausted(): void {
  for (const s of _slots) s.exhaustedUntilMs = 0;
  logger.info("[gemini-keys] todas las marcas exhausted limpiadas");
}

export function getKeysStatus(): {
  total: number;
  activeChat: number;
  activeLive: number;
  slots: { pool: Pool; envName: string; exhausted: boolean; resetAt: string | null }[];
} {
  loadSlots();
  const now = Date.now();
  const slots = _slots.map((s) => ({
    pool: s.pool,
    envName: s.envName,
    exhausted: s.exhaustedUntilMs > now,
    resetAt: s.exhaustedUntilMs > 0 ? new Date(s.exhaustedUntilMs).toISOString() : null,
  }));
  return {
    total: _slots.length,
    activeChat: slots.filter((s) => s.pool === "chat" && !s.exhausted).length,
    activeLive: slots.filter((s) => s.pool === "live" && !s.exhausted).length,
    slots,
  };
}

export function isExhaustedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /exhausted|quota|RESOURCE_EXHAUSTED|\b429\b/i.test(msg);
}

/**
 * Construye un Agent Mastra con la key + bootstrap proveídos. Cada call
 * crea un Agent nuevo — overhead aceptable por la flexibilidad de rotación.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildAgentForKey(keySlot: KeySlot, cfg: any): any {
  const google = createGoogleGenerativeAI({ apiKey: keySlot.key });
  const { modelId, ...rest } = cfg;
  return new Agent({ ...rest, model: google(modelId) });
}

export type { KeySlot };
