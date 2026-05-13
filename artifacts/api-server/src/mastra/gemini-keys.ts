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

/**
 * Modelos OpenRouter en orden de preferencia: free primero (sin costo cuando
 * dispoibles), pago después (Luis pagó OpenRouter para tener fallback real).
 * Cada modelo es un "sub-slot" virtual del slot OPENROUTER_API_KEY — si uno
 * da 429 o timeout, probamos el siguiente.
 *
 * NOTA: los :free son tier comunitario sin costo pero con rate limit por
 * minuto. Los de pago se cobran del crédito de la cuenta.
 */
/**
 * Modelos OpenRouter en orden de preferencia.
 * 2026-05-13: Luis pagó OpenRouter — priorizar modelos PAGA confiables
 * primero (Gemini 2.5 flash es el mismo modelo que directo a Google pero
 * con cuota independiente del crédito OpenRouter). Los modelos :free tienen
 * rate limits estrictos y aguantan mal contexto grande. Los dejamos como
 * último fallback por si el crédito se agota.
 */
export const OPENROUTER_MODEL_CHAIN = [
  "google/gemini-2.5-flash",                // paga, $0.30/M, mismo modelo que Gemini directo
  "anthropic/claude-haiku-4.5",             // paga, $1/M, muy rápido, voz distinta
  "openai/gpt-4o-mini",                     // paga, fallback rápido
  "google/gemini-2.0-flash-exp:free",       // free como último recurso
  "meta-llama/llama-3.3-70b-instruct:free", // free
  "deepseek/deepseek-chat:free",            // free
] as const;

export type Pool = "chat" | "live";
export type Provider = "google" | "openrouter";

interface KeySlot {
  pool: Pool | "fallback";
  provider: Provider;
  envName: string;
  key: string;
  exhaustedUntilMs: number;
  // Para OpenRouter: lista de modelos a iterar. Cada uno tiene su propio
  // estado exhausted (por minuto/día según el modelo).
  modelChain?: readonly string[];
  // Estado de modelos OpenRouter exhausted hasta cuándo (key=model, value=ms).
  modelExhaustedUntil?: Map<string, number>;
  // Modelo actualmente activo (para reporting).
  currentModel?: string;
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
    if (k && k.length > 10) {
      _slots.push({
        pool: "fallback",
        provider: "openrouter",
        envName,
        key: k,
        exhaustedUntilMs: 0,
        modelChain: OPENROUTER_MODEL_CHAIN,
        modelExhaustedUntil: new Map(),
        currentModel: OPENROUTER_MODEL_CHAIN[0],
      });
    }
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

export function markKeyExhausted(envName: string, model?: string): void {
  const s = _slots.find((x) => x.envName === envName);
  if (!s) return;
  // Si tenemos modelChain (OpenRouter), marcamos SOLO ese modelo como
  // exhausted por 1 minuto (los :free reset por minuto en OpenRouter).
  // El slot completo no se marca exhausted — los demás modelos siguen vivos.
  if (s.modelChain && model) {
    s.modelExhaustedUntil = s.modelExhaustedUntil ?? new Map();
    s.modelExhaustedUntil.set(model, Date.now() + 60_000);
    logger.warn({ envName, model, resetIn: "60s" }, "[llm-keys] modelo OpenRouter marcado exhausted por 60s");
    return;
  }
  // Para Gemini directo: hasta reset diario UTC.
  s.exhaustedUntilMs = nextUtcMidnight();
  logger.warn(
    { envName, pool: s.pool, resetAtUtc: new Date(s.exhaustedUntilMs).toISOString() },
    "[llm-keys] key marcada exhausted hasta reset",
  );
}

/**
 * Elige el siguiente modelo disponible en la chain de un slot OpenRouter.
 * Devuelve el primer modelo no exhausted, o null si todos están marcados.
 */
export function pickModelForSlot(slot: KeySlot, skipModels?: Set<string>): string | null {
  if (!slot.modelChain) return null;
  const now = Date.now();
  for (const model of slot.modelChain) {
    if (skipModels?.has(model)) continue;
    const exhaustedUntil = slot.modelExhaustedUntil?.get(model) ?? 0;
    if (exhaustedUntil > now) continue;
    return model;
  }
  return null;
}

/** Limpia las marcas exhausted (slots + modelos OpenRouter). */
export function clearAllExhausted(): void {
  for (const s of _slots) {
    s.exhaustedUntilMs = 0;
    if (s.modelExhaustedUntil) s.modelExhaustedUntil.clear();
  }
  logger.info("[llm-keys] todas las marcas exhausted limpiadas (slots + modelos)");
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
export function buildAgentForKey(keySlot: KeySlot, cfg: any, overrideModel?: string): any {
  const { modelId, ...rest } = cfg;
  if (keySlot.provider === "openrouter") {
    const openrouter = createOpenAI({
      apiKey: keySlot.key,
      baseURL: "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://tanit.work",
        "X-Title": "Tanit",
      },
    });
    // Para OpenRouter: si overrideModel viene (de la chain), usar ese.
    // Si no, el currentModel del slot, o el default.
    const effectiveModel = overrideModel ?? keySlot.currentModel ?? "google/gemini-2.5-flash";
    return new Agent({ ...rest, model: openrouter(effectiveModel) });
  }
  // default: google
  const google = createGoogleGenerativeAI({ apiKey: keySlot.key });
  return new Agent({ ...rest, model: google(modelId) });
}

export type { KeySlot };
