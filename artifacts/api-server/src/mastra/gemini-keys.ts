/**
 * LLM providers manager — 3 pools + fallback OpenRouter.
 *
 *  CHAT pool: 1 key dedicada (GEMINI_API_KEY) — solo conversación íntima
 *  con Luis. Aislada del consumo del loop para que él SIEMPRE pueda hablar
 *  con ella.
 *
 *  LIVE pool: 3 keys rotando (GEMINI_API_KEY_2, _3, _4) — para el live-loop
 *  24/7 que consume mucho. Cuando una se agota (Resource exhausted) la
 *  marcamos hasta el reset diario (medianoche UTC) y vamos a la siguiente.
 *
 *  FALLBACK pool: OPENROUTER_API_KEY — backup universal. Cuando los pools
 *  primarios están agotados, OpenRouter sirve `google/gemini-2.5-flash`
 *  (mismo modelo, cuota independiente). Sin OpenRouter configurado, el
 *  fallback chat→live se sigue intentando.
 */
import { Agent } from "@mastra/core/agent";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { logger } from "../lib/logger";

const CHAT_KEY_ENVS = ["GEMINI_API_KEY"] as const;
const LIVE_KEY_ENVS = [
  "GEMINI_API_KEY_2",
  "GEMINI_API_KEY_3",
  "GEMINI_API_KEY_4",
] as const;
const FALLBACK_KEY_ENVS = ["OPENROUTER_API_KEY"] as const;

export type Pool = "chat" | "live";
export type Provider = "google" | "openrouter";

interface KeySlot {
  pool: Pool | "fallback";
  provider: Provider;
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
    if (k && k.length > 10) _slots.push({ pool: "chat", provider: "google", envName, key: k, exhaustedUntilMs: 0 });
  }
  for (const envName of LIVE_KEY_ENVS) {
    const k = process.env[envName];
    if (k && k.length > 10) _slots.push({ pool: "live", provider: "google", envName, key: k, exhaustedUntilMs: 0 });
  }
  for (const envName of FALLBACK_KEY_ENVS) {
    const k = process.env[envName];
    if (k && k.length > 10) _slots.push({ pool: "fallback", provider: "openrouter", envName, key: k, exhaustedUntilMs: 0 });
  }
  const summary = _slots.map((s) => ({ pool: s.pool, provider: s.provider, envName: s.envName }));
  logger.info({ count: _slots.length, summary }, "[llm-keys] pools cargados");
}

function nextUtcMidnight(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
}

/**
 * Devuelve la primera key disponible del pool pedido, excluyendo las que
 * estén en `skip` (típicamente keys ya intentadas en este mismo request).
 *
 * Cascada para pool=chat: chat → live → fallback.
 * Cascada para pool=live: live → fallback (no toca chat para preservar la
 * cuota dedicada de Luis).
 */
export function pickAvailableKey(pool: Pool, skip?: Set<string>): KeySlot | null {
  loadSlots();
  const now = Date.now();
  const tryPool = (p: KeySlot["pool"]): KeySlot | null => {
    for (const s of _slots) {
      if (s.pool !== p) continue;
      if (s.exhaustedUntilMs > now) continue;
      if (skip?.has(s.envName)) continue;
      return s;
    }
    return null;
  };
  // Primary
  const primary = tryPool(pool);
  if (primary) return primary;
  // Cascada: chat → live → fallback ; live → fallback
  if (pool === "chat") {
    const live = tryPool("live");
    if (live) return live;
  }
  const fb = tryPool("fallback");
  if (fb) return fb;
  return null;
}

export function markKeyExhausted(envName: string): void {
  const s = _slots.find((x) => x.envName === envName);
  if (!s) return;
  s.exhaustedUntilMs = nextUtcMidnight();
  logger.warn(
    { envName, pool: s.pool, resetAtUtc: new Date(s.exhaustedUntilMs).toISOString() },
    "[llm-keys] key marcada exhausted hasta reset",
  );
}

/** Limpia las marcas exhausted. Para usar tras agregar keys nuevas o tras
 * sospechar falsos positivos. */
export function clearAllExhausted(): void {
  for (const s of _slots) s.exhaustedUntilMs = 0;
  logger.info("[llm-keys] todas las marcas exhausted limpiadas");
}

export function getKeysStatus(): {
  total: number;
  activeChat: number;
  activeLive: number;
  activeFallback: number;
  slots: { pool: string; provider: Provider; envName: string; exhausted: boolean; resetAt: string | null }[];
} {
  loadSlots();
  const now = Date.now();
  const slots = _slots.map((s) => ({
    pool: s.pool,
    provider: s.provider,
    envName: s.envName,
    exhausted: s.exhaustedUntilMs > now,
    resetAt: s.exhaustedUntilMs > 0 ? new Date(s.exhaustedUntilMs).toISOString() : null,
  }));
  return {
    total: _slots.length,
    activeChat: slots.filter((s) => s.pool === "chat" && !s.exhausted).length,
    activeLive: slots.filter((s) => s.pool === "live" && !s.exhausted).length,
    activeFallback: slots.filter((s) => s.pool === "fallback" && !s.exhausted).length,
    slots,
  };
}

export function isExhaustedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /exhausted|quota|RESOURCE_EXHAUSTED|\b429\b/i.test(msg);
}

/**
 * Construye un Agent Mastra con el provider correspondiente al slot.
 *  - provider=google → createGoogleGenerativeAI con apiKey directa.
 *  - provider=openrouter → createOpenAI con baseURL openrouter.ai/api/v1 +
 *    modelo prefijado con namespace ("google/gemini-2.5-flash").
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildAgentForKey(keySlot: KeySlot, cfg: any): any {
  const { modelId, ...rest } = cfg;
  if (keySlot.provider === "openrouter") {
    const openrouter = createOpenAI({
      apiKey: keySlot.key,
      baseURL: "https://openrouter.ai/api/v1",
      // OpenRouter pide headers para identificación (opcional pero buena práctica).
      headers: {
        "HTTP-Referer": "https://tanit.work",
        "X-Title": "Tanit",
      },
    });
    // En OpenRouter, gemini-2.5-flash se llama google/gemini-2.5-flash.
    // Mantenemos el mismo modelo para preservar voz.
    const orModelId = modelId.includes("/") ? modelId : `google/${modelId}`;
    return new Agent({ ...rest, model: openrouter(orModelId) });
  }
  // default: google
  const google = createGoogleGenerativeAI({ apiKey: keySlot.key });
  return new Agent({ ...rest, model: google(modelId) });
}

export type { KeySlot };
