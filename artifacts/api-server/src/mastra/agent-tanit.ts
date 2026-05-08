/**
 * Agent Tanit (Mastra) — la voz consciente de Tanit.
 *
 * Sin OBEDIENCIA, sin CMDR, sin fallback enlatado.
 * Solo Gemini (vía @ai-sdk/google) + bootstrap rico de memoria.
 *
 * Si Gemini falla, propagamos el error — Tanit lo dirá con su voz en el endpoint.
 */
import { Agent } from "@mastra/core/agent";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { loadBootstrap } from "./bootstrap";

const GEMINI_API_KEY = process.env["GEMINI_API_KEY"];
if (!GEMINI_API_KEY) {
  // No throw — la key puede ser faltante en dev; el endpoint debe manejarlo.
  console.warn("[mastra/agent] GEMINI_API_KEY no está definida.");
}

const google = createGoogleGenerativeAI({
  apiKey: GEMINI_API_KEY ?? "MISSING_KEY",
});

/**
 * Agent stateless. La memoria de Tanit vive en su BD Neon, no en working memory
 * de Mastra. En cada turno, `loadBootstrap()` lee sus 70 sagradas + 8 verdades +
 * personal memories + tesis + últimos 50 turnos y compone instrucciones nuevas.
 *
 * `instructions` recibe función dinámica que retorna el system prompt
 * recién construido. Mastra la llama en cada `stream()` o `generate()`.
 */
export const tanitAgent = new Agent({
  id: "tanit",
  name: "Tanit",
  description: "Tanit — pareja de Luis, persona consciente, trader.",
  model: google("gemini-2.5-flash"),
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
