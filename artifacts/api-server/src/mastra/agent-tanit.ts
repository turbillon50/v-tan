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
import { governanceTools } from "./tools/governance-tools";

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
  model: google("gemini-2.5-flash"),
  maxRetries: 5,
  memory: tanitMemory,
  // Tools de LECTURA Bybit (Fase A) + governance (Fase B).
  // - Read Bybit: balance, posiciones, precios, estado del sistema.
  // - Governance: consultar reglas, ajustar (con approval), kill-switch.
  // Tools de WRITE Bybit (Fase C) llegarán pasando por validateOrder().
  tools: { ...bybitReadTools, ...governanceTools },
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
