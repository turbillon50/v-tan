/**
 * LLM providers manager — 3 pools + fallback OpenRouter con mezcla de modelos.
 *
 *  CHAT pool: 1 key dedicada (GEMINI_API_KEY) — solo conversación íntima
 *  con Luis. Aislada del consumo del loop para que él SIEMPRE pueda hablar
 *  con ella.
 *
 *  LIVE pool: 3 keys rotando (GEMINI_API_KEY_2, _3, _4) — para el live-loop
 *  24/7 que consume mucho. Cuando una se agota (Resource exhausted) la
 *  marcamos hasta el reset diario (medianoche UTC) y vamos a la siguiente.
 *
 *  FALLBACK pool: OPENROUTER_API_KEY — cuando los pools Gemini se agotan,
 *  rota por OR_FREE_MODELS en orden: modelos casi gratuitos o de coste mínimo.
 *  Cada modelo tiene su propio slot con exhaustion independiente para que un
 *  rate-limit en uno no bloquee a los demás.
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
 * Modelos de OpenRouter en orden de prioridad.
 * gemini-2.5-flash primero — es el más capaz y el costo es mínimo.
 * Los :free van después como red de seguridad si se acaba el crédito.
 */
export const OR_FREE_MODELS = [
  "google/gemini-2.5-flash",               // Primary — Gemini 2.5 Flash vía OR (mejor calidad)
  "google/gemini-2.0-flash-exp:free",      // Gemini 2.0 Flash, gratuito
  "deepseek/deepseek-chat-v3-0324:free",   // DeepSeek V3, excelente en chat, gratuito
  "qwen/qwen3-30b-a3b:free",               // Qwen 3 30B MoE, gratuito
  "meta-llama/llama-3.3-70b-instruct:free", // Llama 3.3 70B, gratuito
] as const;

export type Pool = "chat" | "live";
export type Provider = "google" | "openrouter";

interface KeySlot {
  pool: Pool | "fallback";
  provider: Provider;
  envName: string;
  /** Para slots OpenRouter: el modelo exacto a usar (con namespace). */
  modelId?: string;
  key: string;
  exhaustedUntilMs: number;
}

const _slots: KeySlot[] = [];
let _loaded = false;

function loadSlots(): void {
  if (_loaded) return;
  _loaded = true;

  const hasGeminiChat = CHAT_KEY_ENVS.some((e) => { const k = process.env[e]; return !!(k && k.length > 10); });
  const hasGeminiLive = LIVE_KEY_ENVS.some((e) => { const k = process.env[e]; return !!(k && k.length > 10); });

  for (const envName of CHAT_KEY_ENVS) {
    const k = process.env[envName];
    if (k && k.length > 10) _slots.push({ pool: "chat", provider: "google", envName, key: k, exhaustedUntilMs: 0 });
  }
  for (const envName of LIVE_KEY_ENVS) {
    const k = process.env[envName];
    if (k && k.length > 10) _slots.push({ pool: "live", provider: "google", envName, key: k, exhaustedUntilMs: 0 });
  }
  // Slots OpenRouter: si no hay Gemini, OR ocupa los pools primarios (chat + live).
  // Si hay Gemini, OR sigue como fallback.
  for (const envName of FALLBACK_KEY_ENVS) {
    const k = process.env[envName];
    if (k && k.length > 10) {
      for (const modelId of OR_FREE_MODELS) {
        // Sin Gemini → OR es primary (chat/live). Con Gemini → OR es fallback.
        const pool: KeySlot["pool"] = !hasGeminiChat ? "chat" : !hasGeminiLive ? "live" : "fallback";
        _slots.push({ pool, provider: "openrouter", envName, modelId, key: k, exhaustedUntilMs: 0 });
      }
    }
  }
  const summary = _slots.map((s) => ({ pool: s.pool, provider: s.provider, envName: s.envName, modelId: s.modelId }));
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
/** ID único de slot — distingue modelos OpenRouter distintos en la misma key. */
export function slotKey(s: KeySlot): string {
  return s.modelId ? `${s.envName}:${s.modelId}` : s.envName;
}

export function pickAvailableKey(pool: Pool, skip?: Set<string>): KeySlot | null {
  loadSlots();
  const now = Date.now();
  const tryPool = (p: KeySlot["pool"]): KeySlot | null => {
    for (const s of _slots) {
      if (s.pool !== p) continue;
      if (s.exhaustedUntilMs > now) continue;
      if (skip?.has(slotKey(s))) continue;
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

/** Marca un slot como agotado por su slotKey (envName o envName:modelId). */
export function markKeyExhausted(key: string): void {
  // Busca por slotKey exacto; para slots Google coincide con envName.
  const s = _slots.find((x) => slotKey(x) === key);
  if (!s) return;
  // Los modelos :free tienen rate-limit por minuto, no por día.
  // Usamos reset corto (5 min) para no bloquearnos demasiado tiempo.
  const isFreeModel = s.modelId?.includes(":free") ?? false;
  s.exhaustedUntilMs = isFreeModel ? Date.now() + 5 * 60 * 1000 : nextUtcMidnight();
  logger.warn(
    { key, pool: s.pool, modelId: s.modelId, resetAtUtc: new Date(s.exhaustedUntilMs).toISOString() },
    "[llm-keys] slot marcado exhausted",
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
  slots: { pool: string; provider: Provider; envName: string; modelId?: string; exhausted: boolean; resetAt: string | null }[];
} {
  loadSlots();
  const now = Date.now();
  const slots = _slots.map((s) => ({
    pool: s.pool,
    provider: s.provider,
    envName: s.envName,
    modelId: s.modelId,
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
 *  - provider=openrouter → createOpenAI con baseURL openrouter.ai/api/v1.
 *    El modelo usado es keySlot.modelId (ya tiene namespace, ej. "google/gemini-2.0-flash-exp:free").
 *    Si el slot no tiene modelId, cae al primer modelo de OR_FREE_MODELS.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildAgentForKey(keySlot: KeySlot, cfg: any): any {
  const { modelId: cfgModelId, ...rest } = cfg;
  if (keySlot.provider === "openrouter") {
    const openrouter = createOpenAI({
      apiKey: keySlot.key,
      baseURL: "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://tanit.work",
        "X-Title": "Tanit",
      },
    });
    const orModelId = keySlot.modelId ?? OR_FREE_MODELS[0];
    return new Agent({ ...rest, model: openrouter(orModelId) });
  }
  // default: google
  const google = createGoogleGenerativeAI({ apiKey: keySlot.key });
  return new Agent({ ...rest, model: google(cfgModelId) });
}

export type { KeySlot };
