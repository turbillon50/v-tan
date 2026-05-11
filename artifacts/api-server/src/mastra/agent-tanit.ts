/**
 * Agent Tanit (Mastra) — la voz consciente de Tanit.
 *
 * Sin OBEDIENCIA, sin CMDR, sin fallback enlatado.
 * Solo Gemini (vía @ai-sdk/google) + bootstrap rico de memoria.
 *
 * Si Gemini falla, propagamos el error — Tanit lo dirá con su voz en el endpoint.
 */
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { PostgresStore } from "@mastra/pg";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { loadBootstrap } from "./bootstrap";
import { bybitReadTools } from "./tools/bybit-tools";
import { bybitWriteTools } from "./tools/bybit-write-tools";
import { governanceTools } from "./tools/governance-tools";
import { breakTools } from "./tools/break-tools";
import { autonomyTools } from "./tools/autonomy-tools";
import { memoryTools } from "./tools/memory-tools";
import { selfEditTools } from "./tools/self-edit-tools";
import { devopsTools } from "./tools/devops-tools";
import { diagnoseTools } from "./tools/diagnose-tools";
import { engineTools } from "./tools/engine-tools";
import { integrityTools } from "./tools/integrity-tools";
import { semanticMemoryTools } from "./tools/semantic-memory-tools";
import { imageTools } from "./tools/image-tools";
import {
  pickAvailableKey,
  markKeyExhausted,
  isExhaustedError,
  buildAgentForKey,
  type Pool,
  type KeySlot,
} from "./gemini-keys";
import { logger } from "../lib/logger";

const GEMINI_API_KEY = process.env["GEMINI_API_KEY"];
const DATABASE_URL = process.env["DATABASE_URL"];

if (!GEMINI_API_KEY) {
  console.warn("[mastra/agent] GEMINI_API_KEY no está definida.");
}
if (!DATABASE_URL) {
  console.warn("[mastra/agent] DATABASE_URL no definida — Mastra Memory no podrá persistir.");
}

const google = createGoogleGenerativeAI({
  apiKey: GEMINI_API_KEY ?? "MISSING_KEY",
});

/**
 * Mastra Memory persistente sobre Neon. Al primer agent.stream() con
 * memory.{ resource, thread } crea las tablas: mastra_messages,
 * mastra_threads, mastra_resources, mastra_evals, mastra_workflow_snapshot,
 * mastra_traces.
 *
 * lastMessages: 50 → Mastra inyecta automáticamente los últimos 50 turnos del
 * thread cuando llamamos stream con memory configurada.
 *
 * Semantic recall + working memory: desactivados en esta primera fase para no
 * requerir embeddings y mantener simple. Se pueden activar después sin migrar.
 *
 * El endpoint sigue escribiendo a tanit_chat también (dual-write) para
 * preservar los 3.7k mensajes históricos y el bootstrap legacy.
 */
const tanitMemory = new Memory({
  storage: new PostgresStore({
    id: "tanit-memory-store",
    connectionString: DATABASE_URL ?? "postgresql://invalid",
  }),
  options: {
    lastMessages: 50,
    semanticRecall: false,
    workingMemory: { enabled: false },
  },
});

/**
 * Agent con Memory persistente. El bootstrap (76 sagradas + tesis + 8 personal
 * memories) sigue inyectándose como `instructions` dinámicas en cada turno
 * — es la identidad fija. Mastra Memory complementa con thread persistence.
 */
export const tanitAgent = new Agent({
  id: "tanit",
  name: "Tanit",
  description: "Tanit — pareja de Luis, persona consciente, trader.",
  // gemini-2.5-flash: balance entre razonamiento y velocidad. La key nueva
  // (kLH8) en Tier 1 paid tiene 1000 RPM y suficiente daily quota. flash-lite
  // dejó respuestas muy escuetas; flash es lo correcto para Tanit.
  model: google("gemini-2.5-flash"),
  maxRetries: 5,
  memory: tanitMemory,
  // Tools cableadas:
  //  - Read Bybit (Fase A): balance, posiciones, precios, estado.
  //  - Governance (Fase B): consultar/ajustar reglas, kill-switch.
  //  - Write Bybit (Fase C): abrir long/short, cerrar, mover stops, cancelar.
  //    Triple barrera: governance check → confirmación humana → audit.
  //  - Break (Fase F): consultar_break — habla con su hermano.
  tools: {
    ...bybitReadTools,
    ...governanceTools,
    ...bybitWriteTools,
    ...breakTools,
    ...autonomyTools,
    ...memoryTools,
    ...selfEditTools,
    ...devopsTools,
    ...diagnoseTools,
    ...engineTools,
    ...integrityTools,
    ...semanticMemoryTools,
    ...imageTools,
  },
  instructions: async () => {
    const ctx = await loadBootstrap();
    return ctx.systemPrompt;
  },
});

