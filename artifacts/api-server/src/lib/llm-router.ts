/**
 * llm-router — wrapper único para todas las llamadas LLM del trading-engine.
 *
 * Antes: el motor de trading hacía ~9 llamadas hardcoded directas a
 *   - generativelanguage.googleapis.com (Gemini)
 *   - api.openai.com (GPT-4o-mini)
 *   - api.anthropic.com (Claude Haiku)
 *   - openrouter.ai (parcial, una sola ruta)
 *
 * Cada call site duplicaba retry, cooldown y fallback ad-hoc. Resultado:
 *   - cuando Gemini quemaba cuota, el trading NO rotaba a OpenRouter
 *     (solo el chat de Mastra lo hacía vía gemini-keys.ts)
 *   - sin routing por criticidad — todo iba siempre al mismo modelo
 *   - 14k líneas con 4 implementaciones de "JSON parse robusto"
 *
 * Ahora: un único `routeLLM({ tier, ... })` con cascada por TIER y
 *  failover transparente. Todas las llamadas pasan por OpenRouter primero
 *  (rotación interna de OR + costos predecibles), Gemini directo queda
 *  como red de seguridad de último recurso (4 keys propias).
 *
 * TIER 0  — clasificación, parseo, healthcheck, filtros de señal.
 *           Modelos gratis. Fallar es OK.
 * TIER 1  — heartbeat, intel briefing, conversación cotidiana.
 *           Gemini 2.5 Flash (paid vía OR) + Haiku como red.
 * TIER 2  — DECISIÓN de trade, escritura de tesis, memorias críticas.
 *           Sonnet 4.6 primero, Opus 4.7 segundo, Gemini 2.5 Flash red.
 *           Estas llamadas mueven dinero real — calidad sobre costo.
 */

export type LLMTier = 0 | 1 | 2;

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RouteLLMOptions {
  tier: LLMTier;
  /** System prompt — va separado del historial. */
  system: string;
  /** Historial alternado user/assistant + último turno user. */
  messages: LLMMessage[];
  /** Si true, fuerza respuesta JSON top-level. */
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Timeout TOTAL para el routing (incluyendo failovers). Default 35s. */
  timeoutMs?: number;
  /** Etiqueta opcional para logs (ej "intel-briefing", "trade-decision"). */
  tag?: string;
}

export interface RouteLLMResult {
  text: string;
  model: string;
  provider: "openrouter" | "google-direct";
  attempts: number;
}

interface ModelSpec {
  id: string;
  /** Sólo OpenRouter por ahora; google-direct se maneja aparte. */
  provider: "openrouter";
}

const TIER0: ModelSpec[] = [
  { id: "google/gemini-2.0-flash-exp:free",        provider: "openrouter" },
  { id: "deepseek/deepseek-chat-v3-0324:free",     provider: "openrouter" },
  { id: "meta-llama/llama-3.3-70b-instruct:free",  provider: "openrouter" },
  { id: "qwen/qwen3-30b-a3b:free",                 provider: "openrouter" },
];

const TIER1: ModelSpec[] = [
  { id: "google/gemini-2.5-flash",                 provider: "openrouter" },
  { id: "anthropic/claude-haiku-4.5",              provider: "openrouter" },
  { id: "google/gemini-2.0-flash-exp:free",        provider: "openrouter" },
];

const TIER2: ModelSpec[] = [
  { id: "anthropic/claude-sonnet-4.6",             provider: "openrouter" },
  { id: "anthropic/claude-opus-4.7",               provider: "openrouter" },
  { id: "google/gemini-2.5-flash",                 provider: "openrouter" },
  { id: "anthropic/claude-haiku-4.5",              provider: "openrouter" },
];

function modelsForTier(tier: LLMTier): ModelSpec[] {
  if (tier === 0) return TIER0;
  if (tier === 1) return TIER1;
  return TIER2;
}

const _exhaustedUntil: Map<string, number> = new Map();
const FREE_COOLDOWN_MS = 5 * 60 * 1000;
const PAID_COOLDOWN_MS = 60 * 1000;

function isExhausted(modelId: string): boolean {
  const until = _exhaustedUntil.get(modelId);
  return until !== undefined && until > Date.now();
}

function markExhausted(modelId: string): void {
  const isFree = modelId.includes(":free");
  _exhaustedUntil.set(modelId, Date.now() + (isFree ? FREE_COOLDOWN_MS : PAID_COOLDOWN_MS));
}

function isRateLimitError(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status === 503) return true;
  return /quota|exhausted|rate.?limit|RESOURCE_EXHAUSTED/i.test(body);
}

interface ORResponseChoice { message?: { content?: string } }
interface ORResponse { choices?: ORResponseChoice[]; error?: { message?: string } }