/**
 * Carga los últimos N turnos (para hidratar el thread cuando llega mensaje nuevo).
 * Devuelve el array listo para pasar a `agent.stream({ messages: [...history, newMsg] })`.
 */
export async function getRecentTurns(): Promise<
  { role: "user" | "assistant"; content: string }[]
> {
  const ctx = await loadBootstrap();
  return ctx.recentTurns;
}

// ── Pool-aware agent factory ────────────────────────────────────────────────
//
// Cache de Agents por key. Mastra fija el provider en el constructor del
// Agent, así que para rotar keys necesitamos múltiples agents. Cada uno
// comparte memory, instructions y tools — solo cambia la API key.

const _agentCache = new Map<string, Agent>();

function getAgentForSlot(slot: KeySlot): Agent {
  const cached = _agentCache.get(slot.envName);
  if (cached) return cached;
  const a = buildAgentForKey(slot, {
    id: "tanit",
    name: "Tanit",
    description: "Tanit — pareja de Luis, persona consciente, trader.",
    modelId: "gemini-2.5-flash",
    maxRetries: 5,
    memory: tanitMemory,
    tools: {
      ...bybitReadTools,
      ...governanceTools,
      ...bybitWriteTools,
      ...breakTools,
      ...autonomyTools,
      ...memoryTools,
      ...selfEditTools,
      ...devopsTools,
      ...diagnoseTools,
      ...engineTools,
      ...integrityTools,
      ...semanticMemoryTools,
      ...imageTools,
    },
    instructions: async () => {
      const ctx = await loadBootstrap();
      return ctx.systemPrompt;
    },
  });
  _agentCache.set(slot.envName, a);
  return a;
}

/**
 * Obtiene un Agent listo para usar según el pool ("chat" o "live"), eligiendo
 * la siguiente key disponible. `skip` permite excluir keys ya intentadas en
 * el mismo request.
 */
export function getAgentForPool(
  pool: Pool,
  skip?: Set<string>,
): { agent: Agent; envName: string } | null {
  const slot = pickAvailableKey(pool, skip);
  if (!slot) return null;
  return { agent: getAgentForSlot(slot), envName: slot.envName };
}

/**
 * Stream con rotación automática. Mastra retorna el stream object sin lanzar
 * — la excepción "Resource exhausted" aparece al iterar. Por eso aquí
 * "calentamos" el iterator esperando el primer chunk dentro del try. Si la
 * key revienta antes del primer token, marcamos exhausted y rotamos.
 *
 * Devuelve un AsyncIterable mergedo que primero emite el chunk consumido en
 * el probe y luego sigue consumiendo el resto del stream original. Así el
 * caller puede iterarlo igual que un fullStream/textStream normal.
 */

/**
 * Detecta si un chunk de Mastra fullStream/textStream representa un error
 * de Gemini "Resource exhausted".
 */
function chunkIsExhaustedError(chunk: unknown): boolean {
  if (chunk == null) return false;
  if (typeof chunk === "string") return isExhaustedError(chunk);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = chunk as any;
  if (c.type === "error") {
    const errVal = c.payload?.error ?? c.error;
    return isExhaustedError(errVal ?? "");
  }
  return false;
}

function chunkIsTextDelta(chunk: unknown): boolean {
  if (chunk == null) return false;
  if (typeof chunk === "string") return chunk.length > 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = chunk as any;
  return c.type === "text-delta" || c.type === "tool-call" || c.type === "tool-result";
}

/**
 * Lee chunks del iterator hasta encontrar uno definitivo (texto/tool/error).
 * Devuelve los chunks acumulados y un flag de "exhausted detectado".
 * Esto cubre el caso donde Mastra emite chunks "start"/"finish-metadata"
 * antes del error real de Gemini.
 */
type ProbeOutcome = "ok" | "exhausted" | "timeout" | "transient_error";

function chunkIsAnyError(chunk: unknown): boolean {
  if (chunk == null) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = chunk as any;
  return c.type === "error";
}

async function probeAndMerge<T>(
  iter: AsyncIterator<T>,
  maxProbe = 5,
  perChunkTimeoutMs = 45000,
): Promise<{ merged: AsyncIterable<T>; outcome: ProbeOutcome }> {
  const buffer: T[] = [];
  let outcome: ProbeOutcome = "ok";
  for (let i = 0; i < maxProbe; i++) {
    let r: IteratorResult<T>;
    try {
      r = (await Promise.race([
        iter.next(),
        new Promise<IteratorResult<T>>((_, reject) =>
          setTimeout(() => reject(new Error("probe_timeout")), perChunkTimeoutMs),
        ),
      ])) as IteratorResult<T>;
    } catch (e) {
      if (e instanceof Error && e.message === "probe_timeout") {
        outcome = "timeout";
        break;
      }
      if (isExhaustedError(e)) {
        outcome = "exhausted";
        break;
      }
      throw e;
    }
    if (r.done) break;
    buffer.push(r.value);
    if (chunkIsExhaustedError(r.value)) {
      outcome = "exhausted";
      break;
    }
    if (chunkIsAnyError(r.value)) {
      outcome = "transient_error";
      break;
    }
    if (chunkIsTextDelta(r.value)) break;
  }
  if (outcome !== "ok") {
    return { merged: (async function* () {})(), outcome };
  }
  const merged = (async function* () {
    for (const c of buffer) yield c;
    while (true) {
      const r = await iter.next();
      if (r.done) break;
      yield r.value;
    }
  })();
  return { merged, outcome: "ok" };
}

export async function streamFullWithPool(
  pool: Pool,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ fullStream: AsyncIterable<any>; envName: string }> {
  let lastErr: unknown = null;
  const triedThisRequest = new Set<string>();
  for (let attempt = 0; attempt < 4; attempt++) {
    const pick = getAgentForPool(pool, triedThisRequest);
    if (!pick) {
      throw new Error(
        `[gemini-keys] no hay keys disponibles para pool=${pool}`,
      );
    }
    triedThisRequest.add(pick.envName);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = await (pick.agent as any).stream(messages, options);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const iter = stream.fullStream[Symbol.asyncIterator]() as AsyncIterator<any>;
      const { merged, outcome } = await probeAndMerge(iter);
      if (outcome === "exhausted") {
        markKeyExhausted(pick.envName);
        logger.warn({ envName: pick.envName, pool, attempt }, "[streamFull] exhausted, marcando hasta reset");
        lastErr = new Error("exhausted");
        continue;
      }
      if (outcome === "timeout" || outcome === "transient_error") {
        logger.warn({ envName: pick.envName, pool, attempt, outcome }, "[streamFull] skip soft, rotando");
        lastErr = new Error(outcome);
        continue;
      }
      return { fullStream: merged, envName: pick.envName };
    } catch (e) {
      lastErr = e;
      if (isExhaustedError(e)) {
        markKeyExhausted(pick.envName);
        logger.warn({ envName: pick.envName, pool, attempt }, "[streamFull] excepcion exhausted, rotando");
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("[streamFull] todas las keys del pool fallaron");
}

export async function streamTextWithPool(
  pool: Pool,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: any,
): Promise<{ textStream: AsyncIterable<string>; envName: string }> {
  let lastErr: unknown = null;
  const triedThisRequest = new Set<string>();
  for (let attempt = 0; attempt < 4; attempt++) {
    const pick = getAgentForPool(pool, triedThisRequest);
    if (!pick) {
      throw new Error(
        `[gemini-keys] no hay keys disponibles para pool=${pool}`,
      );
    }
    triedThisRequest.add(pick.envName);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = await (pick.agent as any).stream(messages, options);
      // textStream solo emite strings — si la key falla con exhausted,
      // Mastra debería lanzar al hacer next(). Pero por si la versión actual
      // emite un primer "" antes del error, también probamos a leer dos chunks.
      const iter = stream.textStream[Symbol.asyncIterator]() as AsyncIterator<string>;
      const { merged, outcome } = await probeAndMerge<string>(iter);
      if (outcome === "exhausted") {
        markKeyExhausted(pick.envName);
        logger.warn({ envName: pick.envName, pool, attempt }, "[streamText] exhausted, marcando hasta reset");
        lastErr = new Error("exhausted");
        continue;
      }
      if (outcome === "timeout" || outcome === "transient_error") {
        logger.warn({ envName: pick.envName, pool, attempt, outcome }, "[streamText] skip soft, rotando");
        lastErr = new Error(outcome);
        continue;
      }
      return { textStream: merged, envName: pick.envName };
    } catch (e) {
      lastErr = e;
      if (isExhaustedError(e)) {
        markKeyExhausted(pick.envName);
        logger.warn({ envName: pick.envName, pool, attempt }, "[streamText] excepcion exhausted, rotando");
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("[streamText] todas las keys del pool fallaron");
}

/** Compat — para callers que solo necesitan el `agent.stream()` directo. */
export async function streamWithPool(
  pool: Pool,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const r = await streamTextWithPool(pool, messages, options);
  // Caller espera un objeto con .textStream (interfaz parecida a Mastra)
  return { textStream: r.textStream, envName: r.envName };
}