async function callOpenRouter(
  modelId: string,
  system: string,
  messages: LLMMessage[],
  jsonMode: boolean,
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
  tag: string,
): Promise<{ ok: true; text: string } | { ok: false; rateLimited: boolean; status?: number; reason: string }> {
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) return { ok: false, rateLimited: false, reason: "OPENROUTER_API_KEY no configurada" };

  const orMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: system },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const body: Record<string, unknown> = {
    model: modelId,
    messages: orMessages,
    max_tokens: maxTokens,
    temperature,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${orKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://tanit.work",
        "X-Title": "Tanit",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      const rateLimited = isRateLimitError(res.status, txt);
      console.log(`[llm-router:${tag}] OR ${modelId} HTTP ${res.status}${rateLimited ? " (rate-limited)" : ""}: ${txt.slice(0, 160)}`);
      return { ok: false, rateLimited, status: res.status, reason: `HTTP ${res.status}` };
    }
    const data = await res.json() as ORResponse;
    const text = (data?.choices?.[0]?.message?.content ?? "").trim();
    if (!text || text.length < 2) {
      return { ok: false, rateLimited: false, reason: "respuesta vacía" };
    }
    return { ok: true, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const rateLimited = /timeout|abort/i.test(msg) ? false : isRateLimitError(0, msg);
    console.log(`[llm-router:${tag}] OR ${modelId} excepción: ${msg}`);
    return { ok: false, rateLimited, reason: msg };
  }
}

/**
 * Red de seguridad: si todos los modelos OR fallan, intenta Gemini directo
 * con la primera key disponible. Solo para TIER 1 y 2 (TIER 0 no vale la pena
 * gastar una key Gemini en clasificaciones).
 */
async function callGeminiDirect(
  system: string,
  messages: LLMMessage[],
  jsonMode: boolean,
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
  tag: string,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const keys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
  ].filter((k): k is string => !!k && k.length > 10);
  if (keys.length === 0) return { ok: false, reason: "ninguna GEMINI_API_KEY configurada" };

  // Construir contents alternados (Gemini requiere user/model intercalados)
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  let lastRole: "user" | "model" | "" = "";
  for (const m of messages) {
    const role: "user" | "model" = m.role === "user" ? "user" : "model";
    if (role === lastRole) continue;
    if (contents.length === 0 && role !== "user") continue;
    contents.push({ role, parts: [{ text: m.content }] });
    lastRole = role;
  }
  if (contents.length === 0) {
    // Si messages no tenía nada utilizable, mandar system como single turn
    contents.push({ role: "user", parts: [{ text: "Continúa." }] });
  }

  const generationConfig: Record<string, unknown> = {
    temperature,
    maxOutputTokens: maxTokens,
  };
  if (jsonMode) generationConfig.responseMimeType = "application/json";

  for (const key of keys) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents,
            generationConfig,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.log(`[llm-router:${tag}] gemini-direct HTTP ${res.status}: ${txt.slice(0, 160)}`);
        continue;
      }
      const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
      if (text && text.length > 2) return { ok: true, text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[llm-router:${tag}] gemini-direct excepción: ${msg}`);
    }
  }
  return { ok: false, reason: "todas las keys Gemini fallaron" };
}

/**
 * Punto de entrada único. Selecciona modelo según tier, intenta uno por uno,
 * marca exhausted en rate-limit, y cae a Gemini directo si TIER ≥ 1 y todo
 * OpenRouter falló.
 */
export async function routeLLM(opts: RouteLLMOptions): Promise<RouteLLMResult> {
  const {
    tier,
    system,
    messages,
    jsonMode = false,
    maxTokens = 2048,
    temperature = 0.4,
    timeoutMs = 35_000,
    tag = `tier${tier}`,
  } = opts;

  const models = modelsForTier(tier);
  const perCallTimeout = Math.max(8_000, Math.floor(timeoutMs / Math.max(2, models.length)));
  let attempts = 0;

  for (const m of models) {
    if (isExhausted(m.id)) {
      console.log(`[llm-router:${tag}] skip ${m.id} (cooldown activo)`);
      continue;
    }
    attempts++;
    const result = await callOpenRouter(
      m.id, system, messages, jsonMode, maxTokens, temperature, perCallTimeout, tag,
    );
    if (result.ok) {
      return { text: result.text, model: m.id, provider: "openrouter", attempts };
    }
    if (result.rateLimited) markExhausted(m.id);
  }

  // Red de seguridad: Gemini directo para tiers que justifican gastar una key propia.
  if (tier >= 1) {
    attempts++;
    const fallback = await callGeminiDirect(
      system, messages, jsonMode, maxTokens, temperature, Math.max(15_000, perCallTimeout), tag,
    );
    if (fallback.ok) {
      return { text: fallback.text, model: "gemini-2.5-flash", provider: "google-direct", attempts };
    }
  }

  throw new Error(`[llm-router:${tag}] todos los modelos del tier ${tier} fallaron tras ${attempts} intentos`);
}

/**
 * Helper específico para llamadas JSON-mode con un único turno user.
 * Cubre el patrón más común en trading-engine: prompt + parseo JSON.
 */
export async function routeLLMJSON(opts: {
  tier: LLMTier;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  tag?: string;
}): Promise<{ text: string; model: string; provider: string }> {
  const result = await routeLLM({
    tier: opts.tier,
    system: opts.prompt,
    messages: [{ role: "user", content: "Genera la respuesta solicitada." }],
    jsonMode: true,
    maxTokens: opts.maxTokens ?? 2048,
    temperature: opts.temperature ?? 0.3,
    timeoutMs: opts.timeoutMs ?? 25_000,
    tag: opts.tag ?? `tier${opts.tier}-json`,
  });
  return { text: result.text, model: result.model, provider: result.provider };
}

export function getRouterStatus(): { exhausted: Array<{ model: string; resetAt: string }> } {
  const now = Date.now();
  const exhausted: Array<{ model: string; resetAt: string }> = [];
  for (const [model, until] of _exhaustedUntil.entries()) {
    if (until > now) exhausted.push({ model, resetAt: new Date(until).toISOString() });
  }
  return { exhausted };
}
